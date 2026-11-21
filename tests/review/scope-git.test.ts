/**
 * `ak review scope` against fixture repositories (ADR-0018): one repository
 * per full-re-review trigger and one per non-trigger.
 *
 * Each expected value has a source other than the code under test. The
 * trigger and the non-trigger come from the plan's trigger table. A changed
 * line count comes from `git diff --numstat`. A rewritten commit comes from
 * `git range-diff`. A conflict comes from the exit status of the `git merge`
 * that builds the fixture.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { describe, expect, test } from "bun:test";

import validProject from "../fixtures/delegation/valid.project.json" with { type: "json" };
import validTicket from "../fixtures/delegation/valid.ticket.json" with { type: "json" };
import { runCli } from "../../src/cli.ts";
import { runReview } from "../../src/review/cli.ts";
import { parseJson, type JsonValue } from "../helpers/json.ts";
import { processScratch } from "../helpers/process-tmp.ts";

const NOTE = "This record grants no authority. It approves no checkpoint, ticket, merge or deploy.";

/** `count` lines that no other call with another `tag` produces. */
function lines(tag: string, count: number): string {
  return Array.from({ length: count }, (_, index) => `export const ${tag}${index} = ${index};\n`).join("");
}

interface Run {
  code: number;
  out: string[];
  err: string[];
}

function review(argv: string[], stdin = ""): Run {
  const out: string[] = [];
  const err: string[] = [];
  const code = runReview(argv, { out: (line) => out.push(line), err: (line) => err.push(line), stdin: () => stdin });
  return { code, out, err };
}

/** The member of a JSON object, or null where the value is not an object or lacks it. */
function member(value: JsonValue, key: string): JsonValue {
  return value instanceof Object && !Array.isArray(value) ? (value[key] ?? null) : null;
}

/**
 * A repository with a base branch `main` and a pull request branch `pr`, and
 * a ledger beside it. The pull request starts with two commits: 30 changed
 * lines in `src/a.ts` and 20 in `src/b.ts`.
 */
