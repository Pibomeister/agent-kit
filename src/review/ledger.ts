/**
 * The review convergence ledger on disk (ADR-0018): one append-only JSONL file
 * per pull request, in the form `schemas/review-ledger.schema.json` gives.
 *
 * This file owns what the engine in `converge.ts` must not do: read and append
 * the file, compute a finding's fingerprint, theme and anchor from a snapshot,
 * and turn what a seat reported into ledger lines. A report of a known
 * fingerprint becomes a second seat on an unresolved row, or a repeat of a
 * terminal one, and never a second id.
 *
 * A line is never edited or removed. `seq` counts lines from 1 with no gap.
 * The reader skips a line that is not JSON, which is what an interrupted
 * write leaves, and refuses a file whose `seq` does not continue.
 *
 * This is not the learning runtime's review ledger in `src/learn/review/`.
 */

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, sep } from "node:path";

import Ajv2020, { type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import commonSchema from "../../schemas/common.schema.json" with { type: "json" };
import ledgerSchema from "../../schemas/review-ledger.schema.json" with { type: "json" };
import { fold, isUnresolved, roundCap, step } from "./converge.ts";
import {
  PIPELINE_SEAT,
  type Anchor,
  type Category,
  type ConvergencePolicy,
  type FindingEvent,
  type RepeatEvent,
  type RoundCloseEvent,
  type RoundOpenEvent,
  type LedgerEvent,
  type LedgerState,
  type Origin,
  type OpenRound,
  type Risk,
  type RoundMode,
  type Row,
  type Severity,
  type TerminalStatus,
} from "./types.ts";

const SCHEMA_ID = ledgerSchema.$id;

export function sha256(text: string | Buffer): string {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

/** The identity of a finding. No line number is in it, so moved code keeps its finding. */
export function fingerprint(category: Category, file: string, symbol: string, causeKey: string): string {
  return sha256(JSON.stringify([category, file, symbol, causeKey]));
}

/** The coarse key the same-theme rule and the candidate-duplicate list read. */
export function themeOf(category: Category, file: string, symbol: string): string {
  return sha256(JSON.stringify([category, file, symbol]));
}

/** What a seat reports for a finding. The tool computes the rest. */
export interface FindingReport {
  kind: "finding";
  seat: string;
  severity: Severity;
  category: Category;
  origin: Origin;
  file: string;
  line: number;
  symbol?: string;
  blob?: string;
  cause_key: string;
  text: string;
  suggested_fix?: string;
  in_scope?: boolean;
  risk?: Risk;
  rule?: string;
  status?: TerminalStatus;
  disposition?: string;
}

/** One object of the `--event` input. Each kind is checked against its ledger line definition. */
export interface InputItem {
  kind: string;
}

interface RoundOpenInput {
  kind: "round-open";
  head: string;
  mode?: RoundMode;
  max_rounds?: number;
}

interface RoundCloseInput {
  kind: "round-close";
  anchors?: { id: string; blob: string }[];
}

interface Guards {
  event: ValidateFunction<LedgerEvent>;
  report: ValidateFunction<FindingReport>;
  item: ValidateFunction<InputItem>;
  roundOpen: ValidateFunction<RoundOpenInput>;
  roundClose: ValidateFunction<RoundCloseInput>;
  byKind: (kind: string) => ValidateFunction | undefined;
}

let compiled: Guards | undefined;

/** The validators, compiled on first use so that `ak` commands that never read a ledger do not pay for them. */
function guards(): Guards {
  if (compiled !== undefined) return compiled;
  const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: true });
  addFormats(ajv);
  ajv.addSchema(commonSchema);
  const event = ajv.compile<LedgerEvent>(ledgerSchema);
  compiled = {
    event,
    report: ajv.compile<FindingReport>({ $ref: `${SCHEMA_ID}#/$defs/finding_report` }),
    item: ajv.compile<InputItem>({ type: "object", required: ["kind"], properties: { kind: { type: "string" } } }),
    roundOpen: ajv.compile<RoundOpenInput>({
      type: "object",
      additionalProperties: false,
      required: ["kind", "head"],
      properties: {
        kind: { const: "round-open" },
        head: { type: "string" },
        mode: { enum: ["import", "full", "closure", "bounded"] },
        max_rounds: { type: "integer" },
      },
    }),
    roundClose: ajv.compile<RoundCloseInput>({
      type: "object",
      additionalProperties: false,
      required: ["kind"],
      properties: {
        kind: { const: "round-close" },
        anchors: { $ref: `${SCHEMA_ID}#/$defs/round-close/properties/anchors` },
      },
    }),
    byKind: (kind) => (kind in ledgerSchema.$defs ? ajv.getSchema(`${SCHEMA_ID}#/$defs/${kind}`) : undefined),
  };
  return compiled;
}

