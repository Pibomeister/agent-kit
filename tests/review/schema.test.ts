/**
 * `schemas/review-ledger.schema.json` against the engine's vocabulary.
 *
 * The schema is the wire form of a ledger line and `src/review/types.ts` is
 * what the engine reads. These tests hold the two equal: every enum, every
 * line kind, and every line the engine's own tests write.
 */
import { describe, expect, test } from "bun:test";

import ledgerSchema from "../../schemas/review-ledger.schema.json" with { type: "json" };
import { isLedgerEvent } from "../../src/review/ledger.ts";
import {
  CATEGORIES,
  DEFAULT_POLICY,
  ROUND_MODES,
  SCOPE_TRIGGERS,
  SEVERITIES,
  STATUSES,
  UNRESOLVED,
  type LedgerEvent,
} from "../../src/review/types.ts";
import { drive } from "./driver.ts";
import { digest, head, RISK, Script } from "./script.ts";

const defs = ledgerSchema.$defs;

/** One line of every kind, in an order the engine admits. */
function everyKind(): LedgerEvent[] {
  const script = new Script();
  script.open(0, "import").finding({ seat: "pipeline", status: "observation" });
  script.close().open(1, "full", 2).verdict();
  const id = script.finding({ category: "security", risk: RISK, rule: "AUTHORING.md §8" });
  const copy = script.finding({ theme: 2 });
  script.seat(id, "b").line({ kind: "duplicate", id: copy, of: id });
  script.repro(id, 1, 0).close([{ id, blob: digest(2001) }]);
  script.fixed(id).open(2).verdict().vote(id, "not-addressed").close();
  script.extension().open(3).verdict().repro(id, 1, 0).close();
  script.owner(id, "deferred").followup(id).carry(4);
  script
    .newScope(5)
    .open(5)
    .verdict()
    .repeat(id, { blob: digest(2001) });
  script.line({ kind: "flip", id, seat: "a", reason: "no change in the anchor and no new evidence" });
  const late = script.finding();
  script.repro(late, 1, 0).close().open(6).verdict().dispute(late).close().open(7).verdict().close();
  script.council([{ id: late, choice: "follow-up" }]);
  return script.events;
}

describe("the ledger line schema", () => {
  test("its enums are the engine's constants", () => {
    expect(defs.severity.enum).toEqual([...SEVERITIES]);
    expect(defs.category.enum).toEqual([...CATEGORIES]);
    expect(defs.status.enum).toEqual([...STATUSES]);
    expect(defs["round-open"].properties.mode.enum).toEqual([...ROUND_MODES]);
    expect(defs["scope-open"].properties.trigger.enum).toEqual([...SCOPE_TRIGGERS]);
    expect(defs["round-open"].properties.max_rounds.enum).toEqual([2, DEFAULT_POLICY.max_rounds]);
  });

  test("the policy names only categories, severities and statuses the schema has", () => {
    expect(CATEGORIES).toEqual(expect.arrayContaining([...DEFAULT_POLICY.always_block]));
    expect(SEVERITIES).toEqual(expect.arrayContaining([...DEFAULT_POLICY.blocking_severities]));
    expect(STATUSES).toEqual(expect.arrayContaining([...UNRESOLVED]));
  });

  test("a finding may be filed terminal, and never filed unresolved", () => {
    const terminal = STATUSES.filter((status) => !UNRESOLVED.includes(status));
    expect(defs.finding.properties.status.enum).toEqual(terminal);
    expect(defs.finding_report.properties.status.enum).toEqual(terminal);
  });

  test("every definition a line may match names its own kind and admits no other field", () => {
    const kinds = ledgerSchema.oneOf.map((entry) => entry.$ref.replace("#/$defs/", ""));
    expect(new Set(kinds).size).toBe(kinds.length);
    for (const kind of kinds) {
      const definition = Object.entries(defs).find(([name]) => name === kind)?.[1] ?? {};
      expect({ kind, definition }).toMatchObject({
        kind,
        definition: { additionalProperties: false, properties: { kind: { const: kind } } },
      });
      const required = "required" in definition ? definition.required : [];
      expect(required).toEqual(expect.arrayContaining(["v", "seq", "kind"]));
    }
  });

  test("the engine's tests write one valid line of every kind, and the engine admits each", () => {
    const events = everyKind();
    const kinds = ledgerSchema.oneOf.map((entry) => entry.$ref.replace("#/$defs/", ""));
    expect(new Set<string>(events.map((event) => event.kind))).toEqual(new Set(kinds));
    expect(events.filter((event) => !isLedgerEvent(event))).toEqual([]);
    const script = new Script();
    script.events.push(...events);
    expect(script.state().problems).toEqual([]);
  });

  test("every line a generated review writes is a valid line", () => {
    for (const seed of [0, 1, 2, 3, 5, 8, 13, 21]) {
      const picks = Array.from({ length: 400 }, (_, index) => (index * 7919 + seed * 104_729) % 10_000);
      const run = drive(picks, { policy: DEFAULT_POLICY, seats: 1 + (seed % 3), owner: seed % 2 === 0, scopes: true });
      expect(run.events.filter((event) => !isLedgerEvent(event))).toEqual([]);
    }
  });

  test.each([
    ["a kind the schema does not have", { v: 1, seq: 1, kind: "approve" }],
    ["a field the kind does not have", { v: 1, seq: 1, kind: "round-close", verdict: "approved" }],
    ["a format version other than 1", { v: 2, seq: 1, kind: "round-close" }],
    ["a line number below 1", { v: 1, seq: 0, kind: "round-close" }],
    ["a head that is not a full commit id", { v: 1, seq: 1, kind: "carry", head: "abc123" }],
    [
      "a cap above the policy's",
      { v: 1, seq: 1, kind: "round-open", scope: 1, round: 1, mode: "full", head: head(1), max_rounds: 4 },
    ],
    ["a dispute with no claim", { v: 1, seq: 1, kind: "response", id: "F1", response: "dispute" }],
    ["an owner order that reopens a row", { v: 1, seq: 1, kind: "owner", order: "order-1", id: "F1", status: "open" }],
    ["a council line with no ruling", { v: 1, seq: 1, kind: "council", record: digest(1), rulings: [] }],
    [
      "a reproduction with no exit status",
      {
        v: 1,
        seq: 1,
        kind: "evidence",
        id: "F1",
        evidence: { kind: "repro", ref: "t.test.ts", head: head(1), sha256: digest(1) },
      },
    ],
    [
      "a risk sentence with no named asset",
      { v: 1, seq: 1, kind: "repeat", id: "F1", seat: "a", in_scope: true, risk: { action: "leaks" } },
    ],
  ])("refuses %s", (_name, line) => {
    expect(isLedgerEvent(line)).toBe(false);
  });
});
