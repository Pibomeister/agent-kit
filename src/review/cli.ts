/**
 * `ak review ledger add|show`, `ak review scope` and `ak review decide`: the
 * convergence ledger of one pull request, what its next review covers and the
 * verdict the engine reads from it (ADR-0018).
 *
 * - `ledger add` turns what seats, the author and the gate reported into
 *   ledger lines and appends them, or refuses the whole input.
 * - `ledger show` prints the state the lines fold to.
 * - `scope` compares the pull request at a head with the pull request at the
 *   last reviewed head and prints what the next review covers: the whole
 *   change, the delta, nothing, or a new scope. It reads git and appends
 *   nothing. Its record holds the ledger input that records a carry or a new scope.
 * - `decide` prints the verdict for one exact head: `approved`, `blocked` or
 *   `incomplete`, and the one next action.
 *
 * Each command writes one JSON record. With `--out` the record goes to that
 * file and one line goes to stdout, as `ak council run` does. No command
 * calls a model, runs a test or reads a clock.
 *
 * A record grants no authority. It is evidence a gate or an owner may read; it
 * approves no checkpoint, ticket, merge or deploy. The ledger is what its
 * writer says happened: the engine does not check who appended a line.
 * `ak review decide` trusts those lines, so the ledger file must sit outside
 * author write.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";

import Ajv2020, { type ValidateFunction } from "ajv/dist/2020.js";

import { CLASS_RANK, readMergeRecord, scoreDelegationRun } from "../delegation.ts";
import { decide, fold } from "./converge.ts";
import { readDelta, readHead, resolveCommit } from "./delta.ts";
import {
  addEvents,
  appendLedger,
  parseInput,
  readLedger,
  sha256,
  type AddOptions,
  type InputItem,
  type LedgerFile,
} from "./ledger.ts";
import { scopeOutcome, scopeTriggers, type ScopeFacts } from "./scope.ts";
import { DEFAULT_POLICY, type ConvergencePolicy } from "./types.ts";

export interface ReviewIo {
  out: (line: string) => void;
  err: (line: string) => void;
  /** Reads the `--event -` input. Defaults to the process's stdin. */
  stdin?: () => string;
}

const USAGE = [
  "usage: ak review ledger add --ledger <ledger.jsonl> --event <file|-> [--repo <dir>] [--previous <scope.json>] [--snapshot <dir>] [--max-rounds <2|3>] [--out <record.json>]",
  "       ak review ledger show --ledger <ledger.jsonl> [--out <record.json>]",
  "       ak review scope --ledger <ledger.jsonl> --base <rev> --head <rev> [--repo <dir>] [--previous <scope.json>] [--record <merge-record.json>] [--ticket <file>] [--project <file>] [--intent <file>] [--criteria <file>] [--out <record.json>]",
  "       ak review decide --ledger <ledger.jsonl> --head <sha> --seats <n> [--missing-evidence <item>]... [--integrity-failure <reason>]... [--out <record.json>]",
  "       The ledger must sit outside author write. ak review decide trusts its lines.",
];

const NOTE = "This record grants no authority. It approves no checkpoint, ticket, merge or deploy.";

/** Flags that may be given more than once. */
const REPEATED = new Set(["--missing-evidence", "--integrity-failure"]);

const FLAGS = {
  add: ["--ledger", "--event", "--repo", "--previous", "--snapshot", "--max-rounds", "--out"],
  show: ["--ledger", "--out"],
  scope: [
    "--ledger",
    "--base",
    "--head",
    "--repo",
    "--previous",
    "--record",
    "--ticket",
    "--project",
    "--intent",
    "--criteria",
    "--out",
  ],
  decide: ["--ledger", "--head", "--seats", "--missing-evidence", "--integrity-failure", "--out"],
};

type Command = keyof typeof FLAGS;

/** `ledger add`, `ledger show`, `scope` or `decide`, or undefined for anything else. */
function commandOf(argv: readonly string[]): Command | undefined {
  if (argv[0] === "decide" || argv[0] === "scope") return argv[0];
  if (argv[0] !== "ledger") return undefined;
  return argv[1] === "add" || argv[1] === "show" ? argv[1] : undefined;
}

