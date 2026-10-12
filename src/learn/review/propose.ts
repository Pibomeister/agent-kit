/**
 * The proposer: an active pattern at `config.promoteAt` events becomes a
 * guardrail bullet (deployed through the session-start block) and a candidate
 * lesson draft for the knowledgebase (proposed, never published). A pattern
 * with a team target also becomes a pending team promotion, which a human
 * applies by hand.
 *
 * Also here: retire, rollback and the pending-promotion listing. Every writer
 * expects the caller to hold the ledger lock.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { unknownSelector } from "../../util/suggest.ts";
import type { LearnContext } from "../core/context.ts";
import type { Ledger } from "../core/ledger.ts";
import { mainRepoRoot } from "../core/paths.ts";
import { run } from "../core/proc.ts";
import { type Candidate, similarLine, similarTo } from "../core/similar.ts";
import { readText, SECRET_REDACTIONS_FILE, todayUtc, writeGated } from "../core/store.ts";
import { runOf } from "../core/trace.ts";
import { lessonDraft, proposeLesson } from "../kb.ts";
import { rawSnapshot } from "./events.ts";
import { EVENTS_FILE } from "./ledger.ts";
import { patternContent, PROCESSED_FILE } from "./maintain.ts";
import {
  firstLine,
  impactRow,
  list,
  loadPatterns,
  logLine,
  num,
  type Pattern,
  rebuildIndex,
  savePattern,
  section,
  statusFor,
  str,
} from "./patterns.ts";

export function bullet(pattern: Pattern): string {
  const fix = firstLine(pattern.body, "Fix").trim() || str(pattern.meta, "title");
  return `- [${pattern.id}] ${fix}`;
}

function evidenceLines(pattern: Pattern): string[] {
  return section(pattern.body, "Evidence")
    .split("\n")
    .map((line) => line.replace(/^- /, "").trim())
    .filter((line) => line !== "");
}

/** The candidate lesson a promoted guardrail proposes to the knowledgebase. */
export function guardrailDraft(
  ctx: LearnContext,
  pattern: Pattern,
  root: string,
  at: Date = new Date(),
): Record<string, unknown> {
  const evidence = evidenceLines(pattern).map((line) => {
    const ref = line.split(" ")[0]!;
    return {
      ref: /^https?:\/\//.test(ref) ? ref : `review-ledger:${ref}`,
      kind: /^https?:\/\//.test(ref) ? ("url" as const) : ("receipt" as const),
      note: line,
    };
  });
  const revision = ctx.config.dryRun ? null : headRevision(root);
  return lessonDraft(
    {
      localId: pattern.id,
      title: str(pattern.meta, "title"),
      statement: firstLine(pattern.body, "Fix").trim() || str(pattern.meta, "title"),
      trigger: "surprising-review-result",
      occurrence: { id: pattern.id, content: { meta: pattern.meta, problem: section(pattern.body, "Problem") } },
      evidence: evidence.length > 0 ? evidence : [{ ref: `review-ledger:patterns/${pattern.id}.md`, kind: "receipt" }],
      domains: ["code-review"],
      guidance: [section(pattern.body, "Root cause")].filter((line) => line !== ""),
      createdBy: "learn/pattern-maintainer",
    },
    { root, revision },
    // Inside a run the draft carries the run's span id; a hand promotion outside one keeps the dated id.
    runOf(ctx).runId ?? `learn-review-${todayUtc(at).replace(/-/g, "")}`,
    at,
  );
}

function headRevision(root: string): string | null {
  const repo = mainRepoRoot(root);
  if (repo === null) return null;
  const result = run(["git", "rev-parse", "HEAD"], { cwd: repo, timeoutMs: 10_000 });
  const sha = result.stdout.trim();
  return result.code === 0 && /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}

function teamProposal(pattern: Pattern): string {
  return (
    `\n## ${pattern.id} → \`${str(pattern.meta, "team_target")}\`\n\n` +
    `count: ${num(pattern.meta, "count")} · prs: ${list(pattern.meta, "prs").join(", ")}\n\n` +
    `Proposed line:\n\n${bullet(pattern)}\n\nWhy: ${firstLine(pattern.body, "Problem")}\n\napplied: \n`
  );
}

