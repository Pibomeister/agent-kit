/**
 * Episodes from a claude-mem fixture: fields and priority literals, the stale
 * active session, edits recorded only by tool use, a second run that
 * appends nothing, and the ids a session was shown joined onto its row.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildEpisodes,
  type Episode,
  type EpisodeEvent,
  loadEpisodes,
  markConsolidated,
  unconsolidatedEpisodes,
} from "../../src/learn/memory/episodes.ts";
import { readJsonl } from "../../src/learn/core/store.ts";
import { sessionKey, span } from "../../src/learn/core/trace.ts";
import { shownLookup } from "../../src/learn/memory/exposure.ts";
import { ensureMemoryLedger } from "../../src/learn/memory/ledger.ts";
import { ClaudeMemSource } from "../../src/learn/sources/claude-mem.ts";
import { MemFixture, scratch, testContext } from "./helpers.ts";

const NOW = 1_800_000_000_000; // 2027-01-15T08:00:00Z
const D = 86_400_000;
const H = 3_600_000;

function fixture(path: string): void {
  const mem = new MemFixture(path);
  const s1 = mem.session({
    sid: "s1",
    project: "app",
    platform: "claude",
    started: NOW - 14 * D - H,
    completed: NOW - 14 * D,
  });
  const s2 = mem.session({ sid: "s2", project: "app/wt", platform: "codex", started: NOW - H, completed: NOW });
  mem.session({ sid: "s3", project: "app", started: NOW - 7 * H }); // stale active: ends at its last observation
  mem.session({ sid: "s4", project: "app", started: NOW - 2 * H }); // still active: excluded
  mem.session({ sid: "s5", project: "other", started: NOW - D, completed: NOW - D + H }); // other project: excluded
  mem.observation({
    sid: "s1",
    project: "app",
    type: "discovery",
    title: "t",
    tokens: 1000,
    filesModified: ["a.ts"],
    at: NOW - 14 * D - H / 2,
  });
  mem.observation({
    sid: "s1",
    project: "app",
    type: "review-finding",
    title: "t",
    tokens: 3000,
    filesModified: ["b.ts"],
    at: NOW - 14 * D,
  });
  mem.observation({
    sid: "s2",
    project: "app/wt",
    type: "change",
    title: "t",
    tokens: 2000,
    filesModified: ["a.ts", "c.ts"],
    at: NOW - H / 2,
  });
  mem.observation({ sid: "s3", project: "app", type: "discovery", title: "t", tokens: 500, at: NOW - 7 * H });
  mem.observation({ sid: "s4", project: "app", type: "discovery", title: "t", tokens: 500, at: NOW - H });
  mem.observation({ sid: "s5", project: "other", type: "discovery", title: "t", tokens: 500, at: NOW - D });
  mem.summary({ sid: "s1", project: "app", request: "fix the thing", completed: "done it", next: "" });
  mem.summary({ sid: "s2", project: "app/wt", request: "explore", completed: "", next: "" });
  mem.prompt({ sessionDbId: s1, content: "s1", n: 1, text: "p" });
  mem.prompt({ sessionDbId: s1, content: "s1", n: 2, text: "p" });
  mem.prompt({ sessionDbId: s2, content: "s2", n: 1, text: "p" });
  // Only tool use records d.ts.
  mem.toolUse({
    sid: "s1",
    project: "app",
    tool: "Edit",
    input: { file_path: "d.ts", old_string: "x" },
    at: NOW - 14 * D,
  });
  mem.toolUse({ sid: "s1", project: "app", tool: "Read", input: { file_path: "never-counted.ts" }, at: NOW - 14 * D }); // reads are not edits
  mem.toolUse({ sid: "s2", project: "app/wt", tool: "Write", input: { file_path: "a.ts" }, at: NOW }); // no double count
  mem.close();
}

const EVENTS: EpisodeEvent[] = [
  { source: "correction", ts: "2027-01-01T07:30:00Z" }, // inside s1's window
  { source: "correction", ts: "2027-01-10T07:30:00Z" }, // outside every window
  { source: "claude-mem", obs_id: 2, ts: "2027-01-01T08:00:00Z" },
  { source: "learn-memory", obs_id: 2, ts: "2027-01-01T08:00:00Z" }, // this loop's own output never feeds back in
];

function setup() {
  const dir = scratch();
  const dbPath = join(dir, "mem.db");
  fixture(dbPath);
  const ledger = ensureMemoryLedger(join(dir, "memory"));
  const source = ClaudeMemSource.open(dbPath)!;
  return { ledger, source };
}

describe("episodes", () => {
  test("fields and priority", () => {
    const { ledger, source } = setup();
    let fresh: Episode[];
    try {
      fresh = buildEpisodes(source, ledger, "app", EVENTS, { now: NOW });
    } finally {
      source.close();
    }
    const by = new Map(fresh.map((episode) => [episode.sid, episode]));
    expect([...by.keys()].sort()).toEqual(["s1", "s2", "s3"]);
    const s1 = by.get("s1")!;
    expect([s1.platform, s1.prompts, s1.obs, s1.tokens, s1.files_modified]).toEqual([
      "claude",
      2,
      2,
      4000,
      ["a.ts", "b.ts", "d.ts"],
    ]);
    expect(by.get("s2")!.files_modified).toEqual(["a.ts", "c.ts"]);
    expect([s1.request, s1.completed, s1.failure_signals, s1.corrections, s1.review_events]).toEqual([
      "fix the thing",
      true,
      1,
      1,
      1,
    ]);
    expect([s1.started, s1.ended]).toEqual([NOW - 14 * D - H, NOW - 14 * D]);
    expect(by.get("s3")!.ended).toBe(NOW - 7 * H);
    expect(by.get("s2")!.completed).toBe(false);
    // 0.30*C + 0.20*F + 0.15*R + 0.10*T + 0.10*N + 0.15*A, hand-computed:
    // s1: C=1/3 F=1/5 R=1/5 T=1 N=1 A=e^-1        -> 0.1+0.04+0.03+0.1+0.1+0.055182 = 0.4252
    // s2: T=0.5 N=0.5 (a.ts seen in s1) A=1        -> 0.05+0.05+0.15 = 0.25
    // s3: T=0.125 N=0 A=e^(-(7/24)/14)=0.979382    -> 0.0125+0.146907 = 0.1594
    expect([by.get("s1")!.priority, by.get("s2")!.priority, by.get("s3")!.priority]).toEqual([0.4252, 0.25, 0.1594]);
    const rows = readFileSync(ledger.path("episodes.jsonl"), "utf8")
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => (JSON.parse(line) as Episode).sid);
    expect(rows).toEqual(["s1", "s3", "s2"]); // written oldest first
  });

  test("a second run appends nothing", () => {
    const { ledger, source } = setup();
    try {
      buildEpisodes(source, ledger, "app", EVENTS, { now: NOW });
      expect(buildEpisodes(source, ledger, "app", EVENTS, { now: NOW })).toEqual([]);
    } finally {
      source.close();
    }
    expect(
      readFileSync(ledger.path("episodes.jsonl"), "utf8")
        .split("\n")
        .filter((line) => line !== "").length,
    ).toBe(3);
  });

  test("a session with new observations is rebuilt and re-queued for nightly", () => {
    const dir = scratch();
    const dbPath = join(dir, "mem.db");
    const mem = new MemFixture(dbPath);
    mem.session({ sid: "growing", project: "app", started: NOW - 8 * H });
    mem.observation({ sid: "growing", project: "app", type: "discovery", title: "first", at: NOW - 8 * H });
    const ledger = ensureMemoryLedger(join(dir, "memory"));
    let source = ClaudeMemSource.open(dbPath);
    expect(source).not.toBeNull();
    if (source === null) return;
    try {
      expect(buildEpisodes(source, ledger, "app", EVENTS, { now: NOW })[0]?.obs).toBe(1);
    } finally {
      source.close();
    }
    markConsolidated(ledger, new Map([["growing", { obs: 1, obs_id: 1 }]]), "nightly-1");
    expect(unconsolidatedEpisodes(ledger)).toEqual([]);

    mem.observation({ sid: "growing", project: "app", type: "bugfix", title: "fixed it", at: NOW - 7 * H });
    mem.close();
    source = ClaudeMemSource.open(dbPath);
    expect(source).not.toBeNull();
    if (source === null) return;
    try {
      const refreshed = buildEpisodes(source, ledger, "app", EVENTS, { now: NOW });
      expect(refreshed).toHaveLength(1);
      expect([refreshed[0]?.obs, refreshed[0]?.failure_signals]).toEqual([2, 1]);
    } finally {
      source.close();
    }
    expect(loadEpisodes(ledger)).toHaveLength(1);
    expect(unconsolidatedEpisodes(ledger).map((episode) => episode.sid)).toEqual(["growing"]);
  });

  test("bugfix observations and failure wording in titles fill the failure signal", () => {
    const dir = scratch();
    const dbPath = join(dir, "mem.db");
    const mem = new MemFixture(dbPath);
    mem.session({ sid: "failed", project: "app", started: NOW - D, completed: NOW - D + H });
    mem.observation({ sid: "failed", project: "app", type: "bugfix", title: "repair", at: NOW - D });
    mem.observation({ sid: "failed", project: "app", type: "discovery", title: "tests failed in CI", at: NOW - D });
    mem.observation({ sid: "failed", project: "app", type: "discovery", title: "3 test failures in CI", at: NOW - D });
    mem.observation({
      sid: "failed",
      project: "app",
      type: "discovery",
      title: "Type errors after upgrade",
      at: NOW - D,
    });
    mem.observation({ sid: "failed", project: "app", type: "discovery", title: "normal discovery", at: NOW - D });
    mem.close();
    const ledger = ensureMemoryLedger(join(dir, "memory"));
    const source = ClaudeMemSource.open(dbPath);
    expect(source).not.toBeNull();
    if (source === null) return;
    try {
      expect(buildEpisodes(source, ledger, "app", [], { now: NOW })[0]?.failure_signals).toBe(4);
    } finally {
      source.close();
    }
  });

  test("a dry run writes nothing", () => {
    const { ledger, source } = setup();
    try {
      expect(buildEpisodes(source, ledger, "app", EVENTS, { now: NOW, dryRun: true }).length).toBe(3);
    } finally {
      source.close();
    }
    expect(readFileSync(ledger.path("episodes.jsonl"), "utf8")).toBe("");
  });
});

/** Three ended sessions whose host ids differ from the observer's own. */
function shownFixture(dbPath: string): MemFixture {
  const mem = new MemFixture(dbPath);
  for (const [index, sid] of ["a", "b", "c"].entries()) {
    mem.session({
      sid,
      content: `host-${sid}`,
      project: "app",
      started: NOW - D + index * H,
      completed: NOW - D + (index + 1) * H,
    });
    mem.observation({ sid, project: "app", type: "discovery", title: "t", at: NOW - D + index * H });
  }
  return mem;
}

