import Ajv2020, { type ValidateFunction } from "ajv/dist/2020.js";

import { CASE_IDS, type EvidenceRecord, type OracleReport } from "./types.ts";

const ajv = new Ajv2020({ strict: false });

const oracleValidator: ValidateFunction<OracleReport> = ajv.compile({
  type: "object",
  additionalProperties: false,
  required: ["passed", "failed", "cases"],
  properties: {
    passed: { type: "integer", minimum: 0 },
    failed: { type: "integer", minimum: 0 },
    cases: {
      type: "array",
      minItems: 5,
      maxItems: 5,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "verdict", "detail"],
        properties: {
          id: { type: "string", enum: [...CASE_IDS] },
          verdict: { type: "string", enum: ["pass", "fail"] },
          detail: { type: "string", minLength: 1 },
        },
      },
    },
  },
});

const evidenceValidator: ValidateFunction<EvidenceRecord> = ajv.compile({
  type: "object",
  additionalProperties: true,
  required: ["procedure", "gate", "suite", "verdict", "reason", "receipts", "human_steps"],
  properties: {
    procedure: { const: "TP-LIFE" },
    gate: { const: "G4" },
    suite: { const: "T5" },
    verdict: { type: "string", enum: ["not-run", "passed", "failed"] },
    reason: { type: "string", minLength: 1 },
    receipts: { type: "array", items: { type: "string" } },
    human_steps: { type: "string", minLength: 1 },
  },
});

export function parseOracleReport(text: string): OracleReport | null {
  try {
    // SAFETY: JSON.parse is any; oracleValidator is the contract before use.
    const value = JSON.parse(text) as unknown;
    return oracleValidator(value) ? value : null;
  } catch {
    return null;
  }
}

export function parseEvidenceRecord(text: string): EvidenceRecord | null {
  try {
    // SAFETY: JSON.parse is any; evidenceValidator is the contract before use.
    const value = JSON.parse(text) as unknown;
    return evidenceValidator(value) ? value : null;
  } catch {
    return null;
  }
}

export function flagValue(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  return argv[index + 1];
}
