/**
 * The mutation check of the convergence engine (ADR-0018): every rule, broken
 * one at a time, fails a test.
 *
 * Each mutant is one textual change to `src/review/converge.ts`. The check
 * copies the engine, its types and the tests into a scratch tree, applies the
 * change and runs the tests there. A mutant that survives is a rule no test
 * holds. A mutant whose text is no longer in the engine fails too, so this
 * list cannot go stale without a red test.
 *
 * `TABLE` mutants run against the table tests. `PROPERTY` mutants run against
 * the property suite alone, which shows each property catches a broken engine
 * without help from the tables.
 */
import { cpSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, setDefaultTimeout, test } from "bun:test";

import { processScratch } from "../helpers/process-tmp.ts";

setDefaultTimeout(300_000);

const ROOT = join(import.meta.dir, "..", "..");
const ENGINE = "src/review/converge.ts";
const COPIED = [
  "src/review/types.ts",
  "tests/review/script.ts",
  "tests/review/driver.ts",
  "tests/review/converge.test.ts",
  "tests/review/properties.test.ts",
];
const source = readFileSync(join(ROOT, ENGINE), "utf8");

interface Mutant {
  /** The rule the change breaks. */
  rule: string;
  from: string;
  to: string;
}

const TABLE: Mutant[] = [
  {
    rule: "an always-block row blocks",
    from: `return row.always_block || row.bar === "full" || row.red.length > 0;`,
    to: `return row.bar === "full" || row.red.length > 0;`,
  },
  {
    rule: "a round 1 finding blocks on reading evidence",
    from: `return row.always_block || row.bar === "full" || row.red.length > 0;`,
    to: `return row.always_block || row.red.length > 0;`,
  },
  {
    rule: "a red reproduction blocks",
    from: `return row.always_block || row.bar === "full" || row.red.length > 0;`,
    to: `return row.always_block || row.bar === "full";`,
  },
  { rule: "P2 and P3 never block", from: `!policy.blocking_severities.includes(row.severity) ||`, to: `` },
  { rule: "a pre-existing finding never blocks", from: `    row.origin === "pre-existing" ||\n`, to: `` },
  {
    rule: "a convention finding with no cited rule never blocks",
    from: `(row.category === "convention" && row.rule === null)`,
    to: `false`,
  },
  {
    rule: "a finding outside the delta scope is an observation",
    from: `if (mode === "bounded" || (mode === "closure" && !row.in_scope)) {`,
    to: `if (mode === "bounded") {`,
  },
  {
    rule: "a bounded round admits no new finding",
    from: `if (mode === "bounded" || (mode === "closure" && !row.in_scope)) {`,
    to: `if (mode === "closure" && !row.in_scope) {`,
  },
  {
    rule: "an always-block row is placed open in any round",
    from: `  if (row.always_block) {\n    row.status = "open";`,
    to: `  if (false) {\n    row.status = "open";`,
  },
  {
    rule: "an always-block class needs a risk sentence",
    from: `always_block: concrete && event.risk !== undefined,`,
    to: `always_block: concrete,`,
  },
  {
    rule: "nothing round 1 finds is outside the scope",
    from: `in_scope: open.mode === "full" || event.in_scope,`,
    to: `in_scope: event.in_scope,`,
  },
  {
    rule: "a reproduction that never failed closes nothing",
    from: `    if (!row.red.includes(item.ref)) return;\n`,
    to: ``,
  },
  {
    rule: "a reproduction red at the merge base makes the row pre-existing",
    from: `if (item.base_exit !== 0) {`,
    to: `if (false) {`,
  },
  {
    rule: "a reproduction with no merge-base result is not red",
    from: `  if (item.base_exit === undefined) return;\n`,
    to: ``,
  },
  {
    rule: "an always-block row is not filed as pre-existing",
    from: `if (row.always_block || !isUnresolved(row)) return;`,
    to: `if (!isUnresolved(row)) return;`,
  },
  {
    rule: "a red reproduction reopens a terminal row",
    from: `  if (!isUnresolved(row)) reopen(state, row, open);\n`,
    to: ``,
  },
  {
    rule: "a red reproduction does not reopen a note",
    from: `(isNote(row, policy) || row.status === "observation")`,
    to: `(row.status === "observation")`,
  },
  {
    rule: "evidence does not promote an observation",
    from: `(isNote(row, policy) || row.status === "observation")`,
    to: `(isNote(row, policy))`,
  },
  {
    rule: "a reproduction counts at the head of the open round",
    from: `event.evidence.kind === "repro" && event.evidence.head !== open.head`,
    to: `false`,
  },
  {
    rule: "a repeat with an unchanged anchor does not reopen",
    from: `if (event.blob === undefined || event.blob === row.closed_blob || !event.in_scope) return null;`,
    to: `if (event.blob === undefined || !event.in_scope) return null;`,
  },
  {
    rule: "a repeat with no digest does not reopen",
    from: `if (event.blob === undefined || event.blob === row.closed_blob || !event.in_scope) return null;`,
    to: `if (event.blob === row.closed_blob || !event.in_scope) return null;`,
  },
  {
    rule: "a changed anchor outside the delta scope does not reopen",
    from: `if (event.blob === undefined || event.blob === row.closed_blob || !event.in_scope) return null;`,
    to: `if (event.blob === undefined || event.blob === row.closed_blob) return null;`,
  },
  {
    rule: "an always-block class newly made concrete reopens",
    from: `    return "always-block";\n`,
    to: `    return null;\n`,
  },
  {
    rule: "a changed anchor does not reopen a note",
    from: `return row.always_block || !isNote(row, policy) ? "anchor-changed" : null;`,
    to: `return "anchor-changed";`,
  },
  {
    rule: "a red reproduction decides alone at round close",
    from: `  if (row.red.length > 0) {\n    row.status = "open";\n    return;\n  }`,
    to: ``,
  },
  {
    rule: "an always-block row closes only when every seat calls it addressed",
    from: `const every = open.seats.every((seat) =>`,
    to: `const every = open.seats.some((seat) =>`,
  },
  {
    rule: "a split dispute is filed",
    from: `if (disagree > 0) defer(row, "split");`,
    to: `if (false) defer(row, "split");`,
  },
  {
    rule: "a dispute needs the holding seat and one other",
    from: `agree >= Math.min(2, Math.max(1, seats))`,
    to: `agree >= 1`,
  },
  {
    rule: "an agreed follow-up claim is deferred, not dropped",
    from: `if (row.claim === "pre-existing" || row.claim === "follow-up") defer(row, row.claim);`,
    to: `if (false) defer(row, row.claim);`,
  },
  {
    rule: "the holding seat's ADDRESSED closes the row",
    from: `  if (disagree === 0 && agree > 0) {\n    row.status = "closed";`,
    to: `  if (false) {\n    row.status = "closed";`,
  },
  {
    rule: "NOT-ADDRESSED with no reproduction defers the row",
    from: `if (row.status === "addressed" && disagree > 0) defer(row, "unreproduced");`,
    to: `if (false) defer(row, "unreproduced");`,
  },
  {
    rule: "a finding raised after round 1 needs a red reproduction to stay open",
    from: `  else if (row.bar === "closure") defer(row, "unreproduced");\n`,
    to: ``,
  },
  {
    rule: "a red reproduction at the cap escalates",
    from: `if (row.always_block || row.red.length > 0) row.escalate = "evidence";`,
    to: `if (row.always_block) row.escalate = "evidence";`,
  },
  {
    rule: "an always-block row at the cap goes to the owner",
    from: `if (row.always_block || row.red.length > 0) row.escalate = "evidence";`,
    to: `if (row.red.length > 0) row.escalate = "evidence";`,
  },
  {
    rule: "the same theme reopened in two consecutive rounds escalates",
    from: `else if (open.mode === "closure" && twice.includes(row.theme)) row.escalate = "design";`,
    to: `else if (false) row.escalate = "design";`,
  },
  {
    rule: "the same-theme rule needs two consecutive rounds",
    from: `state.theme_rounds.some((hit) => hit.theme === theme && hit.round === open.round - 1),`,
    to: `true,`,
  },
  {
    rule: "raising a theme in round 1 is not a reopen",
    from: `  if (open.mode !== "closure") return;\n`,
    to: ``,
  },
  {
    rule: "reading evidence alone is deferred at the cap",
    from: `else if (row.escalate === null) defer(row, "cap");`,
    to: `else if (false) defer(row, "cap");`,
  },
  {
    rule: "the cap rules run at the last allowed round",
    from: `if (open.mode === "bounded" || open.round >= state.max_rounds) applyCap(state, open);`,
    to: `if (open.mode === "bounded" || open.round > state.max_rounds) applyCap(state, open);`,
  },
  {
    rule: "no round opens past the cap",
    from: "return event.round <= roundCap(state) ? null : `the round cap of ${roundCap(state)} is reached`;",
    to: `return null;`,
  },
  {
    rule: "a scope lowers its cap and nothing raises it",
    from: `state.max_rounds = Math.min(policy.max_rounds, event.max_rounds);`,
    to: `state.max_rounds = event.max_rounds;`,
  },
  {
    rule: "a scope has one extension",
    from: `return state.extensions === 0 ? null : "this scope already has its one extension";`,
    to: `return null;`,
  },
  {
    rule: "a pull request has one council call",
    from: `  if (state.council !== null) return "the one council call of this pull request was already recorded";\n`,
    to: ``,
  },
  {
    rule: "the council is called at the cap",
    from: `if (!state.capped || state.round < roundCap(state)) return "the council is called at the round cap";`,
    to: ``,
  },
  {
    rule: "the council never rules on an always-block row",
    from: `return row === undefined || !isUnresolved(row) || row.escalate === null || row.always_block;`,
    to: `return row === undefined || !isUnresolved(row) || row.escalate === null;`,
  },
  {
    rule: "an always-block row gets no council card",
    from: `blocking.filter((row) => row.escalate !== null && !row.always_block);`,
    to: `blocking.filter((row) => row.escalate !== null);`,
  },
  {
    rule: "a pull request has one bounded round",
    from: `  if (state.bounded) return "the one bounded round was already opened";\n`,
    to: ``,
  },
  {
    rule: "a council ruling of follow-up defers the row",
    from: 'if (ruling.choice === "follow-up") defer(row, `council:${event.record}`);',
    to: ``,
  },
  {
    rule: "a new scope restarts the round count",
    from: `      state.scope = event.scope;\n      state.round = 0;\n`,
    to: `      state.scope = event.scope;\n`,
  },
  {
    rule: "a new scope invalidates the approvals",
    from: `      state.covered_head = null;\n      state.full_seats = [];\n`,
    to: ``,
  },
  {
    rule: "a further scope is a split-or-replan hold",
    from: `if (state.scope > policy.max_scopes)`,
    to: `if (false)`,
  },
  {
    rule: "a refused line makes the ledger unapprovable",
    from: `if (state.problems.length > 0 || context.integrity_failures.length > 0)`,
    to: `if (context.integrity_failures.length > 0)`,
  },
  {
    rule: "a failed integrity check is incomplete",
    from: `if (state.problems.length > 0 || context.integrity_failures.length > 0)`,
    to: `if (state.problems.length > 0)`,
  },
  {
    rule: "a gap in seq is a problem",
    from: `if (event.seq !== index + 1)`,
    to: `if (false)`,
  },
  {
    rule: "an open round is never approved",
    from: `  if (state.open !== null)\n    return result(held, "close-round"`,
    to: `  if (false)\n    return result(held, "close-round"`,
  },
  {
    rule: "a scope with no closed round is not reviewed",
    from: `  if (state.covered_head === null)\n    return result(held, "review-round"`,
    to: `  if (false)\n    return result(held, "review-round"`,
  },
  {
    rule: "a blocking row blocks the verdict",
    from: `  if (blocking.length > 0) {\n    const next`,
    to: `  if (false) {\n    const next`,
  },
  { rule: "approval does not move with the head", from: `  if (!covered) {`, to: `  if (false) {` },
  {
    rule: "round 1 sits the seats the tier requires",
    from: `if (state.full_seats.length < required)`,
    to: `if (false)`,
  },
  {
    rule: "approval needs an approving seat",
    from: `if (state.approving.length === 0)`,
    to: `if (false)`,
  },
  {
    rule: "a seat's latest verdict replaces its earlier one",
    from: `      state.approving = state.approving.filter((seat) => seat !== event.seat);\n`,
    to: ``,
  },
  {
    rule: "a new scope invalidates the approvals",
    from: `      state.approving = [];\n      state.capped = false;`,
    to: `      state.capped = false;`,
  },
  {
    rule: "a deferred row needs a follow-up reference",
    from: `  if (unfiled.length > 0)\n`,
    to: `  if (false)\n`,
  },
  {
    rule: "missing evidence is incomplete",
    from: `if (context.evidence_missing.length > 0)`,
    to: `if (false)`,
  },
  {
    rule: "the head moving after the last round is the owner's call",
    from: `    return state.round < cap\n      ? result("incomplete", "closure-round", [`,
    to: `    return true\n      ? result("incomplete", "closure-round", [`,
  },
  {
    rule: "blocking rows at the cap leave the fix cycle",
    from: `  if (state.round < cap) {\n    const unanswered`,
    to: `  if (true) {\n    const unanswered`,
  },
  {
    rule: "nothing at the cap approves on its own",
    from: `  if (state.round >= cap)\n    return result("incomplete", "captain-hold", [`,
    to: `  if (false)\n    return result("incomplete", "captain-hold", [`,
  },
  {
    rule: "a ruling of fix gives the bounded round",
    from: `if (state.council !== null && !state.bounded && awaitsBoundedRound(state))`,
    to: `if (false)`,
  },
  { rule: "evidence is written inside a round", from: `  "evidence",\n  "closure",\n];`, to: `  "closure",\n];` },
  { rule: "a finding is written inside a round", from: `  "finding",\n  "seat",\n`, to: `  "seat",\n` },
  {
    rule: "the pipeline never rules",
    from: `  if (event.seat === PIPELINE_SEAT) return "the pipeline never rules";\n`,
    to: ``,
  },
  {
    rule: "a seat rules once per row and round",
    from: "return row.votes.some((vote) => vote.seat === event.seat) ? `${event.seat} already ruled on ${row.id}` : null;",
    to: `return null;`,
  },
  {
    rule: "a seat's report promotes a pipeline observation",
    from: `      if (!promoted) return;\n      place(row, open.mode, policy);`,
    to: `      return;`,
  },
  {
    rule: "a row with new evidence is not a duplicate of a closed row",
    from: `if (!isUnresolved(earlier) && (later.always_block || later.red.length > 0))`,
    to: `if (false)`,
  },
  {
    rule: "an always-block row is not a duplicate of an ordinary row",
    from: `if (later.always_block && !earlier.always_block)`,
    to: `if (false)`,
  },
  {
    rule: "a duplicate's red reproduction follows the defect",
    from: `        for (const ref of later.red) if (!earlier.red.includes(ref)) earlier.red.push(ref);\n`,
    to: ``,
  },
  {
    rule: "a carry needs a closed round",
    from: `return state.covered_head === null ? "no round of this scope has closed: there is no review to carry" : null;`,
    to: `return null;`,
  },
  {
    rule: "the author never closes a row",
    from: `row.status = event.response === "fixed" ? "addressed" : "disputed";`,
    to: `row.status = event.response === "fixed" ? "closed" : "disputed";`,
  },
];