function detail(errors: readonly ErrorObject[] | null | undefined): string {
  return (errors ?? [])
    .slice(0, 4)
    .map((error) => `${error.instancePath === "" ? "the line" : error.instancePath} ${error.message ?? "is invalid"}`)
    .join("; ");
}

export function isLedgerEvent(value: unknown): value is LedgerEvent {
  return guards().event(value);
}

/** A line before it is checked: what the tool built from an input. */
interface Candidate {
  v: number;
  seq: number;
  kind: string;
}

/** Why `value` is not a ledger line, read from the definition of its own kind where it names one. */
function eventProblem(kind: string, value: Candidate): string {
  const validate = guards().byKind(kind);
  if (validate === undefined) return `no ledger line has kind ${JSON.stringify(kind)}`;
  return validate(value) ? "does not match the ledger line schema" : detail(validate.errors);
}

const CODE_SYMBOL = /^[A-Za-z_$]/;
const HEADING = /^#{1,6}\s/;
const WORD = /[A-Za-z_$][\w$]*/g;
const KEYWORDS = new Set([
  "export",
  "default",
  "async",
  "function",
  "class",
  "const",
  "let",
  "var",
  "static",
  "public",
  "private",
  "protected",
  "interface",
  "type",
  "enum",
  "abstract",
  "declare",
  "def",
  "func",
  "fn",
  "pub",
]);

function startsSymbol(file: string, line: string): boolean {
  return file.endsWith(".md") ? HEADING.test(line) : CODE_SYMBOL.test(line);
}

