/**
 * `decide()` table tests: one test per row of the rule tables ADR-0018 takes
 * from the convergence plan (closure, what blocks, the verdict rule and the
 * cap outcomes), and the reopen and refusal rules beside them.
 *
 * `tests/review/mutation.test.ts` runs this file against deliberately broken
 * copies of the engine. So this file imports only the engine, its types and
 * `script.ts`.
 */
import { describe, expect, test } from "bun:test";

import { DEFAULT_POLICY } from "../../src/review/types.ts";
import { RISK, Script, digest, head } from "./script.ts";

/** A reproduction red at head `n` with no merge-base result, which the schema refuses and the engine must not count. */
function headOnlyRed(script: Script, id: string, n: number): Script {
  return script.line({
    kind: "evidence",
    id,
    evidence: { kind: "repro", ref: "tests/repro.test.ts", head: head(n), exit: 1, sha256: digest(3000) },
  });
}

/** Round 1 at head 1 with one finding by seat `a`, closed. */
function oneFinding(options: Parameters<Script["finding"]>[0] = {}, seats: string[] = ["a"]) {
  const script = new Script();
  script.open(1);
  for (const seat of seats) script.verdict(seat);
  const id = script.finding(options);
  script.close();
  return { script, id };
}

describe("closure: how a resolution is verified", () => {
  test("a row with a reproduction closes when the reproduction is green at the new head, with no seat vote", () => {
    const script = new Script();
    script.open(1).verdict();
    const id = script.finding();
    script.repro(id, 1, 0).close();
    expect(script.decide(1).verdict).toBe("blocked");
    script.fixed(id).open(2).verdict().repro(id, 0).close();
    expect(script.row(id)).toMatchObject({ status: "closed", disposition: "fixed", repro: "green" });
    expect(script.decide(2).verdict).toBe("approved");
  });

  test("a row whose reproduction is still red stays open, and an ADDRESSED vote is not counted", () => {
    const script = new Script();
    script.open(1).verdict();
    const id = script.finding();
    script.repro(id, 1, 0).close().fixed(id);
    script.open(2).verdict().repro(id, 1, 0).vote(id, "addressed").close();
    expect(script.row(id).status).toBe("open");
    expect(script.decide(2)).toMatchObject({ verdict: "blocked", action: "fix", blocking: [id] });
  });

  test("with no reproduction and the author's fix, the holding seat's ADDRESSED closes the row", () => {
    const { script, id } = oneFinding();
    script.fixed(id);
    expect(script.decide(1)).toMatchObject({ verdict: "blocked", action: "closure-round" });
    script.open(2).verdict().vote(id, "addressed").close();
    expect(script.row(id)).toMatchObject({ status: "closed", disposition: "fixed" });
    expect(script.decide(2).verdict).toBe("approved");
  });

  test("NOT-ADDRESSED with no reproduction defers the row to a follow-up: an unreproduced claim does not block", () => {
    const { script, id } = oneFinding();
    script.fixed(id).open(2).verdict().vote(id, "not-addressed").close();
    expect(script.row(id)).toMatchObject({ status: "deferred", disposition: "unreproduced" });
    expect(script.decide(2)).toMatchObject({
      verdict: "incomplete",
      action: "file-follow-ups",
      followups_needed: [id],
    });
    script.followup(id);
    expect(script.decide(2).verdict).toBe("approved");
  });

  test("NOT-ADDRESSED with a reproduction that is red at the new head keeps the row open", () => {
    const { script, id } = oneFinding();
    script.fixed(id).open(2).verdict().vote(id, "not-addressed").repro(id, 1, 0).close();
    expect(script.row(id).status).toBe("open");
    expect(script.decide(2).verdict).toBe("blocked");
  });

  test("a disputed row is dropped when the holding seat and one other seat agree with the author", () => {
    const { script, id } = oneFinding({}, ["a", "b"]);
    script.dispute(id, "unsupported").open(2).verdict("a").verdict("b");
    script.vote(id, "addressed", "a").vote(id, "addressed", "b").close();
    expect(script.row(id)).toMatchObject({ status: "dropped", disposition: "unsupported" });
    expect(script.decide(2, 2).verdict).toBe("approved");
  });

  test("one agreeing seat of two does not drop a disputed row", () => {
    const { script, id } = oneFinding({}, ["a", "b"]);
    script.dispute(id).open(2).verdict("a").vote(id, "addressed", "a").close();
    expect(script.row(id).status).toBe("disputed");
    expect(script.decide(2, 2).verdict).toBe("blocked");
  });

  test("an agreed dispute that claims a follow-up is deferred, not dropped", () => {
    const { script, id } = oneFinding();
    script.dispute(id, "follow-up").open(2).verdict().vote(id, "addressed").close();
    expect(script.row(id)).toMatchObject({ status: "deferred", disposition: "follow-up" });
  });

  test("a split dispute is decided by the evidence bar: deferred without a reproduction", () => {
    const { script, id } = oneFinding({}, ["a", "b"]);
    script.dispute(id).open(2).verdict("a").verdict("b");
    script.vote(id, "addressed", "a").vote(id, "not-addressed", "b").close();
    expect(script.row(id)).toMatchObject({ status: "deferred", disposition: "split" });
  });

  test("a split dispute with a red reproduction stays open", () => {
    const { script, id } = oneFinding({}, ["a", "b"]);
    script.dispute(id).open(2).verdict("a").verdict("b");
    script.vote(id, "addressed", "a").vote(id, "not-addressed", "b").repro(id, 1, 0).close();
    expect(script.row(id).status).toBe("open");
  });

  test("a reproduction that is red at the head and at the merge base makes the row pre-existing: filed, never blocking", () => {
    const script = new Script();
    script.open(1).verdict();
    const id = script.finding();
    script.repro(id, 1, 1).close();
    expect(script.row(id)).toMatchObject({ status: "deferred", disposition: "pre-existing", origin: "pre-existing" });
    expect(script.decide(1).verdict).toBe("incomplete");
  });

  test("a reproduction that never failed is no evidence and changes nothing", () => {
    const script = new Script();
    script.open(1).verdict();
    const id = script.finding();
    script.repro(id, 0).close();
    expect(script.row(id)).toMatchObject({ status: "open", repro: "none" });
  });

  test("the author never closes a row: a response leaves it unresolved", () => {
    const { script, id } = oneFinding();
    script.fixed(id);
    expect(script.row(id).status).toBe("addressed");
    expect(script.decide(1).verdict).toBe("blocked");
  });
});

