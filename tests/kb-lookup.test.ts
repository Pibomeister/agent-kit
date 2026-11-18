/**
 * Committed artifact lookup pins by id, schema and hash, and a knowledgebase
 * with no HEAD names that it has no commits.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { ResolvedKb } from "../src/kb/binding.ts";
import { lookupCommittedArtifact, lookupPublishedProject } from "../src/kb/local-git.ts";
import { artifactHash } from "../src/util/hash.ts";
import { processScratch } from "./helpers/process-tmp.ts";

function git(cwd: string, ...args: string[]): void {
  const p = Bun.spawnSync(["git", ...args], {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.invalid",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.invalid",
    },
  });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`);
}

function resolved(root: string, project = "example-project"): ResolvedKb {
  return {
    binding: { backend: "local-git", project, locator: { knowledgebase: "fixture-kb" } },
    knowledgebase: "fixture-kb",
    root,
  };
}

describe("lookupCommittedArtifact", () => {
  test("a pinned hash selects that revision when a later same-id artifact exists", () => {
    const scratch = processScratch("ak-kb-lookup-");
    const kb = join(scratch, "kb");
    mkdirSync(join(kb, "projects", "example-project", "runs"), { recursive: true });
    git(kb, "init", "-q", "-b", "main");
    git(kb, "config", "user.name", "t");
    git(kb, "config", "user.email", "t@example.invalid");
    const first = { schema: "ticket", id: "shared-id", status: "approved", title: "first" };
    const second = { schema: "ticket", id: "shared-id", status: "approved", title: "second" };
    const firstHash = artifactHash(first);
    const secondHash = artifactHash(second);
    writeFileSync(
      join(kb, "projects", "example-project", "runs", "artifacts.jsonl"),
      `${JSON.stringify({
        record: { ref: "run:a/ticket/shared-id", content_hash: firstHash, idempotency_key: firstHash, links: [] },
        artifact: first,
      })}\n${JSON.stringify({
        record: { ref: "run:b/ticket/shared-id", content_hash: secondHash, idempotency_key: secondHash, links: [] },
        artifact: second,
      })}\n`,
    );
    git(kb, "add", "-A");
    git(kb, "commit", "-q", "-m", "two");
    const bound = resolved(kb);
    const latest = lookupCommittedArtifact(bound, "shared-id");
    expect(latest.status).toBe("found");
    if (latest.status === "found") expect(latest.artifact.title).toBe("second");
    const pinned = lookupCommittedArtifact(bound, "shared-id", { schema: "ticket", hash: firstHash });
    expect(pinned.status).toBe("found");
    if (pinned.status === "found") expect(pinned.artifact.title).toBe("first");
  });

  test("a knowledgebase with no commits is unreadable, not a confirmed miss", () => {
    const scratch = processScratch("ak-kb-nohead-");
    const kb = join(scratch, "kb");
    mkdirSync(kb);
    git(kb, "init", "-q", "-b", "main");
    const bound = resolved(kb);
    const looked = lookupCommittedArtifact(bound, "anything");
    expect(looked.status).toBe("unavailable");
    if (looked.status === "unavailable") expect(looked.reason).toContain("the knowledgebase has no commits");
    const project = lookupPublishedProject(bound, "example-project");
    expect(project.status).toBe("unavailable");
    if (project.status === "unavailable") expect(project.reason).toContain("the knowledgebase has no commits");
  });
});
