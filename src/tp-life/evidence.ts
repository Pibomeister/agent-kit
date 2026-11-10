import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { isGateOracleReceipt } from "./receipt.ts";
import { parseEvidenceRecord } from "./parse.ts";
import { RECEIPTS_REL, TEMPLATE_REL, type EvidenceRecord, type Io } from "./types.ts";

export { RECEIPTS_REL, TEMPLATE_REL };

const NOT_RUN = "No operator and independent-oracle environment receipts are bound to this head.";

export function liveReceiptPaths(repo: string): string[] {
  const dir = join(repo, RECEIPTS_REL);
  if (!existsSync(dir)) return [];
  const names = readdirSync(dir).toSorted();
  const out: string[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    out.push(`${RECEIPTS_REL}/${name}`);
  }
  return out;
}

export function boundLiveReceipts(repo: string): string[] {
  const accepted: string[] = [];
  for (const path of liveReceiptPaths(repo)) {
    if (isGateOracleReceipt(repo, path)) accepted.push(path);
  }
  return accepted;
}

export function decideEvidence(template: EvidenceRecord, boundPaths: readonly string[]): EvidenceRecord {
  if (boundPaths.length === 0) {
    return { ...template, verdict: "not-run", reason: NOT_RUN, receipts: [] };
  }
  return {
    ...template,
    verdict: "passed",
    reason: `G4 from ${String(boundPaths.length)} bound TP-LIFE oracle receipt(s).`,
    receipts: [...boundPaths],
  };
}

export function renderEvidence(repo: string, io: Io): number {
  const raw = readFileSync(join(repo, TEMPLATE_REL), "utf8");
  const template = parseEvidenceRecord(raw);
  if (template === null) {
    io.err("tp-life evidence: template is not a G4 record\n");
    return 1;
  }
  const record = decideEvidence(template, boundLiveReceipts(repo));
  io.out(`${JSON.stringify(record, null, 2)}\n`);
  return record.verdict === "failed" ? 1 : 0;
}
