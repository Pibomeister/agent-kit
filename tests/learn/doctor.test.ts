/**
 * `ak learn doctor`: the three host parsers, sampling, scoring, the edit gates,
 * the impact record, the report and the command's output and judge guards.
 * Every session here is a synthetic fixture; no real transcript is read.
 */
import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { runLearn } from "../../src/learn/cli.ts";
import { parseLearnArgs } from "../../src/learn/core/context.ts";
import { DEFAULT_JUDGE } from "../../src/learn/core/config.ts";
import { commandJudge, subscriptionEnv, type JudgeCallContext, type JudgeFn } from "../../src/learn/core/judge.ts";
import { worktreesPath } from "../../src/learn/core/paths.ts";
import { run as runProcess } from "../../src/learn/core/proc.ts";
import { scrubSecrets } from "../../src/learn/core/secrets.ts";
import { skillsLedger } from "../../src/learn/skills/learn.ts";
import { doctorArea, collectOptions, outputRefusal } from "../../src/learn/doctor/cli.ts";
import {
  collect,
  type CollectOptions,
  DOCTOR_HOSTS,
  type DoctorSession,
  MAX_MSG_CHARS,
  renderTranscript,
  sample,
  type SkillInfo,
  truncate,
} from "../../src/learn/doctor/collect.ts";
import type { JsonObject, JsonValue } from "../../src/learn/doctor/json.ts";
import { renderReport, repoArgument } from "../../src/learn/doctor/render.ts";
import { aggregate, gradeFor, parseScore, type SessionScore } from "../../src/learn/doctor/score.ts";
import {
  type Advice,
  decide,
  gateSuggestion,
  IMPACT_PAGE,
  loadImpact,
  parseAdvice,
  recordRun,
  RUNS_DIR,
  unifiedDiff,
} from "../../src/learn/doctor/suggest.ts";
import { gitRepo, MemFixture, scratch, testContext, type TestContext } from "./helpers.ts";

const HOUR = 3_600_000;

const SKILL_TEXT = `---
name: diagnose
description: Find the cause of a defect.
---

# Diagnose

Reproduce first.
Then bisect.
`;

function jsonl(path: string, rows: readonly JsonValue[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
}

function touch(path: string, at: number): void {
  utimesSync(path, at / 1000, at / 1000);
}

interface World {
  base: string;
  repo: string;
  skillPath: string;
  claude: string;
  codex: string;
  grok: string;
  now: number;
}

/** One repository with one skill, and one session of it per host, plus sessions every filter must drop. */
function world(): World {
  const now = Date.now();
  const base = scratch("ak-doctor-");
  const repo = gitRepo(join(base, "repo"));
  const skillPath = join(repo, "skills", "diagnose", "SKILL.md");
  mkdirSync(dirname(skillPath), { recursive: true });
  writeFileSync(skillPath, SKILL_TEXT);
  const claude = join(base, "claude");
  const codex = join(base, "codex");
  const grok = join(base, "grok");

  const claudeFile = join(claude, "projects", "-repo", "c1.jsonl");
  jsonl(claudeFile, [
    {
      type: "user",
      sessionId: "c1",
      cwd: repo,
      timestamp: "2026-10-30T10:00:00Z",
      message: { role: "user", content: "Fix the flaky parser test" },
    },
    {
      type: "user",
      sessionId: "c1",
      message: { role: "user", content: "<system-reminder>host text</system-reminder>" },
    },
    {
      type: "assistant",
      sessionId: "c1",
      message: {
        content: [
          { type: "text", text: "Loading the skill." },
          { type: "tool_use", name: "Skill", input: { skill: "ak:diagnose" } },
        ],
      },
    },
    {
      type: "user",
      sessionId: "c1",
      message: { content: [{ type: "tool_result", content: "exit code 1", is_error: true }] },
    },
    {
      type: "assistant",
      sessionId: "c1",
      message: { content: [{ type: "tool_use", name: "Edit", input: { file_path: "src/parser.ts" } }] },
    },
    { type: "user", sessionId: "c1", message: { role: "user", content: "no, use the v2 client" } },
    { type: "user", sessionId: "c1", isSidechain: true, message: { role: "user", content: "sidechain work" } },
  ]);
  touch(claudeFile, now - HOUR);

  const elsewhere = join(claude, "projects", "-elsewhere", "c2.jsonl");
  jsonl(elsewhere, [
    { type: "user", sessionId: "c2", cwd: "/elsewhere/project", message: { role: "user", content: "Hello there" } },
    { type: "assistant", sessionId: "c2", message: { content: [{ type: "tool_use", name: "Read", input: {} }] } },
  ]);
  touch(elsewhere, now - HOUR);

  const stale = join(claude, "projects", "-repo", "c3.jsonl");
  jsonl(stale, [
    { type: "user", sessionId: "c3", cwd: repo, message: { role: "user", content: "An old request" } },
    { type: "assistant", sessionId: "c3", message: { content: [{ type: "tool_use", name: "Read", input: {} }] } },
  ]);
  touch(stale, now - 60 * 24 * HOUR);

  const codexFile = join(codex, "sessions", "2026", "10", "30", "rollout-x1.jsonl");
  jsonl(codexFile, [
    { type: "session_meta", payload: { id: "x1", cwd: join(repo, "src"), timestamp: "2026-10-30T09:00:00Z" } },
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "<environment_context>cwd</environment_context>" }],
      },
    },
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "<skill>\n<name>diagnose</name>\nbody</skill>" }],
      },
    },
    {
      type: "response_item",
      payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Run the suite" }] },
    },
    {
      type: "response_item",
      payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Running it." }] },
    },
    { type: "response_item", payload: { type: "function_call", name: "shell", arguments: '{"cmd":["bun","test"]}' } },
    { type: "response_item", payload: { type: "function_call", name: "shell", arguments: '{"cmd":["bun","test"]}' } },
    { type: "response_item", payload: { type: "function_call_output", output: "1 pass" } },
  ]);
  touch(codexFile, now - 2 * HOUR);

  const subagent = join(codex, "sessions", "2026", "10", "30", "rollout-sub.jsonl");
  jsonl(subagent, [
    { type: "session_meta", payload: { id: "sub", cwd: repo, source: { subagent: "review" } } },
    {
      type: "response_item",
      payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Reviewing." }] },
    },
    { type: "response_item", payload: { type: "function_call", name: "shell", arguments: "{}" } },
  ]);
  touch(subagent, now - 2 * HOUR);

  const grokDir = join(grok, "sessions", encodeURIComponent(repo), "g1");
  const grokHistory = join(grokDir, "chat_history.jsonl");
  jsonl(grokHistory, [
    { type: "user", content: "/diagnose the timeout" },
    { type: "user", content: "a summary of earlier turns", synthetic_reason: "compaction" },
    {
      type: "assistant",
      content: "Reading the file.",
      tool_calls: [{ function: { name: "read_file", arguments: '{"path":"a.ts"}' } }],
    },
    { type: "tool_result", content: "export const a = 1;" },
  ]);
  writeFileSync(
    join(grokDir, "summary.json"),
    JSON.stringify({ info: { id: "g1" }, created_at: "2026-10-30T08:00:00Z" }),
  );
  touch(grokHistory, now - 3 * HOUR);

  return { base, repo, skillPath, claude, codex, grok, now };
}

