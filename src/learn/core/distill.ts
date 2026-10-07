/**
 * The one seam a tool-call distiller is reached through: a host, the command
 * the operator bound to it and a prompt in, a JSON object out.
 *
 * The command is configuration (`AK_LEARN_DISTILL_<HOST>`), read from the
 * operator's environment and never from this package, so what answers for a
 * host is the operator's binding. Nothing is bound by default, and a host with
 * no binding is never passed here. The scheduled tick sees a binding only once
 * `ak learn setup schedule` writes the unit again, since the unit keeps the
 * `AK_LEARN_*` environment it was written with. The distiller rewrites text
 * and decides nothing, so it is not one of the learning roles and takes no
 * role prompt (ruling `learning-judge-is-runner-bound` covers judgements); its
 * caller scrubs what goes in and gates what comes back.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv from "ajv";
import type { LearnConfig } from "./config.ts";
import { extractJson } from "./judge.ts";
import { run } from "./proc.ts";
import { gateJsonText } from "./store.ts";
import { appendCapped, generations } from "./trace.ts";

/** Variables that make a nested CLI believe it is running inside the parent session, and the caller's trace context. */
const NOT_INHERITED = ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "TRACEPARENT", "TRACESTATE", "BAGGAGE"];
const STDERR_TAIL_CHARS = 2_000;
const TRACE_WINDOW_MS = 24 * 60 * 60 * 1000;

export const DISTILL_TRACE_FILE = "distill-calls.jsonl";

export interface DistillRequest {
  /** The worker host whose session the calls came from. */
  host: string;
  /** That host's bound command, as argv. */
  command: readonly string[];
  /** Scrubbed text only: the stage scrubs every call before it builds this. */
  prompt: string;
  /** How many tool calls the prompt carries. */
  calls: number;
  /** The project's own name, a label for the trace row. It is the operator's, not captured text, and is never sent. */
  project: string;
}

/** What a distiller hands back: the JSON object its command printed, or null when it printed none. */
export type DistillReply = ReturnType<typeof extractJson>;

export type DistillFn = (request: DistillRequest) => DistillReply;

/** What the caller got: `ok` is a JSON object, every other value is no reply. */
export type DistillOutcome = "ok" | "empty" | "unparseable" | "error";

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
type HostEnvelope = Record<string, JsonValue>;

export interface DistillTraceRow {
  at: string;
  host: string;
  project: string;
  calls: number;
  prompt_sha256: string;
  prompt_chars: number;
  reply_chars: number;
  outcome: DistillOutcome;
  exit_code: number;
  timed_out: boolean;
  stderr_tail: string;
  duration_ms: number;
  /** What the command reported about its own call, when its stdout is a JSON envelope that says. */
  usage: JsonValue;
  total_cost_usd: number | null;
}

export interface DistillTraceSummary {
  calls: number;
  failures: number;
  totalCostUsd: number;
}

const jsonValidator = new Ajv({ strict: false });
const validateEnvelope = jsonValidator.compile<HostEnvelope>({ type: "object" });
const validateNumber = jsonValidator.compile<number>({ type: "number" });
const validateSummaryRow = jsonValidator.compile<Pick<DistillTraceRow, "at" | "outcome" | "total_cost_usd">>({
  type: "object",
  required: ["at", "outcome", "total_cost_usd"],
  properties: {
    at: { type: "string" },
    outcome: { enum: ["ok", "empty", "unparseable", "error"] },
    total_cost_usd: { type: ["number", "null"] },
  },
});

function hostEnvelope(stdout: string): HostEnvelope {
  try {
    const parsed: unknown = JSON.parse(stdout.trim());
    return validateEnvelope(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function outcomeOf(result: ReturnType<typeof run>, parsed: DistillReply): DistillOutcome {
  if (result.timedOut || result.code !== 0) return "error";
  if (result.stdout.trim() === "") return "empty";
  return parsed === null ? "unparseable" : "ok";
}

/** One row per request, metadata only: the prompt and the reply are never written. Best-effort, like the judge trace. */
function trace(config: LearnConfig, row: DistillTraceRow): void {
  try {
    const path = join(config.runtimeDir, DISTILL_TRACE_FILE);
    appendCapped(path, gateJsonText(config.runtimeDir, path, `${JSON.stringify(row)}\n`), config.traceMaxBytes);
  } catch {
    return;
  }
}

function summaryRows(path: string): Array<Pick<DistillTraceRow, "at" | "outcome" | "total_cost_usd">> {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  return text.split("\n").flatMap((line) => {
    if (line.trim() === "") return [];
    try {
      const row: unknown = JSON.parse(line);
      return validateSummaryRow(row) ? [row] : [];
    } catch {
      return [];
    }
  });
}

/** Requests, requests without a usable reply and reported cost in the retained trace over the last 24 hours. */
export function distillTraceSummary(config: LearnConfig, now = Date.now()): DistillTraceSummary {
  const summary: DistillTraceSummary = { calls: 0, failures: 0, totalCostUsd: 0 };
  const cutoff = now - TRACE_WINDOW_MS;
  for (const row of generations(join(config.runtimeDir, DISTILL_TRACE_FILE)).flatMap(summaryRows)) {
    const at = Date.parse(row.at);
    if (!Number.isFinite(at) || at < cutoff || at > now) continue;
    summary.calls += 1;
    if (row.outcome !== "ok") summary.failures += 1;
    if (row.total_cost_usd !== null && Number.isFinite(row.total_cost_usd)) summary.totalCostUsd += row.total_cost_usd;
  }
  return summary;
}

/**
 * A distiller that runs the request's command. One attempt: a failed request is not paid for twice,
 * and its calls keep their excerpts. The command runs from the runtime directory, so it discovers no
 * project instructions from its working directory.
 */
export function commandDistiller(config: LearnConfig): DistillFn {
  return (request: DistillRequest) => {
    mkdirSync(config.runtimeDir, { recursive: true });
    const env: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(process.env)) if (!NOT_INHERITED.includes(key)) env[key] = value;
    const startedAt = Date.now();
    const result = run(request.command, {
      cwd: config.runtimeDir,
      input: request.prompt,
      env,
      timeoutMs: config.distillTimeoutMs,
    });
    const parsed = result.timedOut || result.code !== 0 ? null : extractJson(result.stdout);
    const envelope = hostEnvelope(result.stdout);
    const cost = envelope.total_cost_usd;
    trace(config, {
      at: new Date(startedAt).toISOString(),
      host: request.host,
      project: request.project,
      calls: request.calls,
      prompt_sha256: createHash("sha256").update(request.prompt).digest("hex"),
      prompt_chars: request.prompt.length,
      reply_chars: result.stdout.length,
      outcome: outcomeOf(result, parsed),
      exit_code: result.code,
      timed_out: result.timedOut,
      stderr_tail: result.stderr.slice(-STDERR_TAIL_CHARS),
      duration_ms: Date.now() - startedAt,
      usage: envelope.usage ?? null,
      total_cost_usd: validateNumber(cost) ? cost : null,
    });
    return parsed;
  };
}
