import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import Ajv2020, { type ValidateFunction } from "ajv/dist/2020.js";

import { takeSnapshot, type Snapshot } from "../lifecycle/gate.ts";
import { compileSchemas } from "../validation/schemas.ts";
import { parseOracleReport } from "./parse.ts";
import { ORACLE_ID, ORACLE_KIND, SNAPSHOT_IGNORE, type Io } from "./types.ts";

interface BoundSource {
  revision: string;
  diff_hash: string;
}

interface BoundReceipt {
  id: string;
  kind: string;
  status: string;
  exit_status?: number;
  source_revision: BoundSource;
}

const boundValidator: ValidateFunction<BoundReceipt> = new Ajv2020({ strict: false }).compile({
  type: "object",
  required: ["id", "kind", "status", "source_revision"],
  properties: {
    id: { type: "string" },
    kind: { type: "string" },
    status: { type: "string" },
    exit_status: { type: "integer" },
    source_revision: {
      type: "object",
      required: ["revision", "diff_hash"],
      properties: {
        revision: { type: "string", minLength: 40 },
        diff_hash: { type: "string", minLength: 1 },
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

export function resolveReceiptPath(repo: string, receiptPath: string): string {
  return isAbsolute(receiptPath) ? receiptPath : join(repo, receiptPath);
}

export function tpLifeSnapshot(repo: string): Snapshot | null {
  return asSnapshot(takeSnapshot(repo, { ignoreUntrackedDirs: SNAPSHOT_IGNORE }));
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
  const snap = tpLifeSnapshot(repo);
  if (snap === null) {
    io.err("tp-life receipt write: no committed revision\n");
    return 1;
  }
  const raw = readFileSync(oracleJsonPath, "utf8");
  const report = parseOracleReport(raw);
  if (report === null) {
    io.err("tp-life receipt write: oracle JSON is not a complete case report\n");
    return 1;
  }
  const passed = report.failed === 0;
  const receipt = {
    schema: "verification",
    schema_version: 1,
    id: ORACLE_ID,
    project: { id: "agent-kit", repo: snap.repo },
    run_id: "tp-life-local",
    created_by: { role: "runner" },
    inputs: [],
    source_revision: { repo: snap.repo, revision: snap.revision, diff_hash: snap.diff_hash },
    created_at: report.started_at,
    status: passed ? "passed" : "failed",
    kind: ORACLE_KIND,
    check: ORACLE_ID,
    command: {
      argv: ["scripts/tp-life.sh", "oracle", "--base-url", report.base_url],
      cwd: ".",
      started_at: report.started_at,
      duration_ms: report.duration_ms,
    },
    exit_status: passed ? 0 : 1,
    output_digest: digest(raw),
    output_excerpt: `${report.passed} pass, ${report.failed} fail`,
    environment: { id: "tp-life-local", isolated: false, secrets_policy: "none" },
    no_criteria: "TP-LIFE fixture oracle for pending, success, failure, disconnect, duplicate and unknown.",
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
  const snap = tpLifeSnapshot(repo);
  if (snap === null) {
    io.err("tp-life receipt check: no committed revision\n");
    return 1;
  }
  const file = resolveReceiptPath(repo, receiptPath);
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    io.err(`tp-life receipt check: cannot read ${receiptPath}\n`);
    return 1;
  }
  let parsed: unknown;
  try {
    // SAFETY: JSON.parse is any; verification schema is the contract before use.
    parsed = JSON.parse(raw) as unknown;
  } catch {
    io.err("tp-life receipt check: receipt is not JSON\n");
    return 1;
  }
  const validate = compileSchemas(repo).validatorFor("verification");
  if (validate === undefined || !validate(parsed)) {
    io.err("tp-life receipt check: receipt failed schemas/verification.schema.json\n");
    return 1;
  }
  const bound = parseBoundReceipt(raw);
  if (bound === null) {
    io.err("tp-life receipt check: refused, source_revision.diff_hash is missing\n");
    return 2;
  }
  if (bound.source_revision.revision !== snap.revision) {
    io.err(
      `tp-life receipt check: refused ${basename(file)} bound to ${bound.source_revision.revision}, head is ${snap.revision}\n`,
    );
    return 2;
  }
  if (bound.source_revision.diff_hash !== snap.diff_hash) {
    io.err(`tp-life receipt check: refused ${basename(file)} bound to a different working tree\n`);
    return 2;
  }
  io.out(`accepted ${basename(file)} at ${snap.revision}\n`);
  return 0;
}

export function isGateOracleReceipt(repo: string, receiptPath: string): boolean {
  if (checkReceipt(repo, receiptPath, { out: () => undefined, err: () => undefined }) !== 0) return false;
  const bound = parseBoundReceipt(readFileSync(resolveReceiptPath(repo, receiptPath), "utf8"));
  if (bound === null) return false;
  return (
    bound.id === ORACLE_ID &&
    bound.kind === ORACLE_KIND &&
    bound.status === "passed" &&
    bound.exit_status === 0 &&
    bound.source_revision.diff_hash.length > 0
  );
}
