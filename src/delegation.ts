import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import Ajv2020, { type ValidateFunction } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import commonSchema from "../schemas/common.schema.json" with { type: "json" };
import projectSchema from "../schemas/project.schema.json" with { type: "json" };
import ticketSchema from "../schemas/ticket.schema.json" with { type: "json" };
import verificationRecipeSchema from "../schemas/verification-recipe.schema.json" with { type: "json" };
import type { DelegationClass } from "./lifecycle/gate.ts";
import { globToRegExp } from "./util/glob.ts";

export type DelegationFactorName = "reversibility" | "size" | "complexity" | "spec" | "verification";

export interface DelegationFactor {
  score: number;
  evidence: string[];
}

export interface DelegationRecord {
  class: DelegationClass;
  stage: "ticket" | "merge";
  floor: { packs: string[]; sensitive_actions: string[]; shared_surfaces?: string[] };
  factors: Record<DelegationFactorName, DelegationFactor>;
  lowered_by: null | { human: string; reason: string; at: string; from: DelegationClass; superseded?: true };
}

/** Merge-stage evidence: any of these keys may replace the ticket's, and the floor only grows. */
export interface DelegationEvidence {
  factors?: DelegationRecord["factors"];
  floor?: Partial<DelegationRecord["floor"]>;
  lowered_by?: DelegationRecord["lowered_by"];
}

export interface DelegationTicket {
  delegation?: DelegationRecord;
}

export interface DelegationProject {
  guidance: {
    delegation?: {
      weights: Record<DelegationFactorName, number>;
      cut_points: { yellow_agent: number; yellow_owner: number; red: number };
      enforcement: "advisory";
      shared_surfaces?: { path: string; class: DelegationClass; reason: string }[];
    };
  };
}

const PACK_FLOORS = new Map<string, DelegationClass>([
  ["pack-api", "yellow-agent"],
  ["pack-data", "yellow-agent"],
  ["pack-secure", "yellow-owner"],
]);

const ACTION_FLOORS = new Map<string, DelegationClass>([
  ["dependency-add", "yellow-owner"],
  ["public-contract-change", "yellow-owner"],
  ["scope-expansion", "yellow-owner"],
  ["merge", "red"],
  ["deploy", "red"],
  ["production-credentials", "red"],
  ["destructive-data", "red"],
  ["money-movement", "red"],
  ["trust-boundary-change", "red"],
  ["force-push", "red"],
  ["history-rewrite", "red"],
]);

/**
 * The order of the classes. gate.ts is imported for its type alone: it runs its own command line when it is
 * the script, and the bundled `bin/ak` inlines this module, where gate.ts would take itself for the script.
 */
const CLASS_RANK: Record<DelegationClass, number> = { green: 0, "yellow-agent": 1, "yellow-owner": 2, red: 3 };

function highest(...classes: DelegationClass[]): DelegationClass {
  return classes.reduce((left, right) => (CLASS_RANK[right] > CLASS_RANK[left] ? right : left), "green");
}

type SharedSurface = { path: string; class: DelegationClass; reason: string };

function floorClass(floor: DelegationRecord["floor"], declared?: SharedSurface[]): DelegationClass {
  const surfaces = new Map((declared ?? []).map((surface) => [surface.path, surface.class]));
  const shared = (floor.shared_surfaces ?? []).map((path) => {
    const declaredClass = surfaces.get(path);
    if (declaredClass === undefined)
      throw new Error(`ticket names a shared surface the project record does not declare: ${path}`);
    return declaredClass;
  });
  return highest(
    ...floor.packs.map((pack) => PACK_FLOORS.get(pack) ?? "green"),
    ...floor.sensitive_actions.map((action) => ACTION_FLOORS.get(action) ?? "yellow-owner"),
    ...shared,
  );
}