interface Flags {
  one: Map<string, string>;
  many: Map<string, string[]>;
}

type Parsed = { ok: true; flags: Flags } | { ok: false; error: string };

function parseFlags(argv: readonly string[], allowed: readonly string[]): Parsed {
  const one = new Map<string, string>();
  const many = new Map<string, string[]>();
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i] ?? "";
    const value = argv[i + 1];
    if (!allowed.includes(name)) return { ok: false, error: `unknown flag ${name}` };
    if (value === undefined || (value.startsWith("--") && value !== "-"))
      return { ok: false, error: `${name} needs a value` };
    if (REPEATED.has(name)) many.set(name, [...(many.get(name) ?? []), value]);
    else if (one.has(name)) return { ok: false, error: `${name} is given twice` };
    else one.set(name, value);
  }
  return { ok: true, flags: { one, many } };
}

class UsageError extends Error {}

function required(flags: Flags, name: string): string {
  const value = flags.one.get(name);
  if (value === undefined) throw new UsageError(`${name} is required`);
  return value;
}

function emit(io: ReviewIo, out: string | undefined, line: string, record: { schema: string }): void {
  const text = `${JSON.stringify(record, null, 2)}\n`;
  if (out === undefined) {
    io.out(text.trimEnd());
    return;
  }
  writeFileSync(out, text, { mode: 0o600 });
  io.out(`${line}: ${out}`);
}

function ledgerRef(path: string, file: LedgerFile) {
  return { path, sha256: file.sha256, lines: file.events.length, torn: file.torn };
}

function maxRounds(flags: Flags, policy: ConvergencePolicy): number | undefined {
  const given = flags.one.get("--max-rounds");
  if (given === undefined) return undefined;
  // The cap may be lowered to 2. Nothing raises it.
  if (given !== "2" && given !== String(policy.max_rounds))
    throw new UsageError(`--max-rounds is 2 or ${policy.max_rounds}`);
  return Number(given);
}

const COMMIT = { type: "string", pattern: "^[0-9a-f]{40}([0-9a-f]{24})?$" };

interface CarryScope {
  schema: "review-scope";
  outcome: "carry";
  head: string;
  base: string;
  previous: { head: string };
  delta: { empty: true };
  event: { kind: "carry"; head: string };
}

let scopeRecordValidator: ValidateFunction<{ schema: "review-scope" }> | null = null;
let carryValidator: ValidateFunction<CarryScope> | null = null;

function validateScopeRecord(): ValidateFunction<{ schema: "review-scope" }> {
  scopeRecordValidator ??= new Ajv2020({ strict: false }).compile<{ schema: "review-scope" }>({
    type: "object",
    required: ["schema"],
    properties: { schema: { const: "review-scope" } },
  });
  return scopeRecordValidator;
}

function validateCarryScope(): ValidateFunction<CarryScope> {
  carryValidator ??= new Ajv2020({ strict: false }).compile<CarryScope>({
    type: "object",
    required: ["schema", "outcome", "head", "base", "previous", "delta", "event"],
    properties: {
      schema: { const: "review-scope" },
      outcome: { const: "carry" },
      head: COMMIT,
      base: COMMIT,
      previous: { type: "object", required: ["head"], properties: { head: COMMIT } },
      delta: { type: "object", required: ["empty"], properties: { empty: { const: true } } },
      event: {
        type: "object",
        required: ["kind", "head"],
        properties: { kind: { const: "carry" }, head: COMMIT },
      },
    },
  });
  return carryValidator;
}

/** A carry line is admitted only from a scope record whose delta is empty against the last reviewed head. */
function carryFromScope(record: CarryScope, covered: string | null, repo: string): InputItem {
  if (record.event.head !== record.head) throw new Error("a carry line needs a scope record of the carried head");
  if (record.previous.head !== covered)
    throw new Error("a carry line needs a scope record whose previous.head is the last reviewed head");
  const reading = readDelta(repo, record.base, record.previous.head, record.event.head);
  if (!reading.delta.empty) throw new Error("a carry line needs a scope record whose delta is empty against that head");
  const item = { kind: "carry", head: record.event.head };
  return item;
}

