/**
 * Raw layer: GitHub PR threads, claude-mem review observations, local
 * knowledgebase findings and user corrections become `raw/review-events.jsonl`.
 *
 * An inline comment that starts a thread is a finding; a reply in the thread
 * is a resolution, attributed to the PR author or to a third party. Reviewer
 * text is data: it is stored, never executed or interpreted.
 */
import { existsSync } from "node:fs";
import Ajv from "ajv";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import { git as kbGit } from "../../kb/git.ts";
import { checkRunArtifact } from "../../kb/artifacts.ts";
import { registryPath as kbRegistryPath, resolveKnowledgebase } from "../../kb/binding.ts";
import type { LearnContext } from "../core/context.ts";
import { Ledger } from "../core/ledger.ts";
import {
  isScreened,
  memoryDir,
  quarantinedObservationIds,
  readState,
  screenedObservationRanges,
} from "../memory/ledger.ts";
import { projectFolderName, reflectFolderName, registryPath } from "../core/paths.ts";
import { nowIso, nowMs, readJson, readText, writeJson } from "../core/store.ts";
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
  event.session = row.memory_session_id;
  return event;
}

/** The review observation ids an ingest left waiting for the memory loop to screen. */
export function deferredObservationIds(ledger: Ledger): number[] {
  return readJson<{ deferred?: number[] }>(ledger.path(WATERMARK_FILE), {}).deferred ?? [];
}

/** How long the reflector may stay silent before unscreened rows stop waiting on it. */
export const CLAUDE_MEM_STALE_MS = 24 * 3600 * 1000;

function staleWindowMs(ctx: LearnContext, override?: number): number {
  if (override !== undefined) return override;
  const raw = ctx.env.AK_LEARN_CLAUDE_MEM_STALE_MS;
  const parsed = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : CLAUDE_MEM_STALE_MS;
}

export function eventsFromClaudeMem(
  ctx: LearnContext,
  ledger: Ledger,
  project: string,
  sinceMs: number,
  memory: Ledger,
  options: { staleMs?: number; now?: number } = {},
): { events: ReviewEvent[]; maxId: number; deferred: number[] } {
  const minId = readJson<{ claude_mem_max_id?: number }>(ledger.path(WATERMARK_FILE), {}).claude_mem_max_id ?? 0;
  const waiting = deferredObservationIds(ledger);
  const source = ClaudeMemSource.open(ctx.config.memDb);
  if (source === null) return { events: [], maxId: minId, deferred: waiting };
  const ranges = screenedObservationRanges(memory);
  const quarantined = quarantinedObservationIds(memory);
  const state = readState(memory);
  const attempted = state.reflect_stalled_since ?? state.last_reflect ?? state.last_reflect_attempt;
  const stale = attempted !== undefined && (options.now ?? nowMs()) - attempted >= staleWindowMs(ctx, options.staleMs);
  const release = stale && (state.reflect_failures ?? 0) > 0;
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
      if (release || isScreened(ranges, row.id)) events.push(event);
      else deferred.push(row.id);
    }
    return { events, maxId, deferred };
  } finally {
    source.close();
  }
}

interface KbArtifact {
  project: { id: string };
  run_id: string | null;
  created_at: string;
  title: string;
  detail?: string;
  lane: string;
  severity: string;
  evidence: Array<{ location: { path?: string }; observation: string }>;
}

interface StoredKbArtifact {
  record: { ref: string };
  artifact: KbArtifact;
}

let kbArtifactValidator: ((value: unknown) => value is StoredKbArtifact) | undefined;

function kbArtifact(line: string): StoredKbArtifact | null {
  kbArtifactValidator ??= new Ajv({ strict: false }).compile<StoredKbArtifact>({
    type: "object",
    required: ["record", "artifact"],
    properties: {
      record: {
        type: "object",
        required: ["ref"],
        properties: { ref: { type: "string", minLength: 1 } },
      },
      artifact: { type: "object" },
    },
  });
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (!kbArtifactValidator(value)) return null;
  return checkRunArtifact(JSON.stringify(value.artifact)).artifact?.schema === "finding" ? value : null;
}

