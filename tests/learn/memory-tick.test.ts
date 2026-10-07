/**
 * The scheduler: the decision table on a fake local clock, a held lock that
 * exits without opening claude-mem, forcing without a job runs every job, and
 * a scheduled tick that discovers a project and never writes inside it.
 */
import { afterAll, describe, expect, setSystemTime, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { acquireLock, type Ledger } from "../../src/learn/core/ledger.ts";
import { tickLogPath } from "../../src/learn/core/paths.ts";
import { readJsonl } from "../../src/learn/core/store.ts";
import { ClaudeMemSource } from "../../src/learn/sources/claude-mem.ts";
import { unconsolidatedEpisodes } from "../../src/learn/memory/episodes.ts";
import {
  appendRun,
  ensureMemoryLedger,
  memoryDir,
  readState,
  saveState,
  type MemoryState,
} from "../../src/learn/memory/ledger.ts";
import { readRegistry, registerRoot } from "../../src/learn/memory/registry.ts";
import { decide, type DecideInput, runProject, tick } from "../../src/learn/memory/tick.ts";
import {
  gitRepo,
  MemFixture,
  projectScratch,
  reflectorOrEmptyJudge,
  reflectorReply,
  removeProjectScratch,
  scratch,
  testContext,
} from "./helpers.ts";

const NOON = new Date(2026, 8, 18, 12, 0);
const NIGHT = new Date(2026, 8, 18, 2, 10);
const THRESHOLDS = { idleS: 300, reflectTokens: 25_000, nightlyHour: 2 };

function fresh(): MemoryState {
  return { last_reflect: NOON.getTime() - 3_600_000, last_nightly: "2026-09-17", last_weekly: NOON.getTime() };
}

function run(state: MemoryState, now: Date, rest: Partial<DecideInput>): string[] {
  return decide(
    { state, now, idleS: 0, newTokens: 0, newObs: 0, unscreened: 0, unconsolidated: 0, ...rest },
    THRESHOLDS,
  );
}

describe("decide", () => {
  test("idle with enough new tokens reflects", () =>
    expect(run(fresh(), NOON, { idleS: 600, newTokens: 30_000, newObs: 40 })).toEqual(["reflect"]));

  test("busy does not reflect", () =>
    expect(run(fresh(), NOON, { idleS: 30, newTokens: 30_000, newObs: 40 })).toEqual([]));

  test("a six-hour gap reflects on any observation", () => {
    const state = { ...fresh(), last_reflect: NOON.getTime() - 7 * 3_600_000 };
    expect(run(state, NOON, { idleS: 30, newTokens: 100, newObs: 1 })).toEqual(["reflect"]);
  });

  test("nightly at 02:10 with a new episode", () =>
    expect(run(fresh(), NIGHT, { idleS: 60, unconsolidated: 1 })).toEqual(["nightly"]));

  test("nightly not twice a day", () =>
    expect(run({ ...fresh(), last_nightly: "2026-09-18" }, NIGHT, { idleS: 60, unconsolidated: 1 })).toEqual([]));

  test("a backlog runs nightly at any hour when idle", () =>
    expect(run({ ...fresh(), last_nightly: "2026-09-18" }, NOON, { idleS: 600, unconsolidated: 25 })).toEqual([
      "nightly",
    ]));

  test("unscreened history backfills only while idle", () => {
    expect(run(fresh(), NOON, { idleS: 600, unscreened: 40 })).toEqual(["backfill"]);
    expect(run(fresh(), NOON, { idleS: 30, unscreened: 40 })).toEqual([]);
    expect(run(fresh(), NOON, { idleS: 600 })).toEqual([]);
  });

  test("weekly when idle and a week has passed", () =>
    expect(run({ ...fresh(), last_weekly: NOON.getTime() - 8 * 86_400_000 }, NOON, { idleS: 600 })).toEqual([
      "weekly",
    ]));

  test("muted runs nothing", () =>
    expect(
      run({ ...fresh(), muted: true, last_weekly: 0 }, NIGHT, {
        idleS: 9999,
        newTokens: 99_999,
        newObs: 9,
        unscreened: 9,
        unconsolidated: 30,
      }),
    ).toEqual([]));

  test("force overrides everything, mute included", () => {
    expect(run({ muted: true }, NOON, { force: "all" })).toEqual(["reflect", "backfill", "nightly", "weekly"]);
    expect(run({}, NOON, { force: "nightly" })).toEqual(["nightly"]);
  });

  test("failed jobs back off exponentially and the reflect token clause respects it", () => {
    const failed = {
      ...fresh(),
      last_reflect_attempt: NOON.getTime() - 30 * 60_000,
      reflect_failures: 1,
      last_nightly_attempt: NOON.getTime() - 30 * 60_000,
      nightly_failures: 1,
    };
    expect(run(failed, NOON, { idleS: 600, newTokens: 30_000, newObs: 40, unscreened: 5, unconsolidated: 30 })).toEqual(
      [],
    );
    expect(
      run(failed, new Date(NOON.getTime() + 31 * 60_000), {
        idleS: 600,
        newTokens: 30_000,
        newObs: 40,
        unscreened: 5,
        unconsolidated: 30,
      }),
    ).toEqual(["reflect", "backfill", "nightly"]);
  });
});

describe("decide, the failure backoff schedule", () => {
  // 1h doubling per consecutive failure, capped at 24h: 3 failures wait 4h, 20 failures wait 24h, not 2^19 h.
  for (const [failures, waitH] of [
    [1, 1],
    [3, 4],
    [20, 24],
  ] as const) {
    test(`${failures} consecutive failures hold reflect and nightly for exactly ${waitH}h`, () => {
      const attempted = NOON.getTime();
      const state = {
        ...fresh(),
        last_reflect_attempt: attempted,
        reflect_failures: failures,
        last_nightly_attempt: attempted,
        nightly_failures: failures,
      };
      const due = { idleS: 600, newTokens: 30_000, newObs: 40, unscreened: 5, unconsolidated: 30 };
      expect(run(state, new Date(attempted + waitH * 3_600_000 - 60_000), due)).toEqual([]);
      expect(run(state, new Date(attempted + waitH * 3_600_000), due)).toEqual(["reflect", "backfill", "nightly"]);
    });
  }
});

function fixtureProject(ageDays = 1) {
  const dir = scratch();
  const root = gitRepo(join(projectScratch(), "shop"));
  const dbPath = join(dir, "mem.db");
  const mem = new MemFixture(dbPath);
  // Every timestamp below sits one day before `now`; shifting `now` back ages the whole project.
  const now = Date.now() - (ageDays - 1) * 86_400_000;
  mem.session({ sid: "cccc3333-0000", project: "shop", started: now - 86_400_000, completed: now - 86_400_000 + 1000 });
  const observe = (title: string) =>
    mem.observation({ sid: "cccc3333-0000", project: "shop", type: "discovery", title, at: now - 86_400_000 + 500 });
  const reflected = observe("found it");
  observe("found another");
  mem.toolUse({ sid: "cccc3333-0000", project: "shop", tool: "Bash", cwd: root, at: now - 86_400_000 + 500 });
  mem.close();
  // Nightly reads only what the reflector has screened; a test that runs it puts `reflected` behind the watermark.
  return { root, reflected, ctx: testContext({ cwd: root, env: { AK_LEARN_MEM_DB: dbPath } }) };
}

/** Seed one exact accepted reflect range alongside its scheduler state. */
function seedReflected(ledger: Ledger, reflected: number, state: MemoryState = {}): void {
  saveState(ledger, { ...state, last_obs_id_reflected: reflected });
  appendRun(ledger, { job: "reflect", status: "ok", min_obs_id: reflected, max_obs_id: reflected });
}

afterAll(removeProjectScratch);

describe("tick", () => {
  test("an always-failing judge runs once per backoff window and never commits failures", () => {
    const { root, reflected, ctx } = fixtureProject();
    const ledger = ensureMemoryLedger(memoryDir(ctx.config, root));
    const start = new Date(2026, 8, 18, 2, 10);
    seedReflected(ledger, reflected, { last_nightly: "2026-09-17", last_weekly: start.getTime() });
    ledger.commit("seed scheduler state");
    try {
      setSystemTime(start);
      expect(tick(ctx)).toBe(0);
      const commits = ledger.git(["rev-list", "--count", "HEAD"]).stdout.trim();
      for (let i = 1; i < 8; i += 1) {
        setSystemTime(new Date(start.getTime() + i * 15 * 60_000));
        expect(tick(ctx)).toBe(0);
      }
      const reflectCalls = ctx.prompts.filter((prompt) => prompt.includes("# learn/reflector")).length;
      const nightlyCalls = ctx.prompts.filter((prompt) => prompt.includes("# learn/consolidator")).length;
      expect(reflectCalls).toBeLessThanOrEqual(2);
      expect(nightlyCalls).toBeLessThanOrEqual(2);
      expect(ledger.git(["rev-list", "--count", "HEAD"]).stdout.trim()).toBe(commits);
      expect(readState(ledger)).toMatchObject({ reflect_failures: reflectCalls, nightly_failures: nightlyCalls });
    } finally {
      setSystemTime();
    }
  });

  test("history behind the first reflect window is screened a batch per idle tick, then consolidated on the nightly cadence", () => {
    const root = gitRepo(join(projectScratch(), "history"));
    const dbPath = join(scratch(), "mem.db");
    const mem = new MemFixture(dbPath);
    const now = NOON.getTime();
    const session = (sid: string, count: number) => {
      mem.session({ sid, project: "history", started: now - 86_400_000, completed: now - 86_399_000 });
      return Array.from({ length: count }, (_, index) =>
        mem.observation({
          sid,
          project: "history",
          type: "discovery",
          title: `${sid} ${index}`,
          facts: ["f".repeat(600)],
          at: now - 600_000,
        }),
      );
    };
    const oldest = session("aaaa1111-0000", 30);
    const older = session("bbbb2222-0000", 30);
    const newest = session("cccc3333-0000", 70);
    mem.close();
    const ctx = testContext({
      cwd: root,
      env: { AK_LEARN_MEM_DB: dbPath },
      replies: Array.from({ length: 12 }, () => reflectorOrEmptyJudge),
    });
    const ledger = ensureMemoryLedger(memoryDir(ctx.config, root));
    saveState(ledger, { last_nightly: "2026-09-18", last_weekly: now });
    const source = ClaudeMemSource.open(dbPath);
    if (source === null) throw new Error(`claude-mem source did not open at ${dbPath}`);
    const tickAt = (at: Date) => {
      setSystemTime(at);
      const line = runProject(ctx, source, root, "history").find((entry) => entry.startsWith("idle "));
      return line?.slice(line.indexOf("unscreened"));
    };
    const calls = (role: string) => ctx.prompts.filter((prompt) => prompt.includes(`# learn/${role}`)).length;
    const runs = () =>
      readJsonl<{ job: string; status: string; min_obs_id?: number; obs_ids?: number[] }>(ledger.path("runs.jsonl"));
    const minutes = (n: number) => new Date(now + n * 60_000);
    try {
      expect(tickAt(NOON)).toBe("unscreened 0 unconsolidated 0 due reflect");
      const watermark = readState(ledger).last_obs_id_reflected;
      expect(watermark).toBe(newest.at(-1));
      const window = runs().find((row) => row.job === "reflect")?.min_obs_id ?? 0;
      expect(window).toBeGreaterThan(older.at(-1) ?? Infinity);

      // The session the window cut and the two behind it all wait for the backfill instead of holding nightly due.
      expect(tickAt(minutes(15))).toBe(`unscreened ${window - 1} unconsolidated 0 due backfill`);
      expect(calls("reflector")).toBe(2);
      expect(tickAt(minutes(30))?.endsWith("unconsolidated 2 due backfill")).toBe(true);
      expect(calls("reflector")).toBe(3);

      for (const n of [45, 60, 75]) expect(tickAt(minutes(n))).toBe("unscreened 0 unconsolidated 3 due none");
      expect(calls("reflector")).toBe(3);
      expect(calls("consolidator")).toBe(0);
      const backfills = runs().filter((row) => row.job === "backfill");
      expect(backfills.map((row) => row.status)).toEqual(["ok", "ok"]);
      expect(backfills.flatMap((row) => row.obs_ids ?? []).toSorted((a, b) => a - b)).toEqual(
        [...oldest, ...older, ...newest].filter((id) => id < window),
      );
      expect(backfills[0]?.obs_ids?.at(-1)).toBe(window - 1);
      expect(backfills[1]?.obs_ids?.[0]).toBe(oldest[0]);
      expect(readState(ledger).last_obs_id_reflected).toBe(watermark);

      const nextNight = new Date(2026, 8, 19, 2, 10);
      expect(tickAt(nextNight)).toBe("unscreened 0 unconsolidated 3 due nightly");
      expect(calls("consolidator")).toBe(1);
      expect(ctx.prompts.at(-1)).toContain(`  obs:${oldest[0]} [`);
      expect(unconsolidatedEpisodes(ledger)).toEqual([]);
      expect(tickAt(new Date(nextNight.getTime() + 15 * 60_000))).toBe("unscreened 0 unconsolidated 0 due none");
      expect(calls("consolidator")).toBe(1);
    } finally {
      setSystemTime();
      source.close();
    }
  });

  test("a session the first window cut at obs 50 of 40..60 is held from nightly until the backfill screens 40..49", () => {
    const root = gitRepo(join(projectScratch(), "partial"));
    const dbPath = join(scratch(), "mem.db");
    const mem = new MemFixture(dbPath);
    const now = NOON.getTime();
    const session = (sid: string, count: number, title: string) => {
      mem.session({ sid, project: "partial", started: now - 86_400_000, completed: now - 86_399_000 });
      return Array.from({ length: count }, () =>
        mem.observation({ sid, project: "partial", type: "discovery", title, at: now - 60_000 }),
      );
    };
    const behind = session("aaaa1111-0000", 39, "behind the window");
    const cut = session("bbbb2222-0000", 21, "t".repeat(3400));
    mem.close();
    expect([behind[0], behind.at(-1), cut[0], cut.at(-1)]).toEqual([1, 39, 40, 60]);
    const ctx = testContext({
      cwd: root,
      env: { AK_LEARN_MEM_DB: dbPath },
      replies: Array.from({ length: 6 }, () => reflectorOrEmptyJudge),
    });
    const ledger = ensureMemoryLedger(memoryDir(ctx.config, root));
    saveState(ledger, { last_nightly: "2026-09-17", last_weekly: now });
    const source = ClaudeMemSource.open(dbPath);
    if (source === null) throw new Error(`claude-mem source did not open at ${dbPath}`);
    const tickAt = (minute: number) => {
      setSystemTime(new Date(now + minute * 60_000));
      const line = runProject(ctx, source, root, "partial").find((entry) => entry.startsWith("idle "));
      return line?.slice(line.indexOf("unscreened"));
    };
    const calls = (role: string) => ctx.prompts.filter((prompt) => prompt.includes(`# learn/${role}`)).length;
    const marks = () =>
      readJsonl<{ sid: string; obs: number; obs_id: number }>(ledger.path("raw/consolidated.jsonl")).map((mark) => [
        mark.sid,
        mark.obs,
        mark.obs_id,
      ]);
    try {
      expect(tickAt(0)).toBe("unscreened 0 unconsolidated 0 due reflect");
      const runs = readJsonl<{ job: string; min_obs_id?: number; max_obs_id?: number }>(ledger.path("runs.jsonl"));
      expect(runs.filter((row) => row.job === "reflect").map((row) => [row.min_obs_id, row.max_obs_id])).toEqual([
        [50, 60],
      ]);

      // Past the nightly hour with no nightly yet today, and busy, so no backfill: neither held session makes nightly due.
      for (const minute of [1, 2, 3]) expect(tickAt(minute)).toBe("unscreened 49 unconsolidated 0 due none");
      expect(calls("consolidator")).toBe(0);
      expect(marks()).toEqual([]);
      expect(readState(ledger).last_nightly).toBe("2026-09-17");

      expect(tickAt(15)).toBe("unscreened 49 unconsolidated 0 due backfill");
      expect(calls("consolidator")).toBe(0);
      expect(tickAt(30)).toBe("unscreened 0 unconsolidated 2 due nightly");
      expect(calls("consolidator")).toBe(1);
      expect(ctx.prompts.at(-1)).toContain("  obs:40 [");
      expect(ctx.prompts.at(-1)).toContain("  obs:50 [");
      expect(marks().toSorted(([a], [b]) => String(a).localeCompare(String(b)))).toEqual([
        ["aaaa1111-0000", 39, 39],
        ["bbbb2222-0000", 21, 60],
      ]);
      for (const minute of [45, 60]) expect(tickAt(minute)).toBe("unscreened 0 unconsolidated 0 due none");
      expect(calls("consolidator")).toBe(1);
      expect(calls("reflector")).toBe(2);
    } finally {
      setSystemTime();
      source.close();
    }
  });

  test("old history no episode or deferred review id reaches is never backfilled", () => {
    const root = gitRepo(join(projectScratch(), "archive"));
    const dbPath = join(scratch(), "mem.db");
    const mem = new MemFixture(dbPath);
    const now = NOON.getTime();
    const old = now - 60 * 86_400_000;
    mem.session({ sid: "aaaa1111-0000", project: "archive", started: old, completed: old + 1000 });
    const archived = Array.from({ length: 150 }, (_, index) =>
      mem.observation({
        sid: "aaaa1111-0000",
        project: "archive",
        type: "discovery",
        title: `archived ${index}`,
        facts: ["f".repeat(600)],
        at: old + 500,
      }),
    );
    mem.session({ sid: "bbbb2222-0000", project: "archive", started: now - 86_400_000, completed: now - 86_399_000 });
    const recent = Array.from({ length: 3 }, (_, index) =>
      mem.observation({
        sid: "bbbb2222-0000",
        project: "archive",
        type: "discovery",
        title: `recent ${index}`,
        at: now - 600_000,
      }),
    );
    mem.close();
    const ctx = testContext({
      cwd: root,
      env: { AK_LEARN_MEM_DB: dbPath },
      replies: Array.from({ length: 4 }, () => (prompt: string) => reflectorReply(prompt)),
    });
    const ledger = ensureMemoryLedger(memoryDir(ctx.config, root));
    saveState(ledger, { last_nightly: "2026-09-18", last_weekly: now });
    const source = ClaudeMemSource.open(dbPath);
    if (source === null) throw new Error(`claude-mem source did not open at ${dbPath}`);
    const tickAt = (minute: number) => {
      setSystemTime(new Date(now + minute * 60_000));
      const line = runProject(ctx, source, root, "archive").find((entry) => entry.startsWith("idle "));
      return line?.slice(line.indexOf("unscreened"));
    };
    try {
      expect(tickAt(0)).toBe("unscreened 0 unconsolidated 0 due reflect");
      const runs = readJsonl<{ job: string; min_obs_id?: number }>(ledger.path("runs.jsonl"));
      const window = runs.find((row) => row.job === "reflect")?.min_obs_id ?? 0;
      expect(window).toBeGreaterThan(archived[0] ?? Infinity);
      expect(window).toBeLessThan(recent[0] ?? 0);
      expect(readState(ledger).last_obs_id_reflected).toBe(recent.at(-1));

      for (const minute of [15, 30, 45]) expect(tickAt(minute)).toBe("unscreened 0 unconsolidated 1 due none");
      expect(ctx.prompts).toHaveLength(1);
      expect(readJsonl<{ job: string }>(ledger.path("runs.jsonl")).filter((row) => row.job === "backfill")).toEqual([]);
    } finally {
      setSystemTime();
      source.close();
    }
  });

  test("an episode that ages past the 30-day window while it waits is still screened and consolidated", () => {
    const root = gitRepo(join(projectScratch(), "aging"));
    const dbPath = join(scratch(), "mem.db");
    const mem = new MemFixture(dbPath);
    const now = NOON.getTime();
    const day = 86_400_000;
    mem.session({ sid: "aaaa1111-0000", project: "aging", started: now - 29 * day, completed: now - 29 * day + 1000 });
    const waiting = Array.from({ length: 5 }, (_, index) =>
      mem.observation({
        sid: "aaaa1111-0000",
        project: "aging",
        type: "discovery",
        title: `waiting ${index}`,
        at: now - 29 * day + 500,
      }),
    );
    mem.session({ sid: "bbbb2222-0000", project: "aging", started: now - day, completed: now - day + 1000 });
    for (let index = 0; index < 70; index += 1)
      mem.observation({
        sid: "bbbb2222-0000",
        project: "aging",
        type: "discovery",
        title: `recent ${index}`,
        facts: ["f".repeat(600)],
        at: now - 600_000,
      });
    mem.close();
    const ctx = testContext({
      cwd: root,
      env: { AK_LEARN_MEM_DB: dbPath },
      replies: Array.from({ length: 4 }, () => reflectorOrEmptyJudge),
    });
    const ledger = ensureMemoryLedger(memoryDir(ctx.config, root));
    saveState(ledger, { last_nightly: "2026-09-18", last_weekly: now });
    const source = ClaudeMemSource.open(dbPath);
    if (source === null) throw new Error(`claude-mem source did not open at ${dbPath}`);
    const tickAt = (at: number) => {
      setSystemTime(new Date(at));
      const line = runProject(ctx, source, root, "aging").find((entry) => entry.startsWith("idle "));
      return line?.slice(line.indexOf("unscreened"));
    };
    try {
      expect(tickAt(now)).toBe("unscreened 0 unconsolidated 0 due reflect");
      const runs = readJsonl<{ job: string; min_obs_id?: number }>(ledger.path("runs.jsonl"));
      const window = runs.find((row) => row.job === "reflect")?.min_obs_id ?? 0;
      expect(window).toBeGreaterThan(waiting.at(-1) ?? Infinity);
      expect(unconsolidatedEpisodes(ledger).map((episode) => episode.sid)).toEqual(["aaaa1111-0000", "bbbb2222-0000"]);

      const later = now + 2 * day;
      expect(tickAt(later)).toBe(`unscreened ${window - 1} unconsolidated 0 due backfill`);
      expect(ctx.prompts.at(-1)).toContain(`obs:${waiting[0]} `);
      expect(tickAt(later + 15 * 60_000)).toBe("unscreened 0 unconsolidated 2 due nightly");
      expect(ctx.prompts.at(-1)).toContain(`  obs:${waiting[0]} [`);
      expect(unconsolidatedEpisodes(ledger)).toEqual([]);
    } finally {
      setSystemTime();
      source.close();
    }
  });

  test("a held lock exits 0 without opening claude-mem", () => {
    const ctx = testContext();
    mkdirSync(ctx.config.runtimeDir, { recursive: true });
    const release = acquireLock(join(ctx.config.runtimeDir, ".tick.lock"))!;
    try {
      expect(tick(ctx)).toBe(0);
    } finally {
      release();
    }
    expect(ctx.out).toEqual(["tick: another run holds the lock"]);
    expect(existsSync(tickLogPath(ctx.config))).toBe(false);
  });

  test("a missing claude-mem database is logged, not raised", () => {
    const ctx = testContext();
    expect(tick(ctx)).toBe(0);
    expect(readFileSync(tickLogPath(ctx.config), "utf8")).toContain("claude-mem database not found");
  });

  test("force without a job runs every job", () => {
    const { root, reflected, ctx } = fixtureProject();
    seedReflected(ensureMemoryLedger(memoryDir(ctx.config, root)), reflected);
    expect(tick(ctx, { force: true })).toBe(0);
    const jobs = readJsonl<{ job: string }>(join(memoryDir(ctx.config, root), "runs.jsonl")).map((row) => row.job);
    expect(jobs).toEqual(["reflect", "episodes", "reflect", "nightly", "weekly"]);
    expect(ctx.prompts.length).toBe(2); // reflect and nightly; weekly has no lessons to pair
  });

  test("the scheduled tick discovers the project from tool use and writes nothing inside it", () => {
    const { root, ctx } = fixtureProject();
    const before = readFileSync(join(root, ".git", "index"));
    expect(tick(ctx)).toBe(0);
    expect(Object.values(readRegistry(ctx.config)).map((entry) => entry.root)).toEqual([root]);
    expect(readFileSync(tickLogPath(ctx.config), "utf8")).toContain("shop: episodes +1");
    expect(existsSync(join(root, ".claude"))).toBe(false);
    expect(readFileSync(join(root, ".git", "index"))).toEqual(before);
  });

  test("a project whose own memory ledger is held is skipped, and the tick still exits 0", () => {
    const { root, ctx } = fixtureProject();
    const release = ensureMemoryLedger(memoryDir(ctx.config, root)).tryLock();
    expect(release).not.toBeNull();
    try {
      expect(tick(ctx, { force: true })).toBe(0);
    } finally {
      release?.();
    }
    expect(readFileSync(tickLogPath(ctx.config), "utf8")).toContain(
      "shop: another run holds this project's memory ledger",
    );
    expect(ctx.prompts).toEqual([]);
  });

  test("the scheduled tick skips a project with no activity in the last 7 days", () => {
    // One hour inside and one day outside the cutoff, so both sides of the 7-day boundary are pinned.
    for (const [ageDays, runs] of [
      [7 - 1 / 24, true],
      [8, false],
    ] as const) {
      const { ctx } = fixtureProject(ageDays);
      expect(tick(ctx)).toBe(0);
      expect(readFileSync(tickLogPath(ctx.config), "utf8").includes("shop: ")).toBe(runs);
    }
  });

  test("an explicit repository runs that repository alone", () => {
    const { root, ctx } = fixtureProject();
    const other = gitRepo(join(projectScratch(), "other"));
    registerRoot(ctx.config, root);
    registerRoot(ctx.config, other);
    expect(tick(ctx, { only: other, force: true })).toBe(0);
    expect(existsSync(memoryDir(ctx.config, root))).toBe(false);
    expect(readFileSync(tickLogPath(ctx.config), "utf8")).not.toContain("shop: ");
  });

  test("a dry run creates no ledger", () => {
    const { root, ctx } = fixtureProject();
    const dry = { ...ctx, config: { ...ctx.config, dryRun: true } };
    expect(tick(dry, { force: true })).toBe(0);
    expect(existsSync(memoryDir(ctx.config, root))).toBe(false);
  });
});
