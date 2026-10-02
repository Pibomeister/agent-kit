/**
 * One entry point for every host: pick the adapter, run one isolated session, parse it.
 * Not a test file.
 */
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAsync } from "../session.ts";
import { costOf, type PriceTable } from "../pricing.ts";
import { claude } from "./claude.ts";
import { codex } from "./codex.ts";
import { grok } from "./grok.ts";
import type { HostKind, SessionRequest, SessionResult, SubjectAdapter } from "./types.ts";

const ADAPTERS: Record<HostKind, SubjectAdapter> = { claude, codex, grok };

/** Which `dist/` bundle each host installs. Grok reads Claude Code skill frontmatter. */
export const BUNDLE_FOR: Record<HostKind, string> = { claude: "claude-code", codex: "codex", grok: "claude-code" };

export function adapterFor(host: HostKind): SubjectAdapter {
  const adapter = ADAPTERS[host];
  if (adapter === undefined) throw new Error(`no subject adapter for host '${host}'`);
  return adapter;
}

/** The `CLAUDE_CODE_*` variables that carry auth or provider routing; `scripts/eval-local.sh` passes the same ones. */
const AUTH = new Set(["CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX"]);

/**
 * The launching session's own variables (`CLAUDE_CODE_*`, `EVAL_*`) reach a child that inherits
 * them; the host-eval isolation probe planted canaries that arrived this way. The `AUTH` ones stay.
 */
export function withoutParentSession(env: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter(
      ([key]) => AUTH.has(key) || (!key.startsWith("CLAUDE_CODE_") && !key.startsWith("EVAL_") && key !== "CLAUDECODE"),
    ),
  );
}

/** Run one session for `subjectId` under the adapter's isolation. `model` is the matrix binding, passed through opaquely. */
export async function runSubject(
  adapter: SubjectAdapter,
  subjectId: string,
  model: string | undefined,
  req: SessionRequest,
  prices?: PriceTable,
): Promise<SessionResult> {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), `ak-subject-${adapter.host}-`)));
  const isolation = adapter.isolate?.(scratch, req);
  const started = Date.now();
  try {
    const result = await runAsync(adapter.command(req, model), {
      cwd: req.cwd,
      env: { ...withoutParentSession(req.env), ...isolation?.env },
      timeoutMs: req.timeoutMs,
    });
    const parsed = adapter.parse(result.stdout);
    const reported: Pick<SessionResult, "costUsd" | "usage" | "turns" | "model" | "slashCommands" | "stopReason"> = {};
    const estimatedCost =
      adapter.host === "codex" && model !== undefined && parsed.usage !== undefined
        ? costOf(parsed.usage, prices?.models[model])
        : undefined;
    if (parsed.costUsd !== undefined) reported.costUsd = parsed.costUsd;
    else if (estimatedCost !== undefined) reported.costUsd = estimatedCost;
    if (parsed.usage !== undefined) reported.usage = parsed.usage;
    if (parsed.turns !== undefined) reported.turns = parsed.turns;
    if (parsed.model !== undefined) reported.model = parsed.model;
    if (parsed.slashCommands !== undefined) reported.slashCommands = parsed.slashCommands;
    if (parsed.stopReason !== undefined) reported.stopReason = parsed.stopReason;
    const session: SessionResult = {
      subject: subjectId,
      host: adapter.host,
      events: parsed.events,
      reply: result.timedOut && parsed.reply === "" ? "TIMEOUT" : parsed.reply,
      exitCode: result.code,
      timedOut: result.timedOut,
      ...reported,
      durationMs: Date.now() - started,
    };
    if (isolation !== undefined) session.leaks = isolation.leaks;
    return session;
  } finally {
    isolation?.release();
    rmSync(scratch, { recursive: true, force: true });
  }
}
