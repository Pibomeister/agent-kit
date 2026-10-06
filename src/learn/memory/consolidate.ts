/**
 * Nightly consolidation: stratified episodes become typed lessons, plus review
 * events for the review loop. One judge call (role `consolidator`).
 *
 * The batch is 40% failures and corrections, 40% successful repeats and 20%
 * novelty, by priority within each stratum. A failure episode is paired with
 * the later completed episode on the same files (contrastive replay). Only the
 * episodes that fit under the input cap reach the judge, so only they are
 * marked consolidated and only their ids pass the evidence gate.
 *
 * An episode shows only observations inside an accepted reflect or backfill
 * run's exact id range and, once a run has consumed it, only those after the
 * highest id that run consumed. An episode with none to show waits, and so
 * does one with any observation behind the reflect watermark still unscreened:
 * it is shown whole once the backfill reaches it, never consumed in part.
 *
 * A lesson is `confirmed` when its evidence spans two or more sessions and
 * `hypothesis` otherwise. A newly confirmed lesson becomes a knowledgebase
 * draft, never a publication. A lesson restating a live one in the same scope
 * is counted on it rather than written again, and a new lesson lists the
 * existing ones it resembles (`core/similar.ts`).
 */
import { createHash } from "node:crypto";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { LearnContext } from "../core/context.ts";
import type { Ledger } from "../core/ledger.ts";
import type { PageMeta } from "../core/pages.ts";
import { patchBody, renderPage } from "../core/pages.ts";
import { type Candidate, type Comparable, contentKey, similarLine, similarTo } from "../core/similar.ts";
import { buildPrompt } from "../core/roles.ts";
import { appendJsonl, nowIso, nowMs, readJsonl, todayLocal, tokens } from "../core/store.ts";
import { runOf } from "../core/trace.ts";
import { appendEvents, makeEvent, type ReviewEvent } from "../review/events.ts";
import type { ClaudeMemSource, ObservationRow } from "../sources/claude-mem.ts";
import {
  consumedObsIds,
  type Episode,
  loadEpisodes,
  markConsolidated,
  MEMORY_SOURCE,
  unconsolidatedEpisodes,
} from "./episodes.ts";
import {
  appendRun,
  cleanTags,
  isFailureObservation,
  lessonId,
  type LessonPage,
  list,
  loadLessons,
  lessonsIndexText,
  logLine,
  oneLine,
  proposeOrSkip,
  isScreened,
  quarantinedObservationIds,
  readState,
  screenedObservationRanges,
  rewriteIndex,
  saveState,
  sid8,
  str,
  writeLesson,
} from "./ledger.ts";

export const INPUT_CHARS = 80_000;
export const OBS_PER_EPISODE = 15;
const SCOPES = new Set(["repo", "subtree", "technology", "global"]);

type Stratifiable = Pick<
  Episode,
  "sid" | "started" | "completed" | "files_modified" | "failure_signals" | "corrections" | "priority"
>;

/** Up to `batch` episodes: 40% failures/corrections, 40% successful repeats, 20% novelty; priority descending within each. */
export function stratify<T extends Stratifiable>(
  episodes: readonly T[],
  batch: number,
): { chosen: T[]; failures: T[] } {
  const seen = new Set<string>();
  const repeats = new Set<string>();
  for (const episode of [...episodes].sort((a, b) => a.started - b.started)) {
    if (episode.completed && episode.files_modified.some((path) => seen.has(path))) repeats.add(episode.sid);
    for (const path of episode.files_modified) seen.add(path);
  }
  const byPriority = (a: T, b: T) => b.priority - a.priority;
  const fail = episodes.filter((episode) => episode.failure_signals > 0 || episode.corrections > 0).sort(byPriority);
  const failSids = new Set(fail.map((episode) => episode.sid));
  const rep = episodes.filter((episode) => repeats.has(episode.sid) && !failSids.has(episode.sid)).sort(byPriority);
  const repSids = new Set(rep.map((episode) => episode.sid));
  const nov = episodes.filter((episode) => !failSids.has(episode.sid) && !repSids.has(episode.sid)).sort(byPriority);
  const quota = [Math.round(batch * 0.4), Math.round(batch * 0.4)];
  quota.push(batch - quota[0]! - quota[1]!);
  const chosen = [...fail.slice(0, quota[0]), ...rep.slice(0, quota[1]), ...nov.slice(0, quota[2])];
  const rest = [...fail.slice(quota[0]), ...rep.slice(quota[1]), ...nov.slice(quota[2])].sort(byPriority);
  chosen.push(...rest.slice(0, Math.max(0, batch - chosen.length)));
  return { chosen, failures: fail.slice(0, quota[0]) };
}

