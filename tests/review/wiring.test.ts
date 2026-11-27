/**
 * Converging review is the default (ADR-0018, amendment of 2026-11-26). The
 * delivery pipeline keeps the same cap, and the loop the convergence reference
 * describes runs through `ak review`, round by round, to the cap.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";
import { parse } from "yaml";

import { runReview } from "../../src/review/cli.ts";
import { DEFAULT_POLICY } from "../../src/review/types.ts";
import { parseJson, type JsonValue } from "../helpers/json.ts";
import { processScratch } from "../helpers/process-tmp.ts";
import { digest, head } from "./script.ts";

const ROOT = join(import.meta.dir, "..", "..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");

/** A YAML file as a JSON value: parsed, then read back as typed JSON. */
function yaml(path: string): JsonValue {
  const parsed: unknown = parse(read(path));
  return parseJson(JSON.stringify(parsed));
}

/** The member at the object path `path`, or null where a step is absent or not in an object. */
function at(value: JsonValue, ...path: string[]): JsonValue {
  let current = value;
  for (const step of path) {
    if (Array.isArray(current) || !(current instanceof Object)) return null;
    current = current[step] ?? null;
  }
  return current;
}

const CONVERGENCE = at(yaml("policies/review.yaml"), "convergence");

describe("the delivery pipeline's Review keeps the same cap", () => {
  test("review.max_fix_rounds in .no-mistakes.yaml equals the convergence cap", () => {
    const config = yaml(".no-mistakes.yaml");
    expect(at(config, "review", "max_fix_rounds")).toBe(DEFAULT_POLICY.max_rounds);
    expect(at(config, "review", "max_fix_rounds")).toBe(at(CONVERGENCE, "cap", "max_rounds"));
    expect(at(config, "auto_fix", "review")).toBe(3);
  });
});

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

function ledger() {
  const path = join(processScratch("ak-review-wiring-"), "ledger.jsonl");
  const add = (lines: object[]) => run(["ledger", "add", "--ledger", path, "--event", "-"], JSON.stringify(lines));
  const decide = (n: number) => {
    const { code, out } = run(["decide", "--ledger", path, "--head", head(n), "--seats", "2"]);
    const record = parseJson(out[0] ?? "{}");
    return { code, verdict: at(record, "verdict"), action: at(record, "action"), record };
  };
  return { add, decide };
}

/** What a test changes in a finding report: its category, and the risk sentence of an always-block one. */
interface FindingChange {
  category?: string;
  risk?: { asset: string; action: string };
}

function finding(seat: string, cause: string, extra: FindingChange = {}) {
  return {
    kind: "finding",
    seat,
    severity: "P1",
    category: "correctness",
    origin: "introduced",
    file: "src/store.ts",
    line: 4,
    symbol: cause,
    blob: digest(1),
    cause_key: cause,
    text: `The change breaks ${cause}.`,
    ...extra,
  };
}

const verdicts = (a: string, b: string) => [
  { kind: "verdict", seat: "a", word: a },
  { kind: "verdict", seat: "b", word: b },
];

describe("the loop through ak review, round by round", () => {
  test("round 1 full, two closure rounds, then the cap parks with an escalation", () => {
    const { add, decide } = ledger();

    // Round 1: the one full review. A P1 the change introduced blocks.
    expect(
      add([
        { kind: "round-open", head: head(1) },
        ...verdicts("block", "approve"),
        finding("a", "stale-read"),
        { kind: "round-close" },
      ]).code,
    ).toBe(0);
    expect(decide(1)).toMatchObject({ verdict: "blocked", action: "fix" });

    // Round 2: fix-only. F1 closes; a new P1 with no reproduction is filed. Seat b's
    // block word vetoes nothing: once F2 has its follow-up the review approves.
    expect(add([{ kind: "response", id: "F1", response: "fixed" }]).code).toBe(0);
    expect(
      add([
        { kind: "round-open", head: head(2) },
        { kind: "closure", id: "F1", seat: "a", vote: "addressed", location: "src/store.ts:5" },
        finding("b", "late-thing"),
        ...verdicts("approve", "block"),
        { kind: "round-close" },
      ]).code,
    ).toBe(0);
    expect(decide(2)).toMatchObject({ action: "file-follow-ups", record: { blocking: [] } });
    expect(add([{ kind: "followup", id: "F2", ref: "https://example.invalid/issue/1" }]).code).toBe(0);
    expect(decide(2)).toMatchObject({ code: 0, verdict: "approved", action: "none" });

    // Round 3, the cap: a new finding with a reproduction red at the head and green
    // at the merge base blocks, and at the cap it escalates instead of approving.
    expect(
      add([
        { kind: "round-open", head: head(3) },
        finding("b", "repro-thing"),
        {
          kind: "evidence",
          id: "F3",
          evidence: { kind: "repro", ref: "bun test store", head: head(3), exit: 1, base_exit: 0, sha256: digest(9) },
        },
        ...verdicts("approve", "approve"),
        { kind: "round-close" },
      ]).code,
    ).toBe(0);
    const capped = decide(3);
    expect(capped).toMatchObject({ verdict: "blocked", action: "council", record: { escalate: ["F3"] } });
    expect(capped.code).not.toBe(0);

    // A fourth round in the scope is refused.
    expect(add([{ kind: "round-open", head: head(4) }]).code).toBe(2);
  });

  test("a round 3 with nothing blocking and every deferred row filed parks instead of approving", () => {
    const { add, decide } = ledger();
    add([{ kind: "round-open", head: head(1) }, ...verdicts("approve", "approve"), { kind: "round-close" }]);
    add([{ kind: "round-open", head: head(2) }, ...verdicts("approve", "approve"), { kind: "round-close" }]);
    expect(decide(2)).toMatchObject({ code: 0, verdict: "approved", action: "none" });
    add([
      { kind: "round-open", head: head(3) },
      finding("b", "late-thing"),
      ...verdicts("approve", "approve"),
      { kind: "round-close" },
    ]);
    expect(add([{ kind: "followup", id: "F1", ref: "https://example.invalid/issue/2" }]).code).toBe(0);
    const capped = decide(3);
    expect(capped).toMatchObject({ verdict: "incomplete", action: "captain-hold", record: { blocking: [] } });
    expect(capped.code).not.toBe(0);
  });

  test("after round 1 a new finding with no reproduction is filed, not blocking", () => {
    const { add, decide } = ledger();
    add([{ kind: "round-open", head: head(1) }, ...verdicts("approve", "approve"), { kind: "round-close" }]);
    add([
      { kind: "round-open", head: head(2) },
      finding("b", "late-thing"),
      ...verdicts("approve", "block"),
      { kind: "round-close" },
    ]);
    const decision = decide(2);
    expect(decision.record).toMatchObject({ blocking: [], followups_needed: ["F1"] });
  });

  test("a security finding with its risk sentence blocks in a later round with no reproduction", () => {
    const { add, decide } = ledger();
    add([{ kind: "round-open", head: head(1) }, ...verdicts("approve", "approve"), { kind: "round-close" }]);
    add([
      { kind: "round-open", head: head(2) },
      finding("b", "token-leak", {
        category: "security",
        risk: { asset: "the session token", action: "the debug log writes it in clear text" },
      }),
      ...verdicts("approve", "approve"),
      { kind: "round-close" },
    ]);
    const decision = decide(2);
    expect(decision).toMatchObject({ verdict: "blocked", record: { blocking: ["F1"] } });
  });
});
