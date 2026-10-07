/**
 * `ak learn hook <event>` — the only entry the host's hook configuration calls.
 *
 * A hook never blocks or fails a session: every handler is wrapped, errors go
 * to stderr, and the exit code is always 0.
 *
 * With a repo scope set, a session whose root is out of it is a strict no-op:
 * the check runs before the hook's span opens, so it leaves no row either.
 */
import Ajv from "ajv";
import { repoAllowed } from "./core/config.ts";
import { flag, type LearnArea, type LearnArgs, type LearnContext } from "./core/context.ts";
import { mainRepoRoot } from "./core/paths.ts";
import { tokens } from "./core/store.ts";
import { sessionKey, span } from "./core/trace.ts";
import { type CarrierHost, claim, delivered, isCarrierHost, rearm } from "./memory/delivery.ts";
import { sessionRoot, sessionStartBlock, sessionStartBlockWithin } from "./memory/session-context.ts";
import { payloadCwd, promptHook, stopHook } from "./review/hooks.ts";

export interface HookPayload {
  cwd?: string;
  prompt?: string;
  user_prompt?: string;
  stop_hook_active?: boolean;
  [key: string]: unknown;
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

/** Runs `body` when the session is in scope; a throw is reported on stderr and the hook still exits 0. */
function reported(label: HookLabel, ctx: LearnContext, body: () => void): number {
  try {
    if (!inScope(label, ctx)) return 0;
    body();
  } catch (error) {
    ctx.io.err(`ak learn ${label}: ${(error as Error).message}`);
  }
  return 0;
}

/** Runs `body` as the hook's span, reported as above. */
function guarded(label: HookLabel, ctx: LearnContext, body: (ctx: LearnContext) => void): number {
  return reported(label, ctx, () => span(ctx, `hook.${label}`, "hook", body));
}

/**
 * What the session was shown, read back from the printed block: guardrail
 * bullets open with `- [rp-N]`, lesson rows end with `[ls-N]`. The span also
 * carries the session's key when the host named the session, which is what
 * the episode builder joins on (`memory/exposure.ts`).
 */
function recordExposure(ctx: LearnContext, block: string, hostSessionId: string | undefined): void {
  const session = sessionKey(ctx.config, hostSessionId ?? "");
  if (session !== null) ctx.span?.attr("session", session);
  const guardrails = [...block.matchAll(/^- \[(rp-\d{1,6})\]/gm)].map((match) => match[1] ?? "");
  const lessons = [...block.matchAll(/\[(ls-\d{1,6})\]$/gm)].map((match) => match[1] ?? "");
  ctx.span?.attr("shown", [...guardrails, ...lessons]);
  ctx.span?.attr("guardrails", guardrails.length);
  ctx.span?.attr("lessons", lessons.length);
  ctx.span?.attr("block_tokens", tokens(block));
  if (block.trim() === "") ctx.span?.status("nothing");
}

/** What a session-start call reads from the host's payload. Grok names the session in camel case, the others in snake case. */
interface SessionPayload {
  cwd?: string;
  session_id?: string;
  sessionId?: string;
}

const isSessionPayload = new Ajv({ strict: false }).compile<SessionPayload>({
  type: "object",
  properties: { cwd: { type: "string" }, session_id: { type: "string" }, sessionId: { type: "string" } },
});

function parseSessionPayload(stdin: string | undefined): SessionPayload {
  if (stdin === undefined || stdin.trim() === "") return {};
  try {
    const parsed: unknown = JSON.parse(stdin);
    return isSessionPayload(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** Grok clips a hook's `additionalContext` at this many characters. */
export const GROK_CONTEXT_CHARS = 10_000;

/**
 * How a carrier host names the session and takes the block. Grok reads it
 * from a PostToolUse hook's `additionalContext`; Kimi appends a
 * UserPromptSubmit hook's stdout to the context as it is.
 */
const CARRIERS: Record<
  CarrierHost,
  {
    sessionId: (payload: SessionPayload) => string | undefined;
    block: (ctx: LearnContext) => string;
    render: (block: string) => string;
  }
> = {
  grok: {
    sessionId: (payload) => payload.sessionId,
    block: (ctx) => sessionStartBlockWithin(ctx, GROK_CONTEXT_CHARS),
    render: (block) =>
      JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: block } }),
  },
  kimi: {
    sessionId: (payload) => payload.session_id,
    block: sessionStartBlock,
    render: (block) => block,
  },
};

/**
 * `session-start --host H`: print the block on the session's first carrier
 * call and nothing after it; with `--arm`, clear the mark instead. A payload
 * that names no session prints nothing, because a block that cannot be marked
 * delivered would be repeated on every call. Only the call that builds the
 * block is a span: one that arms, or finds the mark, leaves no row.
 */
function carrierHook(ctx: LearnContext, host: CarrierHost, payload: SessionPayload, arm: boolean): void {
  const carrier = CARRIERS[host];
  const sessionId = carrier.sessionId(payload) ?? "";
  if (sessionId === "") return;
  if (arm) {
    rearm(ctx.config, host, sessionId);
    return;
  }
  if (delivered(ctx.config, host, sessionId)) return;
  span(ctx, "hook.session-start", "hook", (traced) => {
    const block = carrier.block(traced).trimEnd();
    const printed = claim(traced.config, host, sessionId) ? block : "";
    if (printed !== "") traced.io.out(carrier.render(printed));
    recordExposure(traced, printed, sessionId);
  });
}

function sessionStartHook(args: LearnArgs, ctx: LearnContext): void {
  const payload = parseSessionPayload(ctx.stdin);
  const session = { ...ctx, cwd: payloadCwd(parsePayload(ctx.stdin), ctx.cwd) };
  const host = flag(args, "host");
  if (isCarrierHost(host)) {
    carrierHook(session, host, payload, args.flags.has("arm"));
    return;
  }
  if (host !== undefined) {
    ctx.io.err(`ak learn session-start: --host is ${Object.keys(CARRIERS).join(" or ")}`);
    return;
  }
  span(session, "hook.session-start", "hook", (traced) => {
    const block = sessionStartBlock(traced);
    if (block.trim() !== "") traced.io.out(block.trimEnd());
    recordExposure(traced, block, payload.session_id ?? payload.sessionId);
  });
}

export const hookArea: LearnArea = {
  summary: "entry points for host hooks; never blocks a session",
  verbs: {
    "session-start": {
      usage:
        "hook session-start [--host grok|kimi [--arm]]  print the merged context block (guardrails, memory, lessons, roster); --host: once per session, --arm: allow it again",
      run: (args, ctx) => reported("session-start", ctx, () => sessionStartHook(args, ctx)),
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
