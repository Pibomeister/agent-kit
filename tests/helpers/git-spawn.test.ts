import { spawnSync } from "node:child_process";

import { describe, expect, test } from "bun:test";

import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  GIT_SPAWN_ATTEMPTS,
  commandMustPrint,
  gitSpawnTransient,
  installedGitSpawn,
  retryGitSpawn,
} from "./git-spawn.ts";

describe("git spawn retry", () => {
  test("a spawn error or a null status is transient", () => {
    expect(
      gitSpawnTransient(["status"], {
        status: null,
        stdout: "",
        stderr: "",
        error: new Error("spawn git EAGAIN"),
      }),
    ).toBe(true);
    expect(gitSpawnTransient(["status"], { status: null, stdout: "", stderr: "" })).toBe(true);
  });

  test("a finished git process is final, including a clean status and a fatal exit", () => {
    expect(gitSpawnTransient(["status", "--porcelain"], { status: 0, stdout: "", stderr: "" })).toBe(false);
    expect(gitSpawnTransient(["rev-parse", "HEAD"], { status: 128, stdout: "", stderr: "fatal" })).toBe(false);
  });

  test("a rev-parse that exits 0 without output is transient, and one that prints is not", () => {
    expect(gitSpawnTransient(["rev-parse", "--git-common-dir"], { status: 0, stdout: "", stderr: "" })).toBe(true);
    expect(gitSpawnTransient(["rev-parse", "--git-common-dir"], { status: 0, stdout: ".git\n", stderr: "" })).toBe(
      false,
    );
    expect(gitSpawnTransient(["log", "-1", "--format=%H"], { status: 0, stdout: "\n", stderr: "" })).toBe(true);
    expect(gitSpawnTransient(["show", "--name-only", "--format="], { status: 0, stdout: "", stderr: "" })).toBe(false);
  });

  test("retries at most three times and stops when git finishes", () => {
    const seen: number[] = [];
    const result = retryGitSpawn(["rev-parse", "HEAD"], () => {
      seen.push(seen.length);
      if (seen.length < GIT_SPAWN_ATTEMPTS) return { status: null, stdout: "", stderr: "" };
      return { status: 0, stdout: "abc\n", stderr: "" };
    });
    expect(seen).toEqual([0, 1, 2]);
    expect(result.stdout).toBe("abc\n");
  });

  test("does not spawn git again after a nonzero exit", () => {
    let calls = 0;
    const result = retryGitSpawn(["rev-parse", "HEAD"], () => {
      calls += 1;
      return { status: 128, stdout: "", stderr: "fatal" };
    });
    expect(calls).toBe(1);
    expect(result.status).toBe(128);
  });

  test("the suite's spawnSync(git) is the retrying wrapper", () => {
    expect(spawnSync).toBe(installedGitSpawn());
    const version = spawnSync("git", ["--version"], { encoding: "utf8" });
    expect(version.status).toBe(0);
    expect(version.stdout).toContain("git version");
  });

  test("an empty ls-tree is tried again, and a path that stays empty is still empty", () => {
    expect(commandMustPrint(["ls-tree", "--full-tree", "-z", "abc", "--", "missing"])).toBe(true);
    const previous = process.env.AK_GIT_SHIM;
    delete process.env.AK_GIT_SHIM;
    try {
      let absent = 0;
      const missing = retryGitSpawn(["ls-tree", "--full-tree", "-z", "abc", "--", "missing"], () => {
        absent += 1;
        return { status: 0, stdout: "", stderr: "" };
      });
      expect(absent).toBe(GIT_SPAWN_ATTEMPTS);
      expect(missing.status).toBe(0);
      expect(missing.stdout).toBe("");
      let found = 0;
      const listed = retryGitSpawn(["ls-tree", "HEAD", "--", "skills/kept"], () => {
        found += 1;
        if (found < 2) return { status: 0, stdout: "", stderr: "" };
        return { status: 0, stdout: "100644 blob abc\tskills/kept\0", stderr: "" };
      });
      expect(found).toBe(2);
      expect(listed.status).toBe(0);
      expect(listed.stdout).toContain("skills/kept");
      let failed = 0;
      const fatal = retryGitSpawn(["ls-tree", "HEAD", "--", "skills/kept"], () => {
        failed += 1;
        return { status: 128, stdout: "", stderr: "fatal" };
      });
      expect(failed).toBe(1);
      expect(fatal.status).toBe(128);
    } finally {
      if (previous === undefined) delete process.env.AK_GIT_SHIM;
      else process.env.AK_GIT_SHIM = previous;
    }
  });

  test("a silent success is not a lost read", () => {
    expect(commandMustPrint(["symbolic-ref", "-d", "refs/remotes/origin/HEAD"])).toBe(false);
    expect(commandMustPrint(["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"])).toBe(false);
    expect(commandMustPrint(["merge-base", "--is-ancestor", "a", "HEAD"])).toBe(false);
    expect(commandMustPrint(["symbolic-ref", "--quiet", "--short", "HEAD"])).toBe(true);
    expect(commandMustPrint(["merge-base", "HEAD", "main"])).toBe(true);
    expect(
      gitSpawnTransient(["symbolic-ref", "-d", "refs/remotes/origin/HEAD"], { status: 0, stdout: "", stderr: "" }),
    ).toBe(false);
  });

  test("the path shim retries an empty rev-parse and execs a symbolic-ref delete once", () => {
    const dir = mkdtempSync(join(tmpdir(), "ak-git-retry-"));
    try {
      const log = join(dir, "log");
      const fake = join(dir, "git-real");
      writeFileSync(log, "");
      writeFileSync(
        fake,
        `#!/bin/sh
printf '%s\\n' "$*" >> "${log}"
case "$*" in
  *rev-parse*)
    n=$(grep -c rev-parse "${log}")
    if [ "$n" -lt 3 ]; then exit 0; fi
    printf '.git\\n'
    exit 0
    ;;
esac
exit 0
`,
        { mode: 0o755 },
      );
      chmodSync(fake, 0o755);
      const shim = join(import.meta.dir, "git-retry.sh");
      chmodSync(shim, 0o755);
      const deleted = spawnSync(shim, ["symbolic-ref", "-d", "refs/remotes/origin/HEAD"], {
        env: { ...process.env, AK_GIT_REAL: fake },
        encoding: "utf8",
      });
      expect(deleted.status).toBe(0);
      const parsed = spawnSync(shim, ["rev-parse", "--git-common-dir"], {
        env: { ...process.env, AK_GIT_REAL: fake },
        encoding: "utf8",
      });
      expect(parsed.status).toBe(0);
      expect(parsed.stdout).toBe(".git\n");
      const lines = readFileSync(log, "utf8").trim().split("\n");
      expect(lines.filter((line) => line.includes("symbolic-ref"))).toEqual([
        "symbolic-ref -d refs/remotes/origin/HEAD",
      ]);
      expect(lines.filter((line) => line.includes("rev-parse"))).toHaveLength(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the path shim retries an empty ls-tree and keeps a path that is still missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "ak-git-ls-tree-"));
    try {
      const log = join(dir, "log");
      const fake = join(dir, "git-real");
      writeFileSync(log, "");
      writeFileSync(
        fake,
        `#!/bin/sh
printf '%s\\n' "$*" >> "${log}"
case "$*" in
  *best-practice*)
    n=$(grep -c best-practice "${log}")
    if [ "$n" -lt 2 ]; then exit 0; fi
    printf '100644 blob f52ec051\\tskills/best-practice-research/SKILL.md\\n'
    exit 0
    ;;
  *missing*)
    exit 0
    ;;
  *)
    exit 2
    ;;
esac
`,
        { mode: 0o755 },
      );
      chmodSync(fake, 0o755);
      const shim = join(import.meta.dir, "git-retry.sh");
      const env = { ...process.env, AK_GIT_REAL: fake };
      const recovered = spawnSync(
        shim,
        ["ls-tree", "--full-tree", "-z", "pin", "--", "skills/best-practice-research/SKILL.md"],
        {
          env,
          encoding: "utf8",
        },
      );
      expect(recovered.status).toBe(0);
      expect(recovered.stdout).toContain("skills/best-practice-research/SKILL.md");
      const absent = spawnSync(shim, ["ls-tree", "--full-tree", "-z", "pin", "--", "missing"], {
        env,
        encoding: "utf8",
      });
      expect(absent.status).toBe(0);
      expect(absent.stdout).toBe("");
      const fatal = spawnSync(shim, ["ls-tree", "HEAD"], { env, encoding: "utf8" });
      expect(fatal.status).toBe(2);
      const lines = readFileSync(log, "utf8").trim().split("\n");
      expect(lines.filter((line) => line.includes("best-practice"))).toHaveLength(2);
      expect(lines.filter((line) => line.includes("missing"))).toHaveLength(3);
      expect(lines.filter((line) => line === "ls-tree HEAD")).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
