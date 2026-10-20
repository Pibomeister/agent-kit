/**
 * The learn raw store: one SQLite file per memory ledger that git never stages,
 * one row per episode and per worker session, full judge bodies in one table of
 * the runtime directory's database, and the metadata traces still capped at the
 * configured size plus one generation. Ledgers written before the store keep
 * their jsonl files; the first write reads them once and leaves them in place.
 */
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../../src/learn/core/config.ts";
import { commandJudge, JUDGE_BODIES_FILE, judgeBody, type JudgeTraceRow } from "../../src/learn/core/judge.ts";
import { Ledger, RAW_STORE_FILE } from "../../src/learn/core/ledger.ts";
import { readJsonl } from "../../src/learn/core/store.ts";
import { appendCapped } from "../../src/learn/core/trace.ts";
import {
  buildEpisodes,
  consolidatedSids,
  type Episode,
  loadEpisodes,
  unconsolidatedEpisodes,
} from "../../src/learn/memory/episodes.ts";
import { ensureMemoryLedger } from "../../src/learn/memory/ledger.ts";
import { ClaudeMemSource } from "../../src/learn/sources/claude-mem.ts";
import { type CapturedSession, CAPTURE_ID_BASE, WorkerSessionSource } from "../../src/learn/sources/worker-sessions.ts";
import { MemFixture, scratch } from "./helpers.ts";

const NOW = 1_800_000_000_000;
const H = 3_600_000;

function rowCount(ledger: Ledger, table: string): number {
  const db = new Database(ledger.path(RAW_STORE_FILE), { readonly: true });
  try {
    return db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n ?? 0;
  } finally {
    db.close();
  }
}

function episode(sid: string, obs: number, extra: Partial<Episode> = {}): Episode {
  return {
    sid,
    platform: "claude",
    started: NOW - 10 * H,
    ended: NOW - 9 * H,
    prompts: 1,
    obs,
    tokens: 10,
    files_modified: [],
    request: null,
    completed: false,
    failure_signals: 0,
    corrections: 0,
    review_events: 0,
    priority: 0.1,
    ...extra,
  };
}

function workerSession(nativeId: string, times: readonly number[]): CapturedSession {
  return {
    native_id: nativeId,
    memory_session_id: nativeId.padEnd(32, "0"),
    platform: "codex",
    cwd: "/fixture/worktree",
    started_at_epoch: times[0] ?? 0,
    completed_at_epoch: times.at(-1) ?? null,
    modified_at_epoch: Date.now(),
    prompt_count: 0,
    request: null,
    completed: null,
    next_steps: null,
    files_modified: [],
    observations: times.map((at, index) => ({
      type: "turn",
      title: "worker turn",
      text: `${nativeId} step ${index}`,
      at,
      files_modified: [],
    })),
  };
}

function judgeScript(dir: string): string {
  const script = join(dir, "judge.sh");
  writeFileSync(script, `printf '%s\\n' '{"result":"{\\"answer\\":\\"kept\\"}"}'\n`);
  return script;
}

describe("episodes in the raw store", () => {
  test("a refreshed episode replaces its one row", () => {
    const dir = scratch();
    const dbPath = join(dir, "mem.db");
    const mem = new MemFixture(dbPath);
    mem.session({ sid: "growing", project: "app", started: NOW - 8 * H });
    mem.observation({ sid: "growing", project: "app", type: "discovery", title: "first", at: NOW - 8 * H });
    const ledger = ensureMemoryLedger(join(dir, "memory"));
    let source = ClaudeMemSource.open(dbPath);
    if (source === null) throw new Error("expected the fixture database");
    try {
      expect(buildEpisodes(source, ledger, "app", [], { now: NOW })[0]?.obs).toBe(1);
    } finally {
      source.close();
    }
    expect(rowCount(ledger, "episodes")).toBe(1);

    mem.observation({ sid: "growing", project: "app", type: "bugfix", title: "fixed it", at: NOW - 7 * H });
    mem.close();
    source = ClaudeMemSource.open(dbPath);
    if (source === null) throw new Error("expected the fixture database");
    try {
      expect(buildEpisodes(source, ledger, "app", [], { now: NOW })[0]?.obs).toBe(2);
    } finally {
      source.close();
    }
    expect(rowCount(ledger, "episodes")).toBe(1);
    expect(loadEpisodes(ledger).map((row) => [row.sid, row.obs])).toEqual([["growing", 2]]);
    expect(existsSync(ledger.path("episodes.jsonl"))).toBe(false);
  });

  test("a dry run creates no store", () => {
    const dir = scratch();
    const dbPath = join(dir, "mem.db");
    const mem = new MemFixture(dbPath);
    mem.session({ sid: "dry", project: "app", started: NOW - 8 * H, completed: NOW - 7 * H });
    mem.observation({ sid: "dry", project: "app", type: "discovery", title: "first", at: NOW - 8 * H });
    mem.close();
    const ledger = ensureMemoryLedger(join(dir, "memory"));
    const source = ClaudeMemSource.open(dbPath);
    if (source === null) throw new Error("expected the fixture database");
    try {
      expect(buildEpisodes(source, ledger, "app", [], { now: NOW, dryRun: true })).toHaveLength(1);
    } finally {
      source.close();
    }
    expect(existsSync(ledger.path(RAW_STORE_FILE))).toBe(false);
    expect(loadEpisodes(ledger)).toEqual([]);
  });
});

