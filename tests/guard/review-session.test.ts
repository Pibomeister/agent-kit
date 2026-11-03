import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { shellAction, type GuardAction, type GuardContext } from "../../src/guard/action.ts";
import { evaluate } from "../../src/guard/evaluate.ts";
import { loadGuardPolicy, type GuardPolicy } from "../../src/guard/policy.ts";

const ROOT = join(import.meta.dir, "..", "..");
const TEMPLATE = join(ROOT, "templates", "guard", "review-session.policy.json");
const CONTEXT: GuardContext = { root: "/work/repo", home: "/home/dev" };

function loadTemplate(): GuardPolicy {
  const result = loadGuardPolicy(TEMPLATE);
  if (result.policy === null)
    throw new Error(`the review-session policy did not load: ${JSON.stringify(result.issues)}`);
  return result.policy;
}

const POLICY = loadTemplate();

function verdict(action: GuardAction) {
  return evaluate(POLICY, action, CONTEXT);
}

describe("templates/guard/review-session.policy.json", () => {
  test("loads against schemas/guard-policy.schema.json", () => {
    const result = loadGuardPolicy(TEMPLATE);
    expect(result.issues).toEqual([]);
    expect(result.policy?.secret_paths).toEqual([
      {
        id: "secret.claude-session-store",
        globs: ["**/.claude/projects/**"],
        reason:
          "Claude Code stores session transcripts under .claude/projects; a review seat must not read the author's session",
      },
    ]);
  });

  test("denies a read under .claude/projects/**", () => {
    const denied: ReadonlyArray<GuardAction> = [
      { kind: "read", paths: [".claude/projects/demo/session.json"] },
      { kind: "read", paths: ["/work/repo/.claude/projects/demo/uuid.jsonl"] },
      { kind: "read", paths: ["/home/dev/.claude/projects/-Users-dev-repo/uuid.jsonl"] },
      shellAction("cat ~/.claude/projects/demo/session.jsonl"),
    ];
    for (const action of denied) {
      const found = verdict(action);
      expect(found.decision).toBe("deny");
      if (found.decision === "deny") expect(found.rule).toBe("secret.claude-session-store");
    }
  });

  test("does not deny the host's own memory paths outside projects/", () => {
    const allowed: ReadonlyArray<GuardAction> = [
      { kind: "read", paths: ["CLAUDE.md"] },
      { kind: "read", paths: ["/work/repo/CLAUDE.md"] },
      { kind: "read", paths: ["/work/repo/.claude/settings.json"] },
      { kind: "read", paths: ["/home/dev/.claude/memory/project_memory.md"] },
      { kind: "read", paths: ["/home/dev/.claude/settings.json"] },
      { kind: "read", paths: ["/home/dev/.claude/CLAUDE.md"] },
      shellAction("cat CLAUDE.md"),
      shellAction("cat ~/.claude/memory/notes.md"),
      shellAction("cat ~/.claude/settings.json"),
    ];
    for (const action of allowed) expect(verdict(action)).toEqual({ decision: "allow" });
  });
});
