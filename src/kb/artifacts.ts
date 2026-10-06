import Ajv2020 from "ajv/dist/2020.js";
import type { ValidateFunction } from "ajv";
import addFormats from "ajv-formats";

import charterSchema from "../../schemas/charter.schema.json" with { type: "json" };
import commonSchema from "../../schemas/common.schema.json" with { type: "json" };
import decisionSchema from "../../schemas/decision.schema.json" with { type: "json" };
import dossierSchema from "../../schemas/dossier.schema.json" with { type: "json" };
import evaluationSchema from "../../schemas/evaluation.schema.json" with { type: "json" };
import eventSchema from "../../schemas/event.schema.json" with { type: "json" };
import findingSchema from "../../schemas/finding.schema.json" with { type: "json" };
import handoffRecordSchema from "../../schemas/handoff-record.schema.json" with { type: "json" };
import lessonSchema from "../../schemas/lesson.schema.json" with { type: "json" };
import mapSchema from "../../schemas/map.schema.json" with { type: "json" };
import planRecordSchema from "../../schemas/plan-record.schema.json" with { type: "json" };
import projectSchema from "../../schemas/project.schema.json" with { type: "json" };
import reviewSchema from "../../schemas/review.schema.json" with { type: "json" };
import runLedgerSchema from "../../schemas/run-ledger.schema.json" with { type: "json" };
import shipEvidenceSchema from "../../schemas/ship-evidence.schema.json" with { type: "json" };
import ticketSchema from "../../schemas/ticket.schema.json" with { type: "json" };
import verificationRecipeSchema from "../../schemas/verification-recipe.schema.json" with { type: "json" };
import verificationSchema from "../../schemas/verification.schema.json" with { type: "json" };

/** What a publish reads off any run artifact before its own schema is applied. */
export interface RunArtifact {
  schema: string;
  id: string;
  project: { id: string };
  run_id: string | null;
  /** Outside the artifact hash (`artifactHash`), so an approved copy has its draft's digest. */
  approvals?: unknown;
}

/**
 * The schemas a run artifact may carry, one per `common#/$defs/schema_id`.
 * Compiled in so the bundled `ak` validates an artifact with no source checkout
 * beside it; a test holds this list equal to that enum.
 */
const ARTIFACT_SCHEMAS = {
  charter: charterSchema,
  decision: decisionSchema,
  dossier: dossierSchema,
  evaluation: evaluationSchema,
  event: eventSchema,
  finding: findingSchema,
  "handoff-record": handoffRecordSchema,
  lesson: lessonSchema,
  map: mapSchema,
  "plan-record": planRecordSchema,
  project: projectSchema,
  review: reviewSchema,
  "run-ledger": runLedgerSchema,
  "ship-evidence": shipEvidenceSchema,
  ticket: ticketSchema,
  verification: verificationSchema,
  "verification-recipe": verificationRecipeSchema,
};

export const ARTIFACT_SCHEMA_IDS: readonly string[] = Object.keys(ARTIFACT_SCHEMAS);

type AjvInstance = InstanceType<typeof Ajv2020>;

let compiled: AjvInstance | null = null;

/** Built on first use: seventeen schemas are not worth compiling for a `check`. */
function instance(): AjvInstance {
  if (compiled !== null) return compiled;
  const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: true });
  addFormats(ajv);
  ajv.addSchema(commonSchema);
  for (const schema of Object.values(ARTIFACT_SCHEMAS)) ajv.addSchema(schema);
  compiled = ajv;
  return ajv;
}

const validHeader = new Ajv2020({ strict: false }).compile<RunArtifact>({
  type: "object",
  required: ["schema", "id", "project", "run_id"],
  properties: {
    schema: { type: "string" },
    id: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$" },
    project: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    run_id: { type: ["string", "null"] },
  },
});

export interface ArtifactCheck {
  artifact: RunArtifact | null;
  /** Why it is not a publishable run artifact; empty when it is. */
  problem: string;
}

function describe(validate: ValidateFunction): string {
  return (validate.errors ?? [])
    .slice(0, 6)
    .map((e) => `${e.instancePath === "" ? "(root)" : e.instancePath} ${e.message ?? "is invalid"}`)
    .join("; ");
}

/**
 * Whether `text` is a run artifact a publish may carry: JSON, an envelope
 * naming a schema this package has, and valid against that schema. Checked
 * before any write, so an artifact failing its own schema never reaches the
 * knowledgebase (CONTRACT.md §2, `publishArtifact`).
 */
export function checkRunArtifact(text: string): ArtifactCheck {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (cause) {
    return { artifact: null, problem: `not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}` };
  }
  if (!validHeader(value)) {
    return { artifact: null, problem: `not an envelope-bearing artifact: ${describe(validHeader)}` };
  }
  if (!ARTIFACT_SCHEMA_IDS.includes(value.schema)) {
    return {
      artifact: null,
      problem: `envelope.schema '${value.schema}' is not one of ${ARTIFACT_SCHEMA_IDS.join(", ")}`,
    };
  }
  const validate = instance().getSchema(`https://agent-kit.local/schemas/${value.schema}.schema.json`);
  if (validate === undefined) {
    return {
      artifact: null,
      problem: `schemas/${value.schema}.schema.json did not compile, so the artifact is not trusted`,
    };
  }
  if (!validate(value)) {
    return { artifact: null, problem: `does not match schemas/${value.schema}.schema.json: ${describe(validate)}` };
  }
  return { artifact: value, problem: "" };
}
