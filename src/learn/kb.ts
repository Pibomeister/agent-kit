/**
 * The knowledgebase bridge: a newly confirmed lesson or a promoted guardrail
 * becomes a `proposeLesson` draft on `schemas/lesson.schema.json`.
 *
 * The central knowledgebase owns project-derived artifacts (ruling
 * `central-kb-owns-project-artifacts`), so the ledger is working state and the
 * knowledgebase is where a lesson is proposed. This bridge drafts; it never
 * publishes. Publication needs explicit authorization or a grant covering
 * `publish-lesson` (ruling `learning-drafts-not-publishes`).
 *
 * With no knowledgebase configured the draft stays in the ledger under
 * `proposals/`, which is the record either way.
 */
import { basename, join } from "node:path";
import { artifactHash } from "../util/hash.ts";
import type { LearnContext } from "./core/context.ts";
import { run } from "./core/proc.ts";
import { scrubJsonText } from "./core/secrets.ts";
import type { Candidate } from "./core/similar.ts";
import { nowIso, readJson, writeJson } from "./core/store.ts";

export type TriggerKind = "failure" | "correction" | "surprising-review-result";

export interface DraftEvidence {
  ref: string;
  kind: "artifact" | "kb-fact" | "code" | "receipt" | "url" | "transcript";
  note?: string;
}

export interface LessonDraftInput {
  /** Ledger-local id: `ls-003` for a lesson, `rp-007` for a guardrail's pattern. */
  localId: string;
  title: string;
  statement: string;
  trigger: TriggerKind;
  /** What happened, hashed into the trigger's occurrence ref. */
  occurrence: { id: string; content: unknown };
  evidence: DraftEvidence[];
  domains: string[];
  paths?: string[];
  guidance?: string[];
  /** The learn role that produced it, e.g. `learn/consolidator`. */
  createdBy: string;
}

export interface ProjectIdentity {
  root: string;
  /** `owner/name` when known. */
  repo?: string;
  /** Full HEAD sha of the project when known; null otherwise. */
  revision?: string | null;
}

function kebab(text: string): string {
  const out = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/, "");
  return out === "" ? "project" : out;
}

const LOCAL_ID = /^[a-z]{2}-\d{1,6}$/;

/** A lesson artifact with status `candidate`. Shape only; nothing is sent. The local id is the runtime's, never a judge's. */
export function lessonDraft(
  input: LessonDraftInput,
  project: ProjectIdentity,
  runId: string,
  at: Date = new Date(),
): Record<string, unknown> {
  if (!LOCAL_ID.test(input.localId))
    throw new Error(`lesson draft: local id must look like ls-003, got ${JSON.stringify(input.localId)}`);
  const projectId = kebab(basename(project.root));
  const repoName = project.repo ?? projectId;
  const created = nowIso(at);
  const draft = {
    schema: "lesson",
    schema_version: 1,
    id: `learn-${projectId}-${input.localId}`,
    project: project.repo === undefined ? { id: projectId } : { id: projectId, repo: project.repo },
    run_id: runId,
    created_by: { role: input.createdBy },
    inputs: [],
    source_revision: project.revision ? { repo: repoName, revision: project.revision } : null,
    created_at: created,
    status: "candidate",
    title: input.title,
    statement: input.statement,
    trigger: {
      kind: input.trigger,
      occurrence: { id: input.occurrence.id, hash: artifactHash(input.occurrence.content) },
      at: created,
    },
    evidence: input.evidence.map((item) =>
      item.note === undefined ? { ref: item.ref, kind: item.kind } : { ...item },
    ),
    applies_to:
      input.paths && input.paths.length > 0
        ? { domains: input.domains, paths: input.paths }
        : { domains: input.domains },
  };
  return input.guidance && input.guidance.length > 0 ? { ...draft, guidance: input.guidance } : draft;
}

export interface ProposalResult {
  /** Where the draft is recorded: the knowledgebase's proposal ref, or the ledger path. */
  ref: string;
  /** True only when a configured knowledgebase accepted the proposal. */
  delivered: boolean;
}

/**
 * Record the draft in `<ledgerDir>/proposals/<id>.json`, then offer it to the
 * knowledgebase command when one is configured (`AK_LEARN_KB_COMMAND`, called
 * as `<command> proposeLesson` with the draft on stdin, answering `{"ref": ...}`).
 * A refused or failed proposal leaves the ledger record in place.
 *
 * The draft leaves the machine here, so what is sent and what is recorded is
 * the draft after the secret gate (`core/secrets.ts`); the ledger record is
 * where the gate records the redaction.
 *
 * `similar` lists the ledger records the draft resembles. It is kept beside the
 * draft in the record, for whoever reviews the proposal to amend or supersede,
 * and never put in the draft itself.
 */
export function proposeLesson(
  ctx: LearnContext,
  ledgerDir: string,
  draft: Record<string, unknown>,
  similar: readonly Candidate[] = [],
): ProposalResult {
  const id = String(draft.id);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id) || id.includes(".."))
    throw new Error(`proposal id is not a file name: ${JSON.stringify(id)}`);
  const recordPath = join(ledgerDir, "proposals", `${id}.json`);
  const previous = readJson<{ kb_ref?: string } | null>(recordPath, null);
  if (previous?.kb_ref) return { ref: previous.kb_ref, delivered: true };

  const record: Record<string, unknown> = { draft, proposed_at: nowIso() };
  if (similar.length > 0) record.similar = similar;
  const command = ctx.env.AK_LEARN_KB_COMMAND;
  let result: ProposalResult = { ref: `ledger:proposals/${id}.json`, delivered: false };
  if (command !== undefined && command.trim() !== "" && !ctx.config.dryRun) {
    const reply = run(["sh", "-c", `${command} proposeLesson`], {
      input: scrubJsonText(JSON.stringify(draft)).text,
      timeoutMs: 60_000,
      env: ctx.env,
    });
    try {
      const parsed = JSON.parse(reply.stdout) as { ref?: unknown };
      if (reply.code === 0 && typeof parsed.ref === "string" && parsed.ref !== "") {
        record.kb_ref = parsed.ref;
        result = { ref: parsed.ref, delivered: true };
      } else {
        record.kb_error = reply.stderr.trim() || `exit ${reply.code}`;
      }
    } catch {
      record.kb_error = reply.stderr.trim() || "unparseable reply";
    }
  }
  if (!ctx.config.dryRun) writeJson(recordPath, record, ledgerDir);
  return result;
}
