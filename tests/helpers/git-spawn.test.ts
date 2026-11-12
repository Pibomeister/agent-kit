import { spawnSync } from "node:child_process";

import { describe, expect, test } from "bun:test";

import { GIT_SPAWN_ATTEMPTS, gitSpawnTransient, installedGitSpawn, retryGitSpawn } from "./git-spawn.ts";

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
});
