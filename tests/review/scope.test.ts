/**
 * The full-re-review triggers and the scope outcome (ADR-0018), as tables.
 *
 * Every expected value here comes from the trigger table of the plan the ADR
 * records: a rewritten share above 30%, a resolved conflict, a higher class, a
 * newly touched surface, growth above 50% or above 400 lines, a changed intent
 * and changed acceptance criteria. Nothing here runs git: `scope-git.test.ts`
 * reads the same facts from fixture repositories.
 */
import { describe, expect, test } from "bun:test";

import {
  linesNotIn,
  readPatch,
  scopeOutcome,
  scopeTriggers,
  type DeltaFacts,
  type ScopeFacts,
} from "../../src/review/scope.ts";
import { DEFAULT_POLICY, SCOPE_TRIGGERS, type ScopeTrigger } from "../../src/review/types.ts";

const A = `sha256:${"a".repeat(64)}`;
const B = `sha256:${"b".repeat(64)}`;

/** A fix of 10 changed lines on a pull request of 100, with every input supplied and unchanged. */
function facts(delta: Partial<DeltaFacts> = {}, rest: Partial<Omit<ScopeFacts, "delta">> = {}): ScopeFacts {
  return {
    delta: {
      empty: false,
      pr_lines: 100,
      added_lines: 10,
      removed_lines: 0,
      rewritten_lines: 0,
      conflict_paths: [],
      path_identity: [],
      changed_paths: [],
      ...delta,
    },
    class_rose: false,
    surface_changed: false,
    intent: { before: A, now: A },
    criteria: { before: A, now: A },
    ...rest,
  };
}

const fired = (given: ScopeFacts) => scopeTriggers(given, DEFAULT_POLICY).fired;

describe("scopeTriggers", () => {
  test("a fix commit with every input unchanged fires nothing and leaves nothing unevaluated", () => {
    expect(scopeTriggers(facts(), DEFAULT_POLICY)).toEqual({ fired: [], reasons: [], unevaluated: [] });
  });

  const deltaCases: [string, Partial<DeltaFacts>, ScopeTrigger[]][] = [
    ["rewritten commits that changed 30% of the lines", { rewritten_lines: 30 }, []],
    ["rewritten commits that changed 31% of the lines", { rewritten_lines: 31 }, ["large-rebase"]],
    ["every commit rewritten while the patch is unchanged", { empty: true, rewritten_lines: 100 }, []],
    ["a conflict resolved in a path of the pull request", { conflict_paths: ["src/a.ts"] }, ["large-rebase"]],
    [
      "a resolved conflict while the patch is unchanged",
      { empty: true, added_lines: 0, conflict_paths: ["src/a.ts"] },
      ["large-rebase"],
    ],
    ["a three-parent merge with no mixed path", { empty: true, conflict_paths: ["."] }, ["large-rebase"]],
    ["a delta that adds 50%", { added_lines: 50 }, []],
    ["a delta that adds 51%", { added_lines: 51 }, ["scope-growth"]],
    ["a delta that adds 400 lines to 1000", { pr_lines: 1000, added_lines: 400 }, []],
    ["a delta that adds 401 lines to 1000", { pr_lines: 1000, added_lines: 401 }, ["scope-growth"]],
    ["lines that left the patch", { added_lines: 0, removed_lines: 90 }, []],
    ["a gitlink or same-blob add and delete", { path_identity: ["vendor/lib"] }, ["path-identity"]],
  ];
  test.each(deltaCases)("%s", (_name, delta, expected) => {
    expect(fired(facts(delta))).toEqual(expected);
  });

  const inputCases: [string, Partial<Omit<ScopeFacts, "delta">>, ScopeTrigger[]][] = [
    ["a higher class", { class_rose: true }, ["risk-tier-rise"]],
    ["a newly touched surface", { surface_changed: true }, ["surface-changed"]],
    ["a changed intent file", { intent: { before: A, now: B } }, ["scope-growth"]],
    ["changed acceptance criteria", { criteria: { before: A, now: B } }, ["requirement-change"]],
  ];
  test.each(inputCases)("%s", (_name, rest, expected) => {
    expect(fired(facts({}, rest))).toEqual(expected);
  });

  test("several triggers fire in the order of the ledger's trigger list, each with one reason", () => {
    const all = scopeTriggers(
      facts(
        { rewritten_lines: 80, added_lines: 500, path_identity: ["vendor/lib"] },
        { class_rose: true, surface_changed: true, criteria: { before: A, now: B } },
      ),
      DEFAULT_POLICY,
    );
    expect(all.fired).toEqual([...SCOPE_TRIGGERS]);
    expect(all.reasons).toHaveLength(SCOPE_TRIGGERS.length);
    expect(all.reasons.filter((reason) => reason === "")).toEqual([]);
  });

  test("an input that was not supplied leaves its trigger unevaluated, and the trigger does not fire", () => {
    const none = scopeTriggers(
      facts(
        {},
        {
          class_rose: null,
          surface_changed: null,
          intent: { before: null, now: A },
          criteria: { before: A, now: null },
        },
      ),
      DEFAULT_POLICY,
    );
    expect(none.fired).toEqual([]);
    expect(none.unevaluated.map((entry) => entry.trigger)).toEqual([
      "risk-tier-rise",
      "surface-changed",
      "scope-growth",
      "requirement-change",
    ]);
  });

  test("growth in lines fires with no intent file, and is then not listed as unevaluated", () => {
    const grown = scopeTriggers(facts({ added_lines: 60 }, { intent: { before: null, now: null } }), DEFAULT_POLICY);
    expect(grown.fired).toEqual(["scope-growth"]);
    expect(grown.unevaluated).toEqual([]);
  });

  test("the thresholds are the policy's", () => {
    const strict = { ...DEFAULT_POLICY, triggers: { rebase_rewritten_percent: 5, growth_percent: 5, growth_lines: 5 } };
    expect(scopeTriggers(facts({ rewritten_lines: 6, added_lines: 0 }), strict).fired).toEqual(["large-rebase"]);
    expect(scopeTriggers(facts({ pr_lines: 1000, added_lines: 6 }), strict).fired).toEqual(["scope-growth"]);
    expect(scopeTriggers(facts({ added_lines: 6 }), strict).fired).toEqual(["scope-growth"]);
  });
});

