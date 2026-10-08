/**
 * `ak learn stats`: what the learning runtime costs, how long it takes and
 * how its runs end, computed from the span file and the judge trace.
 *
 * Deterministic: no judge call and no network. Cost is the host-reported
 * figure or unknown, never estimated; unknown-cost calls are counted apart.
 * Rows are read from both retained generations, and a window that starts
 * before the oldest retained row says so instead of reporting a quiet total.
 */
import type { LearnConfig } from "./core/config.ts";
import type { LearnArea, LearnArgs, LearnContext } from "./core/context.ts";
import { flag } from "./core/context.ts";
import { judgeRows } from "./core/judge.ts";
import { mainRepoRoot } from "./core/paths.ts";
import { projectKey, spanRows, type SpanRow } from "./core/trace.ts";
import { unknownRepo } from "./memory/registry.ts";

const DAY_MS = 86_400_000;
const DEFAULT_DAYS = 30;
const MAX_DAYS = 36_500;
const STATS_FLAGS = ["repo", "days", "json"];
const USAGE = "stats [--repo PATH] [--days N] [--json]   the default verb; no judge call, nothing leaves the machine";

export interface Retention {
  /** The oldest retained row of this source, or null when there is none. */
  oldest: string | null;
  /** The window starts before `oldest`, so it reaches past what is retained (or past the first row ever written). */
  reaches_past: boolean;
}

export interface StatsReport {
  window: { days: number; since: string; until: string };
  retained: { spans: Retention; judge: Retention };
  cost: Array<{ loop: string; role: string; calls: number; cost_usd: number; unknown_cost: number }>;
  latency: {
    spans: Array<{ name: string; count: number; p50_ms: number; p95_ms: number }>;
    judge: Array<{ role: string; count: number; p50_ms: number; p95_ms: number }>;
  };
  /** Judge calls without a usable reply, per role and outcome; `ok` calls are counted in `cost`. */
  failures: Array<{ role: string; outcome: string; count: number }>;
  status: Array<{ name: string; status: string; count: number }>;
}

export interface StatsOptions {
  now: number;
  days: number;
  /** Only spans of this project (or under a span of it) and the judge rows of those runs; null for every row. */
  projectKey: string | null;
}

/** Nearest-rank percentile of an ascending list. */
function percentile(sorted: readonly number[], p: number): number {
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;
}

type NonEmpty<T> = [T, ...T[]];

/** Rows grouped by key, keys in sorted order; every group holds at least one row. */
function groups<T>(rows: readonly T[], key: (row: T) => string): Array<[string, NonEmpty<T>]> {
  const out = new Map<string, NonEmpty<T>>();
  for (const row of rows) {
    const group = out.get(key(row));
    if (group === undefined) out.set(key(row), [row]);
    else group.push(row);
  }
  return [...out].toSorted(([a], [b]) => a.localeCompare(b));
}

interface Latency {
  count: number;
  p50_ms: number;
  p95_ms: number;
}

function latency(durations: readonly number[]): Latency {
  const sorted = durations.toSorted((a, b) => a - b);
  return { count: sorted.length, p50_ms: percentile(sorted, 50), p95_ms: percentile(sorted, 95) };
}

function retention(oldest: string | null, since: number): Retention {
  return { oldest, reaches_past: oldest !== null && Date.parse(oldest) > since };
}

function oldestOf(times: readonly string[]): string | null {
  return times.toSorted()[0] ?? null;
}

/** The project a span belongs to: its own key, else its nearest ancestor's. */
function keyOf(row: SpanRow, byId: ReadonlyMap<string, SpanRow>): string | null {
  let current: SpanRow | undefined = row;
  for (let depth = 0; current !== undefined && depth < 16; depth += 1) {
    if (current.project_key !== null) return current.project_key;
    current = current.parent_span_id === null ? undefined : byId.get(current.parent_span_id);
  }
  return null;
}

export function learnStats(config: LearnConfig, options: StatsOptions): StatsReport {
  const since = options.now - options.days * DAY_MS;
  const inWindow = (iso: string) => {
    const t = Date.parse(iso);
    return Number.isFinite(t) && t >= since && t <= options.now;
  };
  const allSpans = spanRows(config);
  const allJudge = judgeRows(config);
  const byId = new Map(allSpans.map((row) => [row.span_id, row]));
  const spans = allSpans.filter(
    (row) => inWindow(row.start) && (options.projectKey === null || keyOf(row, byId) === options.projectKey),
  );
  const runIds = new Set(spans.map((row) => row.span_id));
  const judge = allJudge.filter(
    (row) => inWindow(row.at) && (options.projectKey === null || (row.run_id !== null && runIds.has(row.run_id))),
  );

  const cost = groups(judge, (row) => `${row.loop}\u0000${row.role}`).map(([, rows]) => {
    const known = rows.filter((row) => row.total_cost_usd !== null);
    const [first] = rows;
    return {
      loop: first.loop,
      role: first.role,
      calls: rows.length,
      cost_usd: Number(known.reduce((sum, row) => sum + (row.total_cost_usd ?? 0), 0).toFixed(6)),
      unknown_cost: rows.length - known.length,
    };
  });

  return {
    window: { days: options.days, since: new Date(since).toISOString(), until: new Date(options.now).toISOString() },
    retained: {
      spans: retention(oldestOf(allSpans.map((row) => row.start)), since),
      judge: retention(oldestOf(allJudge.map((row) => row.at)), since),
    },
    cost,
    latency: {
      spans: groups(spans, (row) => row.name).map(([name, rows]) => ({
        name,
        ...latency(rows.map((row) => row.duration_ms)),
      })),
      judge: groups(judge, (row) => row.role).map(([role, rows]) => ({
        role,
        ...latency(rows.map((row) => row.duration_ms)),
      })),
    },
    failures: groups(
      judge.filter((row) => row.outcome !== "ok"),
      (row) => `${row.role}\u0000${row.outcome}`,
    ).map(([, [first, ...rest]]) => ({
      role: first.role,
      outcome: first.outcome,
      count: rest.length + 1,
    })),
    status: groups(spans, (row) => `${row.name}\u0000${row.status}`).map(([, [first, ...rest]]) => ({
      name: first.name,
      status: first.status,
      count: rest.length + 1,
    })),
  };
}

