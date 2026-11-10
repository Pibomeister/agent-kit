import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { checkReceipt } from "./receipt.ts";
import { parseEvidenceRecord } from "./parse.ts";
import type { EvidenceRecord, Io } from "./types.ts";

export const TEMPLATE_REL = "research/tp-life/evidence.template.json";
export const RECEIPTS_REL = "research/tp-life/receipts";

const NOT_RUN = "No operator and independent-oracle environment receipts are bound to this head.";

function silentIo(): Io {
  return {
    out: (_text: string) => undefined,
    err: (_text: string) => undefined,
  };
}

export function liveReceiptPaths(repo: string): string[] {
  const dir = join(repo, RECEIPTS_REL);
  if (!existsSync(dir)) return [];
  const names = readdirSync(dir).toSorted();
  const out: string[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    out.push(join(dir, name));
  }
  return out;
}

export function boundLiveReceipts(repo: string): string[] {
  const accepted: string[] = [];
  for (const path of liveReceiptPaths(repo)) {
    if (checkReceipt(repo, path, silentIo()) === 0) accepted.push(path);
  }
  return accepted;
}

export function decideEvidence(template: EvidenceRecord, boundCount: number): EvidenceRecord {
  if (boundCount === 0) {
    return { ...template, verdict: "not-run", reason: NOT_RUN, receipts: [] };
  }
  return { ...template, receipts: template.receipts };
}

export function renderEvidence(repo: string, io: Io): number {
  const raw = readFileSync(join(repo, TEMPLATE_REL), "utf8");
  const template = parseEvidenceRecord(raw);
  if (template === null) {
    io.err("tp-life evidence: template is not a G4 record\n");
    return 1;
  }
  const bound = boundLiveReceipts(repo);
  const record = decideEvidence(template, bound.length);
  io.out(`${JSON.stringify(record, null, 2)}\n`);
  return record.verdict === "failed" ? 1 : 0;
}
