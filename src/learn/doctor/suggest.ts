/**
 * Findings and skill edits from the failed sessions, and the record of what
 * became of each proposed edit.
 *
 * The judge (`roles/learn/skill-doctor/ROLE.md`) names an edit as exact
 * replacements in the skill's current file, and the runtime applies them. A
 * replacement whose old text is not in the file exactly once, an edit that
 * renames the skill, and a suggestion with no failed session behind it are
 * all dropped and listed with the gate that dropped them: an edit is accepted
 * into the report only after it validates against the file it changes, which
 * is the SkillOpt half of the design. The WikiSkill half is the impact record:
 * every proposal, and the human's accept or reject with a reason, is kept in
 * the skills ledger, and the next run reads it so a rejected rule is not
 * proposed again (`research/sources/wikiskill-summary.md`).
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { LearnContext } from "../core/context.ts";
import { declaredUnavailable } from "../core/judge.ts";
import type { Ledger } from "../core/ledger.ts";
import { buildPrompt } from "../core/roles.ts";
import { nowIso, readJson, writeGated, writeJson } from "../core/store.ts";
import { scrubCaptured } from "../memory/redact.ts";
import type { ClaudeMemSource } from "../sources/claude-mem.ts";
import type { DoctorSession, SkillInfo } from "./collect.ts";
import { frontmatter, truncate } from "./collect.ts";
import { array, items, judgeObject, objects, parseJson, text, type JsonObject, type JsonValue } from "./json.ts";
import type { Aggregate, Scorer, SessionScore } from "./score.ts";
import { SCORERS } from "./score.ts";

export const MAX_FINDINGS = 3;
export const MAX_SUGGESTIONS = 5;
const SKILL_TEXT_CHARS = 12_000;
const SKILL_TEXT_TOTAL = 60_000;
const SUMMARY_CHARS = 400;
const FIELD_CHARS = 400;
const MOMENT_CHARS = 240;
/** The authoring contract's hard cap on a skill body. */
export const MAX_SKILL_LINES = 300;

export interface Evidence {
  session: string;
  scorer: string;
  moment: string;
}

export interface Suggestion {
  /** Assigned by the runtime: `<run>-<n>`. */
  id: string;
  skill: string;
  kind: "edit" | "new";
  change: string;
  rule: string;
  evidence: Evidence[];
  /** Unified diff from the current file, or the new file as an addition. Computed here, never by the judge. */
  diff: string;
  /** Path of the skill file the edit is against; absent for a new skill. */
  path?: string;
  /** The complete proposed file. */
  proposed: string;
}

export interface Dropped {
  skill: string;
  change: string;
  gate: string;
}

export interface Advice {
  status: "ok" | "unavailable";
  why?: string;
  findings: string[];
  suggestions: Suggestion[];
  dropped: Dropped[];
  deferred: Array<{ finding: string; why: string }>;
}

export interface ImpactEntry {
  id: string;
  run: string;
  at: string;
  skill: string;
  kind: Suggestion["kind"];
  rule: string;
  change: string;
  diff: string;
  status: "proposed" | "accepted" | "rejected";
  decided_at?: string;
  reason?: string;
}

export const SKILL_DOCTOR_CONTRACT = `{
  "findings": ["<one concrete sentence per pattern, at most ${MAX_FINDINGS}>"],
  "suggestions": [{
    "skill": "<an installed skill name exactly as listed, or a new lowercase-kebab name>",
    "kind": "edit | new",
    "change": "<one sentence: what the edit does>",
    "rule": "<the one reusable rule the skill should state>",
    "evidence": [{"session": "<a failed session key exactly as given>", "scorer": "<rubric>", "moment": "<what happened, at most ${MOMENT_CHARS} characters>"}],
    "replace": [{"old": "<text copied exactly from the current SKILL.md, unique in it>", "new": "<its replacement>"}],
    "content": "<for kind new only: the complete SKILL.md, starting with its frontmatter>"
  }],
  "deferred": [{"finding": "<a pattern seen>", "why": "<why no edit clears the bar>"}]
}
At most ${MAX_SUGGESTIONS} suggestions. An edit uses "replace" and no "content"; a new skill uses "content" and no "replace".`;

function str(value: JsonValue | undefined, limit = FIELD_CHARS): string {
  const found = text(value);
  return found === null ? "" : truncate(found, limit);
}

function isScorer(name: string): name is Scorer {
  return SCORERS.some((scorer) => scorer === name);
}

