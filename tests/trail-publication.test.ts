import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import trailAudit from "../templates/trail-audit.example.json" with { type: "json" };
import trail from "../templates/trail.example.json" with { type: "json" };
import type { ResolvedKb } from "../src/kb/binding.ts";
import { git } from "../src/kb/git.ts";
import { publishRunArtifact } from "../src/kb/local-git.ts";
import { processScratch } from "./helpers/process-tmp.ts";

function knowledgebase(project: string): ResolvedKb {
  const root = processScratch("ak-trail-kb-");
  for (const args of [
    ["init", "-q"],
    ["config", "user.name", "fixture"],
    ["config", "user.email", "fixture@example.invalid"],
    ["config", "commit.gpgsign", "false"],
    ["config", "core.hooksPath", join(root, "hooks")],
  ]) {
    expect(git(root, args).status).toBe(0);
  }
  mkdirSync(join(root, "hooks"));
  return {
    root,
    knowledgebase: "fixture-kb",
    binding: { backend: "local-git", project, locator: { knowledgebase: "fixture-kb" } },
  };
}

for (const artifact of [trail, trailAudit]) {
  test(`${artifact.schema}: a marked failed publication cannot resend`, () => {
    const kb = knowledgebase(artifact.project.id);
    const directory = processScratch("ak-trail-attempts-");
    const text = JSON.stringify(artifact);
    const hook = join(kb.root, "hooks", "pre-commit");
    writeFileSync(hook, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
    const first = publishRunArtifact(kb, text, artifact.run_id, [], directory);
    expect(first).toMatchObject({ status: "failed", code: "kb.commit-failed" });
    rmSync(hook);

    const resumed = publishRunArtifact(kb, text, artifact.run_id, [], directory);
    expect(resumed).toMatchObject({ status: "failed", code: "kb.trail-publication-unknown" });
    expect(git(kb.root, ["rev-parse", "--verify", "HEAD"]).status).not.toBe(0);

    const pending = { ...trail, id: "example-ticket-1.111111111111.2", order: 2, run_id: artifact.run_id };
    const next = publishRunArtifact(kb, JSON.stringify(pending), artifact.run_id, [], directory);
    expect(next).toMatchObject({
      status: "complete",
      ref: `run:${artifact.run_id}/trail/${pending.id}`,
      effect: "published",
    });
    const pendingAudit = { ...trailAudit, id: `${trailAudit.id}-next`, run_id: artifact.run_id };
    expect(publishRunArtifact(kb, JSON.stringify(pendingAudit), artifact.run_id, [], directory)).toMatchObject({
      status: "complete",
      ref: `run:${artifact.run_id}/trail-audit/${pendingAudit.id}`,
      effect: "published",
    });
    expect(git(kb.root, ["rev-list", "--count", "HEAD"]).stdout.trim()).toBe("2");
  });

  test(`${artifact.schema}: an unwritten artifact does not consume its attempt`, () => {
    const kb = knowledgebase(artifact.project.id);
    const directory = processScratch("ak-trail-attempts-");
    const path = join(kb.root, "projects", artifact.project.id, "runs", "artifacts.jsonl");
    mkdirSync(join(kb.root, "projects", artifact.project.id, "runs"), { recursive: true });
    writeFileSync(path, "dirty\n");
    const text = JSON.stringify(artifact);
    expect(publishRunArtifact(kb, text, artifact.run_id, [], directory)).toMatchObject({
      status: "failed",
      code: "kb.uncommitted-record",
    });
    rmSync(path);
    expect(publishRunArtifact(kb, text, artifact.run_id, [], directory)).toMatchObject({
      status: "complete",
      effect: "published",
    });
  });

  test(`${artifact.schema}: publication requires an attempt directory`, () => {
    const kb = knowledgebase(artifact.project.id);
    expect(publishRunArtifact(kb, JSON.stringify(artifact), artifact.run_id, [])).toMatchObject({
      status: "refused",
      code: "kb.trail-attempts-required",
    });
    expect(publishRunArtifact(kb, JSON.stringify(artifact), artifact.run_id, [], "")).toMatchObject({
      status: "refused",
      code: "kb.trail-attempts-required",
    });
    expect(git(kb.root, ["rev-parse", "--verify", "HEAD"]).status).not.toBe(0);
  });
}

test("failure before mark creation leaves an attempt available", () => {
  const kb = knowledgebase(trail.project.id);
  const directory = join(processScratch("ak-trail-attempts-"), "absent");
  const text = JSON.stringify(trail);
  expect(publishRunArtifact(kb, text, trail.run_id, [], directory)).toMatchObject({
    status: "failed",
    code: "kb.trail-attempt-unrecorded",
  });
  expect(git(kb.root, ["rev-parse", "--verify", "HEAD"]).status).not.toBe(0);
  mkdirSync(directory);
  expect(publishRunArtifact(kb, text, trail.run_id, [], directory)).toMatchObject({
    status: "complete",
    effect: "published",
  });
});

for (const failureAt of [1, 2]) {
  test(`failure at mark fsync ${failureAt} reports a retained mark without publishing`, () => {
    const kb = knowledgebase(trail.project.id);
    const directory = processScratch("ak-trail-attempts-");
    let calls = 0;
    const sync = fs.fsyncSync;
    const fault = spyOn(fs, "fsyncSync").mockImplementation((fd) => {
      calls += 1;
      if (calls === failureAt) throw new Error("injected durability failure");
      sync(fd);
    });
    try {
      const result = publishRunArtifact(kb, JSON.stringify(trail), trail.run_id, [], directory);
      expect(calls).toBe(failureAt);
      expect(result).toMatchObject({ status: "failed", code: "kb.trail-attempt-unrecorded" });
      expect(result).toHaveProperty("message", expect.stringContaining("mark remains"));
      expect(readdirSync(directory)).toHaveLength(1);
      expect(git(kb.root, ["rev-parse", "--verify", "HEAD"]).status).not.toBe(0);
    } finally {
      fault.mockRestore();
    }
    expect(publishRunArtifact(kb, JSON.stringify(trail), trail.run_id, [], directory)).toMatchObject({
      status: "failed",
      code: "kb.trail-publication-unknown",
    });
  });
}

test("a partial record write returns an honest structured failure and keeps its mark", () => {
  const kb = knowledgebase(trail.project.id);
  const directory = processScratch("ak-trail-attempts-");
  const file = join(kb.root, "projects", trail.project.id, "runs", "artifacts.jsonl");
  const write = fs.writeFileSync;
  let injected = false;
  const fault = spyOn(fs, "writeFileSync").mockImplementation((target, data, options) => {
    if (target === file) {
      injected = true;
      write(target, "partial record\n");
      throw new Error("injected partial write");
    }
    write(target, data, options);
  });
  try {
    const result = publishRunArtifact(kb, JSON.stringify(trail), trail.run_id, [], directory);
    expect(injected).toBe(true);
    expect(result).toMatchObject({ status: "failed", code: "kb.trail-publication-unknown" });
    expect(result).toHaveProperty("message", expect.stringContaining("cleanup"));
    expect(readFileSync(file, "utf8")).toBe("partial record\n");
    expect(readdirSync(directory)).toHaveLength(1);
  } finally {
    fault.mockRestore();
  }
});

test("commit failure preserves concurrent record content and unrelated staged work", () => {
  const kb = knowledgebase(trail.project.id);
  const directory = processScratch("ak-trail-attempts-");
  writeFileSync(join(kb.root, "notes.md"), "unrelated staged work\n");
  expect(git(kb.root, ["add", "notes.md"]).status).toBe(0);
  const hook = join(kb.root, "hooks", "pre-commit");
  const relative = `projects/${trail.project.id}/runs/artifacts.jsonl`;
  writeFileSync(hook, `#!/bin/sh\nprintf 'concurrent data\\n' > '${relative}'\nexit 1\n`, { mode: 0o700 });
  const result = publishRunArtifact(kb, JSON.stringify(trail), trail.run_id, [], directory);
  expect(result).toMatchObject({ status: "failed", code: "kb.trail-publication-unknown" });
  expect(result).toHaveProperty("message", expect.stringContaining("exposed"));
  expect(readFileSync(join(kb.root, relative), "utf8")).toBe("concurrent data\n");
  expect(git(kb.root, ["show", ":notes.md"]).stdout).toBe("unrelated staged work\n");
});

test("cleanup does not follow a concurrent replacement symlink", () => {
  const kb = knowledgebase(trail.project.id);
  const directory = processScratch("ak-trail-attempts-");
  writeFileSync(join(kb.root, "concurrent.md"), "keep this content\n");
  const relative = `projects/${trail.project.id}/runs/artifacts.jsonl`;
  writeFileSync(
    join(kb.root, "hooks", "pre-commit"),
    `#!/bin/sh\nrm '${relative}'\nln -s '../../../concurrent.md' '${relative}'\nexit 1\n`,
    { mode: 0o700 },
  );
  expect(publishRunArtifact(kb, JSON.stringify(trail), trail.run_id, [], directory)).toMatchObject({
    status: "failed",
    code: "kb.trail-publication-unknown",
  });
  expect(fs.lstatSync(join(kb.root, relative)).isSymbolicLink()).toBe(true);
  expect(readFileSync(join(kb.root, "concurrent.md"), "utf8")).toBe("keep this content\n");
});

test("cleanup preserves a concurrent record mode change", () => {
  const kb = knowledgebase(trail.project.id);
  const directory = processScratch("ak-trail-attempts-");
  const relative = `projects/${trail.project.id}/runs/artifacts.jsonl`;
  writeFileSync(join(kb.root, "hooks", "pre-commit"), `#!/bin/sh\nchmod +x '${relative}'\nexit 1\n`, {
    mode: 0o700,
  });
  expect(publishRunArtifact(kb, JSON.stringify(trail), trail.run_id, [], directory)).toMatchObject({
    status: "failed",
    code: "kb.trail-publication-unknown",
  });
  expect(fs.lstatSync(join(kb.root, relative)).mode & 0o111).not.toBe(0);
});

test("an index lock prevents cleanup without removing the written record", () => {
  const kb = knowledgebase(trail.project.id);
  const directory = processScratch("ak-trail-attempts-");
  const first = { ...trail, id: "existing-trail" };
  expect(publishRunArtifact(kb, JSON.stringify(first), trail.run_id, [], directory)).toMatchObject({
    status: "complete",
  });
  writeFileSync(join(kb.root, ".git", "index.lock"), "external lock\n");
  const result = publishRunArtifact(kb, JSON.stringify(trail), trail.run_id, [], directory);
  expect(result).toMatchObject({ status: "failed", code: "kb.trail-publication-unknown" });
  expect(result).toHaveProperty("message", expect.stringContaining("cleanup"));
  expect(result).toHaveProperty("message", expect.stringContaining("exposed"));
  expect(readFileSync(join(kb.root, ".git", "index.lock"), "utf8")).toBe("external lock\n");
  expect(readFileSync(join(kb.root, "projects", trail.project.id, "runs", "artifacts.jsonl"), "utf8")).toContain(
    `"id":"${trail.id}"`,
  );
});
