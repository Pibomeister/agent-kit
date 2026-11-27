/**
 * Runner-written lifecycle verification: the runner, not the worker, runs a check's argv on a fresh clone
 * of the exact clean revision, stores a seat attestation in its private state directory, and records the
 * verification receipt that cites it at the lifecycle verify gate.
 *
 * Trust: the argv, the seat ids and the excluded lineage come from the supervisor-owned private verify
 * configuration; the worker names only a configured check and a receipt id. The attestation is unsigned
 * JSON under the runner's state directory. This adds no key, secret or trust root. The gate checks the
 * attestation reference for shape and seat distinctness only; it does not open the document
 * (`references/verification-evidence/REFERENCE.md`). The command runs as the runner's own user, so this
 * separates context and lineage, not operating-system identity.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { arch, platform, release } from "node:os";
import { basename, join } from "node:path";

import {
  defaultEvidenceDir,
  EMPTY_DIFF,
  isSnapshot,
  readRecords,
  readRunRecord,
  recordGate,
  takeSnapshot,
  type Snapshot,
} from "../lifecycle/gate.ts";
import * as lifecycleGate from "../lifecycle/gate.ts";
import { gitEnv, isolationArgs, resolveTrustedGit } from "../lifecycle/git-isolation.ts";

/** A production-credentialed receipt needs a human approval, which a runner configuration cannot carry. */
export type SecretsPolicy = "none" | "test-only";

export interface LifecycleCheck {
  argv: string[];
  supports: string[];
  timeout_ms?: number;
}

export interface LifecycleVerifyConfig {
  evidence_dir?: string;
  project?: { id: string; repo?: string };
  verifier_seat: string;
  implementer_seat: string;
  excluded_lineage: string[];
  environment: { id: string; secrets_policy: SecretsPolicy };
  checks: Record<string, LifecycleCheck>;
}

export interface SpawnResult {
  exitCode: number;
  stdout: Buffer;
  stderr: Buffer;
}

export interface LifecycleVerifyArgs {
  stateDir: string;
  workerRoot: string;
  runId: string;
  config: LifecycleVerifyConfig;
  check: string;
  receiptId?: string;
  env: NodeJS.ProcessEnv;
  spawn: (argv: string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number) => Promise<SpawnResult>;
  now?: () => Date;
}

export interface LifecycleVerifyResult {
  receipt: { id: string; hash: string; status: "passed" | "failed" };
  attestation: { id: string; hash: string; path: string };
  exit_status: number;
  output_digest: string;
  gate_record: string;
  source_revision: Snapshot;
}

export const ATTESTATION_SCHEMA = "runner-verifier-attestation";
const ARTIFACT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
/** Git state and runner credentials never reach the verify command. */
const WITHHELD_ENV = /^(GIT_|AK_RUNNER_)/;

const sha256 = (bytes: Uint8Array | string): string => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

/** Refusals that do not depend on the checkout: the configuration and the requested ids. */
export function lifecycleConfigProblems(config: LifecycleVerifyConfig): string[] {
  const problems: string[] = [];
  if (!ARTIFACT_ID.test(config.verifier_seat)) problems.push("verifier_seat is not an artifact id");
  if (!ARTIFACT_ID.test(config.implementer_seat)) problems.push("implementer_seat is not an artifact id");
  if (config.verifier_seat === config.implementer_seat)
    problems.push("verifier_seat must differ from implementer_seat");
  if (config.excluded_lineage.includes(config.verifier_seat)) problems.push("verifier_seat is in the excluded lineage");
  if (!config.excluded_lineage.includes(config.implementer_seat))
    problems.push("excluded_lineage must name the implementer seat");
  if (Object.keys(config.checks).length === 0) problems.push("checks must name at least one check");
  for (const id of Object.keys(config.checks)) if (!ARTIFACT_ID.test(id)) problems.push(`check ${id} is not an id`);
  return problems;
}

interface GitRun {
  code: number;
  text: string;
  err: string;
}

