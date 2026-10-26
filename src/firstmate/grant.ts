/**
 * `ak firstmate grant`: the Firstmate binding as the delegated grant (ADR-0004).
 *
 * The review.full and review.readiness operations stay `delegated-grant`. The public
 * super-review full and readiness entrypoints are model-started (ADR-0013). super-ship
 * stays `explicit-or-delegated`: a delegated controller may start it under a validated
 * grant. Under Firstmate the controller is Firstmate, and the grant is the binding
 * it wrote before the task, outside anything the worker can write. This checks that
 * it still is that binding and that it covers the operation asked for. It grants
 * nothing the binding does not name; merge and scope changes are never on it.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { isInside } from "../util/fs.ts";
import type { LedgerRecord } from "./constants.ts";
import { treeHash } from "./pin.ts";
import { git } from "./proc.ts";
import { validateBinding, type Binding } from "./schema.ts";

/** Each grantable phase operation and the required gate that puts it on the slip. */
export const GRANT_OPERATIONS = {
  "review.full": "review-full",
  "review.readiness": "review-readiness",
  "ship.prepare": "ship-preflight",
} as const;
export type GrantOperation = keyof typeof GRANT_OPERATIONS;

export interface GrantArgs {
  binding: string;
  operation: string;
  /** The directory the worker asks from; its git worktree must not hold the binding. */
  cwd: string;
}

export interface GrantRecord {
  operation: GrantOperation;
  binding: string;
  binding_sha256: string;
  task_id: string;
  run_id: string;
  granted_by: "firstmate-binding";
}

export type GrantResult = { ok: true; record: GrantRecord } | { ok: false; reason: string };

const no = (reason: string): GrantResult => ({ ok: false, reason });

const real = (path: string): string => (existsSync(path) ? realpathSync(path) : resolve(path));

export function grant(args: GrantArgs, akRoot: string, ledgerDir: string): GrantResult {
  if (!Object.hasOwn(GRANT_OPERATIONS, args.operation)) {
    return no(
      `${args.operation} is not an operation a Firstmate binding grants; only ${Object.keys(GRANT_OPERATIONS).join(", ")} are`,
    );
  }
  const operation = args.operation as GrantOperation;

  const path = resolve(args.binding);
  if (!existsSync(path)) return no(`binding ${path} does not exist`);
  const bytes = readFileSync(path);
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch (e) {
    return no(`binding ${path} is not JSON: ${(e as Error).message}`);
  }
  const invalid = validateBinding(akRoot, parsed);
  if (invalid.length > 0) return no(`binding ${path} does not validate: ${invalid.join("; ")}`);
  const binding = parsed as Binding;

  // A binding the worker could have written is one it could have widened (CONTRACT.md §5).
  const at = realpathSync(path);
  const sha = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const entry = join(ledgerDir, `${binding.run_id}.json`);
  if (!existsSync(entry))
    return no(`binding ${path} names run ${binding.run_id}, which ak firstmate bind never registered in ${ledgerDir}`);
  let record: LedgerRecord;
  try {
    record = JSON.parse(readFileSync(entry, "utf8")) as LedgerRecord;
  } catch {
    return no(`ledger record ${entry} is unreadable`);
  }
  if (
    typeof record !== "object" ||
    record === null ||
    typeof record.binding_path !== "string" ||
    typeof record.binding_sha256 !== "string"
  ) {
    return no(`ledger record ${entry} is unreadable`);
  }
  if (record.binding_path !== at)
    return no(
      `binding ${path} is not the ${record.binding_path} ak firstmate bind registered for run ${binding.run_id}`,
    );
  if (record.binding_sha256 !== sha)
    return no(`binding ${path} hashes to ${sha}, not the ${record.binding_sha256} ak firstmate bind registered`);
  const top = git(args.cwd, ["rev-parse", "--show-toplevel"]);
  const worktree = top.code === 0 && top.text !== "" ? real(top.text) : real(args.cwd);
  if (isInside(at, worktree))
    return no(`binding ${path} is inside the worktree ${worktree}, which the worker can write`);
  for (const dir of [binding.project.path, binding.project.workspace]) {
    if (dir !== undefined && isInside(at, real(dir)))
      return no(`binding ${path} is inside the project ${dir}, which the worker can write`);
  }

  const gate = GRANT_OPERATIONS[operation];
  if (!binding.required_gates.includes(gate)) {
    return no(`${operation} needs gate ${gate}, and the binding requires only ${binding.required_gates.join(", ")}`);
  }

  const pin = binding.skill_bundle.path;
  if (!existsSync(pin) || !statSync(pin).isDirectory()) return no(`the pinned bundle ${pin} does not exist`);
  const found = `sha256:${treeHash(pin)}`;
  if (found !== binding.skill_bundle.hash) {
    return no(`the pinned bundle ${pin} hashes to ${found}, not the bound ${binding.skill_bundle.hash}`);
  }

  const granted: GrantRecord = {
    operation,
    binding: path,
    binding_sha256: sha,
    task_id: binding.task_id,
    run_id: binding.run_id,
    granted_by: "firstmate-binding",
  };
  // Kept beside the run's gate records, where `ak firstmate status` audits it against the ledger. The
  // knowledgebase store fails closed (CONTRACT.md §1), so only a mock store receives one.
  if (binding.evidence.store === "mock") {
    const kept = grantRecordPath(binding, operation);
    mkdirSync(dirname(kept), { recursive: true });
    writeFileSync(`${kept}.partial-${process.pid}`, `${JSON.stringify(granted, null, 2)}\n`);
    renameSync(`${kept}.partial-${process.pid}`, kept);
  }
  return { ok: true, record: granted };
}

/** Where a grant's record is kept: `<evidence store>/<run_id>/grants/<operation>.json`. */
export function grantRecordPath(binding: Pick<Binding, "evidence" | "run_id">, operation: GrantOperation): string {
  return join(binding.evidence.location, binding.run_id, "grants", `${operation}.json`);
}