function symbolName(file: string, line: string): string {
  if (file.endsWith(".md")) return line.replace(/^#+\s*/, "").trim();
  return (line.match(WORD) ?? []).find((word) => !KEYWORDS.has(word)) ?? "";
}

interface SymbolSpan {
  name: string;
  /** Index of the first line of the body. */
  start: number;
  /** Index one past the last line of the body. */
  end: number;
}

/**
 * The symbols of a file, by the rule `git diff` uses for a hunk header: a line
 * that starts in column one with a letter, `_` or `$` opens a symbol, and in
 * Markdown a heading does. A symbol's body runs to the next such line. The
 * lines before the first one are the symbol with the empty name. The rule
 * reads no grammar, so it gives the same answer for every language and on
 * every machine.
 */
export function symbolsOf(file: string, text: string): SymbolSpan[] {
  const lines = text.split("\n");
  const spans: SymbolSpan[] = [{ name: "", start: 0, end: lines.length }];
  lines.forEach((line, index) => {
    if (!startsSymbol(file, line)) return;
    const last = spans.at(-1);
    if (last !== undefined) last.end = index;
    spans.push({ name: symbolName(file, line), start: index, end: lines.length });
  });
  return spans;
}

export interface SymbolAnchor {
  symbol: string;
  blob: string;
}

function bodyBlob(text: string, span: SymbolSpan): string {
  return sha256(text.split("\n").slice(span.start, span.end).join("\n"));
}

/** The enclosing symbol of `line` (from 1) and the digest of its body. */
export function anchorAt(file: string, text: string, line: number): SymbolAnchor {
  const spans = symbolsOf(file, text);
  const index = Math.max(0, line - 1);
  const span = spans.findLast((candidate) => candidate.start <= index) ?? spans[0];
  if (span === undefined) return { symbol: "", blob: sha256("") };
  return { symbol: span.name, blob: bodyBlob(text, span) };
}

/** The digest of the body of the first symbol named `symbol`, or null when the file has none. */
export function blobOf(file: string, text: string, symbol: string): string | null {
  const span = symbolsOf(file, text).find((candidate) => candidate.name === symbol);
  return span === undefined ? null : bodyBlob(text, span);
}

/** A file of the snapshot, or null when it is absent there. A path that resolves outside the snapshot is refused. */
function snapshotText(snapshot: string, file: string): string | null {
  const root = realpathSync(snapshot);
  const target = join(root, file);
  if (!existsSync(target)) return null;
  const real = realpathSync(target);
  if (!real.startsWith(`${root}${sep}`)) throw new Error(`${file} resolves outside the snapshot`);
  return statSync(real).isFile() ? readFileSync(real, "utf8") : null;
}

function anchorOf(report: FindingReport, snapshot: string | undefined): Anchor {
  if (snapshot === undefined)
    return { file: report.file, symbol: report.symbol ?? "", line: report.line, blob: report.blob ?? sha256("") };
  const text = snapshotText(snapshot, report.file) ?? "";
  return { file: report.file, line: report.line, ...anchorAt(report.file, text, report.line) };
}

export interface LedgerFile {
  events: LedgerEvent[];
  /** Lines that are not JSON: what an interrupted write leaves. They are skipped. */
  torn: number;
  /** Whether the file ends inside a line, so the next append must start a new one. */
  unterminated: boolean;
  sha256: string;
}

/**
 * Read a ledger. A missing file is an empty ledger. A line that is not JSON is
 * counted and skipped. A line that is JSON and not a ledger line, or whose
 * `seq` does not continue from the line before, is an error: that is a
 * removed, reordered or foreign line, and no verdict is read from such a file.
 */
export function readLedger(path: string): LedgerFile {
  if (!existsSync(path)) return { events: [], torn: 0, unterminated: false, sha256: sha256("") };
  const text = readFileSync(path, "utf8");
  const events: LedgerEvent[] = [];
  let torn = 0;
  text.split("\n").forEach((line, index) => {
    if (line.trim() === "") return;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      torn += 1;
      return;
    }
    if (!isLedgerEvent(value)) throw new Error(`${path}:${index + 1}: not a ledger line`);
    if (value.seq !== events.length + 1)
      throw new Error(`${path}:${index + 1}: seq is ${value.seq} and the next line is ${events.length + 1}`);
    events.push(value);
  });
  return { events, torn, unterminated: text !== "" && !text.endsWith("\n"), sha256: sha256(text) };
}

/** Append lines in one write. The file is created owner-only. */
export function appendLedger(path: string, events: readonly LedgerEvent[], unterminated: boolean): void {
  if (events.length === 0) return;
  const lines = events.map((event) => `${JSON.stringify(event)}\n`).join("");
  appendFileSync(path, `${unterminated ? "\n" : ""}${lines}`, { mode: 0o600 });
}

/** What became of one input object. */
export interface AddOutcome {
  input: number;
  kind: string;
  /** The kinds of the lines the input became. Empty when the ledger already holds what it says. */
  lines: string[];
  id?: string;
  status?: string;
  /** Earlier rows with the same theme and a different fingerprint: candidate duplicates. */
  candidates?: string[];
  note?: string;
}

export interface AddOptions {
  policy: ConvergencePolicy;
  snapshot?: string;
  /** Lowers the round cap of a scope whose round 1 this call opens. */
  maxRounds?: number;
}

export interface AddResult {
  appended: LedgerEvent[];
  outcomes: AddOutcome[];
}

interface Adding {
  state: LedgerState;
  seq: number;
  appended: LedgerEvent[];
  options: AddOptions;
}

/** Check a candidate line against the schema and the engine, then take it. */
function admit(adding: Adding, input: number, kind: string, candidate: Candidate): LedgerEvent {
  if (!guards().event(candidate)) throw new Error(`input ${input} (${kind}): ${eventProblem(kind, candidate)}`);
  const refused = step(adding.state, candidate, adding.options.policy);
  if (refused !== null) throw new Error(`input ${input} (${kind}): ${refused}`);
  adding.seq += 1;
  adding.appended.push(candidate);
  return candidate;
}

/** Number a line. An input never carries `v` or `seq`, so the spread cannot replace them. */
function numbered<T extends { kind: string }>(adding: Adding, rest: T): T & { v: 1; seq: number } {
  return { v: 1, seq: adding.seq + 1, ...rest };
}

