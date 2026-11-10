/**
 * Semantic admission for a behavior-contract: accepted intent needs a resolved
 * accepted source, and proposed or unresolved intent cannot discharge a required
 * property. JSON Schema cannot express these cross-field rules. Knowledgebase
 * publish and indexed document validation share this function.
 */

import { asJsonObject, type Json, type JsonObject } from "../lifecycle/behavior-policy.ts";
import { artifactHash } from "../util/hash.ts";

export const ACCEPTED_INTENT_SOURCE_KINDS = new Set([
  "ticket",
  "requirements",
  "decision",
  "recorded-decision",
  "user-instruction",
]);

export const RULE_ACCEPTED_INTENT = "behavior-contract.accepted-intent-requires-accepted-source";
export const RULE_PROPOSED_INTENT = "behavior-contract.proposed-intent-cannot-discharge-accepted";

export interface IntentSourceArtifact {
  schema: string;
  id: string;
  doc: JsonObject;
}

export type IntentLookup = (id: string) => IntentSourceArtifact | undefined;

function rows(value: Json | undefined): Json[] {
  return Array.isArray(value) ? value : [];
}

function isText(value: Json | undefined): value is string {
  return Object.prototype.toString.call(value) === "[object String]";
}

function textField(value: Json | undefined): string | undefined {
  return isText(value) && value !== "" ? value : undefined;
}

function sourceKindSchema(kind: string): string | undefined {
  if (kind === "ticket") return "ticket";
  if (kind === "decision" || kind === "recorded-decision") return "decision";
  if (kind === "requirements") return "behavior-contract";
  if (kind === "user-instruction") return undefined;
  return undefined;
}

function statusOf(doc: JsonObject): string | undefined {
  return textField(doc.status);
}

function humanApproved(doc: JsonObject, expectedHash: string): boolean {
  for (const row of rows(doc.approvals)) {
    if (!asJsonObject(row)) continue;
    const who = textField(row.role) ?? textField(row.by);
    if (who === "human" && textField(row.artifact_hash) === expectedHash) return true;
  }
  return false;
}

function sourceIsAccepted(kind: string, artifact: IntentSourceArtifact): boolean {
  if (!humanApproved(artifact.doc, artifactHash(artifact.doc))) return false;
  const status = statusOf(artifact.doc);
  if (kind === "ticket") return artifact.schema === "ticket" && status === "approved";
  if (kind === "decision" || kind === "recorded-decision") {
    if (artifact.schema !== "decision" || status !== "ruled") return false;
    const ruling = artifact.doc.ruling;
    return asJsonObject(ruling) && ruling.outcome === "decided";
  }
  if (kind === "user-instruction") {
    if (artifact.schema === "ticket") return status === "approved";
    if (artifact.schema === "decision") {
      if (status !== "ruled") return false;
      const ruling = artifact.doc.ruling;
      return asJsonObject(ruling) && ruling.outcome === "decided";
    }
    return false;
  }
  return false;
}

function requirementRow(doc: JsonObject, requirementId: string): JsonObject | undefined {
  for (const value of rows(doc.requirements)) {
    if (!asJsonObject(value)) continue;
    if (textField(value.id) === requirementId) return value;
  }
  return undefined;
}

function requirementsSourceProblem(
  requirementId: string,
  source: JsonObject,
  lookup: IntentLookup,
  originId: string,
  seen: Set<string>,
): string | undefined {
  const ref = textField(source.ref);
  const expectedHash = textField(source.hash);
  if (ref === undefined || expectedHash === undefined) {
    return `${RULE_ACCEPTED_INTENT}: requirement ${requirementId} accepted source needs an immutable hash`;
  }
  if (ref === originId || seen.has(ref)) {
    return `${RULE_ACCEPTED_INTENT}: requirement ${requirementId} accepted source ${ref} is not an accepted source`;
  }
  const artifact = lookup(ref);
  if (artifact === undefined || artifact.schema !== "behavior-contract") {
    return `${RULE_ACCEPTED_INTENT}: requirement ${requirementId} accepted source ${ref} is unknown`;
  }
  if (artifactHash(artifact.doc) !== expectedHash) {
    return `${RULE_ACCEPTED_INTENT}: requirement ${requirementId} accepted source ${ref} does not match ${expectedHash}`;
  }
  const cited = requirementRow(artifact.doc, requirementId);
  if (cited === undefined || textField(cited.intent) !== "accepted") {
    return `${RULE_ACCEPTED_INTENT}: requirement ${requirementId} accepted source ${ref} is not an accepted source`;
  }
  const nested = rows(cited.sources).filter(asJsonObject);
  if (nested.length === 0) {
    return `${RULE_ACCEPTED_INTENT}: requirement ${requirementId} accepted source ${ref} is not an accepted source`;
  }
  const next = new Set(seen);
  next.add(originId);
  next.add(ref);
  const nestedProblems = nested.map((entry) => acceptedSourceProblem(requirementId, entry, lookup, originId, next));
  if (nestedProblems.every((problem) => problem !== undefined))
    return (
      nestedProblems[0] ??
      `${RULE_ACCEPTED_INTENT}: requirement ${requirementId} accepted source ${ref} is not an accepted source`
    );
  return undefined;
}

