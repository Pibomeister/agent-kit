/**
 * `ak lifecycle bypass grant|check` and `record --bypass`: the supervisor-held grant that starts the
 * human-started lifecycle phases for one task without a typed command (ADR-0008). Start only.
 *
 * Every case is a temp repository with a linked worktree standing in for the worker's, a temp
 * supervisor home outside both, and a temp ledger handed to `main` in place of the account's.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadCatalog } from "../../src/catalog/load.ts";
import {
  BYPASS_PHASES,
  checkBypass,
  defaultEvidenceDir,
  main,
  readRecords,
  type GateRecord,
} from "../../src/lifecycle/gate.ts";
import { GATE_FILE, planBundle } from "../../src/packaging/plan.ts";
import { makeTree } from "../helpers/tree.ts";

const REPO = join(import.meta.dir, "..", "..");

function git(cwd: string, ...args: string[]): string {
  const p = Bun.spawnSync(["git", ...args], {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.invalid",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.invalid",
    },
  });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`);
  return p.stdout.toString().trim();
}

const dir = (prefix: string) => mkdtempSync(join(tmpdir(), prefix));

/** The id of the one grant registered in a ledger, from its ledger file name. */
function grantId(ledger: string): string {
  const [name] = readdirSync(ledger);
  if (name === undefined) throw new Error("nothing registered");
  return name.replace(/\.json$/, "");
}

function only(records: GateRecord[]): GateRecord {
  expect(records).toHaveLength(1);
  const [record] = records;
  if (record === undefined) throw new Error("no record");
  return record;
}

/** A project, the worker's linked worktree on branch `task`, a supervisor home and a ledger. */
function setup() {
  const project = makeTree({ "src/a.js": "export const a = 1;\n" });
  git(project, "init", "-q", "-b", "main");
  git(project, "add", "-A");
  git(project, "commit", "-q", "-m", "init");
  const worktree = join(dir("ak-bypass-wt-"), "task");
  git(project, "worktree", "add", "-q", "-b", "task", worktree);
  const home = dir("ak-bypass-home-");
  const ledger = dir("ak-bypass-ledger-");
  return { project, worktree, home, ledger, grantPath: join(home, "data", "T-1", "bypass.json") };
}

function ak(cwd: string, ledger: string, ...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = main(argv, { out: (l) => out.push(l), err: (l) => err.push(l) }, cwd, ledger);
  return { code, out: out.join("\n"), err: err.join("\n") };
}

function granted() {
  const s = setup();
  const r = ak(
    s.home,
    s.ledger,
    "bypass",
    "grant",
    "--task",
    "T-1",
    "--by",
    "captain",
    "--reason",
    "ENG-4151 is customer-blocking",
    "--out",
    s.grantPath,
    "--project",
    s.project,
    "--worktree",
    s.worktree,
  );
  expect(r).toMatchObject({ code: 0 });
  return { ...s, brief: r.out };
}

describe("bypass granted: phases start without a typed command", () => {
  test("grant writes the file outside the repository and prints the brief section", () => {
    const { grantPath, brief, ledger } = granted();
    expect(JSON.parse(readFileSync(grantPath, "utf8"))).toMatchObject({
      schema: "bypass-grant",
      authorized_by: "captain",
      approvals: "supervisor",
      covers: [...BYPASS_PHASES],
      grant_id: grantId(ledger),
    });
    expect(readdirSync(ledger)).toHaveLength(1);
    expect(brief).toContain(`bypass check --grant ${realpathSync(grantPath)} --task T-1 --phase`);
    expect(brief).toContain("Every approval inside a phase stops with needs-decision");
  });

  test("the worker's check passes for every phase and leaves a use record naming who authorized it", () => {
    const { worktree, ledger, grantPath } = granted();
    for (const phase of BYPASS_PHASES) {
      const r = ak(worktree, ledger, "bypass", "check", "--grant", grantPath, "--task", "T-1", "--phase", phase);
      expect(r.code).toBe(0);
      expect(JSON.parse(r.out)).toMatchObject({ mode: "bypass", authorized_by: "captain", task_id: "T-1", phase });
    }
    const used = join(defaultEvidenceDir(worktree), "task", "bypass");
    expect(readdirSync(used).toSorted()).toEqual(BYPASS_PHASES.map((p) => `${p.replace(":", "-")}.json`).toSorted());
  });

  test("a gate recorded with --bypass carries the attribution; one recorded without it does not", () => {
    const { worktree, ledger, grantPath } = granted();
    expect(ak(worktree, ledger, "record", "--gate", "review-full", "--bypass", grantPath, "--task", "T-1").code).toBe(
      0,
    );
    expect(ak(worktree, ledger, "record", "--gate", "build-checks").code).toBe(0);
    const evidence = defaultEvidenceDir(worktree);
    const full = only(readRecords(evidence, "task", "review-full"));
    expect(full.authority).toMatchObject({ mode: "bypass", authorized_by: "captain", task_id: "T-1" });
    expect(full.authority?.grant_sha256).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(only(readRecords(evidence, "task", "build-checks")).authority).toBeUndefined();
  });
});