export interface DiffOp {
  op: " " | "-" | "+";
  line: string;
  ai: number;
  bi: number;
}

/** A file's lines; the newline that ends the last line does not start another. */
function diffLines(source: string): string[] {
  return source === "" ? [] : source.replace(/\n$/, "").split("\n");
}

/** The line operations that turn `before` into `after`. Skill files are short, so a plain LCS table is enough. */
export function diffOps(before: string, after: string): DiffOp[] {
  const a = diffLines(before);
  const b = diffLines(after);
  const table = Array.from({ length: a.length + 1 }, () => Array.from({ length: b.length + 1 }, () => 0));
  const cell = (row: number, column: number): number => table[row]?.[column] ?? 0;
  for (let i = a.length - 1; i >= 0; i -= 1) {
    const row = table[i];
    if (row !== undefined)
      for (let j = b.length - 1; j >= 0; j -= 1)
        row[j] = a[i] === b[j] ? cell(i + 1, j + 1) + 1 : Math.max(cell(i + 1, j), cell(i, j + 1));
  }
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    const left = a[i];
    const right = b[j];
    if (left !== undefined && left === right) ops.push({ op: " ", line: left, ai: i++, bi: j++ });
    else if (left !== undefined && (right === undefined || cell(i + 1, j) >= cell(i, j + 1)))
      ops.push({ op: "-", line: left, ai: i++, bi: j });
    else if (right !== undefined) ops.push({ op: "+", line: right, ai: i, bi: j++ });
    else break;
  }
  return ops;
}

/** A line-based unified diff with three lines of context. */
export function unifiedDiff(before: string, after: string, label: string): string {
  const ops = diffOps(before, after);
  const changed = ops.flatMap((op, index) => (op.op === " " ? [] : [index]));
  if (changed.length === 0) return "";
  const hunks: Array<[number, number]> = [];
  for (const index of changed) {
    const start = Math.max(0, index - 3);
    const end = Math.min(ops.length - 1, index + 3);
    const last = hunks.at(-1);
    if (last !== undefined && start <= last[1] + 1) last[1] = end;
    else hunks.push([start, end]);
  }
  const out = [`--- a/${label}`, `+++ b/${label}`];
  for (const [start, end] of hunks) {
    const slice = ops.slice(start, end + 1);
    const [first] = slice;
    if (first === undefined) continue;
    const aCount = slice.filter((op) => op.op !== "+").length;
    const bCount = slice.filter((op) => op.op !== "-").length;
    out.push(`@@ -${first.ai + (aCount === 0 ? 0 : 1)},${aCount} +${first.bi + (bCount === 0 ? 0 : 1)},${bCount} @@`);
    for (const op of slice) out.push(`${op.op}${op.line}`);
  }
  return `${out.join("\n")}\n`;
}

function occurrences(haystack: string, needle: string): number {
  if (needle === "") return 0;
  let count = 0;
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + needle.length)) count += 1;
  return count;
}

export function normalRule(rule: string): string {
  return rule
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, " ")
    .trim();
}

interface GateInput {
  failed: ReadonlySet<string>;
  skills: ReadonlyMap<string, SkillInfo>;
  rejectedRules: ReadonlyMap<string, ReadonlySet<string>>;
  readSkill: (path: string) => string | null;
}

