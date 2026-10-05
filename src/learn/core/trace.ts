/**
 * Run spans: one row per finished unit of work in `<runtimeDir>/spans.jsonl`,
 * beside the judge-call trace.
 *
 * Rows are shaped like trace spans (trace id, span id, parent, name, start,
 * duration, status) so a later exporter is a pure mapping, and they are closed
 * by `schemas/learn-span.schema.json`: ids, enums, numbers and hashes only.
 * Every row is validated before it is appended and dropped if it fails, so no
 * code path can put prose, a path or a name into the file.
 *
 * A valid ambient `TRACEPARENT` (Firstmate's task carrier) is adopted as the
 * parent; otherwise a unit roots its own trace. Like the judge trace, a span
 * that cannot be written never fails the work it describes.
 */
import { createHmac, randomBytes } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import spanSchema from "../../../schemas/learn-span.schema.json" with { type: "json" };
import type { LearnConfig } from "./config.ts";
import type { LearnContext } from "./context.ts";

export const SPAN_FILE = "spans.jsonl";
const SALT_FILE = ".salt";
const SALT_BYTES = 32;

export type SpanName =
  | "review.run"
  | "review.ingest"
  | "review.maintain"
  | "review.propose"
  | "memory.tick"
  | "memory.episodes"
  | "memory.reflect"
  | "memory.backfill"
  | "memory.nightly"
  | "memory.weekly"
  | "skills.run"
  | "skills.discover"
  | "skills.uses"
  | "hook.session-start"
  | "hook.stop"
  | "hook.prompt";
export type SpanStatus = "ok" | "nothing" | "rejected" | "failed" | "locked" | "skipped" | "dry-run";
export type SpanTrigger = "hook" | "tick" | "force" | "cli";
export type SpanReason =
  | "error"
  | "lock-held"
  | "no-judge-output"
  | "judge-unavailable"
  | "gate-rejected"
  | "debounced"
  | "not-a-repo"
  | "muted"
  | "no-source";
export type SpanAttrValue = number | boolean | string | readonly string[];

const MEMORY_JOB_ATTRS = [
  "dropped_by_provenance",
  "dropped_by_redaction",
  "security_notes",
  "quarantined",
  "tokens_in",
  "tokens_out",
  "episodes",
  "lessons_created",
  "lessons_superseded",
  "proposals",
];

/** Which attributes each span may carry. A key outside its name's list is dropped. */
const ATTRS: Readonly<Record<SpanName, readonly string[]>> = {
  "review.run": [],
  "review.ingest": ["events", "fresh", "deferred", "unavailable"],
  "review.maintain": ["events", "batches", "unusable", "findings", "repeats", "new_patterns", "rejected_parts"],
  "review.propose": ["promoted"],
  "memory.tick": ["projects"],
  "memory.episodes": ["episodes"],
  "memory.reflect": MEMORY_JOB_ATTRS,
  "memory.backfill": MEMORY_JOB_ATTRS,
  "memory.nightly": MEMORY_JOB_ATTRS,
  "memory.weekly": MEMORY_JOB_ATTRS,
  "skills.run": ["pending"],
  "skills.discover": ["sessions", "proposed", "kept"],
  "skills.uses": ["changed", "pending"],
  "hook.session-start": ["block_tokens", "guardrails", "lessons", "roster", "muted", "shown"],
  "hook.stop": ["spawned"],
  "hook.prompt": ["detection", "captured"],
};

export interface SpanRef {
  traceId: string;
  spanId: string;
}

/** The open span a unit's body writes its outcome into. Every method is best-effort and never throws. */
export interface SpanHandle extends SpanRef {
  /** Last call wins; a span nobody marks is `ok`. */
  status(status: SpanStatus, reason?: SpanReason | null): void;
  attr(key: string, value: SpanAttrValue): void;
  /** The project root the unit already resolved; the row keeps only its salted key. */
  project(root: string | null): void;
  /** The ledger commit the unit produced. */
  commit(sha: string | null): void;
}

export interface JudgeTotals {
  calls: number;
  failures: number;
  cost_usd: number;
  cost_known: boolean;
  input_tokens: number;
  output_tokens: number;
}

