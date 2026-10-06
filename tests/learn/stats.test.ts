/**
 * `ak learn stats` and the doctor's runs line: fixed span and judge rows in,
 * exact cost, latency, failure and status numbers out.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runLearn } from "../../src/learn/cli.ts";
import type { LearnConfig } from "../../src/learn/core/config.ts";
import { projectKey, type SpanRow } from "../../src/learn/core/trace.ts";
import { registerRoot } from "../../src/learn/memory/registry.ts";
import { learnStats, runsLine } from "../../src/learn/stats.ts";
import { gitRepo, scratch, testContext } from "./helpers.ts";

const NOW = Date.parse("2026-10-05T12:00:00.000Z");
const K1 = "aaaaaaaaaaaa";
const LOOPS = ["review", "memory", "skills", "hook"] as const;
const K2 = "bbbbbbbbbbbb";

function at(hoursAgo: number): string {
  return new Date(NOW - hoursAgo * 3_600_000).toISOString();
}

function spanRow(id: string, name: SpanRow["name"], fields: Partial<SpanRow> = {}): SpanRow {
  return {
    v: 1,
    trace_id: "4bf92f3577b34da6a3ce929d0e0e4736",
    span_id: id.padEnd(16, "0"),
    parent_span_id: null,
    name,
    loop: LOOPS.find((loop) => name.startsWith(`${loop}.`)) ?? "hook",
    project_key: null,
    trigger: "cli",
    start: at(1),
    duration_ms: 0,
    status: "ok",
    reason: null,
    judge: { calls: 0, failures: 0, cost_usd: 0, cost_known: true, input_tokens: 0, output_tokens: 0 },
    attrs: {},
    commit: null,
    ...fields,
  };
}

function judgeRow(
  runId: string | null,
  loop: string,
  role: string,
  outcome: string,
  ms: number,
  cost: number | null,
  hoursAgo = 1,
) {
  return {
    at: at(hoursAgo),
    call_id: "a2668a55-0000-4000-8000-000000000000",
    run_id: runId === null ? null : runId.padEnd(16, "0"),
    loop,
    role,
    outcome,
    duration_ms: ms,
    total_cost_usd: cost,
    stderr_tail: "",
  };
}

function lines(rows: readonly unknown[]): string {
  return rows.map((row) => `${JSON.stringify(row)}\n`).join("");
}

/** The fixture: two projects, a tick with no project, one row of each source outside a 30-day window. */
function fixture(config: LearnConfig): void {
  mkdirSync(config.runtimeDir, { recursive: true });
  writeFileSync(
    join(config.runtimeDir, "spans.jsonl"),
    lines([
      spanRow("a1", "review.run", { project_key: K1, duration_ms: 100 }),
      spanRow("a2", "review.maintain", { parent_span_id: "a1".padEnd(16, "0"), project_key: K1, duration_ms: 80 }),
      spanRow("a3", "review.propose", { parent_span_id: "a1".padEnd(16, "0"), duration_ms: 7 }),
      spanRow("b1", "memory.tick", { trigger: "tick", duration_ms: 1000 }),
      spanRow("b2", "memory.reflect", {
        parent_span_id: "b1".padEnd(16, "0"),
        project_key: K2,
        status: "failed",
        reason: "no-judge-output",
        duration_ms: 300,
      }),
      spanRow("c1", "memory.episodes", { parent_span_id: "b1".padEnd(16, "0"), duration_ms: 5 }),
      spanRow("d1", "hook.session-start", { project_key: K1, trigger: "hook", duration_ms: 20 }),
      spanRow("d2", "hook.session-start", { project_key: K1, trigger: "hook", status: "nothing", duration_ms: 40 }),
      spanRow("f1", "review.run", { project_key: K1, start: at(40 * 24), duration_ms: 9999 }),
    ]) + "not json\n",
  );
  writeFileSync(
    join(config.runtimeDir, "judge-calls.jsonl"),
    lines([
      judgeRow("a2", "review", "pattern-maintainer", "ok", 500, 0.25),
      judgeRow("a2", "review", "pattern-maintainer", "error", 700, null),
      judgeRow("b2", "memory", "reflector", "ok", 1000, 0.5),
      judgeRow(null, "skills", "skill-scout", "unparseable", 200, 0.1),
      judgeRow("a2", "review", "pattern-maintainer", "ok", 50, 7, 40 * 24),
    ]),
  );
}

