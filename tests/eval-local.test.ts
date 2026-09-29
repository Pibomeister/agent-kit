/**
 * scripts/eval-local.sh against a stub host. A fake `claude` on PATH records its argv, behaves as
 * the real host was seen to (it keeps only the last `--case`, and a run that matches nothing writes
 * an empty result and exits 1), and writes canned results. The assertions are on the result, the
 * receipt and the exit status; the script's source is not read.
 */
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

// Each test runs the whole script (a bun subprocess, a bundle copy per group, the stub host), which
// takes 2-3s warm and has passed the 5s default on a cold first run.
setDefaultTimeout(30_000);

const REPO = resolve(import.meta.dir, "..");
const SCRIPT = join(REPO, "scripts", "eval-local.sh");

// The stub host. It sees only the variables eval-local passes through, so its knobs are named in
// AK_EVAL_PASS_ENV: FAKE_DIR (where argv is logged), FAKE_DROP (case names left out of the result)
// FAKE_COST (dollars spent per invocation, or a comma list of them taken in call order),
// FAKE_TRACE (give every run a durable source trace), FAKE_UNGRADED (the named arm's paid
// grader was skipped for budget), FAKE_FAILED (the named arm's cheap grader failed) and
// FAKE_WITH_ONLY (case names whose graders are all with-only, so nothing counts toward the score).
// It records the PATH it was started with in FAKE_DIR/path.txt.
const FAKE_HOST = `#!/usr/bin/env bun
import { appendFileSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
const argv = process.argv.slice(2);
if (argv[0] === "--version") { console.log("0.0.0 (fake host)"); process.exit(0); }
if (argv.includes("--help")) { console.log("--case <name>  --tag <tag>  --runs <n>  --max-cost-usd <usd>"); process.exit(0); }
appendFileSync(join(process.env.FAKE_DIR!, "argv.jsonl"), JSON.stringify(argv) + "\\n");
writeFileSync(join(process.env.FAKE_DIR!, "path.txt"), process.env.PATH ?? "");
const call = readFileSync(join(process.env.FAKE_DIR!, "argv.jsonl"), "utf8").trim().split("\\n").length - 1;
const target = argv[2]!;
const out = argv[argv.indexOf("--json") + 1]!;
const at = (flag: string) => argv.flatMap((a, i) => (a === flag ? [argv[i + 1]!] : []));
const runs = Number(at("--runs").at(-1) ?? 3);
const wanted = at("--case").at(-1); // the host keeps only the last --case
const drop = (process.env.FAKE_DROP ?? "").split(",").filter(Boolean);
const evals = join(target, "evals");
const walk = (d: string): string[] => readdirSync(d).flatMap((e) => {
  const p = join(d, e);
  return statSync(p).isDirectory() ? (e === "results" ? [] : walk(p)) : e === "case.yaml" ? [p] : [];
});
const found = walk(evals).map((f) => ({ name: /^name: (.*)$/m.exec(readFileSync(f, "utf8"))![1]!, dir: relative(evals, join(f, "..")) }));
const withOnly = (process.env.FAKE_WITH_ONLY ?? "").split(",").filter(Boolean);
const run = (name: string, arm: string, n: number, only: boolean) => {
  const tracePath = join(process.env.FAKE_DIR!, \`trace-\${name}-\${arm}-\${n}.jsonl\`);
  if (process.env.FAKE_TRACE === "1") writeFileSync(tracePath, JSON.stringify({ type: "assistant", name, arm, n }) + "\\n");
  const skipped = process.env.FAKE_UNGRADED === arm;
  const failed = process.env.FAKE_FAILED === arm;
  return {
    graders: [skipped ? { name: "g", skipped: true, reason: "budget" } : { name: "g", passed: true, withOnly: only },
              { name: "h", passed: !failed, withOnly: only }],
    ...(process.env.FAKE_TRACE === "1" ? { tracePath } : {}),
  };
};
const cases = found
  .filter((c) => (wanted === undefined || c.name === wanted) && !drop.includes(c.name))
  .map((c) => ({ c, only: withOnly.includes(c.name) }))
  .map(({ c, only }) => ({ ...c, graders: [{ name: "g", type: "llm", withOnly: only }, { name: "h", type: "tool_used", withOnly: only }],
    arms: {
      with: Array.from({ length: runs }, (_, i) => run(c.name, "with", i + 1, only)),
      without: Array.from({ length: runs }, (_, i) => run(c.name, "without", i + 1, only)),
    }, aggregates: { score: 1, scoreWithout: 1, delta: 0 } }));
const costs = (process.env.FAKE_COST ?? "0.5").split(",");
const cost = cases.length === 0 ? 0 : Number(costs[Math.min(call, costs.length - 1)]);
writeFileSync(out, JSON.stringify({ cases, costUsd: cost, durationSeconds: 1, partial: false, aggregates: { overallScore: cases.length ? 1 : null, meanDelta: 0 } }));
if (cases.length === 0) { console.error("No eval cases found matching --case " + JSON.stringify(wanted)); process.exit(1); }
process.exit(0);
`;

