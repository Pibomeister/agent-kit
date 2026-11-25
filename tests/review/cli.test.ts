/**
 * `ak review ledger add|show` and `ak review decide` (ADR-0018): the record
 * each command prints, the one line it prints with `--out`, and its exit
 * status. The usage of every `ak review` command is held here too. What
 * `ak review scope` prints is in `scope-git.test.ts`.
 */
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { runReview } from "../../src/review/cli.ts";
import { sha256 } from "../../src/review/ledger.ts";
import { DEFAULT_POLICY } from "../../src/review/types.ts";
import { parseJson } from "../helpers/json.ts";
import { processScratch } from "../helpers/process-tmp.ts";
import { digest, head } from "./script.ts";

const NOTE = "This record grants no authority. It approves no checkpoint, ticket, merge or deploy.";

const FINDING = {
  kind: "finding",
  seat: "a",
  severity: "P1",
  category: "correctness",
  origin: "introduced",
  file: "src/store.ts",
  line: 4,
  symbol: "load",
  blob: digest(1),
  cause_key: "stale-read",
  text: "The second caller reads the row before the write lands.",
};

const ROUND_ONE = [
  { kind: "round-open", head: head(1) },
  { kind: "verdict", seat: "a", word: "approve" },
  FINDING,
  { kind: "round-close" },
];

const CLEAN_ROUND = [
  { kind: "round-open", head: head(1) },
  { kind: "verdict", seat: "a", word: "approve" },
  { kind: "round-close" },
];

function run(argv: string[], stdin?: string) {
  const out: string[] = [];
  const err: string[] = [];
  const code = runReview(argv, {
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    stdin: () => stdin ?? "",
  });
  return { code, out, err };
}

/** A scratch directory with a ledger path, and `add` to append inputs through the command. */
function setup(...batches: object[][]) {
  const dir = processScratch("ak-review-");
  const ledger = join(dir, "ledger.jsonl");
  const out = join(dir, "record.json");
  for (const batch of batches) {
    const added = run(["ledger", "add", "--ledger", ledger, "--event", "-"], JSON.stringify(batch));
    if (added.code !== 0) throw new Error(added.err.join("\n"));
  }
  return { dir, ledger, out };
}

