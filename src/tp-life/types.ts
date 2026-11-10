export const CASE_IDS = ["pending", "success", "failure", "disconnect", "duplicate", "unknown"] as const;
export type CaseId = (typeof CASE_IDS)[number];
export type CaseVerdict = "pass" | "fail";

export const ORACLE_ID = "tp-life-oracle";
export const ORACLE_KIND = "command";
export const TEMPLATE_REL = "research/tp-life/evidence.template.json";
export const RECEIPTS_REL = "research/tp-life/receipts";
export const SNAPSHOT_IGNORE = [RECEIPTS_REL] as const;

export interface CaseResult {
  id: CaseId;
  verdict: CaseVerdict;
  detail: string;
}

export interface OracleReport {
  base_url: string;
  started_at: string;
  duration_ms: number;
  passed: number;
  failed: number;
  cases: CaseResult[];
}

export type GateVerdict = "not-run" | "passed" | "failed";

export interface EvidenceRecord {
  procedure: "TP-LIFE";
  gate: "G4";
  suite: "T5";
  covers?: string[];
  verdict: GateVerdict;
  reason: string;
  receipts: string[];
  human_steps: string;
}

export interface Io {
  out: (text: string) => void;
  err: (text: string) => void;
}