const PROPERTY: Mutant[] = [
  {
    rule: "safety: a red reproduction blocks",
    from: `return row.always_block || row.bar === "full" || row.red.length > 0;`,
    to: `return row.always_block || row.bar === "full";`,
  },
  {
    rule: "safety: an always-block row is not filed at round close",
    from: `const every = open.seats.every((seat) =>`,
    to: `const every = open.seats.some((seat) =>`,
  },
  {
    rule: "termination: blocking rows at the cap leave the fix cycle",
    from: `  if (state.round < cap) {\n    const unanswered`,
    to: `  if (true) {\n    const unanswered`,
  },
  {
    rule: "termination: the bounded round is asked for once",
    from: `if (state.council !== null && !state.bounded && awaitsBoundedRound(state))`,
    to: `if (state.council !== null && awaitsBoundedRound(state))`,
  },
  {
    rule: "monotonic filter: an unchanged anchor does not reopen",
    from: `if (event.blob === undefined || event.blob === row.closed_blob || !event.in_scope) return null;`,
    to: `if (!event.in_scope) return null;`,
  },
  {
    rule: "crash safety: the author answers an unresolved row only",
    from: "return isUnresolved(row) ? null : `${row.id} is ${row.status}: the author answers an unresolved row`;",
    to: `return null;`,
  },
  {
    rule: "crash safety: a refused line is never approved",
    from: `if (state.problems.length > 0 || context.integrity_failures.length > 0)`,
    to: `if (context.integrity_failures.length > 0)`,
  },
];