describe("scopeOutcome", () => {
  const quiet = scopeTriggers(facts(), DEFAULT_POLICY);
  const loud = scopeTriggers(facts({}, { class_rose: true }), DEFAULT_POLICY);
  const delta = facts().delta;
  const unchanged = { ...delta, empty: true, added_lines: 0 };

  test.each([
    ["round 1 of the first scope is the full review", { scope: 1, reviewed: false }, null, null, "full"],
    ["round 1 of the second scope is a full review too", { scope: 2, reviewed: false }, null, null, "full"],
    [
      "nothing reviewed in the scope is a full review, whatever was compared",
      { scope: 2, reviewed: false },
      loud,
      delta,
      "full",
    ],
    ["a delta with no trigger gets a closure round", { scope: 1, reviewed: true }, quiet, delta, "closure"],
    ["an unchanged patch carries", { scope: 1, reviewed: true }, quiet, unchanged, "carry"],
    ["a trigger opens the one new scope", { scope: 1, reviewed: true }, loud, delta, "new-scope"],
    ["a trigger on an unchanged patch still opens it", { scope: 1, reviewed: true }, loud, unchanged, "new-scope"],
    ["a second trigger holds the pull request", { scope: 2, reviewed: true }, loud, delta, "hold"],
    [
      "a delta in the second scope with no trigger is a closure round",
      { scope: 2, reviewed: true },
      quiet,
      delta,
      "closure",
    ],
    ["a pull request past its last scope is held", { scope: 3, reviewed: false }, null, null, "hold"],
  ] as const)("%s", (_name, position, triggers, given, expected) => {
    expect(scopeOutcome(position, triggers, given, DEFAULT_POLICY)).toBe(expected);
  });
});

const HEADER = "diff --git a/src/a.ts b/src/a.ts\nindex 1111..2222 100644\n--- a/src/a.ts\n+++ b/src/a.ts\n";

/** A same-sized replacement hunk starting at `start`, or nothing when `count` is 0. */
function replacement(start: number, count: number): string {
  return count === 0
    ? ""
    : `@@ -${start + 1},${count} +${start + 1},${count} @@\n` +
        Array.from({ length: count }, (_, index) => `-old${start + index}\n`).join("") +
        Array.from({ length: count }, (_, index) => `+new${start + index}\n`).join("");
}

/** The patch of a binary file that becomes the blob whose id repeats `blob`. */
function binary(blob: string) {
  return readPatch(
    `diff --git a/logo.png b/logo.png\nindex ${"1".repeat(40)}..${blob.repeat(40)} 100644\nBinary files a/logo.png and b/logo.png differ\n`,
  );
}

