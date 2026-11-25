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
  const add = (...events: JsonValue[]): void => {
    const only = events.length === 1 ? (events[0] ?? null) : null;
    const payload = member(only, "schema") === "review-scope" && only !== null ? only : events;
    const previous =
      member(only, "schema") === "review-scope" && reviewedKeep !== null ? ["--previous", reviewedKeep.path] : [];
    const added = review(
      ["ledger", "add", "--ledger", ledger, "--event", "-", "--repo", root, ...previous],
      JSON.stringify(payload),
    );
    if (added.code !== 0) throw new Error(added.err.join("\n"));
  };
  /** The scope record a caller last kept, and its head. */
  let kept: { path: string; at: string } | null = null;
  /** The scope record of the last closed round. */
  let reviewedKeep: { path: string; at: string } | null = null;
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
    reviewedKeep = kept;
    add({ kind: "round-open", head: at }, { kind: "verdict", seat: "a", word: "approve" }, { kind: "round-close" });
  };
  const decide = (at: string): Run => review(["decide", "--ledger", ledger, "--head", at, "--seats", "1"]);
  const file = (name: string, text: string): string => {
    writeFileSync(join(dir, name), text);
    return join(dir, name);
  };
  return {
    dir,
    root,
    ledger,
    head,
    git,
    tryGit,
    write,
    commit,
    numstat,
    add,
    round,
    scope,
    record,
    keep,
    file,
    decide,
    reviewed: (): { path: string; at: string } => {
      if (reviewedKeep === null) throw new Error("no reviewed scope record");
      return reviewedKeep;
    },
  };
}

