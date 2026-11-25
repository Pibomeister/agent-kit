/**
 * The four properties of the convergence engine (ADR-0018), over random
 * reviews written by `driver.ts`.
 *
 * - Termination: following `decide` ends in `approved` or a hold within the
 *   round cap, one council call and one bounded closure round.
 * - Safety: no ledger is approved while its lines say a row must block.
 * - Monotonic filter: a repeat with no changed anchor and no new evidence
 *   changes no verdict.
 * - Determinism and crash safety: every prefix folds clean, the same lines
 *   give the same verdict, and dropping the last line never turns `blocked`
 *   into `approved`.
 *
 * The seed is pinned, so a run is the same on every machine. Replay another:
 *   AK_REVIEW_SEED=<seed> bun test tests/review/properties.test.ts
 */
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { array, boolean, check as fcCheck, defaultReportMessage, integer, nat, property, record } from "fast-check";

import { blocks, decide, fold, isUnresolved } from "../../src/review/converge.ts";
import { DEFAULT_POLICY, type LedgerEvent } from "../../src/review/types.ts";
import { Picker, contextAt, drive, mustBlock, wildLines, type Run } from "./driver.ts";
import { head } from "./script.ts";

setDefaultTimeout(120_000);

const PINNED_SEED = 20_261_119;
const NUM_RUNS = 400;
const seedEnv = Number(process.env["AK_REVIEW_SEED"] ?? "");
const seed = Number.isInteger(seedEnv) && seedEnv !== 0 ? seedEnv : PINNED_SEED;
const policy = DEFAULT_POLICY;

const reviewArb = record({
  picks: array(nat(10_000), { maxLength: 600, size: "max" }),
  seats: integer({ min: 1, max: 3 }),
  owner: boolean(),
  scopes: boolean(),
  /** A second list, for what a property does with the finished ledger. */
  after: array(nat(10_000), { minLength: 8, maxLength: 8 }),
});

function holds(name: string, predicate: (review: ReviewInput, run: Run) => string | null): void {
  test(name, () => {
    const details = fcCheck(
      property(reviewArb, (review) => {
        const run = drive(review.picks, { policy, seats: review.seats, owner: review.owner, scopes: review.scopes });
        const failure = predicate(review, run);
        if (failure !== null)
          throw new Error(`${failure}\n${run.events.map((event) => JSON.stringify(event)).join("\n")}`);
      }),
      { seed, numRuns: NUM_RUNS },
    );
    if (details.failed) throw new Error(defaultReportMessage(details));
    expect(details.numRuns).toBe(NUM_RUNS);
  });
}

interface ReviewInput {
  picks: number[];
  seats: number;
  owner: boolean;
  scopes: boolean;
  after: number[];
}

function count(events: readonly LedgerEvent[], test_: (event: LedgerEvent) => boolean): number {
  let total = 0;
  for (const event of events) if (test_(event)) total += 1;
  return total;
}

/** The verdict a ledger gets for the head its review covers, which is the only head it can be approved for. */
function verdictAt(events: readonly LedgerEvent[], seats: number, at: string | null) {
  return decide(events, policy, { ...contextAt(1, seats), head: at ?? head(1) });
}

function renumber(events: readonly LedgerEvent[]): LedgerEvent[] {
  return events.map((event, index) => ({ ...event, seq: index + 1 }));
}