function trustedGit(workerRoot: string, cwd: string, args: readonly string[], home: string): GitRun {
  const git = resolveTrustedGit(workerRoot);
  const run = spawnSync(git.binary, [...isolationArgs(cwd), ...args], {
    cwd,
    env: gitEnv({ path: git.path, home }),
    maxBuffer: 1 << 26,
    timeout: 300_000,
    killSignal: "SIGKILL",
  });
  return {
    code: run.status ?? -1,
    text: (run.stdout ?? "").toString().trim(),
    err: (run.stderr ?? "").toString().trim() || (run.error?.message ?? ""),
  };
}

/**
 * A fresh clone at `revision` under the runner state directory: no worker config, hooks or index, and
 * objects shared read-only from the worker's store.
 */
function exportRevision(stateDir: string, workerRoot: string, revision: string): string {
  const parent = join(stateDir, "lifecycle-verify", "exports");
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const scratch = mkdtempSync(join(parent, "x-"));
  const tree = join(scratch, "tree");
  try {
    const clone = trustedGit(
      workerRoot,
      scratch,
      ["clone", "--quiet", "--shared", "--no-checkout", workerRoot, tree],
      stateDir,
    );
    if (clone.code !== 0) throw new Error(`runner cannot clone the revision: ${clone.err}`);
    const checkout = trustedGit(workerRoot, tree, ["checkout", "--quiet", "--detach", revision], stateDir);
    if (checkout.code !== 0) throw new Error(`runner cannot check out ${revision}: ${checkout.err}`);
    const head = trustedGit(workerRoot, tree, ["rev-parse", "HEAD"], stateDir);
    if (head.text !== revision) throw new Error(`runner export is at ${head.text}, not ${revision}`);
    return tree;
  } catch (e) {
    rmSync(scratch, { recursive: true, force: true });
    throw e;
  }
}

function childEnvironment(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) if (!WITHHELD_ENV.test(key)) env[key] = value;
  return env;
}