/**
 * Guardrails a new draft resembles: every other pattern already promoted or
 * retired, compared on title, problem, root cause and fix. A retired one is
 * listed too, because a guardrail that was tried and withdrawn is what a
 * reviewer most needs to see beside its near-copy.
 */
export function similarGuardrails(pattern: Pattern, patterns: ReadonlyMap<string, Pattern>): Candidate[] {
  const pool = patterns
    .values()
    .filter((p) => p.id !== pattern.id && (p.meta.promoted_to === "guardrails" || p.meta.status === "retired"))
    .map((p) => ({ id: p.id, status: str(p.meta, "status"), text: guardrailText(p) }));
  return similarTo(guardrailText(pattern), pool);
}

function guardrailText(pattern: Pattern): string {
  return `${str(pattern.meta, "title")}\n${patternContent(pattern)}`;
}

interface Promotion {
  /** A team proposal was added. */
  team: boolean;
  /** Guardrails the draft resembles. */
  similar: Candidate[];
}

/**
 * Promote one pattern in memory: guardrail bullet, bookkeeping, impact row,
 * team proposal and knowledgebase draft, with the guardrails it resembles
 * beside the draft. Returns whether a team proposal was added and those
 * resembling guardrails.
 */
function promoteOne(
  ctx: LearnContext,
  ledger: Ledger,
  root: string,
  pattern: Pattern,
  patterns: ReadonlyMap<string, Pattern>,
  texts: { guard: string; pending: string },
): Promotion {
  const similar = similarGuardrails(pattern, patterns);
  texts.guard = `${texts.guard.replace(/\n+$/, "")}${texts.guard.trim() === "" ? "" : "\n"}${bullet(pattern)}\n`;
  pattern.meta.promoted_to = "guardrails";
  pattern.meta.promoted_count = num(pattern.meta, "count");
  impactRow(ledger, "promote", pattern.id, str(pattern.meta, "title"));
  let proposed = false;
  if (str(pattern.meta, "team_target") !== "" && !texts.pending.includes(`## ${pattern.id} `)) {
    texts.pending += teamProposal(pattern);
    proposed = true;
  }
  try {
    proposeLesson(ctx, ledger.dir, guardrailDraft(ctx, pattern, root), similar);
  } catch (error) {
    // One unusable draft skips its own knowledgebase proposal; the guardrail and every other promotion stand.
    logLine(ledger, `skipped knowledgebase draft for ${pattern.id}: ${(error as Error).message}`);
  }
  if (similar.length > 0) logLine(ledger, `similar ${similarLine(pattern.id, similar)}: amend or supersede`);
  savePattern(pattern);
  return { team: proposed, similar };
}

export interface SkillCandidate {
  pattern: Pattern;
  reason: "guardrail bullet did not stop recurrence" | "fix is a multi-step procedure";
}

/**
 * Promoted patterns that a bullet is not enough for: at least two new events
 * since promotion, or a fix of more than one line. The skills loop decides
 * what to do with them; this loop only names them.
 */
export function skillCandidates(patterns: ReadonlyMap<string, Pattern>): SkillCandidate[] {
  const out: SkillCandidate[] = [];
  for (const pattern of patterns.values()) {
    const { meta } = pattern;
    if (
      meta.status !== "active" ||
      meta.promoted_to !== "guardrails" ||
      str(meta, "skill_candidate") !== "" ||
      num(meta, "promoted_count") === 0
    )
      continue;
    const since = num(meta, "count") - num(meta, "promoted_count");
    const steps = section(pattern.body, "Fix")
      .split("\n")
      .filter((line) => line.trim() !== "").length;
    if (since >= 2) out.push({ pattern, reason: "guardrail bullet did not stop recurrence" });
    else if (steps >= 2) out.push({ pattern, reason: "fix is a multi-step procedure" });
  }
  return out;
}

