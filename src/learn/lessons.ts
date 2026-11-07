/**
 * The enforced-lessons layer over the canonical lesson pages.
 *
 * The canonical learnings file per project is the memory ledger's lesson
 * pages (`<memory ledger>/lessons/ls-NNN.md`) plus their `lessons.md` index:
 * append-only in that a lesson is added as the next `ls-NNN` page, a
 * restatement is reported as a duplicate of the page it restates and never
 * rewrites its statement or fields, and a lesson is retired by supersession (`status: superseded`),
 * never by deletion. A page may carry three fields the consolidation judge does not
 * invent: `failure` (what went wrong), `check` (the runnable check that now
 * guards it) and `issue` (the tracker link). Session start already loads the
 * confirmed pages (`memory/session-context.ts`); this module is what
 * `ak doctor` and the after-run triage read and write.
 *
 * A lesson is enforced only when its `check` names a check in
 * `RUNNABLE_LESSON_CHECKS` — the checks `ak doctor` itself runs on every
 * invocation. A missing check, or a name outside that registry, is
 * prose-only and is reported as such; nothing here upgrades prose to a gate
 * by naming it confidently.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import Ajv, { type ValidateFunction } from "ajv";
import { parsePage, renderPage, type PageMeta } from "./core/pages.ts";
import { readText } from "./core/store.ts";

/** A doctor check a lesson may name, with the `ak doctor` finding it maps to. */
export interface RunnableLessonCheck {
  id: string;
  /** The `check` label of the finding `ak doctor` emits for this check. */
  doctorCheck: string;
  summary: string;
}

/**
 * Every check `ak doctor` runs unconditionally today. A lesson that names
 * one is checked on each doctor run; extending enforcement means adding a
 * real doctor check and its row here together.
 */
export const RUNNABLE_LESSON_CHECKS: readonly RunnableLessonCheck[] = [
  {
    id: "marketplace-source",
    doctorCheck: "marketplace source",
    summary: "the host marketplace resolves to the published bundle",
  },
  { id: "plugin-enabled", doctorCheck: "plugin", summary: "ak is installed and enabled in the host" },
  { id: "project-enablement", doctorCheck: "project enablement", summary: "ak is enabled for this project" },
  { id: "tracker-binding", doctorCheck: "tracker binding", summary: "the project tracker binding parses" },
  {
    id: "tracker-token",
    doctorCheck: "tracker token",
    summary: "the tracker token exists, is owner-only, gitignored and untracked",
  },
  { id: "linearis-version", doctorCheck: "linearis", summary: "the project-local linearis is the pinned version" },
  {
    id: "knowledgebase-binding",
    doctorCheck: "knowledgebase binding",
    summary: "the project reaches its knowledgebase",
  },
  {
    id: "semantic-lint-key",
    doctorCheck: "semantic lint",
    summary: "the semantic-lint key file is present and owner-only",
  },
];

const CHECK_BY_ID = new Map(RUNNABLE_LESSON_CHECKS.map((check) => [check.id, check]));

/** One canonical lesson page, flattened to the fields coverage and triage use. */
export interface LessonRecord {
  id: string;
  statement: string;
  status: string;
  scope: string;
  failure: string;
  check: string;
  issue: string;
  /** Lesson ids this page replaces; each is marked `superseded` when the page is written. */
  supersedes: string[];
}

function text(value: string | number | string[] | null | undefined): string {
  return value === null || value === undefined ? "" : String(value);
}

/** Lesson pages under `dir/lessons`, in file-name order. */
export function readLessons(dir: string): LessonRecord[] {
  const pagesDir = join(dir, "lessons");
  if (!existsSync(pagesDir)) return [];
  return readdirSync(pagesDir)
    .filter((name) => /^ls-\d{1,6}\.md$/.test(name))
    .toSorted()
    .map((name) => {
      const { meta } = parsePage(readText(join(pagesDir, name)));
      return {
        id: name.slice(0, -".md".length),
        statement: text(meta.statement),
        status: text(meta.status),
        scope: text(meta.scope),
        failure: text(meta.failure),
        check: text(meta.check),
        issue: text(meta.issue),
        supersedes: Array.isArray(meta.supersedes) ? meta.supersedes : [],
      };
    });
}

export interface LessonCoverage {
  lesson: LessonRecord;
  enforced: boolean;
  /** Why the lesson is enforced, or why it is prose-only. */
  reason: string;
  /** The registry row the lesson's check names, when it names one. */
  runnable?: RunnableLessonCheck;
}

const HISTORY_STATUSES = new Set(["superseded", "retired"]);

/** Live lessons: neither superseded nor retired. */
function liveLessons(lessons: readonly LessonRecord[]): LessonRecord[] {
  return lessons.filter((lesson) => !HISTORY_STATUSES.has(lesson.status));
}

