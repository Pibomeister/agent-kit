/**
 * Pattern pages (`patterns/rp-NNN.md`) and the bookkeeping the judge may not
 * touch: counts, sources, statuses, ids and the index table are computed here
 * from the ledger, so a bad reply cannot inflate them.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Ledger } from "../core/ledger.ts";
import { type PageMeta, parsePage, patchBody, renderPage } from "../core/pages.ts";
import { appendGated, nowIso, readText, todayUtc, writeGated } from "../core/store.ts";
import type { ReviewEvent } from "./events.ts";
import { PATTERNS_HEADER, RUNS_HEADER } from "./ledger.ts";

export type PatternStatus = "candidate" | "active" | "retired";

export interface Pattern {
  id: string;
  meta: PageMeta;
  body: string;
  /** Absolute path of the page. */
  path: string;
}

/** Every `patterns/rp-*.md` page, keyed by its file name's id, in file-name order. */
export function loadPatterns(ledger: Ledger): Map<string, Pattern> {
  const dir = ledger.path("patterns");
  const out = new Map<string, Pattern>();
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)
    .filter((file) => /^rp-.*\.md$/.test(file))
    .sort()) {
    const path = ledger.path("patterns", name);
    const { meta, body } = parsePage(readFileSync(path, "utf8"));
    // The file name is the id. A frontmatter `id` is a copy the page carries, never a source of truth.
    const id = name.slice(0, -3);
    out.set(id, { id, meta: { ...meta, id }, body, path });
  }
  return out;
}

/** The page, `<ledger>/patterns/rp-NNN.md`, behind the secret gate of the ledger it sits in. */
export function savePattern(pattern: Pattern): void {
  mkdirSync(dirname(pattern.path), { recursive: true });
  writeGated(dirname(dirname(pattern.path)), pattern.path, renderPage(pattern.meta, pattern.body));
}

export function list(meta: PageMeta, key: string): string[] {
  const value = meta[key];
  return Array.isArray(value) ? value : [];
}

