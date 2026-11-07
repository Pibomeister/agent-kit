import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { appendFileSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Ajv from "ajv";
import { parse as parseYaml } from "yaml";
import { processScratch } from "./helpers/process-tmp.ts";

type WorkflowStep = { uses?: string; with?: { ref?: string }; run?: string; if?: string };
type WorkflowJob = { if: string; steps: WorkflowStep[] };
type PublishWorkflow = {
  on: { push: { branches: string[]; tags: string[] } };
  jobs: { build: WorkflowJob; publish: WorkflowJob };
};
const workflowStep = {
  type: "object",
  properties: {
    uses: { type: "string" },
    with: { type: "object", properties: { ref: { type: "string" } } },
    run: { type: "string" },
    if: { type: "string" },
  },
};
const workflowJob = {
  type: "object",
  required: ["if", "steps"],
  properties: { if: { type: "string" }, steps: { type: "array", items: workflowStep } },
};
const isWorkflow = new Ajv({ strict: false }).compile<PublishWorkflow>({
  type: "object",
  required: ["on", "jobs"],
  properties: {
    on: {
      type: "object",
      required: ["push"],
      properties: {
        push: {
          type: "object",
          required: ["branches", "tags"],
          properties: {
            branches: { type: "array", items: { type: "string" } },
            tags: { type: "array", items: { type: "string" } },
          },
        },
      },
    },
    jobs: { type: "object", required: ["build", "publish"], properties: { build: workflowJob, publish: workflowJob } },
  },
});

const script = join(import.meta.dir, "../tools/publish/version-gate.sh");
const roots: string[] = [];
const templates = processScratch("ak-version-templates-");
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

type VersionFixture = string | { unexpected: string };

function bundle(dir: string, version: VersionFixture, skill: string) {
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
  built: [VersionFixture, string],
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
  built: [VersionFixture, string],
  packageVersion = built[0],
  origin = "",
  omitPublishedManifest = false,
) {
  const root = processScratch("ak-version-gate-");
  roots.push(root);
  const work = join(root, "work");
  let sourceRemote = remoteTemplate;
  if (published !== null) {
    const key = publishedKey(published, omitPublishedManifest);
    const remote = publishedRemoteTemplates.get(key);
    if (remote === undefined) throw new Error(`missing published fixture ${key}`);
    sourceRemote = remote;
  }
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

  test("with --require-release-tag, refuses publication when the release tag is missing", () => {
    const work = gateWork(["0.1.0", "old"], ["0.2.0", "new"]);
    git(work, "add", "-A");
    git(work, "commit", "-qm", "merged");
    const run = spawnSync("sh", [script, "dist", "--require-release-tag"], { cwd: work, encoding: "utf8" });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("release tag v0.2.0 is missing");
    expect(run.stderr).toContain("merged commit");
  });

  test("with --require-release-tag, refuses publication when the tag points at another commit", () => {
    const work = gateWork(["0.1.0", "old"], ["0.2.0", "new"]);
    git(work, "add", "-A");
    git(work, "commit", "-qm", "tagged");
    git(work, "tag", "v0.2.0");
    writeFileSync(join(work, "later.txt"), "later\n");
    git(work, "add", "-A");
    git(work, "commit", "-qm", "merged");
    const run = spawnSync("sh", [script, "dist", "--require-release-tag"], { cwd: work, encoding: "utf8" });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("release tag v0.2.0 points at");
    expect(run.stderr).toContain("not the merged commit");
  });

  test("with --require-release-tag, accepts publication when the tag matches the merged commit", () => {
    const work = gateWork(["0.1.0", "old"], ["0.2.0", "new"]);
    git(work, "add", "-A");
    git(work, "commit", "-qm", "merged");
    git(work, "tag", "v0.2.0");
    const run = spawnSync("sh", [script, "dist", "--require-release-tag"], { cwd: work, encoding: "utf8" });
    expect(run.status).toBe(0);
  });

  test("with --require-release-tag, the tagged commit checked out after main moved on publishes", () => {
    const work = gateWork(["0.1.0", "old"], ["0.2.0", "new"]);
    git(work, "add", "-A");
    git(work, "commit", "-qm", "merged release");
    git(work, "tag", "-a", "v0.2.0", "-m", "release");
    writeFileSync(join(work, "later.txt"), "later\n");
    git(work, "add", "-A");
    git(work, "commit", "-qm", "later merge");
    const atTip = spawnSync("sh", [script, "dist", "--require-release-tag"], { cwd: work, encoding: "utf8" });
    expect(atTip.status).toBe(1);
    expect(atTip.stderr).toContain("not the merged commit");
    git(work, "checkout", "-q", "v0.2.0");
    const atTag = spawnSync("sh", [script, "dist", "--require-release-tag"], { cwd: work, encoding: "utf8" });
    expect(atTag.stderr).toBe("");
    expect(atTag.status).toBe(0);
  });

  test("with --require-release-tag, an unchanged bundle passes while the tag sits at an older commit", () => {
    const work = gateWork(["0.1.0", "same"], ["0.1.0", "same"]);
    git(work, "add", "-A");
    git(work, "commit", "-qm", "release");
    git(work, "tag", "v0.1.0");
    writeFileSync(join(work, "later.txt"), "later\n");
    git(work, "add", "-A");
    git(work, "commit", "-qm", "merged without a bump");
    const run = spawnSync("sh", [script, "dist", "--require-release-tag"], { cwd: work, encoding: "utf8" });
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
  });

  test("with --require-release-tag, a first publish without the tag is refused", () => {
    const work = gateWork(null, ["0.1.0", "new"]);
    git(work, "add", "-A");
    git(work, "commit", "-qm", "merged");
    const run = spawnSync("sh", [script, "dist", "--require-release-tag"], { cwd: work, encoding: "utf8" });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("release tag v0.1.0 is missing");
  });

  test("with --require-release-tag, a first publish with a matching tag still passes", () => {
    const work = gateWork(null, ["0.1.0", "new"]);
    git(work, "add", "-A");
    git(work, "commit", "-qm", "merged");
    git(work, "tag", "v0.1.0");
    const run = spawnSync("sh", [script, "dist", "--require-release-tag"], { cwd: work, encoding: "utf8" });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("first publish");
  });

  test("refuses a non-string catalog version package.json does not match", () => {
    const run = gate(null, [{ unexpected: "manifest" }, "new"], { unexpected: "package" });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("catalog.yaml version { unexpected: 'manifest' }");
    expect(run.stderr).toContain("package.json version { unexpected: 'package' } differ");
  });
});