function fixture() {
  const dir = processScratch("ak-review-scope-");
  const root = join(dir, "repo");
  const ledger = join(dir, "ledger.jsonl");
  mkdirSync(root);
  const tryGit = (...args: string[]) => spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
  const git = (...args: string[]): string => {
    const run = tryGit(...args);
    if (run.status !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr}`);
    return run.stdout.trim();
  };
  const write = (files: Record<string, string>): void => {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    }
  };
  const commit = (files: Record<string, string>, message: string): string => {
    write(files);
    git("add", "-A");
    git("commit", "-m", message);
    return git("rev-parse", "HEAD");
  };
  git("init", "-b", "main", ".");
  git("config", "user.email", "t@example.invalid");
  git("config", "user.name", "T");
  commit({ "src/a.ts": lines("a", 10), "src/b.ts": lines("b", 10), "src/main.ts": lines("m", 10) }, "base");
  git("checkout", "-b", "pr");
  commit({ "src/a.ts": lines("a", 10) + lines("first", 30) }, "first change");
  const head = commit({ "src/b.ts": lines("b", 10) + lines("second", 20) }, "second change");

  /** Changed lines between two commits by git's own count. */
  const numstat = (from: string, to: string): number =>
    git("diff", "--numstat", "--no-renames", from, to)
      .split("\n")
      .reduce((sum, row) => {
        const [added, removed] = row.split("\t");
        return sum + Number(added) + Number(removed);
      }, 0);
  const add = (...events: object[]): void => {
    const added = review(["ledger", "add", "--ledger", ledger, "--event", "-"], JSON.stringify(events));
    if (added.code !== 0) throw new Error(added.err.join("\n"));
  };
  /** The scope record a caller last kept, and its head. */
  let kept: { path: string; at: string } | null = null;
  const scope = (at: string, ...flags: string[]): Run =>
    review(["scope", "--ledger", ledger, "--repo", root, "--base", "main", "--head", at, ...flags]);
  /** The record of a run that must exit 0. Without `--previous`, it passes the record kept last. */
  const record = (at: string, ...flags: string[]): JsonValue => {
    const previous = flags.includes("--previous") || kept === null ? [] : ["--previous", kept.path];
    const run = scope(at, ...flags, ...previous);
    expect({ code: run.code, err: run.err }).toEqual({ code: 0, err: [] });
    return parseJson(run.out[0] ?? "");
  };
  /** Write the scope record of `at` to a file, as a caller keeps it for the next round. */
  const keep = (name: string, at: string, ...flags: string[]): string => {
    const path = join(dir, name);
    writeFileSync(path, JSON.stringify(record(at, ...flags)));
    kept = { path, at };
    return path;
  };
  /** Record one closed round of review at `at`, keeping the scope record of `at` first unless one is kept. */
  const round = (at: string): void => {
    if (kept?.at !== at) keep(`scope-${at}.json`, at);
    add({ kind: "round-open", head: at }, { kind: "verdict", seat: "a", word: "approve" }, { kind: "round-close" });
  };
  const file = (name: string, text: string): string => {
    writeFileSync(join(dir, name), text);
    return join(dir, name);
  };
  return { dir, root, ledger, head, git, tryGit, write, commit, numstat, add, round, scope, record, keep, file };
}

describe("ak review scope before round 1", () => {
  test("says the whole change is reviewed and reads the pull request at the head", () => {
    const f = fixture();
    const base = f.git("merge-base", "main", f.head);
    expect(f.record(f.head)).toMatchObject({
      schema: "review-scope",
      schema_version: 1,
      ledger: { path: f.ledger, lines: 0 },
      scope: 1,
      reviewed: null,
      head: f.head,
      outcome: "full",
      triggers: [],
      unevaluated: [],
      pull_request: { head: f.head, merge_base: base, lines: f.numstat(base, f.head) },
      previous: null,
      delta: null,
      event: null,
      grants: [],
      note: NOTE,
    });
  });

  test("reads --head as a revision and records the full commit id", () => {
    const f = fixture();
    expect(member(f.record("pr"), "head")).toBe(f.head);
  });

  test("with --out it writes the record owner-only and prints one line", () => {
    const f = fixture();
    const out = join(f.dir, "scope.json");
    const run = f.scope(f.head, "--out", out);
    expect(run).toEqual({ code: 0, out: [`review scope outcome=full triggers=none unevaluated=0: ${out}`], err: [] });
    expect(statSync(out).mode & 0o777).toBe(0o600);
    expect(parseJson(readFileSync(out, "utf8"))).toMatchObject({ schema: "review-scope", outcome: "full" });
  });

  test("appends nothing to the ledger", () => {
    const f = fixture();
    f.round(f.head);
    const before = readFileSync(f.ledger, "utf8");
    f.record(f.commit({ "src/a.ts": lines("a", 10) + lines("first", 30) + lines("fix", 2) }, "fix"));
    expect(readFileSync(f.ledger, "utf8")).toBe(before);
  });
});

describe("ak review scope: what is not a trigger", () => {
  test("a fix commit gets a closure round", () => {
    const f = fixture();
    f.round(f.head);
    const fix = f.commit({ "src/a.ts": lines("a", 10) + lines("first", 30) + lines("fix", 3) }, "fix a finding");
    const base = f.git("merge-base", "main", fix);
    expect(f.record(fix)).toMatchObject({
      reviewed: f.head,
      outcome: "closure",
      triggers: [],
      pull_request: { lines: f.numstat(base, fix) },
      previous: { head: f.head, lines: f.numstat(base, f.head) },
      delta: {
        empty: false,
        pr_lines: f.numstat(base, f.head),
        added_lines: f.numstat(f.head, fix),
        removed_lines: 0,
        rewritten_lines: 0,
        conflict_paths: [],
      },
      event: null,
    });
  });

  test("a rebase that leaves the patches unchanged carries the review, and the ledger takes the carry", () => {
    const f = fixture();
    f.round(f.head);
    const base = f.git("rev-parse", "main");
    f.git("checkout", "main");
    f.commit({ "src/main.ts": lines("m", 10) + lines("moved", 5) }, "main moves");
    f.git("checkout", "pr");
    f.git("rebase", "main");
    const rebased = f.git("rev-parse", "HEAD");
    expect(rebased).not.toBe(f.head);
    // git's own comparison: both commits kept their patch.
    expect(f.git("range-diff", "-s", `${base}..${f.head}`, `main..${rebased}`).split("\n")).toEqual([
      expect.stringContaining(" = "),
      expect.stringContaining(" = "),
    ]);
    const scoped = parseJson(readFileSync(f.keep("carry.json", rebased), "utf8"));
    expect(scoped).toMatchObject({
      outcome: "carry",
      triggers: [],
      delta: { empty: true, added_lines: 0, removed_lines: 0, rewritten_lines: 0 },
      event: { kind: "carry", head: rebased },
    });
    f.add(Object(member(scoped, "event")));
    expect(f.record(rebased)).toMatchObject({ reviewed: rebased, outcome: "carry", event: null });
  });

  test("a merge of the base branch with no conflict in the pull request's paths carries the review", () => {
    const f = fixture();
    f.round(f.head);
    f.git("checkout", "main");
    f.commit({ "src/main.ts": lines("m", 10) + lines("moved", 5) }, "main moves");
    f.git("checkout", "pr");
    f.git("merge", "--no-ff", "-m", "merge main", "main");
    const merged = f.git("rev-parse", "HEAD");
    expect(f.record(merged)).toMatchObject({
      outcome: "carry",
      triggers: [],
      delta: { empty: true, conflict_paths: [] },
      event: { kind: "carry", head: merged },
    });
  });

  test("the last round of the cap is a closure round like any other", () => {
    const f = fixture();
    f.round(f.head);
    const second = f.commit({ "src/a.ts": lines("a", 10) + lines("first", 30) + lines("fix", 2) }, "fix");
    f.round(second);
    const third = f.commit({ "src/a.ts": lines("a", 10) + lines("first", 30) + lines("fix", 4) }, "fix again");
    f.round(third);
    const fourth = f.commit(
      { "src/a.ts": lines("a", 10) + lines("first", 30) + lines("fix", 6) },
      "a fix past the cap",
    );
    expect(f.record(fourth)).toMatchObject({ scope: 1, reviewed: third, outcome: "closure", triggers: [] });
  });

  type Fixture = ReturnType<typeof fixture>;
  /** Fold a commit that writes `files` into `target` with `--fixup` and `--autosquash`. */
  const fold = (f: Fixture, target: string, files: Record<string, string>): void => {
    f.write(files);
    f.git("add", "-A");
    f.git("commit", "--fixup", target);
    f.git("-c", "sequence.editor=true", "rebase", "-i", "--autosquash", "main");
  };
  const tip = (f: Fixture): string => f.git("rev-parse", "HEAD");
  const rows: [
    string,
    (f: Fixture) => string,
    { pr_lines: number; rewritten_lines: number; outcome: string; triggers: string[] },
  ][] = [
    [
      "a 30-line commit amended in place, one line replaced",
      (f) => {
        f.round(f.head);
        fold(f, `${f.head}~1`, { "src/a.ts": lines("a", 10) + lines("first", 29) + lines("other", 1) });
        return tip(f);
      },
      // first29 left and other0 came in: 1 of 50.
      { pr_lines: 50, rewritten_lines: 1, outcome: "closure", triggers: [] },
    ],
    [
      "a reviewed 15-line fix commit squashed into its 20-line commit, plus one new line",
      (f) => {
        f.round(f.head);
        f.round(f.commit({ "src/b.ts": lines("b", 10) + lines("second", 20) + lines("fix", 15) }, "fix a finding"));
        f.git("reset", "--soft", f.head);
        f.write({ "src/b.ts": lines("b", 10) + lines("second", 20) + lines("fix", 16) });
        f.git("add", "-A");
        f.git("commit", "--amend", "--no-edit");
        return tip(f);
      },
      // 50 + 15 reviewed lines all stay, and fix15 came in: 1 of 65.
      { pr_lines: 65, rewritten_lines: 1, outcome: "closure", triggers: [] },
    ],
    [
      "a same-subject commit amended by one line, then a new commit reusing the subject",
      (f) => {
        f.round(f.commit({ "src/main.ts": lines("m", 10) + lines("review", 3) }, "address review"));
        f.write({ "src/main.ts": lines("m", 10) + lines("review", 4) });
        f.git("add", "-A");
        f.git("commit", "--amend", "--no-edit");
        return f.commit({ "src/a.ts": lines("a", 10) + lines("first", 30) + lines("more", 16) }, "address review");
      },
      // review3 came in: 1 of 53. The 16 new lines are 30.2% of 53 if they counted, and the delta adds 17, 32%.
      { pr_lines: 53, rewritten_lines: 1, outcome: "closure", triggers: [] },
    ],
    [
      "a 20-line commit reworded while one line is replaced",
      (f) => {
        f.round(f.head);
        f.write({ "src/b.ts": lines("b", 10) + lines("second", 19) + lines("other", 1) });
        f.git("add", "-A");
        f.git("commit", "--amend", "-m", "second change, reworded");
        return tip(f);
      },
      // second19 left and other0 came in: 1 of 50.
      { pr_lines: 50, rewritten_lines: 1, outcome: "closure", triggers: [] },
    ],
    [
      "a reworded commit with the same patch",
      (f) => {
        f.round(f.head);
        f.git("commit", "--amend", "-m", "second change, reworded");
        return tip(f);
      },
      // Both commits keep their patch: nothing is rewritten.
      { pr_lines: 50, rewritten_lines: 0, outcome: "carry", triggers: [] },
    ],
    [
      "a squash of the own commits with the same patch",
      (f) => {
        f.round(f.head);
        f.git("reset", "--soft", "main");
        f.git("commit", "-m", "one commit");
        return tip(f);
      },
      // The one commit holds the same 50 lines: none moved.
      { pr_lines: 50, rewritten_lines: 0, outcome: "carry", triggers: [] },
    ],
    [
      "a reviewed commit dropped, its lines nowhere at the new head",
      (f) => {
        f.round(f.head);
        f.git("reset", "--hard", `${f.head}~1`);
        return tip(f);
      },
      // The 20 lines of the second commit left: 20 of 50, 40%.
      { pr_lines: 50, rewritten_lines: 20, outcome: "new-scope", triggers: ["large-rebase"] },
    ],
    [
      "a 30-line commit with 20 lines replaced, followed by a kept commit",
      (f) => {
        f.round(f.head);
        fold(f, `${f.head}~1`, { "src/a.ts": lines("a", 10) + lines("first", 10) + lines("other", 20) });
        return tip(f);
      },
      // first10..first29 left and other0..other19 came in: 20 of 50, 40%.
      { pr_lines: 50, rewritten_lines: 20, outcome: "new-scope", triggers: ["large-rebase"] },
    ],
    [
      "a reviewed fix commit squashed away, then a new commit reusing its subject",
      (f) => {
        f.round(f.head);
        f.round(f.commit({ "src/main.ts": lines("m", 10) + lines("review", 10) }, "address review"));
        f.git("reset", "--soft", f.head);
        f.git("commit", "--amend", "--no-edit");
        return f.commit({ "src/a.ts": lines("a", 10) + lines("first", 30) + lines("more", 20) }, "address review");
      },
      // The 60 reviewed lines all stay. The 20 new lines are 33% of 60 if they counted, and the delta adds 33%.
      { pr_lines: 60, rewritten_lines: 0, outcome: "closure", triggers: [] },
    ],
    [
      "a reviewed fix commit that replaced 15 of 30 lines, autosquashed with one new line",
      (f) => {
        const third = f.commit({ "src/main.ts": lines("m", 10) + lines("third", 30) }, "third change");
        f.round(third);
        f.write({ "src/main.ts": lines("m", 10) + lines("third", 15) + lines("other", 15) });
        f.git("add", "-A");
        f.git("commit", "--fixup", third);
        f.round(tip(f));
        fold(f, third, { "src/main.ts": lines("m", 10) + lines("third", 15) + lines("other", 15) + lines("new", 1) });
        return tip(f);
      },
      // The reviewed pull request holds 50 + third0..14 + other0..14 = 80 lines, and only new0 came in: 1.
      // Adding up the commits would count third15..29 twice, added and removed: 30 of 80, 37.5%.
      { pr_lines: 80, rewritten_lines: 1, outcome: "closure", triggers: [] },
    ],
    [
      "a 30-line commit amended with one line replaced, then a new commit removing 12 of its lines",
      (f) => {
        f.round(f.head);
        fold(f, `${f.head}~1`, { "src/a.ts": lines("a", 10) + lines("first", 29) + lines("other", 1) });
        return f.commit({ "src/a.ts": lines("a", 10) + lines("first", 17) + lines("other", 1) }, "trim");
      },
      // first29 left and other0 came in: 1. The removal of first17..first28 comes after the cut.
      { pr_lines: 50, rewritten_lines: 1, outcome: "closure", triggers: [] },
    ],
  ];
  test.each(rows)("%s", (_, build, expected) => {
    const f = fixture();
    const { outcome, triggers, ...delta } = expected;
    expect(f.record(build(f))).toMatchObject({ outcome, triggers, delta });
  });
});

describe("ak review scope: large rebase", () => {
  test("a rebase whose rewritten commits changed more than 30% of the lines opens a new scope", () => {
    const f = fixture();
    f.round(f.head);
    f.git("reset", "--hard", "HEAD~1");
    const rewritten = f.commit({ "src/b.ts": lines("b", 10) + lines("other", 20) }, "second change");
    // git's own comparison: the first commit is unchanged, and no commit of the new head keeps the second.
    const pairs = f.git("range-diff", "-s", `main...${f.head}`, `main..${rewritten}`).split("\n");
    expect(pairs.filter((pair) => pair.includes(" = "))).toEqual([expect.stringMatching(/^1: .* = 1: /)]);
    const base = f.git("merge-base", "main", f.head);
    const second = f.numstat(`${f.head}~1`, f.head);
    const scoped = f.record(rewritten);
    // The rewrite changed all 20 lines of the second commit, 40% of the 50. The delta adds 20 lines: 40%.
    expect(scoped).toMatchObject({
      outcome: "new-scope",
      triggers: ["large-rebase"],
      delta: {
        empty: false,
        pr_lines: f.numstat(base, f.head),
        rewritten_lines: second,
        added_lines: 20,
        removed_lines: 20,
      },
      event: { kind: "scope-open", trigger: "large-rebase", head: rewritten },
    });
    expect(second).toBe(20);
    f.add(Object(member(scoped, "event")));
    expect(f.record(rewritten)).toMatchObject({ scope: 2, reviewed: null, outcome: "full", delta: null });
  });

  test("a merge that resolved a conflict in a path of the pull request opens a new scope", () => {
    const f = fixture();
    f.round(f.head);
    f.git("checkout", "main");
    f.commit(
      { "src/a.ts": lines("a", 10) + lines("theirs", 2), "src/main.ts": lines("m", 10) + lines("moved", 1) },
      "main",
    );
    f.git("checkout", "pr");
    // The merge that builds the fixture is the oracle: git stops on a conflict in src/a.ts.
    expect(f.tryGit("merge", "--no-ff", "-m", "merge main", "main").status).toBe(1);
    expect(f.git("diff", "--name-only", "--diff-filter=U")).toBe("src/a.ts");
    const merged = f.commit({ "src/a.ts": lines("a", 10) + lines("theirs", 2) + lines("first", 30) }, "merge main");
    const scoped = f.record(merged);
    expect(scoped).toMatchObject({
      outcome: "new-scope",
      triggers: ["large-rebase"],
      delta: { conflict_paths: ["src/a.ts"] },
      event: { kind: "scope-open", trigger: "large-rebase", head: merged },
    });
    // Once a round has reviewed the merge, it is not new: a fix after it is a closure round.
    f.add(Object(member(scoped, "event")));
    f.round(merged);
    const fixed = f.commit({ "src/b.ts": lines("b", 20) + lines("fix", 1) }, "fix");
    expect(f.record(fixed)).toMatchObject({
      scope: 2,
      outcome: "closure",
      triggers: [],
      delta: { conflict_paths: [] },
    });
  });
});

describe("ak review scope: scope growth", () => {
  test("a delta that adds more than 50% to the pull request's lines opens a new scope", () => {
    const f = fixture();
    f.round(f.head);
    const grown = f.commit({ "src/main.ts": lines("m", 10) + lines("more", 26) }, "more work");
    const base = f.git("merge-base", "main", f.head);
    // 26 lines on a pull request of 50: 52%.
    expect(f.record(grown)).toMatchObject({
      outcome: "new-scope",
      triggers: ["scope-growth"],
      delta: { pr_lines: f.numstat(base, f.head), added_lines: f.numstat(f.head, grown) },
    });
  });

  test("a delta that adds exactly 50% does not", () => {
    const f = fixture();
    f.round(f.head);
    const grown = f.commit({ "src/main.ts": lines("m", 10) + lines("more", 25) }, "more work");
    expect(f.record(grown)).toMatchObject({ outcome: "closure", triggers: [], delta: { added_lines: 25 } });
  });

  test("a delta that adds more than 400 lines opens a new scope at any share", () => {
    const f = fixture();
    const large = f.commit({ "src/large.ts": lines("large", 1000) }, "a large change");
    f.round(large);
    const even = f.commit({ "src/more.ts": lines("more", 400) }, "400 more lines");
    expect(f.record(even)).toMatchObject({ outcome: "closure", triggers: [], delta: { added_lines: 400 } });
    const over = f.commit({ "src/more.ts": lines("more", 401) }, "one more line");
    expect(f.numstat(large, over)).toBe(401);
    // 401 lines on a pull request of 1050: 38%.
    expect(f.record(over)).toMatchObject({
      outcome: "new-scope",
      triggers: ["scope-growth"],
      delta: { added_lines: 401 },
    });
  });

  test("a changed intent file opens a new scope, and an unchanged one does not", () => {
    const f = fixture();
    const intent = f.file("intent.txt", "Add the two exports.\n");
    const kept = f.keep("round-1.json", f.head, "--intent", intent);
    f.round(f.head);
    const fix = f.commit({ "src/a.ts": lines("a", 10) + lines("first", 30) + lines("fix", 1) }, "fix");
    expect(f.record(fix, "--previous", kept, "--intent", intent)).toMatchObject({ outcome: "closure", triggers: [] });
    const changed = f.file("intent-2.txt", "Add the two exports and a third.\n");
    expect(f.record(fix, "--previous", kept, "--intent", changed)).toMatchObject({
      outcome: "new-scope",
      triggers: ["scope-growth"],
      reasons: ["the intent file changed"],
    });
  });
});

describe("ak review scope: requirement change", () => {
  test("changed acceptance criteria open a new scope, and unchanged ones do not", () => {
    const f = fixture();
    const criteria = f.file("criteria.json", JSON.stringify(["AC1: both exports exist"]));
    const kept = f.keep("round-1.json", f.head, "--criteria", criteria);
    f.round(f.head);
    const fix = f.commit({ "src/a.ts": lines("a", 10) + lines("first", 30) + lines("fix", 1) }, "fix");
    expect(f.record(fix, "--previous", kept, "--criteria", criteria)).toMatchObject({
      outcome: "closure",
      triggers: [],
    });
    const changed = f.file("criteria-2.json", JSON.stringify(["AC1: both exports exist", "AC2: a third"]));
    expect(f.record(fix, "--previous", kept, "--criteria", changed)).toMatchObject({
      outcome: "new-scope",
      triggers: ["requirement-change"],
      event: { kind: "scope-open", trigger: "requirement-change", head: fix },
    });
  });
});

/** A fixture whose project record declares `src/shared/**` a red shared surface, with the merge-stage command. */
function delegationFixture() {
  const f = fixture();
  const project = {
    ...validProject,
    guidance: {
      ...validProject.guidance,
      delegation: {
        ...validProject.guidance.delegation,
        shared_surfaces: [{ path: "src/shared/**", class: "red", reason: "Every feature imports the shared helpers." }],
      },
    },
  };
  f.file("ticket.json", JSON.stringify(validTicket));
  f.file("project.json", JSON.stringify(project));
  /** Run `ak delegation --stage merge` at `at` and keep the record it prints. */
  const merge = (name: string, at: string, ...flags: string[]): string => {
    const out: string[] = [];
    const err: string[] = [];
    const code = runCli(
      [
        "delegation",
        join(f.dir, "ticket.json"),
        "--project",
        join(f.dir, "project.json"),
        "--stage",
        "merge",
        "--base",
        "main",
        "--head",
        at,
        ...flags,
      ],
      { cwd: f.root, io: { out: (line) => out.push(line), err: (line) => err.push(line) } },
    );
    expect({ code, err }).toEqual({ code: 0, err: [] });
    return f.file(name, out.join("\n"));
  };
  return { ...f, merge };
}

describe("ak review scope: risk tier and review surface", () => {
  test("a delta that newly touches a shared surface raises the class and opens a new scope", () => {
    const f = delegationFixture();
    const first = f.merge("merge-1.json", f.head);
    const kept = f.keep("round-1.json", f.head, "--record", first);
    f.round(f.head);
    const touched = f.commit({ "src/shared/util.ts": lines("shared", 2) }, "touch the shared helper");
    const second = f.merge("merge-2.json", touched, "--previous", first);
    const before = parseJson(readFileSync(first, "utf8"));
    const now = parseJson(readFileSync(second, "utf8"));
    // The merge-stage command is the oracle for the class and for the surface.
    expect([member(before, "class"), member(now, "class")]).toEqual(["yellow-agent", "red"]);
    expect(member(now, "review_surface_changed")).toBe(true);
    expect(f.record(touched, "--previous", kept, "--record", second)).toMatchObject({
      outcome: "new-scope",
      triggers: ["risk-tier-rise", "surface-changed"],
      unevaluated: [{ trigger: "scope-growth" }, { trigger: "requirement-change" }],
      class: "red",
      review_surface_changed: true,
      event: { kind: "scope-open", trigger: "risk-tier-rise", head: touched },
    });
  });

  test("the same class and no new surface open nothing", () => {
    const f = delegationFixture();
    const first = f.merge("merge-1.json", f.head);
    const kept = f.keep("round-1.json", f.head, "--record", first);
    f.round(f.head);
    const fix = f.commit({ "src/a.ts": lines("a", 10) + lines("first", 30) + lines("fix", 1) }, "fix");
    const second = f.merge("merge-2.json", fix, "--previous", first);
    expect(f.record(fix, "--previous", kept, "--record", second)).toMatchObject({
      outcome: "closure",
      triggers: [],
      class: "yellow-agent",
      review_surface_changed: false,
    });
  });

  test("a merge-stage record computed without the last round's record leaves the surface unevaluated", () => {
    const f = delegationFixture();
    const first = f.merge("merge-1.json", f.head);
    const kept = f.keep("round-1.json", f.head, "--record", first);
    f.round(f.head);
    const touched = f.commit({ "src/shared/util.ts": lines("shared", 2) }, "touch the shared helper");
    const alone = f.merge("merge-2.json", touched);
    expect(f.record(touched, "--previous", kept, "--record", alone)).toMatchObject({
      triggers: ["risk-tier-rise"],
      unevaluated: [{ trigger: "surface-changed" }, { trigger: "scope-growth" }, { trigger: "requirement-change" }],
      review_surface_changed: null,
    });
  });
});

describe("ak review scope: the scope count", () => {
  test("a pull request opens one new scope, and a second trigger holds it", () => {
    const f = fixture();
    f.round(f.head);
    const grown = f.commit({ "src/main.ts": lines("m", 10) + lines("more", 40) }, "more work");
    const first = f.record(grown);
    expect(first).toMatchObject({ scope: 1, outcome: "new-scope" });
    f.add(Object(member(first, "event")));
    f.round(grown);
    const again = f.commit({ "src/again.ts": lines("again", 80) }, "still more work");
    expect(f.record(again)).toMatchObject({
      scope: 2,
      reviewed: grown,
      outcome: "hold",
      triggers: ["scope-growth"],
      event: null,
    });
    f.git("reset", "--hard", grown);
    const small = f.commit({ "src/main.ts": lines("m", 10) + lines("more", 41) }, "a fix in the second scope");
    expect(f.record(small)).toMatchObject({ scope: 2, outcome: "closure", triggers: [] });
  });
});

describe("ak review scope: without the last round's record", () => {
  test("the git triggers are evaluated and the other three are listed as unevaluated", () => {
    const f = fixture();
    f.round(f.head);
    const fix = f.commit({ "src/a.ts": lines("a", 10) + lines("first", 30) + lines("fix", 1) }, "fix");
    expect(f.record(fix)).toMatchObject({
      outcome: "closure",
      triggers: [],
      unevaluated: [
        { trigger: "risk-tier-rise" },
        { trigger: "surface-changed" },
        { trigger: "scope-growth" },
        { trigger: "requirement-change" },
      ],
      class: null,
      intent: null,
      criteria: null,
    });
  });
});

describe("ak review scope refuses", () => {
  test("a round that is still open", () => {
    const f = fixture();
    f.add({ kind: "round-open", head: f.head });
    const run = f.scope(f.head);
    expect({ code: run.code, out: run.out }).toEqual({ code: 2, out: [] });
    expect(run.err.join("\n")).toContain("round 1 of scope 1 is open");
  });

  test("a ledger with a line the fold refuses", () => {
    const f = fixture();
    // A carry with no closed round: `ledger add` refuses it, so the line is written by hand.
    writeFileSync(f.ledger, `${JSON.stringify({ v: 1, seq: 1, kind: "carry", head: f.head })}\n`);
    const run = f.scope(f.head);
    expect({ code: run.code, out: run.out }).toEqual({ code: 2, out: [] });
    expect(run.err.join("\n")).toContain("the ledger has refused lines: line 1 (carry)");
  });

  test("a revision that is not a commit", () => {
    const f = fixture();
    const run = f.scope("no-such-branch");
    expect({ code: run.code, out: run.out }).toEqual({ code: 2, out: [] });
    expect(run.err.join("\n")).toContain("--head no-such-branch is not a commit");
  });

  test("a last reviewed head the repository does not hold", () => {
    const f = fixture();
    const absent = "f".repeat(40);
    f.add(
      { kind: "round-open", head: absent },
      { kind: "verdict", seat: "a", word: "approve" },
      { kind: "round-close" },
    );
    const kept = f.file(
      "absent.json",
      JSON.stringify({
        schema: "review-scope",
        schema_version: 1,
        head: absent,
        class: null,
        intent: null,
        criteria: null,
        review_surface_changed: null,
      }),
    );
    const run = f.scope(f.head, "--previous", kept);
    expect({ code: run.code, out: run.out }).toEqual({ code: 2, out: [] });
    expect(run.err.join("\n")).toContain(`the last reviewed head ${"f".repeat(40)} is not a commit`);
  });

  test("a run without --previous when the ledger holds a reviewed round", () => {
    const f = fixture();
    f.round(f.head);
    const fix = f.commit({ "src/a.ts": lines("a", 10) + lines("first", 30) + lines("fix", 1) }, "fix");
    const run = f.scope(fix);
    expect({ code: run.code, out: run.out }).toEqual({ code: 2, out: [] });
    expect(run.err.join("\n")).toContain(`--previous is required: the ledger holds a reviewed round at ${f.head}`);
  });

  test("a record of another head as the last round's record", () => {
    const f = fixture();
    const kept = f.keep("round-1.json", f.head);
    const second = f.commit({ "src/a.ts": lines("a", 10) + lines("first", 30) + lines("fix", 1) }, "fix");
    f.round(second);
    const third = f.commit({ "src/a.ts": lines("a", 10) + lines("first", 30) + lines("fix", 2) }, "fix again");
    const run = f.scope(third, "--previous", kept);
    expect({ code: run.code, out: run.out }).toEqual({ code: 2, out: [] });
    expect(run.err.join("\n")).toContain(`the last reviewed head is ${second}`);
  });

  test("a file that is not a scope record as the last round's record", () => {
    const f = fixture();
    f.round(f.head);
    const run = f.scope(f.head, "--previous", f.file("other.json", JSON.stringify({ schema: "review-decision" })));
    expect({ code: run.code, out: run.out }).toEqual({ code: 2, out: [] });
    expect(run.err.join("\n")).toContain("is not a record of ak review scope");
  });

  test.each([
    ["--intent", "intent.txt"],
    ["--criteria", "criteria.json"],
  ])("a run without %s when the last round's record holds its value", (flag, name) => {
    const f = fixture();
    const kept = f.keep("round-1.json", f.head, flag, f.file(name, "one\n"));
    f.round(f.head);
    const run = f.scope(f.head, "--previous", kept);
    expect({ code: run.code, out: run.out }).toEqual({ code: 2, out: [] });
    expect(run.err.join("\n")).toContain(`${flag} is required`);
  });

  test("a run without --record when the last round's record holds a class", () => {
    const f = delegationFixture();
    const kept = f.keep("round-1.json", f.head, "--record", f.merge("merge-1.json", f.head));
    f.round(f.head);
    const run = f.scope(f.head, "--previous", kept);
    expect({ code: run.code, out: run.out }).toEqual({ code: 2, out: [] });
    expect(run.err.join("\n")).toContain("--record is required");
  });

  test("a --record without review_surface_changed when the last round's record holds it", () => {
    const f = delegationFixture();
    const first = f.merge("merge-1.json", f.head);
    const one = f.keep("round-1.json", f.head, "--record", first);
    f.round(f.head);
    const fix = f.commit({ "src/a.ts": lines("a", 10) + lines("first", 30) + lines("fix", 1) }, "fix");
    const second = f.merge("merge-2.json", fix, "--previous", first);
    const kept = f.keep("round-2.json", fix, "--previous", one, "--record", second);
    f.round(fix);
    const touched = f.commit({ "src/shared/util.ts": lines("shared", 2) }, "touch the shared helper");
    const run = f.scope(touched, "--previous", kept, "--record", f.merge("merge-3.json", touched));
    expect({ code: run.code, out: run.out }).toEqual({ code: 2, out: [] });
    expect(run.err.join("\n")).toContain("--record must state review_surface_changed");
  });

  test.each(["--intent", "--criteria"])("a %s file that does not exist", (flag) => {
    const f = fixture();
    const absent = join(f.dir, "absent.txt");
    const run = f.scope(f.head, flag, absent);
    expect({ code: run.code, out: run.out }).toEqual({ code: 2, out: [] });
    expect(run.err.join("\n")).toContain(`${flag} ${absent} does not exist`);
  });

  test("a last round's record that does not exist, and one that is not JSON", () => {
    const f = fixture();
    f.round(f.head);
    const absent = join(f.dir, "absent.json");
    const missing = f.scope(f.head, "--previous", absent);
    expect({ code: missing.code, out: missing.out }).toEqual({ code: 2, out: [] });
    expect(missing.err.join("\n")).toContain(`--previous ${absent} does not exist`);
    const broken = f.scope(f.head, "--previous", f.file("broken.json", "{"));
    expect({ code: broken.code, out: broken.out }).toEqual({ code: 2, out: [] });
    expect(broken.err.join("\n")).toContain("is not JSON");
  });

  test("a missing flag and an unknown flag", () => {
    const f = fixture();
    const missing = review(["scope", "--ledger", f.ledger, "--base", "main"]);
    expect({ code: missing.code, out: missing.out }).toEqual({ code: 2, out: [] });
    const unknown = f.scope(f.head, "--force", "yes");
    expect({ code: unknown.code, out: unknown.out }).toEqual({ code: 2, out: [] });
  });
});