describe("what blocks", () => {
  test("round 1: a P1 introduced finding blocks on reading evidence alone", () => {
    const { script, id } = oneFinding();
    expect(script.decide(1)).toMatchObject({ verdict: "blocked", action: "fix", blocking: [id] });
  });

  test.each([
    ["P2", { severity: "P2" }],
    ["P3", { severity: "P3" }],
    ["pre-existing", { origin: "pre-existing" }],
    ["convention with no cited rule", { category: "convention" }],
  ] as const)("any round: a %s finding never blocks and is filed", (_name, options) => {
    const { script, id } = oneFinding(options);
    expect(script.row(id)).toMatchObject({ status: "deferred", disposition: "note" });
    expect(script.decide(1)).toMatchObject({ verdict: "incomplete", action: "file-follow-ups", blocking: [] });
    script.followup(id);
    expect(script.decide(1).verdict).toBe("approved");
  });

  test("a convention finding that cites a project rule blocks", () => {
    const { script } = oneFinding({ category: "convention", rule: "AUTHORING.md section 5" });
    expect(script.decide(1).verdict).toBe("blocked");
  });

  test("round 2: a prior finding still open blocks", () => {
    const { script, id } = oneFinding();
    script.open(2).verdict().close();
    expect(script.decide(2)).toMatchObject({ verdict: "blocked", blocking: [id] });
  });

  test("round 2: a new finding inside the delta scope with a red reproduction blocks", () => {
    const script = new Script().pass(1);
    script.open(2).verdict();
    const id = script.finding();
    script.repro(id, 1, 0).close();
    expect(script.decide(2)).toMatchObject({ verdict: "blocked", blocking: [id] });
  });

  test("round 2: a reproduction red at the head with no merge-base result does not block: the row is deferred as unreproduced", () => {
    const script = new Script().pass(1);
    script.open(2).verdict();
    const id = script.finding();
    headOnlyRed(script, id, 2).close();
    expect(script.row(id)).toMatchObject({ status: "deferred", disposition: "unreproduced", red: [] });
    expect(script.decide(2)).toMatchObject({ verdict: "incomplete", blocking: [] });
  });

  test("round 2: a new finding inside the delta scope with no reproduction is filed and does not block", () => {
    const script = new Script().pass(1);
    script.open(2).verdict();
    const id = script.finding();
    script.close();
    expect(script.row(id)).toMatchObject({ status: "deferred", disposition: "unreproduced" });
    expect(script.decide(2).verdict).toBe("incomplete");
  });

  test("round 2: a new finding outside the delta scope is an observation, even with a red reproduction", () => {
    const script = new Script().pass(1);
    script.open(2).verdict();
    const id = script.finding({ in_scope: false });
    script.repro(id, 1, 0).close();
    expect(script.row(id)).toMatchObject({ status: "observation", disposition: "out-of-scope" });
    expect(script.decide(2).verdict).toBe("approved");
  });

  test("an always-block class blocks in round 2, outside the delta scope, with no reproduction", () => {
    const script = new Script().pass(1);
    script.open(2).verdict();
    const id = script.finding({ category: "security", in_scope: false, risk: RISK });
    script.close();
    expect(script.row(id)).toMatchObject({ status: "open", always_block: true });
    expect(script.decide(2)).toMatchObject({ verdict: "blocked", blocking: [id] });
  });

  test("an always-block class with no risk sentence is a form error and is judged as an ordinary finding", () => {
    const script = new Script().pass(1);
    script.open(2).verdict();
    const id = script.finding({ category: "data-loss", in_scope: false });
    script.close();
    expect(script.row(id)).toMatchObject({ status: "observation", always_block: false, form_error: true });
    expect(script.decide(2).verdict).toBe("approved");
  });

  test("an always-block row blocks at any severity", () => {
    const { script } = oneFinding({ category: "destructive", severity: "P3", risk: RISK });
    expect(script.decide(1).verdict).toBe("blocked");
  });

  test("an always-block row leaves the blocking set when every seat that reviewed the head calls it addressed", () => {
    const { script, id } = oneFinding({ category: "security", risk: RISK }, ["a", "b"]);
    script.fixed(id).open(2).verdict("a").verdict("b").vote(id, "addressed", "a").close();
    expect(script.row(id).status).toBe("addressed");
    expect(script.decide(2, 2).verdict).toBe("blocked");
    script.fixed(id).open(3).verdict("a").verdict("b");
    script.vote(id, "addressed", "a").vote(id, "addressed", "b").close();
    expect(script.row(id).status).toBe("closed");
    expect(script.decide(3, 2)).toMatchObject({ verdict: "incomplete", action: "captain-hold" });
  });

  test("an always-block row leaves the blocking set by a reproduction-backed fix", () => {
    const script = new Script();
    script.open(1).verdict();
    const id = script.finding({ category: "security", risk: RISK });
    script.repro(id, 1, 0).close().fixed(id).open(2).verdict().repro(id, 0).close();
    expect(script.decide(2).verdict).toBe("approved");
  });

  test("an always-block row leaves the blocking set by an owner ruling", () => {
    const { script, id } = oneFinding({ category: "security", risk: RISK });
    script.owner(id, "dropped");
    expect(script.row(id)).toMatchObject({ status: "dropped", disposition: "owner:order-1" });
    expect(script.decide(1).verdict).toBe("approved");
  });

  test("an always-block row is not filed away when its reproduction is red at the merge base too", () => {
    const script = new Script();
    script.open(1).verdict();
    const id = script.finding({ category: "security", risk: RISK });
    script.repro(id, 1, 1).close();
    expect(script.row(id).status).toBe("open");
    expect(script.decide(1).verdict).toBe("blocked");
  });
});