export async function runLifecycleVerify(a: LifecycleVerifyArgs): Promise<LifecycleVerifyResult> {
  const now = a.now ?? (() => new Date());
  const problems = lifecycleConfigProblems(a.config);
  if (problems.length > 0) throw new Error(`invalid lifecycle verification configuration: ${problems.join("; ")}`);
  const check = a.config.checks[a.check];
  if (check === undefined || !Object.hasOwn(a.config.checks, a.check))
    throw new Error(`check ${a.check} is not in the runner's verification configuration`);
  const dir = a.config.evidence_dir ?? defaultEvidenceDir(a.workerRoot);
  const run = readRunRecord(dir, a.runId);
  if (run === undefined) throw new Error(`run ${a.runId} has no task-bound run record in ${dir}`);

  const before = takeSnapshot(a.workerRoot);
  if (!isSnapshot(before)) throw new Error(before);
  if (before.diff_hash !== EMPTY_DIFF)
    throw new Error("runner verification needs a clean committed tree; commit or discard the worker's changes");
  const receiptId = a.receiptId ?? `verif-${a.check}-${before.revision.slice(0, 12)}`;
  if (!ARTIFACT_ID.test(receiptId)) throw new Error("receipt id is not an artifact id");
  const attestationId = `attest-${receiptId}`.slice(0, 128);

  const buildSeats = [
    ...new Set(readRecords(dir, a.runId, "build-checks").flatMap((record) => record.implementer?.seat_id ?? [])),
  ];
  if (buildSeats.includes(a.config.verifier_seat))
    throw new Error(`verifier seat ${a.config.verifier_seat} implemented this run; it cannot verify it`);
  const excluded = [...new Set([...a.config.excluded_lineage, ...buildSeats])];

  const work = join(a.stateDir, "lifecycle-verify", a.runId, receiptId);
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true, mode: 0o700 });
  const tree = exportRevision(a.stateDir, a.workerRoot, before.revision);
  const startedAt = now();
  let result: SpawnResult;
  try {
    result = await a.spawn(check.argv, tree, childEnvironment(a.env), check.timeout_ms ?? DEFAULT_TIMEOUT_MS);
  } finally {
    rmSync(join(tree, ".."), { recursive: true, force: true });
  }
  const finishedAt = now();
  const after = takeSnapshot(a.workerRoot);
  if (!isSnapshot(after) || after.revision !== before.revision || after.diff_hash !== before.diff_hash)
    throw new Error("the worker checkout moved while the runner verified it; nothing was recorded");

  const output = Buffer.concat([result.stdout, result.stderr]);
  const outputDigest = sha256(output);
  writeFileSync(join(work, "output.log"), output, { mode: 0o600 });
  const status = result.exitCode === 0 ? "passed" : "failed";
  const host = { platform: platform(), arch: arch(), release: release() };

  const attestation = {
    schema: ATTESTATION_SCHEMA,
    schema_version: 1,
    id: attestationId,
    run_id: a.runId,
    receipt_id: receiptId,
    check: a.check,
    verifier_seat: a.config.verifier_seat,
    implementer_seat: a.config.implementer_seat,
    build_implementer_seats: buildSeats,
    excluded_lineage: excluded,
    argv: check.argv,
    export: { method: "git-clone-shared", revision: before.revision },
    source_revision: before,
    exit_status: result.exitCode,
    output_digest: outputDigest,
    environment: { id: a.config.environment.id, host },
    started_at: startedAt.toISOString(),
    finished_at: finishedAt.toISOString(),
    recorded_by: "ak runner run-verify",
  };
  const attestationBytes = Buffer.from(`${JSON.stringify(attestation, null, 2)}\n`);
  const attestationHash = sha256(attestationBytes);
  const attestationDir = join(a.stateDir, "attestations");
  mkdirSync(attestationDir, { recursive: true, mode: 0o700 });
  const attestationPath = join(attestationDir, `${attestationHash.slice(7)}.json`);
  writeFileSync(attestationPath, attestationBytes, { mode: 0o600 });

  const ticket = { id: run.ticket.id, schema: "ticket", hash: run.ticket.hash };
  const receipt = {
    schema: "verification",
    schema_version: 1,
    id: receiptId,
    project: a.config.project ?? { id: basename(a.workerRoot) },
    run_id: a.runId,
    created_by: { role: "verifier" },
    inputs: [ticket],
    source_revision: before,
    created_at: finishedAt.toISOString(),
    status,
    kind: "command",
    check: a.check,
    command: {
      argv: check.argv,
      cwd: ".",
      started_at: startedAt.toISOString(),
      duration_ms: finishedAt.getTime() - startedAt.getTime(),
    },
    exit_status: result.exitCode,
    output_digest: outputDigest,
    artifacts: [{ path: "output.log", digest: outputDigest, kind: "log" }],
    environment: {
      id: a.config.environment.id,
      isolated: true,
      secrets_policy: a.config.environment.secrets_policy,
      toolchain: [{ name: "host", version: `${host.platform}-${host.arch}-${host.release}` }],
    },
    ticket,
    supports: check.supports,
    verifier_seat: {
      id: a.config.verifier_seat,
      implementer_seat: a.config.implementer_seat,
      isolation: "runner-attested",
      attestation: { id: attestationId, hash: attestationHash },
    },
  };
  const malformed = lifecycleGate.verificationShapeReasons(receipt);
  if (malformed.length > 0) throw new Error(`runner receipt is malformed: ${malformed.join("; ")}`);
  const receiptBytes = `${JSON.stringify(receipt, null, 2)}\n`;
  const receiptPath = join(work, `${receiptId}.json`);
  writeFileSync(receiptPath, receiptBytes, { mode: 0o600 });

  const recorded = recordGate({ dir, run: a.runId, gate: "verify", project: a.workerRoot, receipts: [receiptPath] });
  if (!recorded.ok) throw new Error(`lifecycle verify gate refused the runner receipt: ${recorded.reason}`);
  if (recorded.skipped.length > 0)
    throw new Error(`lifecycle verify gate did not record the runner receipt: ${recorded.skipped.join("; ")}`);
  return {
    receipt: { id: receiptId, hash: sha256(receiptBytes), status },
    attestation: { id: attestationId, hash: attestationHash, path: attestationPath },
    exit_status: result.exitCode,
    output_digest: outputDigest,
    gate_record: recorded.path,
    source_revision: before,
  };
}
