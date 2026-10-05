/**
 * The one judgement call the learning runtime makes: a prompt in, a JSON object out.
 *
 * The command is configuration (`AK_LEARN_JUDGE`), so which model answers is
 * the runner's binding and never this package's (ruling
 * `learning-judge-is-runner-bound`). Whatever comes back is checked by
 * deterministic gates before it touches a ledger; the judge never sets counts,
 * status, ids or rates.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import Ajv from "ajv";
import type { LearnConfig } from "./config.ts";
import type { Loop } from "./paths.ts";
import { run } from "./proc.ts";
import type { LearnRole } from "./roles.ts";
import { carrierOf, recordJudgeAttempt } from "./trace.ts";

/** Variables that make a nested CLI believe it is running inside the parent session. */
const NESTED_SESSION_VARS = ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT"];
/** Trace context the judge must not inherit: it gets its own child carrier instead. */
const TRACE_CONTEXT_VARS = ["TRACEPARENT", "TRACESTATE", "BAGGAGE"];
const HOST_MODEL_FIELD = "model";

export interface JudgeCallContext {
  /** The enclosing span's id (`trace.ts` `runOf`); null outside a span. */
  runId: string | null;
  /** The enclosing span's trace; absent or null roots a fresh trace for the call. */
  traceId?: string | null;
  loop: Loop;
  role: LearnRole;
  project: string;
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

interface JudgeTraceSummaryRow {
  at: string;
  call_id: string;
  outcome: JudgeOutcome;
  total_cost_usd: number | null;
}

const validateJudgeTraceSummaryRow = jsonValidator.compile<JudgeTraceSummaryRow>({
  type: "object",
  required: ["at", "call_id", "outcome", "total_cost_usd"],
  properties: {
    at: { type: "string" },
    call_id: { type: "string", pattern: "^[0-9a-f-]{36}$" },
    outcome: { enum: ["ok", "empty", "unparseable", "unavailable", "error"] },
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

/** Move the current trace over the previous one, dropping the bodies of the calls that leave with it. */
function rotateTrace(config: LearnConfig, trace: string): void {
  const rotated = join(config.runtimeDir, "judge-calls.1.jsonl");
  const bodies = join(config.runtimeDir, "judge-bodies");
  for (const row of traceRows(rotated)) {
    rmSync(join(bodies, `${row.call_id}.prompt`), { force: true });
    rmSync(join(bodies, `${row.call_id}.reply`), { force: true });
  }
  renameSync(trace, rotated);
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
      parent_span_id: context.runId,
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
    const line = `${JSON.stringify(row)}\n`;
    const trace = join(config.runtimeDir, "judge-calls.jsonl");
    if (existsSync(trace) && statSync(trace).size + Buffer.byteLength(line) > config.traceMaxBytes)
      rotateTrace(config, trace);
    appendFileSync(trace, line);
    if (config.traceFull) {
      const bodies = join(config.runtimeDir, "judge-bodies");
      mkdirSync(bodies, { recursive: true });
      writeFileSync(join(bodies, `${callId}.prompt`), prompt);
      writeFileSync(join(bodies, `${callId}.reply`), stringField(envelope.result) ?? result.stdout);
    }
  } catch {
    return;
  }
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

const validateJudgeStatsRow = jsonValidator.compile<JudgeStatsRow>({
  type: "object",
  required: ["at", "run_id", "loop", "role", "outcome", "duration_ms", "total_cost_usd"],
  properties: {
    at: { type: "string" },
    run_id: { type: ["string", "null"] },
    loop: { enum: ["review", "memory", "skills"] },
    role: { type: "string" },
    outcome: { enum: ["ok", "empty", "unparseable", "unavailable", "error"] },
    duration_ms: { type: "number", minimum: 0 },
    total_cost_usd: { type: ["number", "null"] },
  },
  additionalProperties: true,
});

/** Every retained judge row, oldest generation first, reduced to the fields usage metrics read. */
export function judgeRows(config: LearnConfig): JudgeStatsRow[] {
  const rows: JudgeStatsRow[] = [];
  for (const name of ["judge-calls.1.jsonl", "judge-calls.jsonl"]) {
    let text: string;
    try {
      text = readFileSync(join(config.runtimeDir, name), "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      try {
        const parsed: unknown = JSON.parse(line);
        if (!validateJudgeStatsRow(parsed)) continue;
        const { at, run_id, loop, role, outcome, duration_ms, total_cost_usd } = parsed;
        rows.push({ at, run_id, loop, role, outcome, duration_ms, total_cost_usd });
      } catch {
        continue;
      }
    }
  }
  return rows;
}

/** Calls, calls without a usable reply and reported cost in the retained trace over the last 24 hours. */
export function judgeTraceSummary(config: LearnConfig, now = Date.now()): JudgeTraceSummary {
  const summary: JudgeTraceSummary = { calls: 0, failures: 0, totalCostUsd: 0 };
  const cutoff = now - TRACE_WINDOW_MS;
  for (const name of ["judge-calls.1.jsonl", "judge-calls.jsonl"]) {
    for (const row of traceRows(join(config.runtimeDir, name))) {
      const at = Date.parse(row.at);
      if (!Number.isFinite(at) || at < cutoff || at > now) continue;
      summary.calls += 1;
      if (row.outcome !== "ok") summary.failures += 1;
      if (row.total_cost_usd !== null && Number.isFinite(row.total_cost_usd))
        summary.totalCostUsd += row.total_cost_usd;
    }
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
export function commandJudge(config: LearnConfig): JudgeFn {
  return (prompt: string, context: JudgeCallContext) => {
    mkdirSync(config.runtimeDir, { recursive: true });
    const env: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (!NESTED_SESSION_VARS.includes(key) && !TRACE_CONTEXT_VARS.includes(key)) env[key] = value;
    }
    const traceId = context.traceId ?? randomBytes(16).toString("hex");
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const carrier = { traceId, spanId: randomBytes(8).toString("hex") };
      const startedAt = Date.now();
      const result = run(config.judgeCommand, {
        cwd: config.runtimeDir,
        input: prompt,
        env: { ...env, TRACEPARENT: carrierOf(carrier) },
        timeoutMs: config.judgeTimeoutMs,
      });
      const parsed = result.timedOut || result.code !== 0 ? null : extractJson(result.stdout);
      const outcome = judgeOutcome(result, parsed);
      traceAttempt(config, prompt, context, carrier, attempt + 1, startedAt, result, outcome);
      if (result.timedOut || outcome === "unavailable") return null;
      if (outcome === "ok") return parsed;
    }
    return null;
  };
}