/**
 * Coverage for every live lesson. Superseded and retired lessons are
 * history: they are neither enforced nor prose-only, so they are omitted.
 */
export function classifyLessons(lessons: readonly LessonRecord[]): LessonCoverage[] {
  return liveLessons(lessons).flatMap((lesson): LessonCoverage[] => {
    if (lesson.check === "")
      return [
        {
          lesson,
          enforced: false,
          reason: "prose-only: no check named; add a check field naming a runnable doctor check",
        },
      ];
    const runnable = CHECK_BY_ID.get(lesson.check);
    if (runnable === undefined)
      return [
        {
          lesson,
          enforced: false,
          reason: `prose-only: check '${lesson.check}' is not a runnable doctor check`,
        },
      ];
    return [
      {
        lesson,
        enforced: true,
        reason: `enforced by ak doctor check '${runnable.id}' (${runnable.summary})`,
        runnable,
      },
    ];
  });
}

/** The shape of an `ak doctor` finding, kept structural so this module stays importable without a cycle. */
export interface LessonFinding {
  level: "PASS" | "WARN" | "FAIL";
  check: string;
  detail: string;
  remedy: string;
}

/**
 * One finding per live lesson, then a summary. An enforced lesson passes
 * unless the doctor run it rides on reports its check as FAIL, in which
 * case the lesson finding fails too: that is the gate biting. Prose-only
 * lessons warn and never fail the run on their own — legacy prose is a
 * backlog to convert, not a breakage. No lessons at all is one warning
 * naming the absence, never silence.
 */
export function lessonsFindings(
  coverage: readonly LessonCoverage[],
  doctorFindings: readonly { check: string; level: string }[],
): LessonFinding[] {
  if (coverage.length === 0)
    return [
      {
        level: "WARN",
        check: "lessons coverage",
        detail: "no lessons recorded in the canonical learnings file",
        remedy: "Record a lesson with `ak learn memory triage`, or pass --lessons <ledger-dir> to read another ledger.",
      },
    ];
  const findings: LessonFinding[] = coverage.map((row) => {
    const label = `${row.lesson.id}: ${row.lesson.statement || "(no statement)"}`;
    if (!row.enforced)
      return {
        level: "WARN",
        check: "lessons coverage",
        detail: `${label} — ${row.reason}`,
        remedy: `Name a runnable check in the lesson's check field (one of: ${RUNNABLE_LESSON_CHECKS.map((c) => c.id).join(", ")}), or implement the check and add it to the registry.`,
      };
    const guardLabel = row.runnable?.doctorCheck ?? "";
    const guarded = doctorFindings.filter(
      (finding) => finding.check === guardLabel || finding.check.endsWith(` ${guardLabel}`),
    );
    if (guarded.some((finding) => finding.level === "FAIL"))
      return {
        level: "FAIL",
        check: "lessons coverage",
        detail: `${label} — ${row.reason}; that check currently FAILs`,
        remedy: "Fix the failing doctor check above; the lesson stays enforced while it fails.",
      };
    return {
      level: "PASS",
      check: "lessons coverage",
      detail: `${label} — ${row.reason}${row.lesson.issue === "" ? "" : `; issue ${row.lesson.issue}`}`,
      remedy: "No action needed.",
    };
  });
  const enforced = coverage.filter((row) => row.enforced).length;
  const failing = findings.some((finding) => finding.level === "FAIL");
  findings.push({
    level: failing ? "FAIL" : enforced === coverage.length ? "PASS" : "WARN",
    check: "lessons coverage",
    detail: `${coverage.length} lesson(s): ${enforced} enforced, ${coverage.length - enforced} prose-only`,
    remedy: failing
      ? "Fix the failing doctor checks that guard the enforced lessons above."
      : enforced === coverage.length
        ? "No action needed."
        : "Convert prose-only lessons by naming a runnable doctor check, or record why they stay prose.",
  });
  return findings;
}

/** One failure from a finished run, as the caller (a run record or a person) states it. No judge call is made here. */
export interface FailureRecord {
  failure: string;
  lesson: string;
  check?: string;
  issue?: string;
  scope?: string;
}