function options(w: World, extra: Partial<CollectOptions> = {}): CollectOptions {
  return {
    hosts: DOCTOR_HOSTS,
    repos: [w.repo],
    days: 45,
    maxSessions: 12,
    perSkill: 3,
    noSkill: 4,
    includeGlobalSkills: false,
    worktrees: [],
    claudeHomes: [w.claude],
    codexHomes: [w.codex],
    grokHomes: [w.grok],
    skillDirs: [],
    now: w.now,
    ...extra,
  };
}

function find(sessions: readonly DoctorSession[], key: string): DoctorSession {
  const found = sessions.find((session) => session.key === key);
  if (found === undefined) throw new Error(`no session ${key}`);
  return found;
}

function texts(session: DoctorSession): string {
  return session.entries.map((entry) => `[${entry.kind}] ${entry.text}`).join("\n");
}

describe("collect", () => {
  test("reads the repository's Claude Code, Codex and Grok sessions inside the window", () => {
    const w = world();
    const collection = collect(options(w), {});
    expect(collection.sampled.map((session) => session.key)).toEqual(["claude-c1", "codex-x1", "grok-g1"]);
    expect(collection.sessions_scanned).toBe(5);
    expect(collection.skills.map((skill) => skill.name)).toEqual(["diagnose"]);
    for (const session of collection.sampled) expect(session.skills_used).toEqual(["diagnose"]);
  });

  test("Claude Code: host-injected turns and subagent rows are left out, corrections and errors are counted", () => {
    const w = world();
    const claude = find(collect(options(w, { hosts: ["claude"] }), {}).sampled, "claude-c1");
    expect(claude.cwd).toBe(w.repo);
    expect(claude.stats).toMatchObject({ user_turns: 2, corrections: 1, error_outputs: 1, code_edits: true });
    expect(texts(claude)).not.toContain("host text");
    expect(texts(claude)).not.toContain("sidechain work");
  });

  test("a session whose first records outrun the peek is still placed by its working directory", () => {
    const w = world();
    const claudeFile = join(w.claude, "projects", "-repo", "long.jsonl");
    jsonl(claudeFile, [
      { type: "user", sessionId: "long", cwd: w.repo, message: { role: "user", content: "x".repeat(70_000) } },
      {
        type: "assistant",
        sessionId: "long",
        message: {
          content: [
            { type: "text", text: "On it." },
            { type: "tool_use", name: "Read", input: {} },
          ],
        },
      },
    ]);
    touch(claudeFile, w.now - HOUR);
    const codexFile = join(w.codex, "sessions", "2026", "10", "30", "rollout-long.jsonl");
    jsonl(codexFile, [
      { type: "session_meta", payload: { id: "xlong", cwd: w.repo, instructions: "y".repeat(70_000) } },
      {
        type: "response_item",
        payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "On it." }] },
      },
      { type: "response_item", payload: { type: "function_call", name: "shell", arguments: "{}" } },
    ]);
    touch(codexFile, w.now - HOUR);
    const keys = collect(options(w, { maxSessions: 50, noSkill: 50 }), {}).sampled.map((session) => session.key);
    expect(keys).toContain("claude-long");
    expect(keys).toContain("codex-xlong");
  });

  test("a symlinked skill directory is found, and a session using it counts as using it", () => {
    const w = world();
    const elsewhere = join(w.base, "elsewhere", "linked-skill");
    mkdirSync(elsewhere, { recursive: true });
    writeFileSync(join(elsewhere, "SKILL.md"), "---\nname: linked-skill\ndescription: Linked.\n---\n\nBody.\n");
    const skillsDir = join(w.base, "skills-dir");
    mkdirSync(skillsDir);
    symlinkSync(elsewhere, join(skillsDir, "linked-skill"));
    symlinkSync(join(w.base, "missing"), join(skillsDir, "dangling"));
    writeFileSync(join(skillsDir, "README.md"), "not a skill");
    const claudeFile = join(w.claude, "projects", "-repo", "c9.jsonl");
    jsonl(claudeFile, [
      { type: "user", sessionId: "c9", cwd: w.repo, message: { role: "user", content: "Do the linked work" } },
      {
        type: "assistant",
        sessionId: "c9",
        message: {
          content: [
            { type: "text", text: "Loading it." },
            { type: "tool_use", name: "Skill", input: { skill: "linked-skill" } },
          ],
        },
      },
    ]);
    touch(claudeFile, w.now - HOUR);
    const collection = collect(options(w, { hosts: ["claude"], skillDirs: [skillsDir] }), {});
    expect(collection.skills.map((skill) => skill.name)).toEqual(["diagnose", "linked-skill"]);
    expect(find(collection.sampled, "claude-c9").skills_used).toEqual(["linked-skill"]);
  });

  test("a skill's folded or quoted frontmatter is read as YAML", () => {
    const w = world();
    writeFileSync(
      w.skillPath,
      "---\nname: 'diagnose'\ndescription: >-\n  Find the cause\n  of a defect.\n---\n\nBody.\n",
    );
    expect(collect(options(w), {}).skills).toMatchObject([
      { name: "diagnose", description: "Find the cause of a defect." },
    ]);
  });

  test("Codex: a skill block is a skill load, a subagent rollout is skipped, a repeated call is counted", () => {
    const w = world();
    const collection = collect(options(w, { hosts: ["codex"] }), {});
    expect(collection.sampled.map((session) => session.key)).toEqual(["codex-x1"]);
    const codex = find(collection.sampled, "codex-x1");
    expect(codex.stats).toMatchObject({ user_turns: 1, tool_calls: 2, repeated_tool_calls: 1 });
    expect(codex.entries).toContainEqual({ kind: "note", text: "[skill loaded: diagnose]" });
    expect(texts(codex)).not.toContain("environment_context");
  });

  test("Grok: the working directory comes from the session folder and synthetic turns are left out", () => {
    const w = world();
    const grok = find(collect(options(w, { hosts: ["grok"] }), {}).sampled, "grok-g1");
    expect(grok.cwd).toBe(w.repo);
    expect(grok.started_at).toBe("2026-10-30T08:00:00Z");
    expect(texts(grok)).toContain("[tool:read_file]");
    expect(texts(grok)).not.toContain("summary of earlier turns");
  });

  test("a message is cut at the per-message cap and a long transcript keeps its head and tail", () => {
    const long = "x".repeat(MAX_MSG_CHARS + 25);
    expect(truncate(long, MAX_MSG_CHARS)).toBe(`${"x".repeat(MAX_MSG_CHARS)} [… 25 chars cut]`);
    const w = world();
    const session = find(collect(options(w, { hosts: ["claude"] }), {}).sampled, "claude-c1");
    const entries = Array.from({ length: 200 }, (_, index) => ({ kind: "user", text: `turn ${index}` }));
    const rendered = renderTranscript({ ...session, entries });
    expect(rendered).toContain("[user] turn 99");
    expect(rendered).not.toContain("[user] turn 100\n");
    expect(rendered).toContain("[… 60 entries omitted …]");
    expect(rendered).toContain("[user] turn 160");
  });
});