describe("start only: approvals, merge and deploy are never covered", () => {
  test.each(["align-answer", "spec-approval", "ticket-approval", "ship-pr", "merge", "deploy", "autopilot"])(
    "%s is refused with a needs-decision hint",
    (phase) => {
      const { worktree, ledger, grantPath } = granted();
      const r = ak(worktree, ledger, "bypass", "check", "--grant", grantPath, "--task", "T-1", "--phase", phase);
      expect(r.code).toBe(1);
      expect(r.err).toContain("not a phase a bypass grant starts");
      expect(r.err).toContain("needs-decision");
    },
  );
});

describe("bypass absent or forged: the refusal is unchanged", () => {
  test("no grant file: refused, and no use record is written", () => {
    const s = setup();
    const r = ak(
      s.worktree,
      s.ledger,
      "bypass",
      "check",
      "--grant",
      s.grantPath,
      "--task",
      "T-1",
      "--phase",
      "super-align",
    );
    expect(r.code).toBe(1);
    expect(r.err).toContain("does not exist");
    expect(existsSync(join(defaultEvidenceDir(s.worktree), "task", "bypass"))).toBe(false);
  });

  test("a grant edited after it was registered is refused", () => {
    const { worktree, ledger, grantPath } = granted();
    const text = readFileSync(grantPath, "utf8");
    writeFileSync(grantPath, text.replace('"authorized_by": "captain"', '"authorized_by": "someone else"'));
    const r = ak(worktree, ledger, "bypass", "check", "--grant", grantPath, "--task", "T-1", "--phase", "super-align");
    expect(r.code).toBe(1);
    expect(r.err).toContain("not the sha256:");
  });

  test("a copy of a registered grant is refused", () => {
    const { worktree, ledger, grantPath, home } = granted();
    const copy = join(home, "copy.json");
    copyFileSync(grantPath, copy);
    const r = ak(worktree, ledger, "bypass", "check", "--grant", copy, "--task", "T-1", "--phase", "super-align");
    expect(r.code).toBe(1);
    expect(r.err).toContain("that was registered");
  });

  test("a well-formed grant nobody registered is refused", () => {
    const s = setup();
    const { grantPath } = granted();
    mkdirSync(join(s.home, "data"), { recursive: true });
    const forged = join(s.home, "data", "forged.json");
    copyFileSync(grantPath, forged);
    const r = ak(s.worktree, s.ledger, "bypass", "check", "--grant", forged, "--task", "T-1", "--phase", "super-align");
    expect(r.code).toBe(1);
    expect(r.err).toContain("was never registered");
  });

  test("an expired grant is refused", () => {
    const s = setup();
    expect(
      ak(
        s.home,
        s.ledger,
        "bypass",
        "grant",
        "--task",
        "T-1",
        "--by",
        "captain",
        "--reason",
        "r",
        "--out",
        s.grantPath,
        "--project",
        s.project,
        "--worktree",
        s.worktree,
        "--hours",
        "1",
      ).code,
    ).toBe(0);
    const later = new Date(Date.now() + 3_600_001);
    const r = checkBypass({
      grant: s.grantPath,
      task: "T-1",
      phase: "super-align",
      project: s.worktree,
      ledger: s.ledger,
      now: () => later,
    });
    expect(r).toMatchObject({ ok: false });
    expect(!r.ok && r.reason).toContain("expired");
  });

  test("a grant for another repository is refused", () => {
    const { ledger, grantPath } = granted();
    const other = setup();
    const r = ak(
      other.worktree,
      ledger,
      "bypass",
      "check",
      "--grant",
      grantPath,
      "--task",
      "T-1",
      "--phase",
      "super-align",
    );
    expect(r.code).toBe(1);
    expect(r.err).toContain("is for");
  });

  test("record --bypass with a forged grant writes no record", () => {
    const { worktree, ledger, grantPath } = granted();
    writeFileSync(grantPath, readFileSync(grantPath, "utf8").replace("captain", "captain2"));
    expect(ak(worktree, ledger, "record", "--gate", "review-full", "--bypass", grantPath, "--task", "T-1").code).toBe(
      1,
    );
    expect(readRecords(defaultEvidenceDir(worktree), "task", "review-full")).toEqual([]);
  });
});

