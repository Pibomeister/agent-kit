import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

import {
  classifyLessons,
  lessonsFindings,
  readLessons,
  RUNNABLE_LESSON_CHECKS,
  triageFailures,
  type FailureRecord,
} from "../../src/learn/lessons.ts";
import { ensureMemoryLedger, loadLessons, memoryDir } from "../../src/learn/memory/ledger.ts";
import { sessionRoot } from "../../src/learn/memory/session-context.ts";
import { loadConfig } from "../../src/learn/core/config.ts";
import { loopDir } from "../../src/learn/core/paths.ts";
import { Ledger } from "../../src/learn/core/ledger.ts";
import { memoryArea } from "../../src/learn/memory/cli.ts";
import { applyPairs } from "../../src/learn/memory/deep.ts";
import { applyConsolidation } from "../../src/learn/memory/consolidate.ts";
import { parseLearnArgs } from "../../src/learn/core/context.ts";
import { gitRepo, scratch, testContext, type TestContext } from "./helpers.ts";
import type { LearnArgs } from "../../src/learn/core/context.ts";
import Ajv from "ajv";

function lessonPage(dir: string, id: string, meta: Record<string, string>): void {
  mkdirSync(join(dir, "lessons"), { recursive: true });
  const lines = Object.entries(meta).map(([k, v]) => `${k}: ${v}`);
  writeFileSync(join(dir, "lessons", `${id}.md`), `---\n${lines.join("\n")}\n---\nbody\n`);
}

function git(cwd: string, ...args: string[]) {
  return spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, encoding: "utf8" });
}

const validDoctorJson = new Ajv().compile<{
  findings: { level: string; check: string; detail: string }[];
}>({
  type: "object",
  required: ["findings"],
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        required: ["level", "check", "detail"],
        properties: { level: { type: "string" }, check: { type: "string" }, detail: { type: "string" } },
      },
    },
  },
});

function fixtureLedger(): string {
  const dir = scratch("ak-lessons-");
  lessonPage(dir, "ls-001", {
    statement: "Run the dry run before dispatch",
    status: "confirmed",
    failure: "worker dispatched without a preflight dry run",
    check: "tracker-token",
    issue: "https://github.com/Pibomeister/agent-kit/issues/196",
  });
  lessonPage(dir, "ls-002", {
    statement: "Park challenges need a named challenger",
    status: "confirmed",
    failure: "a parked task had no challenger",
  });
  lessonPage(dir, "ls-003", {
    statement: "Made-up checks do not enforce anything",
    status: "hypothesis",
    check: "no-such-check",
  });
  lessonPage(dir, "ls-004", {
    statement: "Retired lesson",
    status: "superseded",
    check: "tracker-token",
  });
  return dir;
}