function synthetic(key: string, skills: string[], modified: number): DoctorSession {
  return {
    key,
    host: "claude",
    id: key,
    cwd: null,
    started_at: null,
    modified_ms: modified,
    stats: {
      user_turns: 1,
      assistant_turns: 1,
      tool_calls: 1,
      repeated_tool_calls: 0,
      error_outputs: 0,
      code_edits: false,
      corrections: 0,
    },
    skills_used: skills,
    entries: [],
  };
}

describe("sample", () => {
  const sessions = [
    synthetic("a", ["diagnose"], 5),
    synthetic("b", ["diagnose"], 4),
    synthetic("c", ["tdd"], 3),
    synthetic("d", [], 2),
    synthetic("e", [], 1),
  ];

  test("newest first: a quota per skill, then sessions that used none", () => {
    const picked = sample(sessions, { maxSessions: 12, perSkill: 1, noSkill: 1 });
    expect(picked.map((session) => session.key)).toEqual(["a", "c", "d"]);
  });

  test("the session cap wins over both quotas", () => {
    const picked = sample(sessions, { maxSessions: 2, perSkill: 3, noSkill: 4 });
    expect(picked.map((session) => session.key)).toEqual(["a", "b"]);
  });
});

function labels(efficiency: string, codeQuality: string, procedure: string, verbosity: string): JsonObject {
  return {
    efficiency: { label: efficiency, reason: "e" },
    code_quality: { label: codeQuality, reason: "q" },
    procedure_compliance: { label: procedure, reason: "p" },
    verbosity: { label: verbosity, reason: "v" },
  };
}

describe("score", () => {
  const session = synthetic("s1", ["diagnose"], 1);

  test("four valid labels score the session; any applicable score below 0.5 fails it", () => {
    const good = parseScore(session, labels("highly_efficient", "approve", "fully_compliant", "proportionate"));
    expect(good).toMatchObject({ status: "scored", failed: false });
    const verbose = parseScore(session, labels("highly_efficient", "approve", "fully_compliant", "verbose"));
    expect(verbose).toMatchObject({ status: "scored", failed: true });
    const unseen = parseScore(
      session,
      labels("mostly_efficient", "insufficient_evidence", "mostly_compliant", "proportionate"),
    );
    expect(unseen.failed).toBe(false);
    expect(unseen.results.code_quality?.score).toBeNull();
  });

  test("a missing, invalid or declined reply is unavailable, never a zero", () => {
    const invalid = parseScore(session, labels("fast", "approve", "fully_compliant", "proportionate"));
    expect(invalid).toMatchObject({ status: "unavailable", why: "invalid or missing: efficiency", failed: false });
    expect(parseScore(session, { unavailable: "transcript too short" })).toMatchObject({
      status: "unavailable",
      why: "transcript too short",
    });
    expect(parseScore(session, null)).toMatchObject({ status: "unavailable", why: "no usable reply" });
  });

  test("the aggregate curves each rubric mean, weights them with coverage and grades the result", () => {
    const a = parseScore(
      synthetic("a", ["diagnose"], 1),
      labels("highly_efficient", "approve", "fully_compliant", "proportionate"),
    );
    const b = parseScore(
      synthetic("b", [], 1),
      labels("mostly_inefficient", "insufficient_evidence", "mostly_compliant", "verbose"),
    );
    const lost = parseScore(synthetic("c", [], 1), null);
    const result = aggregate([a, b, lost], 1);
    expect(result.raw.efficiency).toBeCloseTo(0.7);
    expect(result.raw.code_quality).toBeCloseTo(1);
    expect(result.scores?.efficiency).toBeCloseTo(0.85);
    expect(result.scores?.verbosity).toBeCloseTo(0.8);
    expect(result.scores?.skill_coverage).toBeCloseTo(0.5);
    expect(result.scores?.overall).toBeCloseTo(0.8475);
    expect(result.grade).toBe("B");
    expect(result.failed).toEqual(["b"]);
    expect(result.sessions_unavailable).toBe(1);
    expect(result.notes.join("\n")).toContain("1 sampled session(s) could not be scored");
  });

  test("a rubric with no evidence counts as 0.5 and says so; no installed skill means no coverage", () => {
    const only = parseScore(
      synthetic("a", [], 1),
      labels("highly_efficient", "insufficient_evidence", "fully_compliant", "proportionate"),
    );
    const result = aggregate([only], 0);
    expect(result.raw.code_quality).toBeNull();
    expect(result.scores?.code_quality).toBeCloseTo(0.75);
    expect(result.scores?.skill_coverage).toBe(0);
    expect(result.notes.join("\n")).toContain("enough evidence for code_quality");
  });

  test("no scored session has no score and no grade, and says why", () => {
    const lost = aggregate([parseScore(synthetic("a", [], 1), null)], 1);
    expect(lost).toMatchObject({ grade: null, scores: null, sessions_scored: 0, sessions_unavailable: 1 });
    expect(lost.notes).toEqual(["1 sampled session(s) could not be scored and are left out of every mean."]);
    expect(aggregate([], 1)).toMatchObject({ grade: null, scores: null, notes: [] });
  });

  test("grade thresholds", () => {
    expect(gradeFor(0.97)).toBe("A+");
    expect(gradeFor(0.9699)).toBe("A");
    expect(gradeFor(0.6)).toBe("D");
    expect(gradeFor(0.5999)).toBe("F");
  });
});

describe("unifiedDiff", () => {
  test("one changed line, removal before addition, three lines of context", () => {
    expect(unifiedDiff("a\nb\nc\n", "a\nB\nc\n", "x/SKILL.md")).toBe(
      "--- a/x/SKILL.md\n+++ b/x/SKILL.md\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n",
    );
  });

  test("identical text has no diff; distant changes get separate hunks; a new file starts at zero", () => {
    expect(unifiedDiff("a\n", "a\n", "x")).toBe("");
    const before = Array.from({ length: 20 }, (_, index) => `l${index + 1}`).join("\n");
    const after = before.replace("l2\n", "L2\n").replace("l18\n", "L18\n");
    const diff = unifiedDiff(before, after, "x");
    expect(diff.match(/^@@/gm)?.length).toBe(2);
    expect(diff).toContain("@@ -1,5 +1,5 @@");
    expect(diff).toContain("@@ -15,6 +15,6 @@");
    expect(unifiedDiff("", "one\ntwo\n", "x")).toContain("@@ -0,0 +1,2 @@\n+one\n+two\n");
  });
});

