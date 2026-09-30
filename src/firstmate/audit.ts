/**
 * What `ak firstmate status complete` and `ak firstmate status --verify` check before a run may be
 * called done. The lifecycle half is core (src/lifecycle/gate.ts); this only supplies the binding's
 * evidence store, run id and required gates, then audits the grants the run was given.
 *
 * The head the gates must be current for is the one the latest ship-preflight record names, because a
 * publish commits and pushes after that record and the live tree has moved on.
 *
 * The grant audit is detection, not prevention (ADR-0004): each grant record the run kept must name
 * the binding the ledger registered, by path and by hash, and the binding must still hash to that.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";

import { checkGates, GATES, readRecords, type Gate, type Snapshot } from "../lifecycle/gate.ts";
import type { LedgerRecord } from "./constants.ts";
import { GRANT_OPERATIONS, grantRecordPath, type GrantOperation, type GrantRecord } from "./grant.ts";
import type { Binding } from "./schema.ts";

export interface AuditArgs {
  binding: Binding;
  /** The binding file as given; its bytes are what the ledger hash covers. */
  bindingPath: string;
  ledgerDir: string;
  /** The checkout whose history answers ancestry; defaults to the binding's project. */
  project?: string;
}

export function auditRun(a: AuditArgs): string[] {
  const b = a.binding;
  if (b.evidence.store !== "mock") {
    return [`refused: evidence store ${b.evidence.store} cannot be read: the knowledgebase fails closed (CONTRACT.md §1)`];
  }
  const refusals: string[] = [];

  // The binding is the one bind registered.
  const entry = join(a.ledgerDir, `${b.run_id}.json`);
  let ledger: LedgerRecord | undefined;
  try {
    ledger = JSON.parse(readFileSync(entry, "utf8")) as LedgerRecord;
  } catch {
    refusals.push(`refused: no ledger record for run ${b.run_id} in ${a.ledgerDir}`);
  }
  const bytes = readFileSync(a.bindingPath);
  const sha = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const at = realpathSync(a.bindingPath);
  if (ledger !== undefined) {
    if (ledger.binding_path !== at) refusals.push(`refused: binding ${at} is not the ${ledger.binding_path} the ledger registered`);
    if (ledger.binding_sha256 !== sha) refusals.push(`refused: binding hashes to ${sha}, not the ${ledger.binding_sha256} the ledger registered`);
  }

  // Every required gate has a current record.
  const gates = b.required_gates.filter((g): g is Gate => (GATES as readonly string[]).includes(g));
  const dir = b.evidence.location;
  const project = a.project ?? b.project.path;
  let head: Snapshot | undefined;
  if (gates.includes("ship-preflight")) {
    const ships = readRecords(dir, b.run_id, "ship-preflight").sort((x, y) => x.recorded_at.localeCompare(y.recorded_at));
    head = ships[ships.length - 1]?.snapshot;
    if (head === undefined) refusals.push(`refused: gate ship-preflight has no current evidence (no record for run ${b.run_id} in ${dir})`);
  }
  if (head !== undefined || !gates.includes("ship-preflight")) {
    // A ticket-backed binding declares the strengthened path. Firstmate's existing brief-backed
    // bindings retain their v1 run-id behavior until they carry a task artifact and run record.
    const evidence = b.work_source.kind === "ticket";
    refusals.push(...checkGates({ dir, run: b.run_id, gates, project, head, evidence }).refusals);
  }

  // Every operation the gates put on the slip ran under a grant, and every grant names this binding.
  for (const [operation, gate] of Object.entries(GRANT_OPERATIONS) as [GrantOperation, string][]) {
    if (!b.required_gates.includes(gate)) continue;
    const path = grantRecordPath(b, operation);
    if (!existsSync(path)) {
      refusals.push(`refused: grant ${operation} has no record at ${path}; gate ${gate} ran without one`);
      continue;
    }
    let g: Partial<GrantRecord>;
    try {
      g = JSON.parse(readFileSync(path, "utf8")) as Partial<GrantRecord>;
    } catch {
      refusals.push(`refused: grant record ${path} is unreadable`);
      continue;
    }
    const expected = ledger?.binding_sha256 ?? sha;
    if (g.binding_sha256 !== expected) refusals.push(`refused: grant ${operation} names binding hash ${g.binding_sha256}, not the registered ${expected}`);
    const named = typeof g.binding === "string" && existsSync(g.binding) ? realpathSync(g.binding) : g.binding;
    if (named !== (ledger?.binding_path ?? at)) refusals.push(`refused: grant ${operation} names binding ${g.binding}, not the registered ${ledger?.binding_path ?? at}`);
    if (g.run_id !== b.run_id) refusals.push(`refused: grant ${operation} is for run ${g.run_id}, not ${b.run_id}`);
  }
  return refusals;
}
