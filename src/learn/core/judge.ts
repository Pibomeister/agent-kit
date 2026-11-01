/**
 * The one judgement call the learning runtime makes: a prompt in, a JSON object out.
 *
 * The command is configuration (`AK_LEARN_JUDGE`), so which model answers is
 * the runner's binding and never this package's (ruling
 * `learning-judge-is-runner-bound`). Whatever comes back is checked by
 * deterministic gates before it touches a ledger; the judge never sets counts,
 * status, ids or rates.
 */
import { Database } from "bun:sqlite";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import Ajv from "ajv";
import type { LearnConfig } from "./config.ts";
import type { Loop } from "./paths.ts";
import { run } from "./proc.ts";
import { gateJsonText, gateText, readText } from "./store.ts";
import type { LearnRole } from "./roles.ts";
import { carrierOf, recordJudgeAttempt } from "./trace.ts";

/** Variables that make a nested CLI believe it is running inside the parent session. */
const NESTED_SESSION_VARS = ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT"];
/** Trace context the judge must not inherit: it gets its own child carrier instead. */
const TRACE_CONTEXT_VARS = ["TRACEPARENT", "TRACESTATE", "BAGGAGE"];
const HOST_MODEL_FIELD = "model";
/**
 * Variables that would bill a call to an account instead of the host's signed-in seat:
 * an API key or bearer token for any provider, a provider base URL that reroutes the
 * call, the switches that send the host CLI to a cloud provider, and the proxy and
 * trusted-CA variables that let a middlebox reroute or read it. A subscription-only judge
 * never sees them. Proxy names are honoured in either case, so the match ignores case.
 */
const METERED_VARS =
  /(?:_API_KEY|_AUTH_TOKEN|_BEARER_TOKEN|_BASE_URL)$|^AWS_BEARER_TOKEN|^CLAUDE_CODE_USE_|^(?:HTTPS?|ALL)_PROXY$|^NODE_EXTRA_CA_CERTS$/i;
/**
 * The `METERED_VARS` names the host CLI is known to read, blanked when the user's
 * `settings.json` cannot be read as an object, since its own names are then unknown.
 */
const KNOWN_METERED_NAMES = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_BEDROCK_BASE_URL",
  "ANTHROPIC_VERTEX_BASE_URL",
  "AWS_BEARER_TOKEN_BEDROCK",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "ANTHROPIC_FOUNDRY_API_KEY",
  "ANTHROPIC_FOUNDRY_BASE_URL",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NODE_EXTRA_CA_CERTS",
];
/** OpenTelemetry switches a subscription-only judge always has off: the prompt is a whole session. */
const OTEL_CONTENT_OFF = { OTEL_LOG_USER_PROMPTS: "0", OTEL_LOG_TOOL_DETAILS: "0" };

/**
 * `env` without the variables that could meter a judge call (`METERED_VARS`), and with
 * OpenTelemetry content logging forced off. Names are compared, values never read.
 */
export function subscriptionEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...Object.fromEntries(Object.entries(env).filter(([key]) => !METERED_VARS.test(key))), ...OTEL_CONTENT_OFF };
}

/** A host settings text as an object; null when it does not parse as one. */
function settingsFrom(text: string): HostEnvelope | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return validateHostEnvelope(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * The host CLI's command with a `--settings` layer that blanks what the user's
 * `settings.json` or the command's own `--settings` would reapply over `subscriptionEnv`:
 * each `METERED_VARS` name in either `env`, and `apiKeyHelper`. The layer also forces
 * OpenTelemetry content logging off. The flag layer outranks
 * user settings, so the call stays on the signed-in seat. The command's own `--settings` layers, in either form,
 * become one merged layer, the last given winning as the host would read it; a file
 * path is read from `cwd`, where the judge runs. Null for any other command: only `claude`
 * itself is known to read this layer, and a launcher such as `env` or `npx` can set its own
 * environment or run something else.
 */
/**
 * The user's `settings.json` as an object. Only a missing file reads as no settings; a file
 * that is present but unreadable (EACCES, EISDIR, EIO, ...), does not parse, or is not an
 * object reads as null, so the caller fails closed.
 */
function userSettings(path: string): HostEnvelope | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "ENOENT" ? {} : null;
  }
  return settingsFrom(text);
}

