/**
 * `ak lifecycle record|check`: the gate records the lifecycle phases leave, and the check super-ship
 * runs before it ships. Standalone only: every case is a plain temp git repository, with no Firstmate
 * home, binding or ledger anywhere.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "../../src/cli.ts";
import { loadCatalog } from "../../src/catalog/load.ts";
import { defaultEvidenceDir, PRE_SHIP_GATES, type Gate, type GateRecord } from "../../src/lifecycle/gate.ts";
import { GATE_FILE, planBundle } from "../../src/packaging/plan.ts";
import { makeTree } from "../helpers/tree.ts";

const REPO = join(import.meta.dir, "..", "..");

function git(cwd: string, ...args: string[]): string {
  const p = Bun.spawnSync(["git", ...args], {
    cwd,
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" },
  });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`);
  return p.stdout.toString().trim();
}

/** A repository on branch `feature`, one commit in, with the work uncommitted on top as a session leaves it. */
function repo(): string {
  const dir = makeTree({ "src/a.js": "export const a = 1;\n" });
  git(dir, "init", "-q", "-b", "main");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  git(dir, "checkout", "-q", "-b", "feature");
  writeFileSync(join(dir, "src/a.js"), "export const a = 2;\n");
  return dir;
}

function ak(cwd: string, ...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = runCli(["lifecycle", ...argv], { cwd, io: { out: (l) => out.push(l), err: (l) => err.push(l) } });
  return { code, out, err: err.join("\n") };
}

const record = (cwd: string, ...gates: Gate[]) => {
  for (const g of gates) expect(ak(cwd, "record", "--gate", g).code).toBe(0);
};

function ticket(cwd: string, id: string): string {
  const path = join(cwd, `${id}.json`);
  writeFileSync(path, `${JSON.stringify({ schema: "ticket", schema_version: 1, id })}\n`);
  return path;
}

function open(cwd: string, id: string): string {
  const ticketPath = ticket(cwd, id);
  const base = git(cwd, "rev-parse", "HEAD");
  const r = ak(cwd, "open", "--ticket", ticketPath);
  expect(r.code).toBe(0);
  const match = r.out[0]?.match(/^opened run (.+)$/);
  expect(match).not.toBeNull();
  const run = match![1]!;
  const metadata = JSON.parse(readFileSync(join(defaultEvidenceDir(cwd), "runs", run, "run.json"), "utf8"));
  expect(metadata).toEqual({
    run_id: run,
    ticket: { id, hash: `sha256:${createHash("sha256").update(readFileSync(ticketPath)).digest("hex")}` },
    opened_at: expect.any(String),
    branch: "feature",
    base,
  });
  return run;
}