describe("the driver", () => {
  test("a list of zeros is the shortest review: one round, no finding, approved", () => {
    const run = drive([], { policy, seats: 2, owner: false, scopes: false });
    expect(run.events.map((event) => event.kind)).toEqual(["round-open", "verdict", "verdict", "round-close"]);
    expect(run.final).toMatchObject({ verdict: "approved", action: "none" });
  });

  test("the random reviews reach every action and every row status", () => {
    const actions = new Set<string>();
    const statuses = new Set<string>();
    const kinds = new Set<string>();
    fcCheck(
      property(reviewArb, (review) => {
        const run = drive(review.picks, { policy, seats: review.seats, owner: review.owner, scopes: review.scopes });
        for (let k = 0; k <= run.events.length; k += 1) {
          const prefix = run.events.slice(0, k);
          const state = fold(prefix, policy);
          actions.add(verdictAt(prefix, review.seats, state.covered_head).action);
          for (const row of state.rows) statuses.add(row.status);
        }
        for (const event of run.events) kinds.add(event.kind);
      }),
      { seed, numRuns: NUM_RUNS },
    );
    // `repair` and `supply-evidence` come from the caller's context and from refused lines, which the driver never writes.
    expect([...actions].toSorted()).toEqual(
      [
        "bounded-closure",
        "captain-hold",
        "close-round",
        "closure-round",
        "council",
        "file-follow-ups",
        "fix",
        "none",
        "owner-hold",
        "review-round",
      ].toSorted(),
    );
    expect([...statuses].toSorted()).toEqual(
      ["addressed", "closed", "deferred", "disputed", "dropped", "observation", "open"].toSorted(),
    );
    expect(kinds.size).toBe(17);
  });
});