/** The fixture database opened as the runtime opens it. */
function opened(dbPath: string): ClaudeMemSource {
  const source = ClaudeMemSource.open(dbPath);
  if (source === null) throw new Error(`claude-mem source did not open at ${dbPath}`);
  return source;
}

describe("what a session was shown", () => {
  test("a row carries the ids recorded for its host session: some, none, or no record at all", () => {
    const dir = scratch();
    const dbPath = join(dir, "mem.db");
    shownFixture(dbPath).close();
    const ledger = ensureMemoryLedger(join(dir, "memory"));
    const source = opened(dbPath);
    const asked: string[] = [];
    const recorded = new Map([
      ["host-a", ["rp-001", "ls-002"]],
      ["host-b", []],
    ]);
    try {
      buildEpisodes(source, ledger, "app", EVENTS, {
        now: NOW,
        shown: (id) => {
          asked.push(id);
          return recorded.get(id);
        },
      });
    } finally {
      source.close();
    }
    expect(asked).toEqual(["host-a", "host-b", "host-c"]);
    const rows = readJsonl<Episode>(ledger.path("episodes.jsonl"));
    expect(rows.map((row) => [row.sid, row.shown])).toEqual([
      ["a", ["rp-001", "ls-002"]],
      ["b", []],
      ["c", undefined],
    ]);
    expect(rows[2]).not.toHaveProperty("shown");
  });

  test("a refreshed row keeps what its earlier revision recorded and adds what the spans now say", () => {
    const dir = scratch();
    const dbPath = join(dir, "mem.db");
    const mem = shownFixture(dbPath);
    const ledger = ensureMemoryLedger(join(dir, "memory"));
    const build = (shown: (id: string) => string[] | undefined) => {
      const source = opened(dbPath);
      try {
        return buildEpisodes(source, ledger, "app", EVENTS, { now: NOW, shown });
      } finally {
        source.close();
      }
    };
    try {
      build((id) => (id === "host-a" ? ["ls-001"] : undefined));
      // Nothing grew, so nothing is asked and nothing is rewritten.
      expect(build(() => ["ls-009"])).toEqual([]);
      mem.observation({ sid: "a", project: "app", type: "discovery", title: "more", at: NOW - D });
      mem.observation({ sid: "c", project: "app", type: "discovery", title: "more", at: NOW - D + 2 * H });
      // The span files have rotated past session a's start; session c's has only now been recorded.
      const refreshed = build((id) => (id === "host-c" ? ["ls-003", "rp-002"] : undefined));
      expect(refreshed.map((row) => [row.sid, row.obs, row.shown])).toEqual([
        ["a", 2, ["ls-001"]],
        ["c", 2, ["ls-003", "rp-002"]],
      ]);
      mem.observation({ sid: "a", project: "app", type: "discovery", title: "again", at: NOW - D });
      expect(build(() => ["ls-004", "ls-001"])[0]?.shown).toEqual(["ls-001", "ls-004"]);
    } finally {
      mem.close();
    }
    expect(loadEpisodes(ledger).map((row) => [row.sid, row.shown])).toEqual([
      ["a", ["ls-001", "ls-004"]],
      ["b", undefined],
      ["c", ["ls-003", "rp-002"]],
    ]);
  });

  test("the lookup gathers every start of one session and answers nothing for a session no start names", () => {
    const ctx = testContext();
    const start = (hostSessionId: string | null, shown: string[]) =>
      span(ctx, "hook.session-start", "hook", (traced) => {
        if (hostSessionId !== null) traced.span?.attr("session", sessionKey(ctx.config, hostSessionId) ?? "");
        traced.span?.attr("shown", shown);
      });
    start("host-a", ["rp-001", "ls-001"]);
    start("host-b", []);
    start(null, ["ls-009"]);
    start("host-a", ["ls-001", "ls-002"]);
    span(ctx, "hook.prompt", "hook", (traced) => traced.span?.attr("session", sessionKey(ctx.config, "host-c") ?? ""));
    const lookup = shownLookup(ctx.config);
    expect(lookup("host-a")).toEqual(["rp-001", "ls-001", "ls-002"]);
    expect(lookup("host-b")).toEqual([]);
    expect(lookup("host-c")).toBeUndefined();
    expect(lookup("")).toBeUndefined();
    // One run reads the span files once: a start recorded after the first question belongs to the next run.
    start("host-c", ["ls-005"]);
    expect(lookup("host-c")).toBeUndefined();
    expect(shownLookup(ctx.config)("host-c")).toEqual(["ls-005"]);
  });
});