/** Each failure with the earliest later completed episode that shares a modified file. */
export function pairFailures<T extends Stratifiable>(failures: readonly T[], all: readonly T[]): Array<[T, T]> {
  const pairs: Array<[T, T]> = [];
  for (const failure of failures) {
    const later = all.filter(
      (episode) =>
        episode.started > failure.started &&
        episode.completed &&
        episode.files_modified.some((path) => failure.files_modified.includes(path)),
    );
    if (later.length > 0) pairs.push([failure, later.reduce((a, b) => (b.started < a.started ? b : a))]);
  }
  return pairs;
}

/** Observations with the quarantined ones dropped, failures first, then decisions, then the rest; capped. */
export function rankObs(
  rows: readonly ObservationRow[],
  quarantined: ReadonlySet<string> = new Set(),
  cap = OBS_PER_EPISODE,
): ObservationRow[] {
  const rank = (row: ObservationRow) => (isFailureObservation(row) ? 0 : row.type === "decision" ? 1 : 2);
  return rows
    .filter((row) => !quarantined.has(`obs:${row.id}`))
    .sort((a, b) => rank(a) - rank(b) || a.id - b.id)
    .slice(0, cap);
}

export function formatEpisode(episode: Episode, rows: readonly ObservationRow[]): string {
  const head =
    `${sid8(episode.sid)} ${episode.platform} start=${episode.started} completed=${episode.completed ? "True" : "False"} ` +
    `failure_signals=${episode.failure_signals} corrections=${episode.corrections} priority=${episode.priority}\n` +
    `  request: ${(episode.request ?? "").slice(0, 300)}\n` +
    `  files: ${episode.files_modified.slice(0, 12).join(", ")}\n`;
  const body = rows
    .map(
      (row) =>
        `  obs:${row.id} [${row.type}] ${row.title ?? ""} — ${(row.subtitle ?? "").slice(0, 160)}` +
        (row.facts ? ` | ${row.facts.slice(0, 300)}` : "") +
        "\n",
    )
    .join("");
  return head + body;
}

export const OUTPUT_CONTRACT = `Reply with one object:
{"lessons": [{"statement": "...", "scope": "repo", "evidence": ["obs:123", "S1a2b3c4d"], "confidence": 0.7, "supersedes": [], "tags": []}],
 "review_events": [{"text": "...", "kind": "finding", "evidence": ["obs:123"], "files": ["path"]}],
 "log": "one line on what this batch covered"}
- evidence: ids copied verbatim from the episodes below. A lesson or review event with no such id is deleted.
- scope: one of repo | subtree | technology | global. confidence: 0..1. At most 8 lessons.
- tags may include: decision, security, blocker, preference, contrastive.
- supersedes: only ids (ls-NNN) listed under existing lessons.
- review_events kind: finding | correction. Leave the list empty when there are none.
- Status, ids, session counts and dates are set by the runtime; any you send are ignored.`;

/** The prompt and the episodes that fit in it. Only `included` reached the judge. */
export function consolidatePrompt(
  ctx: LearnContext,
  ledger: Ledger,
  chosen: readonly Episode[],
  pairs: ReadonlyArray<[Episode, Episode]>,
  obsBySid: ReadonlyMap<string, ObservationRow[]>,
  inputChars = INPUT_CHARS,
): { prompt: string; included: Episode[] } {
  const texts: string[] = [];
  const included: Episode[] = [];
  let used = 0;
  for (const episode of chosen) {
    const text = formatEpisode(episode, obsBySid.get(episode.sid) ?? []);
    if (used + text.length > inputChars) break;
    used += text.length;
    texts.push(text);
    included.push(episode);
  }
  const pairText =
    pairs
      .map(([failure, success]) => {
        const shared = failure.files_modified
          .filter((path) => success.files_modified.includes(path))
          .sort()
          .slice(0, 6);
        return `${sid8(failure.sid)} -> ${sid8(success.sid)} (shared files: ${shared.join(", ")})`;
      })
      .join("\n") || "(none)";
  const prompt = buildPrompt(
    "consolidator",
    OUTPUT_CONTRACT,
    [
      { title: "Existing lessons", body: lessonsIndexText(ledger) },
      {
        title: "Failure pairs (failed or corrected episode -> later completed episode on the same files)",
        body: pairText,
      },
      { title: "Episodes", body: texts.join("\n") || "(none)" },
    ],
    ctx.env,
  );
  return { prompt, included };
}