export function scoreDelegation(ticket: DelegationTicket, project: DelegationProject): DelegationRecord {
  // The project's missing guidance is reported before the ticket's missing block: under the unattended
  // policy that error is a coverage limit an unscored draft (no block) must be able to read.
  const guidance = project.guidance.delegation;
  if (guidance === undefined) throw new Error("project has no guidance.delegation block (weights and cut points)");
  const source = ticket.delegation;
  if (source === undefined) throw new Error("ticket has no delegation block to score");
  const { yellow_agent: yellowAgent, yellow_owner: yellowOwner, red } = guidance.cut_points;
  if (!(yellowAgent < yellowOwner && yellowOwner < red)) {
    throw new Error("project.guidance.delegation cut points must be strictly ascending");
  }

  const { factors } = source;
  const { weights } = guidance;
  const total =
    Math.round(
      (factors.reversibility.score * weights.reversibility +
        factors.size.score * weights.size +
        factors.complexity.score * weights.complexity +
        factors.spec.score * weights.spec +
        (3 - factors.verification.score) * weights.verification) *
        1e9,
    ) / 1e9;
  const scored: DelegationClass =
    total >= red ? "red" : total >= yellowOwner ? "yellow-owner" : total >= yellowAgent ? "yellow-agent" : "green";
  const floor = floorClass(source.floor, guidance.shared_surfaces);
  const fresh = highest(scored, floor);
  const lowering = source.lowered_by;
  if (lowering === null) return { ...source, class: highest(source.class, fresh) };
  if (lowering.superseded === true || highest(fresh, lowering.from) !== lowering.from) {
    return { ...source, class: highest(source.class, fresh), lowered_by: { ...lowering, superseded: true } };
  }
  return { ...source, class: highest(source.class, floor) };
}

function schemaDetail(errors: readonly { instancePath: string; message?: string }[] | null | undefined): string {
  return (errors ?? [])
    .slice(0, 4)
    .map((error) => `${error.instancePath || "(root)"} ${error.message ?? "is invalid"}`)
    .join("; ");
}

function readDocument<T>(path: string, validate: ValidateFunction<T>, label: string): T {
  const text = readFileSync(path, "utf8");
  const parsed: unknown = JSON.parse(text);
  if (!validate(parsed)) throw new Error(`${label} does not match its schema: ${schemaDetail(validate.errors)}`);
  return parsed;
}

function makeValidation(): Ajv2020 {
  const validation = new Ajv2020({ strict: false, allErrors: true, validateFormats: true });
  addFormats(validation);
  validation.addSchema(commonSchema);
  validation.addSchema(verificationRecipeSchema);
  return validation;
}

let blockValidator: ValidateFunction<DelegationRecord> | null = null;

/** The one validation path for a delegation block, shared by both stages. */
function validateDelegationBlock(block: DelegationRecord): void {
  if (blockValidator === null) {
    // SAFETY: ticketSchema is the shipped ticket.schema.json; its delegation property together
    // with its $defs is the schema for one delegation block, rebased on the schema's own $id so
    // its relative references resolve the way the full-document compile resolves them.
    const schema = { $id: ticketSchema.$id, ...ticketSchema.properties.delegation, $defs: ticketSchema.$defs };
    blockValidator = makeValidation().compile<DelegationRecord>(schema);
  }
  if (!blockValidator(block))
    throw new Error(`ticket delegation does not match its schema: ${schemaDetail(blockValidator.errors)}`);
}

function union(first: readonly string[], second: readonly string[]): string[] {
  return [...new Set([...first, ...second])];
}

/**
 * Build the merge-stage record from the approved ticket, the project and the changed paths, then
 * score it. The seed is the ticket block's persisted class; evidence never sets it.
 */