/** Promote every active pattern at or over the threshold that is not promoted yet, then commit. */
export function propose(ctx: LearnContext, ledger: Ledger, root: string, threshold = ctx.config.promoteAt): string {
  const patterns = loadPatterns(ledger);
  const texts = {
    guard: readText(ledger.path("guardrails.md")),
    pending: readText(ledger.path("pending-team-promotions.md")),
  };
  const promoted: string[] = [];
  const proposed: string[] = [];
  const similar: string[] = [];
  let baselined = false;
  for (const pattern of patterns.values()) {
    // A promotion recorded before `promoted_count` existed: today's count becomes its baseline.
    if (pattern.meta.promoted_to === "guardrails" && num(pattern.meta, "promoted_count") === 0) {
      pattern.meta.promoted_count = num(pattern.meta, "count");
      if (!ctx.config.dryRun) savePattern(pattern);
      baselined = true;
      continue;
    }
    if (
      pattern.meta.status !== "active" ||
      statusFor(pattern.meta, ctx.config.activeAt) !== "active" ||
      num(pattern.meta, "count") < threshold ||
      str(pattern.meta, "promoted_to") !== ""
    )
      continue;
    promoted.push(pattern.id);
    if (ctx.config.dryRun) continue;
    const result = promoteOne(ctx, ledger, root, pattern, patterns, texts);
    if (result.team) proposed.push(pattern.id);
    if (result.similar.length > 0) similar.push(`; similar ${similarLine(pattern.id, result.similar)}`);
  }
  if (promoted.length === 0) {
    ctx.span?.status(ctx.config.dryRun ? "dry-run" : "nothing");
    if (baselined && !ctx.config.dryRun) {
      const sha = ledger.commit("propose: bookkeeping (promoted_count baseline)");
      ctx.span?.commit(sha);
    }
    return "nothing to promote";
  }
  ctx.span?.attr("promoted", promoted);
  if (ctx.config.dryRun) {
    ctx.span?.status("dry-run");
    return `dry run: would promote ${promoted.join(",")}`;
  }
  writeGated(ledger.dir, ledger.path("guardrails.md"), texts.guard);
  writeGated(ledger.dir, ledger.path("pending-team-promotions.md"), texts.pending);
  rebuildIndex(ledger, patterns);
  const teamNote = proposed.length > 0 ? `; team proposals ${proposed.join(",")}` : "";
  const sha = ledger.commit(`propose: guardrails +${promoted.join(",")}${teamNote}`);
  ctx.span?.commit(sha);
  return `promoted ${promoted.join(",")} to guardrails${teamNote}${similar.join("")}`;
}

/** A human's promotion of one pattern, whatever its count. A retired or already promoted pattern is refused. */
export function promoteById(ctx: LearnContext, ledger: Ledger, root: string, id: string): string {
  const patterns = loadPatterns(ledger);
  const pattern = patterns.get(id);
  if (pattern === undefined) return unknownSelector("pattern", id, [...patterns.keys()]);
  if (pattern.meta.status === "retired") return `${id} is retired`;
  if (str(pattern.meta, "promoted_to") !== "")
    return `${id} is already promoted to ${str(pattern.meta, "promoted_to")}`;
  if (ctx.config.dryRun) return `dry run: would promote ${id}`;
  const texts = {
    guard: readText(ledger.path("guardrails.md")),
    pending: readText(ledger.path("pending-team-promotions.md")),
  };
  const { team, similar } = promoteOne(ctx, ledger, root, pattern, patterns, texts);
  writeGated(ledger.dir, ledger.path("guardrails.md"), texts.guard);
  writeGated(ledger.dir, ledger.path("pending-team-promotions.md"), texts.pending);
  rebuildIndex(ledger, patterns);
  ledger.commit(`promote: guardrails +${id} (by hand)${team ? `; team proposal ${id}` : ""}`);
  const similarNote = similar.length > 0 ? `; similar ${similarLine(id, similar)}` : "";
  return `promoted ${id} to guardrails${team ? `; team proposal ${id}` : ""}${similarNote}`;
}

/**
 * Remove a pattern's bullet and mark it retired. The page and its evidence stay on record.
 * A dry run looks the pattern up and writes nothing, so it refuses an unknown id as the real run would.
 */
export function retire(ledger: Ledger, id: string, dryRun = false): string {
  const patterns = loadPatterns(ledger);
  const pattern = patterns.get(id);
  if (pattern === undefined) return unknownSelector("pattern", id, [...patterns.keys()]);
  if (dryRun) return `dry run: would retire ${id}`;
  pattern.meta.status = "retired";
  pattern.meta.promoted_to = "";
  savePattern(pattern);
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const guard = ledger.path("guardrails.md");
  writeGated(ledger.dir, guard, readText(guard).replace(new RegExp(`^- \\[${escaped}\\].*\\n?`, "gm"), ""));
  impactRow(ledger, "retire", id, "bullet removed, page kept");
  rebuildIndex(ledger, patterns);
  ledger.commit(`retire: ${id}`);
  return `retired ${id}; guardrail bullet removed, pattern page kept`;
}

