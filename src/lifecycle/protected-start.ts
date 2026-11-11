/**
 * The complete charter predicate Runner.start applies, reused by the gate so a
 * Firstmate parent cannot skip ship-preflight with a weaker record. The gate
 * path requires the recorded standing grant (`requireGrant`). Parent-run trust
 * still rests on host write isolation of the evidence store.
 */
import { realpathSync } from "node:fs";
import { asJsonObject, type Json, type JsonObject } from "./behavior-policy.ts";

export interface ProtectedStartGrant {
  charter_hash: unknown;
  run_id: unknown;
  covers: unknown;
  controller: unknown;
}

export interface ProtectedStartExtras {
  charterPath?: string;
  runId?: string;
  standingGrant?: ProtectedStartGrant;
  /** Gate path: a parent without a standing grant cannot skip ship-preflight. */
  requireGrant?: boolean;
}

const STANDING_CAPABILITIES = ["runner-grants", "trusted-evidence", "independent-context"] as const;

function isText(value: Json | undefined): value is string {
  return Object.prototype.toString.call(value) === "[object String]";
}

function text(value: Json | undefined): string | undefined {
  return isText(value) && value !== "" ? value : undefined;
}

function locationMatches(charter: JsonObject, charterPath: string): boolean {
  const immutability = asJsonObject(charter.immutability) ? charter.immutability : undefined;
  const location = immutability === undefined ? undefined : text(immutability.location);
  if (location === undefined) return false;
  try {
    return realpathSync(location) === realpathSync(charterPath);
  } catch {
    return false;
  }
}

/** The same refusals Runner.start throws, so the gate cannot accept a weaker parent. */
export function charterAllowsProtectedStart(
  charter: JsonObject,
  hash: string,
  extras: ProtectedStartExtras = {},
): { ok: true } | { ok: false; reason: string } {
  const immutability = asJsonObject(charter.immutability) ? charter.immutability : undefined;
  const declared = immutability === undefined ? undefined : text(immutability.hash);
  if (
    charter.status !== "active" ||
    declared !== hash ||
    (extras.charterPath !== undefined && !locationMatches(charter, extras.charterPath))
  )
    return { ok: false, reason: "charter is inactive, moved or has a mismatched hash" };
  const approvals = Array.isArray(charter.approvals) ? charter.approvals : [];
  const human = approvals.some(
    (row) => asJsonObject(row) && row.by === "human" && row.authority === "explicit" && row.artifact_hash === hash,
  );
  if (!human) return { ok: false, reason: "active charter lacks a human approval bound to its hash" };
  const grants = Array.isArray(charter.sensitive_grants) ? charter.sensitive_grants : [];
  for (const row of grants) {
    const grant = asJsonObject(row) ? row : undefined;
    const approval = grant !== undefined && asJsonObject(grant.approval) ? grant.approval : undefined;
    if (
      approval === undefined ||
      approval.artifact_hash !== hash ||
      approval.by !== "human" ||
      approval.authority !== "explicit"
    )
      return { ok: false, reason: "sensitive grant lacks human approval bound to this charter" };
  }
  if (extras.runId !== undefined && charter.run_id !== extras.runId)
    return { ok: false, reason: "run id does not match charter" };
  const capabilities = Array.isArray(charter.allowed_capabilities) ? charter.allowed_capabilities : [];
  if (!STANDING_CAPABILITIES.every((capability) => capabilities.includes(capability)))
    return {
      ok: false,
      reason: "standing start requires charter-approved runner grants, trusted evidence and independent context",
    };
  const standing = Array.isArray(charter.standing_grants) ? charter.standing_grants : [];
  const listed = standing.some(
    (row) => asJsonObject(row) && row.covers === "autopilot.start" && row.controller === "firstmate",
  );
  if (!listed) return { ok: false, reason: "standing grant is absent, forged or unbound to the approved charter" };
  const granted = extras.standingGrant;
  if (extras.requireGrant === true && granted === undefined)
    return { ok: false, reason: "standing grant is absent, forged or unbound to the approved charter" };
  if (granted !== undefined) {
    if (
      granted.charter_hash !== hash ||
      (extras.runId !== undefined && granted.run_id !== extras.runId) ||
      granted.covers !== "autopilot.start" ||
      granted.controller !== "firstmate"
    )
      return { ok: false, reason: "standing grant is absent, forged or unbound to the approved charter" };
  }
  return { ok: true };
}