describe("worker capture in the raw store", () => {
  test("a refreshed session replaces its one row and observations are one row each", () => {
    const ledger = ensureMemoryLedger(scratch("ak-raw-workers-"));
    const first = workerSession("w", [1, 2]);
    expect(WorkerSessionSource.open(ledger).capture([first]).observations).toBe(2);
    const grown = workerSession("w", [1, 2, 3]);
    expect(WorkerSessionSource.open(ledger).capture([grown]).observations).toBe(1);

    expect(rowCount(ledger, "worker_sessions")).toBe(1);
    expect(rowCount(ledger, "worker_observations")).toBe(3);
    const source = WorkerSessionSource.open(ledger);
    expect(source.sessions("", 0, Number.MAX_SAFE_INTEGER).map((row) => row.observation_count)).toEqual([3]);
    expect(source.observationsSince("", 0).map((row) => row.id)).toEqual([
      CAPTURE_ID_BASE,
      CAPTURE_ID_BASE + 1,
      CAPTURE_ID_BASE + 2,
    ]);
    expect(existsSync(ledger.path("raw", "worker-observations.jsonl"))).toBe(false);
    expect(existsSync(ledger.path("raw", "worker-sessions.jsonl"))).toBe(false);
  });
});

describe("the ledger commit", () => {
  test("Ledger.commit does not stage the database, even where .gitignore does not name it", () => {
    const ledger = ensureMemoryLedger(scratch("ak-raw-commit-"));
    // A ledger seeded before the store: its .gitignore names only the lock files.
    writeFileSync(ledger.path(".gitignore"), ".lock*\n");
    WorkerSessionSource.open(ledger).capture([workerSession("c", [1])]);
    writeFileSync(ledger.path("memory.md"), "## Current state\n");
    expect(existsSync(ledger.path(RAW_STORE_FILE))).toBe(true);

    expect(ledger.commit("capture")).not.toBeNull();
    const tracked = ledger.git(["ls-files"]).stdout.split("\n");
    expect(tracked).toContain("memory.md");
    expect(tracked.filter((path) => path.startsWith(RAW_STORE_FILE))).toEqual([]);
    expect(ledger.git(["show", "--name-only", "--format=", "HEAD"]).stdout.trim().split("\n")).toEqual([
      ".gitignore",
      "memory.md",
    ]);
  });

  test("a new ledger ignores the store and SQLite sidecars", () => {
    const ledger = ensureMemoryLedger(scratch("ak-raw-ignore-"));
    for (const suffix of ["", "-journal", "-wal", "-shm"]) {
      const path = `${RAW_STORE_FILE}${suffix}`;
      const result = ledger.git(["check-ignore", "--", path]);
      expect(result.code).toBe(0);
      expect(result.stdout.trim()).toBe(path);
    }
  });
});