function add(flags: Flags, io: ReviewIo): number {
  const path = required(flags, "--ledger");
  const source = required(flags, "--event");
  const cap = maxRounds(flags, DEFAULT_POLICY);
  const snapshot = flags.one.get("--snapshot");
  const repo = flags.one.get("--repo") ?? process.cwd();
  const text = source === "-" ? (io.stdin ?? (() => readFileSync(0, "utf8")))() : readFileSync(source, "utf8");
  const before = readLedger(path);
  const options: AddOptions = { policy: DEFAULT_POLICY };
  if (snapshot !== undefined) options.snapshot = snapshot;
  if (cap !== undefined) options.maxRounds = cap;
  const parsed: unknown = JSON.parse(text);
  const asScope = validateScopeRecord();
  const asCarry = validateCarryScope();
  let items: InputItem[];
  if (asScope(parsed)) {
    if (!asCarry(parsed)) throw new Error("a carry line needs a scope record whose outcome is carry");
    const covered = fold(before.events, DEFAULT_POLICY).covered_head;
    const previousPath = flags.one.get("--previous");
    if (previousPath === undefined || covered === null)
      throw new UsageError("--previous is required: a carry line needs the last reviewed scope record");
    readBaseline(previousPath, covered);
    items = [carryFromScope(parsed, covered, repo)];
  } else {
    items = parseInput(text);
    if (items.some((item) => item.kind === "carry"))
      throw new Error("a carry line needs a scope record whose outcome is carry");
  }
  const result = addEvents(before.events, items, options);
  appendLedger(path, result.appended, before.unterminated);
  const after = readLedger(path);
  const record = {
    schema: "review-ledger-add",
    schema_version: 1,
    ledger: ledgerRef(path, after),
    appended: result.appended,
    outcomes: result.outcomes,
    grants: [],
    note: NOTE,
  };
  emit(
    io,
    flags.one.get("--out"),
    `review ledger add lines=${result.appended.length} seq=${after.events.length}`,
    record,
  );
  return 0;
}

function show(flags: Flags, io: ReviewIo): number {
  const path = required(flags, "--ledger");
  const file = readLedger(path);
  const state = fold(file.events, DEFAULT_POLICY);
  const record = {
    schema: "review-ledger-state",
    schema_version: 1,
    ledger: ledgerRef(path, file),
    policy: DEFAULT_POLICY,
    state,
    grants: [],
    note: NOTE,
  };
  emit(
    io,
    flags.one.get("--out"),
    `review ledger scope=${state.scope} round=${state.round} rows=${state.rows.length} problems=${state.problems.length}`,
    record,
  );
  return state.problems.length === 0 ? 0 : 1;
}

function decideCommand(flags: Flags, io: ReviewIo): number {
  const path = required(flags, "--ledger");
  const head = required(flags, "--head");
  const seats = required(flags, "--seats");
  if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(head)) throw new UsageError("--head is a full commit id");
  if (!/^[1-9][0-9]?$/.test(seats)) throw new UsageError("--seats is a count from 1");
  const file = readLedger(path);
  const context = {
    head,
    seats_required: Number(seats),
    evidence_missing: flags.many.get("--missing-evidence") ?? [],
    integrity_failures: flags.many.get("--integrity-failure") ?? [],
  };
  const decision = decide(file.events, DEFAULT_POLICY, context);
  const state = fold(file.events, DEFAULT_POLICY);
  const record = {
    schema: "review-decision",
    schema_version: 1,
    ledger: ledgerRef(path, file),
    policy: DEFAULT_POLICY,
    context,
    ...decision,
    repeats: state.repeats,
    flips: state.flips,
    grants: [],
    note: NOTE,
  };
  emit(io, flags.one.get("--out"), `review ${decision.verdict} action=${decision.action}`, record);
  return decision.verdict === "approved" ? 0 : 1;
}

/** What a later `scope` run reads back from the record of the last reviewed round. */
interface ScopeBaseline {
  head: string;
  /** The resolved comparison base pinned when that round was scoped. */
  base: string;
  class: keyof typeof CLASS_RANK | null;
  intent: string | null;
  criteria: string | null;
  review_surface_changed: boolean | null;
}