export function eventsFromKbFindings(kbRoot: string, project: string | null): ReviewEvent[] {
  if (project === null) return [];
  const head = kbGit(kbRoot, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
  if (head.status !== 0) {
    const branch = kbGit(kbRoot, ["symbolic-ref", "--quiet", "HEAD"]);
    if (branch.status === 0 && kbGit(kbRoot, ["show-ref", "--verify", "--quiet", branch.stdout.trim()]).status === 1)
      return [];
    throw new Error(`knowledgebase findings: cannot read committed HEAD at ${kbRoot}`);
  }
  const snapshot = head.stdout.trim();
  const path = `projects/${project}/runs/artifacts.jsonl`;
  const listed = kbGit(kbRoot, ["ls-tree", "-z", snapshot, "--", path]);
  if (listed.status !== 0) throw new Error(`knowledgebase findings: cannot locate ${path}: ${listed.stderr.trim()}`);
  if (listed.stdout === "") return [];
  const committed = kbGit(kbRoot, ["cat-file", "blob", `${snapshot}:${path}`]);
  if (committed.status !== 0) throw new Error(`knowledgebase findings: cannot read ${path}: ${committed.stderr.trim()}`);
  const events: ReviewEvent[] = [];
  for (const line of committed.stdout.split("\n")) {
    if (line.trim() === "") continue;
    const stored = kbArtifact(line);
    if (stored === null) continue;
    const { artifact, record } = stored;
    if (artifact.project.id !== project) continue;
    const observations = artifact.evidence.map((entry) => entry.observation);
    const text = [artifact.title, artifact.detail ?? "", ...observations].filter((part) => part !== "").join("\n");
    const event = makeEvent(
      {
        source: "kb-finding",
        kind: "finding",
        project,
        pr: null,
        sha: null,
        author: artifact.lane,
        severity: artifact.severity,
        path: artifact.evidence[0]?.location.path ?? null,
        line: null,
        text,
        url: null,
        ts: artifact.created_at,
      },
      record.ref,
    );
    if (artifact.run_id) event.session = artifact.run_id;
    events.push(event);
  }
  return events;
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
  /** Override for the claude-mem staleness window (`AK_LEARN_CLAUDE_MEM_STALE_MS`). */
  claudeMemStaleMs?: number;
}

/** The hosts a session's review findings come from; `--source` names one. */
export const REVIEW_SOURCES = ["claude", "codex"] as const;

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
  const started = nowIso();
  const watermark = readJson<{ claude_mem_max_id?: number; deferred?: number[]; github_since?: string }>(
    ledger.path(WATERMARK_FILE),
    {},
  );
  let githubSince = watermark.github_since;

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
        ...eventsFromGithub(github, repo, github.pullRequests(repo, options.prs ?? [], options.since, githubSince), project),
      );
      if (!github.unavailable && github.fallbackComplete) githubSince = `${started.slice(0, 19)}Z`;
      if (github.unavailable) {
        unavailable.push("github");
        ctx.io.err("ak learn review: review source github unavailable; selection watermark retained");
      }
    }
  }
  let maxId = 0;
  let deferred: number[] = [];
  if (options.skipMem !== true) {
    const mem = eventsFromClaudeMem(ctx, ledger, project, sinceMs, new Ledger(memoryDir(ctx.config, root)), {
      staleMs: options.claudeMemStaleMs,
    });
    events.push(...mem.events);
    maxId = mem.maxId;
    deferred = mem.deferred;
  }
  const kb = resolveKnowledgebase(root, kbRegistryPath(ctx.env));
  if (kb.state === "failed")
    throw new Error(`knowledgebase findings: ${kb.issues.map((issue) => issue.message).join("; ")}`);
  if (kb.resolved !== null) events.push(...eventsFromKbFindings(kb.resolved.root, kb.resolved.binding.project));
  else if (kb.issues.some((issue) => issue.rule === "kb.unregistered")) {
    unavailable.push("kb-finding");
    ctx.io.err(
      `ak learn review: review source kb-finding unavailable: ${kb.issues.map((issue) => issue.message).join("; ")}`,
    );
  }
  if (options.source !== "codex") events.push(...eventsFromReflectQueue(ctx, root, project));

  if (ctx.config.dryRun) return { events, fresh: 0, unavailable, deferred: deferred.length };
  const fresh = appendEvents(ledger, events);
  if (maxId > 0 || githubSince !== watermark.github_since)
    writeJson(ledger.path(WATERMARK_FILE), {
      ...watermark,
      ...(maxId > 0 ? { claude_mem_max_id: maxId, deferred } : {}),
      github_since: githubSince,
      ts: started,
    });
  if (fresh > 0) ledger.commit(`ingest: +${fresh} events`);
  return { events, fresh, unavailable, deferred: deferred.length };
}