describe("the verdict rule", () => {
  test("approved when round 1 sat the required seats, the head is covered and nothing is open", () => {
    const script = new Script().pass(1, "a", "b");
    expect(script.decide(1, 2)).toMatchObject({ verdict: "approved", action: "none", seats: ["a", "b"], cap: 3 });
  });

  test("a seat's BLOCK word alone never blocks: one approving seat and no blocking row is approved", () => {
    const script = new Script();
    script.open(1).verdict("a", "block").verdict("b").close();
    expect(script.decide(1, 2).verdict).toBe("approved");
  });

  test("every seat blocks with no finding: incomplete, never approved and never blocked", () => {
    const script = new Script();
    script.open(1).verdict("a", "block").verdict("b", "block").close();
    expect(script.decide(1, 2)).toMatchObject({ verdict: "incomplete", action: "closure-round", blocking: [] });
  });

  test("a seat's latest verdict counts: an approval withdrawn in a later round no longer approves", () => {
    const script = new Script().pass(1);
    script.open(2).verdict("a", "block").close();
    expect(script.decide(2)).toMatchObject({ verdict: "incomplete", action: "closure-round" });
    script.open(3).verdict("a", "block").close();
    expect(script.decide(3)).toMatchObject({ verdict: "incomplete", action: "owner-hold" });
  });

  test("an approval from round 1 carries through a later round its seat did not block", () => {
    const script = new Script().pass(1, "a", "b");
    script.open(2).verdict("b").close();
    expect(script.decide(2, 2).verdict).toBe("approved");
  });

  test("incomplete with no ledger line at all", () => {
    expect(new Script().decide(1)).toMatchObject({ verdict: "incomplete", action: "review-round" });
  });

  test("incomplete while a round is open", () => {
    const script = new Script();
    script.open(1).verdict();
    expect(script.decide(1)).toMatchObject({ verdict: "incomplete", action: "close-round" });
  });

  test("incomplete when round 1 sat fewer seats than the tier requires", () => {
    const script = new Script().pass(1, "a");
    expect(script.decide(1, 2)).toMatchObject({ verdict: "incomplete", action: "repair" });
  });

  test("approval does not move with the head: a new head needs a closure pass or a carry", () => {
    const script = new Script().pass(1);
    expect(script.decide(2)).toMatchObject({ verdict: "incomplete", action: "closure-round", seats: [] });
    script.carry(2);
    expect(script.decide(2).verdict).toBe("approved");
    expect(script.decide(1).verdict).toBe("incomplete");
  });

  test("an empty delta carries the approval and does not count as a round", () => {
    const script = new Script().pass(1).carry(2).carry(3).carry(4).carry(5);
    expect(script.decide(5)).toMatchObject({ verdict: "approved", round: 1 });
  });

  test("a closure pass over the delta with no new blocking finding carries the approval", () => {
    const script = new Script().pass(1, "a", "b").pass(2, "b");
    expect(script.decide(2, 2)).toMatchObject({ verdict: "approved", seats: ["a", "b"] });
  });

  test("incomplete while a deferred row has no follow-up reference", () => {
    const { script, id } = oneFinding({ severity: "P3" });
    expect(script.decide(1)).toMatchObject({ verdict: "incomplete", followups_needed: [id] });
  });

  test("incomplete while required evidence is missing at the head", () => {
    const script = new Script().pass(1);
    expect(script.decide(1, 1, ["full test suite"])).toMatchObject({
      verdict: "incomplete",
      action: "supply-evidence",
    });
  });

  test("incomplete when an integrity check of the caller failed", () => {
    const script = new Script().pass(1);
    expect(script.decide(1, 1, [], ["merge base moved"])).toMatchObject({
      verdict: "incomplete",
      action: "repair",
      reasons: ["merge base moved"],
    });
  });

  test("a refused line makes the ledger unapprovable", () => {
    const script = new Script().pass(1);
    script.verdict("b");
    expect(script.state().problems).toEqual(["line 4 (verdict): no round is open"]);
    expect(script.decide(1)).toMatchObject({ verdict: "incomplete", action: "repair" });
  });

  test("a gap in seq is a problem", () => {
    const script = new Script().pass(1);
    const moved = script.events.map((event) => ({ ...event, seq: event.seq + 1 }));
    const kept = new Script();
    kept.events.push(...moved);
    expect(kept.state().problems[0]).toBe("line 1: seq is 2");
    expect(kept.decide(1).verdict).toBe("incomplete");
  });
});