describe("learnStats", () => {
  test("exact tables over every project in the window", () => {
    const ctx = testContext();
    fixture(ctx.config);
    const report = learnStats(ctx.config, { now: NOW, days: 30, projectKey: null });
    expect(report.cost).toEqual([
      { loop: "memory", role: "reflector", calls: 1, cost_usd: 0.5, unknown_cost: 0 },
      { loop: "review", role: "pattern-maintainer", calls: 2, cost_usd: 0.25, unknown_cost: 1 },
      { loop: "skills", role: "skill-scout", calls: 1, cost_usd: 0.1, unknown_cost: 0 },
    ]);
    expect(report.latency.spans).toEqual([
      { name: "hook.session-start", count: 2, p50_ms: 20, p95_ms: 40 },
      { name: "memory.episodes", count: 1, p50_ms: 5, p95_ms: 5 },
      { name: "memory.reflect", count: 1, p50_ms: 300, p95_ms: 300 },
      { name: "memory.tick", count: 1, p50_ms: 1000, p95_ms: 1000 },
      { name: "review.maintain", count: 1, p50_ms: 80, p95_ms: 80 },
      { name: "review.propose", count: 1, p50_ms: 7, p95_ms: 7 },
      { name: "review.run", count: 1, p50_ms: 100, p95_ms: 100 },
    ]);
    expect(report.latency.judge).toEqual([
      { role: "pattern-maintainer", count: 2, p50_ms: 500, p95_ms: 700 },
      { role: "reflector", count: 1, p50_ms: 1000, p95_ms: 1000 },
      { role: "skill-scout", count: 1, p50_ms: 200, p95_ms: 200 },
    ]);
    expect(report.failures).toEqual([
      { role: "pattern-maintainer", outcome: "error", count: 1 },
      { role: "skill-scout", outcome: "unparseable", count: 1 },
    ]);
    expect(report.status).toEqual([
      { name: "hook.session-start", status: "nothing", count: 1 },
      { name: "hook.session-start", status: "ok", count: 1 },
      { name: "memory.episodes", status: "ok", count: 1 },
      { name: "memory.reflect", status: "failed", count: 1 },
      { name: "memory.tick", status: "ok", count: 1 },
      { name: "review.maintain", status: "ok", count: 1 },
      { name: "review.propose", status: "ok", count: 1 },
      { name: "review.run", status: "ok", count: 1 },
    ]);
    expect(report.retained).toEqual({
      spans: { oldest: at(40 * 24), reaches_past: false },
      judge: { oldest: at(40 * 24), reaches_past: false },
    });
  });

  test("a project filter keeps its spans, their unkeyed children, and the judge rows of those runs", () => {
    const ctx = testContext();
    fixture(ctx.config);
    const k1 = learnStats(ctx.config, { now: NOW, days: 30, projectKey: K1 });
    expect(k1.cost).toEqual([
      { loop: "review", role: "pattern-maintainer", calls: 2, cost_usd: 0.25, unknown_cost: 1 },
    ]);
    expect(k1.status.map((row) => row.name)).toEqual([
      "hook.session-start",
      "hook.session-start",
      "review.maintain",
      "review.propose",
      "review.run",
    ]);
    const k2 = learnStats(ctx.config, { now: NOW, days: 30, projectKey: K2 });
    expect(k2.cost).toEqual([{ loop: "memory", role: "reflector", calls: 1, cost_usd: 0.5, unknown_cost: 0 }]);
    expect(k2.status).toEqual([{ name: "memory.reflect", status: "failed", count: 1 }]);
  });

  test("a window that starts before the oldest retained row says it reaches past it", () => {
    const ctx = testContext();
    mkdirSync(ctx.config.runtimeDir, { recursive: true });
    writeFileSync(
      join(ctx.config.runtimeDir, "spans.1.jsonl"),
      lines([spanRow("a1", "review.run", { start: at(5 * 24) })]),
    );
    writeFileSync(join(ctx.config.runtimeDir, "spans.jsonl"), lines([spanRow("a2", "review.run")]));
    const report = learnStats(ctx.config, { now: NOW, days: 30, projectKey: null });
    expect(report.retained.spans).toEqual({ oldest: at(5 * 24), reaches_past: true });
    expect(learnStats(ctx.config, { now: NOW, days: 2, projectKey: null }).retained.spans.reaches_past).toBe(false);
  });

  test("empty input gives empty tables", () => {
    const report = learnStats(testContext().config, { now: NOW, days: 30, projectKey: null });
    expect(report).toMatchObject({
      cost: [],
      latency: { spans: [], judge: [] },
      failures: [],
      status: [],
      retained: { spans: { oldest: null, reaches_past: false }, judge: { oldest: null, reaches_past: false } },
    });
  });
});

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (line: string) => out.push(line), err: (line: string) => err.push(line) }, out, err };
}