type Case = { dir: string; name: string; tools: string[]; tags?: string[] };
const CASES: Case[] = [
  { dir: "alpha/one", name: "case-one", tools: ["Read", "Edit", "Write"] },
  { dir: "alpha/two", name: "case-two", tools: ["Edit", "Write", "Skill"] },
  { dir: "beta/three", name: "case-three", tools: ["Write"] },
  { dir: "beta/four", name: "case-four", tools: ["Write"], tags: ["slow"] },
];

const made: string[] = [];
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

function run(args: string[], env: Record<string, string> = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "ak-eval-local-")));
  made.push(dir);
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "claude"), FAKE_HOST);
  chmodSync(join(bin, "claude"), 0o755);
  const developerGit = join(dir, "developer", "usr", "bin", "git");
  mkdirSync(dirname(developerGit), { recursive: true });
  writeFileSync(developerGit, "#!/bin/sh\\nexit 0\\n");
  chmodSync(developerGit, 0o755);
  writeFileSync(join(bin, "xcrun"), `#!/bin/sh\nprintf '%s\\n' '${developerGit}'\n`);
  chmodSync(join(bin, "xcrun"), 0o755);
  const bundle = join(dir, "bundle");
  mkdirSync(join(bundle, ".claude-plugin"), { recursive: true });
  writeFileSync(join(bundle, ".claude-plugin", "plugin.json"), "{}");
  for (const c of CASES) {
    const file = join(bundle, "evals", c.dir, "case.yaml");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `name: ${c.name}\ntags: [${(c.tags ?? []).join(", ")}]\nexecution:\n  prompt: p\n  allowed_tools: [${c.tools.join(", ")}]\n`);
  }
  for (const skill of ["alpha", "beta"]) {
    if ((env.FAKE_MISSING_SKILLS ?? "").split(",").includes(skill)) continue;
    const file = join(bundle, "skills", skill, "SKILL.md");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `---\nname: ${skill}\ndescription: fixture\n---\n`);
  }
  mkdirSync(join(dir, "home"));
  const json = join(dir, "out", "result.json");
  const r = spawnSync("bash", [SCRIPT, "--runs", "1", ...args], {
    cwd: REPO,
    encoding: "utf8",
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      HOME: join(dir, "home"),
      TMPDIR: dir,
      AK_EVAL_BUNDLE: bundle,
      AK_EVAL_JSON: json,
      AK_EVAL_PASS_ENV: "FAKE_DIR FAKE_DROP FAKE_COST FAKE_TRACE FAKE_UNGRADED FAKE_FAILED FAKE_WITH_ONLY",
      FAKE_DIR: dir,
      ...env,
    },
  });
  const read = (p: string) => (existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null);
  const argvFile = join(dir, "argv.jsonl");
  const calls: string[][] = existsSync(argvFile) ? readFileSync(argvFile, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
  const pathFile = join(dir, "path.txt");
  const hostPath = existsSync(pathFile) ? readFileSync(pathFile, "utf8").split(":") : [];
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, result: read(json), receipt: read(json.replace(/\.json$/, ".receipt.json")), calls,
           hostPath, developerBin: dirname(developerGit) };
}

const names = (result: { cases: Array<{ name: string }> }) => result.cases.map((c) => c.name).sort();