/** A ledger an older version wrote: episodes and worker rows in jsonl, with no store. */
function legacyLedger(): Ledger {
  const ledger = ensureMemoryLedger(scratch("ak-raw-legacy-"));
  writeFileSync(
    ledger.path("episodes.jsonl"),
    [
      episode("a", 1, { consolidated_run: "old-run" }),
      episode("b", 1),
      episode("a", 2),
      episode("c", 1, { consolidated_run: "old-run" }),
    ]
      .map((row) => `${JSON.stringify(row)}\n`)
      .join(""),
  );
  // Old-format worker files: the rows a store-less version appended, a session revised once.
  const observations = [CAPTURE_ID_BASE, CAPTURE_ID_BASE + 1].map((id, index) => ({
    id,
    key: `${index}`.padStart(16, "0"),
    memory_session_id: "l".padEnd(32, "0"),
    project: "",
    type: "turn",
    title: "worker turn",
    subtitle: null,
    narrative: null,
    facts: `l step ${index}`,
    concepts: "[]",
    files_read: "[]",
    files_modified: "[]",
    discovery_tokens: 2,
    created_at: new Date(index + 1).toISOString(),
    created_at_epoch: index + 1,
    platform_source: "codex",
  }));
  const session = {
    id: 0,
    memory_session_id: "l".padEnd(32, "0"),
    platform_source: "codex",
    started_at_epoch: 1,
    completed_at_epoch: null,
    modified_at_epoch: 5,
    observation_count: 1,
    native_id: "l",
    prompt_count: 0,
    request: null,
    completed: null,
    next_steps: null,
    files_modified: [],
  };
  mkdirSync(ledger.path("raw"), { recursive: true });
  writeFileSync(
    ledger.path("raw", "worker-observations.jsonl"),
    observations.map((row) => `${JSON.stringify(row)}\n`).join(""),
  );
  writeFileSync(
    ledger.path("raw", "worker-sessions.jsonl"),
    [session, { ...session, observation_count: 2, completed_at_epoch: 2 }]
      .map((row) => `${JSON.stringify(row)}\n`)
      .join(""),
  );
  return ledger;
}

describe("legacy jsonl files", () => {
  const LEGACY = ["episodes.jsonl", "raw/worker-observations.jsonl", "raw/worker-sessions.jsonl"];

  test("before any write the jsonl files are read and no store is created", () => {
    const ledger = legacyLedger();
    expect(loadEpisodes(ledger).map((row) => [row.sid, row.obs])).toEqual([
      ["a", 2],
      ["b", 1],
      ["c", 1],
    ]);
    // An older mark without an observation count stands only for an episode never refreshed.
    expect([...consolidatedSids(ledger)]).toEqual(["c"]);
    const source = WorkerSessionSource.open(ledger);
    expect(source.observationsSince("", 0).map((row) => row.facts)).toEqual(["l step 0", "l step 1"]);
    expect(source.sessions("", 0, Number.MAX_SAFE_INTEGER).map((row) => row.observation_count)).toEqual([2]);
    expect(existsSync(ledger.path(RAW_STORE_FILE))).toBe(false);
  });

  test("the first write reads them once into the store and leaves them in place", () => {
    const ledger = legacyLedger();
    const before = new Map(LEGACY.map((name) => [name, readFileSync(ledger.path(name), "utf8")]));

    expect(WorkerSessionSource.open(ledger).capture([workerSession("n", [10])]).observations).toBe(1);
    expect(existsSync(ledger.path(RAW_STORE_FILE))).toBe(true);
    for (const name of LEGACY) expect(readFileSync(ledger.path(name), "utf8")).toBe(before.get(name) ?? "");
    expect(rowCount(ledger, "episodes")).toBe(3);
    expect(rowCount(ledger, "worker_sessions")).toBe(2);
    expect(rowCount(ledger, "worker_observations")).toBe(3);

    // Rows added to a jsonl file after the import are not read again.
    appendFileSync(ledger.path("episodes.jsonl"), `${JSON.stringify(episode("late", 1))}\n`);
    appendFileSync(
      ledger.path("raw", "worker-sessions.jsonl"),
      `${JSON.stringify({ memory_session_id: "late".padEnd(32, "0"), started_at_epoch: 1 })}\n`,
    );
    expect(loadEpisodes(ledger).map((row) => row.sid)).toEqual(["a", "b", "c"]);
    expect([...consolidatedSids(ledger)]).toEqual(["c"]);
    expect(unconsolidatedEpisodes(ledger).map((row) => row.sid)).toEqual(["a", "b"]);
    const source = WorkerSessionSource.open(ledger);
    expect(source.observationsSince("", 0).map((row) => row.facts)).toEqual(["l step 0", "l step 1", "n step 0"]);
    expect(source.observationsSince("", 0).at(-1)?.id).toBe(CAPTURE_ID_BASE + 2);
    expect(source.sessions("", 0, Number.MAX_SAFE_INTEGER)).toHaveLength(2);

    // A second write imports nothing again.
    WorkerSessionSource.open(ledger).capture([workerSession("m", [11])]);
    expect(rowCount(ledger, "episodes")).toBe(3);
    expect(rowCount(ledger, "worker_sessions")).toBe(3);
  });
});