/** Distinct sessions an evidence list spans: `S<sid>` directly, `obs:N` through the observation-to-session map. */
export function sessionsOf(evidence: readonly string[], obsSession: ReadonlyMap<string, string>): Set<string> {
  const out = new Set<string>();
  for (const id of evidence) {
    if (id.startsWith("S")) out.add(id.slice(1));
    else if (id.startsWith("obs:") && obsSession.has(id)) out.add(obsSession.get(id)!);
  }
  return out;
}

export function nextLessonId(ledger: Ledger): string {
  const numbers = loadLessons(ledger)
    .values()
    .map(({ path }) => basename(path, ".md").slice(3))
    .filter((digits) => /^\d+$/.test(digits))
    .map(Number)
    .toArray();
  return `ls-${String(numbers.length > 0 ? Math.max(...numbers) + 1 : 1).padStart(3, "0")}`;
}

export function lessonBody(statement: string, evidence: readonly string[]): string {
  return `\n## Statement\n${statement}\n\n## Evidence\n${evidence.map((id) => `- ${id}\n`).join("")}`;
}

export function renderLesson(meta: PageMeta, evidence: readonly string[]): string {
  return renderPage(meta, lessonBody(str(meta.statement), evidence));
}

/** Statuses a repeat is counted on. A superseded or conflicting lesson is history; restating it makes a new lesson. */
const LIVE: ReadonlySet<string> = new Set(["hypothesis", "confirmed", "stale"]);

/** Lessons a new one is compared with: every one not superseded, conflicts included. */
function comparable(lessons: ReadonlyMap<string, LessonPage>): Comparable[] {
  return lessons
    .values()
    .filter(({ meta }) => meta.status !== "superseded")
    .map((page) => ({ id: lessonId(page), status: str(page.meta.status), text: str(page.meta.statement) }))
    .toArray();
}

/**
 * Count a repeat on the lesson it repeats: `count` up by one, `last_seen`
 * today, evidence and tags unioned, the statement and every earlier field
 * kept. Sessions never go down, so a hypothesis whose evidence now spans two
 * sessions is confirmed, and a stale lesson seen again is confirmed again.
 * Returns whether a hypothesis was newly confirmed.
 */
export function countRepeat(
  page: LessonPage,
  evidence: readonly string[],
  tags: readonly string[],
  sessionOf: ReadonlyMap<string, string>,
  today: string,
): boolean {
  const meta: PageMeta = { ...page.meta };
  const before = str(meta.status);
  const known = list(meta.evidence);
  const added = evidence.filter((id) => !known.includes(id));
  meta.count = (Number(meta.count) || 1) + 1;
  meta.last_seen = today;
  meta.evidence = [...known, ...added];
  meta.tags = [...new Set([...list(meta.tags), ...tags])].toSorted();
  meta.sessions = Math.max(Number(meta.sessions) || 0, sessionsOf(meta.evidence, sessionOf).size);
  if (before === "stale" || (before === "hypothesis" && meta.sessions >= 2)) meta.status = "confirmed";
  const body = page.body.trim() === "" ? lessonBody(str(meta.statement), meta.evidence) : page.body;
  page.meta = meta;
  page.body = added.reduce((text, id) => patchBody(text, "append", "", `- ${id}`), body);
  writeLesson(page.path, page.meta, page.body);
  return before === "hypothesis" && meta.status === "confirmed";
}

interface JudgedLesson {
  statement?: unknown;
  scope?: unknown;
  evidence?: unknown;
  confidence?: unknown;
  supersedes?: unknown;
  tags?: unknown;
}

