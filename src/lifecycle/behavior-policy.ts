/**
 * Behavior-verification policy bound onto a task-bound run at open.
 *
 * The snapshot is the run's obligation. Resume, delegated, standalone and
 * unattended paths read it. They do not re-resolve the live project. A missing
 * project after an enabled open cannot turn the run off. A worker field named
 * legacy is ignored.
 */
import { artifactHash, canonicalJson, sha256Hex } from "../util/hash.ts";

export const RUN_SCHEMA_VERSION = 2;

export type BehaviorMode = "off" | "shadow" | "on";
export type EvidenceLayer = "model" | "implementation";
export type PropertyKind = "safety" | "liveness";

export type Json = null | boolean | number | string | Json[] | JsonObject;
export interface JsonObject {
  [key: string]: Json;
}

export interface FrozenBehaviorCheck {
  id: string;
  check: string;
  kind?: "command" | "probe" | "manual";
  supports: string[];
  evidence_layer: EvidenceLayer;
  property_ids: string[];
  property_types: { [id: string]: PropertyKind };
  contract?: { id: string; schema: "behavior-contract"; hash: string };
  input_manifest?: { id: string; hash: string };
  evidence_required?: string[];
  recipe?: { id: string; hash: string };
  surfaces: { [criterion: string]: string };
}

export interface BehaviorBinding {
  run_id: string;
  ticket_hash: string;
  mode: BehaviorMode;
  policy_id: string | null;
  policy_hash: string | null;
  required_checks: FrozenBehaviorCheck[];
  captured_at: string;
  /** Set when Runner.start named a ticket it could not load. Mode may still be off. */
  ticket_resolution?: "unresolved";
  binding_hash: string;
}

export type BindResult = { ok: true; binding: BehaviorBinding } | { ok: false; reason: string };

export type BehaviorClass =
  | { kind: "legacy" }
  | { kind: "bound"; binding: BehaviorBinding }
  | { kind: "incomplete"; reason: string };

const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const AC = /^AC-[0-9]+$/;
const kindOf = (value: Json | undefined) => Object.prototype.toString.call(value);
const isText = (value: Json | undefined): value is string => kindOf(value) === "[object String]";
const isObject = (value: Json | undefined): value is JsonObject => kindOf(value) === "[object Object]";
const JSON_KINDS = new Set(
  ["Null", "Boolean", "Number", "String", "Array", "Object"].map((name) => `[object ${name}]`),
);

export function asJson(value: unknown): value is Json {
  return JSON_KINDS.has(Object.prototype.toString.call(value));
}

export function asJsonObject(value: unknown): value is JsonObject {
  return Object.prototype.toString.call(value) === "[object Object]";
}

function nonempty(value: Json | undefined): value is string {
  return isText(value) && /\S/.test(value);
}

function strings(value: Json | undefined): string[] | undefined {
  return Array.isArray(value) && value.every(isText) ? value : undefined;
}

function asMode(value: Json | undefined): BehaviorMode | undefined {
  if (!isText(value)) return undefined;
  if (value === "off" || value === "shadow" || value === "on") return value;
  return undefined;
}

function asLayer(value: Json | undefined): EvidenceLayer | undefined {
  if (!isText(value)) return undefined;
  if (value === "model" || value === "implementation") return value;
  return undefined;
}

function asPropertyKind(value: Json | undefined): PropertyKind | undefined {
  if (!isText(value)) return undefined;
  if (value === "safety" || value === "liveness") return value;
  return undefined;
}

function asCheckKind(value: Json | undefined): "command" | "probe" | "manual" | undefined {
  if (!isText(value)) return undefined;
  if (value === "command" || value === "probe" || value === "manual") return value;
  return undefined;
}

export function ticketProjectId(ticket: JsonObject): string | undefined {
  const field = ticket.project;
  if (nonempty(field)) return field.trim();
  return isObject(field) && nonempty(field.id) ? field.id : undefined;
}