/** Three rounds, with one P1 finding from round 1 that carries a red reproduction to the cap. */
function redAtCap(options: Parameters<Script["finding"]>[0] = {}) {
  const script = new Script();
  script.open(1).verdict();
  const id = script.finding(options);
  script.repro(id, 1, 0).close();
  script.fixed(id).open(2).verdict().repro(id, 1, 0).close();
  script.fixed(id).open(3).verdict().repro(id, 1, 0).close();
  return { script, id };
}

describe("the cap: every row gets an outcome by rule", () => {
  test("open and blocking with a red reproduction escalates to one council call", () => {
    const { script, id } = redAtCap();
    const decision = script.decide(3);
    expect(decision).toMatchObject({ verdict: "blocked", action: "council", escalate: [id] });
    expect(decision.cards[0]?.question).toContain("red reproduction");
    expect(decision.cards).toMatchObject([
      {
        id: "f1",
        row: "F1",
        theme: null,
        options: ["follow-up", "fix"],
        approve: "follow-up",
      },
    ]);
  });

  test("open with reading evidence only is deferred at the cap", () => {
    const { script, id } = oneFinding();
    script.open(2).verdict().close().open(3).verdict().close();
    expect(script.row(id)).toMatchObject({ status: "deferred", disposition: "cap" });
    expect(script.decide(3)).toMatchObject({ verdict: "incomplete", action: "file-follow-ups" });
  });

  test("the author's unverified fix is deferred at the cap", () => {
    const { script, id } = oneFinding();
    script.open(2).verdict().close().fixed(id).open(3).verdict().close();
    expect(script.row(id)).toMatchObject({ status: "deferred", disposition: "cap" });
  });

  test("a dispute no seat ruled on is deferred at the cap", () => {
    const { script, id } = oneFinding();
    script.dispute(id).open(2).verdict().close().open(3).verdict().close();
    expect(script.row(id)).toMatchObject({ status: "deferred", disposition: "cap" });
  });

  test("only P3 open at the cap: follow-ups filed, the change parks for a human", () => {
    const { script, id } = oneFinding({ severity: "P3" });
    script.pass(2).pass(3).followup(id);
    expect(script.decide(3)).toMatchObject({ verdict: "incomplete", action: "captain-hold" });
  });

  test("below the cap the same rows still wait: nothing is deferred early", () => {
    const { script, id } = oneFinding();
    script.open(2).verdict().close();
    expect(script.row(id).status).toBe("open");
  });

  test("a council ruling of follow-up defers the row under the council record", () => {
    const { script, id } = redAtCap();
    script.council([{ id, choice: "follow-up" }]);
    expect(script.row(id)).toMatchObject({ status: "deferred", disposition: `council:${digest(4000)}` });
    expect(script.decide(3).action).toBe("file-follow-ups");
    script.followup(id);
    expect(script.decide(3)).toMatchObject({ verdict: "incomplete", action: "captain-hold" });
  });

  test("a council ruling of fix gives one bounded closure round, and a green reproduction there closes the row", () => {
    const { script, id } = redAtCap();
    script.council([{ id, choice: "fix" }]);
    expect(script.decide(3)).toMatchObject({ verdict: "blocked", action: "bounded-closure" });
    script.fixed(id).open(4, "bounded").verdict().repro(id, 0).close();
    expect(script.decide(4)).toMatchObject({ verdict: "incomplete", action: "captain-hold" });
  });

  test("still red after the bounded round: one owner hold", () => {
    const { script, id } = redAtCap();
    script
      .council([{ id, choice: "escalate" }])
      .open(4, "bounded")
      .verdict()
      .repro(id, 1, 0)
      .close();
    expect(script.decide(4)).toMatchObject({ verdict: "blocked", action: "owner-hold", blocking: [id] });
    script.owner(id, "deferred").followup(id);
    expect(script.decide(4)).toMatchObject({ verdict: "incomplete", action: "captain-hold" });
  });

  test("a bounded round admits no new finding except an always-block one", () => {
    const { script, id } = redAtCap();
    script
      .council([{ id, choice: "fix" }])
      .open(4, "bounded")
      .verdict();
    const ordinary = script.finding();
    const secret = script.finding({ category: "security", risk: RISK });
    script.repro(ordinary, 1, 0).repro(id, 0).close();
    expect(script.row(ordinary).status).toBe("observation");
    expect(script.decide(4)).toMatchObject({ verdict: "blocked", action: "owner-hold", blocking: [secret] });
  });

  test("an always-block row at the cap never goes to the council: the owner rules", () => {
    const { script, id } = oneFinding({ category: "security", risk: RISK });
    script.open(2).verdict().close().open(3).verdict().close();
    expect(script.decide(3)).toMatchObject({ verdict: "blocked", action: "owner-hold", escalate: [id], cards: [] });
    script.council([{ id, choice: "follow-up" }]);
    expect(script.state().problems).toHaveLength(1);
  });

  test("a red reproduction outranks the same-theme rule: the row escalates on evidence", () => {
    const script = new Script();
    script.open(1).verdict();
    const id = script.finding({ theme: 7 });
    script.close();
    script.open(2).verdict().vote(id, "not-addressed").repro(id, 1, 0).close();
    script.open(3).verdict().vote(id, "not-addressed").repro(id, 1, 0).close();
    expect(script.row(id)).toMatchObject({ status: "open", escalate: "evidence" });
    expect(script.decide(3).cards[0]).toMatchObject({ row: id, theme: null });
  });

  test("a row dropped as out of scope reopens on a red reproduction at a later head", () => {
    const { script, id } = oneFinding();
    script.dispute(id, "out-of-scope").open(2).verdict().vote(id, "addressed").close();
    expect(script.row(id)).toMatchObject({ status: "dropped", disposition: "out-of-scope" });
    script.open(3).verdict().repro(id, 1, 0).close();
    expect(script.row(id)).toMatchObject({ status: "open", reopened: 1 });
  });

  test("the same-theme rule escalates an unreproduced row and its card names the theme", () => {
    const script = new Script();
    script.open(1).verdict("a").verdict("b");
    const id = script.finding({ theme: 7 });
    script.close();
    script.open(2).verdict("a").vote(id, "not-addressed", "a").close();
    script.open(3).verdict("a").vote(id, "not-addressed", "a").close();
    expect(script.row(id)).toMatchObject({ status: "open", escalate: "design" });
    const decision = script.decide(3, 2);
    expect(decision.action).toBe("council");
    expect(decision.cards[0]).toMatchObject({ row: id, theme: digest(1007) });
  });

  test("one reopen of a theme is not the same-theme rule", () => {
    const script = new Script();
    script.open(1).verdict();
    const id = script.finding({ theme: 7 });
    script.close();
    script.open(2).verdict().close();
    script.open(3).verdict().vote(id, "not-addressed").close();
    expect(script.row(id)).toMatchObject({ status: "deferred", escalate: null });
  });

  test("raising a theme in round 1 is not a reopen of it", () => {
    const script = new Script();
    script.open(1, "full", 2).verdict();
    const id = script.finding({ theme: 7 });
    script.close().open(2).verdict().vote(id, "not-addressed").close();
    expect(script.row(id)).toMatchObject({ status: "deferred", disposition: "cap", escalate: null });
  });

  test("a pull request has one council call", () => {
    const { script, id } = redAtCap();
    script.council([{ id, choice: "fix" }]).council([{ id, choice: "follow-up" }]);
    expect(script.state().problems).toEqual([
      "line 17 (council): the one council call of this pull request was already recorded",
    ]);
  });

  test("the council is not called while a round remains", () => {
    const { script, id } = oneFinding();
    script.council([{ id, choice: "follow-up" }]);
    expect(script.state().problems).toEqual(["line 5 (council): the council is called at the round cap"]);
  });

  test("a pull request has one bounded round", () => {
    const { script, id } = redAtCap();
    script
      .council([{ id, choice: "fix" }])
      .open(4, "bounded")
      .verdict()
      .repro(id, 1, 0)
      .close();
    script.open(5, "bounded");
    expect(script.state().problems).toEqual(["line 21 (round-open): the one bounded round was already opened"]);
  });

  test("no fourth round opens: the cap is three rounds per scope", () => {
    const script = new Script().pass(1).pass(2).pass(3);
    script.open(4);
    expect(script.state().problems).toEqual(["line 10 (round-open): the round cap of 3 is reached"]);
  });

  test("a scope may lower its cap to two rounds, and nothing raises it", () => {
    const script = new Script();
    script.open(1, "full", 2).verdict();
    const id = script.finding();
    script.close().open(2).verdict().close();
    expect(script.row(id)).toMatchObject({ status: "deferred", disposition: "cap" });
    expect(script.decide(2).cap).toBe(2);
    script.open(3);
    expect(script.state().problems).toHaveLength(1);
    const raised = new Script({ ...DEFAULT_POLICY, max_rounds: 2 });
    raised.open(1, "full", 3).verdict().close().pass(2);
    expect(raised.decide(2).cap).toBe(2);
  });

  test("a human-authorized extension is one extra closure round, once", () => {
    const { script, id } = redAtCap();
    script.extension();
    expect(script.decide(3)).toMatchObject({ verdict: "blocked", action: "fix", cap: 4 });
    script.fixed(id).open(4).verdict().repro(id, 0).close();
    expect(script.decide(4)).toMatchObject({ verdict: "incomplete", action: "captain-hold" });
    script.extension();
    expect(script.state().problems).toHaveLength(1);
  });

  test("the head moving after the last round is the owner's call, not another automatic round", () => {
    const script = new Script().pass(1).pass(2).pass(3);
    expect(script.decide(4)).toMatchObject({ verdict: "incomplete", action: "owner-hold" });
  });
});