const DIGEST = { type: ["string", "null"], pattern: "^sha256:[0-9a-f]{64}$" };

let baselineValidator: ValidateFunction<ScopeBaseline> | null = null;

/** The members of a `scope` record that a later run reads. The record's other members are not read back. */
function validateBaseline(): ValidateFunction<ScopeBaseline> {
  baselineValidator ??= new Ajv2020({ strict: false }).compile<ScopeBaseline>({
    type: "object",
    required: ["schema", "schema_version", "head", "base", "class", "intent", "criteria", "review_surface_changed"],
    properties: {
      schema: { const: "review-scope" },
      schema_version: { const: 1 },
      head: { type: "string", pattern: "^[0-9a-f]{40}([0-9a-f]{24})?$" },
      base: COMMIT,
      class: { enum: [...Object.keys(CLASS_RANK), null] },
      intent: DIGEST,
      criteria: DIGEST,
      review_surface_changed: { type: ["boolean", "null"] },
    },
  });
  return baselineValidator;
}

/** The `scope` record of the last reviewed round, which must be the record of `reviewed`. */
function readBaseline(path: string, reviewed: string): ScopeBaseline {
  if (!existsSync(path)) throw new UsageError(`--previous ${path} does not exist`);
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`--previous ${path} is not JSON`);
  }
  const valid = validateBaseline();
  if (!valid(value)) throw new Error(`--previous ${path} is not a record of ak review scope`);
  if (value.head !== reviewed)
    throw new Error(
      `--previous ${path} is the record of ${value.head}, and the last reviewed head is ${reviewed}: give the record of that head, or none`,
    );
  return value;
}

function fileDigest(flags: Flags, name: string): string | null {
  const path = flags.one.get(name);
  if (path === undefined) return null;
  if (!existsSync(path)) throw new UsageError(`${name} ${path} does not exist`);
  return sha256(readFileSync(path));
}

/** An input the last round's record holds must be given again, so a trigger evaluated once is never dropped. */
function requireAgain(flags: Flags, name: string, held: string | null): void {
  if (held !== null && flags.one.get(name) === undefined)
    throw new UsageError(`${name} is required: the record of the last reviewed round holds its value`);
}