describe("one task: the grant binds to the task it names and that task's worktree, not to a run", () => {
  test("another task's grant is refused at check, and no use record is written", () => {
    const { worktree, ledger, grantPath } = granted();
    const r = ak(worktree, ledger, "bypass", "check", "--grant", grantPath, "--task", "T-2", "--phase", "super-align");
    expect(r.code).toBe(1);
    expect(r.err).toContain("is for task T-1, not T-2");
    expect(existsSync(join(defaultEvidenceDir(worktree), "task", "bypass"))).toBe(false);
  });

  test("another task's grant is refused at record --bypass, and no gate record is written", () => {
    const { worktree, ledger, grantPath } = granted();
    const r = ak(worktree, ledger, "record", "--gate", "review-full", "--bypass", grantPath, "--task", "T-2");
    expect(r.code).toBe(1);
    expect(r.err).toContain("is for task T-1, not T-2");
    expect(readRecords(defaultEvidenceDir(worktree), "task", "review-full")).toEqual([]);
  });

  test("check and record --bypass without --task are usage errors", () => {
    const { worktree, ledger, grantPath } = granted();
    expect(ak(worktree, ledger, "bypass", "check", "--grant", grantPath, "--phase", "super-align").code).toBe(2);
    expect(ak(worktree, ledger, "record", "--gate", "review-full", "--bypass", grantPath).code).toBe(2);
    expect(readRecords(defaultEvidenceDir(worktree), "task", "review-full")).toEqual([]);
  });

  test("another task's worktree of the same repository is refused at check and record --bypass, even with the right --task", () => {
    const { project, ledger, grantPath } = granted();
    const other = join(dir("ak-bypass-wt-"), "other");
    git(project, "worktree", "add", "-q", "-b", "other", other);
    const r = ak(other, ledger, "bypass", "check", "--grant", grantPath, "--task", "T-1", "--phase", "super-align");
    expect(r.code).toBe(1);
    expect(r.err).toContain("is for worktree");
    expect(existsSync(join(defaultEvidenceDir(other), "other", "bypass"))).toBe(false);
    const rec = ak(other, ledger, "record", "--gate", "review-full", "--bypass", grantPath, "--task", "T-1");
    expect(rec.code).toBe(1);
    expect(rec.err).toContain("is for worktree");
    expect(readRecords(defaultEvidenceDir(other), "other", "review-full")).toEqual([]);
  });

  test("grant refuses a worktree that is not one of the repository's", () => {
    const s = setup();
    const r = ak(
      s.home,
      s.ledger,
      "bypass",
      "grant",
      "--task",
      "T-1",
      "--by",
      "captain",
      "--reason",
      "r",
      "--out",
      s.grantPath,
      "--project",
      s.project,
      "--worktree",
      s.home,
    );
    expect(r.code).toBe(1);
    expect(r.err).toContain("is not one of the worktrees");
    expect(existsSync(s.grantPath)).toBe(false);
  });

  test("one grant carries the task from align through ship across the run super-build opens", () => {
    const { worktree, ledger, grantPath, home } = granted();
    const check = (phase: string) =>
      ak(worktree, ledger, "bypass", "check", "--grant", grantPath, "--task", "T-1", "--phase", phase);
    expect(check("super-align").code).toBe(0);
    expect(check("super-bound").code).toBe(0);
    const ticketPath = join(home, "ticket.json");
    writeFileSync(ticketPath, JSON.stringify({ id: "T-1" }));
    const opened = ak(worktree, ledger, "open", "--ticket", ticketPath);
    expect(opened.code).toBe(0);
    const run = opened.out.replace(/^opened run /, "");
    expect(run).not.toBe("task");
    expect(check("super-review:full").code).toBe(0);
    const record = (gate: string) =>
      ak(worktree, ledger, "record", "--gate", gate, "--bypass", grantPath, "--task", "T-1");
    expect(record("review-full").code).toBe(0);
    expect(check("super-ship").code).toBe(0);
    expect(record("ship-preflight").code).toBe(0);
    expect(JSON.parse(readFileSync(join(ledger, `${grantId(ledger)}.json`), "utf8"))).toMatchObject({
      runs: ["task", run],
    });
  });

  test("a phase-less check is a read-only probe and logs no run", () => {
    const { worktree, ledger, grantPath } = granted();
    expect(ak(worktree, ledger, "bypass", "check", "--grant", grantPath, "--task", "T-1").code).toBe(0);
    expect(JSON.parse(readFileSync(join(ledger, `${grantId(ledger)}.json`), "utf8"))).not.toHaveProperty("runs");
    expect(existsSync(join(defaultEvidenceDir(worktree), "task", "bypass"))).toBe(false);
  });
});