export type ProjectLookup = "unbound" | "resolved" | "unavailable" | "absent";

export function reviewMode(project: JsonObject | undefined): BehaviorMode | "invalid" {
  if (project === undefined) return "off";
  const review = isObject(project.review) ? project.review : undefined;
  if (review === undefined || review.behavior === undefined || review.behavior === null) return "off";
  return asMode(review.behavior) ?? "invalid";
}

function freezeCheck(
  check: JsonObject,
  surfaces: ReadonlyMap<string, string>,
): FrozenBehaviorCheck | { reason: string } {
  if (!nonempty(check.id) || !KEBAB.test(check.id)) return { reason: `behavior check is missing a kebab id` };
  if (!nonempty(check.check)) return { reason: `behavior check ${check.id} is missing its check text` };
  const behavior = isObject(check.behavior) ? check.behavior : undefined;
  if (behavior === undefined) return { reason: `check ${check.id} has no behavior binding` };
  const layer = asLayer(behavior.evidence_layer);
  if (layer === undefined) return { reason: `check ${check.id} evidence_layer is not model or implementation` };
  const propertyIds = strings(behavior.property_ids);
  if (propertyIds === undefined || propertyIds.length === 0) return { reason: `check ${check.id} has no property_ids` };
  if (propertyIds.some((id) => !KEBAB.test(id)))
    return { reason: `check ${check.id} has a property id that is not kebab-case` };
  const types = isObject(behavior.property_types) ? behavior.property_types : {};
  const property_types: { [id: string]: PropertyKind } = {};
  for (const id of propertyIds) {
    const propertyKind = asPropertyKind(types[id]);
    if (propertyKind === undefined)
      return { reason: `check ${check.id} property ${id} has no safety or liveness type` };
    property_types[id] = propertyKind;
  }
  const supports = strings(check.supports) ?? [];
  const frozen: FrozenBehaviorCheck = {
    id: check.id,
    check: check.check,
    supports,
    evidence_layer: layer,
    property_ids: propertyIds,
    property_types,
    surfaces: Object.fromEntries(supports.filter((id) => AC.test(id)).map((id) => [id, surfaces.get(id) ?? "none"])),
  };
  const checkKind = asCheckKind(check.kind);
  if (checkKind !== undefined) frozen.kind = checkKind;
  const required = strings(check.evidence_required);
  if (required !== undefined) frozen.evidence_required = required;
  const recipe = isObject(check.recipe) ? check.recipe : undefined;
  if (recipe !== undefined && nonempty(recipe.id) && nonempty(recipe.hash))
    frozen.recipe = { id: recipe.id, hash: recipe.hash };
  const contract = isObject(behavior.contract) ? behavior.contract : undefined;
  if (contract !== undefined) {
    if (contract.schema !== "behavior-contract" || !nonempty(contract.id) || !nonempty(contract.hash))
      return { reason: `check ${check.id} contract is not a behavior-contract artifact ref` };
    frozen.contract = { id: contract.id, schema: "behavior-contract", hash: contract.hash };
  }
  const manifest = isObject(behavior.input_manifest) ? behavior.input_manifest : undefined;
  if (manifest !== undefined) {
    if (!nonempty(manifest.id) || !nonempty(manifest.hash))
      return { reason: `check ${check.id} input_manifest is not an artifact ref` };
    frozen.input_manifest = { id: manifest.id, hash: manifest.hash };
  }
  return frozen;
}

function behaviorChecks(
  ticket: JsonObject,
  surfaces: ReadonlyMap<string, string>,
): FrozenBehaviorCheck[] | { reason: string } {
  const frozen: FrozenBehaviorCheck[] = [];
  for (const value of Array.isArray(ticket.verification) ? ticket.verification : []) {
    if (!isObject(value) || !isObject(value.behavior)) continue;
    const next = freezeCheck(value, surfaces);
    if ("reason" in next) return next;
    frozen.push(next);
  }
  return frozen;
}

