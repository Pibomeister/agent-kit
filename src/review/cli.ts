/**
 * `ak review ledger add|show` and `ak review decide`: the convergence ledger of
 * one pull request and the verdict the engine reads from it (ADR-0018).
 *
 * - `ledger add` turns what seats, the author and the gate reported into
 *   ledger lines and appends them, or refuses the whole input.
 * - `ledger show` prints the state the lines fold to.
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
 */

import { readFileSync, writeFileSync } from "node:fs";

import { decide, fold } from "./converge.ts";
import { addEvents, appendLedger, parseInput, readLedger, type AddOptions, type LedgerFile } from "./ledger.ts";
import { DEFAULT_POLICY, type ConvergencePolicy } from "./types.ts";

export interface ReviewIo {
  out: (line: string) => void;
  err: (line: string) => void;
  /** Reads the `--event -` input. Defaults to the process's stdin. */
  stdin?: () => string;
}

const USAGE = [
  "usage: ak review ledger add --ledger <ledger.jsonl> --event <file|-> [--snapshot <dir>] [--max-rounds <2|3>] [--out <record.json>]",
  "       ak review ledger show --ledger <ledger.jsonl> [--out <record.json>]",
  "       ak review decide --ledger <ledger.jsonl> --head <sha> --seats <n> [--missing-evidence <item>]... [--integrity-failure <reason>]... [--out <record.json>]",
];

const NOTE = "This record grants no authority. It approves no checkpoint, ticket, merge or deploy.";

/** Flags that may be given more than once. */
const REPEATED = new Set(["--missing-evidence", "--integrity-failure"]);

const FLAGS = {
  add: ["--ledger", "--event", "--snapshot", "--max-rounds", "--out"],
  show: ["--ledger", "--out"],
  decide: ["--ledger", "--head", "--seats", "--missing-evidence", "--integrity-failure", "--out"],
};

type Command = keyof typeof FLAGS;

/** `ledger add`, `ledger show` or `decide`, or undefined for anything else. */
function commandOf(argv: readonly string[]): Command | undefined {
  if (argv[0] === "decide") return "decide";
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

function add(flags: Flags, io: ReviewIo): number {
  const path = required(flags, "--ledger");
  const source = required(flags, "--event");
  const cap = maxRounds(flags, DEFAULT_POLICY);
  const snapshot = flags.one.get("--snapshot");
  const text = source === "-" ? (io.stdin ?? (() => readFileSync(0, "utf8")))() : readFileSync(source, "utf8");
  const before = readLedger(path);
  const options: AddOptions = { policy: DEFAULT_POLICY };
  if (snapshot !== undefined) options.snapshot = snapshot;
  if (cap !== undefined) options.maxRounds = cap;
  const result = addEvents(before.events, parseInput(text), options);
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

/** Exit 0 when the command did its work and, for `decide`, the verdict is `approved`. 1 for any other verdict. 2 for a usage error or a ledger that cannot be read. */
export function runReview(argv: readonly string[], io: ReviewIo): number {
  const command = commandOf(argv);
  if (command === undefined) {
    for (const line of USAGE) io.err(line);
    return 2;
  }
  const parsed = parseFlags(argv.slice(command === "decide" ? 1 : 2), FLAGS[command]);
  if (!parsed.ok) {
    io.err(`ak review: ${parsed.error}`);
    for (const line of USAGE) io.err(line);
    return 2;
  }
  try {
    if (command === "add") return add(parsed.flags, io);
    if (command === "show") return show(parsed.flags, io);
    return decideCommand(parsed.flags, io);
  } catch (cause) {
    io.err(`ak review: ${cause instanceof Error ? cause.message : String(cause)}`);
    if (cause instanceof UsageError) for (const line of USAGE) io.err(line);
    return 2;
  }
}