export function num(meta: PageMeta, key: string): number {
  const value = meta[key];
  if (typeof value === "number") return value;
  const parsed = typeof value === "string" ? Number.parseInt(value, 10) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

export function str(meta: PageMeta, key: string): string {
  const value = meta[key];
  return value === null || value === undefined || Array.isArray(value) ? "" : String(value);
}

/** The text under `## <name>`, up to the next `## ` heading, trimmed. */
export function section(body: string, name: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`^## ${escaped}\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, "m").exec(body);
  return match === null ? "" : match[1]!.trim();
}

/** The first line of a section, for one-line displays. */
export function firstLine(body: string, name: string): string {
  return section(body, name).split("\n")[0] ?? "";
}

export function nextId(patterns: ReadonlyMap<string, Pattern>): string {
  let max = 0;
  for (const id of patterns.keys()) {
    const n = Number.parseInt(id.replace(/\D/g, ""), 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return `rp-${String(max + 1).padStart(3, "0")}`;
}

/** Sources that all come from one pull request's review thread: one family, one opinion. */
const GITHUB_FAMILY: ReadonlySet<string> = new Set(["github", "github-reply", "author-reply", "review-report"]);

/**
 * The independence family of a source label, or null for a corroborating source.
 *
 * Two families are independent witnesses: `github` (every review-thread label folded into one) and
 * `correction` (the user correcting the agent). Every other source, `claude-mem` and `learn-memory`
 * included, observed or forwarded something a witness already said: a session reading a bot comment
 * records it as an observation, and the nightly consolidation forwards it again. Such an event
 * corroborates. It leaves evidence and raises the count, but it adds no family and no PR, and an
 * unknown label is treated the same way.
 */
export function sourceFamily(source: string): "github" | "correction" | null {
  if (GITHUB_FAMILY.has(source)) return "github";
  return source === "correction" ? "correction" : null;
}

/**
 * Active at `activeAt` events backed by either a direct user correction or two
 * distinct non-bot reviewers across independent PRs or source families;
 * candidate otherwise. A bot comment, its summary
 * report, the author's reply and any observation of them are one opinion, so
 * they never activate a pattern alone. Promotion requires `active`, so count
 * raised by corroborating events never promotes a pattern this gate has not
 * passed. Retired is sticky: only a human retires or revives.
 */
export function statusFor(meta: PageMeta, activeAt: number): PatternStatus {
  if (meta.status === "retired") return "retired";
  const sources = list(meta, "sources");
  const families = new Set(sources.flatMap((source) => sourceFamily(source) ?? [])).size;
  const distinct = Math.max(families, list(meta, "prs").length);
  const reviewers = new Set(list(meta, "reviewers").filter(isIndependentReviewer)).size;
  const trusted = sources.includes("correction") || (distinct >= 2 && reviewers >= 2);
  return num(meta, "count") >= activeAt && trusted ? "active" : "candidate";
}

const BOT_REVIEWER = /(?:\[bot\]|bot$|^bot(?:[-_.]|$))/i;

/** Labels the runtime gives an event that no host account wrote: an observation, a forwarded lesson, a correction. */
const RUNTIME_AUTHOR = /^(?:observer:.*|learn-memory|user)$/;

/**
 * A stored reviewer label that stands for one independent person on the review host. Automation and
 * the runtime's own author labels are not: pages written before reviewers were filtered still carry them.
 */
export function isIndependentReviewer(reviewer: string): boolean {
  return !BOT_REVIEWER.test(reviewer) && !RUNTIME_AUTHOR.test(reviewer);
}

function union(values: readonly string[], add: string): string[] {
  return [...new Set([...values, add])].sort();
}

/** `- <ref> (<author> <severity> pr <n> <date>)`: the evidence line an event leaves on a page. */
export function evidenceRef(event: ReviewEvent): string {
  const ref = event.url ?? (event.obs_id !== undefined ? `obs:${event.obs_id}` : event.hash);
  const extra = [
    event.author,
    event.severity,
    event.pr ? `pr ${event.pr}` : null,
    (event.ts ?? "").slice(0, 10),
  ].filter((part) => part);
  return `- ${ref} (${extra.join(" ")})`;
}

/**
 * Count one event against a page. The evidence line is added once, however often the event is replayed.
 * A resolution is a reply saying a finding was handled, not a second sighting: it leaves its evidence
 * line and changes no count, source, PR, reviewer or status. A corroborating source adds no PR.
 */
export function addEvidence(
  meta: PageMeta,
  body: string,
  event: ReviewEvent,
  activeAt: number,
): { meta: PageMeta; body: string } {
  const line = evidenceRef(event);
  const withLine = body.includes(line) ? body : patchBody(body, "append", "", line);
  if (event.kind === "resolution") return { meta: { ...meta }, body: withLine };
  const next: PageMeta = { ...meta };
  next.count = num(meta, "count") + 1;
  next.last_seen = (event.ts ?? nowIso()).slice(0, 10);
  next.sources = union(list(meta, "sources"), event.source);
  // Only a witness adds a PR: a corroborating event's PR number is hearsay about a thread it did not read.
  if (event.pr && sourceFamily(event.source) !== null)
    next.prs = union(list(meta, "prs").map(String), String(event.pr));
  if (event.author && sourceFamily(event.source) !== null)
    next.reviewers = union(list(meta, "reviewers"), event.author);
  next.status = statusFor(next, activeAt);
  return { meta: next, body: withLine };
}

export interface PatternSpec {
  title: string;
  problem: string;
  root_cause: string;
  fix: string;
  team_target: string | null;
}

/** A fresh candidate page. Its count starts at zero; matching events count it up. */
export function newPattern(ledger: Ledger, id: string, spec: PatternSpec, first: ReviewEvent): Pattern {
  const meta: PageMeta = {
    id,
    title: spec.title,
    status: "candidate",
    count: 0,
    first_seen: (first.ts ?? nowIso()).slice(0, 10),
    last_seen: "",
    sources: [],
    prs: [],
    reviewers: [],
    promoted_to: "",
    team_target: spec.team_target ?? "",
  };
  const body = `\n## Problem\n${spec.problem}\n\n## Root cause\n${spec.root_cause}\n\n## Fix\n${spec.fix}\n\n## Evidence\n`;
  return { id, meta, body, path: ledger.path("patterns", `${id}.md`) };
}

/** Run rows of `index.md`, oldest first. */
export function runRows(ledger: Ledger): string[] {
  const text = readText(ledger.path("index.md"));
  const runsPart = text.split("## Patterns")[0] ?? "";
  return runsPart.split("\n").filter((line) => /^\| \d{4}-/.test(line));
}

/** The repeat rate of the latest run, `n/a` before the first. */
export function lastRate(ledger: Ledger): string {
  const rows = runRows(ledger);
  const last = rows[rows.length - 1];
  if (last === undefined) return "n/a";
  const cells = last.split("|");
  return (cells[cells.length - 2] ?? "").trim() || "n/a";
}

/** Rewrite `index.md` from the pages, keeping every run row and appending `runRow` when given. */
export function rebuildIndex(ledger: Ledger, patterns: ReadonlyMap<string, Pattern>, runRow?: string): void {
  const rows = runRows(ledger);
  if (runRow !== undefined) rows.push(runRow);
  const patternRows = [...patterns.values()]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((p) => {
      const problem = firstLine(p.body, "Problem").slice(0, 80);
      const fix = firstLine(p.body, "Fix").slice(0, 80);
      const summary = `${str(p.meta, "title")}: ${problem} → ${fix}`;
      return `| ${p.id} | ${num(p.meta, "count")} | ${str(p.meta, "last_seen")} | ${str(p.meta, "status")} | ${summary} |`;
    });
  const block = (lines: string[]) => lines.map((line) => `${line}\n`).join("");
  writeGated(
    ledger.dir,
    ledger.path("index.md"),
    `# Review patterns\n\n## Runs\n\n${RUNS_HEADER}${block(rows)}\n## Patterns\n\n${PATTERNS_HEADER}${block(patternRows)}`,
  );
}

/** Append one line to the ledger's `log.md`. */
export function logLine(ledger: Ledger, text: string): void {
  appendGated(ledger.dir, ledger.path("log.md"), `\n- ${nowIso()} ${text}\n`);
}

/** Append one row to `skill-impact.md`: the record of what each promotion or retirement did to the repeat rate. */
export function impactRow(ledger: Ledger, action: string, patternId: string, note: string): void {
  appendGated(
    ledger.dir,
    ledger.path("skill-impact.md"),
    `| ${todayUtc()} | ${action} | ${patternId} | ${lastRate(ledger)} | ${note} |\n`,
  );
}