function ticketSurfaces(ticket: JsonObject): Map<string, string> {
  const surfaces = new Map<string, string>();
  for (const value of Array.isArray(ticket.acceptance_criteria) ? ticket.acceptance_criteria : []) {
    if (isObject(value) && nonempty(value.id) && AC.test(value.id))
      surfaces.set(value.id, nonempty(value.surface) ? value.surface : "none");
  }
  return surfaces;
}

function bindingHash(binding: Omit<BehaviorBinding, "binding_hash">): string {
  return `sha256:${sha256Hex(canonicalJson(binding))}`;
}

export function sealBinding(unsigned: Omit<BehaviorBinding, "binding_hash">): BehaviorBinding {
  return { ...unsigned, binding_hash: bindingHash(unsigned) };
}

/** Copy frozen obligations onto a child run id without re-resolving live policy. */
export function rebindSnapshot(binding: BehaviorBinding, runId: string): BehaviorBinding {
  return sealBinding({
    run_id: runId,
    ticket_hash: binding.ticket_hash,
    mode: binding.mode,
    policy_id: binding.policy_id,
    policy_hash: binding.policy_hash,
    required_checks: binding.required_checks,
    captured_at: binding.captured_at,
    ticket_resolution: binding.ticket_resolution,
  });
}

export function bindBehaviorPolicy(args: {
  runId: string;
  ticket: JsonObject;
  ticketHash: string;
  project?: JsonObject;
  projectHash?: string;
  lookup: ProjectLookup;
  callerProjectHash?: string;
  capturedAt: string;
  ticketResolution?: "unresolved";
}): BindResult {
  const checks = behaviorChecks(args.ticket, ticketSurfaces(args.ticket));
  if ("reason" in checks) return { ok: false, reason: checks.reason };
  const ticketWantsBehavior = checks.length > 0;
  if (args.lookup === "unavailable")
    return {
      ok: false,
      reason: "the authoritative project record is unavailable; missing project cannot turn this run off",
    };
  if (args.lookup === "absent" && ticketWantsBehavior)
    return {
      ok: false,
      reason: "enabled behavior checks need an authoritative project record; missing project cannot turn this run off",
    };
  if (args.lookup === "unbound" && args.callerProjectHash !== undefined)
    return {
      ok: false,
      reason: "caller-supplied project record is not the authoritative KB or runner binding",
    };
  if (args.lookup === "resolved" && args.project === undefined)
    return {
      ok: false,
      reason: "the authoritative project record is missing; missing project cannot turn this run off",
    };
  if (args.lookup === "resolved" && args.callerProjectHash !== undefined && args.callerProjectHash !== args.projectHash)
    return { ok: false, reason: "caller-supplied project record does not match the authoritative binding" };
  if (args.project !== undefined) {
    if (args.project.schema !== "project") return { ok: false, reason: "the project record is not schema project" };
    const identity = isObject(args.project.identity) ? args.project.identity : undefined;
    if (identity === undefined || !nonempty(identity.id))
      return { ok: false, reason: "the project record has no identity.id" };
    const wanted = ticketProjectId(args.ticket);
    if (wanted !== undefined && wanted !== identity.id)
      return { ok: false, reason: `ticket project ${wanted} does not match project identity ${identity.id}` };
    const review = isObject(args.project.review) ? args.project.review : undefined;
    if (
      review !== undefined &&
      review.behavior !== undefined &&
      review.behavior !== null &&
      asMode(review.behavior) === undefined
    )
      return { ok: false, reason: "review.behavior is not off, shadow or on" };
  }
  const mode = args.lookup === "absent" ? "off" : reviewMode(args.project);
  if (mode === "invalid") return { ok: false, reason: "review.behavior is not off, shadow or on" };
  if (args.lookup === "unbound" && ticketWantsBehavior)
    return {
      ok: false,
      reason: "enabled behavior checks need an authoritative project record; missing project cannot turn this run off",
    };
  if (mode === "off" && ticketWantsBehavior)
    return {
      ok: false,
      reason:
        "review.behavior is off while the ticket names mandatory behavior checks; modes cannot cancel those checks",
    };
  if (mode === "shadow" && ticketWantsBehavior)
    return {
      ok: false,
      reason:
        "review.behavior is shadow while the ticket names mandatory behavior checks; that conflict needs the authorized resolution path",
    };
  const identity = args.project !== undefined && isObject(args.project.identity) ? args.project.identity : undefined;
  const policyId =
    identity !== undefined && nonempty(identity.id) ? identity.id : (ticketProjectId(args.ticket) ?? null);
  const unsigned: Omit<BehaviorBinding, "binding_hash"> = {
    run_id: args.runId,
    ticket_hash: args.ticketHash,
    mode,
    policy_id: policyId,
    policy_hash: args.projectHash ?? null,
    required_checks: mode === "on" ? checks : [],
    captured_at: args.capturedAt,
    ticket_resolution: args.ticketResolution,
  };
  return { ok: true, binding: sealBinding(unsigned) };
}