/**
 * The paths a rollback restores: judgement and policy, plus the processed map, so the events
 * whose classification is undone are classified again on the next maintain. The raw events, the
 * secret gate's redaction record and the maintainer log are records of what happened and are
 * never rolled back.
 */
export const ROLLBACK_PATHS: readonly string[] = [
  "patterns",
  "index.md",
  "guardrails.md",
  "pending-team-promotions.md",
  "skill-impact.md",
  PROCESSED_FILE,
];

/**
 * Revert the ledger's latest commit, or restore the ledger to `to`.
 *
 * `--to` is all or nothing: every rollback path is restored to its content at
 * `to` and committed once, rather than reverting commit by commit, where a
 * conflict halfway would leave the ledger half rolled back. The raw events file
 * is never touched.
 */
export function rollback(ledger: Ledger, to?: string): string {
  if (to === undefined) {
    const head = ledger.head();
    if (head === null) return "nothing to roll back";
    const subject = ledger.git(["log", "-1", "--format=%s", head]).stdout.trim();
    const raw = RAW_FILES.map((file) => [file, rawSnapshot(ledger, file)] as const);
    if (!ledger.revert(head)) return `revert of '${subject}' failed; nothing was changed`;
    keepRaw(ledger, raw);
    return `reverted '${subject}'`;
  }
  const sha = ledger.git(["rev-parse", "--verify", "--quiet", `${to}^{commit}`]).stdout.trim();
  if (sha === "") return ledger.unknownRevision(to);
  if (ledger.git(["merge-base", "--is-ancestor", sha, "HEAD"]).code !== 0)
    return `${to} is not an ancestor of the ledger's HEAD`;
  const dirty = ledger
    .git(["status", "--porcelain", "--", ...ROLLBACK_PATHS])
    .stdout.split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => line.slice(3));
  if (dirty.length > 0) return `the ledger has uncommitted changes (${dirty.join(", ")}); nothing was changed`;
  const changed = ledger
    .git(["diff", "--name-only", sha, "HEAD", "--", ...ROLLBACK_PATHS])
    .stdout.split("\n")
    .filter((line) => line !== "");
  if (changed.length === 0) return "nothing to roll back";
  const subjects = ledger
    .git(["log", "--format=%s", `${sha}..HEAD`])
    .stdout.split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const failure = restorePaths(ledger, sha, changed);
  if (failure !== null) {
    restorePaths(ledger, "HEAD", changed);
    return `restoring ${to} failed on ${failure}; nothing was changed`;
  }
  const listed = subjects.map((subject) => `'${subject}'`).join(", ");
  ledger.commit(`rollback: restore ${sha.slice(0, 12)}\n\nReverted ${listed}`);
  return `reverted ${listed}`;
}

/** Put each path back to its content at `rev`, removing it where `rev` has none. Returns the first path that failed, or null. */
function restorePaths(ledger: Ledger, rev: string, paths: readonly string[]): string | null {
  for (const path of paths) {
    if (ledger.git(["cat-file", "-e", `${rev}:${path}`]).code === 0) {
      if (ledger.git(["checkout", rev, "--", path]).code !== 0) return path;
    } else {
      rmSync(ledger.path(path), { force: true });
    }
  }
  return null;
}

/** The append-only files a revert of the latest commit must leave as they were. */
const RAW_FILES = [EVENTS_FILE, SECRET_REDACTIONS_FILE] as const;

/** After a revert, put back any raw rows it removed, in a commit of its own. */
function keepRaw(ledger: Ledger, raw: ReadonlyArray<readonly [string, Buffer | null]>): void {
  const restored: string[] = [];
  for (const [file, bytes] of raw) {
    if (bytes === null || bytes.equals(rawSnapshot(ledger, file) ?? Buffer.alloc(0))) continue;
    mkdirSync(ledger.path("raw"), { recursive: true });
    writeFileSync(ledger.path(file), bytes);
    restored.push(file);
  }
  if (restored.length > 0) ledger.commit(`rollback: keep ${restored.join(", ")} append-only`);
}

export function pendingPromotions(ledger: Ledger): string {
  return readText(ledger.path("pending-team-promotions.md"));
}
