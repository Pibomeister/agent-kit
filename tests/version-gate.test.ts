import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = join(import.meta.dir, "../tools/publish/version-gate.sh");
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]) {
  const run = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });
  if (run.status !== 0) throw new Error(run.stderr);
}

function bundle(dir: string, version: string, skill: string) {
  mkdirSync(join(dir, "claude-code/.claude-plugin"), { recursive: true });
  writeFileSync(join(dir, "claude-code/.claude-plugin/plugin.json"), JSON.stringify({ name: "ak", version }));
  writeFileSync(join(dir, "claude-code/SKILL.md"), skill);
}

function gate(published: [string, string] | null, built: [string, string], packageVersion = built[0], origin = "") {
  const root = mkdtempSync(join(tmpdir(), "ak-version-gate-"));
  roots.push(root);
  const remote = join(root, "remote.git");
  const work = join(root, "work");
  git(root, "init", "-q", "--bare", remote);
  git(root, "init", "-q", work);
  if (published) {
    const release = join(root, "release");
    git(root, "init", "-q", release);
    bundle(join(release, "dist"), ...published);
    git(release, "add", "dist");
    git(release, "commit", "-qm", "publish");
    git(release, "push", "-q", remote, "HEAD:refs/heads/published");
  }
  git(work, "remote", "add", "origin", origin || remote);
  writeFileSync(join(work, "package.json"), JSON.stringify({ version: packageVersion }));
  bundle(join(work, "dist"), ...built);
  return spawnSync("sh", [script, "dist"], { cwd: work, encoding: "utf8" });
}

describe("bundle version gate", () => {
  test("refuses changed content at the published version", () => {
    const run = gate(["0.1.0", "old"], ["0.1.0", "new"]);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("without a catalog.yaml and package.json version bump");
  });

  test("accepts changed content with a version bump", () => {
    expect(gate(["0.1.0", "old"], ["0.2.0", "new"]).status).toBe(0);
  });

  test("accepts unchanged content at the published version", () => {
    expect(gate(["0.1.0", "same"], ["0.1.0", "same"]).status).toBe(0);
  });

  test("accepts a first publish when the published branch does not exist", () => {
    const run = gate(null, ["0.1.0", "new"]);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("first publish");
  });

  test("refuses when origin/published cannot be read", () => {
    const run = gate(null, ["0.1.0", "new"], "0.1.0", "/nonexistent/remote.git");
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("cannot read origin/published");
  });

  test("refuses a catalog bump package.json does not match", () => {
    const run = gate(["0.1.0", "old"], ["0.2.0", "new"], "0.1.0");
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("package.json version 0.1.0 differ");
  });
});