export interface SpanRow {
  v: 1;
  trace_id: string;
  span_id: string;
  parent_span_id: string | null;
  name: SpanName;
  loop: "review" | "memory" | "skills" | "hook";
  project_key: string | null;
  trigger: SpanTrigger;
  start: string;
  duration_ms: number;
  status: SpanStatus;
  reason: SpanReason | null;
  judge: JudgeTotals;
  attrs: Record<string, SpanAttrValue>;
  commit: string | null;
}

export interface JudgeAttempt {
  ok: boolean;
  costUsd: number | null;
  inputTokens: number;
  outputTokens: number;
}

const validateRow = new Ajv2020({ strict: false }).compile<SpanRow>(spanSchema);

/** Judge totals of every span open in this process, keyed by span id, so a judge call can find its run. */
const openSpans = new Map<string, JudgeTotals>();

function hex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

function emptyTotals(): JudgeTotals {
  return { calls: 0, failures: 0, cost_usd: 0, cost_known: true, input_tokens: 0, output_tokens: 0 };
}

function addTotals(into: JudgeTotals, from: JudgeTotals): void {
  into.calls += from.calls;
  into.failures += from.failures;
  into.cost_usd += from.cost_usd;
  into.cost_known &&= from.cost_known;
  into.input_tokens += from.input_tokens;
  into.output_tokens += from.output_tokens;
}

/** A W3C `traceparent`: version 00, lowercase hex, neither id all zeros. Anything else is null. */
export function parseTraceparent(value: string | undefined): SpanRef | null {
  const match = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/.exec(value ?? "");
  const traceId = match?.[1];
  const spanId = match?.[2];
  if (traceId === undefined || spanId === undefined) return null;
  if (/^0+$/.test(traceId) || /^0+$/.test(spanId)) return null;
  return { traceId, spanId };
}

/** The sampled carrier naming `ref` as the parent of whatever receives it. */
export function carrierOf(ref: SpanRef): string {
  return `00-${ref.traceId}-${ref.spanId}-01`;
}

/** What a judge call records as its run: the enclosing span, or nothing outside one. */
export interface RunLink {
  runId: string | null;
  traceId: string | null;
}

/** The enclosing span as a judge run id, or nothing outside a span. */
export function runOf(ctx: LearnContext): RunLink {
  return { runId: ctx.span?.spanId ?? null, traceId: ctx.span?.traceId ?? null };
}

/** `hook` when a hook started this process (the Stop hook marks the pipeline it detaches), else `fallback`. */
export function triggerOf(ctx: LearnContext, fallback: SpanTrigger): SpanTrigger {
  return ctx.env.AK_LEARN_TRIGGER === "hook" ? "hook" : fallback;
}

/** Add one judge attempt to the open span it ran under. An id with no open span in this process is ignored. */
export function recordJudgeAttempt(runId: string | null, attempt: JudgeAttempt): void {
  const totals = runId === null ? undefined : openSpans.get(runId);
  if (totals === undefined) return;
  totals.calls += 1;
  if (!attempt.ok) totals.failures += 1;
  if (attempt.costUsd === null) totals.cost_known = false;
  else totals.cost_usd += attempt.costUsd;
  totals.input_tokens += attempt.inputTokens;
  totals.output_tokens += attempt.outputTokens;
}

/**
 * The per-install salt, created once and complete: written to a temporary file
 * and linked into place, so a concurrent first use either wins or reads the
 * winner's salt. Only a missing salt is created; an unreadable or malformed one
 * gives null and is left alone, because regenerating it would re-key every project.
 */
function installSalt(config: LearnConfig): Buffer | null {
  const path = join(config.runtimeDir, SALT_FILE);
  if (!existsSync(path)) {
    try {
      mkdirSync(config.runtimeDir, { recursive: true });
      const temp = `${path}.${process.pid}.${hex(4)}`;
      writeFileSync(temp, randomBytes(SALT_BYTES), { mode: 0o600 });
      try {
        linkSync(temp, path);
      } catch {
        // Another process linked its salt first; that one is read below.
      } finally {
        rmSync(temp, { force: true });
      }
    } catch {
      return null;
    }
  }
  try {
    const salt = readFileSync(path);
    return salt.byteLength === SALT_BYTES ? salt : null;
  } catch {
    return null;
  }
}

/**
 * A project's key: HMAC-SHA-256 of its real root path under the install salt,
 * 12 hex. Resolving the real path is a stat-level call, so the scheduled path
 * may use it; telemetry never resolves a root itself and never spawns git.
 */