function gateInput(w: { skillPath: string }, rejected: ReadonlyMap<string, ReadonlySet<string>> = new Map()) {
  const skills = new Map<string, SkillInfo>([
    ["diagnose", { name: "diagnose", path: w.skillPath, scope: "project", description: "Find the cause." }],
  ]);
  return {
    failed: new Set(["claude-c1"]),
    skills,
    rejectedRules: rejected,
    readSkill: (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : null),
  };
}

const EVIDENCE = [{ session: "claude-c1", scorer: "efficiency", moment: "Edited before reproducing." }];

function edit(extra: JsonObject = {}): JsonObject {
  return {
    skill: "diagnose",
    kind: "edit",
    change: "State the first step.",
    rule: "Reproduce before you edit.",
    evidence: EVIDENCE,
    replace: [{ old: "Reproduce first.", new: "Reproduce first, and record the failing command." }],
    ...extra,
  };
}

function newSkill(name: string, content: string): JsonObject {
  return { skill: name, kind: "new", change: "Add a skill.", rule: "Pin the clock.", evidence: EVIDENCE, content };
}

describe("gateSuggestion", () => {
  const skillDir = scratch("ak-doctor-gate-");
  const skillPath = join(skillDir, "SKILL.md");
  writeFileSync(skillPath, SKILL_TEXT);
  const input = gateInput({ skillPath });
  const gate = (raw: JsonObject, gated = input): string => {
    const outcome = gateSuggestion(raw, "r-1", gated);
    return "dropped" in outcome ? outcome.dropped.gate : "ok";
  };

  test("an edit that validates against the file becomes a suggestion with a computed diff", () => {
    const outcome = gateSuggestion(edit(), "r-1", input);
    if (!("suggestion" in outcome)) throw new Error(outcome.dropped.gate);
    expect(outcome.suggestion).toMatchObject({ id: "r-1", skill: "diagnose", kind: "edit", path: skillPath });
    expect(outcome.suggestion.diff).toContain("-Reproduce first.\n+Reproduce first, and record the failing command.");
    expect(outcome.suggestion.proposed).toContain("record the failing command");
  });

  test("each gate refuses what it exists to refuse", () => {
    expect(gate(edit({ kind: "rewrite" }))).toBe("missing skill, kind, change or rule");
    expect(gate(edit({ evidence: [{ session: "codex-x1", scorer: "efficiency", moment: "m" }] }))).toBe(
      "no evidence from a failed session",
    );
    expect(gate(edit({ evidence: [{ session: "claude-c1", scorer: "taste", moment: "m" }] }))).toBe(
      "no evidence from a failed session",
    );
    expect(gate(edit({ skill: "unknown" }))).toBe("an edit must name an installed skill");
    expect(gate(edit({ replace: [] }))).toBe("an edit needs at least one replacement");
    expect(gate(edit({ replace: [{ old: "Not in the file.", new: "x" }] }))).toBe(
      "a replacement's old text is not in the file exactly once",
    );
    expect(gate(edit({ replace: [{ old: "Reproduce first.", new: "Reproduce first." }] }))).toBe(
      "the edit changes nothing",
    );
    expect(gate(edit({ replace: [{ old: "name: diagnose", new: "name: triage" }] }))).toBe(
      "an edit may not rename the skill",
    );
    const long = Array.from({ length: 300 }, (_, index) => `line ${index}`).join("\n");
    expect(gate(edit({ replace: [{ old: "Then bisect.", new: long }] }))).toBe("a skill body is capped at 300 lines");
    const rejected = gateInput({ skillPath }, new Map([["diagnose", new Set(["reproduce before you edit"])]]));
    expect(gate(edit({ rule: "Reproduce, before you edit!" }), rejected)).toBe("a human rejected this rule before");
  });

  test("a block-scalar name is read as its value, so renaming it is refused", () => {
    const folded = join(skillDir, "FOLDED.md");
    writeFileSync(folded, "---\nname: >-\n  diagnose\ndescription: d\n---\n\nBody.\n");
    const foldedInput = {
      ...input,
      skills: new Map<string, SkillInfo>([
        ["diagnose", { name: "diagnose", path: folded, scope: "project", description: "d" }],
      ]),
    };
    expect(gate(edit({ replace: [{ old: "  diagnose", new: "  triage" }] }), foldedInput)).toBe(
      "an edit may not rename the skill",
    );
  });

  test("a new skill needs a fresh kebab name that its own frontmatter carries", () => {
    const content = "---\nname: pin-clock\ndescription: Pin the clock.\n---\n\nPin it.\n";
    const outcome = gateSuggestion(newSkill("pin-clock", content), "r-2", input);
    if (!("suggestion" in outcome)) throw new Error(outcome.dropped.gate);
    expect(outcome.suggestion.kind).toBe("new");
    expect(outcome.suggestion.path).toBeUndefined();
    expect(outcome.suggestion.diff).toContain("@@ -0,0 +1,6 @@");
    expect(gate(newSkill("diagnose", SKILL_TEXT))).toBe("a new skill may not reuse an installed name");
    expect(gate(newSkill("Pin_Clock", content))).toBe("a new skill name must be lowercase kebab");
    expect(gate(newSkill("pin-time", content))).toBe("a new skill's frontmatter must name it");
  });
});

describe("parseAdvice", () => {
  const skillDir = scratch("ak-doctor-advice-");
  const skillPath = join(skillDir, "SKILL.md");
  writeFileSync(skillPath, SKILL_TEXT);

  test("findings are capped at three, suggestions at five, and every suggestion is gated", () => {
    const reply: JsonObject = {
      findings: ["one", "", "two", "three", "four"],
      suggestions: [edit(), edit({ skill: "unknown" }), edit(), edit(), edit(), edit()],
      deferred: [
        { finding: "Verbose summaries.", why: "One session only." },
        { finding: "", why: "no pattern" },
      ],
    };
    const advice = parseAdvice(reply, "run1", gateInput({ skillPath }));
    expect(advice.status).toBe("ok");
    expect(advice.findings).toEqual(["one", "two", "three"]);
    expect(advice.suggestions.map((s) => s.id)).toEqual(["run1-1", "run1-3", "run1-4", "run1-5"]);
    expect(advice.dropped).toEqual([
      { skill: "unknown", change: "State the first step.", gate: "an edit must name an installed skill" },
    ]);
    expect(advice.deferred).toEqual([{ finding: "Verbose summaries.", why: "One session only." }]);
  });

  test("no reply, or a declared one, proposes nothing", () => {
    expect(parseAdvice(null, "r", gateInput({ skillPath }))).toMatchObject({ status: "unavailable", suggestions: [] });
    expect(parseAdvice({ unavailable: "no failed session" }, "r", gateInput({ skillPath }))).toMatchObject({
      status: "unavailable",
      why: "no failed session",
    });
  });
});

