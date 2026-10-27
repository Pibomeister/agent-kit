import { expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
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

test("failure to create a durable mark prevents publication without consuming the attempt", () => {
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