describe("ak review ledger add", () => {
  test("appends the lines and prints the record on stdout", () => {
    const { dir, ledger } = setup();
    const events = join(dir, "events.json");
    writeFileSync(events, JSON.stringify(ROUND_ONE));
    const { code, out, err } = run(["ledger", "add", "--ledger", ledger, "--event", events]);
    expect({ code, err }).toEqual({ code: 0, err: [] });
    expect(out).toHaveLength(1);
    const text = readFileSync(ledger, "utf8");
    expect(parseJson(out[0] ?? "")).toMatchObject({
      schema: "review-ledger-add",
      schema_version: 1,
      ledger: { path: ledger, sha256: sha256(text), lines: 4, torn: 0 },
      appended: [{ seq: 1, kind: "round-open", mode: "full" }, { seq: 2 }, { seq: 3, id: "F1" }, { seq: 4 }],
      outcomes: [
        { input: 1, kind: "round-open", lines: ["round-open"] },
        { input: 2, kind: "verdict", lines: ["verdict"] },
        { input: 3, kind: "finding", lines: ["finding"], id: "F1", status: "open" },
        { input: 4, kind: "round-close", lines: ["round-close"] },
      ],
      grants: [],
      note: NOTE,
    });
    expect(text.trimEnd().split("\n")).toHaveLength(4);
    expect(statSync(ledger).mode & 0o777).toBe(0o600);
  });

  test("with --out it writes the record owner-only and prints one line", () => {
    const { ledger, out: record } = setup(ROUND_ONE);
    const response = JSON.stringify({ kind: "response", id: "F1", response: "fixed" });
    const { code, out } = run(["ledger", "add", "--ledger", ledger, "--event", "-", "--out", record], response);
    expect(code).toBe(0);
    expect(out).toEqual([`review ledger add lines=1 seq=5: ${record}`]);
    expect(statSync(record).mode & 0o777).toBe(0o600);
    expect(parseJson(readFileSync(record, "utf8"))).toMatchObject({
      schema: "review-ledger-add",
      ledger: { lines: 5 },
      outcomes: [{ input: 1, kind: "response", lines: ["response"], id: "F1" }],
    });
  });

  test("--snapshot anchors a finding in that tree", () => {
    const { dir, ledger } = setup();
    writeFileSync(join(dir, "store.ts"), "export function load() {\n  return 1;\n}\n");
    const report = { ...FINDING, file: "store.ts", line: 2, symbol: undefined, blob: undefined };
    const input = JSON.stringify([{ kind: "round-open", head: head(1) }, report]);
    const { code, out } = run(["ledger", "add", "--ledger", ledger, "--event", "-", "--snapshot", dir], input);
    expect(code).toBe(0);
    expect(parseJson(out[0] ?? "")).toMatchObject({ appended: [{}, { anchor: { file: "store.ts", symbol: "load" } }] });
  });

  test("--max-rounds lowers the cap of the scope round 1 opens, and nothing raises it", () => {
    const { ledger } = setup();
    const input = JSON.stringify(CLEAN_ROUND);
    const lowered = run(["ledger", "add", "--ledger", ledger, "--event", "-", "--max-rounds", "2"], input);
    expect(lowered.code).toBe(0);
    expect(parseJson(lowered.out[0] ?? "")).toMatchObject({
      appended: [{ kind: "round-open", max_rounds: 2 }, {}, {}],
    });
    const raised = run(["ledger", "add", "--ledger", ledger, "--event", "-", "--max-rounds", "4"], input);
    expect(raised.code).toBe(2);
    expect(raised.err[0]).toBe(`ak review: --max-rounds is 2 or ${DEFAULT_POLICY.max_rounds}`);
  });

  test("a refused input exits 2 and appends nothing", () => {
    const { ledger } = setup(ROUND_ONE);
    const before = readFileSync(ledger, "utf8");
    const batch = JSON.stringify([
      { kind: "response", id: "F1", response: "fixed" },
      { kind: "verdict", seat: "a", word: "approve" },
    ]);
    const { code, out, err } = run(["ledger", "add", "--ledger", ledger, "--event", "-"], batch);
    expect({ code, out }).toEqual({ code: 2, out: [] });
    expect(err).toEqual(["ak review: input 2 (verdict): no round is open"]);
    expect(readFileSync(ledger, "utf8")).toBe(before);
  });

  test("input that is not JSON, or an absent event file, exits 2 and creates no ledger", () => {
    const { dir, ledger } = setup();
    expect(run(["ledger", "add", "--ledger", ledger, "--event", "-"], "{").code).toBe(2);
    expect(run(["ledger", "add", "--ledger", ledger, "--event", join(dir, "absent.json")]).code).toBe(2);
    expect(existsSync(ledger)).toBe(false);
  });
});

