import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { readDelta } from "../../src/review/delta.ts";
import { scopeOutcome, scopeTriggers } from "../../src/review/scope.ts";
import { DEFAULT_POLICY } from "../../src/review/types.ts";
import { processScratch } from "../helpers/process-tmp.ts";

const steps = Array.from({ length: 10 }, (_, index) => `  prepare(${index});\n`).join("");
const checkout = (charge = "", prefix = "", setup = steps): string =>
  `${prefix}function checkout(allowed) {\n${setup}${charge === "before" ? "  chargeCard();\n" : ""}  if (!allowed) return;\n${charge === "after" ? "  chargeCard();\n" : ""}  finish();\n}\n`;
const lines = (tag: string, count: number): string =>
  Array.from({ length: count }, (_, index) => `export const ${tag}${index} = ${index};\n`).join("");

function fixture() {
  const root = processScratch("ak-delta-");
  const git = (...args: string[]): string => {
    const run = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
    if (run.status !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr}`);
    return run.stdout.trim();
  };
  const commit = (files: Record<string, string>, message: string, ...args: string[]): string => {
    for (const [file, text] of Object.entries(files)) writeFileSync(join(root, file), text);
    git("add", "-A");
    git("commit", "-m", message, ...args);
    return git("rev-parse", "HEAD");
  };
  git("init", "-b", "main");
  git("config", "user.email", "t@example.invalid");
  git("config", "user.name", "T");
  commit({ "a.ts": "", "b.ts": "", "checkout.ts": checkout() }, "base");
  git("checkout", "-b", "pr");
  const delta = (previous: string) =>
    readDelta(root, git("rev-parse", "main"), previous, git("rev-parse", "HEAD")).delta;
  return { git, commit, delta };
}

describe("readDelta locations in the reviewed base (ADR-0018)", () => {
  test.each([
    ["before the function", "\n\n\n\n", steps],
    ["inside the function", "", `  prepareMore();\n${steps}`],
    ["after a base deletion", "", steps.slice(steps.indexOf("\n") + 1)],
  ])(
    "a clean rebase shifted %s keeps the patch",
    (_, prefix, setup) => {
      const f = fixture();
      const previous = f.commit({ "checkout.ts": checkout("after") }, "charge");
      f.git("checkout", "main");
      f.commit({ "checkout.ts": checkout("", prefix, setup) }, "base shifts");
      f.git("checkout", "pr");
      f.git("rebase", "main");
      expect(f.delta(previous)).toMatchObject({ added_lines: 0, removed_lines: 0, rewritten_lines: 0 });
    },
    120_000,
  );
  test("a clean rebase of two commits editing one file keeps every patch", () => {
    const f = fixture();
    f.commit({ "a.ts": lines("base", 20) }, "source lines");
    f.git("checkout", "main");
    f.git("merge", "--ff-only", "pr");
    f.git("checkout", "pr");
    f.commit({ "a.ts": lines("top", 10) + lines("base", 20) }, "add on top");
    const previous = f.commit({ "a.ts": lines("top", 10) + lines("base", 20) + lines("end", 1) }, "append");
    f.git("checkout", "main");
    f.commit({ "b.ts": lines("b", 1) }, "unrelated base change");
    f.git("checkout", "pr");
    f.git("rebase", "main");
    expect(f.delta(previous)).toMatchObject({ empty: true, changed_paths: [], rewritten_lines: 0 });
  }, 120_000);
});

describe("readDelta aggregate rewrite counts (ADR-0018, hand-counted edits)", () => {
  test.each([0, 24, 49].flatMap((position) => [false, true].map((amend) => ({ position, amend }))))(
    "restoring a source line removes two patch entries: %o",
    ({ position, amend }) => {
      const f = fixture();
      f.git("checkout", "main");
      f.commit({ "a.ts": lines("old", 50) }, "source lines");
      f.git("checkout", "pr");
      f.git("rebase", "main");
      const previous = f.commit({ "a.ts": lines("new", 50) }, "replace source lines");
      const restored = lines("new", 50).replace(
        `export const new${position} = ${position};`,
        `export const old${position} = ${position};`,
      );
      f.commit({ "a.ts": restored }, "restore one source line", ...(amend ? ["--amend"] : []));
      const delta = f.delta(previous);
      expect(delta).toMatchObject({
        empty: false,
        pr_lines: 100,
        added_lines: 0,
        removed_lines: 2,
        rewritten_lines: amend ? 2 : 0,
      });
      const triggers = scopeTriggers(
        {
          delta,
          class_rose: false,
          surface_changed: false,
          intent: { before: "same", now: "same" },
          criteria: { before: "same", now: "same" },
        },
        DEFAULT_POLICY,
      );
      expect(triggers.fired).toEqual([]);
      expect(scopeOutcome({ scope: 1, reviewed: true }, triggers, delta, DEFAULT_POLICY)).toBe("closure");
      expect(scopeOutcome({ scope: 2, reviewed: true }, triggers, delta, DEFAULT_POLICY)).toBe("closure");
    },
    120_000,
  );

  test.each([21, 30, 40])(
    "replacing %d of 40 lines counts the replacement, with or without an appended fix",
    (replaced) => {
      const f = fixture();
      f.commit({ "a.ts": lines("a", 60) }, "first change");
      const previous = f.commit({ "b.ts": lines("b", 40) }, "second change");
      f.commit({ "b.ts": lines("b", 40 - replaced) + lines("c", replaced) }, "second change", "--amend");
      expect(f.delta(previous)).toMatchObject({ pr_lines: 100, rewritten_lines: replaced });
      f.commit({ "a.ts": lines("a", 60) + lines("fix", 16) }, "new fix");
      expect(f.delta(previous)).toMatchObject({ pr_lines: 100, rewritten_lines: replaced });
    },
    120_000,
  );

  test("ten 100-line commits squashed with one extra line count one rewritten line", () => {
    const f = fixture();
    let text = "";
    for (let index = 0; index < 10; index += 1) {
      text += lines(`part${index}_`, 100);
      f.commit({ "a.ts": text }, `part ${index}`);
    }
    const previous = f.git("rev-parse", "HEAD");
    f.git("reset", "--soft", "main");
    f.commit({ "a.ts": text + lines("extra", 1) }, "all parts");
    expect(f.delta(previous)).toMatchObject({
      pr_lines: 1000,
      rewritten_lines: 1,
      added_lines: 1,
      removed_lines: 0,
    });
  }, 120_000);

  test("dropping every own commit counts every reviewed line", () => {
    const f = fixture();
    f.commit({ "a.ts": lines("a", 60) }, "first change");
    const previous = f.commit({ "b.ts": lines("b", 40) }, "second change");
    f.git("reset", "--hard", "main");
    expect(f.delta(previous)).toMatchObject({ pr_lines: 100, rewritten_lines: 100, removed_lines: 100 });
  }, 120_000);

  test("dropping a 40-line commit still counts its lines when an unrelated fix follows", () => {
    const f = fixture();
    f.commit({ "a.ts": lines("a", 60) }, "first change");
    const previous = f.commit({ "b.ts": lines("b", 40) }, "second change");
    f.git("reset", "--hard", "HEAD~1");
    f.commit({ "a.ts": lines("a", 60) + lines("fix", 16) }, "second change");
    expect(f.delta(previous)).toMatchObject({
      pr_lines: 100,
      rewritten_lines: 40,
      added_lines: 16,
      removed_lines: 40,
    });
  }, 120_000);

  test("a reviewed modifying fix squashed into its target counts only a new line", () => {
    const f = fixture();
    const first = f.commit({ "a.ts": lines("a", 30) }, "first change");
    const previous = f.commit({ "a.ts": lines("a", 15) + lines("b", 15) }, "fix", "--fixup", first);
    f.git("-c", "sequence.editor=true", "rebase", "-i", "--autosquash", "main");
    f.commit({ "a.ts": lines("a", 15) + lines("b", 15) + lines("extra", 1) }, "first change", "--amend");
    expect(f.delta(previous)).toMatchObject({
      pr_lines: 30,
      rewritten_lines: 1,
      added_lines: 1,
      removed_lines: 0,
    });
  }, 120_000);

  test("a new fix reusing a squashed commit's subject adds no rewritten lines", () => {
    const f = fixture();
    f.commit({ "a.ts": lines("a", 60) }, "first change");
    const previous = f.commit({ "b.ts": lines("b", 10) }, "address review");
    f.git("reset", "--soft", "main");
    f.commit({}, "first change");
    f.commit({ "a.ts": lines("a", 60) + lines("fix", 20) }, "address review");
    expect(f.delta(previous)).toMatchObject({
      pr_lines: 70,
      rewritten_lines: 0,
      added_lines: 20,
      removed_lines: 0,
    });
  }, 120_000);

  test("an amended commit and a later fix can share a subject without counting the later fix", () => {
    const f = fixture();
    f.commit({ "a.ts": lines("a", 60) }, "first change");
    const previous = f.commit({ "b.ts": lines("b", 3) }, "address review");
    f.commit({ "b.ts": lines("b", 4) }, "address review", "--amend");
    f.commit({ "a.ts": lines("a", 60) + lines("fix", 20) }, "address review");
    expect(f.delta(previous)).toMatchObject({
      pr_lines: 63,
      rewritten_lines: 1,
      added_lines: 21,
      removed_lines: 0,
    });
  }, 120_000);
});