describe("ak lifecycle check, standalone", () => {
  test("a run with every phase's record for the head passes", () => {
    const dir = repo();
    record(dir, ...PRE_SHIP_GATES);
    const r = ak(dir, "check");
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(r.out[0]).toContain(`ok: run feature has current evidence for ${PRE_SHIP_GATES.join(", ")}`);
  });

  for (const missing of PRE_SHIP_GATES) {
    test(`refuses when ${missing} left no record`, () => {
      const dir = repo();
      record(dir, ...PRE_SHIP_GATES.filter((g) => g !== missing));
      const r = ak(dir, "check");
      expect(r.code).toBe(1);
      expect(r.err).toContain(`refused: gate ${missing} has no current evidence`);
      for (const other of PRE_SHIP_GATES.filter((g) => g !== missing)) expect(r.err).not.toContain(`gate ${other} `);
    });
  }

  test("a record for an earlier state of the tree is stale", () => {
    const dir = repo();
    record(dir, ...PRE_SHIP_GATES);
    writeFileSync(join(dir, "src/a.js"), "export const a = 3;\n");
    const r = ak(dir, "check");
    expect(r.code).toBe(1);
    expect(r.err).toContain("refused: gate verify has no current evidence (the latest record is for");
    expect(r.err).toContain("refused: gate review-readiness has no current evidence");
    // build-checks and review-full were on this revision, which is still the head's.
    expect(r.err).not.toContain("gate build-checks");
  });

  test("refusal messages name the latest record by recorded time", () => {
    const dir = repo();
    record(dir, "verify", "review-full");
    writeFileSync(join(dir, "src/a.js"), "export const a = 3;\n");
    record(dir, "verify", "review-full");

    const latest: Partial<Record<Gate, GateRecord>> = {};
    for (const gate of ["verify", "review-full"] as const) {
      const evidence = join(defaultEvidenceDir(dir), "feature", gate);
      const files = readdirSync(evidence).filter((name) => name.endsWith(".json")).sort();
      expect(files).toHaveLength(2);
      for (const [index, file] of files.entries()) {
        const path = join(evidence, file);
        const gateRecord = JSON.parse(readFileSync(path, "utf8")) as GateRecord;
        gateRecord.recorded_at = index === 0 ? "2026-01-02T00:00:00.000Z" : "2026-01-01T00:00:00.000Z";
        writeFileSync(path, `${JSON.stringify(gateRecord, null, 2)}\n`);
        if (index === 0) latest[gate] = gateRecord;
      }
    }

    writeFileSync(join(dir, "src/a.js"), "export const a = 4;\n");
    const r = ak(dir, "check", "--gates", "verify,review-full");
    expect(r.code).toBe(1);
    for (const gate of ["verify", "review-full"] as const) {
      const snapshot = latest[gate]!.snapshot;
      const named = `${snapshot.revision.slice(0, 12)}/${snapshot.diff_hash.replace(/^sha256:/, "").slice(0, 12)}`;
      expect(r.err).toContain(gate === "verify" ? `the latest record is for ${named}` : `the full review is for ${named}`);
    }
  });

  test("a record without a recorded time is ignored, not trusted and not fatal", () => {
    const dir = repo();
    record(dir, ...PRE_SHIP_GATES);
    const evidence = join(defaultEvidenceDir(dir), "feature", "verify");
    const [file] = readdirSync(evidence).filter((name) => name.endsWith(".json"));
    const good = JSON.parse(readFileSync(join(evidence, file!), "utf8")) as Partial<GateRecord>;
    delete good.recorded_at;
    writeFileSync(join(evidence, "zz-foreign.json"), `${JSON.stringify(good, null, 2)}\n`);
    expect(ak(dir, "check").code).toBe(0);

    writeFileSync(join(evidence, file!), `${JSON.stringify(good, null, 2)}\n`);
    const r = ak(dir, "check");
    expect(r.code).toBe(1);
    expect(r.err).toContain("refused: gate verify has no current evidence (no record for run feature");
  });

  test("a full review at H1 plus a delta review after a fix at H2 passes without another full review", () => {
    const dir = repo();
    const run = open(dir, "fix-cycle");
    record(dir, "build-checks", "verify", "review-full");
    git(dir, "commit", "-qam", "build");
    writeFileSync(join(dir, "src/a.js"), "export const a = 4;\n"); // the fix for a review finding
    record(dir, "verify", "review-readiness");
    expect(ak(dir, "check").err).toContain("refused: gate review-full has no current evidence (the full review is for");
    record(dir, "review-delta");
    const checked = ak(dir, "check");
    expect(checked.code).toBe(0);
    expect(checked.out[0]).toContain(`ok: run ${run}`);
    expect(readdirSync(join(defaultEvidenceDir(dir), run, "review-full")).filter((name) => name.endsWith(".json"))).toHaveLength(1);
  });

  test("build-checks from another line of history does not count", () => {
    const dir = repo();
    git(dir, "commit", "-qam", "elsewhere");
    record(dir, "build-checks");
    git(dir, "reset", "-q", "--hard", "main"); // the built commit is no longer in this branch's history
    writeFileSync(join(dir, "src/a.js"), "export const a = 5;\n");
    record(dir, "verify", "review-full", "review-readiness");
    const r = ak(dir, "check");
    expect(r.code).toBe(1);
    expect(r.err).toContain("refused: gate build-checks has no current evidence (every record is for a revision that is not an ancestor");
  });

  test("a branch name reused after its run was merged does not inherit that run's records", () => {
    const dir = repo();
    record(dir, "build-checks");
    git(dir, "commit", "-qam", "build");
    record(dir, ...PRE_SHIP_GATES);
    expect(ak(dir, "check").code).toBe(0);
    git(dir, "checkout", "-q", "main");
    git(dir, "merge", "-q", "--no-ff", "-m", "merge feature", "feature");
    git(dir, "checkout", "-q", "feature");
    git(dir, "merge", "-q", "--ff-only", "main");
    writeFileSync(join(dir, "src/a.js"), "export const a = 6;\n"); // new work that skips super-build
    record(dir, "verify", "review-delta", "review-readiness");
    const r = ak(dir, "check");
    expect(r.code).toBe(1);
    expect(r.err).toContain("refused: gate build-checks has no current evidence (every record is for a revision that is not an ancestor");
    expect(r.err).toContain("since it left main at");
    expect(r.err).toContain("refused: gate review-full has no current evidence");
  });

  test("the v1 branch run warns when a squash reuse inherits records", () => {
    const dir = repo();
    record(dir, "build-checks");
    git(dir, "commit", "-qam", "task one");
    record(dir, ...PRE_SHIP_GATES);
    expect(ak(dir, "check").code).toBe(0);

    git(dir, "checkout", "-q", "main");
    git(dir, "merge", "-q", "--squash", "feature");
    git(dir, "commit", "-qm", "squash task one");
    git(dir, "checkout", "-q", "feature");
    git(dir, "merge", "-q", "--no-edit", "main");
    writeFileSync(join(dir, "src/a.js"), "export const a = 7;\n");
    record(dir, "verify", "review-delta", "review-readiness");

    const inherited = ak(dir, "check");
    expect(inherited.code).toBe(0);
    expect(inherited.err).toContain(
      "note: build-checks for run feature was recorded before this branch last took main (",
    );
    expect(inherited.err).toContain("if this branch was reused for a new task, open a new run (known limit, gate.ts:5-8)");
  });

  test("on a clone, the note and the refusal name the default branch, not the remote HEAD ref", () => {
    const seed = makeTree({ "src/a.js": "export const a = 1;\n" });
    git(seed, "init", "-q", "-b", "main");
    git(seed, "add", "-A");
    git(seed, "commit", "-q", "-m", "init");
    const root = realpathSync(mkdtempSync(join(tmpdir(), "ak-gate-clone-")));
    git(root, "clone", "-q", "--bare", seed, "origin.git");
    git(root, "clone", "-q", "origin.git", "work");
    const dir = join(root, "work");
    git(dir, "checkout", "-q", "-b", "feature");
    writeFileSync(join(dir, "src/a.js"), "export const a = 2;\n");
    record(dir, "build-checks");
    git(dir, "commit", "-qam", "task one");
    record(dir, ...PRE_SHIP_GATES);

    git(dir, "checkout", "-q", "main");
    git(dir, "merge", "-q", "--squash", "feature");
    git(dir, "commit", "-qm", "squash task one");
    git(dir, "push", "-q", "origin", "main");
    git(dir, "checkout", "-q", "feature");
    git(dir, "merge", "-q", "--no-edit", "origin/main");
    writeFileSync(join(dir, "src/a.js"), "export const a = 7;\n");
    record(dir, "verify", "review-delta", "review-readiness");

    const inherited = ak(dir, "check");
    expect(inherited.code).toBe(0);
    expect(inherited.err).toContain("note: build-checks for run feature was recorded before this branch last took main (");

    git(dir, "reset", "-q", "--hard", "origin/main");
    writeFileSync(join(dir, "src/a.js"), "export const a = 8;\n");
    record(dir, "verify", "review-delta", "review-readiness");
    const refused = ak(dir, "check");
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("since it left main at");
    expect(refused.err).not.toContain("refs/remotes/origin/HEAD");
  });

  test("an explicit fresh run inherits no records", () => {
    const dir = repo();
    record(dir, ...PRE_SHIP_GATES);
    const freshRun = ak(dir, "check", "--run", "task-2");
    expect(freshRun.code).toBe(1);
    for (const gate of PRE_SHIP_GATES) {
      expect(freshRun.err).toContain(`refused: gate ${gate} has no current evidence (no record for run task-2`);
    }
  });

  test("a closed strengthened run rejects squash reuse and a newly opened run sees none of its records", () => {
    const dir = repo();
    const first = open(dir, "task-1");
    record(dir, ...PRE_SHIP_GATES, "ship-preflight");
    const closed = JSON.parse(readFileSync(join(defaultEvidenceDir(dir), "runs", first, "run.json"), "utf8"));
    expect(closed.closed_at).toEqual(expect.any(String));
    expect(ak(dir, "record", "--gate", "verify").err).toContain("run closed; open a new run");

    git(dir, "add", "task-1.json");
    git(dir, "commit", "-qm", "task one");
    git(dir, "checkout", "-q", "main");
    git(dir, "merge", "-q", "--squash", "feature");
    git(dir, "commit", "-qm", "squash task one");
    git(dir, "checkout", "-q", "feature");
    git(dir, "merge", "-q", "--no-edit", "main");
    writeFileSync(join(dir, "src/a.js"), "export const a = 8;\n");
    expect(ak(dir, "record", "--gate", "verify").err).toContain("run closed; open a new run");

    const second = open(dir, "task-2");
    expect(second).not.toBe(first);
    const checked = ak(dir, "check");
    expect(checked.code).toBe(1);
    expect(checked.err).toContain(`gate build-checks has no current evidence (no record for run ${second}`);
    expect(checked.err).toContain(`gate review-full has no current evidence (no record for run ${second}`);
  });

  test("commits and a mid-task merge from main keep the opened run id and its earlier records", () => {
    const dir = repo();
    const run = open(dir, "continuation");
    record(dir, "build-checks", "verify", "review-full");
    git(dir, "add", "continuation.json");
    git(dir, "commit", "-qam", "first task commit");

    git(dir, "checkout", "-q", "main");
    writeFileSync(join(dir, "main.txt"), "upstream\n");
    git(dir, "add", "main.txt");
    git(dir, "commit", "-qm", "main advances");
    git(dir, "checkout", "-q", "feature");
    git(dir, "merge", "-q", "--no-edit", "main");
    writeFileSync(join(dir, "src/a.js"), "export const a = 9;\n");
    record(dir, "verify", "review-delta", "review-readiness");

    const checked = ak(dir, "check");
    expect(checked.code).toBe(0);
    expect(checked.err).toBe("");
    expect(checked.out[0]).toContain(`ok: run ${run}`);
    const pointer = JSON.parse(readFileSync(join(defaultEvidenceDir(dir), "branches", "feature.json"), "utf8"));
    expect(pointer.run_id).toBe(run);
  });

  test("work on the default branch itself keeps build-checks recorded before its commit", () => {
    const dir = repo();
    git(dir, "checkout", "-q", "main");
    record(dir, "build-checks");
    git(dir, "commit", "-qam", "build");
    record(dir, "verify", "review-full", "review-readiness");
    const r = ak(dir, "check");
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
  });

  test("records live under the git common directory, so a linked worktree's run is found from any worktree", () => {
    const dir = repo();
    git(dir, "commit", "-qam", "work");
    const linked = join(mkdtempSync(join(tmpdir(), "ak-wt-")), "wt");
    git(dir, "worktree", "add", "-q", "-b", "topic", linked);
    const r = ak(linked, "record", "--gate", "verify");
    expect(r.code).toBe(0);
    expect(r.out[0]).toContain(join(realpathSync(dir), ".git", "agent-kit", "evidence", "topic", "verify"));
    expect(ak(dir, "check", "--run", "topic", "--gates", "verify", "--project", linked).code).toBe(0);
    expect(git(dir, "status", "--porcelain")).toBe("");
  });

  test("an explicit run and directory are what a Firstmate worker passes, and a detached head needs one", () => {
    const dir = repo();
    const store = mkdtempSync(join(tmpdir(), "ak-store-"));
    expect(ak(dir, "record", "--gate", "verify", "--run", "ak-T-1", "--dir", store).code).toBe(0);
    expect(ak(dir, "check", "--gates", "verify", "--run", "ak-T-1", "--dir", store).code).toBe(0);
    expect(ak(dir, "check", "--gates", "verify").code).toBe(1);
    git(dir, "checkout", "-q", "--detach");
    const r = ak(dir, "check");
    expect(r.code).toBe(2);
    expect(r.err).toContain("pass --run <id>");
    expect(existsSync(join(store, "runs", "ak-T-1", "run.json"))).toBe(false);
    expect(existsSync(join(store, "branches"))).toBe(false);
  });

  test("bad usage exits 2 and names the gates", () => {
    const dir = repo();
    expect(ak(dir, "record", "--gate", "deploy").err).toContain("--gate must be one of build-checks");
    expect(ak(dir, "check", "--gates", "verify,merge").code).toBe(2);
    expect(ak(dir, "nope").code).toBe(2);
  });
});