export function projectKey(config: LearnConfig, root: string): string | null {
  const salt = installSalt(config);
  if (salt === null) return null;
  let real = root;
  try {
    real = realpathSync(root);
  } catch {
    // A root that no longer exists still keys by the path the unit resolved.
  }
  return createHmac("sha256", salt).update(real).digest("hex").slice(0, 12);
}

/** `spans.jsonl` -> `spans.1.jsonl`, `.pipeline.log` -> `.pipeline.1.log`. */
function rotatedPath(path: string): string {
  const name = basename(path);
  const ext = extname(name);
  return join(dirname(path), `${name.slice(0, name.length - ext.length)}.1${ext}`);
}

/**
 * Append `text`, first moving the file over its one previous generation when
 * the append would take it past `maxBytes`. Best-effort: a failure writes
 * nothing and throws nothing. Two processes rotating at the same instant can
 * drop the previous generation, the same limit the judge trace accepts.
 */
export function appendCapped(path: string, text: string, maxBytes: number): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    if (existsSync(path) && statSync(path).size + Buffer.byteLength(text) > maxBytes)
      renameSync(path, rotatedPath(path));
    appendFileSync(path, text);
  } catch {
    return;
  }
}

const LOOPS = ["review", "memory", "skills", "hook"] as const;

function loopOf(name: SpanName): SpanRow["loop"] {
  return LOOPS.find((loop) => name.startsWith(`${loop}.`)) ?? "hook";
}

/**
 * Run `body` as one unit of work and append its span when it finishes, on
 * every exit. The body's context carries the open span, so nested units and
 * judge calls name it as their parent. A throw is recorded as `failed`/`error`
 * and rethrown unchanged.
 */
export function span<T>(ctx: LearnContext, name: SpanName, trigger: SpanTrigger, body: (ctx: LearnContext) => T): T {
  const parent = ctx.span ?? parseTraceparent(ctx.env.TRACEPARENT);
  const ref: SpanRef = { traceId: parent?.traceId ?? hex(16), spanId: hex(8) };
  const started = Date.now();
  const totals = emptyTotals();
  let status: SpanStatus = "ok";
  let reason: SpanReason | null = null;
  let key: string | null = null;
  let commit: string | null = null;
  const attrs: Record<string, SpanAttrValue> = {};
  const handle: SpanHandle = {
    ...ref,
    status: (next, why = null) => {
      status = next;
      reason = why;
    },
    attr: (attrKey, value) => {
      if (ATTRS[name].includes(attrKey)) attrs[attrKey] = value;
    },
    project: (root) => {
      key = root === null ? null : projectKey(ctx.config, root);
    },
    commit: (sha) => {
      commit = sha;
    },
  };
  openSpans.set(ref.spanId, totals);
  try {
    return body({ ...ctx, span: handle });
  } catch (error) {
    status = "failed";
    reason = "error";
    throw error;
  } finally {
    openSpans.delete(ref.spanId);
    const enclosing = ctx.span === undefined ? undefined : openSpans.get(ctx.span.spanId);
    if (enclosing !== undefined) addTotals(enclosing, totals);
    writeSpan(ctx.config, {
      v: 1,
      trace_id: ref.traceId,
      span_id: ref.spanId,
      parent_span_id: parent?.spanId ?? null,
      name,
      loop: loopOf(name),
      project_key: key,
      trigger,
      start: new Date(started).toISOString(),
      duration_ms: Math.max(0, Date.now() - started),
      status,
      reason,
      judge: totals,
      attrs,
      commit,
    });
  }
}

function writeSpan(config: LearnConfig, row: SpanRow): void {
  if (!validateRow(row)) return;
  appendCapped(join(config.runtimeDir, SPAN_FILE), `${JSON.stringify(row)}\n`, config.traceMaxBytes);
}

function rowsIn(path: string): SpanRow[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const rows: SpanRow[] = [];
  for (const line of text.split("\n")) {
    try {
      const parsed: unknown = JSON.parse(line);
      if (validateRow(parsed)) rows.push(parsed);
    } catch {
      continue;
    }
  }
  return rows;
}

/** Every schema-valid row in the retained span files, oldest generation first. */
export function spanRows(config: LearnConfig): SpanRow[] {
  const current = join(config.runtimeDir, SPAN_FILE);
  return [...rowsIn(rotatedPath(current)), ...rowsIn(current)];
}