describe("review scopes", () => {
  test("a new scope restarts the round count, keeps the rows and invalidates the approvals", () => {
    const { script, id } = oneFinding({ severity: "P3" });
    script.followup(id);
    expect(script.decide(1).verdict).toBe("approved");
    script.newScope(2);
    expect(script.decide(1)).toMatchObject({ verdict: "incomplete", action: "review-round", scope: 2, round: 0 });
    script.pass(2);
    expect(script.state().rows).toHaveLength(1);
    expect(script.decide(2).verdict).toBe("approved");
  });

  test("an approval of an earlier scope does not count in the new one", () => {
    const script = new Script().pass(1).newScope(2);
    script.open(2).verdict("b", "block").close();
    expect(script.decide(2)).toMatchObject({ verdict: "incomplete", action: "closure-round", scope: 2 });
  });

  test("a pull request opens a new scope once: the next trigger is a split-or-replan hold", () => {
    const script = new Script().pass(1).newScope(2).pass(2).newScope(3, "requirement-change");
    expect(script.decide(3)).toMatchObject({ verdict: "incomplete", action: "captain-hold", scope: 3 });
  });
});

/** A row closed in round 2 with its symbol body recorded at that head. */
function closedRow() {
  const { script, id } = oneFinding();
  script
    .fixed(id)
    .open(2)
    .verdict()
    .vote(id, "addressed")
    .close([{ id, blob: digest(2001) }]);
  script.open(3).verdict();
  return { script, id };
}