function parseCheck(value: Json): FrozenBehaviorCheck | undefined {
  if (!isObject(value) || !nonempty(value.id) || !nonempty(value.check)) return undefined;
  const layer = asLayer(value.evidence_layer);
  if (layer === undefined) return undefined;
  const propertyIds = strings(value.property_ids);
  if (propertyIds === undefined || propertyIds.length === 0) return undefined;
  const types = isObject(value.property_types) ? value.property_types : undefined;
  if (types === undefined) return undefined;
  const property_types: { [id: string]: PropertyKind } = {};
  for (const id of propertyIds) {
    const propertyKind = asPropertyKind(types[id]);
    if (propertyKind === undefined) return undefined;
    property_types[id] = propertyKind;
  }
  const supports = strings(value.supports);
  const surfacesValue = isObject(value.surfaces) ? value.surfaces : undefined;
  if (supports === undefined || surfacesValue === undefined) return undefined;
  const frozen: FrozenBehaviorCheck = {
    id: value.id,
    check: value.check,
    supports,
    evidence_layer: layer,
    property_ids: propertyIds,
    property_types,
    surfaces: Object.fromEntries(
      Object.entries(surfacesValue).flatMap(([id, surface]) => (isText(surface) ? [[id, surface]] : [])),
    ),
  };
  const checkKind = asCheckKind(value.kind);
  if (checkKind !== undefined) frozen.kind = checkKind;
  const required = strings(value.evidence_required);
  if (required !== undefined) frozen.evidence_required = required;
  const recipe = isObject(value.recipe) ? value.recipe : undefined;
  if (recipe !== undefined && nonempty(recipe.id) && nonempty(recipe.hash))
    frozen.recipe = { id: recipe.id, hash: recipe.hash };
  const contract = isObject(value.contract) ? value.contract : undefined;
  if (contract !== undefined) {
    if (contract.schema !== "behavior-contract" || !nonempty(contract.id) || !nonempty(contract.hash)) return undefined;
    frozen.contract = { id: contract.id, schema: "behavior-contract", hash: contract.hash };
  }
  const manifest = isObject(value.input_manifest) ? value.input_manifest : undefined;
  if (manifest !== undefined) {
    if (!nonempty(manifest.id) || !nonempty(manifest.hash)) return undefined;
    frozen.input_manifest = { id: manifest.id, hash: manifest.hash };
  }
  return frozen;
}

