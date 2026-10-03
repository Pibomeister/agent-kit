/**
 * Episodes from a claude-mem fixture: fields and priority literals, the stale
 * active session, edits recorded only by tool use, and a second run that
 * appends nothing.
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
import { ensureMemoryLedger } from "../../src/learn/memory/ledger.ts";
import { ClaudeMemSource } from "../../src/learn/sources/claude-mem.ts";
import { MemFixture, scratch } from "./helpers.ts";

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