describe("eval-local: several --case flags across grant groups", () => {
  test("every selected case runs, in the group its grants put it in", () => {
    const r = run(["--case", "case-one", "--case", "case-two", "--case", "case-three"]);
    expect(r.stderr).not.toContain("No eval cases found");
    expect(r.status).toBe(0);
    expect(names(r.result)).toEqual(["case-one", "case-three", "case-two"]);
    expect(r.receipt.invocations.map((i: { cases: string[] }) => i.cases)).toEqual([["case-one", "case-two"], ["case-three"]]);
    expect(r.receipt.partial).toBe(false);
  });

  test("the host is not handed a --case it would narrow to one; the staged bundle already selects", () => {
    const r = run(["--case", "case-one", "--case", "case-two", "--case", "case-three"]);
    expect(r.calls).toHaveLength(2);
    for (const call of r.calls) expect(call).not.toContain("--case");
  });

  test("a --tag selects by staging too, and is not handed to the host", () => {
    const r = run(["--tag", "slow"]);
    expect(r.status).toBe(0);
    expect(names(r.result)).toEqual(["case-four"]);
    for (const call of r.calls) expect(call).not.toContain("--tag");
  });

  test("a single selected case in a single group runs only that case", () => {
    const r = run(["--case", "case-three"]);
    expect(r.status).toBe(0);
    expect(names(r.result)).toEqual(["case-three"]);
  });
});

describe("eval-local: the selected corpus matches its instrument", () => {
  test("a selected case whose skill is absent refuses to measure a partial bundle", () => {
    const r = run(["--case", "case-three"], { FAKE_MISSING_SKILLS: "beta" });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("does not install beta");
    expect(r.stderr).toContain("bun run ak build --profile all");
    expect(r.calls).toHaveLength(0);
  });

  test.each([
    ["env-allowlist", []],
    ["inherited-env", ["--inherit-env"]],
  ] as const)("under %s the host starts with the resolved git first on PATH and the receipt names it", (method, flags) => {
    const r = run(["--case", "case-three", ...flags]);
    expect(r.status).toBe(0);
    expect(r.receipt.isolation.method).toBe(`host-sandbox+${method}`);
    expect(r.receipt.tooling.git).toEqual({ source: "xcrun", path: join(r.developerBin, "git") });
    expect(r.hostPath[0]).toBe(r.developerBin);
  });
});

describe("eval-local: the receipt checks what each group was meant to run", () => {
  test("a case missing from a group's result makes the run partial and is listed", () => {
    const r = run([], { FAKE_DROP: "case-two" });
    const edit = r.receipt.invocations.find((i: { grant: string[] }) => i.grant.join(",") === "Edit,Write");
    expect(edit).toMatchObject({ partial: true, incomplete_cases: ["case-two"] });
    expect(r.receipt.partial).toBe(true);
  });

  test("a group whose result holds no case is an error, not a quiet zero", () => {
    const r = run([], { FAKE_DROP: "case-three,case-four" });
    const write = r.receipt.invocations.find((i: { grant: string[] }) => i.grant.join(",") === "Write");
    expect(write).toMatchObject({ partial: true, incomplete_cases: ["case-four", "case-three"], error: "nothing run" });
    expect(r.receipt.partial).toBe(true);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/group \[Write\] ran none of its 2 case/);
  });

  test("a complete run is not partial", () => {
    const r = run([]);
    expect(r.status).toBe(0);
    expect(r.receipt.partial).toBe(false);
    for (const i of r.receipt.invocations) expect(i).toMatchObject({ partial: false, incomplete_cases: [] });
  });
});

