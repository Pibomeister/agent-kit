/**
 * The lint ratchet and the two tool configs, run for real on temp trees.
 *
 * The ratchet cases drive `tools/oxlint/ratchet.ts` as a CLI against a tree with its own one-rule
 * config, so each assertion is about what the command does to a baseline, not about the repo's
 * current findings. The config cases copy the repository's `.oxfmtrc.json` and `.oxlintrc.json` into a
 * temp root and run the real binaries: the formatter case pins the failure that shaped the ignore
 * list (oxfmt read `__MARKER__` in a Markdown fixture as bold and rewrote it), and the linter case
 * pins that the vendored anti-slop plugin actually loads. The growth cases drive `tools/oxlint/growth.ts`
 * against temp git repos whose first commit is tagged as the merge base.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { lint, readBaseline } from "../tools/oxlint/ratchet.ts";

const REPO = resolve(import.meta.dir, "..");
const RATCHET = join(REPO, "tools", "oxlint", "ratchet.ts");
const GROWTH = join(REPO, "tools", "oxlint", "growth.ts");
const BIN = join(REPO, "node_modules", ".bin");

function tree(files: Record<string, string>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ak-lint-")));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

const ONE_RULE = JSON.stringify({ plugins: ["eslint"], categories: {}, rules: { "eslint/no-debugger": "error" } });

function ratchet(root: string, ...flags: string[]) {
  const run = spawnSync("bun", [RATCHET, "--root", root, ...flags, "src"], { encoding: "utf8" });
  return { status: run.status, out: `${run.stdout}${run.stderr}` };
}

// Starting nested Bun and importing Ajv took 6.12s beside another full suite. Run this real CLI
// failure once at module load so scheduler delay cannot consume the timed assertion body.
const missingOxlint = (() => {
  const home = tree({ "tools/oxlint/ratchet.ts": "" });
  copyFileSync(RATCHET, join(home, "tools", "oxlint", "ratchet.ts"));
  mkdirSync(join(home, "node_modules"));
  symlinkSync(join(REPO, "node_modules", "ajv"), join(home, "node_modules", "ajv"));
  const root = tree({ ".oxlintrc.json": ONE_RULE, "src/a.ts": "export {};\n" });
  const run = spawnSync("bun", [join(home, "tools", "oxlint", "ratchet.ts"), "--root", root, "src"], {
    encoding: "utf8",
  });
  return {
    status: run.status,
    out: `${run.stdout}${run.stderr}`,
    binary: join(home, "node_modules", ".bin", "oxlint"),
  };
})();

/** The recorded baseline, read through the ratchet's own schema-checked parser. */
const baseline = (root: string) =>
  Object.fromEntries([...readBaseline(root)].map(([file, rules]) => [file, Object.fromEntries(rules)]));

describe("lint ratchet", () => {
  test("a violation the baseline does not record fails, naming the file and line", () => {
    const root = tree({ ".oxlintrc.json": ONE_RULE, "src/a.ts": "export const f = () => {\n  debugger;\n};\n" });
    const run = ratchet(root);
    expect(run.status).toBe(1);
    expect(run.out).toContain("src/a.ts:2:");
    expect(run.out).toContain("eslint(no-debugger)");
    expect(run.out).toContain("help: Remove the debugger statement");
  });

  test("--update refuses to record growth; --allow-growth records it and the next check passes", () => {
    const root = tree({ ".oxlintrc.json": ONE_RULE, "src/a.ts": "debugger;\ndebugger;\n" });
    expect(ratchet(root, "--update").status).toBe(1);
    expect(ratchet(root, "--update", "--allow-growth").status).toBe(0);
    expect(baseline(root)).toEqual({ "src/a.ts": { "eslint(no-debugger)": 2 } });
    expect(ratchet(root).status).toBe(0);
  });

  test("one more violation in a recorded file fails even though the pair is in the baseline", () => {
    const root = tree({ ".oxlintrc.json": ONE_RULE, "src/a.ts": "debugger;\n" });
    ratchet(root, "--update", "--allow-growth");
    writeFileSync(join(root, "src/a.ts"), "debugger;\ndebugger;\n");
    const run = ratchet(root);
    expect(run.status).toBe(1);
    expect(run.out).toContain("baseline allows 1");
  });

  test("a fixed violation leaves the baseline stale until it is recorded, and recording needs no growth flag", () => {
    const root = tree({ ".oxlintrc.json": ONE_RULE, "src/a.ts": "debugger;\ndebugger;\n", "src/b.ts": "debugger;\n" });
    ratchet(root, "--update", "--allow-growth");
    writeFileSync(join(root, "src/a.ts"), "debugger;\n");
    writeFileSync(join(root, "src/b.ts"), "export {};\n");
    const stale = ratchet(root);
    expect(stale.status).toBe(1);
    expect(stale.out).toContain("down to 1 from 2");
    expect(ratchet(root, "--update").status).toBe(0);
    expect(baseline(root)).toEqual({ "src/a.ts": { "eslint(no-debugger)": 1 } });
    expect(ratchet(root).status).toBe(0);
  });

  test("a malformed baseline is an error, not an empty one", () => {
    const root = tree({
      ".oxlintrc.json": ONE_RULE,
      "src/a.ts": "export {};\n",
      "tools/oxlint/baseline.json": JSON.stringify({ "src/a.ts": { "eslint(no-debugger)": "many" } }),
    });
    const run = ratchet(root);
    expect(run.status).not.toBe(0);
    expect(run.out).toContain("baseline.json is malformed");
  });

  test("a plugin that fails to load stops the run and says why, rather than reading as a clean tree", () => {
    const root = tree({
      ".oxlintrc.json": JSON.stringify({ jsPlugins: ["./missing/index.ts"], rules: {} }),
      "src/a.ts": "export {};\n",
    });
    const run = ratchet(root);
    expect(run.status).not.toBe(0);
    expect(run.out).toContain("oxlint produced no report");
    expect(run.out).toContain("Failed to load JS plugin: ./missing/index.ts");
  });

  test("an oxlint binary that cannot be started names the missing path rather than printing null", () => {
    expect(missingOxlint.status).not.toBe(0);
    expect(missingOxlint.out).toContain("oxlint produced no report");
    expect(missingOxlint.out).toContain(missingOxlint.binary);
    expect(missingOxlint.out).not.toContain("nullnull");
  });
});