describe("ak review ledger show", () => {
  test("prints the state the lines fold to", () => {
    const { ledger } = setup(ROUND_ONE);
    const { code, out } = run(["ledger", "show", "--ledger", ledger]);
    expect(code).toBe(0);
    expect(parseJson(out[0] ?? "")).toMatchObject({
      schema: "review-ledger-state",
      schema_version: 1,
      ledger: { path: ledger, lines: 4, torn: 0 },
      policy: DEFAULT_POLICY,
      state: {
        scope: 1,
        round: 1,
        open: null,
        covered_head: head(1),
        rows: [{ id: "F1", status: "open", seats: ["a"], anchor: { symbol: "load" } }],
        problems: [],
      },
      grants: [],
      note: NOTE,
    });
  });

  test("with --out it prints one line", () => {
    const { ledger, out: record } = setup(ROUND_ONE);
    const { code, out } = run(["ledger", "show", "--ledger", ledger, "--out", record]);
    expect(code).toBe(0);
    expect(out).toEqual([`review ledger scope=1 round=1 rows=1 problems=0: ${record}`]);
    expect(parseJson(readFileSync(record, "utf8"))).toMatchObject({ schema: "review-ledger-state" });
  });

  test("a missing ledger is an empty one", () => {
    const { ledger } = setup();
    const { code, out } = run(["ledger", "show", "--ledger", ledger]);
    expect(code).toBe(0);
    expect(parseJson(out[0] ?? "")).toMatchObject({ ledger: { lines: 0 }, state: { round: 0, rows: [] } });
    expect(existsSync(ledger)).toBe(false);
  });

  test("a ledger with a line the engine refuses exits 1 and names the line", () => {
    const { ledger, out: record } = setup();
    writeFileSync(ledger, `${JSON.stringify({ v: 1, seq: 1, kind: "verdict", seat: "a", word: "approve" })}\n`);
    const { code, out } = run(["ledger", "show", "--ledger", ledger, "--out", record]);
    expect(code).toBe(1);
    expect(out).toEqual([`review ledger scope=1 round=0 rows=0 problems=1: ${record}`]);
    expect(parseJson(readFileSync(record, "utf8"))).toMatchObject({
      state: { problems: ["line 1 (verdict): no round is open"] },
    });
  });

  test("a ledger that cannot be read exits 2", () => {
    const { ledger } = setup();
    writeFileSync(ledger, `${JSON.stringify({ v: 1, seq: 2, kind: "round-close" })}\n`);
    const { code, out, err } = run(["ledger", "show", "--ledger", ledger]);
    expect({ code, out }).toEqual({ code: 2, out: [] });
    expect(err).toEqual([`ak review: ${ledger}:1: seq is 2 and the next line is 1`]);
  });
});

describe("ak review decide", () => {
  test("approved exits 0", () => {
    const { ledger, out: record } = setup(CLEAN_ROUND);
    const argv = ["decide", "--ledger", ledger, "--head", head(1), "--seats", "1"];
    const printed = run(argv);
    expect(printed.code).toBe(0);
    expect(parseJson(printed.out[0] ?? "")).toMatchObject({
      schema: "review-decision",
      schema_version: 1,
      ledger: { path: ledger, lines: 3 },
      policy: DEFAULT_POLICY,
      context: { head: head(1), seats_required: 1, evidence_missing: [], integrity_failures: [] },
      verdict: "approved",
      action: "none",
      reasons: [],
      repeats: 0,
      flips: 0,
      grants: [],
      note: NOTE,
    });
    expect(run([...argv, "--out", record]).out).toEqual([`review approved action=none: ${record}`]);
  });

  test("blocked exits 1 and names the one next action", () => {
    const { ledger, out: record } = setup(ROUND_ONE);
    const { code, out } = run(["decide", "--ledger", ledger, "--head", head(1), "--seats", "1", "--out", record]);
    expect(code).toBe(1);
    expect(out).toEqual([`review blocked action=fix: ${record}`]);
    expect(parseJson(readFileSync(record, "utf8"))).toMatchObject({
      verdict: "blocked",
      action: "fix",
      blocking: ["F1"],
    });
  });

  test("incomplete exits 1: another head, a seat short, missing evidence, a failed integrity check", () => {
    const { ledger } = setup(CLEAN_ROUND);
    const decide = (...flags: string[]) => {
      const { code, out } = run(["decide", "--ledger", ledger, "--seats", "1", ...flags]);
      return { code, record: parseJson(out[0] ?? "") };
    };
    expect(decide("--head", head(2))).toMatchObject({ code: 1, record: { verdict: "incomplete" } });
    const short = run(["decide", "--ledger", ledger, "--head", head(1), "--seats", "2"]);
    expect(short.code).toBe(1);
    expect(parseJson(short.out[0] ?? "")).toMatchObject({ verdict: "incomplete", action: "repair" });
    expect(decide("--head", head(1), "--missing-evidence", "ci", "--missing-evidence", "diff-digest")).toMatchObject({
      code: 1,
      record: {
        verdict: "incomplete",
        action: "supply-evidence",
        context: { evidence_missing: ["ci", "diff-digest"] },
        reasons: ["missing at the head: ci, diff-digest"],
      },
    });
    expect(decide("--head", head(1), "--integrity-failure", "the merge base moved")).toMatchObject({
      code: 1,
      record: { verdict: "incomplete", action: "repair", reasons: ["the merge base moved"] },
    });
  });

  test("decide reads the ledger and never writes it", () => {
    const { ledger } = setup(ROUND_ONE);
    const before = readFileSync(ledger, "utf8");
    run(["decide", "--ledger", ledger, "--head", head(1), "--seats", "1"]);
    expect(readFileSync(ledger, "utf8")).toBe(before);
  });

  test("the same ledger and context give the same record", () => {
    const { ledger } = setup(ROUND_ONE);
    const argv = ["decide", "--ledger", ledger, "--head", head(1), "--seats", "1"];
    expect(run(argv).out).toEqual(run(argv).out);
  });
});