describe("impact record", () => {
  test("a run records labels and proposals; a human decides each proposal once", () => {
    const ctx = testContext();
    const repo = gitRepo(join(scratch("ak-doctor-ledger-"), "repo"));
    const ledger = skillsLedger(ctx, repo);
    const skillPath = join(repo, "SKILL.md");
    writeFileSync(skillPath, SKILL_TEXT);
    const advice = parseAdvice({ findings: ["f"], suggestions: [edit()] }, "run1", gateInput({ skillPath }));
    const scores: SessionScore[] = [
      parseScore(
        synthetic("claude-c1", ["diagnose"], 1),
        labels("highly_inefficient", "approve", "fully_compliant", "proportionate"),
      ),
    ];
    expect(recordRun(ledger, "run1", scores, aggregate(scores, 1), advice)).not.toBeNull();
    const runFile = readFileSync(ledger.path(RUNS_DIR, "run1.json"), "utf8");
    expect(runFile).toContain('"efficiency": "highly_inefficient"');
    expect(runFile).not.toContain('"reason"');
    expect(loadImpact(ledger.dir)).toMatchObject([{ id: "run1-1", status: "proposed", skill: "diagnose" }]);
    expect(decide(ledger, "run1-9", "accepted", undefined)).toBe("unknown");
    expect(decide(ledger, "run1-1", "rejected", "too narrow")).toBe("ok");
    expect(decide(ledger, "run1-1", "accepted", undefined)).toBe("decided");
    expect(loadImpact(ledger.dir)).toMatchObject([{ id: "run1-1", status: "rejected", reason: "too narrow" }]);
    expect(readFileSync(ledger.path(IMPACT_PAGE), "utf8")).toContain("## run1-1 — diagnose (rejected)");
  });

  test("a held lock writes nothing, and a failed commit is reported", () => {
    const ctx = testContext();
    const ledger = skillsLedger(ctx, gitRepo(join(scratch("ak-doctor-lock-"), "repo")));
    const scores = [
      parseScore(
        synthetic("claude-c1", [], 1),
        labels("highly_efficient", "approve", "fully_compliant", "proportionate"),
      ),
    ];
    const advice: Advice = { status: "ok", findings: [], suggestions: [], dropped: [], deferred: [] };
    const skillPath = join(ledger.dir, "SKILL.md");
    writeFileSync(skillPath, SKILL_TEXT);
    const proposing = parseAdvice({ suggestions: [edit()] }, "run2", gateInput({ skillPath }));

    const release = ledger.tryLock();
    if (release === null) throw new Error("no lock");
    expect(recordRun(ledger, "run1", scores, aggregate(scores, 0), advice)).toBeNull();
    expect(existsSync(ledger.path(RUNS_DIR, "run1.json"))).toBe(false);
    expect(decide(ledger, "run2-1", "accepted", undefined)).toBe("locked");
    release();

    expect(recordRun(ledger, "run2", scores, aggregate(scores, 0), proposing)).not.toBeNull();
    writeFileSync(join(ledger.dir, ".git", "index.lock"), "");
    expect(decide(ledger, "run2-1", "accepted", undefined)).toBe("uncommitted");
    expect(loadImpact(ledger.dir)).toMatchObject([{ id: "run2-1", status: "accepted" }]);
  });
});

describe("renderReport", () => {
  test("every judge-supplied value is escaped and the page loads nothing remote", () => {
    const w = world();
    const collection = collect(options(w), {});
    const scores = collection.sampled.map((session) =>
      parseScore(session, labels("highly_efficient", "approve", "fully_compliant", "proportionate")),
    );
    const advice: Advice = {
      status: "ok",
      findings: ["<script>alert(1)</script>"],
      suggestions: [],
      dropped: [{ skill: "x", change: "<img src=x>", gate: "g" }],
      deferred: [],
    };
    const html = renderReport({
      title: "T & <b>",
      collection,
      scores,
      aggregate: aggregate(scores, 1),
      advice,
      decideRepo: null,
    });
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain("<img src=x>");
    expect(html).toContain("T &amp; &lt;b&gt;");
    expect(html).toContain("Content-Security-Policy");
    expect(html).not.toMatch(/(?:src|href)="https?:/);
    expect(html).not.toContain("Fix the flaky parser test");
  });
});

describe("subscription-only judge", () => {
  test("metered credentials are dropped by name; the signed-in seat's variables stay", () => {
    expect(
      subscriptionEnv({
        ANTHROPIC_API_KEY: "k",
        OPENAI_API_KEY: "k",
        ANTHROPIC_AUTH_TOKEN: "t",
        AWS_BEARER_TOKEN_BEDROCK: "t",
        CLAUDE_CODE_USE_BEDROCK: "1",
        CLAUDE_CODE_USE_VERTEX: "1",
        ANTHROPIC_BASE_URL: "http://proxy",
        ANTHROPIC_BEDROCK_BASE_URL: "http://proxy",
        CLAUDE_CODE_OAUTH_TOKEN: "o",
        HOME: "/h",
        PATH: "/bin",
      }),
    ).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: "o", HOME: "/h", PATH: "/bin" });
  });

  test("the judge command never sees a metered credential when it is subscription-only", () => {
    const ctx = testContext();
    const script =
      'if [ -n "$ANTHROPIC_API_KEY" ]; then echo \'{"key":"present"}\'; else echo \'{"key":"absent"}\'; fi';
    const config = { ...ctx.config, judgeCommand: ["sh", "-c", script] };
    const context: JudgeCallContext = { runId: null, loop: "skills", role: "session-scorer", project: "p" };
    const previous = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "fixture-value";
    try {
      expect(commandJudge(config, { subscriptionOnly: true })("prompt", context)).toEqual({ key: "absent" });
      expect(commandJudge(config)("prompt", context)).toEqual({ key: "present" });
    } finally {
      if (previous === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = previous;
    }
  });

  test("user settings cannot reapply a metered credential, base URL or key helper inside the judge", () => {
    const ctx = testContext();
    const bin = scratch("ak-judge-bin-");
    const claude = join(bin, "claude");
    writeFileSync(claude, "#!/usr/bin/env bun\nconsole.log(JSON.stringify({ argv: process.argv.slice(2) }));\n");
    chmodSync(claude, 0o755);
    const configDir = scratch("ak-judge-config-");
    writeFileSync(
      join(configDir, "settings.json"),
      JSON.stringify({
        env: { ANTHROPIC_BASE_URL: "http://proxy", CLAUDE_CODE_USE_BEDROCK: "1", ANTHROPIC_API_KEY: "k", KEEP: "v" },
        apiKeyHelper: "print-key",
      }),
    );
    const config = { ...ctx.config, configDir, judgeCommand: [claude, ...DEFAULT_JUDGE.slice(1)] };
    const context: JudgeCallContext = { runId: null, loop: "skills", role: "session-scorer", project: "p" };
    expect(settingsOf(commandJudge(config, { subscriptionOnly: true })("prompt", context))).toEqual([
      {
        disableAllHooks: true,
        env: { ANTHROPIC_BASE_URL: "", CLAUDE_CODE_USE_BEDROCK: "", ANTHROPIC_API_KEY: "" },
        apiKeyHelper: "",
      },
    ]);
    expect(settingsOf(commandJudge(config)("prompt", context))).toEqual([{ disableAllHooks: true }]);
    mkdirSync(config.runtimeDir, { recursive: true });
    writeFileSync(join(config.runtimeDir, "judge-settings.json"), JSON.stringify({ disableAllHooks: true }));
    const fromFile = {
      ...config,
      judgeCommand: [claude, "-p", "--settings={}", "--settings", "judge-settings.json"],
    };
    const equalsForm = { ...config, judgeCommand: [claude, "-p", '--settings={"disableAllHooks":true}'] };
    expect(settingsOf(commandJudge(fromFile, { subscriptionOnly: true })("prompt", context))).toEqual([
      {
        disableAllHooks: true,
        env: { ANTHROPIC_BASE_URL: "", CLAUDE_CODE_USE_BEDROCK: "", ANTHROPIC_API_KEY: "" },
        apiKeyHelper: "",
      },
    ]);
    expect(settingsOf(commandJudge(equalsForm, { subscriptionOnly: true })("prompt", context))).toEqual([
      {
        disableAllHooks: true,
        env: { ANTHROPIC_BASE_URL: "", CLAUDE_CODE_USE_BEDROCK: "", ANTHROPIC_API_KEY: "" },
        apiKeyHelper: "",
      },
    ]);
  });
});

