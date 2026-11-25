import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Ajv from "ajv";
import { parse as parseYaml } from "yaml";
import { processScratch } from "./helpers/process-tmp.ts";

type WorkflowStep = { uses?: string; with?: { ref?: string }; run?: string; if?: string; name?: string };
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
    name: { type: "string" },
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
  return run.stdout.trim();
}

function remoteTag(remote: string, tag: string) {
  return spawnSync("git", ["rev-parse", "-q", "--verify", `refs/tags/${tag}^{commit}`], {
    cwd: remote,
    encoding: "utf8",
  }).stdout.trim();
}

// A private copy of a published remote, so a test that pushes a tag or main changes no shared template.
function ownRemote(published: [string, string] | null) {
  const root = processScratch("ak-version-remote-");
  roots.push(root);
  const remote = join(root, "origin.git");
  const source = published === null ? remoteTemplate : publishedRemoteTemplates.get(publishedKey(published));
  if (source === undefined) throw new Error("missing published fixture");
  cpSync(source, remote, { recursive: true });
  return remote;
}

// A merged commit on main in a private remote, ready for the --create-release-tag mode.
function mergedOnMain(published: [string, string] | null, built: [string, string]) {
  const remote = ownRemote(published);
  const work = gateWork(published, built, built[0], remote);
  git(work, "add", "-A");
  git(work, "commit", "-qm", "merged");
  git(work, "push", "-q", "origin", "HEAD:refs/heads/main");
  return { remote, work, head: git(work, "rev-parse", "HEAD") };
}

function createTag(work: string) {
  return spawnSync("sh", [script, "dist", "--create-release-tag"], { cwd: work, encoding: "utf8" });
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

  test("with --create-release-tag, a missing tag is created at the merged commit on main and pushed", () => {
    const { remote, work, head } = mergedOnMain(["0.1.0", "old"], ["0.2.0", "new"]);
    const run = createTag(work);
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(run.stdout).toContain(`Created release tag v0.2.0 at the merged commit ${head}`);
    expect(remoteTag(remote, "v0.2.0")).toBe(head);
  });

  test("with --create-release-tag, a first publish creates its missing tag", () => {
    const { remote, work, head } = mergedOnMain(null, ["0.1.0", "new"]);
    const run = createTag(work);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("Created release tag v0.1.0");
    expect(run.stdout).toContain("first publish");
    expect(remoteTag(remote, "v0.1.0")).toBe(head);
  });

  test("with --create-release-tag, a merged commit that is not on main gets no tag", () => {
    const { remote, work } = mergedOnMain(["0.1.0", "old"], ["0.2.0", "new"]);
    writeFileSync(join(work, "later.txt"), "later\n");
    git(work, "add", "-A");
    git(work, "commit", "-qm", "never merged");
    const run = createTag(work);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("is not on main, so release tag v0.2.0 is not created");
    expect(remoteTag(remote, "v0.2.0")).toBe("");
  });

  test("with --create-release-tag, a tag on origin at another commit still refuses and stays put", () => {
    const { remote, work, head } = mergedOnMain(["0.1.0", "old"], ["0.2.0", "new"]);
    git(work, "push", "-q", "origin", "HEAD:refs/tags/v0.2.0");
    writeFileSync(join(work, "later.txt"), "later\n");
    git(work, "add", "-A");
    git(work, "commit", "-qm", "later merge");
    git(work, "push", "-q", "origin", "HEAD:refs/heads/main");
    const run = createTag(work);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain(`release tag v0.2.0 points at ${head}, not the merged commit`);
    expect(remoteTag(remote, "v0.2.0")).toBe(head);
  });

  test("with --create-release-tag, a tag already at the merged commit passes without a new tag", () => {
    const { work } = mergedOnMain(["0.1.0", "old"], ["0.2.0", "new"]);
    git(work, "tag", "v0.2.0");
    const run = createTag(work);
    expect(run.status).toBe(0);
    expect(run.stdout).not.toContain("Created release tag");
  });

  test("with --create-release-tag, an unchanged bundle creates no tag", () => {
    const { remote, work } = mergedOnMain(["0.1.0", "same"], ["0.1.0", "same"]);
    const run = createTag(work);
    expect(run.status).toBe(0);
    expect(remoteTag(remote, "v0.1.0")).toBe("");
  });

  test("with --create-release-tag, a refused tag push refuses and leaves no local tag", () => {
    const { remote, work } = mergedOnMain(["0.1.0", "old"], ["0.2.0", "new"]);
    const hook = join(remote, "hooks/pre-receive");
    writeFileSync(hook, "#!/bin/sh\nexit 1\n");
    chmodSync(hook, 0o755);
    const run = createTag(work);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("cannot push release tag v0.2.0 to origin");
    expect(spawnSync("git", ["rev-parse", "-q", "--verify", "refs/tags/v0.2.0"], { cwd: work }).status).toBe(1);
  });

  test("refuses an unknown second argument", () => {
    const run = spawnSync("sh", [script, "dist", "--tag"], { cwd: gateWork(null, ["0.1.0", "new"]), encoding: "utf8" });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("expected --require-release-tag or --create-release-tag");
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

  test("the read-only build job checks the version bump, and only the publish job touches the release tag", () => {
    const build = workflow.jobs.build?.steps ?? [];
    expect(build.some((step) => step.run === "tools/publish/version-gate.sh dist")).toBe(true);
    expect(build.some((step) => step.run?.includes("release-tag"))).toBe(false);
  });

  test("the publish job creates a missing tag only on the push to main, before it publishes", () => {
    const steps = workflow.jobs.publish?.steps ?? [];
    const tagStep = steps.findIndex((step) => step.run?.includes("version-gate.sh dist --create-release-tag"));
    const publishStep = steps.findIndex((step) => step.name === "Publish generated bundles to the published branch");
    expect(tagStep).toBeGreaterThanOrEqual(0);
    expect(publishStep).toBeGreaterThan(tagStep);
    const root = processScratch("ak-version-step-");
    roots.push(root);
    mkdirSync(join(root, "tools/publish"), { recursive: true });
    writeFileSync(join(root, "tools/publish/version-gate.sh"), '#!/bin/sh\necho "$*"\n');
    chmodSync(join(root, "tools/publish/version-gate.sh"), 0o755);
    const mode = (GITHUB_EVENT_NAME: string, GITHUB_REF: string) =>
      spawnSync("bash", ["-e", "-c", steps[tagStep]?.run ?? ""], {
        cwd: root,
        env: { ...process.env, GITHUB_EVENT_NAME, GITHUB_REF },
        encoding: "utf8",
      }).stdout.trim();
    expect(mode("push", "refs/heads/main")).toBe("dist --create-release-tag");
    expect(mode("push", "refs/tags/v0.1.0")).toBe("dist --require-release-tag");
    expect(mode("workflow_dispatch", "refs/heads/main")).toBe("dist --require-release-tag");
  });

  test("a tag run refuses a commit that is not on main, in the build job the publish job needs", () => {
    const steps = workflow.jobs.build?.steps ?? [];
    const ancestry = steps.findIndex((step) => step.if === "startsWith(github.ref, 'refs/tags/v')");
    expect(ancestry).toBeGreaterThanOrEqual(0);
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
