/**
 * The start checks Runner.start applies to a charter, reused by the gate so a
 * Firstmate parent cannot skip ship-preflight with a weaker record.
 */
import { asJsonObject, type JsonObject } from "./behavior-policy.ts";

/** True when the charter would be accepted by Runner.start for a standing autopilot.start. */
export function charterAllowsProtectedStart(charter: JsonObject, hash: string): boolean {
  if (charter.status !== "active") return false;
  const approvals = Array.isArray(charter.approvals) ? charter.approvals : [];
  const human = approvals.some(
    (row) => asJsonObject(row) && row.by === "human" && row.authority === "explicit" && row.artifact_hash === hash,
  );
  if (!human) return false;
  const grants = Array.isArray(charter.standing_grants) ? charter.standing_grants : [];
  return grants.some((row) => asJsonObject(row) && row.covers === "autopilot.start" && row.controller === "firstmate");
}