/** One suggestion through every gate, or the gate that refused it. */
export function gateSuggestion(
  raw: JsonObject,
  id: string,
  input: GateInput,
): { suggestion: Suggestion } | { dropped: Dropped } {
  const skill = str(raw.skill, 80).toLowerCase();
  const change = str(raw.change);
  const rule = str(raw.rule);
  const kind = raw.kind === "new" ? "new" : raw.kind === "edit" ? "edit" : null;
  const drop = (gate: string) => ({ dropped: { skill: skill || "(unnamed)", change, gate } });
  if (skill === "" || change === "" || rule === "" || kind === null) return drop("missing skill, kind, change or rule");
  const evidence = objects(raw.evidence)
    .map((item) => ({
      session: str(item.session, 200),
      scorer: str(item.scorer, 40),
      moment: str(item.moment, MOMENT_CHARS),
    }))
    .filter((item) => input.failed.has(item.session) && isScorer(item.scorer));
  if (evidence.length === 0) return drop("no evidence from a failed session");
  if (input.rejectedRules.get(skill)?.has(normalRule(rule)) === true) return drop("a human rejected this rule before");
  if (kind === "new") {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+){0,4}$/.test(skill)) return drop("a new skill name must be lowercase kebab");
    if (input.skills.has(skill)) return drop("a new skill may not reuse an installed name");
    const content = (text(raw.content) ?? "").replaceAll("\r\n", "\n");
    if (frontmatter(content).name !== skill) return drop("a new skill's frontmatter must name it");
    if (content.split("\n").length > MAX_SKILL_LINES) return drop(`a skill body is capped at ${MAX_SKILL_LINES} lines`);
    return {
      suggestion: {
        id,
        skill,
        kind,
        change,
        rule,
        evidence,
        diff: unifiedDiff("", content, `${skill}/SKILL.md`),
        proposed: content,
      },
    };
  }
  const info = input.skills.get(skill);
  if (info === undefined) return drop("an edit must name an installed skill");
  const current = input.readSkill(info.path);
  if (current === null) return drop("the skill file could not be read");
  const replacements = objects(raw.replace);
  if (replacements.length === 0) return drop("an edit needs at least one replacement");
  let proposed = current;
  for (const pair of replacements) {
    const old = text(pair.old) ?? "";
    const next = text(pair.new);
    if (next === null || occurrences(proposed, old) !== 1)
      return drop("a replacement's old text is not in the file exactly once");
    proposed = proposed.replace(old, () => next);
  }
  if (proposed === current) return drop("the edit changes nothing");
  if (frontmatter(proposed).name !== frontmatter(current).name) return drop("an edit may not rename the skill");
  if (proposed.split("\n").length > MAX_SKILL_LINES) return drop(`a skill body is capped at ${MAX_SKILL_LINES} lines`);
  return {
    suggestion: {
      id,
      skill,
      kind,
      change,
      rule,
      evidence,
      diff: unifiedDiff(current, proposed, `${skill}/SKILL.md`),
      path: info.path,
      proposed,
    },
  };
}

function readSkillFile(path: string): string | null {
  try {
    return readFileSync(path, "utf8").replaceAll("\r\n", "\n");
  } catch {
    return null;
  }
}

/** The judge's reply through the gates. Findings are capped and trimmed; nothing else is taken from it. */
export function parseAdvice(reply: JsonObject | null, run: string, input: GateInput): Advice {
  const declared = declaredUnavailable(reply);
  if (reply === null || declared !== null)
    return {
      status: "unavailable",
      why: declared ?? "no usable reply",
      findings: [],
      suggestions: [],
      dropped: [],
      deferred: [],
    };
  if (array(reply.findings) === null || array(reply.suggestions) === null)
    return {
      status: "unavailable",
      why: "the reply is off contract: findings and suggestions must both be arrays",
      findings: [],
      suggestions: [],
      dropped: [],
      deferred: [],
    };
  const findings = items(reply.findings)
    .map((item) => str(item))
    .filter((item) => item !== "")
    .slice(0, MAX_FINDINGS);
  const suggestions: Suggestion[] = [];
  const dropped: Dropped[] = [];
  for (const raw of objects(reply.suggestions).slice(0, MAX_SUGGESTIONS)) {
    const gated = gateSuggestion(raw, `${run}-${suggestions.length + dropped.length + 1}`, input);
    if ("suggestion" in gated) suggestions.push(gated.suggestion);
    else dropped.push(gated.dropped);
  }
  const deferred = objects(reply.deferred)
    .map((item) => ({ finding: str(item.finding), why: str(item.why) }))
    .filter((item) => item.finding !== "");
  return { status: "ok", findings, suggestions, dropped, deferred };
}

function sessionBlock(score: SessionScore, summary: string | null): string {
  const lines = [
    `#### ${score.key}${score.failed ? " (failed)" : ""}`,
    `- host: ${score.host}; skills: ${score.skills_used.join(", ") || "(none)"}; user corrections: ${score.corrections}`,
  ];
  for (const scorer of SCORERS) {
    const result = score.results[scorer];
    if (result !== undefined) lines.push(`- ${scorer}: ${result.label} — ${result.reason}`);
  }
  if (summary !== null) lines.push(`- claude-mem summary: ${summary}`);
  return lines.join("\n");
}

