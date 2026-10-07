import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { lessonDraft, proposeLesson } from "../../src/learn/kb.ts";
import { compileSchemas } from "../../src/validation/schemas.ts";
import { scratch, testContext } from "./helpers.ts";

const REPO = resolve(import.meta.dir, "..", "..");

function draft() {
  return draftWith("ls-003");
}

function draftWith(localId: string) {
  return lessonDraft(
    {
      localId,
      title: "Pin the fixture clock",
      statement: "Tests that compare timestamps pin the clock; otherwise they fail across a second boundary.",
      trigger: "correction",
      occurrence: { id: "obs-412", content: { title: "flaky timestamp test" } },
      evidence: [
        { ref: "claude-mem:obs-412", kind: "transcript" },
        { ref: "claude-mem:obs-507", kind: "transcript", note: "second session" },
      ],
      domains: ["testing"],
      paths: ["tests/**"],
      guidance: ["Pass a fixed Date into the function under test."],
      createdBy: "learn/consolidator",
    },
    { root: "/work/My App", repo: "acme/my-app", revision: "a".repeat(40) },
    "learn-memory-20260924",
    new Date("2026-09-24T10:00:00Z"),
  );
}

describe("knowledgebase bridge", () => {
  test("a draft is a schema-valid candidate lesson", () => {
    const validate = compileSchemas(REPO).validatorFor("lesson")!;
    const lesson = draft();
    expect(validate(lesson)).toBe(true);
    expect(lesson.status).toBe("candidate");
    expect(lesson.id).toBe("learn-my-app-ls-003");
    expect((lesson.trigger as { occurrence: { hash: string } }).occurrence.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test("with no knowledgebase the draft stays in the ledger", () => {
    const ctx = testContext();
    const ledger = scratch();
    const result = proposeLesson(ctx, ledger, draft());
    expect(result).toEqual({ ref: "ledger:proposals/learn-my-app-ls-003.json", delivered: false });
    const record = JSON.parse(readFileSync(join(ledger, "proposals", "learn-my-app-ls-003.json"), "utf8"));
    expect(record.draft.status).toBe("candidate");
  });

  test("a configured knowledgebase receives the draft once and its ref is kept", () => {
    const base = scratch();
    const seen = join(base, "seen");
    const ctx = testContext({ env: { AK_LEARN_KB_COMMAND: `cat > ${seen}; echo '{"ref":"kb:lesson/1"}'; true` } });
    const ledger = join(base, "ledger");
    expect(proposeLesson(ctx, ledger, draft())).toEqual({ ref: "kb:lesson/1", delivered: true });
    expect(JSON.parse(readFileSync(seen, "utf8")).id).toBe("learn-my-app-ls-003");
    const again = testContext({ env: { AK_LEARN_KB_COMMAND: "exit 1" } });
    expect(proposeLesson(again, ledger, draft())).toEqual({ ref: "kb:lesson/1", delivered: true });
  });

  test("a failing knowledgebase leaves the ledger record with the error", () => {
    const ctx = testContext({ env: { AK_LEARN_KB_COMMAND: "echo nope >&2; exit 3; true" } });
    const ledger = scratch();
    expect(proposeLesson(ctx, ledger, draft()).delivered).toBe(false);
    const record = JSON.parse(readFileSync(join(ledger, "proposals", "learn-my-app-ls-003.json"), "utf8"));
    expect(record.kb_error).toBe("nope");
  });

  test("an id that is not the runtime's shape never becomes a path", () => {
    expect(() => draftWith("../../../../escape")).toThrow();
    expect(() => proposeLesson(testContext(), scratch(), { ...draft(), id: "../escape" })).toThrow();
  });

  test("dry run writes nothing and never runs the knowledgebase command", () => {
    // A configured command, so the dry-run guard and not the missing command is what keeps it from running.
    const ran = join(scratch(), "ran");
    const ctx = testContext({
      env: { AK_LEARN_DRY_RUN: "1", AK_LEARN_KB_COMMAND: `touch ${ran}; echo '{"ref":"kb:lesson/1"}'` },
    });
    const ledger = scratch();
    const result = proposeLesson(ctx, ledger, draft());
    expect(existsSync(ran)).toBe(false);
    expect(result.delivered).toBe(false);
    expect(existsSync(join(ledger, "proposals"))).toBe(false);
  });
});