export function subscriptionCommand(command: readonly string[], configDir: string, cwd: string): string[] | null {
  if (command[0] === undefined || basename(command[0]) !== "claude") return null;
  // A user settings.json that is present but cannot be read as an object fails closed: which of
  // its keys the host would still apply is unknown, so every known metered name and `apiKeyHelper` are blanked.
  const user = userSettings(join(configDir, "settings.json"));
  const userEnv =
    user === null
      ? Object.fromEntries(KNOWN_METERED_NAMES.map((name) => [name, ""]))
      : validateHostEnvelope(user.env)
        ? user.env
        : {};
  const rest: string[] = [];
  let given: string | undefined;
  for (let index = 1; index < command.length; index += 1) {
    const arg = command[index] ?? "";
    if (arg === "--settings") {
      given = command[index + 1];
      index += 1;
    } else if (arg.startsWith("--settings=")) given = arg.slice("--settings=".length);
    else rest.push(arg);
  }
  const base =
    settingsFrom(
      given === undefined || given.trimStart().startsWith("{") ? (given ?? "{}") : readText(resolve(cwd, given)),
    ) ?? {};
  const baseEnv = validateHostEnvelope(base.env) ? base.env : {};
  const blanked = [...Object.keys(userEnv), ...Object.keys(baseEnv)].filter((key) => METERED_VARS.test(key));
  const helper = user === null || "apiKeyHelper" in user || "apiKeyHelper" in base ? { apiKeyHelper: "" } : {};
  const text = JSON.stringify({
    ...base,
    env: { ...baseEnv, ...Object.fromEntries(blanked.map((key) => [key, ""])), ...OTEL_CONTENT_OFF },
    ...helper,
  });
  return [command[0], "--settings", text, ...rest];
}

export interface CommandJudgeOptions {
  /**
   * Drop every metered credential from the judge's environment, so a call runs on the signed-in seat or fails.
   * A command other than `claude` cannot be held to that, so it is not run and the reply declares it unavailable.
   */
  subscriptionOnly?: boolean;
}

export interface JudgeCallContext {
  /** The enclosing span's id (`trace.ts` `runOf`); null outside a span. */
  runId: string | null;
  /** The enclosing span's trace; absent or null roots a fresh trace for the call. */
  traceId?: string | null;
  loop: Loop;
  role: LearnRole;
  project: string;
  onProcessResult?: (failure: "auth" | "timeout" | null) => void;
}

export type JudgeFn = (prompt: string, context: JudgeCallContext) => Record<string, unknown> | null;

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

type HostEnvelope = Record<string, JsonValue>;

/** What the caller got: `ok` is a usable reply, every other value is a failed call. */
export type JudgeOutcome = "ok" | "empty" | "unparseable" | "unavailable" | "error";

export interface JudgeTraceRow {
  at: string;
  call_id: string;
  run_id: string | null;
  trace_id: string;
  /** This attempt's own span: the judge receives it as its `TRACEPARENT`. */
  span_id: string;
  parent_span_id: string | null;
  loop: Loop;
  role: LearnRole;
  project: string;
  prompt_sha256: string;
  prompt_chars: number;
  attempt: number;
  outcome: JudgeOutcome;
  exit_code: number;
  timed_out: boolean;
  stderr_tail: string;
  duration_ms: number;
  [HOST_MODEL_FIELD]: string | null;
  usage: JsonValue;
  total_cost_usd: number | null;
  session_id: string | null;
  is_error: boolean | null;
}

const STDERR_TAIL_BYTES = 2 * 1024;
const TRACE_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Retained trace generations, oldest first; `rotateTrace` moves the second over the first. */
const TRACE_GENERATIONS = ["judge-calls.1.jsonl", "judge-calls.jsonl"] as const;
/**
 * The runtime directory's database. With `AK_LEARN_TRACE=full` its one table, `judge_bodies`, holds each
 * retained call's prompt and reply, keyed by call id. Created only for full tracing; later
 * metadata-only runs still prune an existing database on rotation.
 */
export const JUDGE_BODIES_FILE = "trace.sqlite";
/** Where an older version wrote one file per body, `<call id>.prompt` and `.reply`. Rotation still removes them. */
const LEGACY_BODIES_DIR = "judge-bodies";
const BODIES_BUSY_MS = 5_000;
const jsonValidator = new Ajv({ strict: false });
const validateHostEnvelope = jsonValidator.compile<HostEnvelope>({ type: "object" });
const validateString = jsonValidator.compile<string>({ type: "string" });
const validateNumber = jsonValidator.compile<number>({ type: "number" });
const validateBoolean = jsonValidator.compile<boolean>({ type: "boolean" });

export interface JudgeTraceSummary {
  calls: number;
  failures: number;
  totalCostUsd: number;
}

