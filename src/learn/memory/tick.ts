/**
 * The memory loop's scheduler. Every tick: take the runtime-wide lock,
 * discover projects from claude-mem, capture offline worker session stores,
 * and for each project active in the last seven days record new episodes,
 * then run whichever jobs are due. Failures are logged, never raised.
 *
 * The scheduled path never spawns git in a repository, and opens one kind of
 * file inside one: the `.git` pointer of a linked worktree, read to place a
 * worker session no registered root or recorded worktree contains. Everything
 * else is stat only, because under a macOS scheduler an open inside a protected
 * folder blocks on the privacy prompt and ignores every timeout. Git runs only
 * in the ledgers, which live under the config directory.
 */
import { mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import Ajv from "ajv";
import { repoAllowed } from "../core/config.ts";
import type { LearnContext } from "../core/context.ts";
import { acquireLock, Ledger } from "../core/ledger.ts";
import { tickLogPath } from "../core/paths.ts";
import { gateText, nowIso, nowMs, readText, todayLocal } from "../core/store.ts";
import { appendCapped, span, type SpanReason, type SpanStatus, type SpanTrigger } from "../core/trace.ts";
import { loadEvents } from "../review/events.ts";
import { deferredObservationIds } from "../review/ingest.ts";
import { reviewLedger, reviewLedgerDir } from "../review/ledger.ts";
import { ClaudeMemSource } from "../sources/claude-mem.ts";
import {
  CAPTURE_WINDOW_MS,
  type CapturedSession,
  ProjectMemorySource,
  scanWorkerSessions,
  WorkerSessionSource,
  workerHomes,
  workerRootResolver,
} from "../sources/worker-sessions.ts";
import { consolidate, readyEpisodes } from "./consolidate.ts";
import { deep } from "./deep.ts";
import { buildEpisodes, type EpisodeEvent, unconsolidatedEpisodes } from "./episodes.ts";
import { appendRun, ensureMemoryLedger, logLine, type MemoryState, memoryDir, readState } from "./ledger.ts";
import { backfill, reflect, unscreenedIds } from "./reflect.ts";
import { discoverProjects, discoverySince, readRegistry, readWorktrees } from "./registry.ts";

export type Job = "reflect" | "backfill" | "nightly" | "weekly";
export const JOBS: readonly Job[] = ["reflect", "backfill", "nightly", "weekly"];

export const ACTIVE_DAYS = 7;
export const REFLECT_MAX_GAP_MS = 6 * 3600 * 1000;
export const NIGHTLY_BACKLOG = 25;
export const WEEK_MS = 7 * 86_400_000;
export const FAILURE_BACKOFF_MIN_MS = 3_600_000;
export const FAILURE_BACKOFF_MAX_MS = 24 * FAILURE_BACKOFF_MIN_MS;

export interface DecideInput {
  state: MemoryState;
  /** The machine's local clock: the nightly hour and the calendar day are local. */
  now: Date;
  idleS: number;
  newTokens: number;
  newObs: number;
  /** Observations at or below the reflect watermark that no accepted run was shown and a consumer waits on. */
  unscreened: number;
  /** Unconsolidated episodes with screened observations to show; one still waiting on a screen is not counted. */
  unconsolidated: number;
  /** `all` or one job forces it, even on a muted project. */
  force?: Job | "all" | null;
}

export interface Thresholds {
  idleS: number;
  reflectTokens: number;
  nightlyHour: number;
}

function backoffElapsed(state: MemoryState, job: "reflect" | "nightly", now: number): boolean {
  const failures = job === "reflect" ? state.reflect_failures : state.nightly_failures;
  const attempted = job === "reflect" ? state.last_reflect_attempt : state.last_nightly_attempt;
  if (!failures || attempted === undefined) return true;
  const delay = Math.min(FAILURE_BACKOFF_MIN_MS * 2 ** (failures - 1), FAILURE_BACKOFF_MAX_MS);
  return now - attempted >= delay;
}

/**
 * Which jobs are due. Pure.
 *
 * | Job | Due when |
 * |---|---|
 * | reflect | idle and new discovery tokens reach the threshold, or any new observation 6h after the last reflect |
 * | backfill | idle and an observation an episode or review ingest waits on is unscreened; one batch per tick |
 * | nightly | past the nightly hour, not yet run today, one ready episode; or a backlog of 25 ready while idle |
 * | weekly | idle and a week since the last |
 *
 * A failed or rejected reflect, and a failed nightly, hold that job back for
 * 1h, doubling per consecutive failure up to 24h. The backfill shares the
 * reflect backoff. A forced job ignores it.
 */
export function decide(input: DecideInput, thresholds: Thresholds): Job[] {
  if (input.force) return input.force === "all" ? [...JOBS] : [input.force];
  if (input.state.muted) return [];
  const due: Job[] = [];
  const idle = input.idleS >= thresholds.idleS;
  const now = input.now.getTime();
  const lastReflect = input.state.last_reflect ?? 0;
  if (
    backoffElapsed(input.state, "reflect", now) &&
    ((idle && input.newTokens >= thresholds.reflectTokens) ||
      (input.newObs > 0 && now - lastReflect >= REFLECT_MAX_GAP_MS))
  )
    due.push("reflect");
  if (idle && input.unscreened > 0 && backoffElapsed(input.state, "reflect", now)) due.push("backfill");
  const today = todayLocal(input.now);
  if (
    backoffElapsed(input.state, "nightly", now) &&
    ((input.now.getHours() >= thresholds.nightlyHour &&
      (input.state.last_nightly ?? "") < today &&
      input.unconsolidated >= 1) ||
      (input.unconsolidated >= NIGHTLY_BACKLOG && idle))
  ) {
    due.push("nightly");
  }
  if (idle && now - (input.state.last_weekly ?? 0) >= WEEK_MS) due.push("weekly");
  return due;
}

/**
 * The run-log fields a job span reads, typed as the jobs write them (episode
 * and lesson lists are arrays of ids). The log itself stays open.
 */
interface RunRow {
  status: "ok" | "rejected" | "failed";
  reason?: string;
  dropped_by_provenance?: number;
  dropped_by_redaction?: number;
  security_notes?: number;
  tokens_in?: number;
  tokens_out?: number;
  quarantined?: string[];
  episodes?: string[];
  new?: string[];
  created?: string[];
  superseded?: string[];
  proposals?: string[];
}

const COUNT = { type: "integer", minimum: 0 };
const IDS = { type: "array", items: { type: "string" } };
let runRowValidator: ((row: unknown) => row is RunRow) | undefined;

/** Compiled on first use: hooks import this module and never read a run log. */
function validateRunRow(row: unknown): row is RunRow {
  runRowValidator ??= new Ajv({ strict: false }).compile<RunRow>(RUN_ROW_SCHEMA);
  return runRowValidator(row);
}

const RUN_ROW_SCHEMA = {
  type: "object",
  required: ["status"],
  properties: {
    status: { enum: ["ok", "rejected", "failed"] },
    reason: { type: "string" },
    dropped_by_provenance: COUNT,
    dropped_by_redaction: COUNT,
    security_notes: COUNT,
    tokens_in: COUNT,
    tokens_out: COUNT,
    quarantined: IDS,
    episodes: IDS,
    new: IDS,
    created: IDS,
    superseded: IDS,
    proposals: IDS,
  },
  additionalProperties: true,
};

/** The run log's rows a span can read; a line that fails the shape is skipped, since telemetry never fails a job. */
function runLog(ledger: Ledger): RunRow[] {
  const rows: RunRow[] = [];
  for (const line of readText(ledger.path("runs.jsonl")).split("\n")) {
    if (line.trim() === "") continue;
    try {
      const row: unknown = JSON.parse(line);
      if (validateRunRow(row)) rows.push(row);
    } catch {
      continue;
    }
  }
  return rows;
}

/** A run row's counts as span attributes: numbers as they are, id lists by length. */
function runAttrs(row: RunRow): Array<[string, number | undefined]> {
  return [
    ["dropped_by_provenance", row.dropped_by_provenance],
    ["dropped_by_redaction", row.dropped_by_redaction],
    ["security_notes", row.security_notes],
    ["tokens_in", row.tokens_in],
    ["tokens_out", row.tokens_out],
    ["quarantined", row.quarantined?.length],
    ["episodes", (row.episodes ?? row.new)?.length],
    ["lessons_created", row.created?.length],
    ["lessons_superseded", row.superseded?.length],
    ["proposals", row.proposals?.length],
  ];
}

function spanOutcome(row: RunRow | undefined, dryRun: boolean): [SpanStatus, SpanReason | null] {
  if (row === undefined) return [dryRun ? "dry-run" : "nothing", null];
  if (row.status === "rejected") return ["rejected", "gate-rejected"];
  if (row.status === "failed") return ["failed", row.reason === "no judge output" ? "no-judge-output" : "error"];
  return ["ok", null];
}

/**
 * Run one memory job as its span. Every job records its outcome as one row in
 * the run log, so the span reads its status and counts from the row the job
 * appended rather than from its prose summary; a job that appended none had
 * nothing to do (or was a dry run).
 */
function jobSpan(
  ctx: LearnContext,
  name: "memory.episodes" | "memory.reflect" | "memory.backfill" | "memory.nightly" | "memory.weekly",
  trigger: SpanTrigger,
  ledger: Ledger,
  root: string,
  body: (ctx: LearnContext) => string,
): string {
  return span(ctx, name, trigger, (inner) => {
    inner.span?.project(root);
    const before = runLog(ledger).length;
    const head = ledger.head();
    const text = body(inner);
    const row = runLog(ledger).slice(before).at(-1);
    const [status, reason] = spanOutcome(row, ctx.config.dryRun);
    inner.span?.status(status, reason);
    for (const [attr, value] of row === undefined ? [] : runAttrs(row)) {
      if (value !== undefined) inner.span?.attr(attr, value);
    }
    const after = ledger.head();
    if (after !== head) inner.span?.commit(after);
    return text;
  });
}

/** The review ledger's raw events, when the review loop has one. Never creates it. */
function reviewEvents(ctx: LearnContext, root: string): EpisodeEvent[] {
  const ledger = new Ledger(reviewLedgerDir(ctx.config, root));
  return ledger.initialized ? loadEvents(ledger) : [];
}

/**
 * One project's episodes and due jobs. Takes the memory ledger's lock; a
 * concurrent run on the same project returns without doing anything.
 */
export function runProject(
  ctx: LearnContext,
  claude: ClaudeMemSource | null,
  root: string,
  memProject: string,
  options: { job?: Job | "all"; force?: boolean; captured?: readonly CapturedSession[]; capturedSince?: number } = {},
): string[] {
  const dryRun = ctx.config.dryRun;
  const ledger = dryRun ? new Ledger(memoryDir(ctx.config, root)) : ensureMemoryLedger(memoryDir(ctx.config, root));
  const release = dryRun ? () => undefined : ledger.tryLock();
  if (release === null) return ["another run holds this project's memory ledger"];
  const trigger: SpanTrigger = options.force === true ? "force" : "tick";
  try {
    const out: string[] = [];
    let captured = 0;
    let refreshed = 0;
    const captures = WorkerSessionSource.open(ledger);
    try {
      ({ observations: captured, sessions: refreshed } = captures.capture(options.captured ?? [], {
        dryRun,
        sinceMs: options.capturedSince,
      }));
      if ((options.captured?.length ?? 0) > 0) out.push(`worker observations +${captured}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      out.push(`worker capture failed: ${message}`);
      if (!dryRun) logLine(ledger, `worker capture failed: ${message}`);
    }
    const source = new ProjectMemorySource(claude, captures);
    try {
      out.push(
        jobSpan(ctx, "memory.episodes", trigger, ledger, root, () => {
          const fresh = buildEpisodes(source, ledger, memProject, reviewEvents(ctx, root), { dryRun });
          if ((fresh.length > 0 || captured > 0) && !dryRun) {
            appendRun(ledger, {
              job: "episodes",
              status: "ok",
              new: fresh.map((episode) => episode.sid),
              worker_observations: captured,
            });
            ledger.commit(`episodes +${fresh.length}, worker observations +${captured}`);
          } else if (refreshed > 0 && !dryRun) ledger.commit(`worker sessions refreshed ${refreshed}`);
          return `episodes +${fresh.length}`;
        }),
      );
    } catch (error) {
      out.push(`episodes failed: ${(error as Error).message}`);
      if (!dryRun) logLine(ledger, `episodes failed: ${(error as Error).message}`);
    }
    const state = readState(ledger);
    const lastActivity = source.lastActivityMs(memProject);
    if (!lastActivity)
      return [...out, `no observations under project '${memProject}'; check the registry and worker-session homes`];
    const idleS = (nowMs() - lastActivity) / 1000;
    const native = source.newTokensSince(memProject, state.last_obs_id_reflected ?? 0);
    const workers = source.capturedTokensSince(memProject, state.last_worker_obs_id_reflected ?? 0);
    const newTokens = native.tokens + workers.tokens;
    const newObs = native.count + workers.count;
    const existingReview = new Ledger(reviewLedgerDir(ctx.config, root));
    const deferred = deferredObservationIds(existingReview);
    const unscreened = unscreenedIds(source, ledger, deferred).length;
    const unconsolidated = readyEpisodes(source, ledger, unconsolidatedEpisodes(ledger)).size;
    const force = options.force === true ? (options.job ?? "all") : null;
    let due = decide(
      { state, now: new Date(), idleS, newTokens, newObs, unscreened, unconsolidated, force },
      ctx.config,
    );
    if (options.job !== undefined && options.force !== true)
      due = due.filter((job) => options.job === "all" || options.job === job);
    const dueText = due.length > 0 ? due.join(",") : "none";
    out.push(
      `idle ${Math.floor(idleS)}s new_tokens ${newTokens} new_obs ${newObs} unscreened ${unscreened} unconsolidated ${unconsolidated} due ${dueText}`,
    );
    const runners: Record<Job, (ctx: LearnContext) => string> = {
      reflect: (job) => reflect(job, source, ledger, memProject, trigger),
      backfill: (job) => backfill(job, source, ledger, memProject, deferred, trigger),
      // Forwarding findings seeds the review ledger when it is missing; compaction only touches one that exists.
      nightly: (job) => consolidate(job, source, ledger, root, dryRun ? null : reviewLedger(job.config, root), trigger),
      weekly: (job) => deep(job, ledger, root, existingReview.initialized ? existingReview : null, trigger),
    };
    for (const job of JOBS) {
      if (!due.includes(job)) continue;
      try {
        out.push(jobSpan(ctx, `memory.${job}`, trigger, ledger, root, runners[job]));
      } catch (error) {
        const err = error as Error;
        out.push(`${job} failed: ${err.message}`);
        if (!dryRun)
          logLine(ledger, `${job} failed: ${err.message}\n\`\`\`\n${(err.stack ?? "").slice(-1500)}\n\`\`\``);
      }
    }
    return out;
  } finally {
    release();
  }
}

