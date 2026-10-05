/**
 * Offline worker-session capture: the three supported host stores normalize to
 * one observation shape, map a linked worktree through its Git common dir, and
 * append idempotently to the registered project's memory ledger.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Ledger } from "../../src/learn/core/ledger.ts";
import { run } from "../../src/learn/core/proc.ts";
import { ensureMemoryLedger } from "../../src/learn/memory/ledger.ts";
import { memoryDir, readState } from "../../src/learn/memory/ledger.ts";
import { loadEpisodes } from "../../src/learn/memory/episodes.ts";
import { type Registry, registerRoot, registryHygiene } from "../../src/learn/memory/registry.ts";
import { fetchNew, formatObservation } from "../../src/learn/memory/reflect.ts";
import { tick } from "../../src/learn/memory/tick.ts";
import {
  CAPTURE_ID_BASE,
  type CapturedSession,
  ProjectMemorySource,
  WorkerSessionSource,
  captureWorkerSessions,
  parseCodexSession,
  parseGrokSession,
  parseKimiSession,
  registeredRootForCwd,
  scanWorkerSessions,
} from "../../src/learn/sources/worker-sessions.ts";
import { projectScratch, reflectorOrEmptyJudge, removeProjectScratch, scratch, testContext } from "./helpers.ts";

const FIXTURES = join(import.meta.dir, "fixtures", "worker-sessions");

afterAll(removeProjectScratch);

function linkedRepo() {
  const main = join(projectScratch(), "registered");
  mkdirSync(main, { recursive: true });
  run(["git", "init", "-q"], { cwd: main });
  writeFileSync(join(main, "README.md"), "fixture\n");
  run(["git", "add", "-A"], { cwd: main });
  run(["git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init", "--no-gpg-sign"], {
    cwd: main,
  });

  const linked = join(projectScratch(), "linked");
  const linkedGit = join(main, ".git", "worktrees", "fixture");
  mkdirSync(linkedGit, { recursive: true });
  mkdirSync(linked, { recursive: true });
  writeFileSync(join(linked, ".git"), `gitdir: ${linkedGit}\n`);
  writeFileSync(join(linkedGit, "commondir"), "../..\n");
  writeFileSync(join(linkedGit, "gitdir"), `${join(linked, ".git")}\n`);
  writeFileSync(join(linkedGit, "HEAD"), readFileSync(join(main, ".git", "HEAD"), "utf8"));
  return { main, linked };
}

function requiredSession(value: CapturedSession | null): CapturedSession {
  if (value === null) throw new Error("fixture session did not parse");
  return value;
}

function replaceFixtureCwd(dir: string, cwd: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) replaceFixtureCwd(path, cwd);
    else if (entry.isFile() && (path.endsWith(".json") || path.endsWith(".jsonl")))
      writeFileSync(path, readFileSync(path, "utf8").replaceAll("/fixture/worktree", cwd));
  }
}

function workerSession(nativeId: string, times: readonly number[]): CapturedSession {
  return {
    native_id: nativeId,
    memory_session_id: nativeId.padEnd(32, "0"),
    platform: "codex",
    cwd: "/fixture/worktree",
    started_at_epoch: times[0] ?? 0,
    completed_at_epoch: times.at(-1) ?? null,
    prompt_count: 0,
    request: null,
    completed: null,
    next_steps: null,
    files_modified: [],
    observations: times.map((at, index) => ({
      type: "assistant",
      title: "assistant message",
      text: `${nativeId} step ${index}`,
      at,
      files_modified: [],
    })),
  };
}

/** Two overlapping sessions captured into one ledger: ids follow capture order, not time. */
function overlappingWorkers() {
  const ledger = ensureMemoryLedger(scratch("ak-capture-order-"));
  const long = workerSession("a", [100, 110, 120, 130, 140, 150, 160, 170, 180, 190]);
  const short = workerSession("b", [151, 152, 153, 154, 155, 156, 157, 158, 159, 160]);
  captureWorkerSessions(ledger, [long, short]);
  const workers = WorkerSessionSource.open(ledger);
  const rows = workers.observationsSince("", 0);
  const capFor = (count: number) => rows.slice(0, count).reduce((used, row) => used + formatObservation(row).length, 0);
  return { source: new ProjectMemorySource(null, workers), ids: rows.map((row) => row.id), capFor };
}

function codexToolOutput(text: string) {
  return {
    type: "response_item",
    payload: { type: "custom_tool_call_output", output: [{ type: "input_text", text }] },
  };
}

