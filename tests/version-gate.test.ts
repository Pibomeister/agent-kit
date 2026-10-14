import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = join(import.meta.dir, "../tools/publish/version-gate.sh");
const roots: string[] = [];
const templates = mkdtempSync(join(tmpdir(), "ak-version-templates-"));
const remoteTemplate = join(templates, "remote.git");
const workTemplate = join(templates, "work");
const publishedRemoteTemplates = new Map<string, string>();
beforeAll(() => {
  git(templates, "init", "-q", "--bare", remoteTemplate);
  git(templates, "init", "-q", workTemplate);
  seedPublishedRemote(["0.1.0", "old"]);
  seedPublishedRemote(["0.1.0", "old"], true);
  seedPublishedRemote(["0.2.0", "old"]);
  seedPublishedRemote(["0.1.0-dev", "old"]);
  seedPublishedRemote(["0.1.0", "same"]);
});
afterAll(() => rmSync(templates, { recursive: true, force: true }));
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]) {
  const run = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });
  if (run.status !== 0) throw new Error(run.stderr);
}

function bundle(dir: string, version: unknown, skill: string) {
  mkdirSync(join(dir, "claude-code/.claude-plugin"), { recursive: true });
  writeFileSync(join(dir, "claude-code/.claude-plugin/plugin.json"), JSON.stringify({ name: "ak", version }));
  writeFileSync(join(dir, "claude-code/SKILL.md"), skill);
}

function publishedKey(published: [string, string], omitPublishedManifest = false) {
  return JSON.stringify([published, omitPublishedManifest]);
}

function seedPublishedRemote(published: [string, string], omitPublishedManifest = false) {
  const remote = join(templates, `published-${publishedRemoteTemplates.size}.git`);
  const release = join(templates, `published-${publishedRemoteTemplates.size}-work`);
  cpSync(remoteTemplate, remote, { recursive: true });
  cpSync(workTemplate, release, { recursive: true });
  bundle(join(release, "dist"), ...published);
  if (omitPublishedManifest) rmSync(join(release, "dist/claude-code/.claude-plugin/plugin.json"));
  git(release, "add", "dist");
  git(release, "commit", "-qm", "publish");
  git(release, "push", "-q", remote, "HEAD:refs/heads/published");
  publishedRemoteTemplates.set(publishedKey(published, omitPublishedManifest), remote);
}

function gate(
  published: [string, string] | null,
  built: [unknown, string],
  packageVersion = built[0],
  origin = "",
  omitPublishedManifest = false,
) {
  return spawnSync("sh", [script, "dist"], {
    cwd: gateWork(published, built, packageVersion, origin, omitPublishedManifest),
    encoding: "utf8",
  });
}

async function gateAsync(published: [string, string], built: [string, string]) {
  const child = Bun.spawn(["sh", script, "dist"], {
    cwd: gateWork(published, built),
    stdout: "ignore",
    stderr: "ignore",
  });
  return { status: await child.exited };
}

function gateWork(
  published: [string, string] | null,
  built: [unknown, string],
  packageVersion = built[0],
  origin = "",
  omitPublishedManifest = false,
) {
  const root = mkdtempSync(join(tmpdir(), "ak-version-gate-"));
  roots.push(root);
  const work = join(root, "work");
  const sourceRemote =
    published === null ? remoteTemplate : publishedRemoteTemplates.get(publishedKey(published, omitPublishedManifest));
  if (sourceRemote === undefined)
    throw new Error(`missing published fixture ${publishedKey(published, omitPublishedManifest)}`);
  cpSync(workTemplate, work, { recursive: true });
  appendFileSync(
    join(work, ".git/config"),
    `\n[remote "origin"]\n\turl = ${origin || sourceRemote}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`,
  );
  writeFileSync(join(work, "package.json"), JSON.stringify({ version: packageVersion }));
  bundle(join(work, "dist"), ...built);
  return work;
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

  test("refuses unreadable published manifest even with a new current version", () => {
    const run = gate(["0.1.0", "old"], ["0.2.0", "new"], "0.2.0", "", true);
    expect(run.status).toBe(1);
  });

  test("refuses a changed bundle published at a lower version", () => {
    const run = gate(["0.2.0", "old"], ["0.1.0", "new"]);
    expect(run.status).toBe(1);
  });

  test("release outranks its prerelease, but a prerelease cannot replace the release", async () => {
    const [release, prerelease] = await Promise.all([
      gateAsync(["0.1.0-dev", "old"], ["0.1.0", "new"]),
      gateAsync(["0.1.0", "old"], ["0.1.0-dev", "new"]),
    ]);
    expect(release.status).toBe(0);
    expect(prerelease.status).toBe(1);
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

  test("refuses a non-string catalog version package.json does not match", () => {
    const run = gate(null, [{ unexpected: "manifest" }, "new"], { unexpected: "package" });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("catalog.yaml version { unexpected: 'manifest' }");
    expect(run.stderr).toContain("package.json version { unexpected: 'package' } differ");
  });
});