describe("publish-bundle workflow release recovery", () => {
  const document: unknown = parseYaml(
    readFileSync(join(import.meta.dir, "../.github/workflows/publish-bundle.yml"), "utf8"),
  );
  if (!isWorkflow(document)) throw new Error("publish-bundle.yml does not match the workflow shape");
  const workflow = document;

  test("a v* tag push starts the workflow alongside the push to main", () => {
    expect(workflow.on.push.branches).toEqual(["main"]);
    expect(workflow.on.push.tags).toEqual(["v*"]);
  });

  test("both jobs run at main or a v* tag and check out the triggering ref, not the tip of main", () => {
    for (const name of ["build", "publish"] as const) {
      const job = workflow.jobs[name];
      if (job === undefined) throw new Error(`missing job ${name}`);
      expect(job.if).toBe("github.ref == 'refs/heads/main' || startsWith(github.ref, 'refs/tags/v')");
      const checkout = job.steps.find((step) => step.uses?.startsWith("actions/checkout@"));
      expect(checkout?.with?.ref).toBeUndefined();
    }
  });

  test("a tag run refuses a commit that is not on main, before the gate, and passes one that is", () => {
    const steps = workflow.jobs.build?.steps ?? [];
    const gateStep = steps.findIndex((step) => step.run === "tools/publish/version-gate.sh dist --require-release-tag");
    const ancestry = steps.findIndex((step) => step.if === "startsWith(github.ref, 'refs/tags/v')");
    expect(ancestry).toBeGreaterThanOrEqual(0);
    expect(gateStep).toBeGreaterThan(ancestry);
    const check = steps[ancestry]?.run ?? "";
    const work = gateWork(null, ["0.1.0", "new"]);
    git(work, "add", "-A");
    git(work, "commit", "-qm", "merged");
    git(work, "update-ref", "refs/remotes/origin/main", "HEAD");
    git(work, "tag", "v0.1.0");
    const env = { ...process.env, GITHUB_REF: "refs/tags/v0.1.0", GITHUB_SHA: "tagged" };
    expect(spawnSync("bash", ["-e", "-c", check], { cwd: work, env, encoding: "utf8" }).status).toBe(0);
    git(work, "checkout", "-q", "--orphan", "side");
    git(work, "commit", "-qm", "unmerged");
    const refused = spawnSync("bash", ["-e", "-c", check], { cwd: work, env, encoding: "utf8" });
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("refs/tags/v0.1.0 points at tagged, which is not on main");
  });
});
