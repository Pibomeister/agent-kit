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

export interface HostDetails {
  revision: string;
  porcelain: string;
  version: string;
  hostname: string;
  os: string;
  host_login: string;
}

export interface ReceiptPayload {
  cases: CaseResult[];
  host: HostDetails;
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
export type OracleSubVerdict = "incomplete" | "red-to-green";

export interface OracleObservation {
  path: string;
  digest: string;
  status: string;
  exit_status?: number;
  cases: CaseResult[];
}

export interface EvidenceRecord {
  procedure: "TP-LIFE";
  gate: "G4";
  suite: "T5";
  covers?: string[];
  verdict: GateVerdict;
  oracle_sub_verdict?: OracleSubVerdict;
  reason: string;
  receipts: string[];
  human_steps: string;
}

export interface Io {
  out: (text: string) => void;
  err: (text: string) => void;
}
