/**
 * Episode memory: ended claude-mem sessions become `episodes.jsonl` rows,
 * deterministically, each with a priority. Rows are only ever appended; when a
 * resumed session gains observations, its newer row supersedes the older one.
 * Consolidation is recorded beside them in `raw/consolidated.jsonl` as
 * `{sid, run, obs, obs_id}`, also append-only; a rollback appends the runs it
 * undid to `raw/undone-runs.jsonl`, and their marks stop counting.
 *
 *   priority = 0.30*C + 0.20*F + 0.15*R + 0.10*T + 0.10*N + 0.15*A
 *
 * C corrections (cap 3), F failure signals (cap 5), R review events (cap 5),
 * T tokens over the most tokens of any episode in the 30-day window, N the
 * share of modified files no earlier episode touched, A exp(-age_days / 14).
 */
import { appendJsonl, nowIso, nowMs, readJsonl } from "../core/store.ts";
import type { Ledger } from "../core/ledger.ts";
import { type ClaudeMemSource, jsonList, type SessionRow } from "../sources/claude-mem.ts";
import { isFailureObservation } from "./ledger.ts";

export interface Episode {
  sid: string;
  platform: string;
  started: number;
  ended: number;
  prompts: number;
  obs: number;
  tokens: number;
  files_modified: string[];
  request: string | null;
  completed: boolean;
  failure_signals: number;
  corrections: number;
  review_events: number;
  priority: number;
  /** Written by ledgers from before `raw/consolidated.jsonl`; read, never written. */
  consolidated_run?: string;
}

export const CONSOLIDATED_FILE = "raw/consolidated.jsonl";
export const UNDONE_RUNS_FILE = "raw/undone-runs.jsonl";

export interface ConsolidationMark {
  sid: string;
  run: string;
  /** How many of the session's observations sit at or below `obs_id`; the episode revision's count on older marks. */
  obs?: number;
  /** Highest observation id this run consumed. Absent on older marks, which consumed from the start. */
  obs_id?: number;
  ts?: string;
}

/** The fields of a review event an episode reads. Structural, so any review-ledger row fits. */
export interface EpisodeEvent {
  source?: string;
  ts?: string | null;
  obs_id?: number | null;
}

/** The review-event source for a user correction captured by the prompt hook. */
export const CORRECTION_SOURCE = "correction";

/** The review-event source this loop writes; never counted back into an episode. */
export const MEMORY_SOURCE = "learn-memory";

/** An active session with no activity for this long is treated as ended. */
export const STALE_ACTIVE_MS = 6 * 3600 * 1000;
const WINDOW_MS = 30 * 86_400_000;
const DAY_MS = 86_400_000;

function isoToMs(ts: string | undefined): number | null {
  if (typeof ts !== "string" || ts.length < 19) return null;
  const ms = Date.parse(`${ts.slice(0, 19)}Z`);
  return Number.isNaN(ms) ? null : ms;
}

export function rawEpisode(
  source: ClaudeMemSource,
  session: SessionRow,
  events: readonly EpisodeEvent[],
): Omit<Episode, "priority"> | null {
  const sid = session.memory_session_id;
  const obs = source.sessionObservations(sid);
  if (obs.length === 0) return null;
  const files = new Set<string>();
  for (const row of obs) for (const path of jsonList(row.files_modified)) files.add(path);
  // claude-mem fills observations.files_modified on a small share of rows; tool use fills the rest.
  for (const path of source.editedFiles(sid)) files.add(path);
  const ended = session.completed_at_epoch ?? Math.max(...obs.map((row) => row.created_at_epoch));
  const summary = source.latestSummary(sid);
  const obsIds = new Set(obs.map((row) => row.id));
  const corrections = events.filter((event) => {
    if (event.source !== CORRECTION_SOURCE) return false;
    const at = isoToMs(event.ts ?? undefined) ?? -1;
    return at >= session.started_at_epoch && at <= ended;
  }).length;
  const reviewEvents = events.filter(
    (event) => typeof event.obs_id === "number" && obsIds.has(event.obs_id) && event.source !== MEMORY_SOURCE,
  ).length;
  return {
    sid,
    platform: session.platform_source,
    started: session.started_at_epoch,
    ended,
    prompts: source.promptCount(session.id),
    obs: obs.length,
    tokens: obs.reduce((sum, row) => sum + (row.discovery_tokens ?? 0), 0),
    files_modified: [...files].sort(),
    request: summary?.request ?? null,
    completed: (summary?.completed ?? "").trim() !== "",
    failure_signals: obs.filter(isFailureObservation).length,
    corrections,
    review_events: reviewEvents,
  };
}