function verb(name: string, argv: readonly string[], ctx: TestContext): number {
  const found = doctorArea.verbs[name];
  if (found === undefined) throw new Error(`no verb ${name}`);
  return found.run(parseLearnArgs(argv), ctx);
}

/** Each `--settings` value the fake host CLI echoed back as its argv, parsed. */
function settingsOf(reply: ReturnType<JudgeFn>): unknown[] {
  const argv = Array.isArray(reply?.argv) ? reply.argv.map(String) : [];
  return argv.flatMap((arg, index): unknown[] => (argv[index - 1] === "--settings" ? [JSON.parse(arg)] : []));
}

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

/** A judge that fails the Claude Code session on efficiency and passes the rest, then proposes one edit. */
function scriptedJudge(prompt: string): JsonObject {
  if (prompt.includes("# learn/skill-doctor"))
    return {
      findings: ["The parser session edited before it reproduced.", "<b>bold</b>"],
      suggestions: [
        edit(),
        edit({ rule: "A second rule.", evidence: [{ session: "codex-x1", scorer: "efficiency", moment: "m" }] }),
      ],
      deferred: [{ finding: "Verbose summaries.", why: "One session only." }],
    };
  const efficiency = prompt.includes("# Session claude-c1") ? "highly_inefficient" : "highly_efficient";
  return labels(efficiency, "approve", "fully_compliant", "proportionate");
}