function tickLog(ctx: LearnContext, line: string): void {
  ctx.io.out(line);
  if (ctx.config.dryRun) return;
  const path = tickLogPath(ctx.config);
  if (!appendCapped(path, gateText(ctx.config.runtimeDir, path, `${line}\n`), ctx.config.traceMaxBytes))
    ctx.io.err(`tick: could not write ${path}`);
}

/**
 * The scheduled tick over every registered project active in the last seven
 * days, or over `only` (a main repo root already resolved by the caller).
 * Returns 0 in every case, including a held lock: the loser exits quietly.
 */
export function tick(ctx: LearnContext, options: { only?: string; job?: Job | "all"; force?: boolean } = {}): number {
  return span(ctx, "memory.tick", options.force === true ? "force" : "tick", (inner) => tickRun(inner, options));
}

function tickRun(ctx: LearnContext, options: { only?: string; job?: Job | "all"; force?: boolean }): number {
  mkdirSync(ctx.config.runtimeDir, { recursive: true });
  const release = acquireLock(join(ctx.config.runtimeDir, ".tick.lock"));
  if (release === null) {
    ctx.span?.status("locked", "lock-held");
    ctx.io.out("tick: another run holds the lock");
    return 0;
  }
  try {
    const source = ClaudeMemSource.open(ctx.config.memDb);
    try {
      tickLog(ctx, `== ${nowIso()} tick${ctx.config.dryRun ? " DRY RUN" : ""}`);
      if (source === null)
        tickLog(ctx, `observer: claude-mem database not found at ${ctx.config.memDb}; worker capture continues`);
      // The repo scope gates the scheduled pass; `only` is an explicit `memory run --repo` and is not gated.
      const allowed = (root: string) => options.only !== undefined || repoAllowed(ctx.config, root);
      const registry =
        options.only === undefined && source !== null
          ? discoverProjects(
              ctx.config,
              source.toolUseCwds(discoverySince()),
              (warning) => tickLog(ctx, warning),
              allowed,
            )
          : readRegistry(ctx.config);
      const cutoff = nowMs() - ACTIVE_DAYS * 86_400_000;
      let projects = 0;
      const capturedSince = nowMs() - CAPTURE_WINDOW_MS;
      const stores = new Map<string, WorkerSessionSource | null>();
      const stored = (root: string) => {
        if (!stores.has(root)) {
          try {
            stores.set(root, WorkerSessionSource.open(new Ledger(memoryDir(ctx.config, root))));
          } catch {
            stores.set(root, null);
          }
        }
        return stores.get(root) ?? null;
      };
      const scan = scanWorkerSessions(workerHomes(ctx.env), workerRootResolver(registry, readWorktrees(ctx.config)), {
        sinceMs: capturedSince,
        warn: (warning) => tickLog(ctx, warning),
        wanted: (root) => (options.only === undefined || root === options.only) && allowed(root),
        stored,
      });
      if (scan.unmatched > 0)
        tickLog(ctx, `worker sessions skipped: ${scan.unmatched} outside every registered root and worktree`);
      for (const entry of Object.values(registry)) {
        if (options.only !== undefined && entry.root !== options.only) continue;
        if (!allowed(entry.root)) continue;
        const workerSessions = scan.sessions.get(entry.root) ?? [];
        if (
          options.only === undefined &&
          Math.max(source?.lastActivityMs(entry.mem_project) ?? 0, scan.activity.get(entry.root) ?? 0) < cutoff
        )
          continue;
        const name = entry.mem_project || basename(entry.root);
        projects += 1;
        let lines: string[];
        try {
          lines = runProject(ctx, source, entry.root, entry.mem_project, {
            job: options.job,
            force: options.force,
            captured: workerSessions,
            capturedSince,
          });
        } catch (error) {
          lines = [`failed: ${(error as Error).message}`];
        }
        for (const line of lines) tickLog(ctx, `${name}: ${line}`);
      }
      ctx.span?.attr("projects", projects);
      if (source === null && projects === 0) ctx.span?.status("failed", "no-source");
      else if (ctx.config.dryRun) ctx.span?.status("dry-run");
      else if (projects === 0) ctx.span?.status("nothing");
    } finally {
      source?.close();
    }
  } catch (error) {
    ctx.span?.status("failed", "error");
    ctx.io.err(`tick failed: ${(error as Error).message}`);
  } finally {
    release();
  }
  return 0;
}
