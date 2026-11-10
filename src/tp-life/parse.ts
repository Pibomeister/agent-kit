import Ajv2020, { type ValidateFunction } from "ajv/dist/2020.js";

import { CASE_IDS, type CaseResult, type EvidenceRecord, type OracleReport, type ReceiptPayload } from "./types.ts";

const ajv = new Ajv2020({ strict: false });

const caseItem = {
  type: "object",
  additionalProperties: false,
  required: ["id", "verdict", "detail"],
  properties: {
    id: { type: "string", enum: [...CASE_IDS] },
    verdict: { type: "string", enum: ["pass", "fail"] },
    detail: { type: "string", minLength: 1 },
  },
} as const;

const oracleValidator: ValidateFunction<OracleReport> = ajv.compile({
  type: "object",
  additionalProperties: false,
  required: ["base_url", "started_at", "duration_ms", "passed", "failed", "cases"],
  properties: {
    base_url: { type: "string", minLength: 1 },
    started_at: { type: "string", minLength: 1 },
    duration_ms: { type: "integer", minimum: 0 },
    passed: { type: "integer", minimum: 0 },
    failed: { type: "integer", minimum: 0 },
    cases: {
      type: "array",
      minItems: CASE_IDS.length,
      maxItems: CASE_IDS.length,
      items: caseItem,
    },
  },
});

const payloadValidator: ValidateFunction<ReceiptPayload> = ajv.compile({
  type: "object",
  additionalProperties: false,
  required: ["cases", "host"],
  properties: {
    cases: {
      type: "array",
      minItems: CASE_IDS.length,
      maxItems: CASE_IDS.length,
      items: caseItem,
    },
    host: {
      type: "object",
      additionalProperties: false,
      required: ["revision", "porcelain", "version", "hostname", "os", "host_login"],
      properties: {
        revision: { type: "string", minLength: 1 },
        porcelain: { type: "string" },
        version: { type: "string", minLength: 1 },
        hostname: { type: "string", minLength: 1 },
        os: { type: "string", minLength: 1 },
        host_login: { type: "string", minLength: 1 },
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
    covers: { type: "array", items: { type: "string" } },
    verdict: { type: "string", enum: ["not-run", "passed", "failed"] },
    oracle_sub_verdict: { type: "string", enum: ["incomplete", "red-to-green"] },
    reason: { type: "string", minLength: 1 },
    receipts: { type: "array", items: { type: "string" } },
    human_steps: { type: "string", minLength: 1 },
  },
});

export function uniqueComplete(cases: readonly CaseResult[]): boolean {
  if (cases.length !== CASE_IDS.length) return false;
  const seen = new Set<string>();
  for (const row of cases) {
    if (seen.has(row.id)) return false;
    seen.add(row.id);
  }
  for (const id of CASE_IDS) {
    if (!seen.has(id)) return false;
  }
  return true;
}

function countsFrom(cases: OracleReport["cases"]) {
  let passed = 0;
  let failed = 0;
  for (const row of cases) {
    if (row.verdict === "pass") passed += 1;
    else failed += 1;
  }
  return { passed, failed };
}

export function parseOracleReport(text: string): OracleReport | null {
  try {
    // SAFETY: JSON.parse is any; oracleValidator is the contract before use.
    const value = JSON.parse(text) as unknown;
    if (!oracleValidator(value)) return null;
    if (!uniqueComplete(value.cases)) return null;
    const counts = countsFrom(value.cases);
    return { ...value, passed: counts.passed, failed: counts.failed };
  } catch {
    return null;
  }
}

export function parseReceiptPayload(text: string): ReceiptPayload | null {
  try {
    // SAFETY: JSON.parse is any; payloadValidator is the contract before use.
    const value = JSON.parse(text) as unknown;
    if (!payloadValidator(value)) return null;
    if (!uniqueComplete(value.cases)) return null;
    return value;
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

export function isDuplicateOnlyFail(cases: readonly CaseResult[]): boolean {
  if (!uniqueComplete(cases)) return false;
  for (const row of cases) {
    if (row.id === "duplicate") {
      if (row.verdict !== "fail") return false;
    } else if (row.verdict !== "pass") return false;
  }
  return true;
}

export function isAllPass(cases: readonly CaseResult[]): boolean {
  if (!uniqueComplete(cases)) return false;
  for (const row of cases) {
    if (row.verdict !== "pass") return false;
  }
  return true;
}

export function flagValue(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  return argv[index + 1];
}

export interface TakenFlag {
  value: string | undefined;
  rest: string[];
}

export function takeFlag(argv: readonly string[], name: string): TakenFlag {
  const index = argv.indexOf(name);
  if (index < 0) return { value: undefined, rest: [...argv] };
  const value = argv[index + 1];
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (i === index || i === index + 1) continue;
    const item = argv[i];
    if (item !== undefined) rest.push(item);
  }
  return { value, rest };
}
