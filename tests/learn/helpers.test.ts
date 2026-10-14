import { expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { run } from "../../src/learn/core/proc.ts";
import { gitRepo, memoryFixture, scratch } from "./helpers.ts";

const git = (cwd: string, ...args: string[]) => run(["git", ...args], { cwd });

test("project fixture copies keep files, index, refs and config private", () => {
  const first = gitRepo(join(scratch(), "first"));
  const second = gitRepo(join(scratch(), "second"));
  const head = git(second, "rev-parse", "HEAD").stdout;
  expect(existsSync(join(first, ".git", "info", "exclude"))).toBe(true);
  writeFileSync(join(first, "README.md"), "private edit\n");
  expect(git(first, "add", "README.md").code).toBe(0);
  expect(git(first, "branch", "private-branch").code).toBe(0);
  expect(git(first, "config", "fixture.marker", "private").code).toBe(0);
  expect(git(second, "status", "--porcelain").stdout).toBe("");
  expect(git(second, "branch", "--list", "private-branch").stdout).toBe("");
  expect(git(second, "config", "--get", "fixture.marker").code).toBe(1);
  const fresh = gitRepo(join(scratch(), "fresh"));
  expect(git(fresh, "rev-parse", "HEAD").stdout).toBe(head);
  expect(git(fresh, "status", "--porcelain").stdout).toBe("");
  expect(readFileSync(join(fresh, "README.md"), "utf8")).toBe("fixture\n");
});

test("memory fixture commits cannot change another copy or the seed", () => {
  const first = memoryFixture(join(scratch(), "memory"));
  const second = memoryFixture(join(scratch(), "memory"));
  const head = second.head();
  writeFileSync(first.path("memory.md"), "private memory\n");
  expect(first.commit("private update")).not.toBeNull();
  expect(first.head()).not.toBe(head);
  expect(second.head()).toBe(head);
  expect(readFileSync(second.path("memory.md"), "utf8")).toBe("");
  const fresh = memoryFixture(join(scratch(), "memory"));
  expect(fresh.head()).toBe(head);
  expect(readFileSync(fresh.path("memory.md"), "utf8")).toBe("");
  expect(fresh.git(["status", "--porcelain"]).stdout).toBe("");
});