function decay(ageDays: number, eFoldDays = 14): number {
  return Math.exp(-ageDays / eFoldDays);
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/** Fill `priority`. T is relative to the most tokens in the 30-day window; N is against earlier episodes' files. */
export function score(
  fresh: ReadonlyArray<Omit<Episode, "priority">>,
  existing: readonly Episode[],
  now: number,
): Episode[] {
  const inWindow = [...existing.filter((episode) => now - episode.ended <= WINDOW_MS), ...fresh];
  const maxTokens = Math.max(...inWindow.map((episode) => episode.tokens), 0) || 1;
  const seen = new Set<string>();
  for (const episode of existing) for (const path of episode.files_modified) seen.add(path);
  const scored = new Map<string, number>();
  for (const episode of [...fresh].sort((a, b) => a.started - b.started)) {
    const files = episode.files_modified;
    const novel = files.filter((path) => !seen.has(path)).length;
    const n = files.length > 0 ? novel / files.length : 0;
    for (const path of files) seen.add(path);
    const ageDays = Math.max(0, (now - episode.ended) / DAY_MS);
    scored.set(
      episode.sid,
      round4(
        (0.3 * Math.min(episode.corrections, 3)) / 3 +
          (0.2 * Math.min(episode.failure_signals, 5)) / 5 +
          (0.15 * Math.min(episode.review_events, 5)) / 5 +
          (0.1 * episode.tokens) / maxTokens +
          0.1 * n +
          0.15 * decay(ageDays),
      ),
    );
  }
  return fresh.map((episode) => ({ ...episode, priority: scored.get(episode.sid)! }));
}

export function loadEpisodes(ledger: Ledger): Episode[] {
  const latest = new Map<string, Episode>();
  for (const episode of readJsonl<Episode>(ledger.path("episodes.jsonl"))) latest.set(episode.sid, episode);
  return [...latest.values()];
}

/** Runs a rollback undid. Their consolidation marks no longer count. */
export function undoneRuns(ledger: Ledger): Set<string> {
  return new Set(readJsonl<{ run: string }>(ledger.path(UNDONE_RUNS_FILE)).map((row) => row.run));
}

/** Session ids consolidated by a run that still stands. */
export function consolidatedSids(ledger: Ledger): Set<string> {
  const undone = undoneRuns(ledger);
  const rows = readJsonl<Episode>(ledger.path("episodes.jsonl"));
  const latest = new Map(loadEpisodes(ledger).map((episode) => [episode.sid, episode]));
  const revisions = new Map<string, number>();
  for (const row of rows) revisions.set(row.sid, (revisions.get(row.sid) ?? 0) + 1);
  const marks: ConsolidationMark[] = [
    ...rows.flatMap((row) => (row.consolidated_run ? [{ sid: row.sid, run: row.consolidated_run, obs: row.obs }] : [])),
    ...readJsonl<ConsolidationMark>(ledger.path(CONSOLIDATED_FILE)),
  ];
  const consolidated = new Set<string>();
  for (const mark of marks) {
    if (undone.has(mark.run)) continue;
    const episode = latest.get(mark.sid);
    if (episode === undefined) continue;
    if (mark.obs !== undefined ? mark.obs >= episode.obs : revisions.get(mark.sid) === 1) consolidated.add(mark.sid);
  }
  return consolidated;
}

/** Episodes no standing run has consolidated, in file order. */
export function unconsolidatedEpisodes(ledger: Ledger): Episode[] {
  const done = consolidatedSids(ledger);
  return loadEpisodes(ledger).filter((episode) => !done.has(episode.sid));
}

/** Per session, the highest observation id a standing run consumed. Sessions with only older marks are absent. */
export function consumedObsIds(ledger: Ledger): Map<string, number> {
  const undone = undoneRuns(ledger);
  const consumed = new Map<string, number>();
  for (const mark of readJsonl<ConsolidationMark>(ledger.path(CONSOLIDATED_FILE))) {
    if (mark.obs_id === undefined || undone.has(mark.run)) continue;
    consumed.set(mark.sid, Math.max(consumed.get(mark.sid) ?? 0, mark.obs_id));
  }
  return consumed;
}

/** Record that `run` consolidated these sessions up to the given observation. Appends; never rewrites. */
export function markConsolidated(
  ledger: Ledger,
  consumed: ReadonlyMap<string, { obs: number; obs_id: number }>,
  run: string,
): void {
  const ts = nowIso();
  appendJsonl(
    ledger.path(CONSOLIDATED_FILE),
    [...consumed].map(([sid, mark]) => ({ sid, run, ...mark, ts })),
  );
}

/** Append new or observation-refreshed episodes, oldest first. Returns the appended rows. */
export function buildEpisodes(
  source: ClaudeMemSource,
  ledger: Ledger,
  memProject: string,
  events: readonly EpisodeEvent[],
  options: { now?: number; days?: number; dryRun?: boolean } = {},
): Episode[] {
  const now = options.now ?? nowMs();
  const existing = loadEpisodes(ledger);
  const known = new Map(existing.map((episode) => [episode.sid, episode]));
  const raw: Array<Omit<Episode, "priority">> = [];
  for (const session of source.sessions(memProject, now - (options.days ?? 30) * DAY_MS, now - STALE_ACTIVE_MS)) {
    const previous = known.get(session.memory_session_id);
    if (previous !== undefined && session.observation_count <= previous.obs) continue;
    const episode = rawEpisode(source, session, events);
    if (episode === null) continue;
    if (previous === undefined || episode.obs > previous.obs) raw.push(episode);
  }
  const refreshed = new Set(raw.map((episode) => episode.sid));
  const fresh = score(
    raw,
    existing.filter((episode) => !refreshed.has(episode.sid)),
    now,
  );
  if (fresh.length > 0 && options.dryRun !== true) {
    appendJsonl(
      ledger.path("episodes.jsonl"),
      [...fresh].sort((a, b) => a.started - b.started),
    );
  }
  return fresh;
}