/** The fields of a retained judge row that usage metrics read; never `stderr_tail`, usage bodies or prompts. */
export interface JudgeStatsRow {
  at: string;
  run_id: string | null;
  loop: Loop;
  role: LearnRole;
  outcome: JudgeOutcome;
  duration_ms: number;
  total_cost_usd: number | null;
}

interface JudgeTraceSummaryRow extends JudgeStatsRow {
  call_id: string;
}

const validateJudgeTraceSummaryRow = jsonValidator.compile<JudgeTraceSummaryRow>({
  type: "object",
  required: ["at", "call_id", "run_id", "loop", "role", "outcome", "duration_ms", "total_cost_usd"],
  properties: {
    at: { type: "string" },
    call_id: { type: "string", pattern: "^[0-9a-f-]{36}$" },
    run_id: { type: ["string", "null"] },
    loop: { enum: ["review", "memory", "skills"] },
    role: { type: "string" },
    outcome: { enum: ["ok", "empty", "unparseable", "unavailable", "error"] },
    duration_ms: { type: "number", minimum: 0 },
    total_cost_usd: { type: ["number", "null"] },
  },
  additionalProperties: true,
});

function stderrTail(stderr: string): string {
  const bytes = Buffer.from(stderr);
  if (bytes.byteLength <= STDERR_TAIL_BYTES) return stderr;
  let tail = bytes.subarray(bytes.byteLength - STDERR_TAIL_BYTES).toString("utf8");
  while (Buffer.byteLength(tail) > STDERR_TAIL_BYTES) tail = tail.slice(1);
  return tail;
}