export function parseBehaviorBinding(value: Json | undefined): BehaviorBinding | undefined {
  if (value === undefined || !isObject(value)) return undefined;
  if (!nonempty(value.run_id) || !nonempty(value.ticket_hash) || !nonempty(value.captured_at)) return undefined;
  const mode = asMode(value.mode);
  if (mode === undefined) return undefined;
  if (value.policy_id !== null && !nonempty(value.policy_id)) return undefined;
  if (value.policy_hash !== null && !nonempty(value.policy_hash)) return undefined;
  if (!Array.isArray(value.required_checks)) return undefined;
  const required_checks: FrozenBehaviorCheck[] = [];
  for (const entry of value.required_checks) {
    const check = parseCheck(entry);
    if (check === undefined) return undefined;
    required_checks.push(check);
  }
  if (!nonempty(value.binding_hash)) return undefined;
  if (value.ticket_resolution !== undefined && value.ticket_resolution !== "unresolved") return undefined;
  const unsigned: Omit<BehaviorBinding, "binding_hash"> = {
    run_id: value.run_id,
    ticket_hash: value.ticket_hash,
    mode,
    policy_id: value.policy_id === null ? null : value.policy_id,
    policy_hash: value.policy_hash === null ? null : value.policy_hash,
    required_checks,
    captured_at: value.captured_at,
    ticket_resolution: value.ticket_resolution === "unresolved" ? "unresolved" : undefined,
  };
  const expected = bindingHash(unsigned);
  if (value.binding_hash !== expected) return undefined;
  return { ...unsigned, binding_hash: value.binding_hash };
}

export function classifyRun(record: JsonObject, runId: string, ticket?: JsonObject): BehaviorClass {
  const frozen = ticket === undefined ? undefined : behaviorChecks(ticket, ticketSurfaces(ticket));
  const ticketWants = frozen !== undefined && !("reason" in frozen) && frozen.length > 0;
  const version = record.schema_version;
  const hasBehavior = record.behavior !== undefined;
  if (version === undefined && !hasBehavior) {
    if (ticketWants)
      return {
        kind: "incomplete",
        reason: `run ${runId} is a new enabled run with no behavior policy snapshot`,
      };
    return { kind: "legacy" };
  }
  if (version !== RUN_SCHEMA_VERSION)
    return { kind: "incomplete", reason: `run ${runId} is not a version-${RUN_SCHEMA_VERSION} behavior-bound run` };
  const binding = parseBehaviorBinding(record.behavior);
  if (binding === undefined)
    return { kind: "incomplete", reason: `run ${runId} has no complete behavior policy snapshot` };
  if (binding.run_id !== runId)
    return { kind: "incomplete", reason: `behavior snapshot is for run ${binding.run_id}, not ${runId}` };
  const namedTicket = isObject(record.ticket) ? record.ticket : undefined;
  if (namedTicket !== undefined && nonempty(namedTicket.hash) && binding.ticket_hash !== namedTicket.hash)
    return {
      kind: "incomplete",
      reason: `behavior snapshot is for ticket ${binding.ticket_hash}, not ${namedTicket.hash}`,
    };
  if (frozen !== undefined && "reason" in frozen) return { kind: "incomplete", reason: frozen.reason };
  if (binding.ticket_resolution === "unresolved" && ticketWants)
    return {
      kind: "incomplete",
      reason: `run ${runId} ticket was unresolved at Runner.start; snapshot is not frozen-clean`,
    };
  if (ticketWants && binding.mode !== "on")
    return {
      kind: "incomplete",
      reason: `run ${runId} ticket names mandatory behavior checks; snapshot mode ${binding.mode} cannot cancel them`,
    };
  if (ticketWants && canonicalJson(binding.required_checks) !== canonicalJson(frozen))
    return {
      kind: "incomplete",
      reason: `run ${runId} frozen check definitions do not match the opened ticket`,
    };
  if (binding.mode === "on") {
    for (const check of binding.required_checks) {
      if (check.property_ids.length === 0)
        return { kind: "incomplete", reason: `required behavior check ${check.id} is missing its frozen definition` };
    }
  }
  return { kind: "bound", binding };
}

export function projectHashOf(project: JsonObject): string {
  return artifactHash(project);
}
