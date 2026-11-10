export const CASE_IDS = ["pending", "success", "failure", "disconnect", "duplicate"] as const;
export type CaseId = (typeof CASE_IDS)[number];
export type CaseVerdict = "pass" | "fail";

export interface CaseResult {
  id: CaseId;
  verdict: CaseVerdict;
  detail: string;
}

export interface OracleReport {
  passed: number;
  failed: number;
  cases: CaseResult[];
}

export type GateVerdict = "not-run" | "passed" | "failed";

export interface EvidenceRecord {
  procedure: "TP-LIFE";
  gate: "G4";
  suite: "T5";
  verdict: GateVerdict;
  reason: string;
  receipts: string[];
  human_steps: string;
}

export interface Io {
  out: (text: string) => void;
  err: (text: string) => void;
}