function hostEnvelope(stdout: string): HostEnvelope {
  try {
    const parsed: unknown = JSON.parse(stdout.trim());
    return validateHostEnvelope(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function stringField(value: JsonValue | undefined): string | null {
  return validateString(value) ? value : null;
}

function numberField(value: JsonValue | undefined): number | null {
  return validateNumber(value) ? value : null;
}

function booleanField(value: JsonValue | undefined): boolean | null {
  return validateBoolean(value) ? value : null;
}

/** The envelope's own model field, or the names its per-model usage is keyed by. */
function hostModel(envelope: HostEnvelope): string | null {
  const named = stringField(envelope[HOST_MODEL_FIELD]);
  if (named !== null) return named;
  const byModel = envelope.modelUsage;
  if (!validateHostEnvelope(byModel)) return null;
  const names = Object.keys(byModel);
  return names.length === 0 ? null : names.join(",");
}

function usageCount(usage: JsonValue | undefined, field: string): number {
  if (!validateHostEnvelope(usage)) return 0;
  const value = numberField(usage[field]);
  return value !== null && Number.isInteger(value) && value >= 0 ? value : 0;
}

function traceSummaryRow(line: string): JudgeTraceSummaryRow | null {
  try {
    const parsed: unknown = JSON.parse(line);
    return validateJudgeTraceSummaryRow(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function traceRows(path: string): JudgeTraceSummaryRow[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const rows: JudgeTraceSummaryRow[] = [];
  for (const line of text.split("\n")) {
    const row = traceSummaryRow(line);
    if (row !== null) rows.push(row);
  }
  return rows;
}

function openBodies(config: LearnConfig): Database {
  const db = new Database(join(config.runtimeDir, JUDGE_BODIES_FILE), { create: true });
  db.exec(`PRAGMA busy_timeout = ${BODIES_BUSY_MS}`);
  db.exec(
    "CREATE TABLE IF NOT EXISTS judge_bodies (call_id TEXT PRIMARY KEY, prompt TEXT NOT NULL, reply TEXT NOT NULL)",
  );
  return db;
}

/** The body database when a full trace has created it, else null; never creates it. */
function existingBodies(config: LearnConfig): Database | null {
  return existsSync(join(config.runtimeDir, JUDGE_BODIES_FILE)) ? openBodies(config) : null;
}

/** Move the current trace over the previous one, dropping the bodies of the calls that leave with it. */
function rotateTrace(config: LearnConfig, trace: string): void {
  const rotated = join(config.runtimeDir, TRACE_GENERATIONS[0]);
  const leaving = traceRows(rotated).map((row) => row.call_id);
  const db = existingBodies(config);
  if (db !== null) {
    try {
      const drop = db.query<unknown, [string]>("DELETE FROM judge_bodies WHERE call_id = ?1");
      db.transaction(() => {
        for (const callId of leaving) drop.run(callId);
      })();
    } finally {
      db.close();
    }
  }
  const legacy = join(config.runtimeDir, LEGACY_BODIES_DIR);
  for (const callId of leaving) {
    rmSync(join(legacy, `${callId}.prompt`), { force: true });
    rmSync(join(legacy, `${callId}.reply`), { force: true });
  }
  renameSync(trace, rotated);
}

/** Store one call's prompt and reply behind the runtime directory's secret gate. */
function writeBodies(config: LearnConfig, callId: string, prompt: string, reply: string): void {
  const label = join(config.runtimeDir, `${JUDGE_BODIES_FILE}#judge_bodies`, callId);
  const db = openBodies(config);
  try {
    db.query<unknown, [string, string, string]>(
      "INSERT OR REPLACE INTO judge_bodies (call_id, prompt, reply) VALUES (?1, ?2, ?3)",
    ).run(
      callId,
      gateText(config.runtimeDir, `${label}.prompt`, prompt),
      gateText(config.runtimeDir, `${label}.reply`, reply),
    );
  } finally {
    db.close();
  }
}

/**
 * Append one row per attempt to `judge-calls.jsonl` in the runtime directory.
 * Best-effort: a trace that cannot be written never fails the judge call.
 */
function traceAttempt(
  config: LearnConfig,
  prompt: string,
  context: JudgeCallContext,
  carrier: { traceId: string; spanId: string },
  attempt: number,
  startedAt: number,
  result: ReturnType<typeof run>,
  outcome: JudgeOutcome,
): void {
  try {
    const envelope = hostEnvelope(result.stdout);
    // The span's totals come first, so a trace file that cannot be written does not drop the attempt from them.
    recordJudgeAttempt(context.runId, {
      ok: outcome === "ok",
      costUsd: numberField(envelope.total_cost_usd),
      inputTokens: usageCount(envelope.usage, "input_tokens"),
      outputTokens: usageCount(envelope.usage, "output_tokens"),
    });
    const callId = randomUUID();
    mkdirSync(config.runtimeDir, { recursive: true });
    const row: JudgeTraceRow = {
      at: new Date(startedAt).toISOString(),
      call_id: callId,
      run_id: context.runId,
      trace_id: carrier.traceId,
      span_id: carrier.spanId,
      // A run id outside a span (a dated id) names no span, so the attempt has no span parent.
      parent_span_id: context.runId !== null && /^[0-9a-f]{16}$/.test(context.runId) ? context.runId : null,
      loop: context.loop,
      role: context.role,
      project: context.project,
      prompt_sha256: createHash("sha256").update(prompt).digest("hex"),
      prompt_chars: prompt.length,
      attempt,
      outcome,
      exit_code: result.code,
      timed_out: result.timedOut,
      stderr_tail: stderrTail(result.stderr),
      duration_ms: Date.now() - startedAt,
      [HOST_MODEL_FIELD]: hostModel(envelope),
      usage: envelope.usage ?? null,
      total_cost_usd: numberField(envelope.total_cost_usd),
      session_id: stringField(envelope.session_id),
      is_error: booleanField(envelope.is_error),
    };
    const trace = join(config.runtimeDir, TRACE_GENERATIONS[1]);
    const line = gateJsonText(config.runtimeDir, trace, `${JSON.stringify(row)}\n`);
    if (existsSync(trace) && statSync(trace).size + Buffer.byteLength(line) > config.traceMaxBytes)
      rotateTrace(config, trace);
    appendFileSync(trace, line);
    if (config.traceFull) writeBodies(config, callId, prompt, stringField(envelope.result) ?? result.stdout);
  } catch {
    return;
  }
}

/** Every retained judge row, oldest generation first, reduced to the fields usage metrics read. */
export function judgeRows(config: LearnConfig): JudgeStatsRow[] {
  return TRACE_GENERATIONS.flatMap((name) =>
    traceRows(join(config.runtimeDir, name)).map(
      ({ at, run_id, loop, role, outcome, duration_ms, total_cost_usd }) => ({
        at,
        run_id,
        loop,
        role,
        outcome,
        duration_ms,
        total_cost_usd,
      }),
    ),
  );
}

/** Calls, calls without a usable reply and reported cost in the retained trace over the last 24 hours. */
export function judgeTraceSummary(config: LearnConfig, now = Date.now()): JudgeTraceSummary {
  const summary: JudgeTraceSummary = { calls: 0, failures: 0, totalCostUsd: 0 };
  const cutoff = now - TRACE_WINDOW_MS;
  for (const row of judgeRows(config)) {
    const at = Date.parse(row.at);
    if (!Number.isFinite(at) || at < cutoff || at > now) continue;
    summary.calls += 1;
    if (row.outcome !== "ok") summary.failures += 1;
    if (row.total_cost_usd !== null && Number.isFinite(row.total_cost_usd)) summary.totalCostUsd += row.total_cost_usd;
  }
  return summary;
}

/**
 * Pull the first JSON object out of a judge reply. Accepts the host's JSON
 * envelope (`{"result": "..."}`), a bare object, a fenced block or an object
 * embedded in prose.
 */
export function extractJson(stdout: string): Record<string, unknown> | null {
  const trimmed = stdout.trim();
  if (trimmed === "") return null;
  let content: unknown;
  try {
    const wrapper = JSON.parse(trimmed) as unknown;
    content =
      wrapper !== null && typeof wrapper === "object" && !Array.isArray(wrapper) && "result" in wrapper
        ? wrapper.result
        : wrapper;
  } catch {
    content = trimmed;
  }
  if (content !== null && typeof content === "object" && !Array.isArray(content))
    return content as Record<string, unknown>;
  if (typeof content !== "string") return null;
  const fenced = /```(?:json)?\s*(\{[\s\S]*\})\s*```/.exec(content);
  const bare = fenced ?? /(\{[\s\S]*\})/.exec(content);
  if (bare === null) return null;
  try {
    const parsed = JSON.parse(bare[1]!) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * A role's declared `unavailable` (`{"unavailable": "<why>"}`). It is a result, not a
 * malformed reply: callers treat it as a failed run that writes nothing, and it is
 * never retried (ruling `required-lane-failure-is-unavailable`).
 */
export function declaredUnavailable(reply: Record<string, unknown> | null): string | null {
  if (reply === null) return null;
  const why = reply.unavailable;
  return typeof why === "string" && Object.keys(reply).length === 1 ? why : null;
}

function judgeOutcome(result: ReturnType<typeof run>, parsed: ReturnType<JudgeFn>): JudgeOutcome {
  if (result.timedOut || result.code !== 0) return "error";
  if (result.stdout.trim() === "") return "empty";
  if (parsed === null) return "unparseable";
  return declaredUnavailable(parsed) === null ? "ok" : "unavailable";
}

/**
 * A judge bound to the configured command. One retry on an empty, failed or unparseable reply; every attempt is traced.
 * The command runs from the runtime directory, so it discovers no project instructions from its working directory.
 */
export function commandJudge(config: LearnConfig, options: CommandJudgeOptions = {}): JudgeFn {
  return (prompt: string, context: JudgeCallContext) => {
    mkdirSync(config.runtimeDir, { recursive: true });
    const command =
      options.subscriptionOnly === true
        ? subscriptionCommand(config.judgeCommand, config.configDir, config.runtimeDir)
        : config.judgeCommand;
    if (command === null)
      return {
        unavailable: `a subscription-only judge must be the claude command, not ${config.judgeCommand[0] ?? "nothing"}`,
      };
    const env: NodeJS.ProcessEnv = {};
    const parent = options.subscriptionOnly === true ? subscriptionEnv(process.env) : process.env;
    for (const [key, value] of Object.entries(parent)) {
      if (!NESTED_SESSION_VARS.includes(key) && !TRACE_CONTEXT_VARS.includes(key)) env[key] = value;
    }
    const traceId = context.traceId ?? randomBytes(16).toString("hex");
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const carrier = { traceId, spanId: randomBytes(8).toString("hex") };
      const startedAt = Date.now();
      const result = run(command, {
        cwd: config.runtimeDir,
        input: prompt,
        env: { ...env, TRACEPARENT: carrierOf(carrier) },
        timeoutMs: config.judgeTimeoutMs,
      });
      const parsed = result.timedOut || result.code !== 0 ? null : extractJson(result.stdout);
      const outcome = judgeOutcome(result, parsed);
      const failure = result.timedOut
        ? "timeout"
        : result.code !== 0 &&
            /\b(?:401|403|unauthorized|unauthenticated|authentication|invalid api key|not logged in)\b/i.test(
              `${result.stderr}\n${result.stdout}`,
            )
          ? "auth"
          : null;
      context.onProcessResult?.(failure);
      traceAttempt(config, prompt, context, carrier, attempt + 1, startedAt, result, outcome);
      if (result.timedOut || outcome === "unavailable") return null;
      if (outcome === "ok") return parsed;
    }
    return null;
  };
}
