/**
 * A git call that must print its answer can exit 0 with no output under host load. The gate must
 * read that silence as a failed call naming the command, never as a real answer: not as a missing
 * revision, not as "not a git checkout" with no evidence, and not as a detached head.
 *
 * The stub is a PATH shim named `git`: for the one argv the case selects it exits 0 silently, and
 * every other call execs the real git, so the callers run against a real repository throughout.
 */
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  checkGates,
  defaultEvidenceDir,
  grantBypass,
  main,
  openRun,
  takeSnapshot,
  type Snapshot,
} from "../../src/lifecycle/gate.ts";
import { makeTree } from "../helpers/tree.ts";

setDefaultTimeout(60_000);

function git(cwd: string, ...args: string[]): string {
  const run = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.invalid",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.invalid",
    },
  });
  if (run.status !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr ?? ""}`);
  return (run.stdout ?? "").trim();
}

function repo(): string {
  const dir = makeTree({ "src/a.js": "export const a = 1;\n" }, { provenance: false });
  git(dir, "init", "-q", "-b", "main");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  git(dir, "checkout", "-q", "-b", "feature");
  return dir;
}

/**
 * Run `body` with a `git` shim first on PATH. The shim exits 0 with no output when argv starts
 * with `silent` (for example `["rev-parse", "--git-path"]`) and delegates everything else.
 */
function withSilentGit<T>(silent: readonly string[], body: () => T): T {
  const realGit = Bun.which("git");
  if (realGit === null) throw new Error("git is not on PATH");
  const shim = makeTree({}, { provenance: false });
  const match = silent.map((arg, i) => `[ "$${i + 1}" = '${arg}' ]`).join(" && ");
  writeFileSync(join(shim, "git"), `#!/bin/sh\nif ${match}; then exit 0; fi\nexec "${realGit}" "$@"\n`);
  chmodSync(join(shim, "git"), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${shim}:${path ?? ""}`;
  try {
    return body();
  } finally {
    process.env.PATH = path;
  }
}

const isSnapshot = (s: Snapshot | string): s is Snapshot => Object(s) === s;

/** The refusal a silent call must produce; a snapshot here means the silence was read as an answer. */
function refusal(snapshot: Snapshot | string): string {
  if (isSnapshot(snapshot)) throw new Error(`expected a refusal, got a snapshot of ${snapshot.revision}`);
  return snapshot;
}

describe("a must-print git call that exits 0 silently", () => {
  test("a clean snapshot still works: commands that legitimately print nothing are untouched", () => {
    const dir = repo();
    const snapshot = takeSnapshot(dir);
    if (!isSnapshot(snapshot)) throw new Error(snapshot);
    expect(snapshot.revision).toMatch(/^[0-9a-f]{40}$/);
  });

  test("takeSnapshot refuses a silent rev-parse HEAD, naming the command", () => {
    const dir = repo();
    const text = refusal(withSilentGit(["rev-parse", "HEAD"], () => takeSnapshot(dir)));
    expect(text).toContain("git rev-parse HEAD");
    expect(text).toContain("no output");
  });

  test("takeSnapshot refuses a silent rev-parse --git-path index, naming the command", () => {
    const dir = repo();
    const text = refusal(withSilentGit(["rev-parse", "--git-path"], () => takeSnapshot(dir)));
    expect(text).toContain("git rev-parse --git-path index");
    expect(text).toContain("no output");
  });

  test("defaultEvidenceDir refuses a silent rev-parse --git-common-dir, naming the command", () => {
    const dir = repo();
    let message = "";
    try {
      withSilentGit(["rev-parse", "--git-common-dir"], () => defaultEvidenceDir(dir));
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    expect(message).toContain("git rev-parse --git-common-dir");
    expect(message).toContain("no output");
  });

  test("openRun does not read a silent symbolic-ref as a detached head", () => {
    const dir = repo();
    const opened = withSilentGit(["symbolic-ref"], () =>
      openRun({ dir: join(dir, "evidence"), project: dir, ticket: join(dir, "ticket.json") }),
    );
    expect(opened.ok).toBe(false);
    if (!opened.ok) {
      expect(opened.reason).toContain("git symbolic-ref --quiet --short HEAD");
      expect(opened.reason).toContain("no output");
    }
  });

  test("a run resolved from the branch does not read a silent symbolic-ref as a detached head", () => {
    const dir = repo();
    const err: string[] = [];
    const io = { out: () => {}, err: (line: string) => err.push(line) };
    const code = withSilentGit(["symbolic-ref"], () =>
      main(["check", "--dir", join(dir, "evidence"), "--project", dir, "--gates", "build"], io, dir),
    );
    expect(code).toBe(2);
    expect(err.join("\n")).not.toContain("detached head");
    expect(err.join("\n")).toContain("git symbolic-ref --quiet --short HEAD");
  });

  test("checkGates refuses rather than drop the fork bound when a fork probe goes silent", () => {
    const dir = repo();
    for (const silent of [["symbolic-ref"], ["merge-base"]]) {
      const result = withSilentGit(silent, () =>
        checkGates({
          dir: join(dir, "evidence"),
          run: "feature",
          gates: ["build-checks"],
          project: dir,
          forkBound: true,
        }),
      );
      expect(result.ok).toBe(false);
      expect(result.refusals.join("\n")).toContain(`git ${silent[0]}`);
      expect(result.refusals.join("\n")).toContain("no output");
    }
  });

  test("a dangling origin/HEAD is an absent default ref, not a failed call", () => {
    const dir = repo();
    git(dir, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/gone");
    const result = checkGates({
      dir: join(dir, "evidence"),
      run: "feature",
      gates: ["build-checks"],
      project: dir,
      forkBound: true,
    });
    expect(result.refusals.join("\n")).not.toContain("cannot find where this branch left the default branch");
    expect(result.refusals.join("\n")).toContain("no record for run feature");
  });

  test("grantBypass names the silent call instead of calling the project not a checkout", () => {
    const dir = repo();
    const outside = makeTree({}, { provenance: false });
    for (const silent of [
      ["rev-parse", "--git-common-dir"],
      ["worktree", "list"],
    ]) {
      const granted = withSilentGit(silent, () =>
        grantBypass({
          task: "t",
          project: dir,
          worktree: dir,
          by: "supervisor",
          reason: "r",
          out: join(outside, "grant.json"),
          hours: 1,
          cwd: outside,
          ledger: join(outside, "ledger"),
        }),
      );
      expect(granted.ok).toBe(false);
      if (!granted.ok) {
        expect(granted.reason).toContain(`git ${silent.join(" ")}`);
        expect(granted.reason).toContain("no output");
      }
    }
  });
});