describe("trace metadata caps and full judge bodies", () => {
  test("the cap is 10 MiB and span and judge metadata keep one previous generation", () => {
    const dir = scratch();
    expect(loadConfig({ CLAUDE_CONFIG_DIR: join(dir, "config") }).traceMaxBytes).toBe(10 * 1024 * 1024);
    const config = {
      ...loadConfig({ CLAUDE_CONFIG_DIR: join(dir, "config"), AK_LEARN_TRACE: "full" }),
      judgeCommand: ["sh", judgeScript(dir)],
      judgeTimeoutMs: 10_000,
      traceMaxBytes: 800,
    };
    const judge = commandJudge(config);
    for (const prompt of ["one", "two", "three", "four"])
      expect(judge(prompt, { loop: "memory", role: "reflector", project: "shop", runId: null })).toEqual({
        answer: "kept",
      });
    const spans = join(config.runtimeDir, "spans.jsonl");
    for (let index = 0; index < 40; index += 1) appendCapped(spans, `${JSON.stringify({ index })}\n`, 100);

    const files = readdirSync(config.runtimeDir).filter((name) => name.endsWith(".jsonl"));
    expect(files.filter((name) => name.startsWith("judge-calls")).toSorted()).toEqual([
      "judge-calls.1.jsonl",
      "judge-calls.jsonl",
    ]);
    expect(files.filter((name) => name.startsWith("spans")).toSorted()).toEqual(["spans.1.jsonl", "spans.jsonl"]);
    for (const name of ["judge-calls.1.jsonl", "judge-calls.jsonl"])
      expect(statSync(join(config.runtimeDir, name)).size).toBeLessThanOrEqual(800);
    for (const name of ["spans.1.jsonl", "spans.jsonl"])
      expect(statSync(join(config.runtimeDir, name)).size).toBeLessThanOrEqual(100);
  });

  test("AK_LEARN_TRACE=full writes bodies into one table, dropped with their metadata generation", () => {
    const dir = scratch();
    const config = {
      ...loadConfig({ CLAUDE_CONFIG_DIR: join(dir, "config"), AK_LEARN_TRACE: "full" }),
      judgeCommand: ["sh", judgeScript(dir)],
      judgeTimeoutMs: 10_000,
      traceMaxBytes: 800,
    };
    const judge = commandJudge(config);
    for (const prompt of ["first", "second", "third"])
      expect(judge(prompt, { loop: "review", role: "pattern-maintainer", project: "shop", runId: null })).toEqual({
        answer: "kept",
      });

    const retained = ["judge-calls.1.jsonl", "judge-calls.jsonl"].flatMap((name) =>
      readJsonl<JudgeTraceRow>(join(config.runtimeDir, name)).map((row) => row.call_id),
    );
    expect(retained).toHaveLength(2);
    expect(existsSync(join(config.runtimeDir, "judge-bodies"))).toBe(false);
    const db = new Database(join(config.runtimeDir, JUDGE_BODIES_FILE), { readonly: true });
    try {
      expect(db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'").all()).toEqual([
        { name: "judge_bodies" },
      ]);
      expect(
        db
          .query<{ call_id: string }, []>("SELECT call_id FROM judge_bodies")
          .all()
          .map((row) => row.call_id)
          .toSorted(),
      ).toEqual(retained.toSorted());
    } finally {
      db.close();
    }
    expect(retained.map((id) => judgeBody(config, id))).toEqual([
      { prompt: "second", reply: '{"answer":"kept"}' },
      { prompt: "third", reply: '{"answer":"kept"}' },
    ]);
  });

  test("the default metadata-only trace creates no body database", () => {
    const dir = scratch();
    const config = {
      ...loadConfig({ CLAUDE_CONFIG_DIR: join(dir, "config") }),
      judgeCommand: ["sh", judgeScript(dir)],
      judgeTimeoutMs: 10_000,
    };
    expect(commandJudge(config)("prompt", { loop: "memory", role: "reflector", project: "shop", runId: null })).toEqual(
      { answer: "kept" },
    );
    expect(existsSync(join(config.runtimeDir, "judge-calls.jsonl"))).toBe(true);
    expect(existsSync(join(config.runtimeDir, JUDGE_BODIES_FILE))).toBe(false);
    expect(existsSync(join(config.runtimeDir, "judge-bodies"))).toBe(false);
  });
});