describe("ak learn stats", () => {
  test("runs with no verb, prints the four tables, and --json prints the same report as one object", () => {
    const ctx = testContext();
    fixture(ctx.config);
    const text = capture();
    expect(runLearn(["stats"], { cwd: scratch(), io: text.io, env: ctx.env })).toBe(0);
    const printed = text.out.join("\n");
    for (const heading of [
      "Cost by loop and role",
      "Latency by span",
      "Latency by judge role",
      "Judge failures by role and outcome",
      "Span status",
    ])
      expect(printed).toContain(heading);
    const json = capture();
    expect(runLearn(["stats", "--json", "--days", "36500"], { cwd: scratch(), io: json.io, env: ctx.env })).toBe(0);
    const report = learnStats(ctx.config, { now: Date.now(), days: 36500, projectKey: null });
    const parsed: unknown = JSON.parse(json.out.join("\n"));
    expect(parsed).toMatchObject({
      window: { days: 36500 },
      retained: report.retained,
      cost: report.cost,
      latency: report.latency,
      failures: report.failures,
      status: report.status,
    });
  });

  test("--repo keys the filter from the repository's real root, including a subdirectory", () => {
    const ctx = testContext();
    const root = gitRepo(join(scratch(), "shop"));
    mkdirSync(join(root, "src"));
    const key = projectKey(ctx.config, root) ?? "";
    mkdirSync(ctx.config.runtimeDir, { recursive: true });
    writeFileSync(
      join(ctx.config.runtimeDir, "spans.jsonl"),
      lines([
        spanRow("a1", "review.run", { project_key: key, start: new Date().toISOString() }),
        spanRow("a2", "review.run", { project_key: K2, start: new Date().toISOString() }),
      ]),
    );
    const out = capture();
    expect(
      runLearn(["stats", "--repo", join(root, "src"), "--json"], { cwd: scratch(), io: out.io, env: ctx.env }),
    ).toBe(0);
    const parsed: unknown = JSON.parse(out.out.join("\n"));
    expect(parsed).toMatchObject({ status: [{ name: "review.run", status: "ok", count: 1 }] });
  });

  test("the text tables carry the fixture's numbers", () => {
    const ctx = testContext();
    fixture(ctx.config);
    const out = capture();
    expect(runLearn(["stats", "--days", "36500"], { cwd: scratch(), io: out.io, env: ctx.env })).toBe(0);
    const rows = out.out.map((line) => line.split(/\s+/).join(" "));
    // A 100-year window also takes in the 40-day-old rows: three maintainer calls, one of them $7.
    expect(rows).toContain("review pattern-maintainer 3 7.250000 1");
    expect(rows).toContain("pattern-maintainer 3 500 700");
    expect(rows).toContain("review.run 2 100 9999");
    expect(rows).toContain("pattern-maintainer error 1");
    expect(rows).toContain("hook.session-start nothing 1");
  });

  test("--help prints the usage; unknown flags, extra words, --json=value and a huge --days are usage errors", () => {
    const ctx = testContext();
    const help = capture();
    expect(runLearn(["stats", "--help"], { cwd: scratch(), io: help.io, env: ctx.env })).toBe(0);
    expect(help.out.join("\n")).toContain("stats [--repo PATH] [--days N] [--json]");
    for (const argv of [
      ["stats", "--dys", "7"],
      ["stats", "show", "extra"],
      ["stats", "--json=false"],
      ["stats", "--days", "36501"],
    ]) {
      const out = capture();
      expect(runLearn(argv, { cwd: scratch(), io: out.io, env: ctx.env })).toBe(2);
      expect(out.out).toEqual([]);
    }
  });

  test("--repo outside any repository is an error, not an empty report", () => {
    const ctx = testContext();
    const out = capture();
    expect(
      runLearn(["stats", "--repo", join(scratch(), "missing")], { cwd: scratch(), io: out.io, env: ctx.env }),
    ).toBe(1);
    expect(out.err.join("\n")).toContain("is not inside a git repository");
    expect(out.out).toEqual([]);
  });

  test("--repo naming no repository is told the registered roots nearest it", () => {
    const ctx = testContext();
    const repo = gitRepo(join(scratch(), "shop"));
    registerRoot(ctx.config, repo);
    const out = capture();
    expect(runLearn(["stats", "--repo", `${repo}x`], { cwd: scratch(), io: out.io, env: ctx.env })).toBe(1);
    expect(out.err).toEqual([
      `ak learn stats: --repo ${repo}x is not inside a git repository: unknown repository '${repo}x'; did you mean ${repo}?`,
    ]);
  });

  test("a bad or bare --days and a bare --repo are usage errors", () => {
    const ctx = testContext();
    const out = capture();
    expect(runLearn(["stats", "--days", "zero"], { cwd: scratch(), io: out.io, env: ctx.env })).toBe(2);
    expect(out.err.join("\n")).toContain("--days");
    expect(runLearn(["stats", "--days"], { cwd: scratch(), io: out.io, env: ctx.env })).toBe(2);
    expect(runLearn(["stats", "--repo"], { cwd: scratch(), io: out.io, env: ctx.env })).toBe(2);
  });

  test("other areas still need a verb", () => {
    const out = capture();
    expect(runLearn(["review"], { cwd: scratch(), io: out.io, env: testContext().env })).toBe(2);
    expect(out.err.join("\n")).toContain("ak learn review —");
  });
});

describe("doctor runs line", () => {
  test("counts spans of the last 24 hours by loop and status", () => {
    const ctx = testContext();
    fixture(ctx.config);
    expect(runsLine(ctx.config, NOW)).toBe(
      "  runs (24h)         8 spans: hook nothing 1, ok 1; memory failed 1, ok 2; review ok 3",
    );
    expect(runsLine(testContext().config, NOW)).toBe("  runs (24h)         0 spans");
  });
});