export function scoreMergeStage(
  ticket: DelegationTicket,
  project: DelegationProject,
  changedPaths: readonly string[],
  evidence?: DelegationEvidence,
): DelegationRecord {
  const guidance = project.guidance.delegation;
  if (guidance === undefined) throw new Error("project has no guidance.delegation block (weights and cut points)");
  const source = ticket.delegation;
  if (source === undefined) throw new Error("ticket has no delegation block to score");
  const declared = guidance.shared_surfaces ?? [];
  const matched = declared
    .filter((surface) => changedPaths.some((path) => globToRegExp(surface.path).test(path)))
    .map((surface) => surface.path);
  const sharedSurfaces = union(
    union(source.floor.shared_surfaces ?? [], evidence?.floor?.shared_surfaces ?? []),
    matched,
  );
  const hasSurfaces =
    source.floor.shared_surfaces !== undefined || evidence?.floor?.shared_surfaces !== undefined || matched.length > 0;
  const floor: DelegationRecord["floor"] = {
    packs: union(source.floor.packs, evidence?.floor?.packs ?? []),
    sensitive_actions: union(source.floor.sensitive_actions, evidence?.floor?.sensitive_actions ?? []),
  };
  if (hasSurfaces) floor.shared_surfaces = sharedSurfaces;
  const candidate: DelegationRecord = {
    class: source.class,
    stage: "merge",
    floor,
    factors: evidence?.factors ?? source.factors,
    lowered_by: evidence !== undefined && "lowered_by" in evidence ? (evidence.lowered_by ?? null) : source.lowered_by,
  };
  validateDelegationBlock(candidate);
  return scoreDelegation({ delegation: candidate }, project);
}

function loadDocuments(ticketInput: string, projectInput: string, cwd: string) {
  const ticketPath = resolve(cwd, ticketInput);
  const projectPath = resolve(cwd, projectInput);
  if (!existsSync(ticketPath)) throw new Error(`ticket does not exist: ${ticketInput}`);
  if (!existsSync(projectPath)) throw new Error(`project record does not exist: ${projectInput}`);
  const validation = makeValidation();
  const ticket = readDocument(ticketPath, validation.compile<DelegationTicket>(ticketSchema), "ticket");
  const project = readDocument(projectPath, validation.compile<DelegationProject>(projectSchema), "project");
  return { ticket, project };
}

export function scoreDelegationFiles(
  ticketInput: string,
  projectInput: string,
  cwd: string = process.cwd(),
): DelegationRecord {
  const { ticket, project } = loadDocuments(ticketInput, projectInput, cwd);
  return scoreDelegation(ticket, project);
}

let evidenceValidator: ValidateFunction<DelegationEvidence> | null = null;

export function scoreMergeDelegationFiles(
  ticketInput: string,
  projectInput: string,
  changedPaths: readonly string[],
  evidenceInput?: string,
  cwd: string = process.cwd(),
): DelegationRecord {
  const { ticket, project } = loadDocuments(ticketInput, projectInput, cwd);
  let evidence: DelegationEvidence | undefined;
  if (evidenceInput !== undefined) {
    const evidencePath = resolve(cwd, evidenceInput);
    if (!existsSync(evidencePath)) throw new Error(`evidence does not exist: ${evidenceInput}`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(evidencePath, "utf8"));
    } catch (cause) {
      throw new Error(
        `evidence ${evidenceInput} does not match its schema: ${cause instanceof Error ? cause.message : String(cause)}`,
        { cause },
      );
    }
    if (evidenceValidator === null) {
      evidenceValidator = makeValidation().compile<DelegationEvidence>({
        type: "object",
        additionalProperties: false,
        properties: { factors: { type: "object" }, floor: { type: "object" }, lowered_by: {} },
      });
    }
    if (!evidenceValidator(parsed))
      throw new Error(`evidence ${evidenceInput} does not match its schema: ${schemaDetail(evidenceValidator.errors)}`);
    // The candidate built from this object is validated against the delegation schema in
    // scoreMergeStage before it is scored.
    evidence = parsed;
  }
  try {
    return scoreMergeStage(ticket, project, changedPaths, evidence);
  } catch (cause) {
    if (evidenceInput !== undefined && cause instanceof Error && cause.message.includes("does not match its schema"))
      throw new Error(`evidence ${evidenceInput} does not match its schema: ${cause.message}`, { cause });
    throw cause;
  }
}