describe("readPatch", () => {
  test("counts the added and the removed lines and no header", () => {
    const patch = readPatch(`${HEADER}@@ -3 +3,2 @@\n-const a = 1;\n+const a = 2;\n+const b = 3;\n`);
    expect(patch.lines).toBe(3);
  });

  test("a patch that only moved keeps its id", () => {
    const at3 = readPatch(`${HEADER}@@ -3 +3 @@\n-old\n+new\n`);
    const at90 = readPatch(`${HEADER}@@ -90 +94 @@ function later() {\n-old\n+new\n`);
    expect(at90.id).toBe(at3.id);
  });

  test("an indentation change is a change", () => {
    const flat = readPatch(`${HEADER}@@ -3 +3 @@\n-old\n+return 1\n`);
    const nested = readPatch(`${HEADER}@@ -3 +3 @@\n-old\n+    return 1\n`);
    expect(nested.id).not.toBe(flat.id);
  });

  test("a removed line that looks like a file header is a changed line", () => {
    const patch = readPatch(`${HEADER}@@ -3,2 +2 @@\n--- a/src/a.ts\n-+++ b/src/a.ts\n`);
    expect(patch.lines).toBe(2);
  });

  test("the same lines in another file are another patch", () => {
    const other = HEADER.replaceAll("src/a.ts", "src/b.ts");
    expect(readPatch(`${other}@@ -3 +3 @@\n-old\n+new\n`).id).not.toBe(
      readPatch(`${HEADER}@@ -3 +3 @@\n-old\n+new\n`).id,
    );
  });

  test("a binary file is one changed line, and another blob is another patch", () => {
    expect(binary("2").lines).toBe(1);
    expect(binary("3").id).not.toBe(binary("2").id);
  });

  test("a mode change and a lost final newline change the id, and the mode pair counts as one line", () => {
    const plain = readPatch(`${HEADER}@@ -3 +3 @@\n-old\n+new\n`);
    const mode = readPatch(
      `${HEADER.replace("index", "old mode 100644\nnew mode 100755\nindex")}@@ -3 +3 @@\n-old\n+new\n`,
    );
    const newline = readPatch(`${HEADER}@@ -3 +3 @@\n-old\n+new\n\\ No newline at end of file\n`);
    expect([mode.lines, newline.lines]).toEqual([3, 2]);
    expect(new Set([plain.id, mode.id, newline.id]).size).toBe(3);
  });

  test("a mode-only pair with no hunk is one changed line", () => {
    const patch = readPatch("diff --git a/src/a.ts b/src/a.ts\nold mode 100644\nnew mode 100755\n");
    expect(patch.lines).toBe(1);
  });

  test("a hunkless new or deleted file is one changed line", () => {
    const added = readPatch("diff --git a/empty b/empty\nnew file mode 100644\nindex 0000000..e69de29\n");
    const deleted = readPatch("diff --git a/empty b/empty\ndeleted file mode 100644\nindex e69de29..0000000\n");
    const executable = readPatch("diff --git a/empty b/empty\nnew file mode 100755\nindex 0000000..e69de29\n");
    expect([added.lines, deleted.lines, executable.lines]).toEqual([1, 1, 1]);
  });

  test("a gitlink bump is one SHA line", () => {
    const old = "1".repeat(40);
    const next = "2".repeat(40);
    const patch = readPatch(
      `diff --git a/vendor/lib b/vendor/lib\nindex ${old}..${next} 160000\n--- a/vendor/lib\n+++ b/vendor/lib\n@@ -1 +1 @@\n-Subproject commit ${old}\n+Subproject commit ${next}\n`,
    );
    expect(patch.lines).toBe(1);
  });
});

describe("linesNotIn", () => {
  test.each([0, 24, 49])("restoring source line %i removes only its two patch entries", (restored) => {
    const before = readPatch(HEADER + replacement(0, 50));
    const after = readPatch(HEADER + replacement(0, restored) + replacement(restored + 1, 49 - restored));
    expect(linesNotIn(after, before)).toBe(0);
    expect(linesNotIn(before, after)).toBe(2);
    expect(after.id).not.toBe(before.id);
  });

  test("inserting a line inside replacement text preserves the other entries", () => {
    const before = readPatch(HEADER + replacement(0, 50));
    const after = readPatch(
      HEADER + replacement(0, 50).replace("+new0\n", "+extra\n+new0\n").replace("+1,50", "+1,51"),
    );
    expect(linesNotIn(after, before)).toBe(1);
    expect(linesNotIn(before, after)).toBe(0);
  });

  test("merging hunks matches each repeated line only once", () => {
    const separate = readPatch(`${HEADER}@@ -1 +1 @@\n-a\n+same\n@@ -3 +3 @@\n-b\n+same\n`);
    const merged = readPatch(`${HEADER}@@ -1,3 +1,3 @@\n-a\n-gap\n-b\n+same\n+same\n+same\n`);
    expect(linesNotIn(merged, separate)).toBe(2);
    expect(linesNotIn(separate, merged)).toBe(0);
    expect(linesNotIn(merged, separate)).toBe(2);
  });

  test("counts each changed line as often as it occurs, per file", () => {
    const before = readPatch(`${HEADER}@@ -1 +1,2 @@\n-x\n+}\n+}\n`);
    const now = readPatch(`${HEADER}@@ -1 +1,4 @@\n-x\n+}\n+}\n+}\n+y\n`);
    expect(linesNotIn(now, before)).toBe(2);
    expect(linesNotIn(before, now)).toBe(0);
  });

  test("the same line in another file is not held", () => {
    const here = readPatch(`${HEADER}@@ -1 +1 @@\n+same\n`);
    const there = readPatch(`${HEADER.replaceAll("src/a.ts", "src/b.ts")}@@ -1 +1 @@\n+same\n`);
    expect(linesNotIn(here, there)).toBe(1);
  });
});