function skillTexts(skills: readonly SkillInfo[], names: ReadonlySet<string>): string {
  let budget = SKILL_TEXT_TOTAL;
  const parts: string[] = [];
  for (const skill of skills) {
    if (!names.has(skill.name)) continue;
    const body = readSkillFile(skill.path);
    if (body === null || budget <= 0) continue;
    const shown = body.slice(0, Math.min(SKILL_TEXT_CHARS, budget));
    budget -= shown.length;
    parts.push(`#### ${skill.name} (${skill.scope})\n\n\`\`\`markdown\n${shown.replaceAll("```", "'''")}\n\`\`\``);
  }
  return parts.join("\n\n") || "No skill file was used in a failed session.";
}

function impactLines(entries: readonly ImpactEntry[]): string {
  const decided = entries.filter((entry) => entry.status !== "proposed");
  if (decided.length === 0) return "No earlier proposal has been accepted or rejected.";
  return decided
    .map(
      (entry) =>
        `- ${entry.status}: ${entry.skill} — rule: ${entry.rule}${entry.reason ? ` — reason: ${entry.reason}` : ""}`,
    )
    .join("\n");
}

/** A claude-mem summary of a host session, scrubbed like a transcript, when claude-mem observed it. Read-only; absent claude-mem gives null. */
function memSummary(mem: ClaudeMemSource | null, session: DoctorSession): string | null {
  const row = mem?.summaryForSession(session.id) ?? null;
  if (row === null) return null;
  const joined = [row.request, row.completed].filter((part) => part).join(" / ");
  return joined === "" ? null : truncate(scrubCaptured(joined), SUMMARY_CHARS);
}

export interface AdviseInput {
  run: string;
  project: string;
  sessions: readonly DoctorSession[];
  scores: readonly SessionScore[];
  aggregate: Aggregate;
  skills: readonly SkillInfo[];
  impact: readonly ImpactEntry[];
  mem: ClaudeMemSource | null;
}

/** The skill-doctor prompt: the run's scores, every scored session, the skills the failed ones used, and the impact record. */
export function advicePrompt(input: AdviseInput, env: NodeJS.ProcessEnv): string {
  const byKey = new Map(input.sessions.map((session) => [session.key, session]));
  const failed = new Set(input.aggregate.failed);
  const scored = input.scores.filter((score) => score.status === "scored");
  const usedInFailed = new Set(scored.filter((score) => failed.has(score.key)).flatMap((score) => score.skills_used));
  const summary = [
    `overall ${input.aggregate.scores?.overall.toFixed(2) ?? "n/a"} (${input.aggregate.grade ?? "no grade"}); ${input.aggregate.sessions_scored} scored, ${failed.size} failed`,
    ...SCORERS.map((scorer) => `- ${scorer}: raw ${input.aggregate.raw[scorer]?.toFixed(2) ?? "n/a"}`),
    `- skill coverage: ${input.aggregate.scores?.skill_coverage.toFixed(2) ?? "n/a"}`,
  ].join("\n");
  return buildPrompt(
    "skill-doctor",
    SKILL_DOCTOR_CONTRACT,
    [
      { title: "Run summary", body: summary },
      { title: "Failed session keys", body: [...failed].join("\n") || "(none: no session failed)" },
      {
        title: "Scored sessions",
        body: scored
          .map((score) => {
            const session = byKey.get(score.key);
            return sessionBlock(score, session === undefined ? null : memSummary(input.mem, session));
          })
          .join("\n\n"),
      },
      {
        title: "Installed skills",
        body:
          input.skills
            .map((skill) => `- ${skill.name} (${skill.scope}): ${skill.description || "(no description)"}`)
            .join("\n") || "(none)",
      },
      { title: "Current text of the skills the failed sessions used", body: skillTexts(input.skills, usedInFailed) },
      { title: "Earlier proposals and their outcome (skill-impact)", body: impactLines(input.impact) },
    ],
    env,
  );
}

/** One judge call over the scored run, then the gates. */
export function advise(ctx: LearnContext, input: AdviseInput): Advice {
  const reply = judgeObject(ctx, advicePrompt(input, ctx.env), {
    runId: null,
    loop: "skills",
    role: "skill-doctor",
    project: input.project,
  });
  const rejectedRules = new Map<string, Set<string>>();
  for (const entry of input.impact) {
    if (entry.status !== "rejected") continue;
    const set = rejectedRules.get(entry.skill) ?? new Set<string>();
    set.add(normalRule(entry.rule));
    rejectedRules.set(entry.skill, set);
  }
  return parseAdvice(reply, input.run, {
    failed: new Set(input.aggregate.failed),
    skills: new Map(input.skills.map((skill) => [skill.name, skill])),
    rejectedRules,
    readSkill: readSkillFile,
  });
}

export const IMPACT_FILE = "doctor/impact.json";
export const IMPACT_PAGE = "wiki/skill-impact.md";
export const RUNS_DIR = "doctor/runs";

/** The impact record exists and is not an array: writing over it would lose every recorded decision. */
export class CorruptImpactError extends Error {}

/** The impact record, empty when there is none yet. Throws `CorruptImpactError` when the file is not an array. */
export function loadImpact(ledgerDir: string): ImpactEntry[] {
  const path = join(ledgerDir, IMPACT_FILE);
  if (!existsSync(path)) return [];
  if (array(parseJson(readFileSync(path, "utf8")) ?? undefined) === null)
    throw new CorruptImpactError(`${path} is not a JSON array; repair or restore it from the ledger's history`);
  return readJson<ImpactEntry[]>(path, []);
}

/** The impact record as a page a human reads: newest first, each proposal with its rule, outcome and diff. */
export function renderImpactPage(entries: readonly ImpactEntry[]): string {
  const lines = ["# Skill impact", "", "Every edit the skill doctor proposed, and what became of it.", ""];
  for (const entry of entries.toReversed()) {
    lines.push(`## ${entry.id} — ${entry.skill} (${entry.status})`, "");
    lines.push(`- proposed: ${entry.at}`, `- rule: ${entry.rule}`, `- change: ${entry.change}`);
    if (entry.decided_at !== undefined) lines.push(`- decided: ${entry.decided_at}`);
    if (entry.reason !== undefined) lines.push(`- reason: ${entry.reason}`);
    lines.push("", "```diff", entry.diff.trimEnd(), "```", "");
  }
  return `${lines.join("\n")}\n`;
}

function saveImpact(ledger: Ledger, entries: readonly ImpactEntry[]): void {
  writeJson(ledger.path(IMPACT_FILE), entries, ledger.dir);
  mkdirSync(dirname(ledger.path(IMPACT_PAGE)), { recursive: true });
  writeGated(ledger.dir, ledger.path(IMPACT_PAGE), renderImpactPage(entries));
}

/**
 * The run's raw layer and its proposals, written to the skills ledger under its lock and committed.
 * Labels only: no transcript, no reason. Null when another job holds the lock or the commit failed.
 */
export function recordRun(
  ledger: Ledger,
  run: string,
  scores: readonly SessionScore[],
  aggregate: Aggregate,
  advice: Advice,
): string | null {
  const release = ledger.tryLock();
  if (release === null) return null;
  try {
    const rows = scores.map((score) => ({
      key: score.key,
      host: score.host,
      skills_used: score.skills_used,
      status: score.status,
      failed: score.failed,
      labels: Object.fromEntries(SCORERS.map((scorer) => [scorer, score.results[scorer]?.label ?? null])),
    }));
    const impact = loadImpact(ledger.dir);
    writeJson(ledger.path(RUNS_DIR, `${run}.json`), { run, at: nowIso(), aggregate, sessions: rows }, ledger.dir);
    for (const suggestion of advice.suggestions) {
      impact.push({
        id: suggestion.id,
        run,
        at: nowIso(),
        skill: suggestion.skill,
        kind: suggestion.kind,
        rule: suggestion.rule,
        change: suggestion.change,
        diff: suggestion.diff,
        status: "proposed",
      });
    }
    saveImpact(ledger, impact);
    return ledger.commit(`doctor: run ${run}, ${advice.suggestions.length} proposal(s)`);
  } finally {
    release();
  }
}

/**
 * A human's decision on one proposal, under the ledger's lock. A decided proposal is not decided again.
 * `uncommitted` means the decision is saved and rides in the ledger's next commit.
 */
export function decide(
  ledger: Ledger,
  id: string,
  status: "accepted" | "rejected",
  reason: string | undefined,
): "ok" | "unknown" | "decided" | "locked" | "uncommitted" {
  const release = ledger.tryLock();
  if (release === null) return "locked";
  try {
    const impact = loadImpact(ledger.dir);
    const entry = impact.find((item) => item.id === id);
    if (entry === undefined) return "unknown";
    if (entry.status !== "proposed") return "decided";
    entry.status = status;
    entry.decided_at = nowIso();
    if (reason !== undefined && reason.trim() !== "") entry.reason = truncate(reason, FIELD_CHARS);
    saveImpact(ledger, impact);
    return ledger.commit(`doctor: ${status} ${id}`) === null ? "uncommitted" : "ok";
  } finally {
    release();
  }
}
