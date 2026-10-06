import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseLearnArgs } from "../../src/learn/core/context.ts";
import { loopDir, projectFolderName } from "../../src/learn/core/paths.ts";
import { run } from "../../src/learn/core/proc.ts";
import { skillsArea } from "../../src/learn/skills/cli.ts";
import {
  discover,
  extractUserMessages,
  gateCandidate,
  gatherSessions,
  loadRegistry,
  measureUses,
  parseCandidates,
  type ProposedCandidate,
  promoteCandidate,
  rejectCandidate,
  renderDraft,
  runSkillLearn,
  type SessionSample,
  shouldIncludeMessage,
  type SkillRegistry,
  skillsLedger,
} from "../../src/learn/skills/learn.ts";
import { gitRepo, inOutsideRepo, MemFixture, scratch, type TestContext, testContext } from "./helpers.ts";

const CAND: ProposedCandidate = {
  name: "Bot Re-Review",
  description: "Re-request the review bot at the current head. Use when the user says re-review or bot review.",
  scope: "global",
  intent: "Get a fresh bot review after pushing fixes.",
  steps: ["gh pr comment $PR --body '@review-bot review'", "poll gh pr checks until fresh"],
  guardrails: ["never mention the assistant in the comment"],
  evidence: [
    { session: "aaaa1111", quote: "ask the bot to re-review" },
    { session: "bbbb2222", quote: "re-trigger the review bot" },
    { session: "cccc3333", quote: "bot review is stale, rerun" },
  ],
  confidence: "high",
};

const SESSIONS: Record<string, string[]> = {
  "aaaa1111-0000": ["please ask the bot to re-review this PR", "and then fix the lint failures"],
  "bbbb2222-0000": ["pushed the fix, re-trigger the review bot", "check the CI result too please"],
  "cccc3333-0000": ["the bot review is stale, rerun it now", "the head moved after my rebase"],
};

function emptyRegistry(): SkillRegistry {
  return { next: 1, candidates: {}, rejected: [], seen_sessions: {} };
}

function userLine(content: unknown, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ type: "user", message: { role: "user", content }, ...extra });
}