const scratch = processScratch("review-mutants-");

/** Build the scratch tree for one engine text and run `file` there. Returns bun's exit status. */
async function run(name: string, engine: string, file: string): Promise<number> {
  const dir = join(scratch, name);
  mkdirSync(join(dir, "src", "review"), { recursive: true });
  mkdirSync(join(dir, "tests", "review"), { recursive: true });
  for (const path of COPIED) cpSync(join(ROOT, path), join(dir, path));
  writeFileSync(join(dir, ENGINE), engine);
  symlinkSync(join(ROOT, "node_modules"), join(dir, "node_modules"));
  const child = Bun.spawn([process.execPath, "test", `./tests/review/${file}`], {
    cwd: dir,
    stdout: "ignore",
    stderr: "ignore",
    env: { ...process.env, AK_REVIEW_SEED: "" },
  });
  return child.exited;
}

/** The rules whose mutant passed `file`, or whose text is gone from the engine. */
async function survivors(mutants: readonly Mutant[], file: string, prefix: string): Promise<string[]> {
  const alive: string[] = [];
  const pending = mutants.map((mutant, index) => ({ mutant, index }));
  const worker = async (): Promise<void> => {
    for (let next = pending.shift(); next !== undefined; next = pending.shift()) {
      const { mutant, index } = next;
      if (source.split(mutant.from).length !== 2) {
        alive.push(`${mutant.rule}: its text is in the engine ${source.split(mutant.from).length - 1} times`);
        continue;
      }
      const status = await run(`${prefix}${index}`, source.replace(mutant.from, mutant.to), file);
      if (status === 0) alive.push(`${mutant.rule}: no test failed`);
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  return alive.toSorted();
}

describe("mutation check of the convergence engine", () => {
  test("the unchanged engine passes in the scratch tree, so a red mutant is the mutant's doing", async () => {
    expect(await run("clean-table", source, "converge.test.ts")).toBe(0);
    expect(await run("clean-properties", source, "properties.test.ts")).toBe(0);
  });

  test("every broken rule fails a table test", async () => {
    expect(await survivors(TABLE, "converge.test.ts", "table-")).toEqual([]);
  });

  test("each property catches a broken engine", async () => {
    expect(await survivors(PROPERTY, "properties.test.ts", "property-")).toEqual([]);
  });
});