function scopeCommand(flags: Flags, io: ReviewIo): number {
  const path = required(flags, "--ledger");
  const repo = flags.one.get("--repo") ?? process.cwd();
  // Every required flag is read before the repository is: a missing flag is a usage error, whatever the repository holds.
  const revisions = { base: required(flags, "--base"), head: required(flags, "--head") };
  const base = resolveCommit(repo, revisions.base, "--base");
  const head = resolveCommit(repo, revisions.head, "--head");
  const file = readLedger(path);
  const state = fold(file.events, DEFAULT_POLICY);
  if (state.problems.length > 0) throw new Error(`the ledger has refused lines: ${state.problems.join("; ")}`);
  if (state.open !== null)
    throw new Error(`round ${state.open.round} of scope ${state.open.scope} is open: close it before the next scope`);
  const recordPath = flags.one.get("--record");
  const merge = recordPath === undefined ? null : readMergeRecord(recordPath, process.cwd(), "--record");
  const now = {
    class: merge?.class ?? null,
    intent: fileDigest(flags, "--intent"),
    criteria: fileDigest(flags, "--criteria"),
  };
  const reviewed = state.covered_head;
  const position = { scope: state.scope, reviewed: reviewed !== null };
  // Before round 1 of a scope there is no reviewed head, so nothing is compared and `--previous` is not read.
  const previousPath = reviewed === null ? undefined : flags.one.get("--previous");
  if (reviewed !== null && previousPath === undefined)
    throw new UsageError(
      `--previous is required: the ledger holds a reviewed round at ${reviewed}, so give the scope record of that head`,
    );
  const before = reviewed === null || previousPath === undefined ? null : readBaseline(previousPath, reviewed);
  if (merge !== null && merge.head !== head)
    throw new UsageError(
      `--record is the record of ${merge.head ?? "no head"}, and --head is ${head}: give the merge-stage record of this head`,
    );
  if (before !== null) {
    requireAgain(flags, "--record", before.class);
    requireAgain(flags, "--intent", before.intent);
    requireAgain(flags, "--criteria", before.criteria);
    if (before.review_surface_changed !== null && merge?.review_surface_changed === undefined)
      throw new UsageError(
        "--record must state review_surface_changed: the record of the last reviewed round holds its value, so run ak delegation --stage merge with --previous",
      );
    if (before.class !== null && reviewed !== null) {
      const ticket = flags.one.get("--ticket");
      const project = flags.one.get("--project");
      if (ticket === undefined || project === undefined)
        throw new UsageError(
          "--ticket and --project are required: the record of the last reviewed round holds a class, so score ak delegation --stage merge at that head",
        );
      const scored = scoreDelegationRun({ ticket, project, stage: "merge", base, head: reviewed }, repo);
      if (scored.class !== before.class)
        throw new UsageError(
          `--previous class is ${before.class}, and merge-stage scoring at ${reviewed} is ${scored.class}`,
        );
    }
  }
  const reading =
    reviewed === null ? null : readDelta(repo, base, resolveCommit(repo, reviewed, "the last reviewed head"), head);
  const facts: ScopeFacts | null =
    reading === null
      ? null
      : {
          delta: reading.delta,
          class_rose:
            before === null || before.class === null || now.class === null
              ? null
              : CLASS_RANK[now.class] > CLASS_RANK[before.class],
          surface_changed: merge?.review_surface_changed ?? null,
          intent: { before: before?.intent ?? null, now: now.intent },
          criteria: { before: before?.criteria ?? null, now: now.criteria },
        };
  const triggers = facts === null ? null : scopeTriggers(facts, DEFAULT_POLICY);
  const outcome = scopeOutcome(position, triggers, facts?.delta ?? null, DEFAULT_POLICY);
  const trigger = triggers?.fired[0];
  const event =
    outcome === "new-scope" && trigger !== undefined
      ? { kind: "scope-open", trigger, head }
      : outcome === "carry" && head !== reviewed
        ? { kind: "carry", head }
        : null;
  const record = {
    schema: "review-scope",
    schema_version: 1,
    ledger: ledgerRef(path, file),
    policy: DEFAULT_POLICY,
    scope: state.scope,
    reviewed,
    base,
    head,
    outcome,
    triggers: triggers?.fired ?? [],
    reasons: triggers?.reasons ?? [],
    unevaluated: triggers?.unevaluated ?? [],
    pull_request: reading === null ? readHead(repo, base, head) : reading.now,
    previous: reading?.previous ?? null,
    delta: reading?.delta ?? null,
    ...now,
    review_surface_changed: merge?.review_surface_changed ?? null,
    event,
    grants: [],
    note: NOTE,
  };
  emit(
    io,
    flags.one.get("--out"),
    `review scope outcome=${outcome} triggers=${record.triggers.join(",") || "none"} unevaluated=${record.unevaluated.length}`,
    record,
  );
  return 0;
}

/**
 * Exit 0 when the command did its work and, for `decide`, the verdict is `approved`. 1 for any
 * other verdict. 2 for a usage error, or a ledger, a record or a revision that cannot be read.
 * `scope` exits 0 for every outcome: the outcome is in the record and in the line.
 */
export function runReview(argv: readonly string[], io: ReviewIo): number {
  const command = commandOf(argv);
  if (command === undefined) {
    for (const line of USAGE) io.err(line);
    return 2;
  }
  const parsed = parseFlags(argv.slice(command === "decide" || command === "scope" ? 1 : 2), FLAGS[command]);
  if (!parsed.ok) {
    io.err(`ak review: ${parsed.error}`);
    for (const line of USAGE) io.err(line);
    return 2;
  }
  try {
    if (command === "add") return add(parsed.flags, io);
    if (command === "show") return show(parsed.flags, io);
    if (command === "scope") return scopeCommand(parsed.flags, io);
    return decideCommand(parsed.flags, io);
  } catch (cause) {
    io.err(`ak review: ${cause instanceof Error ? cause.message : String(cause)}`);
    if (cause instanceof UsageError) for (const line of USAGE) io.err(line);
    return 2;
  }
}