describe("worker session parsers", () => {
  test("normalizes a captured Codex rollout including tool input, failure output and edited files", () => {
    const path = join(FIXTURES, "codex", "sessions", "2026", "10", "04", "rollout-fixture.jsonl");
    const session = requiredSession(parseCodexSession(path));
    expect(session.platform).toBe("codex");
    expect(session.cwd).toBe("/fixture/worktree");
    expect(session.request).toBe("Fix the lint warnings without suppressing the rule.");
    expect(session.memory_session_id).toMatch(/^[0-9a-f]{32}$/);
    expect(session.observations.map((row) => row.type)).toEqual(["prompt", "tool-use", "error", "assistant"]);
    expect(session.files_modified).toEqual(["src/lint.ts"]);
    expect(session.observations.some((row) => row.text.includes("200 warnings remain"))).toBe(true);
    const text = session.observations.map((row) => row.text).join("\n");
    expect(text).not.toContain("injected project instructions");
    expect(text).not.toContain("injected global instructions");
    expect(text).not.toContain("injected skill body");
    expect(text).not.toContain("environment_context");
  });

  test("a tool result reporting zero failures is not a failure signal", () => {
    const path = join(scratch("ak-codex-rollout-"), "rollout-clean.jsonl");
    writeFileSync(
      path,
      [
        { type: "session_meta", payload: { id: "clean", cwd: "/fixture/worktree" } },
        codexToolOutput("Found 0 warnings and 0 errors."),
        codexToolOutput("12 pass\n0 fail\nno regression detected"),
        codexToolOutput("10 warnings in src/lint.ts"),
        codexToolOutput("1 error, 0 warnings"),
        codexToolOutput("2 errors, 0 warnings"),
        codexToolOutput("3 findings and 2 violations after 0 failures"),
        codexToolOutput("0 errors, 0 failures, no regressions"),
      ]
        .map((row) => JSON.stringify(row))
        .join("\n"),
    );
    const session = requiredSession(parseCodexSession(path));
    expect(session.observations.map((row) => row.type)).toEqual([
      "tool-result",
      "tool-result",
      "error",
      "error",
      "error",
      "error",
      "tool-result",
    ]);
  });

  test("normalizes a captured Grok session and excludes synthetic context", () => {
    const dir = join(FIXTURES, "grok", "sessions", "%2Ffixture%2Fworktree", "grok-session");
    const session = requiredSession(parseGrokSession(dir));
    expect(session.platform).toBe("grok");
    expect(session.request).toBe("Review why the verifier needed five rounds.");
    expect(session.files_modified).toEqual(["src/review.ts"]);
    expect(session.observations.some((row) => row.text.includes("injected project context"))).toBe(false);
    expect(session.observations.some((row) => row.type === "error")).toBe(true);
  });

  test("normalizes a captured Kimi wire and excludes injections and private reasoning", () => {
    const dir = join(FIXTURES, "kimi", "sessions", "wd_fixture", "kimi-session");
    const session = requiredSession(parseKimiSession(dir));
    expect(session.platform).toBe("kimi");
    expect(session.request).toBe("Find the regression in the capture loop.");
    expect(session.files_modified).toEqual(["src/capture.ts"]);
    const text = session.observations.map((row) => row.text).join("\n");
    expect(text).not.toContain("injected reminder");
    expect(text).not.toContain("private reasoning");
    expect(text).toContain("Typecheck failed");
  });

  test("scans captured fixture homes for every supported host", () => {
    const sessions = scanWorkerSessions(
      {
        codex: [join(FIXTURES, "codex")],
        grok: [join(FIXTURES, "grok")],
        kimi: [join(FIXTURES, "kimi")],
      },
      { sinceMs: 0 },
    );
    expect(sessions.map((session) => session.platform).toSorted()).toEqual(["codex", "grok", "kimi"]);
  });

  test("an unreadable host record is skipped and reported while the other sessions are returned", () => {
    const homes = scratch("ak-worker-unreadable-");
    cpSync(FIXTURES, homes, { recursive: true });
    const broken = join(homes, "kimi", "sessions", "wd_fixture", "broken-session");
    mkdirSync(join(broken, "agents", "main", "wire.jsonl"), { recursive: true });
    writeFileSync(join(broken, "state.json"), JSON.stringify({ id: "broken", cwd: "/fixture/worktree" }));
    const warnings: string[] = [];
    const sessions = scanWorkerSessions(
      { codex: [join(homes, "codex")], grok: [join(homes, "grok")], kimi: [join(homes, "kimi")] },
      { sinceMs: 0, warn: (line) => warnings.push(line) },
    );
    expect(sessions.map((session) => session.platform).toSorted()).toEqual(["codex", "grok", "kimi"]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(join(broken, "state.json"));
  });
});

describe("worker capture project resolution", () => {
  test("maps a linked worktree to the registered root by Git common dir", () => {
    const { main, linked } = linkedRepo();
    const ctx = testContext({ cwd: main });
    const registry = registerRoot(ctx.config, main, 1);
    expect(registeredRootForCwd(registry, linked)).toBe(main);
  });

  test("does not map a different clone merely because its basename matches", () => {
    const first = join(projectScratch(), "same-name");
    const second = join(projectScratch(), "other", "same-name");
    mkdirSync(first, { recursive: true });
    mkdirSync(second, { recursive: true });
    run(["git", "init", "-q"], { cwd: first });
    run(["git", "init", "-q"], { cwd: second });
    const registry: Registry = { registered: { root: first, mem_project: "same-name", last_seen: 1 } };
    expect(registeredRootForCwd(registry, second)).toBeNull();
  });

  test("a root folded by registry hygiene remains a Git identity alias of the one active ledger", () => {
    const older = join(projectScratch(), "older", "shop");
    const newer = join(projectScratch(), "newer", "shop");
    mkdirSync(older, { recursive: true });
    mkdirSync(newer, { recursive: true });
    run(["git", "init", "-q"], { cwd: older });
    run(["git", "init", "-q"], { cwd: newer });
    const clean = registryHygiene({
      older: { root: older, mem_project: "shop", last_seen: 1 },
      newer: { root: newer, mem_project: "shop", last_seen: 2 },
    }).registry;
    expect(Object.values(clean)).toEqual([{ root: newer, mem_project: "shop", last_seen: 2, aliases: [older] }]);
    expect(registeredRootForCwd(clean, older)).toBe(newer);
  });
});

describe("memory tick worker capture", () => {
  test("records all three hosts under the registered root without a claude-mem database", () => {
    const { main, linked } = linkedRepo();
    const homes = scratch("ak-worker-homes-");
    cpSync(FIXTURES, homes, { recursive: true });
    replaceFixtureCwd(homes, linked);
    const ctx = testContext({
      cwd: main,
      env: {
        AK_LEARN_CODEX_HOMES: join(homes, "codex"),
        AK_LEARN_GROK_HOMES: join(homes, "grok"),
        AK_LEARN_KIMI_HOMES: join(homes, "kimi"),
      },
      replies: [reflectorOrEmptyJudge, { lessons: [], review_events: [], log: "fixture batch" }],
    });
    registerRoot(ctx.config, main, Date.now());

    expect(tick(ctx, { only: main, job: "reflect", force: true })).toBe(0);
    const ledger = new Ledger(memoryDir(ctx.config, main));
    expect(
      loadEpisodes(ledger)
        .map((episode) => episode.platform)
        .toSorted(),
    ).toEqual(["codex", "grok", "kimi"]);
    expect(ctx.prompts).toHaveLength(1);
    expect(ctx.prompts[0]).toContain("200 warnings remain");
    expect(ctx.prompts[0]).toContain("verifier still reports the same finding");
    expect(ctx.prompts[0]).toContain("Typecheck failed in src/capture.ts");
    expect(readState(ledger).last_worker_obs_id_reflected).toBeGreaterThanOrEqual(CAPTURE_ID_BASE);

    expect(tick(ctx, { only: main, job: "nightly", force: true })).toBe(0);
    expect(ctx.prompts).toHaveLength(2);
    expect(ctx.out.some((line) => line.includes("nightly: 3/3 episodes"))).toBe(true);

    expect(tick(ctx, { only: main, job: "reflect", force: true })).toBe(0);
    expect(ctx.prompts).toHaveLength(2);
    expect(ctx.out.filter((line) => line.includes("worker observations +0")).length).toBeGreaterThan(0);
  });
});

describe("reflect window over captured workers", () => {
  test("a capped read after the worker watermark shows the ids next to it, whatever their times", () => {
    const { source, ids, capFor } = overlappingWorkers();
    const shown = fetchNew(source, "", 0, capFor(15), CAPTURE_ID_BASE - 1);
    expect(shown.map((row) => row.id)).toEqual(ids.slice(0, 15));
  });

  test("a zero worker watermark fills from the newest worker rows though claude-mem was already reflected", () => {
    const { source, ids, capFor } = overlappingWorkers();
    const shown = fetchNew(source, "", 41, capFor(5), 0);
    expect(shown.map((row) => row.id)).toEqual(ids.slice(-5));
  });
});

describe("captured observation ledger", () => {
  test("appends normalized sessions idempotently with a separate monotonic id range", () => {
    const ledger = ensureMemoryLedger(scratch("ak-capture-ledger-"));
    const codex = requiredSession(
      parseCodexSession(join(FIXTURES, "codex", "sessions", "2026", "10", "04", "rollout-fixture.jsonl")),
    );
    expect(captureWorkerSessions(ledger, [codex])).toBe(4);
    expect(captureWorkerSessions(ledger, [codex])).toBe(0);

    const source = WorkerSessionSource.open(ledger);
    const sessions = source.sessions("ignored", 0, Number.MAX_SAFE_INTEGER);
    expect(sessions).toHaveLength(1);
    const observations = source.sessionObservations(codex.memory_session_id);
    expect(observations).toHaveLength(4);
    expect(observations.every((row) => row.id >= CAPTURE_ID_BASE)).toBe(true);
    expect(observations.map((row) => row.id)).toEqual(observations.map((row) => row.id).toSorted((a, b) => a - b));
    expect(new Ledger(ledger.dir).git(["status", "--porcelain"]).stdout).not.toBe("");
  });
});
