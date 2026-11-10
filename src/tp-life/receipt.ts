import { createHash } from "node:crypto";
import { hostname, platform, release } from "node:os";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import Ajv2020, { type ValidateFunction } from "ajv/dist/2020.js";

import { git, takeSnapshot, type Snapshot } from "../lifecycle/gate.ts";
import { compileSchemas } from "../validation/schemas.ts";
import { parseOracleReport, parseReceiptPayload } from "./parse.ts";
import {
  ORACLE_ID,
  ORACLE_KIND,
  SNAPSHOT_IGNORE,
  type HostDetails,
  type Io,
  type OracleObservation,
  type ReceiptPayload,
} from "./types.ts";

export const UNATTESTED_NOTE = "unattested: report was not produced by the oracle run in this command";

interface BoundView {
  id: string;
  kind: string;
  status: string;
  exit_status?: number;
  repo: string;
  revision: string;
  diff_hash: string;
  output_digest: string;
  excerpt: string;
}

const boundValidator: ValidateFunction<BoundRaw> = new Ajv2020({ strict: false }).compile({
  type: "object",
  required: ["id", "kind", "status", "source_revision", "output_digest"],
  properties: {
    id: { type: "string" },
    kind: { type: "string" },
    status: { type: "string" },
    exit_status: { type: "integer" },
    output_digest: { type: "string", minLength: 1 },
    output_excerpt: { type: "string" },
    source_revision: {
      type: "object",
      required: ["repo", "revision", "diff_hash"],
      properties: {
        repo: { type: "string", minLength: 1 },
        revision: { type: "string", minLength: 40 },
        diff_hash: { type: "string", minLength: 1, pattern: "^sha256:[0-9a-f]{64}$" },
      },
    },
  },
});

interface BoundRaw {
  id: string;
  kind: string;
  status: string;
  exit_status?: number;
  output_digest: string;
  output_excerpt?: string;
  source_revision: { repo: string; revision: string; diff_hash: string };
}

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

function asBoundView(raw: BoundRaw): BoundView {
  return {
    id: raw.id,
    kind: raw.kind,
    status: raw.status,
    exit_status: raw.exit_status,
    repo: raw.source_revision.repo,
    revision: raw.source_revision.revision,
    diff_hash: raw.source_revision.diff_hash,
    output_digest: raw.output_digest,
    excerpt: raw.output_excerpt ?? "",
  };
}

function parseBoundRaw(text: string): BoundRaw | null {
  try {
    // SAFETY: JSON.parse is any; boundValidator is the contract before use.
    const value = JSON.parse(text) as unknown;
    return boundValidator(value) ? value : null;
  } catch {
    return null;
  }
}

function boundFieldError(): string {
  const first = boundValidator.errors?.[0];
  if (first === undefined) return "source_revision.diff_hash is missing";
  const params = first.params;
  const path = first.instancePath.replace(/^\//, "").replaceAll("/", ".");
  if (first.keyword === "required" && Object.prototype.hasOwnProperty.call(params, "missingProperty")) {
    const missing = String(params.missingProperty);
    const named = path.length > 0 ? `${path}.${missing}` : missing;
    return `${named} is missing`;
  }
  const named = path.length > 0 ? path : "source_revision.diff_hash";
  return `${named} is invalid`;
}

function readPackageVersion(repo: string): string {
  const raw = readFileSync(join(repo, "package.json"), "utf8");
  const match = /"version": "([^"]+)"/.exec(raw);
  const version = match?.[1];
  return version === undefined || version.length === 0 ? "unrecorded" : version;
}

function hostDetails(repo: string, snap: Snapshot): HostDetails {
  const status = git(repo, ["status", "--porcelain=v1"]);
  return {
    revision: snap.revision,
    porcelain: status.code === 0 ? status.text : "unrecorded",
    version: readPackageVersion(repo),
    hostname: hostname(),
    os: `${platform()} ${release()}`,
    host_login: process.env.AK_TP_LIFE_HOST_LOGIN ?? "unrecorded",
  };
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
  const payload: ReceiptPayload = { cases: report.cases, host: hostDetails(repo, snap) };
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
    output_excerpt: JSON.stringify(payload),
    environment: { id: "tp-life-unattested", isolated: false, secrets_policy: "none" },
    notes: UNATTESTED_NOTE,
    no_criteria: "TP-LIFE fixture oracle for pending, success, failure, disconnect, duplicate and unknown.",
  };
  const validate = compileSchemas(repo).validatorFor("verification");
  if (validate === undefined || !validate(receipt)) {
    io.err("tp-life receipt write: constructed receipt failed schemas/verification.schema.json\n");
    return 1;
  }
  writeFileSync(outPath, `${JSON.stringify(receipt, null, 2)}\n`);
  io.out(`wrote ${outPath} status=${receipt.status} revision=${snap.revision} unattested\n`);
  return 0;
}

interface BoundRead {
  code: number;
  message: string;
  view: BoundView | null;
}

export function readBoundReceipt(repo: string, receiptPath: string): BoundRead {
  const snap = tpLifeSnapshot(repo);
  if (snap === null) {
    return { code: 1, message: "tp-life receipt check: no committed revision\n", view: null };
  }
  const file = resolveReceiptPath(repo, receiptPath);
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return { code: 1, message: `tp-life receipt check: cannot read ${receiptPath}\n`, view: null };
  }
  let parsed: unknown;
  try {
    // SAFETY: JSON.parse is any; verification schema is the contract before use.
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return { code: 1, message: "tp-life receipt check: receipt is not JSON\n", view: null };
  }
  const validate = compileSchemas(repo).validatorFor("verification");
  const schemaOk = validate !== undefined && validate(parsed);
  const bound = parseBoundRaw(raw);
  if (bound === null) {
    return {
      code: 2,
      message: `tp-life receipt check: refused, ${boundFieldError()}\n`,
      view: null,
    };
  }
  if (!schemaOk) {
    return { code: 1, message: "tp-life receipt check: receipt failed schemas/verification.schema.json\n", view: null };
  }
  if (bound.source_revision.repo !== snap.repo) {
    return {
      code: 2,
      message: `tp-life receipt check: refused ${basename(file)} bound to a different repo\n`,
      view: null,
    };
  }
  if (bound.source_revision.revision !== snap.revision) {
    return {
      code: 2,
      message: `tp-life receipt check: refused ${basename(file)} bound to ${bound.source_revision.revision}, head is ${snap.revision}\n`,
      view: null,
    };
  }
  if (bound.source_revision.diff_hash !== snap.diff_hash) {
    return {
      code: 2,
      message: `tp-life receipt check: refused ${basename(file)} bound to a different working tree\n`,
      view: null,
    };
  }
  return { code: 0, message: `accepted ${basename(file)} at ${snap.revision}\n`, view: asBoundView(bound) };
}

export function checkReceipt(repo: string, receiptPath: string, io: Io): number {
  const result = readBoundReceipt(repo, receiptPath);
  if (result.code === 0) io.out(result.message);
  else io.err(result.message);
  return result.code;
}

export function oracleObservation(repo: string, receiptPath: string): OracleObservation | null {
  const result = readBoundReceipt(repo, receiptPath);
  if (result.code !== 0 || result.view === null) return null;
  if (result.view.id !== ORACLE_ID || result.view.kind !== ORACLE_KIND) return null;
  const payload = parseReceiptPayload(result.view.excerpt);
  if (payload === null) return null;
  return {
    path: receiptPath,
    digest: result.view.output_digest,
    status: result.view.status,
    exit_status: result.view.exit_status,
    cases: payload.cases,
  };
}