describe("the repository's tool configs", () => {
  test("oxfmt formats code and leaves fixtures, donor material, Markdown and YAML byte-for-byte alone", () => {
    const unformatted = "export const x   =  { a:1 }\n";
    const root = tree({
      "src/a.ts": unformatted,
      "schemas/a.schema.json": '{"a":1}',
      "tests/fixtures/invalid/skills/alpha/SKILL.md": "Uses __DENY_MODEL_TERM__ here.\n",
      "tests/fixtures/valid/src/b.ts": unformatted,
      "provenance/donor-snapshots/x/c.ts": unformatted,
      "research/sources/d.json": '{"a":1}',
      "evals/demo/_fixtures/repo/e.js": unformatted,
      "skills/alpha/SKILL.md": "*   item\n",
      "catalog.yaml": "a:   1\n",
      // Eval inputs are pinned by sha256 in recorded receipts; reformatting one invalidates them.
      "tests/learn/evals/prompts/dev.json": '{"a":1}',
      "tests/learn/evals/reflect/fixtures.json": '{"a":1}',
    });
    copyFileSync(join(REPO, ".oxfmtrc.json"), join(root, ".oxfmtrc.json"));
    const run = spawnSync(join(BIN, "oxfmt"), ["--list-different", "."], { cwd: root, encoding: "utf8" });
    const listed = run.stdout.split("\n").filter(Boolean).toSorted();
    expect(listed).toEqual(["schemas/a.schema.json", "src/a.ts"]);
  });

  test("oxlint loads the vendored anti-slop plugin and rejects a laundered type", () => {
    const root = tree({ "src/a.ts": "export const read = (body: string) => body as unknown as number;\n" });
    copyFileSync(join(REPO, ".oxlintrc.json"), join(root, ".oxlintrc.json"));
    mkdirSync(join(root, "tools", "oxlint"), { recursive: true });
    symlinkSync(join(REPO, "tools", "oxlint", "anti-slop"), join(root, "tools", "oxlint", "anti-slop"));
    // Type-aware rules look for tsgolint under the linted tree's own node_modules.
    symlinkSync(join(REPO, "node_modules"), join(root, "node_modules"));
    const codes = lint(root, ["src"]).map((d) => d.rule);
    expect(codes).toContain("anti-slop(no-chained-type-assertions)");
  });

  test("oxlint runs the type-aware rules against the tree's tsconfig", () => {
    const root = tree({
      "src/a.ts": "const load = async (): Promise<number> => 1;\nload();\n",
      "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true, target: "ES2022" }, include: ["src"] }),
    });
    copyFileSync(join(REPO, ".oxlintrc.json"), join(root, ".oxlintrc.json"));
    mkdirSync(join(root, "tools", "oxlint"), { recursive: true });
    symlinkSync(join(REPO, "tools", "oxlint", "anti-slop"), join(root, "tools", "oxlint", "anti-slop"));
    symlinkSync(join(REPO, "node_modules"), join(root, "node_modules"));
    const floating = lint(root, ["src"]).filter((d) => d.rule === "typescript(no-floating-promises)");
    expect(floating.map((d) => d.line)).toEqual([2]);
  });
});

