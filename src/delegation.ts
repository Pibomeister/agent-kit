import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";

import Ajv2020, { type ValidateFunction } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { parse as parseYaml } from "yaml";

import commonSchema from "../schemas/common.schema.json" with { type: "json" };
import projectSchema from "../schemas/project.schema.json" with { type: "json" };
import ticketSchema from "../schemas/ticket.schema.json" with { type: "json" };
import { DELEGATION_CLASSES, type DelegationClass } from "./lifecycle/gate.ts";

export type DelegationFactorName = "reversibility" | "size" | "complexity" | "spec" | "verification";

export interface DelegationFactor {
  score: number;
  evidence: string[];
}

export interface DelegationRecord {
  class: DelegationClass;
  stage: "ticket" | "merge";
  floor: { packs: string[]; sensitive_actions: string[] };
  factors: Record<DelegationFactorName, DelegationFactor>;
  lowered_by: null | { human: string; reason: string; at: string };
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

function highest(...classes: DelegationClass[]): DelegationClass {
  return classes.reduce(
    (left, right) => (DELEGATION_CLASSES.indexOf(right) > DELEGATION_CLASSES.indexOf(left) ? right : left),
    "green",
  );
}

function floorClass(floor: DelegationRecord["floor"]): DelegationClass {
  return highest(
    ...floor.packs.map((pack) => PACK_FLOORS.get(pack) ?? "green"),
    ...floor.sensitive_actions.map((action) => ACTION_FLOORS.get(action) ?? "yellow-owner"),
  );
}

export function scoreDelegation(ticket: DelegationTicket, project: DelegationProject): DelegationRecord {
  const source = ticket.delegation;
  if (source === undefined) throw new Error("ticket has no delegation block to score");
  const guidance = project.guidance.delegation;
  if (guidance === undefined) throw new Error("project has no guidance.delegation block (weights and cut points)");
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
  const computed =
    source.lowered_by === null
      ? highest(source.class, scored, floorClass(source.floor))
      : highest(source.class, floorClass(source.floor));

  return { ...source, class: computed };
}

function readDocument<T>(path: string, validate: ValidateFunction<T>, label: string): T {
  const text = readFileSync(path, "utf8");
  const parsed: unknown = extname(path).toLowerCase() === ".json" ? JSON.parse(text) : parseYaml(text);
  if (!validate(parsed)) {
    const detail = (validate.errors ?? [])
      .slice(0, 4)
      .map((error) => `${error.instancePath || "(root)"} ${error.message ?? "is invalid"}`)
      .join("; ");
    throw new Error(`${label} does not match its schema: ${detail}`);
  }
  return parsed;
}

function siblingProject(ticketPath: string): string | undefined {
  for (const name of ["project.json", "project.yaml", "project.yml"]) {
    const candidate = resolve(dirname(ticketPath), name);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

export function scoreDelegationFiles(
  ticketInput: string,
  projectInput?: string,
  cwd: string = process.cwd(),
): DelegationRecord {
  const ticketPath = resolve(cwd, ticketInput);
  const projectPath = projectInput === undefined ? siblingProject(ticketPath) : resolve(cwd, projectInput);
  if (!existsSync(ticketPath)) throw new Error(`ticket does not exist: ${ticketInput}`);
  if (projectPath === undefined || !existsSync(projectPath)) {
    throw new Error("project record not found; place project.json beside the ticket or pass --project <path>");
  }
  const validation = new Ajv2020({ strict: false, allErrors: true, validateFormats: true });
  addFormats(validation);
  validation.addSchema(commonSchema);
  const ticket = readDocument(ticketPath, validation.compile<DelegationTicket>(ticketSchema), "ticket");
  const project = readDocument(projectPath, validation.compile<DelegationProject>(projectSchema), "project");
  return scoreDelegation(ticket, project);
}