describe("convergence properties", () => {
  holds("termination: following decide ends in approved or a hold, inside the round budget", (review, run) => {
    if (run.stuck !== null) return `stuck at ${run.stuck} after ${run.steps} steps`;
    const state = fold(run.events, policy);
    if (JSON.stringify(state) !== JSON.stringify(run.state)) return "fold differs from the state built line by line";
    if (state.problems.length > 0) return `the driver wrote a refused line: ${state.problems.join("; ")}`;
    const ended =
      run.final.verdict === "approved" || run.final.action === "owner-hold" || run.final.action === "captain-hold";
    if (!ended) return `ended at ${run.final.verdict} / ${run.final.action}`;
    const scopes = 1 + count(run.events, (event) => event.kind === "scope-open");
    const extensions = count(run.events, (event) => event.kind === "extension");
    const rounds = count(run.events, (event) => event.kind === "round-open" && event.mode !== "import");
    const bounded = count(run.events, (event) => event.kind === "round-open" && event.mode === "bounded");
    const councils = count(run.events, (event) => event.kind === "council");
    if (councils > 1) return `${councils} council calls`;
    if (bounded > 1) return `${bounded} bounded rounds`;
    // Per scope: the round cap, plus one extension the owner may grant. Per pull request: one bounded round.
    if (rounds > scopes * policy.max_rounds + extensions + bounded) return `${rounds} rounds in ${scopes} scopes`;
    if (!review.owner && !review.scopes && rounds > policy.max_rounds + 1) return `${rounds} rounds with no owner act`;
    if (scopes > policy.max_scopes + 1) return `${scopes} scopes`;
    return null;
  });

  holds("safety: never approved while an always-block row or a red reproduction is open", (review, run) => {
    for (let k = 0; k <= run.events.length; k += 1) {
      const prefix = run.events.slice(0, k);
      const state = fold(prefix, policy);
      const decision = verdictAt(prefix, review.seats, state.covered_head);
      if (decision.verdict !== "approved") continue;
      const owed = mustBlock(prefix, policy);
      if (owed.length > 0) return `approved at line ${k} while ${owed.join(", ")} must block`;
      const open = state.rows.filter((row) => isUnresolved(row) && (row.always_block || row.red.length > 0));
      if (open.length > 0) return `approved at line ${k} with ${open.map((row) => row.id).join(", ")} open`;
      if (state.rows.some(blocks)) return `approved at line ${k} with a blocking row`;
      if (state.rows.some((row) => row.status === "deferred" && row.followup === null))
        return `approved at line ${k} with a deferred row that has no follow-up`;
    }
    return null;
  });

  holds("monotonic filter: a repeat with no changed anchor and no new evidence changes no verdict", (review, run) => {
    const picker = new Picker(review.after);
    const places: { at: number; id: string; blob: string }[] = [];
    for (let k = 1; k < run.events.length; k += 1) {
      const state = fold(run.events.slice(0, k), policy);
      if (state.open === null || state.open.mode === "import") continue;
      for (const row of state.rows) if (!isUnresolved(row)) places.push({ at: k, id: row.id, blob: row.closed_blob });
    }
    if (places.length === 0) return null;
    const place = places[picker.next(places.length)];
    if (place === undefined) return null;
    const repeat: LedgerEvent = {
      v: 1,
      seq: 0,
      kind: "repeat",
      id: place.id,
      seat: "a",
      in_scope: picker.next(2) === 0,
    };
    if (picker.next(2) === 0) repeat.blob = place.blob;
    const flip: LedgerEvent = { v: 1, seq: 0, kind: "flip", id: place.id, seat: "a", reason: "no change" };
    const padded = renumber([...run.events.slice(0, place.at), repeat, flip, ...run.events.slice(place.at)]);
    const state = fold(padded, policy);
    if (state.problems.length > 0) return `the repeat was refused: ${state.problems.join("; ")}`;
    if (state.repeats !== run.state.repeats + 1) return "the repeat was not counted";
    for (const at of [run.head, run.head + 1]) {
      const before = decide(run.events, policy, contextAt(at, review.seats));
      const after = decide(padded, policy, contextAt(at, review.seats));
      if (JSON.stringify(before) !== JSON.stringify(after))
        return `the repeat of ${place.id} at line ${place.at} changed the decision`;
    }
    return JSON.stringify(state.rows) === JSON.stringify(run.state.rows) ? null : "the repeat changed a row";
  });

  holds("determinism and crash safety: every prefix folds, and a lost last line never approves", (review, run) => {
    const copy: unknown = JSON.parse(JSON.stringify(run.events));
    if (JSON.stringify(copy) !== JSON.stringify(run.events)) return "the ledger does not survive a JSON round trip";
    let earlier = fold([], policy);
    for (let k = 1; k <= run.events.length; k += 1) {
      const full = run.events.slice(0, k);
      const cut = run.events.slice(0, k - 1);
      const state = fold(full, policy);
      if (state.problems.length > 0) return `prefix ${k} has problems: ${state.problems.join("; ")}`;
      for (const at of [state.covered_head, earlier.covered_head, head(run.head)]) {
        const whole = verdictAt(full, review.seats, at);
        if (JSON.stringify(whole) !== JSON.stringify(verdictAt(full, review.seats, at)))
          return `two verdicts for the same ${k} lines`;
        if (whole.verdict === "blocked" && verdictAt(cut, review.seats, at).verdict === "approved")
          return `dropping line ${k} turns blocked into approved`;
      }
      earlier = state;
    }
    return null;
  });

  holds("crash safety: no single line appended to an approved ledger blocks it", (review, run) => {
    for (let k = 1; k <= run.events.length; k += 1) {
      const prefix = run.events.slice(0, k);
      const state = fold(prefix, policy);
      if (verdictAt(prefix, review.seats, state.covered_head).verdict !== "approved") continue;
      for (const line of wildLines(state, run.head)) {
        // SAFETY: `wildLines` returns members of the LedgerEvent union without `v` and `seq`, and both are added here.
        const wild = { ...line, v: 1, seq: k + 1 } as LedgerEvent;
        const extended = [...prefix, wild];
        const after = fold(extended, policy);
        for (const at of [state.covered_head, after.covered_head]) {
          const whole = verdictAt(extended, review.seats, at);
          // If this line were the one a crash lost, the shorter ledger would approve what the full one blocks.
          if (whole.verdict === "blocked" && verdictAt(prefix, review.seats, at).verdict === "approved")
            return `a ${wild.kind} line after line ${k} blocks an approved ledger: ${JSON.stringify(wild)}`;
          if (after.problems.length > 0 && whole.verdict === "approved")
            return `approved with a refused ${wild.kind} line after line ${k}`;
        }
      }
    }
    return null;
  });
});