function openRound(adding: Adding, input: number, kind: string): OpenRound {
  if (adding.state.open === null) throw new Error(`input ${input} (${kind}): no round is open`);
  return adding.state.open;
}

function knownRow(adding: Adding, input: number, row: Row, report: FindingReport, anchor: Anchor): AddOutcome {
  if (isUnresolved(row) || (row.status === "observation" && row.seats.every((seat) => seat === PIPELINE_SEAT))) {
    if (row.seats.includes(report.seat))
      return {
        input,
        kind: "finding",
        lines: [],
        id: row.id,
        status: row.status,
        note: "already reported by this seat",
      };
    admit(adding, input, "seat", numbered(adding, { kind: "seat", id: row.id, seat: report.seat }));
    return { input, kind: "finding", lines: ["seat"], id: row.id, status: row.status };
  }
  const reopened = row.reopened;
  const repeat: RepeatEvent = numbered(adding, {
    kind: "repeat",
    id: row.id,
    seat: report.seat,
    in_scope: report.in_scope ?? true,
  });
  // Without a snapshot or a reported digest there is no body to compare, and the repeat cannot show a change.
  if (adding.options.snapshot !== undefined || report.blob !== undefined) repeat.blob = anchor.blob;
  if (report.risk !== undefined) repeat.risk = report.risk;
  admit(adding, input, "repeat", repeat);
  if (row.reopened > reopened)
    return { input, kind: "finding", lines: ["repeat"], id: row.id, status: row.status, note: "reopened" };
  const flip = numbered(adding, {
    kind: "flip",
    id: row.id,
    seat: report.seat,
    reason: "no change in the anchor and no new evidence",
  });
  admit(adding, input, "flip", flip);
  return {
    input,
    kind: "finding",
    lines: ["repeat", "flip"],
    id: row.id,
    status: row.status,
    note: "repeat of a terminal row: not shown to the author",
  };
}

function addFinding(adding: Adding, input: number, item: InputItem): AddOutcome {
  const report: unknown = item;
  const validate = guards().report;
  if (!validate(report)) throw new Error(`input ${input} (finding): ${detail(validate.errors)}`);
  const open = openRound(adding, input, "finding");
  const anchor = anchorOf(report, adding.options.snapshot);
  const print = fingerprint(report.category, report.file, anchor.symbol, report.cause_key);
  const known = adding.state.rows.find((row) => row.fingerprint === print);
  if (known !== undefined) return knownRow(adding, input, known, report, anchor);
  const theme = themeOf(report.category, report.file, anchor.symbol);
  const candidates = adding.state.rows.filter((row) => row.theme === theme).map((row) => row.id);
  const id = `F${adding.state.rows.length + 1}`;
  const line: FindingEvent = numbered(adding, {
    kind: "finding",
    id,
    fingerprint: print,
    theme,
    anchor,
    severity: report.severity,
    category: report.category,
    origin: report.origin,
    seat: report.seat,
    first_seen_head: open.head,
    first_seen_scope: open.scope,
    first_seen_round: open.round,
    cause_key: report.cause_key,
    text: report.text,
    // Round 1 reviews the whole change, so nothing in it is outside the scope.
    in_scope: open.mode === "full" || (report.in_scope ?? true),
  });
  if (report.suggested_fix !== undefined) line.suggested_fix = report.suggested_fix;
  if (report.risk !== undefined) line.risk = report.risk;
  if (report.rule !== undefined) line.rule = report.rule;
  if (candidates.length > 0) line.candidates = candidates;
  if (report.status !== undefined) line.status = report.status;
  if (report.disposition !== undefined) line.disposition = report.disposition;
  admit(adding, input, "finding", line);
  const outcome: AddOutcome = { input, kind: "finding", lines: ["finding"], id };
  const row = adding.state.rows.at(-1);
  if (row !== undefined) outcome.status = row.status;
  if (candidates.length > 0) outcome.candidates = candidates;
  return outcome;
}

/** The mode of the next round when the input does not name one. After the cap and a council call it is the bounded round. */
function nextMode(state: LedgerState): RoundMode {
  if (state.round === 0) return "full";
  return state.round < roundCap(state) || state.council === null ? "closure" : "bounded";
}