describe("reopening a terminal row", () => {
  test("a repeat with an unchanged anchor and no new evidence changes nothing", () => {
    const { script, id } = closedRow();
    script.repeat(id, { blob: digest(2001) }).close();
    expect(script.row(id)).toMatchObject({ status: "closed", reopened: 0 });
    expect(script.state().repeats).toBe(1);
    expect(script.decide(3)).toMatchObject({ verdict: "incomplete", action: "captain-hold" });
  });

  test("a repeat reopens the row when the anchor's body changed and the report is inside the delta scope", () => {
    const { script, id } = closedRow();
    script
      .repeat(id, { blob: digest(2002) })
      .repro(id, 1, 0)
      .close();
    expect(script.row(id)).toMatchObject({ status: "open", reopened: 1 });
    expect(script.decide(3).verdict).toBe("blocked");
  });

  test("a changed anchor outside the delta scope does not reopen", () => {
    const { script, id } = closedRow();
    script.repeat(id, { blob: digest(2002), in_scope: false }).close();
    expect(script.row(id).status).toBe("closed");
  });

  test("a repeat with no digest cannot show a change and does not reopen", () => {
    const { script, id } = closedRow();
    script.repeat(id).close();
    expect(script.row(id).status).toBe("closed");
  });

  test("a new reproduction that is red at this head reopens the row", () => {
    const { script, id } = closedRow();
    script.repro(id, 1, 0).close();
    expect(script.row(id)).toMatchObject({ status: "open", reopened: 1 });
    expect(script.decide(3)).toMatchObject({ verdict: "blocked", action: "council" });
  });

  test("a reproduction red at the head with no merge-base result does not reopen the row", () => {
    const { script, id } = closedRow();
    headOnlyRed(script, id, 3).close();
    expect(script.row(id)).toMatchObject({ status: "closed", reopened: 0 });
    expect(script.decide(3)).toMatchObject({ verdict: "incomplete", action: "captain-hold" });
  });

  test("a red reproduction does not reopen a filed note", () => {
    const { script, id } = oneFinding({ severity: "P2" });
    script.open(2).verdict().repro(id, 1, 0).close();
    expect(script.row(id)).toMatchObject({ status: "deferred", red: [] });
  });

  test("a changed anchor does not reopen a filed note", () => {
    const { script, id } = oneFinding({ severity: "P2" });
    script
      .open(2)
      .verdict()
      .repeat(id, { blob: digest(2002) })
      .close();
    expect(script.row(id)).toMatchObject({ status: "deferred", reopened: 0 });
  });

  test("an always-block class newly made concrete reopens the row", () => {
    const { script, id } = oneFinding({ category: "security", severity: "P2" });
    expect(script.row(id)).toMatchObject({ status: "deferred", form_error: true });
    script.open(2).verdict().repeat(id, { risk: RISK, in_scope: false }).close();
    expect(script.row(id)).toMatchObject({ status: "open", always_block: true, form_error: false });
    expect(script.decide(2).verdict).toBe("blocked");
  });
});

