/**
 * A git call that must print its answer can exit 0 with no output under host load. The gate must
 * read that silence as a failed call naming the command, never as a real answer: not as a missing
 * revision, not as "not a git checkout" with no evidence, and not as a detached head.
 *
 * Snapshot git is pinned to `/usr/bin` then `/bin` and never searches PATH, so a PATH shim cannot
 * produce that silence. These cases prove the shim is ignored: the real git still answers.
 */
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { isolatedGitArgv } from "../../src/lifecycle/git-isolation.ts";
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
  const match = silent.map((arg, i) => `[ "\${${i + 1}}" = ${JSON.stringify(arg)} ]`).join(" && ");
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

describe("a PATH git shim cannot silence a must-print call", () => {
  test("a clean snapshot still works: commands that legitimately print nothing are untouched", () => {
    const dir = repo();
    const snapshot = takeSnapshot(dir);
    if (!isSnapshot(snapshot)) throw new Error(snapshot);
    expect(snapshot.revision).toMatch(/^[0-9a-f]{40}$/);
  });

  test("takeSnapshot ignores a PATH git that would silence rev-parse HEAD", () => {
    const dir = repo();
    const argv = ["--no-replace-objects", ...isolatedGitArgv(dir, ["rev-parse", "HEAD"])];
    const snapshot = withSilentGit(argv, () => takeSnapshot(dir));
    if (!isSnapshot(snapshot)) throw new Error(snapshot);
    expect(snapshot.revision).toMatch(/^[0-9a-f]{40}$/);
  });

  test("takeSnapshot ignores a PATH git that would silence rev-parse --git-path index", () => {
    const dir = repo();
    const prefix = ["--no-replace-objects", ...isolatedGitArgv(dir, ["rev-parse", "--git-path"])];
    const snapshot = withSilentGit(prefix, () => takeSnapshot(dir));
    if (!isSnapshot(snapshot)) throw new Error(snapshot);
    expect(snapshot.revision).toMatch(/^[0-9a-f]{40}$/);
  });

  test("defaultEvidenceDir ignores a PATH git that would silence rev-parse --git-common-dir", () => {
    const dir = repo();
    const evidence = withSilentGit(["rev-parse", "--git-common-dir"], () => defaultEvidenceDir(dir));
    expect(evidence).toContain("agent-kit/evidence");
  });

  test("openRun does not read a PATH-silenced symbolic-ref as a detached head", () => {
    const dir = repo();
    const opened = withSilentGit(["symbolic-ref"], () =>
      openRun({ dir: join(dir, "evidence"), project: dir, ticket: join(dir, "ticket.json") }),
    );
    if (!opened.ok) expect(opened.reason).not.toContain("no output");
  });

  test("a run resolved from the branch does not read a PATH-silenced symbolic-ref as a detached head", () => {
    const dir = repo();
    const err: string[] = [];
    const io = { out: () => {}, err: (line: string) => err.push(line) };
    const code = withSilentGit(["symbolic-ref"], () =>
      main(["check", "--dir", join(dir, "evidence"), "--project", dir, "--gates", "build"], io, dir),
    );
    expect(code).not.toBe(0);
    expect(err.join("\n")).not.toContain("detached head");
    expect(err.join("\n")).not.toContain("no output");
  });

  test("checkGates does not drop the fork bound when a PATH git would silence a fork probe", () => {
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
      expect(result.refusals.join("\n")).not.toContain("no output");
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

  test("grantBypass ignores a PATH git that would silence the checkout probe", () => {
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
      expect(granted.ok).toBe(true);
    }
  });
});
