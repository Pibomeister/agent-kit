/**
 * The weekly job: (1) roll up review-pattern evidence older than 30 days per
 * month, (2) mark confirmed lessons unseen for 90 days `stale`, (3) one judge
 * call (role `lesson-merger`) over the lessons index for merge and
 * contradiction pairs.
 *
 * A lesson's `last_seen` is set at creation and refreshed only by a merge, so
 * the 90 days run from creation or last merge. Global lessons and lessons
 * tagged decision, security or blocker never go stale.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { LearnContext } from "../core/context.ts";
import type { Ledger } from "../core/ledger.ts";
import { buildPrompt } from "../core/roles.ts";
import { nowMs, todayLocal, writeGated } from "../core/store.ts";
import { runOf } from "../core/trace.ts";
import { ClaudeMemSource } from "../sources/claude-mem.ts";
import { ProjectMemorySource, WorkerSessionSource } from "../sources/worker-sessions.ts";
import { sessionsOf } from "./consolidate.ts";
import {
  appendRun,
  list,
  loadLessons,
  lessonsIndexText,
  logLine,
  proposeOrSkip,
  readState,
  rewriteIndex,
  saveState,
  sid8,
  str,
  writeLesson,
} from "./ledger.ts";

const EVIDENCE_RE = /^- (\S+) \((.*?)(\d{4}-\d{2}-\d{2})\)\s*$/;
const MONTH_RE = /^- (\d{4}-\d{2}): (\d+) events? \((?:obs (\d+)(?:…(\d+))?)?(?:; )?(?:prs ([\d, ]+))?\)\s*$/;
const PROTECTED_TAGS = new Set(["decision", "security", "blocker"]);

/** `YYYY-MM-DD` minus `days`, as `YYYY-MM-DD`. Calendar arithmetic on the date alone. */
export function daysBefore(day: string, days: number): string {
  const at = new Date(`${day}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() - days);
  return at.toISOString().slice(0, 10);
}

interface Bucket {
  n: number;
  obs: number[];
  prs: Set<string>;
}

/**
 * Roll `## Evidence` lines older than 30 days up into one line per month. Recent
 * lines, prose between them, other sections and the frontmatter are kept. A
 * month line from an earlier pass is absorbed, so the result is idempotent.
 */
export function compactEvidence(text: string, today: string): string {
  const cutoff = daysBefore(today, 30);
  const lines = text.split("\n");
  const heading = lines.indexOf("## Evidence");
  if (heading < 0) return text;
  const start = heading + 1;
  let end = lines.length;
  for (let i = start; i < lines.length; i += 1) {
    if (lines[i]!.startsWith("## ")) {
      end = i;
      break;
    }
  }
  const months = new Map<string, Bucket>();
  const out: string[] = [];
  const bucket = (month: string): Bucket => {
    let found = months.get(month);
    if (found === undefined) {
      found = { n: 0, obs: [], prs: new Set() };
      months.set(month, found);
      out.push(`@@${month}`);
    }
    return found;
  };
  for (const line of lines.slice(start, end)) {
    const rolled = MONTH_RE.exec(line);
    if (rolled !== null) {
      const b = bucket(rolled[1]!);
      b.n += Number(rolled[2]);
      for (const value of [rolled[3], rolled[4]]) if (value) b.obs.push(Number(value));
      for (const pr of (rolled[5] ?? "").split(",")) if (pr.trim() !== "") b.prs.add(pr.trim());
      continue;
    }
    const match = EVIDENCE_RE.exec(line);
    if (match === null || match[3]! >= cutoff) {
      out.push(line);
      continue;
    }
    const b = bucket(match[3]!.slice(0, 7));
    b.n += 1;
    if (match[1]!.startsWith("obs:")) b.obs.push(Number(match[1]!.slice(4)));
    for (const pr of match[2]!.matchAll(/\bpr (\d+)/g)) b.prs.add(pr[1]!);
  }
  for (const [month, b] of months) {
    const parts: string[] = [];
    if (b.obs.length > 0)
      parts.push(b.obs.length > 1 ? `obs ${Math.min(...b.obs)}…${Math.max(...b.obs)}` : `obs ${b.obs[0]}`);
    if (b.prs.size > 0) parts.push(`prs ${[...b.prs].sort((x, y) => Number(x) - Number(y)).join(", ")}`);
    out[out.indexOf(`@@${month}`)] = `- ${month}: ${b.n} event${b.n === 1 ? "" : "s"} (${parts.join("; ")})`;
  }
  return [...lines.slice(0, start), ...out, ...lines.slice(end)].join("\n");
}

/**
 * Compact every review pattern page under the review ledger's lock. Returns the
 * number of pages changed, or -1 when the review loop holds the lock (the job
 * retries next week).
 */
export function compactReviewLedger(review: Ledger, today = todayLocal()): number {
  const dir = review.path("patterns");
  if (!existsSync(dir)) return 0;
  const release = review.tryLock();
  if (release === null) return -1;
  try {
    let changed = 0;
    for (const name of readdirSync(dir)
      .filter((file) => /^rp-.*\.md$/.test(file))
      .sort()) {
      const path = join(dir, name);
      const before = readFileSync(path, "utf8");
      const after = compactEvidence(before, today);
      if (after !== before) {
        writeGated(review.dir, path, after);
        changed += 1;
      }
    }
    if (changed > 0) review.commit("learn memory: compact evidence");
    return changed;
  } finally {
    release();
  }
}

export function decayLessons(ledger: Ledger, today = todayLocal()): string[] {
  const cutoff = daysBefore(today, 90);
  const stale: string[] = [];
  for (const [id, { meta, body, path }] of loadLessons(ledger)) {
    const guarded = meta.scope === "global" || list(meta.tags).some((tag) => PROTECTED_TAGS.has(tag));
    const lastSeen = str(meta.last_seen) || today;
    if (meta.status === "confirmed" && lastSeen < cutoff && !guarded) {
      writeLesson(path, { ...meta, status: "stale" }, body);
      stale.push(id);
    }
  }
  return stale;
}

/** `obs:N` to the claude-mem or captured worker session it came from, for every observation cited by a lesson, as nightly consolidation maps them. */
export function lessonObsSessions(ctx: LearnContext, ledger: Ledger): Map<string, string> {
  const ids = loadLessons(ledger)
    .values()
    .flatMap(({ meta }) => list(meta.evidence))
    .filter((id) => /^obs:\d+$/.test(id))
    .map((id) => Number(id.slice(4)))
    .toArray();
  if (ids.length === 0) return new Map();
  const mem = ClaudeMemSource.open(ctx.config.memDb);
  try {
    const source = new ProjectMemorySource(mem, WorkerSessionSource.open(ledger));
    return new Map([...source.observationSessions(ids)].map(([id, sid]) => [`obs:${id}`, sid8(sid).slice(1)]));
  } finally {
    mem?.close();
  }
}

function pairsOf(value: unknown, known: ReadonlyMap<string, unknown>): Array<[string, string]> {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (pair): pair is [string, string] =>
      Array.isArray(pair) && pair.length === 2 && pair.every((id) => typeof id === "string" && known.has(id)),
  );
}

export interface PairResult {
  merged: Array<[string, string]>;
  conflicts: Array<[string, string]>;
  /** Kept lessons a merge moved from `hypothesis` to `confirmed`. */
  confirmed: string[];
}

/**
 * Apply merge and contradiction pairs. A merge keeps the lower id, unions
 * evidence and tags (so the dropped page's decay protection survives), keeps
 * both statements, and recomputes status from the sessions the evidence spans
 * (`obs:N` through `obsSession`). A merge never lowers the session count and
 * never demotes a confirmed lesson.
 * A contradiction marks both sides `conflict`, which keeps them out of the
 * session-start block.
 */
export function applyPairs(
  ledger: Ledger,
  reply: Record<string, unknown>,
  today = todayLocal(),
  obsSession: ReadonlyMap<string, string> = new Map(),
): PairResult {
  const lessons = loadLessons(ledger);
  const result: PairResult = { merged: [], conflicts: [], confirmed: [] };
  for (const pair of pairsOf(reply.merge, lessons)) {
    if (pair[0] === pair[1]) continue;
    const [keep, drop] = [...pair].sort() as [string, string];
    const kept = lessons.get(keep)!;
    const dropped = lessons.get(drop)!;
    const km = kept.meta;
    const dm = dropped.meta;
    const before = km.status;
    km.evidence = [...new Set([...list(km.evidence), ...list(dm.evidence)])].sort();
    km.tags = [...new Set([...list(km.tags), ...list(dm.tags)])].sort();
    km.last_seen = [str(km.last_seen), str(dm.last_seen)].sort().at(-1)!;
    km.merged = [...new Set([...list(km.merged), drop])].sort();
    km.sessions = Math.max(
      sessionsOf(km.evidence, obsSession).size,
      Number(km.sessions) || 0,
      Number(dm.sessions) || 0,
    );
    if (km.status === "hypothesis") km.status = km.sessions >= 2 ? "confirmed" : "hypothesis";
    const body =
      `\n## Statement\n${str(km.statement)}\n\n## Merged from ${drop}\n${str(dm.statement)}\n\n## Evidence\n` +
      km.evidence.map((id) => `- ${id}\n`).join("");
    writeLesson(kept.path, km, body);
    kept.body = body;
    writeLesson(dropped.path, { ...dm, status: "superseded", valid_until: today, superseded_by: keep }, dropped.body);
    dropped.meta = { ...dm, status: "superseded", valid_until: today, superseded_by: keep };
    result.merged.push(pair);
    if (before !== "confirmed" && km.status === "confirmed") result.confirmed.push(keep);
  }
  for (const pair of pairsOf(reply.contradict, lessons)) {
    for (const id of pair) {
      const page = lessons.get(id)!;
      if (page.meta.status === "hypothesis" || page.meta.status === "confirmed") {
        page.meta = { ...page.meta, status: "conflict" };
        writeLesson(page.path, page.meta, page.body);
      }
    }
    result.conflicts.push(pair);
  }
  rewriteIndex(ledger);
  return result;
}

export const OUTPUT_CONTRACT = `Reply with {"merge": [["ls-001", "ls-002"]], "contradict": [["ls-003", "ls-004"]]}.
- merge: pairs that state the same lesson about the same subject.
- contradict: pairs that cannot both be true or give opposite instructions for the same situation.
- Only ids that appear in the index. Empty lists are fine.`;

export function deepPrompt(ctx: LearnContext, index: string): string {
  return buildPrompt("lesson-merger", OUTPUT_CONTRACT, [{ title: "Lessons index", body: index }], ctx.env);
}

export function deep(ctx: LearnContext, ledger: Ledger, root: string, review: Ledger | null, trigger = "tick"): string {
  const index = lessonsIndexText(ledger);
  if (ctx.config.dryRun) {
    ctx.io.out(deepPrompt(ctx, index));
    return "weekly: dry run";
  }
  const compacted = review === null ? 0 : compactReviewLedger(review);
  const stale = decayLessons(ledger);
  let pairs: PairResult = { merged: [], conflicts: [], confirmed: [] };
  // Inside a tick the run is the job's span; called on its own it keeps the dated id.
  const runId = runOf(ctx).runId ?? `weekly-${todayLocal()}-${nowMs() % 100_000}`;
  if (index !== "(none)") {
    const reply = ctx.judge(deepPrompt(ctx, index), {
      runId,
      traceId: runOf(ctx).traceId,
      loop: "memory",
      role: "lesson-merger",
      project: basename(root),
    });
    if (reply !== null) pairs = applyPairs(ledger, reply, todayLocal(), lessonObsSessions(ctx, ledger));
  }
  const lessons = loadLessons(ledger);
  const proposals: string[] = [];
  const skippedProposals: string[] = [];
  for (const id of pairs.confirmed) {
    const page = lessons.get(id);
    if (page === undefined) continue;
    const trig = list(page.meta.tags).includes("preference") ? "correction" : "failure";
    const proposal = proposeOrSkip(ctx, ledger, root, page, { runId, createdBy: "learn/lesson-merger", trigger: trig });
    if ("ref" in proposal) proposals.push(proposal.ref);
    else skippedProposals.push(proposal.skipped);
  }
  saveState(ledger, { ...readState(ledger), last_weekly: nowMs() });
  const run = {
    job: "weekly",
    id: runId,
    status: "ok",
    trigger,
    compacted_pages: compacted,
    stale_lessons: stale,
    merged: pairs.merged,
    conflicts: pairs.conflicts,
    proposals,
  };
  appendRun(ledger, skippedProposals.length > 0 ? { ...run, proposals_skipped: skippedProposals } : run);
  const compactNote =
    compacted === -1
      ? "evidence compaction skipped (review ledger locked, retries next week)"
      : `${compacted} review pattern pages compacted`;
  logLine(
    ledger,
    `weekly: ${compactNote}, ${stale.length} lessons stale, ${pairs.merged.length} merged, ${pairs.conflicts.length} conflicts`,
  );
  ledger.commit(`weekly ${runId}`);
  return `weekly: ${compactNote}, ${stale.length} stale, ${pairs.merged.length} merged, ${pairs.conflicts.length} conflicts`;
}