describe("lesson enforcement coverage", () => {
  test("reads the canonical lesson pages with failure, check and issue fields", () => {
    const lessons = readLessons(fixtureLedger());
    expect(lessons.map((l) => l.id)).toEqual(["ls-001", "ls-002", "ls-003", "ls-004"]);
    expect(lessons[0]).toMatchObject({
      failure: "worker dispatched without a preflight dry run",
      check: "tracker-token",
      issue: "https://github.com/Pibomeister/agent-kit/issues/196",
    });
    expect(RUNNABLE_LESSON_CHECKS.map((c) => c.id)).toContain("tracker-token");
  });

  test("classifies enforced, prose-only and unknown-check lessons; superseded is history", () => {
    const coverage = classifyLessons(readLessons(fixtureLedger()));
    const byId = new Map(coverage.map((row) => [row.lesson.id, row]));
    expect(byId.get("ls-001")?.enforced).toBe(true);
    expect(byId.get("ls-002")?.enforced).toBe(false);
    expect(byId.get("ls-002")?.reason).toContain("prose-only");
    expect(byId.get("ls-003")?.enforced).toBe(false);
    expect(byId.get("ls-003")?.reason).toContain("no-such-check");
    expect(byId.has("ls-004")).toBe(false);
  });

  test("findings name each lesson, and a failing enforced check fails the lesson finding", () => {
    const coverage = classifyLessons(readLessons(fixtureLedger()));
    const passing = lessonsFindings(coverage, [{ check: "tracker token", level: "PASS" }]);
    expect(passing.find((f) => f.detail.includes("ls-001"))?.level).toBe("PASS");
    expect(passing.find((f) => f.detail.includes("ls-002"))?.level).toBe("WARN");
    const failing = lessonsFindings(coverage, [{ check: "tracker token", level: "FAIL" }]);
    expect(failing.find((f) => f.detail.includes("ls-001"))?.level).toBe("FAIL");
    const summary = passing.at(-1);
    expect(summary?.check).toBe("lessons coverage");
    expect(summary?.detail).toContain("1 enforced");
    expect(summary?.detail).toContain("2 prose-only");
    const failingSummary = failing.at(-1);
    expect(failingSummary?.level).toBe("FAIL");
    expect(failingSummary?.remedy).not.toBe("No action needed.");
    expect(failingSummary?.remedy).toContain("failing doctor check");
  });

  test("an enforced lesson fails when any host's guarded check fails, not just the first label match", () => {
    const dir = scratch("ak-lessons-plugin-");
    lessonPage(dir, "ls-001", { statement: "Keep ak enabled", status: "confirmed", check: "plugin-enabled" });
    const findings = lessonsFindings(classifyLessons(readLessons(dir)), [
      { check: "Claude Code plugin", level: "PASS" },
      { check: "Codex plugin", level: "FAIL" },
    ]);
    expect(findings.find((f) => f.detail.includes("ls-001"))?.level).toBe("FAIL");
  });

  test("an absent or empty lessons source is one honest warning, not silence", () => {
    const findings = lessonsFindings(classifyLessons(readLessons(scratch("ak-lessons-none-"))), []);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.level).toBe("WARN");
    expect(findings[0]?.detail).toContain("no lessons");
  });
});

describe("ak doctor lessons coverage", () => {
  test("doctor in a linked worktree reads the main repository's ledger, the one triage writes", () => {
    const main = scratch("ak-doctor-main-");
    git(main, "init", "-q");
    git(main, "commit", "-q", "--allow-empty", "-m", "seed");
    const worktree = join(scratch("ak-doctor-wt-"), "wt");
    git(main, "worktree", "add", "-q", worktree);
    const home = scratch("ak-doctor-home-");
    const env = {
      ...process.env,
      PATH: "/usr/bin:/bin",
      CLAUDE_CONFIG_DIR: join(home, "claude-home"),
      CODEX_HOME: join(home, "codex-home"),
      AK_PUBLISHED_ROOT: join(home, "missing-published"),
    };
    const root = sessionRoot(worktree);
    if (root === null) throw new Error("worktree has no session root");
    lessonPage(loopDir(loadConfig(env), root, "memory"), "ls-001", {
      statement: "Run the dry run before dispatch",
      status: "confirmed",
      check: "tracker-token",
    });
    const run = spawnSync(
      process.execPath,
      [join(import.meta.dir, "../../src/maintenance/cli.ts"), "doctor", "--json"],
      { cwd: worktree, env, encoding: "utf8" },
    );
    const parsed: unknown = JSON.parse(run.stdout);
    if (!validDoctorJson(parsed)) throw new Error("doctor --json did not match its schema");
    const coverage = parsed.findings.filter((f) => f.check === "lessons coverage");
    expect(coverage.some((f) => f.detail.includes("ls-001"))).toBe(true);
  });

  test("doctor --json reports enforced and prose-only lessons from --lessons", () => {
    const root = scratch("ak-doctor-lessons-");
    spawnSync("git", ["init", "-q", root]);
    const lessons = fixtureLedger();
    const run = spawnSync(
      process.execPath,
      [join(import.meta.dir, "../../src/maintenance/cli.ts"), "doctor", "--json", "--lessons", lessons],
      {
        cwd: root,
        env: {
          ...process.env,
          PATH: "/usr/bin:/bin",
          CLAUDE_CONFIG_DIR: join(root, "claude-home"),
          CODEX_HOME: join(root, "codex-home"),
          AK_PUBLISHED_ROOT: join(root, "missing-published"),
        },
        encoding: "utf8",
      },
    );
    const parsed: unknown = JSON.parse(run.stdout);
    if (!validDoctorJson(parsed)) throw new Error("doctor --json did not match its schema");
    const coverage = parsed.findings.filter((f) => f.check === "lessons coverage");
    expect(coverage.some((f) => f.level === "PASS" && f.detail.includes("ls-001"))).toBe(true);
    expect(coverage.some((f) => f.level === "WARN" && f.detail.includes("ls-002"))).toBe(true);
    expect(coverage.at(-1)?.detail).toContain("1 enforced");
  });
});

