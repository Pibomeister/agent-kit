/**
 * Semantic admission for a behavior-contract: accepted intent needs an accepted
 * source, and proposed or unresolved intent cannot discharge a required property.
 * JSON Schema cannot express these cross-field rules. Document validation and
 * knowledgebase publish share this function.
 */

import { asJsonObject, type Json, type JsonObject } from "../lifecycle/behavior-policy.ts";

export const ACCEPTED_INTENT_SOURCE_KINDS = new Set([
  "ticket",
  "requirements",
  "decision",
  "recorded-decision",
  "user-instruction",
]);

export const RULE_ACCEPTED_INTENT = "behavior-contract.accepted-intent-requires-accepted-source";
export const RULE_PROPOSED_INTENT = "behavior-contract.proposed-intent-cannot-discharge-accepted";

function rows(value: Json | undefined): Json[] {
  return Array.isArray(value) ? value : [];
}

function isText(value: Json | undefined): value is string {
  return Object.prototype.toString.call(value) === "[object String]";
}

function textField(value: Json | undefined): string | undefined {
  return isText(value) && value !== "" ? value : undefined;
}

/** Why `doc` cannot be admitted as a behavior-contract; empty when it can. */
export function behaviorContractIntentProblems(doc: JsonObject): string[] {
  const problems: string[] = [];
  const requirements = new Map<string, string>();
  for (const value of rows(doc.requirements)) {
    if (!asJsonObject(value)) continue;
    const id = textField(value.id);
    const intent = textField(value.intent);
    if (id === undefined || intent === undefined) continue;
    requirements.set(id, intent);
    if (intent !== "accepted") continue;
    let sourceCount = 0;
    let hasAcceptedSource = false;
    for (const sourceValue of rows(value.sources)) {
      if (!asJsonObject(sourceValue)) continue;
      const source = sourceValue;
      sourceCount += 1;
      const kind = textField(source.kind);
      if (kind !== undefined && ACCEPTED_INTENT_SOURCE_KINDS.has(kind)) hasAcceptedSource = true;
    }
    if (sourceCount === 0) {
      problems.push(`${RULE_ACCEPTED_INTENT}: requirement ${id} is accepted without an intent source`);
      continue;
    }
    if (!hasAcceptedSource)
      problems.push(`${RULE_ACCEPTED_INTENT}: requirement ${id} is accepted without a source of accepted intent`);
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
