import { describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "../../src/learn/core/proc.ts";
import {
  catalogSkills,
  frontmatter,
  installedSkills,
  rosterSection,
  skillsUnder,
} from "../../src/learn/skills/roster.ts";
import { skillsLedger } from "../../src/learn/skills/learn.ts";
import { writeJson } from "../../src/learn/core/store.ts";
import { gitRepo, scratch, testContext } from "./helpers.ts";

const FOLDED = `---
name: careful-review
description: >-
  Review a pushed PR with calibrated severity.
  Use for “careful review” or “would this pass”.
allowed-tools: Read
---
# body
`;

const QUOTED = `---
name: kill-slop
description: "Stop coding agents from shipping sloppy code. Use when the user mentions slop."
---
`;

const CATALOG = `schema_version: 1
package:
  id: ak
skills:
  - id: alpha
    invocation: U
    status: authored
    summary: Human-started lifecycle phase.
  - id: beta
    invocation: M
    status: authored
    summary: >-
      Model-started helper that
      finds the cause of a defect.
  - id: gamma
    invocation: M
    status: contract
    summary: Not written yet.
`;

function skill(dir: string, name: string, text: string): void {
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(join(dir, name, "SKILL.md"), text);
}

function fixtureCatalog(): string {
  const root = scratch("ak-catalog-");
  writeFileSync(join(root, "catalog.yaml"), CATALOG);
  return root;
}

describe("frontmatter", () => {
  test("folded multi-line description joins into one line, other keys kept", () => {
    const fm = frontmatter(FOLDED);
    expect(fm.name).toBe("careful-review");
    expect(fm.description).toBe(
      "Review a pushed PR with calibrated severity. Use for “careful review” or “would this pass”.",
    );
    expect(fm["allowed-tools"]).toBe("Read");
  });

  test("a file without frontmatter yields nothing", () => {
    expect(frontmatter("# just a body\n")).toEqual({});
  });
});

describe("installed skills", () => {
  test("walks symlinked skill dirs, stops at a SKILL.md, uses the directory name", () => {
    const base = scratch();
    const elsewhere = join(base, "elsewhere");
    skill(elsewhere, "deslop-voice", "---\nname: deslop\ndescription: Strips padding.\n---\n");
    const root = join(base, "skills");
    skill(root, "kill-slop", QUOTED);
    mkdirSync(join(root, "kill-slop", "nested"), { recursive: true });
    writeFileSync(join(root, "kill-slop", "nested", "SKILL.md"), "---\nname: nested\n---\n");
    symlinkSync(join(elsewhere, "deslop-voice"), join(root, "deslop-voice"));
    expect(skillsUnder(root)).toEqual([join(root, "deslop-voice", "SKILL.md"), join(root, "kill-slop", "SKILL.md")]);
    const skills = installedSkills(root);
    expect(skills.map((s) => s.name)).toEqual(["deslop-voice", "kill-slop"]);
    expect(skills[1]!.description).toBe(
      "Stop coding agents from shipping sloppy code. Use when the user mentions slop.",
    );
  });

  test("disable-model-invocation marks a skill human-only", () => {
    const root = scratch();
    skill(root, "ship-it", "---\nname: ship-it\ndescription: Ship.\ndisable-model-invocation: true\n---\n");
    expect(installedSkills(root)[0]!.modelInvocable).toBe(false);
  });
});

describe("catalog skills", () => {
  test("only authored entries, invocation class carried", () => {
    const skills = catalogSkills(fixtureCatalog());
    expect(skills.map((s) => [s.name, s.modelInvocable])).toEqual([
      ["alpha", false],
      ["beta", true],
    ]);
    expect(skills[1]!.description).toBe("Model-started helper that finds the cause of a defect.");
  });

  test("the real catalog lists user-invoked lifecycle skills as human-only", () => {
    const skills = catalogSkills(join(import.meta.dir, "..", ".."));
    const align = skills.find((s) => s.name === "super-align");
    expect(align?.modelInvocable).toBe(false);
    expect(skills.every((s) => s.description !== "")).toBe(true);
  });
});

describe("rosterSection", () => {
  test("model-invoked skills get lines, user-invoked ones only a slash command, installed dedupe against the catalog", () => {
    const ctx = testContext();
    const repo = gitRepo(join(scratch(), "repo"));
    const global = join(ctx.config.configDir, "skills");
    skill(global, "kill-slop", QUOTED);
    skill(global, "beta", "---\nname: beta\ndescription: A shadowing copy.\n---\n");
    skill(global, "ship-it", "---\nname: ship-it\ndescription: Ship.\ndisable-model-invocation: true\n---\n");
    skill(
      join(repo, ".claude", "skills"),
      "repo-thing",
      "---\nname: repo-thing\ndescription: Only in this repository.\n---\n",
    );
    const text = rosterSection(ctx, repo, { packageRoot: fixtureCatalog(), width: 40 });
    expect(text).toBe(
      [
        "## Skill roster",
        "",
        "Skills (read the SKILL.md and follow it when a task matches):",
        "- beta: Model-started helper that finds the caus",
        "- kill-slop: Stop coding agents from shipping sloppy",
        "- repo-thing: Only in this repository.",
        "Human-only commands (suggest one when it fits; never start it yourself): /ak:alpha, /ship-it",
        "",
      ].join("\n"),
    );
    expect(text).not.toContain("gamma");
  });

  test("a catalog human-only command is named in the form the host's bundle gates on", () => {
    const ctx = testContext();
    const global = join(ctx.config.configDir, "skills");
    skill(global, "ship-it", "---\nname: ship-it\ndescription: Ship.\ndisable-model-invocation: true\n---\n");
    const humanOnly = (host: "claude-code" | "codex") =>
      rosterSection(ctx, null, { packageRoot: fixtureCatalog(), host })
        .split("\n")
        .find((line) => line.startsWith("Human-only commands"));
    expect(humanOnly("codex")).toEndWith(": $ak:alpha, /ship-it");
    expect(humanOnly("claude-code")).toEndWith(": /ak:alpha, /ship-it");
  });

  test("pending candidates are listed with their ledger path; decided ones are not", () => {
    const ctx = testContext();
    const repo = gitRepo(join(scratch(), "repo"));
    const ledger = skillsLedger(ctx, repo);
    writeJson(ledger.path("registry.json"), {
      next: 3,
      candidates: {
        "sk-001": { name: "rerun-bot-review", description: "Re-request a stale bot review.", status: "candidate" },
        "sk-002": { name: "gone", description: "Rejected.", status: "rejected" },
      },
      rejected: ["gone"],
      seen_sessions: {},
    });
    const text = rosterSection(ctx, repo, { packageRoot: fixtureCatalog() });
    expect(text).toContain(
      `- rerun-bot-review [sk-001]: Re-request a stale bot review. \`${ledger.path("candidates", "sk-001.md")}\``,
    );
    expect(text).not.toContain("gone");
  });

  test("outside a repository: no project skills, no candidates, and empty when nothing exists", () => {
    const ctx = testContext();
    const empty = scratch();
    writeFileSync(join(empty, "catalog.yaml"), "schema_version: 1\n");
    expect(rosterSection(ctx, null, { packageRoot: empty })).toBe("");
  });

  test("never writes inside the repository", () => {
    const ctx = testContext();
    const repo = gitRepo(join(scratch(), "repo"));
    skillsLedger(ctx, repo);
    rosterSection(ctx, repo, { packageRoot: fixtureCatalog() });
    expect(run(["git", "status", "--porcelain"], { cwd: repo }).stdout).toBe("");
  });
});