/** The doctor's line: spans of the last 24 hours by loop and status. */
export function runsLine(config: LearnConfig, now = Date.now()): string {
  const rows = spanRows(config).filter((row) => {
    const t = Date.parse(row.start);
    return t >= now - DAY_MS && t <= now;
  });
  const label = `  ${"runs (24h)".padEnd(17)}  ${rows.length} ${rows.length === 1 ? "span" : "spans"}`;
  if (rows.length === 0) return label;
  const loops = groups(rows, (row) => row.loop).map(
    ([loop, loopRows]) =>
      `${loop} ${groups(loopRows, (row) => row.status)
        .map(([status, n]) => `${status} ${n.length}`)
        .join(", ")}`,
  );
  return `${label}: ${loops.join("; ")}`;
}

function table(
  title: string,
  header: readonly string[],
  rows: ReadonlyArray<ReadonlyArray<string | number>>,
): string[] {
  const cells = [header, ...rows.map((row) => row.map(String))];
  const widths = header.map((_, i) => Math.max(...cells.map((row) => (row[i] ?? "").length)));
  const line = (row: readonly string[]) =>
    row
      .map((cell, i) => cell.padEnd(widths[i] ?? 0))
      .join("  ")
      .trimEnd();
  return [title, line(header), ...(rows.length === 0 ? ["(none)"] : cells.slice(1).map(line)), ""];
}

function bound(name: string, r: Retention): string {
  return `${name} from ${r.oldest ?? "-"}${r.reaches_past ? " (the window reaches past the oldest retained row)" : ""}`;
}

function render(report: StatsReport): string[] {
  return [
    `window ${report.window.since} .. ${report.window.until} (${report.window.days} days); ${bound("spans", report.retained.spans)}; ${bound("judge", report.retained.judge)}`,
    "",
    ...table(
      "Cost by loop and role (host-reported USD)",
      ["loop", "role", "calls", "cost_usd", "unknown_cost"],
      report.cost.map((row) => [row.loop, row.role, row.calls, row.cost_usd.toFixed(6), row.unknown_cost]),
    ),
    ...table(
      "Latency by span (ms)",
      ["span", "count", "p50", "p95"],
      report.latency.spans.map((row) => [row.name, row.count, row.p50_ms, row.p95_ms]),
    ),
    ...table(
      "Latency by judge role (ms)",
      ["role", "count", "p50", "p95"],
      report.latency.judge.map((row) => [row.role, row.count, row.p50_ms, row.p95_ms]),
    ),
    ...table(
      "Judge failures by role and outcome",
      ["role", "outcome", "count"],
      report.failures.map((row) => [row.role, row.outcome, row.count]),
    ),
    ...table(
      "Span status",
      ["span", "status", "count"],
      report.status.map((row) => [row.name, row.status, row.count]),
    ),
  ];
}

function show(args: LearnArgs, ctx: LearnContext): number {
  if (args.flags.has("help")) {
    ctx.io.out(`ak learn ${USAGE}`);
    return 0;
  }
  const unknown = [...args.flags.keys()].filter((name) => !STATS_FLAGS.includes(name));
  if (unknown.length > 0 || args.positional.length > 0) {
    ctx.io.err(
      `ak learn stats: unexpected ${[...unknown.map((name) => `--${name}`), ...args.positional].join(" ")}; usage: ak learn ${USAGE}`,
    );
    return 2;
  }
  if (
    args.flags.get("days") === true ||
    args.flags.get("repo") === true ||
    (args.flags.has("json") && args.flags.get("json") !== true)
  ) {
    ctx.io.err(`ak learn stats: --days and --repo each want a value, --json takes none; usage: ak learn ${USAGE}`);
    return 2;
  }
  const rawDays = flag(args, "days");
  const days = rawDays === undefined ? DEFAULT_DAYS : Number(rawDays);
  if (!Number.isInteger(days) || days <= 0 || days > MAX_DAYS) {
    ctx.io.err(`ak learn stats: --days wants a whole number of days from 1 to ${MAX_DAYS}, got ${rawDays ?? ""}`);
    return 2;
  }
  let key: string | null = null;
  const repo = flag(args, "repo");
  if (repo !== undefined) {
    const root = mainRepoRoot(repo);
    if (root === null) {
      ctx.io.err(`ak learn stats: --repo ${repo} is not inside a git repository: ${unknownRepo(ctx.config, repo)}`);
      return 1;
    }
    key = projectKey(ctx.config, root);
    if (key === null) {
      ctx.io.err("ak learn stats: the install salt is unreadable, so no project key can be computed");
      return 1;
    }
  }
  const report = learnStats(ctx.config, { now: Date.now(), days, projectKey: key });
  if (args.flags.has("json")) ctx.io.out(JSON.stringify(report, null, 2));
  else for (const line of render(report)) ctx.io.out(line);
  return 0;
}

export const statsArea: LearnArea = {
  summary: "cost, latency, failure and status tables from the span file and judge trace",
  default: "show",
  verbs: {
    show: {
      usage: USAGE,
      run: show,
    },
  },
};