describe("the gate a bundle carries", () => {
  test(`every host's bundle ships ${GATE_FILE}, and it runs under node with no checkout`, () => {
    const { catalog } = loadCatalog(REPO);
    if (catalog === null) throw new Error("no catalog");
    const dir = repo();
    for (const host of ["claude-code", "codex"] as const) {
      const file = planBundle({ root: REPO, catalog }, host, {}).files.get(GATE_FILE);
      expect(file?.contents).toContain("ak lifecycle");
      const script = join(mkdtempSync(join(tmpdir(), "ak-bin-")), "ak-gate.mjs");
      writeFileSync(script, file!.contents);
      const node = (...argv: string[]) => Bun.spawnSync(["node", script, ...argv], { cwd: dir });
      const ticketPath = ticket(dir, `${host}-ticket`);
      const opened = node("open", "--ticket", ticketPath);
      expect(opened.exitCode).toBe(0);
      expect(opened.stdout.toString()).toMatch(/^opened run feature-[0-9a-f]{12}\n$/);
      expect(node("record", "--gate", "verify", "--run", host).exitCode).toBe(0);
      const ok = node("check", "--gates", "verify", "--run", host);
      expect(ok.stdout.toString()).toContain(`ok: run ${host} has current evidence for verify`);
      const refused = node("check", "--run", host);
      expect(refused.exitCode).toBe(1);
      expect(refused.stderr.toString()).toContain("refused: gate build-checks has no current evidence");
    }
  });
});
