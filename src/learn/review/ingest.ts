/**
 * Raw layer: GitHub PR threads, claude-mem review observations and user
 * corrections become `raw/review-events.jsonl`.
 *
 * An inline comment that starts a thread is a finding; a reply in the thread
 * is a resolution, attributed to the PR author or to a third party. Reviewer
 * text is data: it is stored, never executed or interpreted.
 */
import { basename, join } from "node:path";
import { homedir } from "node:os";
import type { LearnContext } from "../core/context.ts";
import { Ledger } from "../core/ledger.ts";
import { isScreened, memoryDir, quarantinedObservationIds, screenedObservationRanges } from "../memory/ledger.ts";
import { projectFolderName, reflectFolderName, registryPath } from "../core/paths.ts";
import { nowIso, readJson, writeJson } from "../core/store.ts";
import { ClaudeMemSource, jsonList, type ObservationRow } from "../sources/claude-mem.ts";
import {
  authorLabel,
  GitHubReviewSource,
  type IssueComment,
  type PullRequestRef,
  type Review,
  type ReviewComment,
} from "../sources/github.ts";
import { appendEvents, eventHash, makeEvent, parseSeverity, type ReviewEvent, stripHtml } from "./events.ts";

/** Bot noise and slash commands that ride on issue comments. */
const NOISE = /railway-pr-env-link|Mergify Payload|^@greptileai|^@Mergifyio|greptile_summary/im;
/** An issue comment counts only when it is a review report (`## Review`, `## Re-review`). */
const REPORT = /^\s*##\s*(re-)?review\b/im;
/** A claude-mem `gotcha` observation counts only when its title reads like review feedback. */
const MEM_REVIEW_TITLE = /finding|reviewer|blocker|greptile|\bP[0-3]\b|review (round|feedback|report)/i;

export const WATERMARK_FILE = "raw/.watermark.json";

/** One inline review comment as an event. A reply links to its parent finding's hash. */
export function githubCommentEvent(
  comment: ReviewComment,
  byId: ReadonlyMap<number, ReviewComment>,
  pr: number,
  sha: string,
  prAuthor: string,
  project: string | null,
): ReviewEvent {
  const login = comment.user?.login ?? "";
  const parent = comment.in_reply_to_id ?? null;
  const [source, kind] =
    parent === null
      ? (["github", "finding"] as const)
      : login === prAuthor
        ? (["author-reply", "resolution"] as const)
        : (["github-reply", "resolution"] as const);
  const event = makeEvent({
    source,
    kind,
    project,
    pr,
    sha,
    author: authorLabel(comment.user),
    severity: parseSeverity(comment.body),
    path: comment.path ?? null,
    line: comment.line ?? comment.original_line ?? null,
    text: stripHtml(comment.body),
    url: comment.html_url,
    ts: comment.created_at,
  });
  const parentComment = parent === null ? undefined : byId.get(parent);
  if (parentComment !== undefined) event.in_reply_to = eventHash("github", parentComment.html_url);
  return event;
}

export function reviewEvent(review: Review, pr: number, sha: string, project: string | null): ReviewEvent | null {
  const body = review.body ?? "";
  if (body.trim() === "") return null;
  return makeEvent({
    source: "github",
    kind: "finding",
    project,
    pr,
    sha,
    author: authorLabel(review.user),
    severity: parseSeverity(body),
    path: null,
    line: null,
    text: stripHtml(body),
    url: review.html_url,
    ts: review.submitted_at,
  });
}

export function reportEvent(
  comment: IssueComment,
  pr: number,
  sha: string,
  project: string | null,
): ReviewEvent | null {
  const body = comment.body ?? "";
  if (NOISE.test(body) || !REPORT.test(body)) return null;
  return makeEvent({
    source: "review-report",
    kind: "finding",
    project,
    pr,
    sha,
    author: authorLabel(comment.user),
    severity: null,
    path: null,
    line: null,
    text: stripHtml(body),
    url: comment.html_url,
    ts: comment.created_at,
  });
}

export function eventsFromGithub(
  source: GitHubReviewSource,
  repo: string,
  prs: readonly PullRequestRef[],
  project: string | null,
): ReviewEvent[] {
  const events: ReviewEvent[] = [];
  for (const pr of prs) {
    const sha = pr.headRefOid ?? "";
    const author = pr.author?.login ?? "";
    const comments = source.reviewComments(repo, pr.number);
    const byId = new Map(comments.map((comment) => [comment.id, comment]));
    for (const comment of comments) events.push(githubCommentEvent(comment, byId, pr.number, sha, author, project));
    for (const review of source.reviews(repo, pr.number)) {
      const event = reviewEvent(review, pr.number, sha, project);
      if (event !== null) events.push(event);
    }
    for (const comment of source.issueComments(repo, pr.number)) {
      const event = reportEvent(comment, pr.number, sha, project);
      if (event !== null) events.push(event);
    }
  }
  return events;
}