describe("usage", () => {
  const { ledger } = setup();

  test.each([
    [[], null],
    [["ledger"], null],
    [["ledger", "drop", "--ledger", ledger], null],
    [["approve"], null],
    [["ledger", "show"], "--ledger is required"],
    [["ledger", "show", "--ledger"], "--ledger needs a value"],
    [["ledger", "show", "--ledger", ledger, "--head", head(1)], "unknown flag --head"],
    [["ledger", "show", "--ledger", ledger, "--ledger", ledger], "--ledger is given twice"],
    [["ledger", "add", "--ledger", ledger], "--event is required"],
    [["ledger", "add", "--ledger", ledger, "--event", "--out"], "--event needs a value"],
    [["scope", "--ledger", ledger, "--head", head(1)], "--base is required"],
    [["scope", "--ledger", ledger, "--base", head(1)], "--head is required"],
    [["scope", "--ledger", ledger, "--base", head(1), "--head", head(1), "--seats", "1"], "unknown flag --seats"],
    [["decide", "--ledger", ledger, "--seats", "1"], "--head is required"],
    [["decide", "--ledger", ledger, "--head", head(1)], "--seats is required"],
    [["decide", "--ledger", ledger, "--head", "abc123", "--seats", "1"], "--head is a full commit id"],
    [["decide", "--ledger", ledger, "--head", head(1), "--seats", "0"], "--seats is a count from 1"],
    [["decide", "--ledger", ledger, "--head", head(1), "--seats", "1", "--snapshot", "."], "unknown flag --snapshot"],
  ])("%j exits 2 with the usage", (argv, message) => {
    const { code, out, err } = run(argv);
    expect({ code, out }).toEqual({ code: 2, out: [] });
    if (message !== null) expect(err[0]).toBe(`ak review: ${message}`);
    expect(err.slice(message === null ? 0 : 1)).toEqual([
      "usage: ak review ledger add --ledger <ledger.jsonl> --event <file|-> [--repo <dir>] [--previous <scope.json>] [--snapshot <dir>] [--max-rounds <2|3>] [--out <record.json>]",
      "       ak review ledger show --ledger <ledger.jsonl> [--out <record.json>]",
      "       ak review scope --ledger <ledger.jsonl> --base <rev> --head <rev> [--repo <dir>] [--previous <scope.json>] [--record <merge-record.json>] [--ticket <file>] [--project <file>] [--intent <file>] [--criteria <file>] [--out <record.json>]",
      "       ak review decide --ledger <ledger.jsonl> --head <sha> --seats <n> [--missing-evidence <item>]... [--integrity-failure <reason>]... [--out <record.json>]",
      "       The ledger must sit outside author write. ak review decide trusts its lines.",
    ]);
  });
});