function runTriage(args: LearnArgs, ctx: TestContext): number {
  const verb = memoryArea.verbs.triage;
  if (verb === undefined) throw new Error("memory triage verb is missing");
  return verb.run(args, ctx);
}

describe("after-run failure triage", () => {
  const failures: FailureRecord[] = [
    {
      failure: "Worker dispatched without a preflight dry run",
      lesson: "Run the dry run before dispatch",
      check: "tracker-token",
      issue: "https://github.com/Pibomeister/agent-kit/issues/196",
    },
    { failure: "Watchdog retried with no backoff", lesson: "Back off between watchdog retries" },
    { failure: "watchdog   retried with no backoff", lesson: "Back off between watchdog retries" },
  ];

  test("dedupes against existing lessons and within the batch, and queues issue records", () => {
    const existing = readLessons(fixtureLedger());
    const result = triageFailures(existing, failures);
    expect(result.duplicates.map((d) => d.lessonId)).toEqual(["ls-001", "ls-005"]);
    expect(result.created).toHaveLength(1);
    expect(result.created[0]).toMatchObject({ id: "ls-005", status: "hypothesis", check: "" });
    expect(result.issueCandidates.map((c) => c.failure)).toEqual(["Watchdog retried with no backoff"]);
  });

  test("a restated lesson with reworded failure is a duplicate, and a linked or queued lesson is not queued again", () => {
    const existing = readLessons(fixtureLedger());
    const restated = [
      { failure: "dispatch went out with no preflight", lesson: "Run the dry run before dispatch." },
      { failure: "nobody challenged the park", lesson: "Park challenges need a named challenger" },
    ];
    const first = triageFailures(existing, restated);
    expect(first.created).toHaveLength(0);
    expect(first.duplicates.map((d) => d.lessonId)).toEqual(["ls-001", "ls-002"]);
    expect(first.issueCandidates.map((c) => c.lessonId)).toEqual(["ls-002"]);
    expect(triageFailures(existing, restated, new Set(["ls-002"])).issueCandidates).toHaveLength(0);
  });

  test("memory triage writes only the new lesson, records issue candidates, and is idempotent", () => {
    const repo = gitRepo(scratch("ak-triage-repo-"));
    const ctx = testContext({ cwd: repo });
    const file = join(scratch("ak-triage-"), "failures.json");
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, JSON.stringify(failures));
    const run = () => runTriage(parseLearnArgs(["--file", file, "--repo", repo]), ctx);
    expect(run()).toBe(0);
    expect(ctx.out.join("\n")).toContain("created ls-001");
    expect(ctx.out.join("\n")).toContain("1 issue candidate");
    const outBefore = ctx.out.length;
    expect(run()).toBe(0);
    expect(ctx.out.slice(outBefore).join("\n")).toContain("0 created");
    expect(ctx.out.slice(outBefore).join("\n")).toContain("0 issue candidate");
    // The ledger the verb wrote is the canonical one session start reads.
    const written = loadLessons(new Ledger(memoryDir(ctx.config, repo)));
    expect([...written.keys()]).toEqual(["ls-001", "ls-002"]);
    expect(written.get("ls-002")?.meta.check ?? "").toBe("");
    const issueLog = readFileSync(join(memoryDir(ctx.config, repo), "raw", "triage-issues.jsonl"), "utf8");
    expect(issueLog).toContain("Watchdog retried with no backoff");
  });

  test("a duplicate naming a check keeps its check and issue, and supersedes the prose-only lesson for every reader", () => {
    const repo = gitRepo(scratch("ak-triage-repo-"));
    const ctx = testContext({ cwd: repo });
    const ledger = ensureMemoryLedger(memoryDir(ctx.config, repo));
    lessonPage(ledger.dir, "ls-001", {
      statement: "Run the dry run before dispatch",
      status: "confirmed",
      check: "tracker-token",
    });
    lessonPage(ledger.dir, "ls-002", {
      statement: "Park challenges need a named challenger",
      status: "confirmed",
      confidence: "0.90",
      evidence: "[obs:1, obs:7]",
      sessions: "2",
      count: "4",
      tags: "[dispatch]",
      first_seen: "2026-09-01",
    });
    expect(classifyLessons(readLessons(ledger.dir)).find((row) => row.lesson.id === "ls-002")?.enforced).toBe(false);
    const file = join(scratch("ak-triage-"), "failures.json");
    writeFileSync(
      file,
      JSON.stringify([
        {
          failure: "a parked task had no challenger",
          lesson: "Park challenges need a named challenger",
          check: "tracker-token",
          issue: "#210",
        },
      ]),
    );
    const run = () => runTriage(parseLearnArgs(["--file", file, "--repo", repo]), ctx);
    expect(run()).toBe(0);
    expect(ctx.out.join("\n")).toContain(
      "duplicate of ls-002: Park challenges need a named challenger; check tracker-token; issue #210",
    );
    const runs = readFileSync(ledger.path("runs.jsonl"), "utf8").trim().split("\n");
    const last: unknown = JSON.parse(runs.at(-1) ?? "{}");
    expect(last).toMatchObject({
      job: "triage",
      duplicates: [{ lessonId: "ls-002", check: "tracker-token", issue: "#210" }],
    });
    const pages = loadLessons(ledger);
    expect(pages.get("ls-002")?.meta).toMatchObject({ status: "superseded", superseded_by: "ls-003" });
    expect(pages.get("ls-003")?.meta).toMatchObject({
      statement: "Park challenges need a named challenger",
      status: "confirmed",
      check: "tracker-token",
      issue: "#210",
      supersedes: ["ls-002"],
      confidence: "0.90",
      evidence: ["obs:1", "obs:7"],
      sessions: 2,
      count: 4,
      tags: ["dispatch"],
      first_seen: "2026-09-01",
    });
    const coverageNow = () =>
      lessonsFindings(classifyLessons(readLessons(ledger.dir)), [{ check: "tracker token", level: "PASS" }]);
    const enforcedAfterTriage = coverageNow();
    expect(enforcedAfterTriage.some((f) => f.detail.includes("ls-002"))).toBe(false);
    expect(enforcedAfterTriage.find((f) => f.detail.includes("ls-003"))).toMatchObject({ level: "PASS" });
    expect(enforcedAfterTriage.find((f) => f.detail.includes("ls-003"))?.detail).toContain("issue #210");

    expect(applyPairs(ledger, { merge: [["ls-002", "ls-003"]] }, "2026-11-07").merged).toEqual([]);
    const repeat = applyConsolidation(
      ledger,
      { lessons: [{ statement: "Park challenges need a named challenger", scope: "repo", evidence: ["obs:1"] }] },
      new Set(["obs:1"]),
      new Map(),
      { today: "2026-11-07" },
    );
    expect(repeat.repeated).toEqual(["ls-003"]);
    const afterTicks = coverageNow();
    expect(afterTicks.some((f) => f.detail.includes("ls-002"))).toBe(false);
    expect(afterTicks.find((f) => f.detail.includes("ls-003"))).toMatchObject({ level: "PASS" });
    expect(afterTicks.at(-1)?.detail).toContain("2 enforced, 0 prose-only");

    const before = ctx.out.length;
    expect(run()).toBe(0);
    expect(ctx.out.slice(before).join("\n")).toContain("0 created, 1 duplicate(s)");
    expect([...loadLessons(ledger).keys()]).toEqual(["ls-001", "ls-002", "ls-003"]);
  });

  test("memory triage refuses a missing or malformed failures file", () => {
    const repo = gitRepo(scratch("ak-triage-repo-"));
    const ctx = testContext({ cwd: repo });
    const bad = join(scratch("ak-triage-"), "bad.json");
    writeFileSync(bad, "{not json");
    expect(runTriage(parseLearnArgs(["--file", bad, "--repo", repo]), ctx)).toBe(1);
    expect(ctx.err.join("\n")).toContain("triage");
  });
});