function acceptedSourceProblem(
  requirementId: string,
  source: JsonObject,
  lookup: IntentLookup | undefined,
  originId: string,
  seen: Set<string> = new Set(),
): string | undefined {
  const kind = textField(source.kind);
  const ref = textField(source.ref);
  if (kind === undefined || !ACCEPTED_INTENT_SOURCE_KINDS.has(kind) || ref === undefined) {
    return `${RULE_ACCEPTED_INTENT}: requirement ${requirementId} is accepted without a source of accepted intent`;
  }
  if (lookup === undefined) {
    return `${RULE_ACCEPTED_INTENT}: requirement ${requirementId} accepted source ${ref} is not resolved at admission`;
  }
  if (kind === "requirements") return requirementsSourceProblem(requirementId, source, lookup, originId, seen);
  const artifact = lookup(ref);
  if (artifact === undefined) {
    return `${RULE_ACCEPTED_INTENT}: requirement ${requirementId} accepted source ${ref} is unknown`;
  }
  const expectedSchema = sourceKindSchema(kind);
  if (expectedSchema !== undefined && artifact.schema !== expectedSchema) {
    return `${RULE_ACCEPTED_INTENT}: requirement ${requirementId} accepted source ${ref} is unknown`;
  }
  const expectedHash = textField(source.hash);
  if (expectedHash === undefined) {
    return `${RULE_ACCEPTED_INTENT}: requirement ${requirementId} accepted source ${ref} needs an immutable hash`;
  }
  if (artifactHash(artifact.doc) !== expectedHash) {
    return `${RULE_ACCEPTED_INTENT}: requirement ${requirementId} accepted source ${ref} does not match ${expectedHash}`;
  }
  if (!sourceIsAccepted(kind, artifact)) {
    return `${RULE_ACCEPTED_INTENT}: requirement ${requirementId} accepted source ${ref} is not an accepted source`;
  }
  return undefined;
}

/** Why `doc` cannot be admitted as a behavior-contract; empty when it can. */
export function behaviorContractIntentProblems(doc: JsonObject, lookup?: IntentLookup): string[] {
  const problems: string[] = [];
  const requirements = new Map<string, string>();
  for (const value of rows(doc.requirements)) {
    if (!asJsonObject(value)) continue;
    const id = textField(value.id);
    const intent = textField(value.intent);
    if (id === undefined || intent === undefined) continue;
    requirements.set(id, intent);
    if (intent !== "accepted") continue;
    const sources = rows(value.sources).filter(asJsonObject);
    if (sources.length === 0) {
      problems.push(`${RULE_ACCEPTED_INTENT}: requirement ${id} is accepted without an intent source`);
      continue;
    }
    const originId = textField(doc.id) ?? "";
    const sourceProblems = sources.map((source) => acceptedSourceProblem(id, source, lookup, originId));
    if (sourceProblems.every((problem) => problem !== undefined))
      problems.push(
        sourceProblems[0] ??
          `${RULE_ACCEPTED_INTENT}: requirement ${id} is accepted without a source of accepted intent`,
      );
  }
  for (const value of rows(doc.properties)) {
    if (!asJsonObject(value)) continue;
    const id = textField(value.id) ?? "unnamed";
    const cited = rows(value.requirement_ids).flatMap((entry) => {
      const requirementId = textField(entry);
      return requirementId === undefined ? [] : [requirementId];
    });
    if (cited.length === 0) continue;
    const intents = cited.map((requirementId) => requirements.get(requirementId));
    if (intents.some((intent) => intent === undefined)) {
      problems.push(`${RULE_PROPOSED_INTENT}: property ${id} cites a requirement that is not on this contract`);
      continue;
    }
    if (intents.every((intent) => intent !== "accepted")) {
      problems.push(
        `${RULE_PROPOSED_INTENT}: property ${id} is discharged only by proposed or unresolved intent; proposed intent cannot discharge an accepted requirement`,
      );
    }
  }
  return problems;
}