/**
 * A claude-mem observation as an event, when it is review feedback: a
 * `review-finding` / `review-resolution` observation, or a `gotcha` whose
 * title reads like a review. Anything else is null.
 */
export function observationEvent(row: ObservationRow, project: string): ReviewEvent | null {
  const isReview = row.type === "review-finding" || row.type === "review-resolution";
  const isGotcha = jsonList(row.concepts).includes("gotcha") || (row.concepts ?? "").includes("gotcha");
  if (!isReview && !(isGotcha && MEM_REVIEW_TITLE.test(row.title ?? ""))) return null;
  const text = [row.title, row.subtitle, row.narrative, row.facts].filter((part) => part).join("\n");
  const prMatch = /\/(\d{3,5})\b|#(\d{3,5})\b/.exec(`${row.project} ${row.title ?? ""}`);
  const event = makeEvent(
    {
      source: "claude-mem",
      kind: row.type === "review-resolution" ? "resolution" : "finding",
      project,
      pr: prMatch === null ? null : Number.parseInt(prMatch[1] ?? prMatch[2]!, 10),
      sha: null,
      author: `observer:${row.type}`,
      severity: parseSeverity(text),
      path: jsonList(row.files_modified)[0] ?? null,
      line: null,
      text,
      url: null,
      ts: row.created_at,
      platform: row.platform_source ?? "claude",
    },
    `obs:${row.id}`,
  );
  event.obs_id = row.id;
  return event;
}

/**
 * Review observations after the ledger's watermark, and the ones an earlier
 * run deferred. A review-shaped row becomes an event once an accepted reflect
 * or backfill run screened it, and is dropped once a run quarantined it. Until
 * then its id rides in the watermark file's `deferred` list, so the watermark
 * moves on and each run replays only those rows.
 */
export function eventsFromClaudeMem(
  ctx: LearnContext,
  ledger: Ledger,
  project: string,
  sinceMs: number,
  memory: Ledger,
): { events: ReviewEvent[]; maxId: number; deferred: number[] } {
  const mark = readJson<{ claude_mem_max_id?: number; deferred?: number[] }>(ledger.path(WATERMARK_FILE), {});
  const minId = mark.claude_mem_max_id ?? 0;
  const waiting = mark.deferred ?? [];
  const source = ClaudeMemSource.open(ctx.config.memDb);
  if (source === null) return { events: [], maxId: minId, deferred: waiting };
  const ranges = screenedObservationRanges(memory);
  const quarantined = quarantinedObservationIds(memory);
  try {
    let maxId = minId;
    const events: ReviewEvent[] = [];
    const deferred: number[] = [];
    const rows = [
      ...source.observationsById(waiting),
      ...source.observationsSince(project, minId, { sinceEpochMs: sinceMs }),
    ];
    for (const row of rows) {
      maxId = Math.max(maxId, row.id);
      const event = observationEvent(row, project);
      if (event === null || quarantined.has(`obs:${row.id}`)) continue;
      if (isScreened(ranges, row.id)) events.push(event);
      else deferred.push(row.id);
    }
    return { events, maxId, deferred };
  } finally {
    source.close();
  }
}

/**
 * A user correction as an event. Keyed on the UTC day and the first 200
 * characters, so the prompt hook and claude-reflect's queue recording the same
 * correction produce one event, not two.
 */
export function correctionEvent(
  text: string,
  ts: string,
  project: string | null,
  platform: string,
  extra: { patterns?: string; confidence?: number } = {},
): ReviewEvent {
  const event = makeEvent(
    {
      source: "correction",
      kind: "correction",
      project,
      pr: null,
      sha: null,
      author: "user",
      severity: null,
      path: null,
      line: null,
      text,
      url: null,
      ts,
      platform,
    },
    `${ts.slice(0, 10)}|${text.slice(0, 200)}`,
  );
  return { ...event, ...extra };
}

interface ReflectQueueItem {
  sentiment?: string;
  message?: string;
  timestamp?: string;
}