describe("eval-local: evidence retention and grading state", () => {
  test("host traces are copied beside the receipt before the temporary source disappears", () => {
    const r = run(["--case", "case-three"], { FAKE_TRACE: "1" });
    expect(r.status).toBe(0);
    expect(r.receipt.traces).toHaveLength(2);
    for (const trace of r.receipt.traces) {
      expect(trace.copy).not.toBeNull();
      expect(existsSync(trace.copy)).toBe(true);
      expect(readFileSync(trace.copy, "utf8")).toContain('"type":"assistant"');
    }
  });

  test("a budget-skipped grader is ungraded rather than a failed verdict", () => {
    const r = run(["--case", "case-three"], { FAKE_UNGRADED: "with" });
    expect(r.status).toBe(0);
    expect(r.receipt.cases[0].with).toMatchObject({ n: 1, graded: 0, ungraded: 1, passes: 0, rate: null });
    expect(r.receipt.cases[0].without).toMatchObject({ n: 1, graded: 1, ungraded: 0, passes: 1, rate: 1 });
    expect(r.receipt.cases[0]).toMatchObject({ score: null, scoreWithout: null, delta: null });
    expect(r.receipt.overall).toMatchObject({ score: null, meanDelta: null, ungraded: 1 });
    expect(r.stdout).toContain("1 ungraded");
    expect(r.stdout).toMatch(/^case-three\s+0\/0 \[0,1\] \+ 1 ungraded\s+1\/1 \[[\d.]+,1\]\s+-\s+-$/m);
  });

  test("a definite grader failure stays a graded failure when the paid grader is skipped", () => {
    const r = run(["--case", "case-three"], { FAKE_UNGRADED: "with", FAKE_FAILED: "with" });
    expect(r.status).toBe(0);
    expect(r.receipt.cases[0].with).toMatchObject({ n: 1, graded: 1, ungraded: 0, passes: 0, rate: 0 });
    expect(r.receipt.cases[0]).toMatchObject({ score: 1, scoreWithout: 1, delta: 0 });
    expect(r.receipt.overall).toMatchObject({ score: 1, meanDelta: 0, ungraded: 0 });
    expect(r.stdout).not.toContain("ungraded");
  });

  test("a case with no score graders is neither graded nor ungraded", () => {
    const r = run(["--case", "case-three"], { FAKE_WITH_ONLY: "case-three" });
    expect(r.status).toBe(0);
    for (const arm of ["with", "without"]) {
      expect(r.receipt.cases[0][arm]).toMatchObject({ n: 1, graded: 0, ungraded: 0, passes: 0, rate: null });
    }
    expect(r.receipt.cases[0]).toMatchObject({ score: 1, scoreWithout: 1, delta: 0 });
    expect(r.receipt.overall).toMatchObject({ score: 1, meanDelta: 0, ungraded: 0 });
    expect(r.stdout).not.toContain("ungraded");
  });

  test("a definite grader failure without a skipped grader is a graded failure", () => {
    const r = run(["--case", "case-three"], { FAKE_FAILED: "without" });
    expect(r.status).toBe(0);
    expect(r.receipt.cases[0].without).toMatchObject({ n: 1, graded: 1, ungraded: 0, passes: 0, rate: 0 });
    expect(r.receipt.cases[0].with).toMatchObject({ n: 1, graded: 1, ungraded: 0, passes: 1, rate: 1 });
  });
});

describe("eval-local: the cost cap", () => {
  test("spend past the cap is recorded and warned about", () => {
    const r = run(["--case", "case-three", "--max-cost-usd", "1"], { FAKE_COST: "2.5" });
    expect(r.receipt).toMatchObject({ budget: 1, over_budget: true, costUsd: 2.5 });
    expect(r.stderr).toMatch(/spent \$2\.5 against a cap of \$1/);
    expect(r.stdout).toContain("over budget (cap $1)");
  });

  test("spend within the cap is not over budget", () => {
    const r = run(["--case", "case-three", "--max-cost-usd", "3"], { FAKE_COST: "2.5" });
    expect(r.receipt).toMatchObject({ budget: 3, over_budget: false });
    expect(r.stderr).not.toContain("against a cap");
  });

  test("spend summing to exactly the cap is not over budget", () => {
    const r = run(["--case", "case-one", "--case", "case-three", "--max-cost-usd", "0.3"], { FAKE_COST: "0.1,0.2" });
    expect(r.receipt.invocations).toHaveLength(2);
    expect(r.receipt).toMatchObject({ budget: 0.3, over_budget: false, costUsd: 0.3 });
    expect(r.stderr).not.toContain("against a cap");
  });

  test("a single group's host cost is recorded at the precision the cap is judged at", () => {
    const r = run(["--case", "case-three", "--max-cost-usd", "0.3"], { FAKE_COST: "0.30003" });
    expect(r.receipt.invocations).toHaveLength(1);
    expect(r.receipt).toMatchObject({ budget: 0.3, over_budget: false, costUsd: 0.3 });
    expect(r.stderr).not.toContain("against a cap");
  });

  test("with no cap, the receipt says so", () => {
    const r = run(["--case", "case-three"]);
    expect(r.receipt).toMatchObject({ budget: null, over_budget: false });
  });
});