/** Reviewed R, dirty, then B, then an empty H whose tree is B's. */
function between(f: ReturnType<typeof fixture>) {
  f.round(f.head);
  f.commit({ "src/a.ts": lines("a", 10) + lines("first", 30) + lines("fix", 1) }, "dirty");
  const B = f.commit({ "src/extra.ts": "between\n" }, "B");
  f.git("commit", "--allow-empty", "-m", "H empty on B");
  const H = f.git("rev-parse", "HEAD");
  expect(f.git("merge-base", B, f.head)).toBe(f.head);
  expect(f.git("rev-parse", `${B}^{tree}`)).toBe(f.git("rev-parse", `${H}^{tree}`));
  return { B, H };
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

describe("ak review scope: later-round tree identity", () => {
  test("a mode-only change after round 1 is closure with at least one added line", () => {
    const f = fixture();
    f.round(f.head);
    f.git("update-index", "--chmod=+x", "src/a.ts");
    f.git("commit", "-m", "chmod +x");
    const next = f.git("rev-parse", "HEAD");
    const scoped = f.record(next);
    expect(scoped).toMatchObject({ outcome: "closure", triggers: [], delta: { empty: false } });
    expect(Number(member(member(scoped, "delta"), "added_lines"))).toBeGreaterThanOrEqual(1);
  });

  test("moving added lines above unchanged base lines is closure, not carry", () => {
    const f = fixture();
    f.round(f.head);
    const reordered = f.commit({ "src/a.ts": lines("first", 30) + lines("a", 10) }, "reorder");
    expect(f.record(reordered)).toMatchObject({
      outcome: "closure",
      triggers: [],
      delta: { empty: false },
      event: null,
    });
  });

  test("a gitlink bump after round 1 opens a new scope", () => {
    const f = fixture();
    const pin = f.git("rev-parse", "main");
    f.git("update-index", "--add", "--cacheinfo", `160000,${pin},vendor/lib`);
    f.git("commit", "-m", "add gitlink");
    const linked = f.git("rev-parse", "HEAD");
    f.round(linked);
    f.git("update-index", "--cacheinfo", `160000,${f.head},vendor/lib`);
    f.git("commit", "-m", "bump gitlink");
    const bumped = f.git("rev-parse", "HEAD");
    expect(f.record(bumped)).toMatchObject({
      outcome: "new-scope",
      triggers: ["path-identity"],
      delta: { empty: false, added_lines: 1 },
      event: { kind: "scope-open", trigger: "path-identity", head: bumped },
    });
  });

  test("a gitlink bump still opens a new scope when diff.ignoreSubmodules is all", () => {
    const f = fixture();
    const pin = f.git("rev-parse", "main");
    f.git("update-index", "--add", "--cacheinfo", `160000,${pin},vendor/lib`);
    f.git("commit", "-m", "add gitlink");
    const linked = f.git("rev-parse", "HEAD");
    f.round(linked);
    f.git("config", "diff.ignoreSubmodules", "all");
    f.git("update-index", "--cacheinfo", `160000,${f.head},vendor/lib`);
    f.git("commit", "-m", "bump gitlink");
    const bumped = f.git("rev-parse", "HEAD");
    expect(f.record(bumped)).toMatchObject({
      outcome: "new-scope",
      triggers: ["path-identity"],
      delta: { empty: false, added_lines: 1 },
      event: { kind: "scope-open", trigger: "path-identity", head: bumped },
    });
  });

  test("replacing a reviewed file with a gitlink opens a new scope", () => {
    const f = fixture();
    f.round(f.head);
    const pin = f.git("rev-parse", "main");
    f.git("rm", "-q", "src/a.ts");
    f.git("update-index", "--add", "--cacheinfo", `160000,${pin},src/a.ts`);
    f.git("commit", "-m", "file to gitlink");
    const replaced = f.git("rev-parse", "HEAD");
    expect(f.record(replaced)).toMatchObject({
      outcome: "new-scope",
      triggers: ["path-identity"],
      event: { kind: "scope-open", trigger: "path-identity", head: replaced },
    });
  });

  test("a two-line git mv after round 1 opens a new scope and matches --numstat", () => {
    const f = fixture();
    f.round(f.head);
    const small = f.commit({ "src/small.ts": "only\n" }, "add a one-line file");
    f.round(small);
    f.git("mv", "src/small.ts", "src/small-moved.ts");
    f.git("commit", "-m", "git mv");
    const moved = f.git("rev-parse", "HEAD");
    expect(f.numstat(small, moved)).toBe(2);
    expect(f.record(moved)).toMatchObject({
      outcome: "new-scope",
      triggers: ["path-identity"],
      delta: { empty: false, added_lines: 1 },
    });
  });

  test("a git mv of a pull-request file after round 1 opens a new scope and matches --numstat", () => {
    const f = fixture();
    f.round(f.head);
    f.git("mv", "src/a.ts", "src/moved.ts");
    f.git("commit", "-m", "git mv a.ts");
    const moved = f.git("rev-parse", "HEAD");
    expect(f.numstat(f.head, moved)).toBe(80);
    expect(f.record(moved)).toMatchObject({
      outcome: "new-scope",
      triggers: ["path-identity", "scope-growth"],
      delta: { empty: false, added_lines: 50 },
    });
  });

  test("a forged carry for a dirty head is refused", () => {
    const f = fixture();
    f.round(f.head);
    const dirty = f.commit({ "src/a.ts": lines("a", 10) + lines("first", 30) + lines("fix", 1) }, "fix");
    const forged = review(
      ["ledger", "add", "--ledger", f.ledger, "--event", "-", "--repo", f.root],
      JSON.stringify({ kind: "carry", head: dirty }),
    );
    expect({ code: forged.code, out: forged.out }).toEqual({ code: 2, out: [] });
    expect(forged.err.join("\n")).toContain("a carry line needs a scope record whose outcome is carry");
    const claimed = review(
      ["ledger", "add", "--ledger", f.ledger, "--event", "-", "--repo", f.root, "--previous", f.reviewed().path],
      JSON.stringify({
        schema: "review-scope",
        outcome: "carry",
        head: dirty,
        base: f.git("rev-parse", "main"),
        previous: { head: f.head },
        delta: { empty: true },
        event: { kind: "carry", head: dirty },
      }),
    );
    expect({ code: claimed.code, out: claimed.out }).toEqual({ code: 2, out: [] });
    expect(claimed.err.join("\n")).toContain(
      "a carry line needs a scope record whose delta is empty against that head",
    );
  });

  test("a hand-written --previous of the last reviewed head does not make a dirty head carry", () => {
    const f = fixture();
    f.round(f.head);
    const dirty = f.commit({ "src/a.ts": lines("a", 10) + lines("first", 30) + lines("fix", 1) }, "fix");
    const previous = f.file(
      "forged-previous.json",
      JSON.stringify({
        schema: "review-scope",
        schema_version: 1,
        head: f.head,
        base: f.git("rev-parse", "main"),
        class: null,
        intent: null,
        criteria: null,
        review_surface_changed: null,
      }),
    );
    expect(f.record(dirty, "--previous", previous)).toMatchObject({
      outcome: "closure",
      triggers: [],
      delta: { empty: false },
      event: null,
    });
  });

  test("FORGE-carry-base-equals-dirty-head: a carry whose base is the dirty head is refused", () => {
    const f = fixture();
    const pin = f.git("rev-parse", "main");
    f.round(f.head);
    const dirty = f.commit({ "src/a.ts": lines("a", 10) + lines("first", 30) + lines("fix", 1) }, "fix");
    expect(member(parseJson(readFileSync(f.reviewed().path, "utf8")), "base")).toBe(pin);
    const forged = review(
      ["ledger", "add", "--ledger", f.ledger, "--event", "-", "--repo", f.root, "--previous", f.reviewed().path],
      JSON.stringify({
        schema: "review-scope",
        outcome: "carry",
        head: dirty,
        base: dirty,
        previous: { head: f.head },
        delta: { empty: true },
        event: { kind: "carry", head: dirty },
      }),
    );
    expect({ code: forged.code, out: forged.out }).toEqual({ code: 2, out: [] });
    expect(forged.err.join("\n")).toContain("is an ancestor of base");
  });

  test("MB-force-pushed-base-branch: a base branch force-moved to the dirty tip is refused", () => {
    const f = fixture();
    f.round(f.head);
    const dirty = f.commit({ "src/a.ts": lines("a", 10) + lines("first", 30) + lines("fix", 1) }, "fix");
    f.git("update-ref", "refs/heads/main", dirty);
    expect(f.git("rev-parse", "main")).toBe(dirty);
    const run = f.scope(dirty, "--previous", f.reviewed().path);
    expect({ code: run.code, out: run.out }).toEqual({ code: 2, out: [] });
    expect(run.err.join("\n")).toContain("is an ancestor of base");
  });

  test("FU-replace-decide: a replace ref cannot make a dirty head carry", () => {
    const f = fixture();
    const pin = f.git("rev-parse", "main");
    f.round(f.head);
    const dirty = f.commit({ "src/a.ts": lines("a", 10) + lines("first", 30) + lines("fix", 1) }, "fix");
    f.git("replace", dirty, f.head);
    expect(f.record(dirty)).toMatchObject({
      outcome: "closure",
      delta: { empty: false },
      event: null,
    });
    const claimed = review(
      ["ledger", "add", "--ledger", f.ledger, "--event", "-", "--repo", f.root, "--previous", f.reviewed().path],
      JSON.stringify({
        schema: "review-scope",
        outcome: "carry",
        head: dirty,
        base: pin,
        previous: { head: f.head },
        delta: { empty: true },
        event: { kind: "carry", head: dirty },
      }),
    );
    expect({ code: claimed.code, out: claimed.out }).toEqual({ code: 2, out: [] });
    expect(claimed.err.join("\n")).toContain(
      "a carry line needs a scope record whose delta is empty against that head",
    );
  });

  test("FU-decide-dirty-head-after-forged-carry: decide does not approve a dirty head after a refused carry", () => {
    const f = fixture();
    f.round(f.head);
    const dirty = f.commit({ "src/a.ts": lines("a", 10) + lines("first", 30) + lines("fix", 1) }, "fix");
    const forged = review(
      ["ledger", "add", "--ledger", f.ledger, "--event", "-", "--repo", f.root],
      JSON.stringify({
        schema: "review-scope",
        outcome: "carry",
        head: dirty,
        base: dirty,
        previous: { head: f.head },
        delta: { empty: true },
        event: { kind: "carry", head: dirty },
      }),
    );
    expect(forged.code).toBe(2);
    const decided = f.decide(dirty);
    expect(decided.code).toBe(1);
    expect(parseJson(decided.out[0] ?? "")).toMatchObject({ verdict: "incomplete" });
  });

  test("BETWEEN-scope: --base B --head H after a dirty commit is refused", () => {
    const f = fixture();
    const { B, H } = between(f);
    const run = review([
      "scope",
      "--ledger",
      f.ledger,
      "--repo",
      f.root,
      "--base",
      B,
      "--head",
      H,
      "--previous",
      f.reviewed().path,
    ]);
    expect({ code: run.code, out: run.out }).toEqual({ code: 2, out: [] });
    expect(run.err.join("\n")).toContain("is an ancestor of base");
    expect(f.decide(H).code).toBe(1);
  });

  test("BETWEEN-forge: a carry JSON whose base is B is refused", () => {
    const f = fixture();
    const { B, H } = between(f);
    const forged = review(
      ["ledger", "add", "--ledger", f.ledger, "--event", "-", "--repo", f.root, "--previous", f.reviewed().path],
      JSON.stringify({
        schema: "review-scope",
        outcome: "carry",
        head: H,
        base: B,
        previous: { head: f.head },
        delta: { empty: true },
        event: { kind: "carry", head: H },
      }),
    );
    expect({ code: forged.code, out: forged.out }).toEqual({ code: 2, out: [] });
    expect(forged.err.join("\n")).toContain("is an ancestor of base");
    expect(f.decide(H).code).toBe(1);
  });

  test("BETWEEN-edited-previous: editing --previous.base to B does not carry", () => {
    const f = fixture();
    const { B, H } = between(f);
    const edited = parseJson(readFileSync(f.reviewed().path, "utf8"));
    const object = edited instanceof Object && !Array.isArray(edited) ? edited : {};
    object.base = B;
    const previous = f.file("edited-previous.json", JSON.stringify(object));
    const run = review([
      "scope",
      "--ledger",
      f.ledger,
      "--repo",
      f.root,
      "--base",
      B,
      "--head",
      H,
      "--previous",
      previous,
    ]);
    expect({ code: run.code, out: run.out }).toEqual({ code: 2, out: [] });
    expect(run.err.join("\n")).toContain("is an ancestor of base");
    expect(f.decide(H).code).toBe(1);
  });

  test("BETWEEN-update-ref: force-moving main to B is refused", () => {
    const f = fixture();
    const { B, H } = between(f);
    f.git("update-ref", "refs/heads/main", B);
    const run = f.scope(H, "--previous", f.reviewed().path);
    expect({ code: run.code, out: run.out }).toEqual({ code: 2, out: [] });
    expect(run.err.join("\n")).toContain("is an ancestor of base");
    expect(f.decide(H).code).toBe(1);
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
    f.add(Object(scoped));
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

  test("a criss-cross merge still exits 0", () => {
    const f = fixture();
    f.round(f.head);
    f.git("checkout", "-b", "x", f.head);
    const x1 = f.commit({ "src/x.ts": "x\n" }, "x1");
    f.git("checkout", "-b", "y", f.head);
    const y1 = f.commit({ "src/y.ts": "y\n" }, "y1");
    f.git("checkout", "x");
    f.git("merge", "--no-ff", "-m", "x2 merges y1", y1);
    const x2 = f.git("rev-parse", "HEAD");
    f.git("checkout", "y");
    f.git("merge", "--no-ff", "-m", "y2 merges x1", x1);
    const y2 = f.git("rev-parse", "HEAD");
    f.git("checkout", "pr");
    f.git("reset", "--hard", x2);
    f.git("merge", "--no-ff", "-m", "pr merges y2", y2);
    const head = f.git("rev-parse", "HEAD");
    const run = f.scope(head, "--previous", f.reviewed().path);
    expect(run.code).toBe(0);
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
      "a commit amended with one line replaced, then a merge of a base branch that moved elsewhere",
      (f) => {
        f.round(f.head);
        f.write({ "src/b.ts": lines("b", 10) + lines("second", 19) + lines("other", 1) });
        f.git("add", "-A");
        f.git("commit", "--amend", "--no-edit");
        f.git("checkout", "main");
        f.commit({ "src/main.ts": lines("m", 10) + lines("moved", 20) }, "main moves");
        f.git("checkout", "pr");
        f.git("merge", "--no-ff", "-m", "merge main", "main");
        return tip(f);
      },
      // second19 left and other0 came in: 1 of 50. Reading the cut against the merged base would add moved0..moved19: 21, 42%.
      { pr_lines: 50, rewritten_lines: 1, outcome: "closure", triggers: [] },
    ],
    [
      "a rebase onto a base branch that moved, with no change to the patches",
      (f) => {
        f.round(f.head);
        f.git("checkout", "main");
        f.commit({ "src/main.ts": lines("m", 10) + lines("moved", 20) }, "main moves");
        f.git("checkout", "pr");
        f.git("rebase", "main");
        return tip(f);
      },
      // Both commits keep their patch: nothing is rewritten.
      { pr_lines: 50, rewritten_lines: 0, outcome: "carry", triggers: [] },
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

  test("a three-parent merge that mixed a conflicted path is a large-rebase", () => {
    const f = fixture();
    f.round(f.head);
    const root = f.head;
    const a = f.commit({ "src/mix.ts": "aaa\n" }, "a");
    f.git("checkout", "-b", "side-b", root);
    const b = f.commit({ "src/mix.ts": "bbb\n" }, "b");
    f.git("checkout", "-b", "side-c", root);
    const c = f.commit({ "src/mix.ts": "ccc\n" }, "c");
    f.git("checkout", "pr");
    f.write({ "src/mix.ts": "aaa\nbbb\nccc\n" });
    f.git("add", "-A");
    const tree = f.git("write-tree");
    const mixed = f.git("commit-tree", tree, "-p", a, "-p", b, "-p", c, "-m", "octopus mix");
    f.git("reset", "--hard", mixed);
    expect(f.git("rev-list", "--parents", "-n", "1", mixed).split(" ")).toHaveLength(4);
    expect(f.record(mixed)).toMatchObject({
      outcome: "new-scope",
      triggers: ["large-rebase"],
      delta: { conflict_paths: ["src/mix.ts"] },
      event: { kind: "scope-open", trigger: "large-rebase", head: mixed },
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
  const classFlags = ["--ticket", join(f.dir, "ticket.json"), "--project", join(f.dir, "project.json")];
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
  return { ...f, merge, classFlags };
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
    expect(f.record(touched, "--previous", kept, "--record", second, ...f.classFlags)).toMatchObject({
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
    expect(f.record(fix, "--previous", kept, "--record", second, ...f.classFlags)).toMatchObject({
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
    expect(f.record(touched, "--previous", kept, "--record", alone, ...f.classFlags)).toMatchObject({
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
        base: f.git("rev-parse", "main"),
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

  test("a --record whose head is not --head", () => {
    const f = delegationFixture();
    const first = f.merge("merge-1.json", f.head);
    const kept = f.keep("round-1.json", f.head, "--record", first);
    f.round(f.head);
    const fix = f.commit({ "src/a.ts": lines("a", 10) + lines("first", 30) + lines("fix", 1) }, "fix");
    const run = f.scope(fix, "--previous", kept, "--record", first, ...f.classFlags);
    expect({ code: run.code, out: run.out }).toEqual({ code: 2, out: [] });
    expect(run.err.join("\n")).toContain(`--record is the record of ${f.head}`);
  });

  test("a previous.class that does not match merge-stage scoring at the last reviewed head", () => {
    const f = delegationFixture();
    const first = f.merge("merge-1.json", f.head);
    const kept = f.keep("round-1.json", f.head, "--record", first);
    f.round(f.head);
    const edited = parseJson(readFileSync(kept, "utf8"));
    const object = edited instanceof Object && !Array.isArray(edited) ? edited : {};
    object.class = "red";
    writeFileSync(kept, JSON.stringify(object));
    const fix = f.commit({ "src/a.ts": lines("a", 10) + lines("first", 30) + lines("fix", 1) }, "fix");
    const second = f.merge("merge-2.json", fix, "--previous", first);
    const run = f.scope(fix, "--previous", kept, "--record", second, ...f.classFlags);
    expect({ code: run.code, out: run.out }).toEqual({ code: 2, out: [] });
    expect(run.err.join("\n")).toContain("--previous class is red");
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
    const kept = f.keep("round-2.json", fix, "--previous", one, "--record", second, ...f.classFlags);
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
