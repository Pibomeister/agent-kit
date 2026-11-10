import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import Ajv2020, { type ValidateFunction } from "ajv/dist/2020.js";

import { takeSnapshot, type Snapshot } from "../lifecycle/gate.ts";
import { compileSchemas } from "../validation/schemas.ts";
import { parseOracleReport } from "./parse.ts";
import type { Io } from "./types.ts";

interface BoundSource {
  revision: string;
  diff_hash?: string;
}

interface BoundReceipt {
  source_revision: BoundSource;
}

const boundValidator: ValidateFunction<BoundReceipt> = new Ajv2020({ strict: false }).compile({
  type: "object",
  required: ["source_revision"],
  properties: {
    source_revision: {
      type: "object",
      required: ["revision"],
      properties: {
        revision: { type: "string", minLength: 40 },
        diff_hash: { type: "string" },
      },
    },
  },
});

function isSnapshot(value: Snapshot | string): value is Snapshot {
  return Object.prototype.hasOwnProperty.call(value, "revision");
}

function asSnapshot(value: Snapshot | string): Snapshot | null {
  return isSnapshot(value) ? value : null;
}

function digest(bytes: string): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function parseBoundReceipt(text: string): BoundReceipt | null {
  try {
    // SAFETY: JSON.parse is any; boundValidator is the contract before use.
    const value = JSON.parse(text) as unknown;
    return boundValidator(value) ? value : null;
  } catch {
    return null;
  }
}

export function writeOracleReceipt(repo: string, oracleJsonPath: string, outPath: string, io: Io): number {
  const snap = asSnapshot(takeSnapshot(repo));
  if (snap === null) {
    io.err("tp-life receipt write: no committed revision\n");
    return 1;
  }
  const raw = readFileSync(oracleJsonPath, "utf8");
  const report = parseOracleReport(raw);
  if (report === null) {
    io.err("tp-life receipt write: oracle JSON is not a five-case report\n");
    return 1;
  }
  const passed = report.failed === 0;
  const now = new Date().toISOString();
  const receipt = {
    schema: "verification",
    schema_version: 1,
    id: `tp-life-oracle-${snap.revision.slice(0, 8)}`,
    project: { id: "agent-kit", repo: snap.repo },
    run_id: "tp-life-local",
    created_by: { role: "runner" },
    inputs: [],
    source_revision: { repo: snap.repo, revision: snap.revision, diff_hash: snap.diff_hash },
    created_at: now,
    status: passed ? "passed" : "failed",
    kind: "command",
    command: {
      argv: ["scripts/tp-life.sh", "oracle"],
      cwd: ".",
      started_at: now,
      duration_ms: 0,
    },
    exit_status: passed ? 0 : 1,
    output_digest: digest(raw),
    output_excerpt: `${report.passed} pass, ${report.failed} fail`,
    environment: { id: "tp-life-local", isolated: true, secrets_policy: "none" },
    no_criteria: "TP-LIFE fixture oracle for pending, success, failure, disconnect and duplicate.",
  };
  const validate = compileSchemas(repo).validatorFor("verification");
  if (validate === undefined || !validate(receipt)) {
    io.err("tp-life receipt write: constructed receipt failed schemas/verification.schema.json\n");
    return 1;
  }
  writeFileSync(outPath, `${JSON.stringify(receipt, null, 2)}\n`);
  io.out(`wrote ${outPath} status=${receipt.status} revision=${snap.revision}\n`);
  return 0;
}

export function checkReceipt(repo: string, receiptPath: string, io: Io): number {
  const snap = asSnapshot(takeSnapshot(repo));
  if (snap === null) {
    io.err("tp-life receipt check: no committed revision\n");
    return 1;
  }
  const bound = parseBoundReceipt(readFileSync(receiptPath, "utf8"));
  if (bound === null) {
    io.err("tp-life receipt check: receipt is not JSON with source_revision.revision\n");
    return 1;
  }
  if (bound.source_revision.revision !== snap.revision) {
    io.err(
      `tp-life receipt check: refused ${basename(receiptPath)} bound to ${bound.source_revision.revision}, head is ${snap.revision}\n`,
    );
    return 2;
  }
  const diffHash = bound.source_revision.diff_hash;
  if (diffHash !== undefined && diffHash !== snap.diff_hash) {
    io.err(`tp-life receipt check: refused ${basename(receiptPath)} bound to a different working tree\n`);
    return 2;
  }
  io.out(`accepted ${basename(receiptPath)} at ${snap.revision}\n`);
  return 0;
}