function addRoundOpen(adding: Adding, input: number, item: InputItem): AddOutcome {
  const given: unknown = item;
  const validate = guards().roundOpen;
  if (!validate(given)) throw new Error(`input ${input} (round-open): ${detail(validate.errors)}`);
  const mode = given.mode ?? nextMode(adding.state);
  const cap = given.max_rounds ?? adding.options.maxRounds;
  const line: RoundOpenEvent = numbered(adding, {
    kind: "round-open",
    scope: adding.state.scope,
    round: mode === "import" ? 0 : adding.state.round + 1,
    mode,
    head: given.head,
  });
  if (mode === "full" && cap !== undefined) line.max_rounds = cap;
  admit(adding, input, "round-open", line);
  return { input, kind: "round-open", lines: ["round-open"] };
}

/** The digest of every row's symbol body at the snapshot, which is what a later repeat is compared with. */
function closeAnchors(adding: Adding): { id: string; blob: string }[] {
  const snapshot = adding.options.snapshot;
  if (snapshot === undefined) return [];
  const anchors: { id: string; blob: string }[] = [];
  for (const row of adding.state.rows) {
    const text = snapshotText(snapshot, row.anchor.file);
    const blob = text === null ? null : blobOf(row.anchor.file, text, row.anchor.symbol);
    if (blob !== null) anchors.push({ id: row.id, blob });
  }
  return anchors;
}

function addRoundClose(adding: Adding, input: number, item: InputItem): AddOutcome {
  const given: unknown = item;
  const validate = guards().roundClose;
  if (!validate(given)) throw new Error(`input ${input} (round-close): ${detail(validate.errors)}`);
  const anchors = given.anchors ?? closeAnchors(adding);
  const line: RoundCloseEvent = numbered(adding, { kind: "round-close" });
  if (anchors.length > 0) line.anchors = anchors;
  admit(adding, input, "round-close", line);
  return { input, kind: "round-close", lines: ["round-close"] };
}

/** The line kinds only this tool writes: it decides them from the ledger, so an input may not state them. */
const COMPUTED = new Set(["seat", "repeat", "flip"]);

function addOne(adding: Adding, input: number, item: InputItem): AddOutcome {
  if (item.kind === "finding") return addFinding(adding, input, item);
  if (item.kind === "round-open") return addRoundOpen(adding, input, item);
  if (item.kind === "round-close") return addRoundClose(adding, input, item);
  if (COMPUTED.has(item.kind))
    throw new Error(`input ${input} (${item.kind}): the tool writes this line from a finding report`);
  // The tool numbers a scope as it numbers a line: the input names the trigger and the head.
  const candidate =
    item.kind === "scope-open"
      ? numbered(adding, { ...item, scope: adding.state.scope + 1 })
      : numbered(adding, { ...item });
  const line = admit(adding, input, item.kind, candidate);
  const outcome: AddOutcome = { input, kind: item.kind, lines: [line.kind] };
  if ("id" in line) outcome.id = line.id;
  return outcome;
}

/** Parse the `--event` input: one object or an array of them. */
export function parseInput(text: string): InputItem[] {
  const value: unknown = JSON.parse(text);
  const list: unknown[] = Array.isArray(value) ? value : [value];
  const validate = guards().item;
  return list.map((entry, index) => {
    if (!validate(entry)) throw new Error(`input ${index + 1}: an object with a kind is expected`);
    if ("v" in entry || "seq" in entry) throw new Error(`input ${index + 1}: the tool numbers the lines`);
    return entry;
  });
}

/**
 * Turn inputs into ledger lines after the lines in `existing`. Nothing is
 * written here. One refused input refuses the whole call, so a batch lands
 * complete or not at all.
 */
export function addEvents(
  existing: readonly LedgerEvent[],
  items: readonly InputItem[],
  options: AddOptions,
): AddResult {
  const state = fold(existing, options.policy);
  if (state.problems.length > 0) throw new Error(`the ledger has refused lines: ${state.problems.join("; ")}`);
  const adding: Adding = { state, seq: existing.length, appended: [], options };
  const outcomes = items.map((item, index) => addOne(adding, index + 1, item));
  return { appended: adding.appended, outcomes };
}