/** Corrections waiting in claude-reflect's per-project queue, read-only. Checked under the config dir and `~/.claude`. */
export function eventsFromReflectQueue(ctx: LearnContext, root: string, project: string | null): ReviewEvent[] {
  const folder = reflectFolderName(root);
  const bases = [...new Set([ctx.config.configDir, join(homedir(), ".claude")])];
  const events: ReviewEvent[] = [];
  for (const base of bases) {
    const items = readJson<ReflectQueueItem[]>(join(base, "projects", folder, "learnings-queue.json"), []);
    if (!Array.isArray(items)) continue;
    for (const item of items) {
      if (item.sentiment !== "correction" || typeof item.message !== "string" || item.message.trim() === "") continue;
      events.push(correctionEvent(item.message, item.timestamp ?? nowIso(), project, "claude"));
    }
  }
  return events;
}

/** The claude-mem project name for a root: the registry's record when there is one, else the directory name. */
export function memProject(ctx: LearnContext, root: string): string {
  const registry = readJson<Record<string, { mem_project?: string }>>(registryPath(ctx.config), {});
  const recorded = registry[projectFolderName(root)]?.mem_project;
  return typeof recorded === "string" && recorded !== "" ? recorded : basename(root);
}

export interface IngestOptions {
  prs?: readonly number[];
  /** `YYYY-MM-DD`: lower bound for claude-mem observations, and PR selection when no numbers are given. */
  since?: string;
  /** The session's working directory; `gh` resolves the current branch's PR there. The root when absent. */
  cwd?: string;
  /** `owner/name`; resolved through `gh` when absent. */
  repo?: string;
  /** `codex` sessions have no claude-reflect queue. */
  source?: string;
  github?: GitHubReviewSource;
  skipGithub?: boolean;
  skipMem?: boolean;
}

export interface IngestResult {
  /** Every event gathered this run, before deduplication. */
  events: ReviewEvent[];
  /** Events actually appended. */
  fresh: number;
  /** Sources that were asked for and could not be read (ruling `required-lane-failure-is-unavailable`). */
  unavailable: string[];
  /** claude-mem review observations held back until the memory loop screens them. */
  deferred: number;
}

/** What a report appends when review observations are waiting on the memory loop's screen; empty when none are. */
export function deferredNote(result: IngestResult): string {
  return result.deferred === 0
    ? ""
    : `; ${result.deferred} claude-mem review observation(s) wait for the memory loop to screen them`;
}

/** Gather events and append the unseen ones. In a dry run nothing is written. Commits when anything was appended. */
export function ingest(ctx: LearnContext, ledger: Ledger, root: string, options: IngestOptions = {}): IngestResult {
  const project = memProject(ctx, root);
  const sinceMs = options.since === undefined ? 0 : Date.parse(`${options.since}T00:00:00Z`);
  if (Number.isNaN(sinceMs)) throw new Error(`--since wants YYYY-MM-DD, got ${options.since}`);
  const events: ReviewEvent[] = [];
  const unavailable: string[] = [];

  if (options.skipGithub !== true) {
    const github = options.github ?? new GitHubReviewSource(options.cwd ?? root);
    const repo = options.repo ?? github.repo();
    if (repo === null) {
      // An absent source is reported, never read as "no findings": a quiet run would look like a clean one.
      unavailable.push("github");
      ctx.io.err(
        "ak learn review: review source github unavailable (`gh repo view` failed); pass --gh-repo or --no-github",
      );
    } else {
      events.push(
        ...eventsFromGithub(github, repo, github.pullRequests(repo, options.prs ?? [], options.since), project),
      );
    }
  }
  let maxId = 0;
  let deferred: number[] = [];
  if (options.skipMem !== true) {
    const mem = eventsFromClaudeMem(ctx, ledger, project, sinceMs, new Ledger(memoryDir(ctx.config, root)));
    events.push(...mem.events);
    maxId = mem.maxId;
    deferred = mem.deferred;
  }
  if (options.source !== "codex") events.push(...eventsFromReflectQueue(ctx, root, project));

  if (ctx.config.dryRun) return { events, fresh: 0, unavailable, deferred: deferred.length };
  const fresh = appendEvents(ledger, events);
  if (maxId > 0) writeJson(ledger.path(WATERMARK_FILE), { claude_mem_max_id: maxId, deferred, ts: nowIso() });
  if (fresh > 0) ledger.commit(`ingest: +${fresh} events`);
  return { events, fresh, unavailable, deferred: deferred.length };
}