interface JudgedEvent {
  text?: unknown;
  kind?: unknown;
  evidence?: unknown;
  files?: unknown;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export interface ConsolidateSummary {
  created: string[];
  dropped: number;
  superseded: string[];
  /** Created lessons whose status is `confirmed`. */
  confirmed: string[];
  review_events: number;
  /** Events held in the memory ledger because the review ledger was locked. */
  review_events_parked: number;
  /** Existing lessons a judged lesson repeated, counted on that lesson instead of written again; once per repeat. */
  repeated: string[];
  /** Created lessons resembling an existing one, with the candidates a reviewer may amend or supersede. */
  similar: Array<{ id: string; candidates: Candidate[] }>;
}

/**
 * Create lesson pages, mark superseded ones, and forward review events when a
 * review ledger is given. The runtime sets every id, status and count.
 *
 * A judged lesson whose statement and scope match a live lesson's after
 * normalization is a repeat: it is counted on that lesson (`countRepeat`) and
 * its `supersedes` is ignored, since a lesson cannot replace what it restates.
 * Every created lesson is compared with the existing ones and its resembling
 * candidates are listed in `similar`; nothing about them is stored or changed.
 * `sessionOf` maps older evidence to sessions, beside `obsSession`, so a
 * repeat across sessions confirms.
 */
export function applyConsolidation(
  ledger: Ledger,
  reply: Record<string, unknown>,
  valid: ReadonlySet<string>,
  obsSession: ReadonlyMap<string, string>,
  options: {
    review?: { ledger: Ledger; project: string };
    runId?: string;
    today?: string;
    sessionOf?: ReadonlyMap<string, string>;
  } = {},
): ConsolidateSummary {
  const today = options.today ?? todayLocal();
  const sessionOf = new Map([...(options.sessionOf ?? []), ...obsSession]);
  const existing = loadLessons(ledger);
  const summary: ConsolidateSummary = {
    created: [],
    dropped: 0,
    superseded: [],
    confirmed: [],
    review_events: 0,
    review_events_parked: 0,
    repeated: [],
    similar: [],
  };
  const lessons = Array.isArray(reply.lessons) ? (reply.lessons as JudgedLesson[]) : [];
  for (const lesson of lessons) {
    if (lesson === null || typeof lesson !== "object") continue;
    const evidence = strings(lesson.evidence).filter((id) => valid.has(id));
    const statement = oneLine(lesson.statement);
    if (evidence.length === 0 || statement === "") {
      summary.dropped += 1;
      continue;
    }
    const scope = typeof lesson.scope === "string" && SCOPES.has(lesson.scope) ? lesson.scope : "repo";
    const key = contentKey(statement, scope);
    const repeat = [...existing.values()].find(
      (page) => LIVE.has(str(page.meta.status)) && contentKey(str(page.meta.statement), str(page.meta.scope)) === key,
    );
    if (repeat !== undefined) {
      if (countRepeat(repeat, evidence, cleanTags(lesson.tags), sessionOf, today))
        summary.confirmed.push(lessonId(repeat));
      summary.repeated.push(lessonId(repeat));
      continue;
    }
    const id = nextLessonId(ledger);
    const sessions = sessionsOf(evidence, obsSession).size;
    const confidence = Number(lesson.confidence);
    const meta: PageMeta = {
      id,
      statement,
      scope,
      status: sessions >= 2 ? "confirmed" : "hypothesis",
      confidence: Math.min(1, Math.max(0, Number.isFinite(confidence) && confidence !== 0 ? confidence : 0.5)).toFixed(
        2,
      ),
      sessions,
      count: 1,
      tags: cleanTags(lesson.tags),
      evidence,
      supersedes: [],
      first_seen: today,
      last_seen: today,
      valid_until: "",
    };
    const confirmed = meta.status === "confirmed";
    const supersedes: string[] = [];
    for (const old of strings(lesson.supersedes)) {
      const page = existing.get(old);
      if (old === id || page === undefined) continue;
      if (page.meta.status !== "hypothesis" && page.meta.status !== "confirmed") continue;
      if (page.meta.status === "confirmed" && !confirmed) {
        meta.status = "conflict";
        page.meta = { ...page.meta, status: "conflict" };
      } else {
        page.meta = { ...page.meta, status: "superseded", valid_until: today, superseded_by: id };
        supersedes.push(old);
        summary.superseded.push(old);
      }
      writeLesson(page.path, page.meta, page.body);
    }
    meta.supersedes = supersedes;
    const candidates = similarTo(statement, comparable(existing));
    if (candidates.length > 0) summary.similar.push({ id, candidates });
    const path = join(ledger.path("lessons"), `${id}.md`);
    writeFileSync(path, renderLesson(meta, evidence));
    existing.set(id, { meta, body: lessonBody(statement, evidence), path });
    summary.created.push(id);
    if (meta.status === "confirmed") summary.confirmed.push(id);
  }
  if (options.review !== undefined) {
    const events = Array.isArray(reply.review_events) ? (reply.review_events as JudgedEvent[]) : [];
    const delivered = forwardReviewEvents(
      options.review.ledger,
      ledger,
      options.review.project,
      events,
      valid,
      options.runId ?? null,
    );
    summary.review_events = delivered.forwarded;
    summary.review_events_parked = delivered.parked;
  }
  rewriteIndex(ledger);
  return summary;
}

/** Review events built while the review ledger was locked, waiting for a run that gets the lock. */
export const PENDING_REVIEW_FILE = "raw/pending-review-events.jsonl";

/** Evidence-backed findings and corrections from a judge reply, as review events. Deduplicated later by the hash of the text. */
export function buildReviewEvents(
  project: string,
  events: readonly JudgedEvent[],
  valid: ReadonlySet<string>,
  runId: string | null,
): ReviewEvent[] {
  const out: ReviewEvent[] = [];
  for (const event of events) {
    if (event === null || typeof event !== "object") continue;
    const text = oneLine(event.text);
    const evidence = strings(event.evidence).filter((id) => valid.has(id));
    if (text === "" || evidence.length === 0) continue;
    const obsIds = evidence.filter((id) => id.startsWith("obs:")).map((id) => Number(id.slice(4)));
    const files = strings(event.files)
      .map((file) => oneLine(file, 500))
      .filter((file) => file !== "");
    const forwarded = makeEvent(
      {
        source: MEMORY_SOURCE,
        kind: event.kind === "correction" ? "correction" : "finding",
        project,
        pr: null,
        sha: null,
        author: MEMORY_SOURCE,
        severity: null,
        path: files[0] ?? null,
        line: null,
        text: `${text}\n(evidence: ${evidence.join(", ")})`,
        // The run id rides in url, not author: maintain adds every author to a pattern's reviewers list.
        url: runId === null ? null : `${MEMORY_SOURCE}:run/${runId}`,
        ts: nowIso(),
      },
      createHash("sha1").update(text).digest("hex"),
    );
    if (obsIds[0] !== undefined) forwarded.obs_id = obsIds[0];
    out.push(forwarded);
  }
  return out;
}

/**
 * Append review events to the review ledger's raw layer, where the review
 * loop classifies them on its own next run. Takes the review ledger's lock.
 * A busy ledger parks the events in the memory ledger's
 * `raw/pending-review-events.jsonl` instead of losing them; the next call that
 * gets the lock sends the parked events first and then empties the queue.
 * `appendEvents` deduplicates by hash, so a crash between the two resends
 * nothing twice.
 */
export function deliverReviewEvents(
  review: Ledger,
  memory: Ledger,
  events: readonly ReviewEvent[],
): { forwarded: number; parked: number } {
  const release = review.tryLock();
  if (release === null) {
    appendJsonl(memory.path(PENDING_REVIEW_FILE), events);
    return { forwarded: 0, parked: events.length };
  }
  try {
    const pendingPath = memory.path(PENDING_REVIEW_FILE);
    const parked = readJsonl<ReviewEvent>(pendingPath);
    const fresh = appendEvents(review, [...parked, ...events]);
    if (fresh > 0) review.commit(`learn memory: +${fresh} review events`);
    if (existsSync(pendingPath)) rmSync(pendingPath);
    return { forwarded: fresh, parked: 0 };
  } finally {
    release();
  }
}

/** Build and deliver in one step. Returns how many events reached the review ledger and how many were parked. */
export function forwardReviewEvents(
  review: Ledger,
  memory: Ledger,
  project: string,
  events: readonly JudgedEvent[],
  valid: ReadonlySet<string>,
  runId: string | null,
): { forwarded: number; parked: number } {
  return deliverReviewEvents(review, memory, buildReviewEvents(project, events, valid, runId));
}

/** The lesson's origin as a knowledgebase trigger: a stated preference or a corrected session is a correction. */
function triggerOf(
  meta: PageMeta,
  obsSession: ReadonlyMap<string, string>,
  corrected: ReadonlySet<string>,
): "correction" | "failure" {
  if (list(meta.tags).includes("preference")) return "correction";
  const sessions = sessionsOf(list(meta.evidence), obsSession);
  return [...sessions].some((sid) => corrected.has(sid)) ? "correction" : "failure";
}

/** `obs:N` to the session it came from, for every observation an existing lesson cites. */
export function citedObsSessions(source: ClaudeMemSource, ledger: Ledger): Map<string, string> {
  const ids = loadLessons(ledger)
    .values()
    .flatMap(({ meta }) => list(meta.evidence))
    .filter((id) => /^obs:\d+$/.test(id))
    .map((id) => Number(id.slice(4)))
    .toArray();
  if (ids.length === 0) return new Map();
  return new Map([...source.observationSessions(ids)].map(([id, sid]) => [`obs:${id}`, sid8(sid).slice(1)]));
}

/** A pending episode's screened observations no standing run has consumed, and the mark consuming them records. */
export interface ReadyEpisode {
  rows: ObservationRow[];
  obs: number;
  obs_id: number;
}

/** The pending episodes that have something to show the consolidator and nothing left for the backfill to screen, by session id. */
export function readyEpisodes(
  source: ClaudeMemSource,
  ledger: Ledger,
  pending: readonly Episode[],
): Map<string, ReadyEpisode> {
  const ranges = screenedObservationRanges(ledger);
  const consumed = consumedObsIds(ledger);
  const watermark = readState(ledger).last_obs_id_reflected ?? 0;
  const ready = new Map<string, ReadyEpisode>();
  for (const episode of pending) {
    const allRows = source.sessionObservations(episode.sid);
    if (allRows.some((row) => row.id <= watermark && !isScreened(ranges, row.id))) continue;
    const after = consumed.get(episode.sid) ?? 0;
    const rows = allRows.filter((row) => row.id > after && isScreened(ranges, row.id));
    const last = rows.at(-1);
    if (last !== undefined)
      ready.set(episode.sid, { rows, obs: allRows.filter((row) => row.id <= last.id).length, obs_id: last.id });
  }
  return ready;
}

/** A nightly with nothing to show still counts as today's run, so the scheduler does not call it again every tick. */
function nothingToConsolidate(ctx: LearnContext, ledger: Ledger, message: string): string {
  if (!ctx.config.dryRun) saveState(ledger, { ...readState(ledger), last_nightly: todayLocal() });
  return message;
}

export function consolidate(
  ctx: LearnContext,
  source: ClaudeMemSource,
  ledger: Ledger,
  root: string,
  review: Ledger | null,
  trigger = "tick",
): string {
  // Events parked by an earlier run go out as soon as the review ledger is free, even on a night with nothing to consolidate.
  if (review !== null && !ctx.config.dryRun && existsSync(ledger.path(PENDING_REVIEW_FILE)))
    deliverReviewEvents(review, ledger, []);
  const all = loadEpisodes(ledger);
  const pending = unconsolidatedEpisodes(ledger);
  if (pending.length === 0) return nothingToConsolidate(ctx, ledger, "nightly: no unconsolidated episodes");
  const unseen = readyEpisodes(source, ledger, pending);
  const ready = pending.filter((episode) => unseen.has(episode.sid));
  if (ready.length === 0) return nothingToConsolidate(ctx, ledger, "nightly: no reflected observations to consolidate");
  const { chosen, failures } = stratify(ready, ctx.config.batch);
  const pairs = pairFailures(failures, all);
  const quarantined = quarantinedObservationIds(ledger);
  const obsBySid = new Map<string, ObservationRow[]>();
  const obsSessionAll = new Map<string, string>();
  for (const episode of chosen) obsBySid.set(episode.sid, rankObs(unseen.get(episode.sid)?.rows ?? [], quarantined));
  for (const [sid, rows] of obsBySid) for (const row of rows) obsSessionAll.set(`obs:${row.id}`, sid8(sid).slice(1));
  const { prompt, included } = consolidatePrompt(ctx, ledger, chosen, pairs, obsBySid);
  if (ctx.config.dryRun) {
    ctx.io.out(prompt);
    return `nightly: dry run (${included.length}/${chosen.length} episodes fit, ${pairs.length} pairs, ${tokens(prompt)} prompt tokens)`;
  }
  // Inside a tick the run is the job's span; called on its own it keeps the dated id rollback also reads.
  const runId = runOf(ctx).runId ?? `nightly-${todayLocal()}-${nowMs() % 100_000}`;
  const reply = ctx.judge(prompt, {
    runId,
    traceId: runOf(ctx).traceId,
    loop: "memory",
    role: "consolidator",
    project: basename(root),
  });
  if (reply === null) {
    const state = readState(ledger);
    saveState(ledger, {
      ...state,
      last_nightly_attempt: nowMs(),
      nightly_failures: (state.nightly_failures ?? 0) + 1,
    });
    appendRun(ledger, { job: "nightly", id: runId, status: "failed", reason: "no judge output", trigger });
    logLine(ledger, "nightly failed: no judge output");
    return "nightly: judge call failed";
  }
  const shown = new Set(included.map((episode) => sid8(episode.sid).slice(1)));
  const obsSession = new Map([...obsSessionAll].filter(([, sid]) => shown.has(sid)));
  const valid = new Set([...obsSession.keys(), ...included.map((episode) => sid8(episode.sid))]);
  const summary = applyConsolidation(ledger, reply, valid, obsSession, {
    review: review === null ? undefined : { ledger: review, project: basename(root) },
    runId,
    sessionOf: citedObsSessions(source, ledger),
  });
  markConsolidated(
    ledger,
    new Map(
      included.flatMap((episode) => {
        const mark = unseen.get(episode.sid);
        return mark === undefined ? [] : [[episode.sid, { obs: mark.obs, obs_id: mark.obs_id }] as const];
      }),
    ),
    runId,
  );
  const corrected = new Set(
    included.filter((episode) => episode.corrections > 0).map((episode) => sid8(episode.sid).slice(1)),
  );
  const lessons = loadLessons(ledger);
  const proposals: string[] = [];
  const skippedProposals: string[] = [];
  for (const id of summary.confirmed) {
    const page = lessons.get(id);
    if (page === undefined) continue;
    const trig = triggerOf(page.meta, obsSession, corrected);
    const similar = summary.similar.find((entry) => entry.id === id)?.candidates;
    const proposal = proposeOrSkip(ctx, ledger, root, page, {
      runId,
      createdBy: "learn/consolidator",
      trigger: trig,
      similar,
    });
    if ("ref" in proposal) proposals.push(proposal.ref);
    else skippedProposals.push(proposal.skipped);
  }
  const state = readState(ledger);
  const { last_nightly_attempt: _attempt, nightly_failures: _failures, ...withoutBackoff } = state;
  saveState(ledger, { ...withoutBackoff, last_nightly: todayLocal() });
  const log = typeof reply.log === "string" ? reply.log : "";
  const run = {
    job: "nightly",
    id: runId,
    status: "ok",
    trigger,
    episodes: included.map((episode) => episode.sid),
    selected: chosen.length,
    pairs: pairs.length,
    tokens_in: tokens(prompt),
    ...summary,
    proposals,
  };
  const recorded = skippedProposals.length > 0 ? { ...run, proposals_skipped: skippedProposals } : run;
  appendRun(ledger, { ...recorded, log: log.slice(0, 200) });
  logLine(
    ledger,
    `nightly ${runId}: ${included.length}/${chosen.length} episodes, +${summary.created.length} lessons, ${summary.repeated.length} repeats counted, ` +
      `${summary.dropped} dropped, ${summary.superseded.length} superseded, ${summary.review_events} review events forwarded, ` +
      `${summary.review_events_parked} parked, ${proposals.length} proposals. ${log}`,
  );
  for (const { id, candidates } of summary.similar)
    logLine(ledger, `similar ${similarLine(id, candidates)}: amend or supersede`);
  ledger.commit(`nightly ${runId}: +${summary.created.length} lessons`);
  const similar = summary.similar.map(({ id, candidates }) => `; similar ${similarLine(id, candidates)}`).join("");
  const repeats = summary.repeated.length > 0 ? `, ${summary.repeated.length} repeats counted` : "";
  return (
    `nightly: ${included.length}/${chosen.length} episodes -> +${summary.created.length} lessons${repeats}, ` +
    `${summary.review_events} review events${similar}`
  );
}