const BASELINE_PATH = "tools/oxlint/baseline.json";
const recorded = (counts: Record<string, Record<string, number>>) => `${JSON.stringify(counts, null, 2)}\n`;

/** Keep the machine's git config (signing, hooks) out of the temp repos. */
const GIT_ISOLATION = [
  "-c",
  "user.name=t",
  "-c",
  "user.email=t@t",
  "-c",
  "commit.gpgsign=false",
  "-c",
  "core.hooksPath=/dev/null",
];

function gitIn(root: string, ...args: string[]) {
  const run = spawnSync("git", [...GIT_ISOLATION, ...args], { cwd: root, encoding: "utf8" });
  if (run.status !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr}`);
}

/** A temp repo whose first commit is tagged `base`, standing in for the merge base with main. */
function repo(files: Record<string, string>): string {
  const root = tree(files);
  gitIn(root, "init", "-q", "-b", "main");
  commit(root, "base");
  gitIn(root, "tag", "base");
  return root;
}

function commit(root: string, message: string) {
  gitIn(root, "add", "-A");
  gitIn(root, "commit", "-q", "-m", message);
}

function check(root: string, ref = "base") {
  const run = spawnSync("bun", [GROWTH, "--root", root, ref], { encoding: "utf8" });
  return { status: run.status, out: `${run.stdout}${run.stderr}` };
}

const LOAD = "export const load = () => 1;\n".repeat(20);

describe("baseline growth since the merge base", () => {
  test("a count raised by hand fails, naming the file, the rule and the merge base's count", () => {
    const root = repo({
      ".oxlintrc.json": ONE_RULE,
      "src/a.ts": LOAD,
      [BASELINE_PATH]: recorded({ "src/a.ts": { r: 1 } }),
    });
    writeFileSync(join(root, BASELINE_PATH), recorded({ "src/a.ts": { r: 2 } }));
    commit(root, "grow");
    const run = check(root);
    expect(run.status).toBe(1);
    expect(run.out).toContain("src/a.ts: r 1 -> 2");
  });

  test("a new file entered into the baseline fails", () => {
    const root = repo({ ".oxlintrc.json": ONE_RULE, "src/a.ts": LOAD, [BASELINE_PATH]: recorded({}) });
    writeFileSync(join(root, "src/b.ts"), "export const b = 2;\n");
    writeFileSync(join(root, BASELINE_PATH), recorded({ "src/b.ts": { r: 1 } }));
    commit(root, "new file with a violation");
    expect(check(root).status).toBe(1);
  });

  test("a renamed file carries its counts to the new path, and no more", () => {
    const root = repo({
      ".oxlintrc.json": ONE_RULE,
      "src/a.ts": LOAD,
      [BASELINE_PATH]: recorded({ "src/a.ts": { r: 3 } }),
    });
    gitIn(root, "mv", "src/a.ts", "src/loader.ts");
    writeFileSync(join(root, BASELINE_PATH), recorded({ "src/loader.ts": { r: 3 } }));
    commit(root, "rename");
    expect(check(root).status).toBe(0);
    writeFileSync(join(root, BASELINE_PATH), recorded({ "src/loader.ts": { r: 4 } }));
    commit(root, "grow after rename");
    const run = check(root);
    expect(run.status).toBe(1);
    expect(run.out).toContain("src/loader.ts: r 3 -> 4");
  });

  test("growth passes when .oxlintrc.json changed, because a rule is being adopted", () => {
    const root = repo({ ".oxlintrc.json": ONE_RULE, "src/a.ts": LOAD, [BASELINE_PATH]: recorded({}) });
    writeFileSync(
      join(root, ".oxlintrc.json"),
      JSON.stringify({ plugins: ["eslint"], rules: { "eslint/no-var": "error" } }),
    );
    writeFileSync(join(root, BASELINE_PATH), recorded({ "src/a.ts": { "eslint(no-var)": 5 } }));
    commit(root, "adopt no-var");
    const run = check(root);
    expect(run.status).toBe(0);
    expect(run.out).toContain("src/a.ts: eslint(no-var) 0 -> 5");
  });

  test("a baseline that only shrank passes", () => {
    const root = repo({
      ".oxlintrc.json": ONE_RULE,
      "src/a.ts": LOAD,
      [BASELINE_PATH]: recorded({ "src/a.ts": { r: 3 } }),
    });
    writeFileSync(join(root, BASELINE_PATH), recorded({ "src/a.ts": { r: 1 } }));
    commit(root, "shrink");
    expect(check(root).status).toBe(0);
  });

  test("every rename is found among other changes that sort before, between and after them", () => {
    const root = repo({
      ".oxlintrc.json": ONE_RULE,
      "src/0.ts": "export const zero = 0;\n",
      "src/a.ts": LOAD,
      "src/m.ts": "export const m = 1;\n",
      "src/p.ts": "export const parse = () => 2;\n".repeat(20),
      [BASELINE_PATH]: recorded({ "src/a.ts": { r: 2 }, "src/p.ts": { r: 1 } }),
    });
    writeFileSync(join(root, "src/0.ts"), "export const zero = 1;\n");
    gitIn(root, "rm", "-q", "src/m.ts");
    gitIn(root, "mv", "src/a.ts", "src/b.ts");
    gitIn(root, "mv", "src/p.ts", "src/z.ts");
    writeFileSync(join(root, BASELINE_PATH), recorded({ "src/b.ts": { r: 2 }, "src/z.ts": { r: 1 } }));
    commit(root, "edit, delete and rename twice");
    expect(check(root).status).toBe(0);
  });

  test("main shrinking the baseline after the branch forked does not fail the branch", () => {
    const root = repo({
      ".oxlintrc.json": ONE_RULE,
      "src/a.ts": LOAD,
      [BASELINE_PATH]: recorded({ "src/a.ts": { r: 3 } }),
    });
    gitIn(root, "checkout", "-q", "-b", "topic");
    writeFileSync(join(root, "src/b.ts"), "export const b = 2;\n");
    commit(root, "unrelated branch work");
    gitIn(root, "checkout", "-q", "main");
    writeFileSync(join(root, BASELINE_PATH), recorded({ "src/a.ts": { r: 1 } }));
    commit(root, "main fixes two");
    gitIn(root, "checkout", "-q", "topic");
    expect(check(root, "main").status).toBe(0);
  });

  test("a ref with no merge base is a usage error that says to fetch history", () => {
    const root = repo({ ".oxlintrc.json": ONE_RULE, "src/a.ts": LOAD, [BASELINE_PATH]: recorded({}) });
    gitIn(root, "checkout", "-q", "--orphan", "unrelated");
    commit(root, "no shared history");
    gitIn(root, "checkout", "-q", "main");
    const run = check(root, "unrelated");
    expect(run.status).toBe(2);
    expect(run.out).toContain("no merge base");
  });

  test("--root inside the repository resolves to its top, and a --root with no value is a usage error", () => {
    const root = repo({
      ".oxlintrc.json": ONE_RULE,
      "src/a.ts": LOAD,
      [BASELINE_PATH]: recorded({ "src/a.ts": { r: 1 } }),
    });
    writeFileSync(join(root, BASELINE_PATH), recorded({ "src/a.ts": { r: 2 } }));
    commit(root, "grow");
    expect(check(join(root, "src")).out).toContain("src/a.ts: r 1 -> 2");
    const bare = spawnSync("bun", [GROWTH, "base", "--root"], { encoding: "utf8" });
    expect(bare.status).toBe(2);
  });

  test("a merge base with no baseline counts every recorded violation as growth, and says so", () => {
    const root = repo({ ".oxlintrc.json": ONE_RULE, "src/a.ts": LOAD, "tools/oxlint/.keep": "" });
    writeFileSync(join(root, BASELINE_PATH), recorded({ "src/a.ts": { r: 1 } }));
    commit(root, "first baseline");
    const run = check(root);
    expect(run.status).toBe(1);
    expect(run.out).toContain("has no tools/oxlint/baseline.json");
  });

  test("an uncommitted baseline edit is measured, not the last commit", () => {
    const root = repo({
      ".oxlintrc.json": ONE_RULE,
      "src/a.ts": LOAD,
      [BASELINE_PATH]: recorded({ "src/a.ts": { r: 1 } }),
    });
    writeFileSync(join(root, BASELINE_PATH), recorded({ "src/a.ts": { r: 2 } }));
    expect(check(root).status).toBe(1);
  });

  test("a staged rename not yet committed carries its counts", () => {
    const root = repo({
      ".oxlintrc.json": ONE_RULE,
      "src/a.ts": LOAD,
      [BASELINE_PATH]: recorded({ "src/a.ts": { r: 2 } }),
    });
    gitIn(root, "mv", "src/a.ts", "src/b.ts");
    writeFileSync(join(root, BASELINE_PATH), recorded({ "src/b.ts": { r: 2 } }));
    expect(check(root).status).toBe(0);
  });
});