function normalizeKeyPart(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** A lesson statement normalized for dedup: case, punctuation and whitespace do not make a new lesson. */
export function lessonKey(lesson: string): string {
  return normalizeKeyPart(lesson);
}

export interface TriageResult {
  created: LessonRecord[];
  duplicates: { failure: FailureRecord; lessonId: string }[];
  /** Created or duplicate failures with no issue link: candidates for an issue record, never filed from here. */
  issueCandidates: { failure: string; lesson: string; lessonId: string }[];
}

/** The next `ls-NNN` id after every existing one. */
export function nextLessonId(lessons: readonly LessonRecord[]): string {
  const max = lessons.reduce((top, lesson) => {
    const n = Number(/^ls-(\d+)$/.exec(lesson.id)?.[1] ?? 0);
    return Math.max(top, n);
  }, 0);
  return `ls-${String(max + 1).padStart(3, "0")}`;
}

/**
 * Deduped triage of run failures into lesson records. A failure whose
 * normalized lesson statement matches a live lesson, or an earlier failure
 * in the same batch, is a duplicate of that lesson — reported with its
 * check and issue, never rewritten; the failure text is detail, not
 * identity. A duplicate that names a check its prose-only lesson lacks is
 * appended as the next page with that lesson's status, and lists it in
 * `supersedes`; the caller marks it superseded the way consolidation does,
 * so every ledger reader agrees which page is live. A lesson already
 * carrying an issue link, or already named in `recordedCandidates` (the ids
 * an earlier triage queued), is not queued again. New lessons start as
 * `hypothesis`: consolidation confirms them from evidence later, and
 * session start loads only confirmed lessons.
 */
export function triageFailures(
  existing: readonly LessonRecord[],
  failures: readonly FailureRecord[],
  recordedCandidates: ReadonlySet<string> = new Set(),
): TriageResult {
  const created: LessonRecord[] = [];
  const duplicates: TriageResult["duplicates"] = [];
  const issueCandidates: TriageResult["issueCandidates"] = [];
  const byKey = new Map<string, LessonRecord>();
  for (const lesson of liveLessons(existing)) byKey.set(lessonKey(lesson.statement), lesson);
  const live: LessonRecord[] = [...existing];
  const candidateIds = new Set(recordedCandidates);
  const candidate = (failure: FailureRecord, lesson: LessonRecord) => {
    if ((failure.issue ?? "") !== "" || lesson.issue !== "" || candidateIds.has(lesson.id)) return;
    candidateIds.add(lesson.id);
    issueCandidates.push({ failure: failure.failure, lesson: failure.lesson, lessonId: lesson.id });
  };
  for (const failure of failures) {
    const key = lessonKey(failure.lesson);
    const known = byKey.get(key);
    const check = failure.check ?? "";
    const issue = failure.issue ?? "";
    if (known !== undefined) {
      duplicates.push({ failure, lessonId: known.id });
      if (check === "" || check === known.check || CHECK_BY_ID.has(known.check)) {
        candidate(failure, known);
        continue;
      }
    }
    const record: LessonRecord = {
      id: nextLessonId(live),
      statement: known?.statement ?? failure.lesson,
      status: known?.status ?? "hypothesis",
      scope: known !== undefined && known.scope !== "" ? known.scope : (failure.scope ?? "repo"),
      failure: failure.failure,
      check,
      issue: issue !== "" ? issue : (known?.issue ?? ""),
      supersedes: known === undefined ? [] : [known.id],
    };
    created.push(record);
    live.push(record);
    byKey.set(key, record);
    candidate(failure, record);
  }
  return { created, duplicates, issueCandidates };
}

/**
 * A new lesson page in the canonical format, ready for `writeLesson`. A
 * successor carries its predecessor's page — confidence, evidence,
 * sessions, count, tags, first_seen and body — so only its id, check,
 * failure, issue and supersedes differ from the page it replaces.
 */
export function renderLesson(
  record: LessonRecord,
  today: string,
  predecessor?: { meta: PageMeta; body: string },
): string {
  const meta: PageMeta = {
    confidence: 0.5,
    evidence: [],
    tags: [],
    count: 1,
    first_seen: today,
    ...predecessor?.meta,
    id: record.id,
    statement: record.statement,
    status: record.status,
    scope: record.scope,
    supersedes: record.supersedes,
    last_seen: today,
  };
  if (record.failure !== "") meta.failure = record.failure;
  if (record.check !== "") meta.check = record.check;
  if (record.issue !== "") meta.issue = record.issue;
  return renderPage(meta, predecessor?.body ?? `${record.statement}\n\nFailure: ${record.failure}\n`);
}

const failureRecordList: ValidateFunction<FailureRecord[]> = new Ajv().compile({
  type: "array",
  items: {
    type: "object",
    required: ["failure", "lesson"],
    properties: {
      failure: { type: "string", minLength: 1 },
      lesson: { type: "string", minLength: 1 },
      check: { type: "string" },
      issue: { type: "string" },
      scope: { type: "string" },
    },
  },
});
const failureRecordFile: ValidateFunction<{ failures: FailureRecord[] }> = new Ajv().compile({
  type: "object",
  required: ["failures"],
  properties: { failures: failureRecordList.schema },
});

/** A failures file's records: a JSON array of failure records, or an object holding them under `failures`. Null for anything else. */
export function parseFailureRecords(source: string): FailureRecord[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return null;
  }
  if (failureRecordList(parsed)) return parsed;
  if (failureRecordFile(parsed)) return parsed.failures;
  return null;
}
