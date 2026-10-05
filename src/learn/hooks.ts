/**
 * `ak learn hook <event>` — the only entry the host's hook configuration calls.
 *
 * A hook never blocks or fails a session: every handler is wrapped, errors go
 * to stderr, and the exit code is always 0.
 *
 * With a repo scope set, a session whose root is out of it is a strict no-op:
 * the check runs before the hook's span opens, so it leaves no row either.
 */
import { repoAllowed } from "./core/config.ts";
import type { LearnArea, LearnContext } from "./core/context.ts";
import { mainRepoRoot } from "./core/paths.ts";
import { tokens } from "./core/store.ts";
import { span } from "./core/trace.ts";
import { sessionRoot, sessionStartBlock } from "./memory/session-context.ts";
import { promptHook, stopHook } from "./review/hooks.ts";

export interface HookPayload {
  cwd?: string;
  prompt?: string;
  user_prompt?: string;
  stop_hook_active?: boolean;
  [key: string]: unknown;
}

/** The session's working directory: the payload's when it names one, else the process's. */
export function payloadCwd(payload: HookPayload, fallback: string): string {
  return typeof payload.cwd === "string" && payload.cwd !== "" ? payload.cwd : fallback;
}

export function parsePayload(stdin: string | undefined): HookPayload {
  if (stdin === undefined || stdin.trim() === "") return {};
  try {
    const parsed = JSON.parse(stdin) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as HookPayload) : {};
  } catch {
    return {};
  }
}

type HookLabel = "session-start" | "stop" | "prompt";

/** The root each verb acts on, resolved the way that verb resolves it. */
const HOOK_ROOT: Record<HookLabel, (cwd: string) => string | null> = {
  "session-start": sessionRoot,
  stop: mainRepoRoot,
  prompt: mainRepoRoot,
};

/** Whether the session's root is in the repo scope. Unscoped, nothing is resolved. */
function inScope(label: HookLabel, ctx: LearnContext): boolean {
  if (ctx.config.repos === null) return true;
  const payload = parsePayload(ctx.stdin);
  return repoAllowed(ctx.config, HOOK_ROOT[label](payloadCwd(payload, ctx.cwd)));
}

/** Runs `body` as the hook's span; a throw is reported on stderr and the hook still exits 0. */
function guarded(label: HookLabel, ctx: LearnContext, body: (ctx: LearnContext) => void): number {
  try {
    if (!inScope(label, ctx)) return 0;
    span(ctx, `hook.${label}`, "hook", body);
  } catch (error) {
    ctx.io.err(`ak learn ${label}: ${(error as Error).message}`);
  }
  return 0;
}

/**
 * What the session was shown, read back from the printed block: guardrail
 * bullets open with `- [rp-N]`, lesson rows end with `[ls-N]`.
 */
function recordExposure(ctx: LearnContext, block: string): void {
  const guardrails = [...block.matchAll(/^- \[(rp-\d{1,6})\]/gm)].map((match) => match[1] ?? "");
  const lessons = [...block.matchAll(/\[(ls-\d{1,6})\]$/gm)].map((match) => match[1] ?? "");
  ctx.span?.attr("shown", [...guardrails, ...lessons]);
  ctx.span?.attr("guardrails", guardrails.length);
  ctx.span?.attr("lessons", lessons.length);
  ctx.span?.attr("block_tokens", tokens(block));
  if (block.trim() === "") ctx.span?.status("nothing");
}

export const hookArea: LearnArea = {
  summary: "entry points for host hooks; never blocks a session",
  verbs: {
    "session-start": {
      usage: "hook session-start            print the merged context block (guardrails, memory, lessons, roster)",
      run: (_args, ctx) =>
        guarded("session-start", ctx, (hook) => {
          const payload = parsePayload(hook.stdin);
          const cwd = payloadCwd(payload, hook.cwd);
          const block = sessionStartBlock({ ...hook, cwd });
          if (block.trim() !== "") hook.io.out(block.trimEnd());
          recordExposure(hook, block);
        }),
    },
    stop: {
      usage: "hook stop [--source codex]    debounced: detach the review pipeline for this project",
      run: (args, ctx) => guarded("stop", ctx, (hook) => stopHook(hook, parsePayload(hook.stdin), args)),
    },
    prompt: {
      usage: "hook prompt                   capture a user correction from a submitted prompt",
      run: (args, ctx) => guarded("prompt", ctx, (hook) => promptHook(hook, parsePayload(hook.stdin), args)),
    },
  },
};