describe("a worker-authored grant is rejected", () => {
  test("grant refuses to run from a checkout of the repository it grants", () => {
    const s = setup();
    const r = ak(
      s.worktree,
      s.ledger,
      "bypass",
      "grant",
      "--task",
      "T-1",
      "--by",
      "captain",
      "--reason",
      "r",
      "--out",
      s.grantPath,
      "--project",
      s.project,
      "--worktree",
      s.worktree,
    );
    expect(r.code).toBe(1);
    expect(r.err).toContain("run it from outside the repository");
    expect(existsSync(s.grantPath)).toBe(false);
    expect(readdirSync(s.ledger)).toEqual([]);
  });

  test("grant refuses to write inside the worktree or the git directory", () => {
    const s = setup();
    for (const out of [
      join(s.worktree, "bypass.json"),
      join(git(s.project, "rev-parse", "--absolute-git-dir"), "bypass.json"),
    ]) {
      const r = ak(
        s.home,
        s.ledger,
        "bypass",
        "grant",
        "--task",
        "T-1",
        "--by",
        "captain",
        "--reason",
        "r",
        "--out",
        out,
        "--project",
        s.project,
        "--worktree",
        s.worktree,
      );
      expect(r.code).toBe(1);
      expect(r.err).toContain("which a worker in that repository can write");
    }
  });

  test("a grant file in the worktree is refused even with a matching ledger entry", () => {
    const { worktree, ledger, grantPath } = granted();
    const id = grantId(ledger);
    const inside = join(worktree, "bypass.json");
    const text = readFileSync(grantPath, "utf8");
    writeFileSync(inside, text);
    const sha = `sha256:${createHash("sha256").update(text).digest("hex")}`;
    writeFileSync(
      join(ledger, `${id}.json`),
      JSON.stringify({ grant_id: id, grant_path: realpathSync(inside), grant_sha256: sha }),
    );
    const r = ak(worktree, ledger, "bypass", "check", "--grant", inside, "--task", "T-1", "--phase", "super-align");
    expect(r.code).toBe(1);
    expect(r.err).toContain("which the worker can write");
  });
});

test(`the bundled ${GATE_FILE} carries bypass and refuses an absent grant under node`, () => {
  const s = setup();
  const { catalog } = loadCatalog(REPO);
  if (catalog === null) throw new Error("no catalog");
  const script = join(dir("ak-bypass-bundle-"), "ak-gate.mjs");
  const bundled = planBundle({ root: REPO, catalog }, "claude-code", {}).files.get(GATE_FILE);
  if (bundled === undefined) throw new Error(`no ${GATE_FILE} in the bundle`);
  writeFileSync(script, bundled.contents);
  const node = (...argv: string[]) => Bun.spawnSync(["node", script, ...argv], { cwd: s.worktree });
  // The bundle resolves the account's real ledger, so nothing here runs `grant`: a regression in its
  // guards would write there. The grant itself is exercised above against a temp ledger.
  expect(node().stderr.toString()).toContain("ak lifecycle bypass grant");
  const missing = node("bypass", "check", "--grant", s.grantPath, "--task", "T-1", "--phase", "super-align");
  expect(missing.exitCode).toBe(1);
  expect(missing.stderr.toString()).toContain("does not exist");
});