describe("rows and seats", () => {
  test("a second seat on an unresolved row joins it", () => {
    const script = new Script();
    script.open(1).verdict("a").verdict("b");
    const id = script.finding();
    script.seat(id, "b").close();
    expect(script.row(id).seats).toEqual(["a", "b"]);
  });

  test("an imported pipeline finding is an observation until a review seat reports it", () => {
    const script = new Script();
    script.open(1, "import");
    const id = script.finding({ seat: "pipeline" });
    script.close();
    expect(script.row(id)).toMatchObject({ status: "observation", seats: ["pipeline"] });
    script.open(1).verdict().close();
    expect(script.decide(1).verdict).toBe("approved");
    const reported = new Script();
    reported.open(1, "import");
    const same = reported.finding({ seat: "pipeline" });
    reported.close().open(1).verdict().seat(same, "a").close();
    expect(reported.row(same)).toMatchObject({ status: "open", bar: "full", seats: ["pipeline", "a"] });
    expect(reported.decide(1).verdict).toBe("blocked");
  });

  test("a confirmed duplicate is dropped and its seat and evidence move to the earlier row", () => {
    const script = new Script().pass(1, "a", "b");
    script.open(2).verdict("a").verdict("b");
    const first = script.finding({ theme: 5 });
    const second = script.finding({ theme: 5, seat: "b" });
    script.repro(second, 1, 0);
    script.line({ kind: "duplicate", id: second, of: first }).close();
    expect(script.row(second)).toMatchObject({ status: "dropped", disposition: `duplicate:${first}` });
    expect(script.row(first)).toMatchObject({ status: "open", seats: ["a", "b"], red: ["tests/repro.test.ts"] });
  });

  test("a row with new evidence is not folded into a closed row as its duplicate", () => {
    const { script, id } = oneFinding({ theme: 5 });
    script.fixed(id).open(2).verdict().vote(id, "addressed");
    const second = script.finding({ theme: 5 });
    script.repro(second, 1, 0).close().open(3).verdict();
    script.line({ kind: "duplicate", id: second, of: id });
    expect(script.state().problems).toEqual([
      `line 14 (duplicate): ${second} carries evidence the closed row ${id} does not: it stays a row`,
    ]);
  });

  test("an always-block row is not folded into an ordinary row as its duplicate", () => {
    const script = new Script();
    script.open(1).verdict();
    const first = script.finding({ theme: 5 });
    const second = script.finding({ theme: 5, category: "security", risk: RISK });
    script.line({ kind: "duplicate", id: second, of: first });
    expect(script.state().problems).toEqual([
      `line 5 (duplicate): ${second} always blocks and ${first} does not: it stays a row`,
    ]);
  });

  test("nothing round 1 finds is outside the scope, whatever its line says", () => {
    const { script, id } = oneFinding({ in_scope: false });
    expect(script.row(id)).toMatchObject({ status: "open", in_scope: true });
  });

  test("a carry needs a closed round of the scope to carry", () => {
    const script = new Script().carry(1);
    expect(script.state().problems).toEqual([
      "line 1 (carry): no round of this scope has closed: there is no review to carry",
    ]);
  });

  test.each(["finding", "verdict", "closure", "evidence", "repeat"] as const)(
    "a %s line outside an open round is refused",
    (kind) => {
      const { script, id } = oneFinding({ severity: "P3" });
      script.followup(id);
      if (kind === "finding") script.finding();
      else if (kind === "verdict") script.verdict("b");
      else if (kind === "closure") script.vote(id, "not-addressed");
      else if (kind === "evidence") script.repro(id, 1, 0);
      else script.repeat(id);
      expect(script.state().problems).toHaveLength(1);
      expect(script.decide(1).verdict).toBe("incomplete");
    },
  );

  test("a reproduction run at another head than the open round's is refused", () => {
    const script = new Script();
    script.open(1).verdict();
    const id = script.finding();
    script.line({
      kind: "evidence",
      id,
      evidence: { kind: "repro", ref: "tests/repro.test.ts", head: head(9), exit: 1, sha256: digest(1) },
    });
    expect(script.state().problems).toEqual(["line 4 (evidence): a reproduction counts at the head of the open round"]);
  });

  test("the pipeline never rules and a seat rules once per row and round", () => {
    const script = new Script();
    script.open(1).verdict();
    const id = script.finding();
    script.vote(id, "addressed", "pipeline").vote(id, "addressed").vote(id, "not-addressed");
    expect(script.state().problems).toEqual([
      "line 4 (closure): the pipeline never rules",
      `line 6 (closure): a already ruled on ${id}`,
    ]);
  });
});
