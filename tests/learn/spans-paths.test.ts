/**
 * One span per instrumented unit on each of its exits: ok, nothing to do,
 * judge failed, lock held, dry run, thrown error. Plus the two capped logs and
 * the rollback reader that has to accept both nightly run-id formats.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runLearn } from "../../src/learn/cli.ts";
import { parseLearnArgs } from "../../src/learn/core/context.ts";
import { acquireLock } from "../../src/learn/core/ledger.ts";
import { projectFolderName, tickLogPath } from "../../src/learn/core/paths.ts";
import { readJsonl } from "../../src/learn/core/store.ts";
import { parseTraceparent, SPAN_FILE, span, type SpanRow } from "../../src/learn/core/trace.ts";
import { rollbackWiki } from "../../src/learn/memory/cli.ts";
import { UNDONE_RUNS_FILE } from "../../src/learn/memory/episodes.ts";
import { ensureMemoryLedger, memoryDir, SECTIONS } from "../../src/learn/memory/ledger.ts";
import { tick } from "../../src/learn/memory/tick.ts";
import { appendEvents } from "../../src/learn/review/events.ts";
import { PIPELINE_LOG, type Spawner, stopHook } from "../../src/learn/review/hooks.ts";
import { correctionEvent } from "../../src/learn/review/ingest.ts";
import { reviewLedger, reviewLedgerDir } from "../../src/learn/review/ledger.ts";
import { maintain } from "../../src/learn/review/maintain.ts";
import { skillsLedger } from "../../src/learn/skills/learn.ts";
import { gitRepo, inOutsideRepo, MemFixture, scratch, type TestContext, testContext } from "./helpers.ts";

function explodingJudge(): never {
  throw new Error("judge exploded");
}

function spans(ctx: TestContext): SpanRow[] {
  const path = join(ctx.config.runtimeDir, SPAN_FILE);
  return existsSync(path) ? readJsonl<SpanRow>(path) : [];
}

function named(ctx: TestContext, name: SpanRow["name"]): SpanRow[] {
  return spans(ctx).filter((row) => row.name === name);
}

function learn(ctx: TestContext, argv: string[], stdin?: string): number {
  return runLearn(argv, {
    cwd: ctx.cwd,
    io: { out: (line) => ctx.out.push(line), err: (line) => ctx.err.push(line) },
    env: ctx.env,
    judge: ctx.judge,
    stdin,
  });
}

function reviewRepo(replies: Parameters<typeof testContext>[0] = {}) {
  const root = gitRepo(join(scratch(), "shop"));
  const ctx = testContext({ cwd: root, ...replies });
  return { root, ctx };
}

function correction() {
  return correctionEvent("no, use the fixture clock", "2026-10-05T10:00:00Z", "shop", "claude", {
    patterns: "explicit",
    confidence: 0.9,
  });
}

describe("review spans", () => {
  test("a run with nothing to do: run ok, stages nothing", () => {
    const { ctx } = reviewRepo();
    expect(learn(ctx, ["review", "run", "--no-github", "--no-mem"])).toBe(0);
    expect(named(ctx, "review.run")[0]).toMatchObject({ status: "ok", trigger: "cli" });
    expect(named(ctx, "review.ingest")[0]).toMatchObject({ status: "nothing" });
    expect(named(ctx, "review.maintain")[0]).toMatchObject({ status: "nothing" });
    expect(named(ctx, "review.propose")[0]).toMatchObject({ status: "nothing" });
  });

  test("an unusable judge reply fails the maintain stage with no-judge-output", () => {
    const { root, ctx } = reviewRepo({ replies: [null] });
    appendEvents(reviewLedger(ctx.config, root), [correction()]);
    expect(learn(ctx, ["review", "maintain"])).toBe(0);
    expect(named(ctx, "review.maintain")[0]).toMatchObject({
      status: "failed",
      reason: "no-judge-output",
      attrs: { batches: 1, unusable: 1, rejected_parts: 0 },
    });
    expect(named(ctx, "review.maintain")[0]?.commit).toMatch(/^[0-9a-f]{40}$/);
  });

  test("a held lock records locked/lock-held and still exits 0", () => {
    const { root, ctx } = reviewRepo();
    const ledger = reviewLedger(ctx.config, root);
    const release = ledger.tryLock();
    try {
      expect(learn(ctx, ["review", "run", "--no-github", "--no-mem"])).toBe(0);
    } finally {
      release?.();
    }
    expect(named(ctx, "review.run")[0]).toMatchObject({ status: "locked", reason: "lock-held" });
    expect(named(ctx, "review.ingest")).toHaveLength(0);
  });

  test("a dry run records dry-run", () => {
    const { root, ctx } = reviewRepo();
    appendEvents(reviewLedger(ctx.config, root), [correction()]);
    const dry = { ...ctx, env: { ...ctx.env, AK_LEARN_DRY_RUN: "1" } };
    expect(learn(dry, ["review", "maintain"])).toBe(0);
    expect(named(ctx, "review.maintain")[0]).toMatchObject({ status: "dry-run" });
  });

  test("a thrown error records failed/error and keeps the verb's exit code", () => {
    const { ctx } = reviewRepo();
    expect(learn(ctx, ["review", "run", "--no-github", "--no-mem", "--since", "not-a-date"])).toBe(1);
    expect(named(ctx, "review.run")[0]).toMatchObject({ status: "failed", reason: "error" });
  });

  test("outside a repository the run fails with not-a-repo", () => {
    inOutsideRepo((cwd) => {
      const ctx = testContext({ cwd });
      expect(learn(ctx, ["review", "run"])).toBe(1);
      expect(named(ctx, "review.run")[0]).toMatchObject({ status: "failed", reason: "not-a-repo", project_key: null });
    });
  });

  test("maintain called directly inside a span still commits its ledger", () => {
    const { root, ctx } = reviewRepo({ replies: [null] });
    const ledger = reviewLedger(ctx.config, root);
    appendEvents(ledger, [correction()]);
    const head = ledger.head();
    span(ctx, "review.maintain", "cli", (inner) => maintain(inner, ledger, "shop"));
    expect(ledger.head()).not.toBe(head);
    expect(named(ctx, "review.maintain")[0]?.commit).toBe(ledger.head());
  });
});

describe("memory spans", () => {
  test("a held tick lock records locked", () => {
    const ctx = testContext();
    mkdirSync(ctx.config.runtimeDir, { recursive: true });
    const release = acquireLock(join(ctx.config.runtimeDir, ".tick.lock"));
    try {
      expect(tick(ctx)).toBe(0);
    } finally {
      release?.();
    }
    expect(named(ctx, "memory.tick")[0]).toMatchObject({ status: "locked", reason: "lock-held", trigger: "tick" });
  });

  test("a missing claude-mem database records failed/no-source", () => {
    const ctx = testContext();
    expect(tick(ctx)).toBe(0);
    expect(named(ctx, "memory.tick")[0]).toMatchObject({ status: "failed", reason: "no-source" });
  });

  test("memory run writes memory.tick (force) and a job span per job, failed reflect included", () => {
    const dir = scratch();
    const root = gitRepo(join(dir, "shop"));
    const dbPath = join(dir, "mem.db");
    const mem = new MemFixture(dbPath);
    const now = Date.now();
    mem.session({ sid: "dddd4444-0000", project: "shop", started: now - 3_600_000, completed: now - 3_000_000 });
    mem.observation({
      sid: "dddd4444-0000",
      project: "shop",
      type: "discovery",
      title: "found it",
      at: now - 3_500_000,
    });
    mem.close();
    const ctx = testContext({ cwd: root, env: { AK_LEARN_MEM_DB: dbPath }, replies: [null] });
    expect(learn(ctx, ["memory", "run", "--job", "reflect"])).toBe(0);
    const tickRow = named(ctx, "memory.tick")[0];
    expect(tickRow).toMatchObject({ trigger: "force", status: "ok", attrs: { projects: 1 }, project_key: null });
    expect(named(ctx, "memory.episodes")[0]).toMatchObject({ status: "ok", attrs: { episodes: 1 } });
    const reflect = named(ctx, "memory.reflect")[0];
    expect(reflect).toMatchObject({ status: "failed", reason: "no-judge-output", trigger: "force" });
    expect(reflect?.parent_span_id).toBe(tickRow?.span_id ?? "");
    expect(reflect?.project_key).toMatch(/^[0-9a-f]{12}$/);
  });

  test("a reflection the gates reject records rejected/gate-rejected", () => {
    const dir = scratch();
    const root = gitRepo(join(dir, "shop"));
    const dbPath = join(dir, "mem.db");
    const mem = new MemFixture(dbPath);
    const now = Date.now();
    mem.session({ sid: "dddd4444-0000", project: "shop", started: now - 3_600_000, completed: now - 3_000_000 });
    mem.observation({
      sid: "dddd4444-0000",
      project: "shop",
      type: "discovery",
      title: "found it",
      at: now - 3_500_000,
    });
    mem.close();
    const invented = `${SECTIONS.join("\n- invented and cites nothing shown [obs:99999]\n")}\n`;
    const ctx = testContext({ cwd: root, env: { AK_LEARN_MEM_DB: dbPath }, replies: [{ memory: invented }] });
    expect(learn(ctx, ["memory", "run", "--job", "reflect"])).toBe(0);
    expect(named(ctx, "memory.reflect")[0]).toMatchObject({ status: "rejected", reason: "gate-rejected" });
  });

  test("a job that throws records failed/error and the tick carries on", () => {
    const dir = scratch();
    const root = gitRepo(join(dir, "shop"));
    const dbPath = join(dir, "mem.db");
    const mem = new MemFixture(dbPath);
    const now = Date.now();
    mem.session({ sid: "dddd4444-0000", project: "shop", started: now - 3_600_000, completed: now - 3_000_000 });
    mem.observation({
      sid: "dddd4444-0000",
      project: "shop",
      type: "discovery",
      title: "found it",
      at: now - 3_500_000,
    });
    mem.close();
    const ctx = testContext({ cwd: root, env: { AK_LEARN_MEM_DB: dbPath }, replies: [explodingJudge] });
    expect(learn(ctx, ["memory", "run", "--job", "reflect"])).toBe(0);
    expect(ctx.out.join("\n")).toContain("reflect failed: judge exploded");
    expect(named(ctx, "memory.reflect")[0]).toMatchObject({ status: "failed", reason: "error" });
    expect(named(ctx, "memory.tick")[0]).toMatchObject({ status: "ok" });
  });

  test("tick.log rotates under the runtime cap", () => {
    const ctx = testContext();
    const small = { ...ctx, config: { ...ctx.config, traceMaxBytes: 200 } };
    for (let i = 0; i < 6; i += 1) tick(small);
    const log = tickLogPath(ctx.config);
    expect(existsSync(log.replace(/tick\.log$/, "tick.1.log"))).toBe(true);
    expect(statSync(log).size).toBeLessThanOrEqual(200);
  });
});

describe("memory rollback", () => {
  test("marks nightly runs undone for both the legacy dated id and the span id", () => {
    const ledger = ensureMemoryLedger(memoryDir(testContext().config, scratch()));
    writeFileSync(ledger.path("memory.md"), "# Working memory\n");
    ledger.commit("seed");
    const base = ledger.head() ?? "";
    for (const run of ["nightly-2026-10-01-4242", "0123456789abcdef"]) {
      writeFileSync(ledger.path("lessons.md"), `# Lessons\n${run}\n`);
      ledger.commit(`nightly ${run}: +1 lessons`);
    }
    expect(rollbackWiki(ledger, base)).toStartWith("rolled back");
    const undone = readJsonl<{ run: string }>(ledger.path(UNDONE_RUNS_FILE)).map((row) => row.run);
    expect(undone.toSorted()).toEqual(["0123456789abcdef", "nightly-2026-10-01-4242"]);
  });
});

describe("skills spans", () => {
  test("discover with too few sessions records nothing; run and uses record ok", () => {
    const root = gitRepo(join(scratch(), "repo"));
    const ctx = testContext({ cwd: root });
    expect(learn(ctx, ["skills", "run", "--repo", root])).toBe(0);
    expect(named(ctx, "skills.discover")[0]).toMatchObject({ status: "nothing", attrs: { sessions: 0 } });
    expect(named(ctx, "skills.run")[0]).toMatchObject({ status: "ok", trigger: "cli" });
    expect(named(ctx, "skills.uses")[0]).toMatchObject({ status: "ok", attrs: { changed: 0, pending: 0 } });
  });

  test("a held skills lock records locked on both steps", () => {
    const root = gitRepo(join(scratch(), "repo"));
    const ctx = testContext({ cwd: root });
    const release = skillsLedger(ctx, root).tryLock();
    try {
      expect(learn(ctx, ["skills", "run", "--repo", root])).toBe(0);
    } finally {
      release?.();
    }
    expect(named(ctx, "skills.discover")[0]).toMatchObject({ status: "locked", reason: "lock-held" });
    expect(named(ctx, "skills.uses")[0]).toMatchObject({ status: "locked", reason: "lock-held" });
  });

  test("an unusable discovery reply records failed/no-judge-output", () => {
    const root = gitRepo(join(scratch(), "repo"));
    const ctx = testContext({ cwd: root, replies: [null] });
    const transcripts = join(ctx.config.configDir, "projects", projectFolderName(root));
    mkdirSync(transcripts, { recursive: true });
    for (const [sid, lines] of [
      ["aaaa1111-0000", ["please ask the bot to re-review this PR", "and then fix the lint failures"]],
      ["bbbb2222-0000", ["pushed the fix, re-trigger the review bot", "check the CI result too please"]],
      ["cccc3333-0000", ["the bot review is stale, rerun it now", "the head moved after my rebase"]],
    ] as const)
      writeFileSync(
        join(transcripts, `${sid}.jsonl`),
        lines.map((content) => `${JSON.stringify({ type: "user", message: { role: "user", content } })}\n`).join(""),
      );
    expect(learn(ctx, ["skills", "run", "--repo", root])).toBe(0);
    expect(named(ctx, "skills.discover")[0]).toMatchObject({
      status: "failed",
      reason: "no-judge-output",
      attrs: { sessions: 3 },
    });
  });

  test("a dry run records dry-run on the run", () => {
    const root = gitRepo(join(scratch(), "repo"));
    const ctx = testContext({ cwd: root, env: { AK_LEARN_DRY_RUN: "1" } });
    expect(learn(ctx, ["skills", "run", "--repo", root])).toBe(0);
    expect(named(ctx, "skills.run")[0]).toMatchObject({ status: "dry-run" });
  });

  test("the pipeline the Stop hook detaches records hook as its trigger", () => {
    const root = gitRepo(join(scratch(), "repo"));
    const ctx = testContext({ cwd: root, env: { AK_LEARN_TRIGGER: "hook" } });
    expect(learn(ctx, ["skills", "run", "--repo", root])).toBe(0);
    expect(named(ctx, "skills.run")[0]).toMatchObject({ trigger: "hook" });
  });
});

function recorder() {
  const calls: Array<{ argv: readonly string[]; env: NodeJS.ProcessEnv | undefined }> = [];
  const spawner: Spawner = (argv, options) => calls.push({ argv, env: options.env });
  return { calls, spawner };
}

describe("hook spans", () => {
  test("stop: spawned, then debounced; the pipeline gets the hook span as carrier and no ambient trace state", () => {
    const repo = gitRepo(join(scratch(), "app"));
    const ctx = testContext({
      env: { TRACEPARENT: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01", TRACESTATE: "vendor=x" },
    });
    const { calls, spawner } = recorder();
    span(ctx, "hook.stop", "hook", (hook) => stopHook(hook, { cwd: repo }, parseLearnArgs([]), spawner));
    span(ctx, "hook.stop", "hook", (hook) => stopHook(hook, { cwd: repo }, parseLearnArgs([]), spawner));
    const [first, second] = named(ctx, "hook.stop");
    expect(first).toMatchObject({ status: "ok", attrs: { spawned: true } });
    expect(second).toMatchObject({ status: "skipped", reason: "debounced" });
    expect(calls).toHaveLength(1);
    const env = calls[0]?.env ?? {};
    expect(parseTraceparent(env.TRACEPARENT)).toEqual({ traceId: first?.trace_id ?? "", spanId: first?.span_id ?? "" });
    expect(env.AK_LEARN_TRIGGER).toBe("hook");
    expect(env.TRACESTATE).toBeUndefined();
  });

  test("stop: a non-git directory is skipped with not-a-repo", () => {
    inOutsideRepo((cwd) => {
      const ctx = testContext();
      span(ctx, "hook.stop", "hook", (hook) => stopHook(hook, { cwd }, parseLearnArgs([]), recorder().spawner));
      expect(named(ctx, "hook.stop")[0]).toMatchObject({ status: "skipped", reason: "not-a-repo" });
    });
  });

  test("stop: an oversized pipeline log is rotated before the spawn and its old generation is never committed", () => {
    const repo = gitRepo(join(scratch(), "app"));
    const ctx = testContext();
    const small = { ...ctx, config: { ...ctx.config, traceMaxBytes: 50 } };
    const ledger = reviewLedger(ctx.config, repo);
    // A ledger seeded before the rotated log existed: its .gitignore does not name it.
    writeFileSync(ledger.path(".gitignore"), "raw/.last_run\nraw/.pipeline.log\n.lock*\n");
    ledger.commit("old ignore file");
    writeFileSync(ledger.path(PIPELINE_LOG), "x".repeat(80));
    stopHook(small, { cwd: repo }, parseLearnArgs([]), recorder().spawner);
    const rotated = join(reviewLedgerDir(ctx.config, repo), "raw", ".pipeline.1.log");
    expect(readFileSync(rotated, "utf8")).toBe("x".repeat(80));
    expect(readFileSync(ledger.path(PIPELINE_LOG), "utf8")).toBe("");
    writeFileSync(ledger.path("log.md"), "# Maintainer log\nchanged\n");
    ledger.commit("after rotation");
    expect(ledger.git(["ls-files", "raw"]).stdout).not.toContain(".pipeline");
  });

  test("stop and prompt in a dry run record dry-run and write nothing", () => {
    const repo = gitRepo(join(scratch(), "app"));
    const ctx = testContext({ cwd: repo, env: { AK_LEARN_DRY_RUN: "1" } });
    const { calls, spawner } = recorder();
    span(ctx, "hook.stop", "hook", (hook) => stopHook(hook, { cwd: repo }, parseLearnArgs([]), spawner));
    expect(learn(ctx, ["hook", "prompt"], JSON.stringify({ cwd: repo, prompt: "no, use the fixture clock" }))).toBe(0);
    expect(calls).toHaveLength(0);
    expect(named(ctx, "hook.stop")[0]).toMatchObject({ status: "dry-run" });
    expect(named(ctx, "hook.prompt")[0]).toMatchObject({ status: "dry-run" });
    expect(existsSync(reviewLedgerDir(ctx.config, repo))).toBe(false);
  });

  test("prompt: a correction is captured; an ordinary prompt is nothing", () => {
    const repo = gitRepo(join(scratch(), "app"));
    const ctx = testContext({ cwd: repo });
    expect(learn(ctx, ["hook", "prompt"], JSON.stringify({ cwd: repo, prompt: "no, use the fixture clock" }))).toBe(0);
    expect(learn(ctx, ["hook", "prompt"], JSON.stringify({ cwd: repo, prompt: "please add a test" }))).toBe(0);
    const [captured, plain] = named(ctx, "hook.prompt");
    expect(captured).toMatchObject({ status: "ok", attrs: { captured: true }, trigger: "hook" });
    expect(captured?.attrs.detection).not.toBe("none");
    expect(plain).toMatchObject({ status: "nothing", attrs: { captured: false, detection: "none" } });
  });

  test("session-start outside any repository prints the roster only and records no project", () => {
    inOutsideRepo((cwd) => {
      const ctx = testContext({ cwd });
      expect(learn(ctx, ["hook", "session-start"], JSON.stringify({ cwd }))).toBe(0);
      expect(named(ctx, "hook.session-start")[0]).toMatchObject({
        project_key: null,
        attrs: { guardrails: 0, lessons: 0 },
      });
    });
  });
});