describe("ak learn doctor", () => {
  test("output must sit outside every tracked part of a work tree", () => {
    const repo = gitRepo(join(scratch("ak-doctor-out-"), "repo"));
    expect(outputRefusal(join(repo, "out"))).toContain("git does not ignore it");
    writeFileSync(join(repo, ".gitignore"), "out/\n");
    expect(outputRefusal(join(repo, "out", "report.html"))).toBeNull();
    expect(outputRefusal(join(scratch("ak-doctor-free-"), "out"))).toBeNull();
  });

  test("a session belongs by the root, a listed worktree or a registered one; a same-named folder does not", () => {
    const w = world();
    const ctx = testContext({ cwd: w.repo });
    const linked = join(w.base, "linked");
    const added = runProcess(["git", "-C", w.repo, "worktree", "add", "-q", "-b", "linked", linked], {
      timeoutMs: 30_000,
    });
    expect(added.code).toBe(0);
    const removed = join(w.base, "removed-worktree");
    mkdirSync(dirname(worktreesPath(ctx.config)), { recursive: true });
    writeFileSync(
      worktreesPath(ctx.config),
      JSON.stringify({ [removed]: w.repo, [join(w.base, "foreign")]: join(w.base, "other-repo") }),
    );
    const session = (id: string, cwd: string): void => {
      const file = join(w.claude, "projects", "-places", `${id}.jsonl`);
      jsonl(file, [
        { type: "user", sessionId: id, cwd, message: { role: "user", content: "Some work" } },
        {
          type: "assistant",
          sessionId: id,
          message: {
            content: [
              { type: "text", text: "On it." },
              { type: "tool_use", name: "Read", input: {} },
            ],
          },
        },
      ]);
      touch(file, w.now - HOUR);
    };
    session("in-linked", join(linked, "src"));
    session("in-removed", removed);
    session("same-name", join(w.base, "elsewhere", "repo", "src"));
    session("foreign", join(w.base, "foreign"));
    const parsed = collectOptions(parseLearnArgs(["--host", "claude", "--claude-home", w.claude]), ctx);
    if (!parsed.ok) throw new Error(parsed.error);
    const keys = collect(parsed.value, {}).sampled.map((sampled) => sampled.key);
    expect(keys.toSorted()).toEqual(["claude-c1", "claude-in-linked", "claude-in-removed"]);
  });

  test("collect options: hosts, whole numbers and the repository scope are checked", () => {
    const w = world();
    const ctx = testContext({ cwd: w.repo });
    const parse = (argv: readonly string[]) => collectOptions(parseLearnArgs(argv), ctx);
    const refusal = (argv: readonly string[]): string => {
      const parsed = parse(argv);
      return parsed.ok ? "accepted" : parsed.error;
    };
    expect(refusal(["--host", "claude,cursor"])).toBe("unknown host cursor; the doctor reads claude, codex, grok");
    expect(refusal(["--days", "0"])).toBe("--days takes a positive whole number, not 0");
    expect(refusal(["--all", "--repo", w.repo])).toBe("--all and --repo are exclusive");
    expect(parse([])).toMatchObject({ ok: true, value: { hosts: ["claude", "codex", "grok"], repos: [w.repo] } });
    expect(parse(["--all", "--host", "grok"])).toMatchObject({ ok: true, value: { hosts: ["grok"], repos: [] } });
    const outside = collectOptions(parseLearnArgs([]), testContext({ cwd: scratch("ak-doctor-norepo-") }));
    expect(outside).toEqual({ ok: false, error: "not in a repository: pass --repo P or --all" });
  });

  test("run: scores each session, gates the edits, writes owner-only files and never edits a skill", () => {
    const w = world();
    const ctx = testContext({ cwd: w.repo });
    const contexts: JudgeCallContext[] = [];
    ctx.judge = (prompt, context) => {
      contexts.push(context);
      return scriptedJudge(prompt);
    };
    const out = join(w.base, "out");
    const homes = ["--claude-home", w.claude, "--codex-home", w.codex, "--grok-home", w.grok];
    expect(verb("run", ["--out", join(w.repo, "out"), ...homes], ctx)).toBe(2);
    expect(ctx.err.join("\n")).toContain("refusing --out");

    expect(verb("run", ["--out", out, "--repo", w.repo, "--record", ...homes], ctx)).toBe(0);
    expect(contexts.map((context) => context.role)).toEqual([
      "session-scorer",
      "session-scorer",
      "session-scorer",
      "skill-doctor",
    ]);
    expect(mode(out)).toBe(0o700);
    const shared = join(w.base, "shared");
    mkdirSync(shared, { mode: 0o755 });
    chmodSync(shared, 0o755);
    expect(verb("run", ["--out", shared, "--repo", w.repo, ...homes], ctx)).toBe(0);
    expect(mode(shared)).toBe(0o755);
    expect(mode(join(shared, "transcripts"))).toBe(0o700);
    expect(mode(join(shared, "run.json"))).toBe(0o600);
    expect(mode(join(shared, "inventory.json"))).toBe(0o600);
    for (const id of readdirSync(join(shared, "proposed"))) expect(mode(join(shared, "proposed", id))).toBe(0o700);
    expect(readdirSync(join(out, "transcripts")).toSorted()).toEqual(["claude-c1.md", "codex-x1.md", "grok-g1.md"]);
    expect(mode(join(out, "transcripts", "claude-c1.md"))).toBe(0o600);
    const report = join(out, "report.html");
    expect(mode(report)).toBe(0o600);
    const html = readFileSync(report, "utf8");
    expect(html).toContain("&lt;b&gt;bold&lt;/b&gt;");
    expect(html).toContain("no evidence from a failed session");
    expect(html).not.toContain("Fix the flaky parser test");
    expect(readFileSync(w.skillPath, "utf8")).toBe(SKILL_TEXT);
    expect(readFileSync(join(out, "run.json"), "utf8")).not.toContain("Fix the flaky parser test");

    const [proposal] = loadImpact(skillsLedger(ctx, w.repo).dir);
    if (proposal === undefined) throw new Error("no proposal recorded");
    expect(readFileSync(join(out, "proposed", proposal.id, "SKILL.md"), "utf8")).toContain(
      "record the failing command",
    );
    expect(verb("reject", [proposal.id, "--repo", w.repo, "--reason", "too narrow"], ctx)).toBe(0);
    expect(verb("reject", [proposal.id, "--repo", w.repo], ctx)).toBe(1);
    expect(verb("impact", ["--repo", w.repo], ctx)).toBe(0);
    expect(ctx.out.join("\n")).toContain(`${proposal.id}  rejected  diagnose  Reproduce before you edit.`);

    const second = join(w.base, "second");
    const prompts: string[] = [];
    ctx.judge = (prompt) => {
      prompts.push(prompt);
      return scriptedJudge(prompt);
    };
    expect(verb("run", ["--out", second, "--repo", w.repo, ...homes], ctx)).toBe(0);
    expect(prompts.at(-1)).toContain("- rejected: diagnose — rule: Reproduce before you edit. — reason: too narrow");
    expect(readFileSync(join(second, "run.json"), "utf8")).toContain("a human rejected this rule before");
    expect(existsSync(join(second, "proposed"))).toBe(false);

    expect(verb("render", ["--out", second, "--report", join(w.base, "again.html")], ctx)).toBe(0);
    expect(readFileSync(join(w.base, "again.html"), "utf8")).toBe(readFileSync(join(second, "report.html"), "utf8"));
  });

  test("a claude-mem summary of a sampled session reaches the doctor's prompt", () => {
    const w = world();
    const ctx = testContext({ cwd: w.repo });
    const mem = new MemFixture(ctx.config.memDb);
    mem.session({ sid: "mem-1", project: "repo", started: 1, content: "c1" });
    mem.summary({ sid: "mem-1", project: "repo", request: "Fix the parser", completed: "Reproduced and fixed" });
    mem.db.close();
    const prompts: string[] = [];
    ctx.judge = (prompt) => {
      prompts.push(prompt);
      return scriptedJudge(prompt);
    };
    const homes = ["--claude-home", w.claude, "--codex-home", w.codex, "--grok-home", w.grok];
    expect(verb("run", ["--out", join(w.base, "out"), "--repo", w.repo, ...homes], ctx)).toBe(0);
    expect(prompts.at(-1)).toContain("- claude-mem summary: Fix the parser / Reproduced and fixed");
  });

  test("a claude-mem summary is scrubbed before it reaches the doctor's prompt", () => {
    const w = world();
    const ctx = testContext({ cwd: w.repo });
    const mem = new MemFixture(ctx.config.memDb);
    mem.session({ sid: "mem-1", project: "repo", started: 1, content: "c1" });
    mem.summary({ sid: "mem-1", project: "repo", request: "Use API_KEY=fixturevalue123", completed: "Done" });
    mem.db.close();
    const prompts: string[] = [];
    ctx.judge = (prompt) => {
      prompts.push(prompt);
      return scriptedJudge(prompt);
    };
    const homes = ["--claude-home", w.claude, "--codex-home", w.codex, "--grok-home", w.grok];
    expect(verb("run", ["--out", join(w.base, "out"), "--repo", w.repo, ...homes], ctx)).toBe(0);
    expect(prompts.at(-1)).toContain("claude-mem summary: Use API_KEY=[redacted:env-secret]");
    expect(prompts.at(-1)).not.toContain("fixturevalue123");
  });

  test("a judge outage reads as no grade and exits non-zero", () => {
    const w = world();
    const ctx = testContext({ cwd: w.repo });
    ctx.judge = () => null;
    const homes = ["--claude-home", w.claude, "--codex-home", w.codex, "--grok-home", w.grok];
    const out = join(w.base, "out");
    expect(verb("run", ["--out", out, "--repo", w.repo, ...homes], ctx)).toBe(1);
    expect(ctx.out.join("\n")).toContain("no grade; suggestions unavailable: no session was scored");
    expect(ctx.out.join("\n")).not.toContain("grade D");
    const html = readFileSync(join(out, "report.html"), "utf8");
    expect(html).toContain("No grade: no session was scored, and 3 could not be.");
    expect(html).not.toContain("/ 100");
  });

  test("the report offers a decision command only for a recorded proposal, naming its repository", () => {
    const w = world();
    const ctx = testContext({ cwd: w.repo });
    ctx.judge = scriptedJudge;
    const homes = ["--claude-home", w.claude, "--codex-home", w.codex, "--grok-home", w.grok];
    const plain = join(w.base, "plain");
    expect(verb("run", ["--out", plain, "--repo", w.repo, ...homes], ctx)).toBe(0);
    const unrecorded = readFileSync(join(plain, "report.html"), "utf8");
    expect(unrecorded).not.toContain("ak learn doctor accept");
    expect(unrecorded).toContain("--repo P --record");

    const kept = join(w.base, "kept");
    expect(verb("run", ["--out", kept, "--repo", w.repo, "--record", ...homes], ctx)).toBe(0);
    const [proposal] = loadImpact(skillsLedger(ctx, w.repo).dir);
    if (proposal === undefined) throw new Error("no proposal recorded");
    const recorded = readFileSync(join(kept, "report.html"), "utf8");
    expect(recorded).toContain(`ak learn doctor accept ${proposal.id} --repo `);
    expect(recorded).toContain(w.repo);
    expect(verb("accept", [proposal.id, "--repo", w.repo], { ...ctx, cwd: w.base })).toBe(0);
  });

  test("a repository under the home directory gets a --repo argument that passes the gate and reaches it", () => {
    const home = "/Users/alice";
    const shellValue = (argument: string): string =>
      runProcess(["sh", "-c", `printf %s ${argument}`], { timeoutMs: 10_000, env: { ...process.env, HOME: home } })
        .stdout;
    for (const repo of [`${home}/orca/agent-kit`, `${home}/home/bob/it's "$x"`, home]) {
      const argument = repoArgument(repo, home);
      expect(scrubSecrets(argument).text).toBe(argument);
      expect(shellValue(argument)).toBe(repo);
    }
    expect(repoArgument("/Users/alice2/repo", home)).toBe("/Users/alice2/repo");

    const w = world();
    const ctx = testContext({ cwd: w.repo, env: { HOME: w.base } });
    ctx.judge = scriptedJudge;
    const homes = ["--claude-home", w.claude, "--codex-home", w.codex, "--grok-home", w.grok];
    const out = join(w.base, "out");
    expect(verb("run", ["--out", out, "--repo", w.repo, "--record", ...homes], ctx)).toBe(0);
    expect(readFileSync(join(out, "report.html"), "utf8")).toContain("--repo &quot;$HOME/repo&quot;");
    const again = join(w.base, "again.html");
    expect(verb("render", ["--out", out, "--report", again], ctx)).toBe(0);
    expect(readFileSync(again, "utf8")).toBe(readFileSync(join(out, "report.html"), "utf8"));
  });

  test("two edits to one skill each keep their own proposed file", () => {
    const w = world();
    const ctx = testContext({ cwd: w.repo });
    ctx.judge = (prompt) =>
      prompt.includes("# learn/skill-doctor")
        ? {
            findings: [],
            suggestions: [
              edit(),
              edit({ rule: "Bisect last.", replace: [{ old: "Then bisect.", new: "Bisect last." }] }),
            ],
          }
        : scriptedJudge(prompt);
    const homes = ["--claude-home", w.claude, "--codex-home", w.codex, "--grok-home", w.grok];
    const out = join(w.base, "out");
    expect(verb("run", ["--out", out, "--repo", w.repo, ...homes], ctx)).toBe(0);
    const proposed = join(out, "proposed");
    const proposedTexts = readdirSync(proposed).map((id) => readFileSync(join(proposed, id, "SKILL.md"), "utf8"));
    expect(proposedTexts).toHaveLength(2);
    expect(proposedTexts.filter((text) => text.includes("record the failing command"))).toHaveLength(1);
    expect(proposedTexts.filter((text) => text.includes("Bisect last."))).toHaveLength(1);
  });

  test("a held ledger lock fails --record and leaves the report without a decision command", () => {
    const w = world();
    const ctx = testContext({ cwd: w.repo });
    ctx.judge = scriptedJudge;
    const homes = ["--claude-home", w.claude, "--codex-home", w.codex, "--grok-home", w.grok];
    const release = skillsLedger(ctx, w.repo).tryLock();
    if (release === null) throw new Error("no lock");
    const out = join(w.base, "out");
    expect(verb("run", ["--out", out, "--repo", w.repo, "--record", ...homes], ctx)).toBe(1);
    release();
    expect(ctx.err.join("\n")).toContain("was not recorded");
    expect(readFileSync(join(out, "report.html"), "utf8")).not.toContain("ak learn doctor accept");
  });

  test("a dry run calls no judge and writes nothing", () => {
    const w = world();
    const live = testContext({ cwd: w.repo });
    live.judge = scriptedJudge;
    const homes = ["--claude-home", w.claude, "--codex-home", w.codex, "--grok-home", w.grok];
    expect(verb("run", ["--out", join(w.base, "live"), "--repo", w.repo, "--record", ...homes], live)).toBe(0);
    const ledger = skillsLedger(live, w.repo);
    const [proposal] = loadImpact(ledger.dir);
    if (proposal === undefined) throw new Error("no proposal recorded");
    const head = ledger.head();

    let calls = 0;
    const dry: TestContext = {
      ...live,
      config: { ...live.config, dryRun: true },
      judge: () => {
        calls += 1;
        return null;
      },
    };
    const out = join(w.base, "dry");
    expect(verb("run", ["--out", out, "--repo", w.repo, "--record", ...homes], dry)).toBe(0);
    expect(verb("collect", ["--out", out, "--repo", w.repo, ...homes], dry)).toBe(0);
    expect(verb("accept", [proposal.id, "--repo", w.repo], dry)).toBe(0);
    expect(verb("render", ["--out", join(w.base, "live"), "--report", join(w.base, "dry.html")], dry)).toBe(0);
    expect(calls).toBe(0);
    expect(existsSync(out)).toBe(false);
    expect(existsSync(join(w.base, "dry.html"))).toBe(false);
    expect(ledger.head()).toBe(head);
    expect(loadImpact(ledger.dir)).toMatchObject([{ id: proposal.id, status: "proposed" }]);
  });

  test("the doctor area's default judge runs subscription-only", async () => {
    const w = world();
    const base = testContext();
    const script = join(w.base, "judge.sh");
    writeFileSync(
      script,
      `if [ -n "$ANTHROPIC_API_KEY" ]; then echo '{"unavailable":"metered"}'; else cat <<'EOF'\n${JSON.stringify(
        labels("highly_efficient", "approve", "fully_compliant", "proportionate"),
      )}\nEOF\nfi\n`,
    );
    const out: string[] = [];
    const previous = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "fixture-value";
    try {
      const code = await runLearn(
        [
          "doctor",
          "run",
          "--out",
          join(w.base, "out"),
          "--repo",
          w.repo,
          "--claude-home",
          w.claude,
          "--codex-home",
          w.codex,
          "--grok-home",
          w.grok,
        ],
        {
          cwd: w.repo,
          io: { out: (line) => out.push(line), err: (line) => out.push(line) },
          env: { ...base.env, AK_LEARN_JUDGE: `sh ${script}` },
        },
      );
      expect(code).toBe(0);
    } finally {
      if (previous === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = previous;
    }
    expect(out.join("\n")).toContain("scored: 3, unavailable: 0");
  });
});