/** A transcript under the project's folder in the config dir, one user turn per message. */
function transcript(ctx: TestContext, root: string, sid: string, messages: string[]): string {
  const dir = join(ctx.config.configDir, "projects", projectFolderName(root));
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${sid}.jsonl`);
  writeFileSync(path, `${messages.map((m) => userLine(m)).join("\n")}\n`);
  return path;
}

/** A repository with three sessions that each ask for the same thing, and an empty catalog. */
function fixture(replies: NonNullable<Parameters<typeof testContext>[0]>["replies"] = []) {
  const ctx = testContext({ replies });
  const root = gitRepo(join(scratch(), "repo"));
  for (const [sid, messages] of Object.entries(SESSIONS)) transcript(ctx, root, sid, messages);
  const packageRoot = scratch("ak-catalog-");
  writeFileSync(join(packageRoot, "catalog.yaml"), "schema_version: 1\n");
  return { ctx, root, packageRoot };
}

function repoClean(root: string): boolean {
  return run(["git", "status", "--porcelain"], { cwd: root }).stdout === "";
}

describe("transcript extraction (claude-reflect port)", () => {
  test("system content, tool results and continuations are not user requests", () => {
    expect(shouldIncludeMessage("rerun the review bot please")).toBe(true);
    for (const text of [
      "",
      "<command-name>/x</command-name>",
      "[Request interrupted]",
      '{"a":1}',
      "This session is being continued from x",
      "**bold**",
    ]) {
      expect(shouldIncludeMessage(text)).toBe(false);
    }
  });

  test("user turns only: meta turns and non-text parts dropped, text parts kept", () => {
    const path = join(scratch(), "t.jsonl");
    writeFileSync(
      path,
      [
        userLine("first real request"),
        userLine("meta noise", { isMeta: true }),
        JSON.stringify({ type: "assistant", message: { content: "an answer" } }),
        userLine([
          { type: "tool_result", content: "x" },
          { type: "text", text: "second real request" },
        ]),
        "not json",
        userLine("<system-reminder>injected</system-reminder>"),
      ].join("\n"),
    );
    expect(extractUserMessages(path)).toEqual(["first real request", "second real request"]);
    expect(extractUserMessages(join(scratch(), "missing.jsonl"))).toEqual([]);
  });
});

describe("gatherSessions", () => {
  test("reads transcripts once, shortens ids, and adds claude-mem first prompts for sessions without one", () => {
    const { ctx, root } = fixture();
    transcript(ctx, root, "dddd4444-0000", ["only one usable message here"]);
    const memDb = join(scratch(), "mem.db");
    const mem = new MemFixture(memDb);
    mem.session({
      sid: "m1",
      content: "eeee5555-0000",
      project: "repo",
      started: Date.now(),
      prompt: "rerun the review bot on this branch",
    });
    mem.session({
      sid: "m2",
      content: "aaaa1111-0000",
      project: "repo",
      started: Date.now(),
      prompt: "a duplicate of a transcript session",
    });
    mem.close();
    const withMem: TestContext = { ...ctx, config: { ...ctx.config, memDb } };

    const registry = emptyRegistry();
    const sessions = gatherSessions(withMem, root, 14, registry);
    expect(sessions.map((s) => s.sid).sort()).toEqual(["aaaa1111", "bbbb2222", "cccc3333", "eeee5555"]);
    expect(sessions.find((s) => s.sid === "eeee5555")!.messages).toEqual(["rerun the review bot on this branch"]);
    expect(registry.seen_sessions["dddd4444-0000"]).toBeGreaterThan(0);
    expect(registry.seen_sessions["eeee5555-0000"]).toBe(-1);

    expect(gatherSessions(withMem, root, 14, registry)).toEqual([]);
    expect(gatherSessions(withMem, root, 14, registry, true)).toHaveLength(4);
  });
});

describe("the evidence gate", () => {
  const sessions: SessionSample[] = Object.entries(SESSIONS).map(([sid, messages]) => ({
    sid: sid.slice(0, 8),
    messages,
  }));

  test("three sessions quoting real words pass, with the name kebab-cased", () => {
    const gated = gateCandidate(CAND, sessions, new Set());
    expect(gated?.name).toBe("bot-re-review");
    expect(gated?.evidence).toHaveLength(3);
  });

  test("a session not in the input, a quote the session lacks, or a repeated session does not count", () => {
    for (const bad of [
      { session: "ffff9999", quote: "bot review is stale, rerun" },
      { session: "cccc3333", quote: "words nobody typed" },
      { session: "aaaa1111", quote: "then fix the lint failures" },
    ]) {
      expect(gateCandidate({ ...CAND, evidence: [...CAND.evidence.slice(0, 2), bad] }, sessions, new Set())).toBeNull();
    }
  });

  test("short quotes that would match any session are not evidence", () => {
    const tiny = {
      ...CAND,
      evidence: [
        { session: "aaaa1111", quote: "e" },
        { session: "bbbb2222", quote: "the" },
        { session: "cccc3333", quote: "review" },
      ],
    };
    expect(gateCandidate(tiny, sessions, new Set())).toBeNull();
    const threeWords = {
      ...CAND,
      evidence: [...CAND.evidence.slice(0, 2), { session: "cccc3333", quote: "the bot review" }],
    };
    expect(gateCandidate(threeWords, sessions, new Set())).toBeNull();
  });

  test("low confidence, an empty description and a taken name all fail", () => {
    expect(gateCandidate({ ...CAND, confidence: "low" }, sessions, new Set())).toBeNull();
    expect(gateCandidate({ ...CAND, description: "  " }, sessions, new Set())).toBeNull();
    expect(gateCandidate(CAND, sessions, new Set(["bot-re-review"]))).toBeNull();
  });

  test("a malformed reply is a failed call, not an empty one", () => {
    expect(parseCandidates(null)).toBeNull();
    expect(parseCandidates({ nothing: true })).toBeNull();
    expect(parseCandidates({ candidates: [7, { name: "x" }] })).toEqual([]);
  });
});

describe("renderDraft", () => {
  test("renders a SKILL.md draft with steps, guardrails and evidence", () => {
    const text = renderDraft({ ...CAND, name: "bot-re-review" }, "sk-001", "2026-09-24");
    expect(text.startsWith(`---\nname: bot-re-review\ndescription: ${CAND.description}\n---\n`)).toBe(true);
    expect(text).toContain(
      "## Steps\n1. gh pr comment $PR --body '@review-bot review'\n2. poll gh pr checks until fresh\n",
    );
    expect(text).toContain("## Guardrails (from corrections)\n- never mention the assistant in the comment\n");
    expect(text).toContain("- session `aaaa1111`: “ask the bot to re-review”");
    expect(text).toContain(
      "*Candidate sk-001, proposed by skill-learn on 2026-09-24 from 3 sessions (confidence high).",
    );
  });
});

describe("discover", () => {
  test("a gated candidate lands in the ledger with a runtime id; the repository is untouched", () => {
    const { ctx, root, packageRoot } = fixture([
      { candidates: [CAND, { ...CAND, name: "thin", evidence: CAND.evidence.slice(0, 1) }] },
    ]);
    const summary = discover(ctx, root, { packageRoot });
    expect(summary).toBe("analysed 3 sessions; 1 new candidates: sk-001 bot-re-review");
    expect(ctx.prompts[0]).toContain("#### session aaaa1111");
    const ledger = skillsLedger(ctx, root);
    const registry = loadRegistry(ledger);
    expect(registry.candidates["sk-001"]).toMatchObject({
      name: "bot-re-review",
      scope: "global",
      status: "candidate",
      evidence: 3,
      uses: 0,
    });
    expect(registry.next).toBe(2);
    expect(readFileSync(ledger.path("candidates", "sk-001.md"), "utf8")).toContain("# bot-re-review");
    expect(run(["git", "status", "--porcelain"], { cwd: ledger.dir }).stdout).toBe("");
    expect(repoClean(root)).toBe(true);
  });

  test("a dry run prints the prompt and writes nothing", () => {
    const { ctx, root, packageRoot } = fixture();
    const dry: TestContext = { ...ctx, config: { ...ctx.config, dryRun: true } };
    expect(discover(dry, root, { packageRoot })).toBe("dry run");
    expect(ctx.prompts).toEqual([]);
    expect(ctx.out.join("\n")).toContain("## Output contract (enforced by the runtime)");
    expect(existsSync(loopDir(ctx.config, root, "skills"))).toBe(false);
  });

  test("a dry skills run creates no skills ledger", () => {
    const { ctx, root } = fixture();
    const dry: TestContext = { ...ctx, config: { ...ctx.config, dryRun: true } };
    expect(runSkillLearn(dry, root)).toBe("dry run");
    expect(ctx.prompts).toEqual([]);
    expect(existsSync(loopDir(ctx.config, root, "skills"))).toBe(false);
  });

  test("a failed judge call leaves the sessions unmarked for the next pass", () => {
    const { ctx, root, packageRoot } = fixture([null, { candidates: [CAND] }]);
    expect(discover(ctx, root, { packageRoot })).toBe("judge call failed (sessions left unmarked)");
    expect(loadRegistry(skillsLedger(ctx, root)).seen_sessions).toEqual({});
    expect(discover(ctx, root, { packageRoot })).toContain("1 new candidates");
  });

  test("fewer than three new sessions calls no judge and marks nothing", () => {
    const ctx = testContext();
    const root = gitRepo(join(scratch(), "repo"));
    transcript(ctx, root, "aaaa1111-0000", SESSIONS["aaaa1111-0000"]!);
    expect(discover(ctx, root)).toBe("only 1 new sessions; nothing to analyse");
    expect(ctx.prompts).toEqual([]);
    expect(loadRegistry(skillsLedger(ctx, root)).seen_sessions).toEqual({});
  });

  test("a rejected name is never proposed again", () => {
    const { ctx, root, packageRoot } = fixture([{ candidates: [CAND] }, { candidates: [CAND] }]);
    discover(ctx, root, { packageRoot });
    expect(rejectCandidate(ctx, root, "sk-001")).toBe(true);
    const ledger = skillsLedger(ctx, root);
    expect(existsSync(ledger.path("candidates", "sk-001.md"))).toBe(false);
    expect(discover(ctx, root, { packageRoot, force: true })).toContain("0 new candidates");
    expect(ctx.prompts[1]).toContain("## Rejected names (never propose again)\n\nbot-re-review");
    expect(loadRegistry(ledger).rejected).toEqual(["bot-re-review"]);
  });
});

describe("uses and promotion", () => {
  test("uses counts distinct claude-mem sessions that read the draft", () => {
    const { ctx, root, packageRoot } = fixture([{ candidates: [CAND] }]);
    discover(ctx, root, { packageRoot });
    const ledger = skillsLedger(ctx, root);
    const draft = ledger.path("candidates", "sk-001.md");
    const memDb = join(scratch(), "mem.db");
    const mem = new MemFixture(memDb);
    const at = Date.now();
    mem.observation({ sid: "s1", project: "repo", type: "discovery", filesRead: [draft], at });
    mem.observation({ sid: "s1", project: "repo", type: "discovery", filesRead: [draft], at });
    mem.observation({ sid: "s2", project: "repo", type: "discovery", filesRead: [draft, "/other"], at });
    mem.observation({
      sid: "s3",
      project: "repo",
      type: "discovery",
      filesRead: [ledger.path("candidates", "sk-002.md")],
      at,
    });
    mem.close();
    const withMem: TestContext = { ...ctx, config: { ...ctx.config, memDb } };

    const registry = loadRegistry(ledger);
    expect(measureUses(withMem, ledger, registry)).toBe(1);
    expect(registry.candidates["sk-001"]!.uses).toBe(2);
    expect(runSkillLearn(withMem, root)).toBe("1 candidates pending (bot-re-review=2)");
    expect(loadRegistry(ledger).candidates["sk-001"]!.uses).toBe(2);
  });

  test("skills run discovers at most once a day, so fresh sessions on the next stop make no judge call", () => {
    const { ctx, root } = fixture([{ candidates: [CAND] }, { candidates: [] }]);
    expect(skillsArea.verbs.run!.run(parseLearnArgs(["--repo", root]), ctx)).toBe(0);
    expect(ctx.prompts).toHaveLength(1);
    expect(ctx.out.at(-1)).toContain("1 candidates pending (bot-re-review=0)");
    transcript(ctx, root, "dddd4444-0000", ["ask the bot to re-review again", "the head moved once more"]);
    transcript(ctx, root, "eeee5555-0000", ["re-trigger the review bot please", "after the rebase landed"]);
    transcript(ctx, root, "ffff6666-0000", ["bot review is stale again, rerun", "the fix is pushed now"]);
    expect(skillsArea.verbs.run!.run(parseLearnArgs(["--repo", root]), ctx)).toBe(0);
    expect(ctx.prompts).toHaveLength(1);
    expect(ctx.out.at(-1)).toBe("1 candidates pending (bot-re-review=0)");
  });

  test("promote prints a writing-skills input, marks the hand-off, and installs nothing", () => {
    const { ctx, root, packageRoot } = fixture([{ candidates: [CAND] }]);
    discover(ctx, root, { packageRoot });
    const text = promoteCandidate(ctx, root, "sk-001")!;
    expect(text.split("\n")[0]).toBe(
      "Input for the writing-skills skill: candidate sk-001 (bot-re-review), used by 0 sessions, evidence from 3.",
    );
    expect(text).toContain("---\nname: bot-re-review\n");
    const info = loadRegistry(skillsLedger(ctx, root)).candidates["sk-001"]!;
    expect(info.status).toBe("promoted");
    expect(existsSync(join(ctx.config.configDir, "skills", "bot-re-review"))).toBe(false);
    expect(repoClean(root)).toBe(true);
    expect(promoteCandidate(ctx, root, "sk-404")).toBeNull();
  });
});

describe("ak learn skills", () => {
  function verb(ctx: TestContext, name: string, argv: string[]): number {
    return skillsArea.verbs[name]!.run(parseLearnArgs(argv), ctx);
  }

  test("list, promote and reject through the CLI", () => {
    const { ctx, root, packageRoot } = fixture([{ candidates: [CAND] }]);
    discover(ctx, root, { packageRoot });
    expect(verb(ctx, "list", ["--repo", root])).toBe(0);
    expect(ctx.out[0]).toMatch(/^sk-001 {2}candidate bot-re-review +scope=global uses=0 evidence=3 high$/);
    expect(ctx.out[1]).toBe("1 candidates, 0 rejected names, 3 sessions seen");
    expect(verb(ctx, "promote", ["--repo", root])).toBe(2);
    expect(ctx.err.at(-1)).toBe("ak learn skills: --id is required");
    expect(verb(ctx, "reject", ["--repo", root, "--id", "sk-009"])).toBe(1);
    expect(ctx.err.at(-1)).toBe("ak learn skills reject: unknown candidate 'sk-009'; did you mean sk-001?");
    expect(verb(ctx, "promote", ["--repo", root, "--id", "sk-01"])).toBe(1);
    expect(ctx.err.at(-1)).toBe("ak learn skills promote: unknown candidate 'sk-01'; did you mean sk-001?");
    expect(verb(ctx, "reject", ["--repo", root, "sk-001"])).toBe(0);
    expect(ctx.out.at(-1)).toBe("rejected sk-001");
  });

  test("a --repo that names nothing is refused, not read as a project with no candidates", () => {
    const { ctx, root } = fixture();
    const missing = `${root}-gone`;
    for (const name of ["list", "roster"]) {
      ctx.err.length = 0;
      expect(verb(ctx, name, ["--repo", missing])).toBe(2);
      expect(ctx.err).toEqual([
        `ak learn skills: --repo names no directory: unknown repository '${missing}'; there are none to choose from`,
      ]);
    }
  });

  test("discover validates --since and refuses to run outside a repository", () => {
    const { ctx, root } = fixture();
    expect(verb(ctx, "discover", ["--repo", root, "--since", "soon"])).toBe(2);
    const { outside, code } = inOutsideRepo((cwd) => {
      const created = testContext({ cwd });
      return { outside: created, code: verb(created, "discover", []) };
    });
    expect(code).toBe(2);
    expect(outside.err[0]).toBe("ak learn skills: not inside a git repository; pass --repo");
  });
});
