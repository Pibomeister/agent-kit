import { existsSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import { oracleObservation } from "./receipt.ts";
import { isAllPass, isDuplicateOnlyFail, parseEvidenceRecord } from "./parse.ts";
import {
  RECEIPTS_REL,
  TEMPLATE_REL,
  type EvidenceRecord,
  type Io,
  type OracleObservation,
  type OracleSubVerdict,
} from "./types.ts";

export { RECEIPTS_REL, TEMPLATE_REL };

const NOT_RUN = "G4 stays not-run until a human records it.";
const OPERATOR_WORD =
  "oracle_sub_verdict is computed from unattested receipts. Their origin and the head they ran on rest on the operator's word. Machine-checked covers only the per-case comparison inside each receipt.";

export function liveReceiptPaths(receiptsDir: string, relativePrefix: string): string[] {
  if (!existsSync(receiptsDir)) return [];
  const names = readdirSync(receiptsDir).toSorted();
  const out: string[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    out.push(`${relativePrefix}/${name}`);
  }
  return out;
}

export function boundOracleObservations(
  repo: string,
  receiptsDir: string,
  relativePrefix: string,
): OracleObservation[] {
  const accepted: OracleObservation[] = [];
  for (const rel of liveReceiptPaths(receiptsDir, relativePrefix)) {
    const abs = isAbsolute(rel) ? rel : join(repo, rel);
    const obs = oracleObservation(repo, abs);
    if (obs === null) continue;
    accepted.push({ ...obs, path: rel });
  }
  return accepted;
}

function uniqueObservations(observations: readonly OracleObservation[]): OracleObservation[] {
  const seen = new Set<string>();
  const unique: OracleObservation[] = [];
  for (const row of observations) {
    if (seen.has(row.digest)) continue;
    seen.add(row.digest);
    unique.push(row);
  }
  return unique;
}

function timestampMs(value: string): number | undefined {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return undefined;
  return ms;
}

export function oracleSubVerdict(observations: readonly OracleObservation[]): OracleSubVerdict {
  const failedAt: number[] = [];
  const passedAt: number[] = [];
  for (const row of observations) {
    const at = row.created_at;
    if (at === undefined) continue;
    const ms = timestampMs(at);
    if (ms === undefined) continue;
    if (row.status === "failed" && row.exit_status === 1 && isDuplicateOnlyFail(row.cases)) {
      failedAt.push(ms);
    }
    if (row.status === "passed" && row.exit_status === 0 && isAllPass(row.cases)) {
      passedAt.push(ms);
    }
  }
  for (const failed of failedAt) {
    for (const passed of passedAt) {
      if (failed < passed) return "red-to-green";
    }
  }
  return "incomplete";
}

function reasonFor(sub: OracleSubVerdict, bound: number): string {
  if (bound === 0) return `${NOT_RUN} ${OPERATOR_WORD}`;
  if (sub === "red-to-green") {
    return `Oracle sub-verdict red-to-green from unattested receipts bound to this HEAD. ${OPERATOR_WORD}`;
  }
  return `Oracle sub-verdict incomplete. Need one bound failed receipt where only duplicate failed and a later bound passed receipt. ${OPERATOR_WORD}`;
}

export function decideEvidence(template: EvidenceRecord, observations: readonly OracleObservation[]): EvidenceRecord {
  const unique = uniqueObservations(observations);
  const sub = oracleSubVerdict(unique);
  const receipts: string[] = [];
  for (const row of unique) receipts.push(row.path);
  return {
    ...template,
    verdict: "not-run",
    oracle_sub_verdict: sub,
    reason: reasonFor(sub, unique.length),
    receipts,
  };
}

export function renderEvidence(repo: string, io: Io, receiptsDirArg?: string): number {
  let raw: string;
  try {
    raw = readFileSync(join(repo, TEMPLATE_REL), "utf8");
  } catch {
    io.err(`tp-life evidence: cannot read ${TEMPLATE_REL}\n`);
    return 1;
  }
  const template = parseEvidenceRecord(raw);
  if (template === null) {
    io.err("tp-life evidence: template is not a G4 record\n");
    return 1;
  }
  const receiptsDir =
    receiptsDirArg === undefined
      ? join(repo, RECEIPTS_REL)
      : isAbsolute(receiptsDirArg)
        ? receiptsDirArg
        : join(repo, receiptsDirArg);
  const prefix = receiptsDir.startsWith(`${repo}/`) ? receiptsDir.slice(repo.length + 1) : receiptsDir;
  const record = decideEvidence(template, boundOracleObservations(repo, receiptsDir, prefix));
  io.out(`${JSON.stringify(record, null, 2)}\n`);
  return 0;
}
