/**
 * The `x-validator-rule` layer.
 *
 * Every JSON Schema under schemas/ tags the constraints it cannot express in
 * JSON Schema with an `x-validator-rule` key. Those rule ids are the ids used
 * here, one function per rule, so a failure names the same rule the schema
 * author named. Rules that a schema already enforces structurally (a pinned
 * `const`, a closed object, an `if/then`) are re-asserted here only where the
 * cross-document or recomputed half is what actually bites.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { CheckContext } from "./context.ts";
import { error, type Issue } from "./types.ts";
import { artifactHash, canonicalJson, sha256Hex } from "../util/hash.ts";
import { loadArtifacts } from "./artifacts.ts";

const REMOTE_SIDE_EFFECTS = new Set([
  "remote-push",
  "pr-open",
  "pr-comment",
  "pr-thread-resolve",
  "kb-publish",
  "tracker-write",
]);

/** Key names a dossier may never carry: an architectural verdict by any name. */
const DOSSIER_REFUSED_KEYS = new Set([
  "verdict",
  "architectural_verdict",
  "architecture_verdict",
  "recommendation_verdict",
  "assessment",
  "ruling",
]);

/** Key names an event may never carry: nothing in an event confers authority. */
const EVENT_REFUSED_KEYS = new Set(["grant", "grants", "approval", "approvals", "authority"]);

const APP_LOCAL_KB_ROOT = /(^|\/)(context\.md|docs\/solutions|docs\/adr)(\/|$)/i;
const GUIDANCE_NAMES =
  /\b(pr_size|pr-size|test_pyramid|test-pyramid|target_changed_lines|unit_percent|integration_percent|end_to_end_percent)\b/i;

const SEVERITY_RANK: Record<string, number> = { P3: 0, P2: 1, P1: 2, P0: 3 };
const SPEC_QUALITY_RANK: Record<string, number> = { patch: 0, sketch: 1, smell: 2 };
const DIFFICULTY_RANK: Record<string, number> = {
  mechanical: 0,
  "local-judgment": 1,
  "cross-cutting": 2,
  null: 3,
};
const AUTOFIX_RANK: Record<string, number> = { safe_auto: 0, gated_auto: 1, manual: 2, advisory: 3 };
const LABEL_SEVERITIES: Record<string, ReadonlySet<string>> = {
  Critical: new Set(["P0", "P1"]),
  Important: new Set(["P0", "P1", "P2"]),
  Nit: new Set(["P2", "P3"]),
  FYI: new Set(["P2", "P3"]),
};

export interface IndexedDoc {
  readonly file: string;
  readonly doc: Record<string, unknown>;
  readonly schema: string;
}

export interface DocIndex {
  readonly all: readonly IndexedDoc[];
  readonly byId: ReadonlyMap<string, IndexedDoc>;
  readonly byCharterHash: ReadonlyMap<string, IndexedDoc>;
}

function obj(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function at(doc: Record<string, unknown>, path: string): unknown {
  let current: unknown = doc;
  for (const key of path.split(".")) {
    const record = obj(current);
    if (record === null) return undefined;
    current = record[key];
  }
  return current;
}

/** The actor that produced the artifact: `created_by` is a creator object or a bare role. */
function creatorRole(doc: Record<string, unknown>): string | null {
  const created = doc["created_by"];
  const record = obj(created);
  return record === null ? str(created) : str(record["role"]);
}

function revisionOf(value: unknown): string | null {
  const record = obj(value);
  return record === null ? str(value) : str(record["revision"]);
}

/** Minimal glob match, enough for `src/**` style write-scope declarations. */
function globMatches(pattern: string, path: string): boolean {
  const source = pattern
    .split("")
    .map((c) => (/[.+^${}()|[\]\\]/.test(c) ? `\\${c}` : c))
    .join("")
    .replace(/\*\*\//g, "(?:.*/)?")
    .replace(/\*\*/g, ".*")
    .replace(/(?<!\.)\*/g, "[^/]*")
    .replace(/\?/g, "[^/]");
  try {
    return new RegExp(`^${source}$`).test(path);
  } catch {
    return false;
  }
}

function* walkKeys(value: unknown, path: string[] = []): Generator<{ key: string; path: string; value: unknown }> {
  const record = obj(value);
  if (record !== null) {
    for (const [key, held] of Object.entries(record)) {
      const next = [...path, key];
      yield { key, path: next.join("."), value: held };
      yield* walkKeys(held, next);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const [index, held] of value.entries()) yield* walkKeys(held, [...path, String(index)]);
  }
}

export function indexDocuments(docs: ReadonlyArray<{ file: string; doc: unknown }>): DocIndex {
  const all: IndexedDoc[] = [];
  const byId = new Map<string, IndexedDoc>();
  const byCharterHash = new Map<string, IndexedDoc>();
  for (const entry of docs) {
    const record = obj(entry.doc);
    if (record === null) continue;
    const schema = str(record["schema"]);
    if (schema === null) continue;
    const indexed: IndexedDoc = { file: entry.file, doc: record, schema };
    all.push(indexed);
    const id = str(record["id"]);
    if (id !== null && !byId.has(id)) byId.set(id, indexed);
    if (schema === "charter") {
      const hash = str(at(record, "immutability.hash"));
      if (hash !== null) byCharterHash.set(hash, indexed);
    }
  }
  return { all, byId, byCharterHash };
}

interface RuleContext {
  readonly file: string;
  readonly doc: Record<string, unknown>;
  readonly index: DocIndex;
  readonly ctx?: CheckContext;
  readonly issues: Issue[];
}

/**
 * The domain of `finding.fingerprint.inputs.evidence_digest`, read from the
 * schema that states it.
 *
 * The domain is declared once, as `x-digest-domain` beside the field, and this
 * reads it rather than repeating it. A digest whose domain is written once in a
 * schema description and once in TypeScript has two places to drift and nothing
 * that says which one is the guarantee -- and the direction this one drifts in
 * is not a weaker check but an inverted one, because a digest that picks up
 * `location.line_range` makes `finding.fingerprint-stable-across-line-moves`
 * refuse the stable fingerprint release scenario 9 requires and accept the
 * moving one it forbids.
 */
export interface DigestDomain {
  readonly over: string;
  readonly fields: ReadonlyArray<string>;
}

const DIGEST_DOMAIN_PATH =
  "properties.fingerprint.properties.inputs.properties.evidence_digest.x-digest-domain";
const digestDomainCache = new Map<string, DigestDomain | null>();

export function digestDomain(root: string): DigestDomain | null {
  const cached = digestDomainCache.get(root);
  if (cached !== undefined) return cached;
  let found: DigestDomain | null = null;
  const file = resolve(root, "schemas", "finding.schema.json");
  if (existsSync(file)) {
    let schema: Record<string, unknown> | null = null;
    try {
      schema = obj(JSON.parse(readFileSync(file, "utf8")));
    } catch {
      schema = null;
    }
    const declared = schema === null ? null : obj(at(schema, DIGEST_DOMAIN_PATH));
    const over = declared === null ? null : str(declared["over"]);
    const fields = declared === null ? [] : arr(declared["fields"]).map(str).filter((f): f is string => f !== null);
    if (over !== null && fields.length > 0) found = { over, fields };
  }
  digestDomainCache.set(root, found);
  return found;
}

/**
 * The digest itself, so that whatever writes a finding and whatever checks one
 * compute it the same way. Nothing in this tree produces findings yet, which is
 * how the domain came to be a convention rather than a rule; when something
 * does, it calls this rather than spelling the projection a second time.
 */
export function evidenceDigest(doc: Record<string, unknown>, domain: DigestDomain): string {
  const projected = arr(at(doc, domain.over)).map((entry) => {
    const record = obj(entry);
    const out: Record<string, unknown> = {};
    for (const field of domain.fields) out[field] = record === null ? null : (at(record, field) ?? null);
    return out;
  });
  return `sha256:${sha256Hex(canonicalJson(projected))}`;
}

function fail(rc: RuleContext, rule: string, message: string): void {
  rc.issues.push(error(rule, rc.file, message));
}

// ------------------------------------------------------------------- charter

function charterRules(rc: RuleContext): void {
  const { doc } = rc;
  const immutability = obj(doc["immutability"]);
  const declaredHash = immutability === null ? null : str(immutability["hash"]);

  const RULE_HASH = "charter.hash-matches-content-and-location-is-not-worker-writable";
  if (immutability !== null && declaredHash !== null) {
    const blanked = JSON.parse(canonicalJson(doc)) as Record<string, unknown>;
    (blanked["immutability"] as Record<string, unknown>)["hash"] = "";
    const recomputed = artifactHash(blanked);
    if (recomputed !== declaredHash) {
      fail(
        rc,
        RULE_HASH,
        `charter hash ${declaredHash} does not match its content; recomputed ${recomputed} over the canonical document with immutability.hash blanked and approvals removed`,
      );
    }
  }
  if (immutability !== null) {
    if (immutability["worker_writable"] === true) {
      fail(rc, RULE_HASH, "charter declares worker_writable: true; a charter a worker can edit is not a charter");
    }
    const location = str(immutability["location"]);
    if (location !== null) {
      for (const repo of arr(doc["repos"])) {
        const record = obj(repo);
        if (record === null) continue;
        for (const glob of arr(record["paths"])) {
          const pattern = str(glob);
          if (pattern !== null && globMatches(pattern, location)) {
            fail(
              rc,
              RULE_HASH,
              `charter location ${location} falls inside worker-writable scope ${pattern} declared for repo ${str(record["repo"]) ?? "?"}`,
            );
          }
        }
      }
    }
  }

  const RULE_GRANT = "charter.sensitive-grant-requires-explicit-human-approval-bound-to-this-hash";
  for (const [i, grant] of arr(doc["sensitive_grants"]).entries()) {
    const record = obj(grant);
    if (record === null) continue;
    const approval = obj(record["approval"]);
    const bound = approval === null ? null : str(approval["artifact_hash"]);
    const action = str(record["action"]) ?? `#${i}`;
    if (approval === null) {
      fail(rc, RULE_GRANT, `sensitive grant ${action} carries no approval`);
      continue;
    }
    if (str(approval["by"]) !== "human" || str(approval["authority"]) !== "explicit") {
      fail(rc, RULE_GRANT, `sensitive grant ${action} is not approved explicitly by a human`);
    }
    if (declaredHash !== null && bound !== declaredHash) {
      fail(
        rc,
        RULE_GRANT,
        `sensitive grant ${action} is approved against ${bound ?? "no hash"}, not against this charter's hash ${declaredHash}`,
      );
    }
  }

  const RULE_SEATS = "charter.supervisor-seats-independent-and-not-the-implementer";
  const supervisors = obj(doc["supervisors"]);
  if (supervisors !== null) {
    const seats = arr(supervisors["seats"]).map(obj);
    if (seats.length !== 2) {
      fail(rc, RULE_SEATS, `supervisors.seats has ${seats.length} seats; plan 7.3 requires exactly two, with no tie-breaker`);
    }
    const ids = seats.map((s) => (s === null ? null : str(s["id"])));
    const holders = seats.map((s) => (s === null ? null : str(s["filled_by"])));
    if (new Set(ids.filter((v) => v !== null)).size !== ids.filter((v) => v !== null).length) {
      fail(rc, RULE_SEATS, "supervisor seat ids are not unique");
    }
    const named = holders.filter((v): v is string => v !== null);
    if (new Set(named).size !== named.length) {
      fail(rc, RULE_SEATS, `one actor fills both supervisor seats (${named.join(", ")}); the seating is not independent`);
    }
    const creator = creatorRole(doc);
    for (const holder of named) {
      if (holder === creator) {
        fail(rc, RULE_SEATS, `supervisor seat is filled by ${holder}, which is also the charter's created_by role`);
      }
      if (holder === "implementer") {
        fail(rc, RULE_SEATS, "a supervisor seat is filled by the implementer");
      }
    }
    if (supervisors["may_implement"] === true || supervisors["tie_breaker_allowed"] === true) {
      fail(rc, RULE_SEATS, "supervisors declare may_implement or tie_breaker_allowed; plan 7.3 forbids both");
    }
  }

  const RULE_AMEND = "charter.amendment-creates-a-new-hash-and-invalidates-old-grants";
  const supersedes = obj(doc["supersedes"]);
  if (supersedes !== null) {
    const oldHash = str(supersedes["hash"]);
    if (oldHash !== null && oldHash === declaredHash) {
      fail(rc, RULE_AMEND, `amended charter reuses the superseded charter's hash ${oldHash}; an amendment is a new charter`);
    }
    for (const grant of arr(doc["sensitive_grants"])) {
      const record = obj(grant);
      const approval = record === null ? null : obj(record["approval"]);
      if (approval !== null && oldHash !== null && str(approval["artifact_hash"]) === oldHash) {
        fail(
          rc,
          RULE_AMEND,
          `sensitive grant ${str(record?.["action"]) ?? "?"} is still bound to the superseded charter hash ${oldHash}; grants do not carry over`,
        );
      }
    }
    const oldId = str(supersedes["id"]);
    const previous = oldId === null ? undefined : rc.index.byId.get(oldId);
    if (previous !== undefined && previous.file !== rc.file && str(previous.doc["status"]) !== "superseded") {
      fail(rc, RULE_AMEND, `charter ${oldId} is superseded by this one but its own status is ${str(previous.doc["status"]) ?? "unset"}`);
    }
  }
}

// ------------------------------------------------------------------ decision

function decisionRules(rc: RuleContext): void {
  const { doc } = rc;
  const seats = arr(doc["seats"]).map(obj);
  const judgments = arr(doc["judgments"]).map(obj);
  const options = arr(doc["options"]).map(obj);

  const RULE_SEATS = "decision.seats-declared-independent-and-not-the-implementer";
  if (seats.length !== 2) {
    fail(rc, RULE_SEATS, `decision declares ${seats.length} seats; plan 7.3 requires exactly two`);
  }
  const holders = seats.map((s) => (s === null ? null : str(s["filled_by"]))).filter((v): v is string => v !== null);
  if (new Set(holders).size !== holders.length) {
    fail(rc, RULE_SEATS, `one actor fills both decision seats (${holders.join(", ")})`);
  }
  const creator = creatorRole(doc);
  for (const [i, seat] of seats.entries()) {
    if (seat === null) continue;
    if (seat["independent"] !== true) fail(rc, RULE_SEATS, `seat ${str(seat["id"]) ?? i} is not declared independent`);
    if (seat["may_implement"] === true) fail(rc, RULE_SEATS, `seat ${str(seat["id"]) ?? i} may implement`);
    const holder = str(seat["filled_by"]);
    if (holder !== null && (holder === creator || holder === "implementer")) {
      fail(rc, RULE_SEATS, `seat ${str(seat["id"]) ?? i} is filled by ${holder}, which is the implementer of the work under decision`);
    }
  }

  const RULE_CHOICE = "decision.judgment-choice-names-a-declared-option";
  const optionIds = new Set(options.map((o) => (o === null ? null : str(o["id"]))).filter((v): v is string => v !== null));
  const seatIds = new Set(seats.map((s) => (s === null ? null : str(s["id"]))).filter((v): v is string => v !== null));
  const seen = new Set<string>();
  for (const [i, judgment] of judgments.entries()) {
    if (judgment === null) continue;
    const choice = str(judgment["choice"]);
    if (choice !== null && !optionIds.has(choice)) {
      fail(rc, RULE_CHOICE, `judgment ${i} chose ${choice}, which is not one of the declared options (${[...optionIds].join(", ")})`);
    }
    const seat = str(judgment["seat"]);
    if (seat !== null) {
      if (!seatIds.has(seat)) fail(rc, RULE_CHOICE, `judgment ${i} names seat ${seat}, which is not a declared seat`);
      if (seen.has(seat)) fail(rc, RULE_CHOICE, `seat ${seat} returned more than one judgment; one judgment per seat`);
      seen.add(seat);
    }
  }

  const RULE_AGREE = "decision.agreement-matches-the-recorded-judgments";
  if (doc["agreement"] !== undefined) {
    const choices = judgments.map((j) => (j === null ? null : str(j["choice"])));
    const recomputed = judgments.length === 2 && choices[0] !== null && choices[0] === choices[1];
    if (doc["agreement"] !== recomputed) {
      fail(
        rc,
        RULE_AGREE,
        `agreement is recorded as ${String(doc["agreement"])} but the ${judgments.length} recorded judgment(s) give ${String(recomputed)}`,
      );
    }
  }

  const RULE_AUTH = "decision.authority-check-recomputed-from-charter-and-evidence";
  const check = obj(doc["authority_check"]);
  if (check !== null) {
    const evidenceRefs = new Set(
      arr(doc["evidence"]).map((e) => str(obj(e)?.["ref"])).filter((v): v is string => v !== null),
    );
    const required = arr(doc["required_evidence"]).map(str).filter((v): v is string => v !== null);
    const missing = required.filter((r) => !evidenceRefs.has(r));
    if (check["required_evidence_present"] !== undefined && check["required_evidence_present"] !== (missing.length === 0)) {
      fail(
        rc,
        RULE_AUTH,
        `required_evidence_present is ${String(check["required_evidence_present"])} but ${missing.length === 0 ? "all" : `${missing.length}`} required evidence ref(s) ${missing.length === 0 ? "resolve" : `are absent (${missing.join(", ")})`}; absent required evidence fails closed`,
      );
    }
    if (check["both_judgments_returned"] !== undefined && check["both_judgments_returned"] !== (judgments.length >= 2)) {
      fail(rc, RULE_AUTH, `both_judgments_returned is ${String(check["both_judgments_returned"])} with ${judgments.length} judgment(s) recorded`);
    }
    const independent = seats.length === 2 && seats.every((s) => s !== null && s["independent"] === true) && new Set(holders).size === holders.length;
    if (check["seats_independent"] !== undefined && check["seats_independent"] !== independent) {
      fail(rc, RULE_AUTH, `seats_independent is ${String(check["seats_independent"])} but the recorded seating gives ${String(independent)}`);
    }
    const charterHash = str(at(doc, "charter.hash"));
    const charter = charterHash === null ? undefined : rc.index.byCharterHash.get(charterHash);
    if (charter !== undefined) {
      const checkpoint = str(doc["checkpoint"]);
      const listed = arr(charter.doc["checkpoints"]).map(str);
      const inCharter = checkpoint !== null && listed.includes(checkpoint);
      if (check["checkpoint_in_charter"] !== undefined && check["checkpoint_in_charter"] !== inCharter) {
        fail(
          rc,
          RULE_AUTH,
          `checkpoint_in_charter is ${String(check["checkpoint_in_charter"])} but charter ${charter.file} lists [${listed.join(", ")}] and this decision takes ${checkpoint ?? "no checkpoint"}`,
        );
      }
    }
    const components = ["charter_permits", "required_evidence_present", "seats_independent", "checkpoint_in_charter"];
    const allTrue = components.every((k) => check[k] === true);
    const passes = str(check["result"]) === "pass";
    if (passes !== allTrue) {
      fail(
        rc,
        RULE_AUTH,
        `authority_check.result is ${str(check["result"]) ?? "unset"} while its components give ${allTrue ? "pass" : "fail"}; every component is recorded so a failure names itself`,
      );
    }
  }

  const RULE_RULING = "decision.ruling-requires-a-passed-authority-check-not-mere-agreement";
  const ruling = obj(doc["ruling"]);
  if (ruling !== null && str(ruling["outcome"]) === "decided") {
    if (check === null || str(check["result"]) !== "pass") {
      fail(rc, RULE_RULING, "ruling is decided without a passed deterministic authority check; agreement is not authority");
    }
    if (judgments.length < 2) {
      fail(rc, RULE_RULING, `ruling is decided with ${judgments.length} judgment(s); a missing judgment is a blocked checkpoint`);
    }
  }
  if (arr(doc["grants_issued"]).length > 0 && (ruling === null || str(ruling["outcome"]) !== "decided")) {
    fail(rc, RULE_RULING, "grants are issued without a decided ruling");
  }
}

// ------------------------------------------------------------------- dossier

function dossierRules(rc: RuleContext): void {
  const { doc } = rc;

  const RULE_TURNS = "dossier.turns-used-within-turns-allowed";
  const budget = obj(doc["budget"]);
  if (budget !== null) {
    const allowed = num(budget["turns_allowed"]);
    const used = num(budget["turns_used"]);
    if (allowed !== null && used !== null) {
      if (used > allowed) fail(rc, RULE_TURNS, `budget.turns_used ${used} exceeds turns_allowed ${allowed}`);
      if (budget["exhausted"] !== undefined && budget["exhausted"] !== (used >= allowed)) {
        fail(rc, RULE_TURNS, `budget.exhausted is ${String(budget["exhausted"])} with ${used} of ${allowed} turns used`);
      }
    }
  }

  const RULE_LEXICAL = "dossier.lexical-baseline-present";
  const searches = arr(doc["searches"]).map(obj);
  if (!searches.some((s) => s !== null && str(s["tool"]) === "lexical")) {
    fail(rc, RULE_LEXICAL, "no lexical search is recorded; the lexical baseline is what makes coverage checkable when an index is unavailable");
  }

  const RULE_GRAPH = "dossier.stale-or-absent-graph-documents-a-limitation";
  const limits = arr(doc["coverage_limits"]).map(obj);
  const providers = arr(doc["graph_providers"]).map(obj);
  const degraded = providers.filter((p) => {
    if (p === null) return false;
    if (p["available"] === false) return true;
    const freshness = str(at(p, "index.freshness"));
    return freshness === "stale" || freshness === "unknown";
  });
  if (degraded.length > 0 && limits.length === 0) {
    fail(
      rc,
      RULE_GRAPH,
      `${degraded.length} graph provider(s) are unavailable or of stale/unknown freshness and no coverage limitation is documented`,
    );
  }

  const RULE_VERDICT = "dossier.no-architectural-verdict";
  for (const entry of walkKeys(doc)) {
    if (DOSSIER_REFUSED_KEYS.has(entry.key)) {
      fail(rc, RULE_VERDICT, `dossier carries ${entry.path}; a dossier reports coverage and never an architectural verdict`);
    }
  }

  const RULE_INDEX = "dossier.index-revision-compared-to-source-revision";
  const sourceRevision = revisionOf(doc["source_revision"]);
  for (const entry of walkKeys(doc)) {
    const record = obj(entry.value);
    if (record === null || entry.key !== "index") continue;
    const freshness = str(record["freshness"]);
    const indexRevision = str(record["index_revision"]);
    if (indexRevision === null || sourceRevision === null) {
      if (freshness === "fresh") {
        fail(rc, RULE_INDEX, `${entry.path} claims freshness "fresh" with no index_revision to compare against the dossier's source revision`);
      }
      continue;
    }
    if (indexRevision !== sourceRevision && freshness === "fresh") {
      fail(
        rc,
        RULE_INDEX,
        `${entry.path} claims freshness "fresh" at index revision ${indexRevision} while the dossier's source revision is ${sourceRevision}`,
      );
    }
  }
}

// --------------------------------------------------------------------- event

function eventRules(rc: RuleContext): void {
  const { doc } = rc;

  const RULE_AUTH = "event.no-event-field-confers-authority";
  const trust = obj(doc["trust"]);
  if (trust !== null && trust["grants_authority"] !== false) {
    fail(rc, RULE_AUTH, "trust.grants_authority is not false; no field of an inbound event confers authority on anything");
  }
  if (trust !== null && str(trust["classification"]) !== "untrusted-claim") {
    fail(rc, RULE_AUTH, `trust.classification is ${str(trust["classification"]) ?? "unset"}; every inbound event is an untrusted claim`);
  }
  for (const [i, action] of arr(doc["requested_actions"]).entries()) {
    const record = obj(action);
    if (record !== null && record["requires_authorization"] !== true) {
      fail(rc, RULE_AUTH, `requested_actions[${i}] (${str(record["action"]) ?? "?"}) does not require authorization`);
    }
  }
  for (const entry of walkKeys(doc)) {
    if (EVENT_REFUSED_KEYS.has(entry.key)) {
      fail(rc, RULE_AUTH, `event carries ${entry.path}; a comment cannot authorize anything, so an event may not carry a grant or an approval`);
    }
  }

  const RULE_REMOTE = "event.remote-side-effect-key-is-unique-and-read-back";
  const keys = new Map<string, number>();
  for (const [i, effect] of arr(doc["side_effects_performed"]).entries()) {
    const record = obj(effect);
    if (record === null) continue;
    const kind = str(record["effect"]);
    if (kind === null || !REMOTE_SIDE_EFFECTS.has(kind)) continue;
    const key = str(record["idempotency_key"]);
    if (key === null) {
      fail(rc, RULE_REMOTE, `side_effects_performed[${i}] (${kind}) is a remote effect with no idempotency key`);
    } else if (keys.has(key)) {
      fail(rc, RULE_REMOTE, `side_effects_performed[${i}] reuses idempotency key ${key} already used by entry ${keys.get(key)}`);
    } else {
      keys.set(key, i);
    }
    if (record["skipped_as_duplicate"] === true) continue;
    const readBack = obj(record["read_back"]);
    if (readBack === null || readBack["performed"] !== true || readBack["confirmed"] !== true) {
      fail(rc, RULE_REMOTE, `side_effects_performed[${i}] (${kind}) was not read back and confirmed`);
    }
  }
}

// ------------------------------------------------------------------- finding

function rankChange(field: string, from: unknown, to: unknown): { ok: boolean; direction: string } | null {
  const key = (v: unknown): string => (v === null ? "null" : String(v));
  if (field === "severity") {
    const a = SEVERITY_RANK[key(from)];
    const b = SEVERITY_RANK[key(to)];
    return a === undefined || b === undefined ? null : { ok: b >= a, direction: "less severe" };
  }
  if (field === "spec_quality") {
    const a = SPEC_QUALITY_RANK[key(from)];
    const b = SPEC_QUALITY_RANK[key(to)];
    return a === undefined || b === undefined ? null : { ok: b >= a, direction: "more specified" };
  }
  if (field === "difficulty") {
    const a = DIFFICULTY_RANK[key(from)];
    const b = DIFFICULTY_RANK[key(to)];
    return a === undefined || b === undefined ? null : { ok: b >= a, direction: "easier" };
  }
  if (field === "autofix_class") {
    const a = AUTOFIX_RANK[key(from)];
    const b = AUTOFIX_RANK[key(to)];
    return a === undefined || b === undefined ? null : { ok: b >= a, direction: "more autofixable" };
  }
  if (field === "confidence_anchor") {
    const a = num(from);
    const b = num(to);
    return a === null || b === null ? null : { ok: b <= a, direction: "more authorized" };
  }
  return null;
}

function findingRules(rc: RuleContext): void {
  const { doc } = rc;

  const RULE_FP = "finding.fingerprint-stable-across-line-moves";
  const fingerprint = obj(doc["fingerprint"]);
  const inputs = fingerprint === null ? null : obj(fingerprint["inputs"]);
  if (inputs !== null) {
    const symbol = str(inputs["symbol_or_path"]);
    if (symbol !== null && /(:\d+|#L\d+|:\d+-\d+)$/.test(symbol)) {
      fail(rc, RULE_FP, `fingerprint input symbol_or_path is ${symbol}; identity may not depend on a line number, or a moved finding gets a new identity`);
    }
    for (const key of Object.keys(inputs)) {
      if (/line|lineno|line_range|offset/i.test(key)) {
        fail(rc, RULE_FP, `fingerprint input ${key} is line-bearing; identity inputs are rule or cause, symbol or path, and an evidence digest`);
      }
    }
    const value = str(fingerprint?.["value"] ?? null);
    const signature = canonicalJson(inputs);
    for (const other of rc.index.all) {
      if (other.file === rc.file || other.schema !== "finding") continue;
      const otherFp = obj(other.doc["fingerprint"]);
      const otherInputs = otherFp === null ? null : obj(otherFp["inputs"]);
      if (otherInputs === null) continue;
      const otherValue = str(otherFp?.["value"] ?? null);
      const sameInputs = canonicalJson(otherInputs) === signature;
      if (sameInputs && value !== null && otherValue !== null && value !== otherValue) {
        fail(rc, RULE_FP, `identical fingerprint inputs produce a different value here (${value}) than in ${other.file} (${otherValue})`);
      }
      if (!sameInputs && value !== null && value === otherValue) {
        fail(rc, RULE_FP, `fingerprint value ${value} is shared with ${other.file}, which has different identity inputs`);
      }
    }
  }

  const RULE_DIGEST = "finding.evidence-digest-domain";
  // Recomputation is all this adds. The definition it recomputes against lives
  // in the schema, so the check and the statement cannot disagree: see
  // digestDomain above for why that matters more here than for other digests.
  // Gated on ctx because the domain is read from the tree under inspection,
  // which is the same place the documents come from.
  if (inputs !== null && rc.ctx !== undefined) {
    const domain = digestDomain(rc.ctx.root);
    const declared = str(inputs["evidence_digest"]);
    if (domain === null) {
      fail(
        rc,
        RULE_DIGEST,
        `schemas/finding.schema.json declares no ${DIGEST_DOMAIN_PATH}; the domain of this digest is the whole of what release scenario 9 rests on and a domain stated only in prose is one no check can hold`,
      );
    } else if (declared !== null) {
      const recomputed = evidenceDigest(doc, domain);
      if (recomputed !== declared) {
        fail(
          rc,
          RULE_DIGEST,
          `evidence_digest ${declared} is not a digest of what the schema says it covers; recomputed ${recomputed} over ${domain.fields.join(" and ")} of each ${domain.over} entry`,
        );
      }
    }
  }

  const RULE_LABEL = "finding.presentation-label-never-substitutes-for-severity";
  const label = str(doc["presentation_label"]);
  const severity = str(doc["severity"]);
  if (label !== null) {
    if (severity === null) {
      fail(rc, RULE_LABEL, `presentation_label ${label} is recorded with no severity; the label is never the field a policy reads`);
    } else {
      const permitted = LABEL_SEVERITIES[label];
      if (permitted !== undefined && !permitted.has(severity)) {
        fail(
          rc,
          RULE_LABEL,
          `presentation_label ${label} contradicts severity ${severity}; the label is a presentation choice and never reorders severity`,
        );
      }
    }
  }

  const RULE_SYNTH = "finding.synthesis-may-only-worsen-a-grade";
  const synthesis = obj(doc["synthesis"]);
  if (synthesis !== null) {
    const originalId = str(at(synthesis, "of.id"));
    const original = originalId === null ? undefined : rc.index.byId.get(originalId);
    for (const [i, change] of arr(synthesis["changes"]).entries()) {
      const record = obj(change);
      if (record === null) continue;
      const field = str(record["field"]);
      if (field === null) continue;
      const verdict = rankChange(field, record["from"], record["to"]);
      if (verdict !== null && !verdict.ok) {
        fail(
          rc,
          RULE_SYNTH,
          `synthesis change ${i} moves ${field} from ${JSON.stringify(record["from"])} to ${JSON.stringify(record["to"])}, making the finding ${verdict.direction}; synthesis may only worsen a grade`,
        );
      }
      if (original !== undefined && original.file !== rc.file) {
        const actual = original.doc[field];
        if (actual !== undefined && canonicalJson(actual) !== canonicalJson(record["from"])) {
          fail(
            rc,
            RULE_SYNTH,
            `synthesis change ${i} records ${field} from ${JSON.stringify(record["from"])} but ${original.file} holds ${JSON.stringify(actual)}`,
          );
        }
      }
      if (doc[field] !== undefined && canonicalJson(doc[field]) !== canonicalJson(record["to"])) {
        fail(
          rc,
          RULE_SYNTH,
          `synthesis change ${i} records ${field} to ${JSON.stringify(record["to"])} but this finding holds ${JSON.stringify(doc[field])}`,
        );
      }
    }
  }

  const RULE_SEC = "finding.low-confidence-security-is-adjudicated-not-filtered";
  const lane = str(doc["lane"]) ?? "";
  const confidence = num(doc["confidence_anchor"]);
  if (lane.includes("security") && confidence !== null && confidence <= 50) {
    const status = str(doc["status"]);
    const adjudicated =
      arr(doc["conflicting_evidence"]).length > 0 || obj(doc["dispatch"]) !== null || obj(doc["closure_receipt"]) !== null;
    if ((status === "rejected" || status === "deferred") && !adjudicated) {
      fail(
        rc,
        RULE_SEC,
        `security finding at confidence ${confidence} is ${status} with no adjudication recorded; a low-confidence security concern is adjudicated, never filtered out`,
      );
    }
  }
}

// -------------------------------------------------------------------- lesson

function lessonRules(rc: RuleContext): void {
  const { doc } = rc;

  const RULE_DUP = "lesson.duplicate-of-an-existing-lesson-is-refused";
  const statement = str(doc["statement"]);
  if (statement !== null) {
    const normalized = statement.toLowerCase().replace(/\s+/g, " ").trim();
    for (const other of rc.index.all) {
      if (other.file === rc.file || other.schema !== "lesson") continue;
      const otherStatement = str(other.doc["statement"]);
      if (otherStatement === null) continue;
      if (otherStatement.toLowerCase().replace(/\s+/g, " ").trim() === normalized) {
        fail(
          rc,
          RULE_DUP,
          `restates the lesson already captured in ${other.file}; an existing lesson on the same ground is reused, never duplicated`,
        );
      }
    }
  }

  const RULE_ROLLBACK = "lesson.skill-rollback-preserves-lesson-and-evidence-history";
  const rolled = arr(doc["skill_changes"]).map(obj).filter((c) => c !== null && str(c["state"]) === "rolled-back");
  if (rolled.length > 0) {
    if (arr(doc["evidence"]).length === 0) {
      fail(rc, RULE_ROLLBACK, "a rolled-back skill revision left this lesson with no evidence; a rollback does not roll back the lesson");
    }
    if (str(doc["status"]) === "retired") {
      fail(
        rc,
        RULE_ROLLBACK,
        `lesson is retired alongside a rolled-back skill revision (${str(rolled[0]?.["skill"]) ?? "?"}); the lesson and its evidence survive the rollback intact`,
      );
    }
  }
}

// ------------------------------------------------------------------- project

function projectRules(rc: RuleContext): void {
  const { doc } = rc;

  const RULE_KB = "project.kb-root-is-not-an-application-local-docs-tree";
  const kb = obj(doc["kb"]);
  if (kb !== null) {
    if (str(kb["ownership"]) !== "central") {
      fail(rc, RULE_KB, `kb.ownership is ${str(kb["ownership"]) ?? "unset"}; central ownership is not configurable (ADR-0001)`);
    }
    for (const key of ["root", "project_path"]) {
      const value = str(kb[key]);
      if (value !== null && APP_LOCAL_KB_ROOT.test(value)) {
        fail(rc, RULE_KB, `kb.${key} is ${value}, an application-local documentation tree; project artifacts live in the central KB (ADR-0001, release scenario 21)`);
      }
    }
  }

  const RULE_STANDARDS = "project.standards-path-resolves-or-lane-returns-empty";
  const standards = arr(doc["standards"]).map(obj);
  if (rc.ctx !== undefined) {
    for (const standard of standards) {
      if (standard === null) continue;
      const path = str(standard["path"]);
      if (path === null || path.startsWith("/") || /^[a-z]+:\/\//i.test(path)) continue;
      if (!existsSync(resolve(rc.ctx.root, path))) {
        fail(
          rc,
          RULE_STANDARDS,
          `standards entry ${str(standard["id"]) ?? "?"} points at ${path}, which does not resolve; the standards lane cites these rule by rule and never invents a preference`,
        );
      }
    }
  }

  const RULE_PYRAMID = "project.test-pyramid-percentages-sum-to-100";
  const pyramid = obj(at(doc, "guidance.test_pyramid"));
  if (pyramid !== null) {
    const parts = ["unit_percent", "integration_percent", "end_to_end_percent"].map((k) => num(pyramid[k]));
    if (parts.every((p): p is number => p !== null)) {
      const total = parts.reduce((a, b) => a + b, 0);
      if (total !== 100) {
        fail(rc, RULE_PYRAMID, `guidance.test_pyramid percentages sum to ${total}, not 100`);
      }
    }
  }

  const RULE_GATE = "project.numeric-guidance-never-becomes-a-gate";
  for (const block of ["pr_size", "test_pyramid"]) {
    const record = obj(at(doc, `guidance.${block}`));
    if (record !== null && str(record["enforcement"]) !== "advisory") {
      fail(rc, RULE_GATE, `guidance.${block}.enforcement is ${str(record["enforcement"]) ?? "unset"}; numeric guidance is advisory and never a gate`);
    }
  }
  for (const [i, constraint] of arr(doc["mandatory_constraints"]).entries()) {
    const record = obj(constraint);
    if (record === null || record["blocks"] === undefined) continue;
    const text = `${str(record["id"]) ?? ""} ${str(record["requirement"]) ?? ""}`;
    if (GUIDANCE_NAMES.test(text)) {
      fail(
        rc,
        RULE_GATE,
        `mandatory_constraints[${i}] promotes numeric guidance into a ${str(record["blocks"])} gate; exceeding a target is recorded in guidance.exceptions instead`,
      );
    }
  }

  const RULE_TRACKER = "project.single-tracker-system-of-record";
  const tracker = obj(doc["tracker_policy"]);
  if (tracker !== null) {
    const record = str(at(tracker, "system_of_record.system"));
    const mirrors = arr(tracker["mirrors"]).map(obj);
    const seen = new Set<string>();
    for (const [i, mirror] of mirrors.entries()) {
      if (mirror === null) continue;
      const system = str(mirror["system"]);
      if (system === null) continue;
      if (system === record) {
        fail(rc, RULE_TRACKER, `tracker mirror ${i} names ${system}, the same system as the system of record; a projection is never a second authoritative status`);
      }
      if (seen.has(system)) {
        fail(rc, RULE_TRACKER, `tracker mirror ${i} duplicates ${system}`);
      }
      seen.add(system);
      if (str(mirror["role"]) !== "projection") {
        fail(rc, RULE_TRACKER, `tracker mirror ${i} (${system}) is not declared a projection`);
      }
    }
  }
}

// -------------------------------------------------------------------- review

function reviewRules(rc: RuleContext): void {
  const { doc } = rc;
  const authorship = obj(doc["authorship"]);
  const implementer = authorship === null ? null : str(authorship["implementer"]);
  const specApprover = authorship === null ? null : str(authorship["spec_approver"]);
  const lanes = arr(doc["lanes"]).map(obj);
  const verdict = str(doc["verdict"]);

  const RULE_SEAT = "review.seat-filled-by-someone-other-than-the-author";
  const RULE_SEC = "review.security-seat-not-filled-by-implementer-or-spec-approver";
  for (const [i, lane] of lanes.entries()) {
    if (lane === null) continue;
    const role = str(lane["role"]) ?? `#${i}`;
    const seat = obj(lane["seat"]);
    if (seat === null) continue;
    const filledBy = str(seat["filled_by"]);
    if (seat["independent_of_author"] !== true) {
      fail(rc, RULE_SEAT, `lane ${role} declares a seat that is not independent of the author; there is no self-review fallback`);
    }
    if (filledBy !== null && implementer !== null && filledBy === implementer) {
      if (role.includes("security")) {
        fail(rc, RULE_SEC, `the security seat is filled by ${filledBy}, the implementer of the change under review`);
      } else {
        fail(rc, RULE_SEAT, `lane ${role} is filled by ${filledBy}, the implementer of the change under review`);
      }
    }
    if (role.includes("security") && filledBy !== null && specApprover !== null && filledBy === specApprover) {
      fail(rc, RULE_SEC, `the security seat is filled by ${filledBy}, who approved the spec for this change`);
    }
  }

  const RULE_UNAVAILABLE = "review.unavailable-required-lane-blocks-approval";
  const blocked = lanes.filter((l) => l !== null && l["required"] === true && str(l["state"]) === "unavailable");
  if (blocked.length > 0 && verdict === "approved") {
    fail(
      rc,
      RULE_UNAVAILABLE,
      `verdict is approved while required lane(s) ${blocked.map((l) => str(l?.["role"]) ?? "?").join(", ")} are unavailable; an incomplete review is never an approval`,
    );
  }

  const RULE_CYCLES = "review.third-fix-cycle-stops";
  const cycles = obj(doc["fix_cycles"]);
  if (cycles !== null) {
    const allowed = num(cycles["allowed"]);
    const used = num(cycles["used"]);
    if (allowed !== null && allowed > 2) fail(rc, RULE_CYCLES, `fix_cycles.allowed is ${allowed}; plan 6.3 caps it at two`);
    if (allowed !== null && used !== null && used > allowed) {
      fail(rc, RULE_CYCLES, `fix_cycles.used ${used} exceeds allowed ${allowed}; the third cycle stops`);
    }
    if (allowed !== null && used !== null && used >= allowed) {
      if (verdict === "approved") {
        fail(rc, RULE_CYCLES, `the fix cycle budget is exhausted (${used}/${allowed}) and the run still approves rather than returning blocked or replan`);
      }
      if (str(cycles["exhausted_action"]) === null) {
        fail(rc, RULE_CYCLES, `the fix cycle budget is exhausted (${used}/${allowed}) with no exhausted_action recorded`);
      }
    }
  }

  const RULE_DELTA = "review.delta-scope-bounded-by-affected-behavior";
  const scope = obj(doc["delta_scope"]);
  if (str(doc["mode"]) === "delta") {
    if (scope === null || arr(scope["affected_behavior"]).length === 0) {
      fail(rc, RULE_DELTA, "a delta review declares no affected behavior; the scope boundary is affected behavior, never changed lines");
    }
  }
  if (scope !== null) {
    if (str(scope["boundary"]) !== "affected-behavior") {
      fail(rc, RULE_DELTA, `delta_scope.boundary is ${str(scope["boundary"]) ?? "unset"}; a changed-lines boundary would suppress an issue in an untouched caller`);
    }
    const untouched = arr(doc["new_findings"]).map(obj).filter((f) => f !== null && f["in_untouched_caller"] === true);
    if (untouched.length > 0 && arr(scope["excluded"]).length > 0) {
      fail(
        rc,
        RULE_DELTA,
        `${untouched.length} finding(s) were found in untouched callers while delta_scope.excluded drops ${arr(scope["excluded"]).length} area(s); the exclusions did not bound by affected behavior`,
      );
    }
  }

  const RULE_BASELINE = "review.material-change-establishes-a-new-baseline";
  const reset = obj(doc["baseline_reset"]);
  if (reset !== null) {
    if (arr(reset["invalidated_approvals"]).length === 0) {
      fail(rc, RULE_BASELINE, `baseline_reset records ${str(reset["reason"]) ?? "a material change"} but invalidates no approvals`);
    }
    if (reset["new_scope"] !== true) {
      fail(rc, RULE_BASELINE, "baseline_reset does not declare a new scope");
    }
    const used = num(at(doc, "fix_cycles.used"));
    if (used !== null && used > 0) {
      fail(
        rc,
        RULE_BASELINE,
        `baseline_reset establishes a new baseline while carrying ${used} spent fix cycle(s) forward; a new baseline is a new review scope, not an unbounded third delta loop`,
      );
    }
  }
}

// -------------------------------------------------------------- verification

function verificationRules(rc: RuleContext): void {
  const { doc } = rc;
  const status = str(doc["status"]);
  const kind = str(doc["kind"]);

  const RULE_PROSE = "verification.prose-never-substitutes-for-exit-status-and-digest";
  if (status === "passed" || status === "failed") {
    if (kind === "command") {
      if (num(doc["exit_status"]) === null) {
        fail(rc, RULE_PROSE, `a ${status} command receipt records no exit_status; an agent's description of green tests is not a receipt`);
      }
      if (str(doc["output_digest"]) === null) {
        fail(rc, RULE_PROSE, `a ${status} command receipt records no output_digest`);
      }
      const exit = num(doc["exit_status"]);
      if (status === "passed" && exit !== null && exit !== 0) {
        fail(rc, RULE_PROSE, `receipt status is passed with exit_status ${exit}`);
      }
      const disagreement = obj(doc["exit_disagreement"]);
      if (status === "failed" && exit === 0 && disagreement === null) {
        fail(rc, RULE_PROSE, "receipt status is failed with exit_status 0 but records no exit_disagreement from the output");
      }
    }
  }

  if ("exit_disagreement" in doc) {
    const disagreement = obj(doc["exit_disagreement"]);
    const outputReports = disagreement === null ? null : str(disagreement["output_reports"]);
    if (kind !== "command" || status !== "failed" || num(doc["exit_status"]) !== 0) {
      fail(rc, RULE_PROSE, "exit_disagreement is only permitted on a failed command receipt with exit_status 0");
    } else if (
      disagreement === null ||
      str(disagreement["verdict_from"]) !== "output" ||
      outputReports === null ||
      outputReports.trim().length === 0
    ) {
      fail(rc, RULE_PROSE, "exit_disagreement must name output as the verdict source and quote the failure reported by that output");
    }
  }

  const RULE_WEAK = "verification.weakened-check-requires-its-own-decision";
  const weakened = arr(doc["weakened_checks"]).map(obj);
  // The schema already requires `decision` on every entry, so a check for its
  // absence here only ever reported a defect ajv had already named on the same
  // field -- two messages for one missing member. It was not unreachable:
  // document rules run on documents that failed schema validation, which
  // tests/docrules.test.ts pins, so a clause restating a `required` does fire.
  // It just cannot fire on anything ajv let through, which makes it worth
  // nothing rather than dead. What ajv cannot see is whether the decision
  // named exists and decided anything. An unauthorized weakening, one citing an id nobody wrote, and one
  // citing a checkpoint that blocked are the same document to a shape check,
  // and the third is the one a run actually produces -- the weakening happens,
  // the escalation it depends on never comes back, and the reference stays.
  for (const [i, entry] of weakened.entries()) {
    if (entry === null) continue;
    const what = str(entry["what"]) ?? "?";
    const decisionId = str(at(entry, "decision.id"));
    if (decisionId === null) continue;
    const named = rc.index.byId.get(decisionId);
    if (named === undefined) {
      fail(rc, RULE_WEAK, `weakened_checks[${i}] (${what}) names decision ${decisionId}, which matches no artifact; the authorization is the whole of what makes this entry permissible`);
      continue;
    }
    if (named.schema !== "decision") {
      fail(rc, RULE_WEAK, `weakened_checks[${i}] (${what}) names ${decisionId}, which is a ${named.schema} rather than a decision`);
      continue;
    }
    const outcome = str(at(named.doc, "ruling.outcome"));
    if (outcome !== "decided") {
      fail(rc, RULE_WEAK, `weakened_checks[${i}] (${what}) is authorized by ${decisionId}, whose ruling is ${outcome ?? "unrecorded"}; a checkpoint that did not decide authorizes nothing`);
    }
  }
  if (weakened.length > 0 && status === "passed") {
    fail(
      rc,
      RULE_WEAK,
      `receipt passes with ${weakened.length} weakened check(s); a passing check obtained by weakening is a failure of the run, not a pass`,
    );
  }

  const RULE_STALE = "verification.receipt-stale-when-revision-differs-from-head";
  const receiptRevision = revisionOf(doc["source_revision"]);
  const id = str(doc["id"]);
  if (receiptRevision !== null && id !== null && obj(doc["invalidation"]) === null) {
    for (const other of rc.index.all) {
      if (other.schema !== "review" || other.file === rc.file) continue;
      const cited = arr(at(other.doc, "packet.verification_receipts")).some((r) => str(obj(r)?.["id"]) === id);
      if (!cited) continue;
      const head = revisionOf(other.doc["reviewed_head"]);
      if (head !== null && head !== receiptRevision) {
        fail(
          rc,
          RULE_STALE,
          `receipt is at revision ${receiptRevision} but ${other.file} reviews head ${head} and cites it as evidence; a receipt that stops describing the current state is marked and superseded, never reused`,
        );
      }
    }
  }
}

const RULES: Record<string, (rc: RuleContext) => void> = {
  charter: charterRules,
  decision: decisionRules,
  dossier: dossierRules,
  event: eventRules,
  finding: findingRules,
  lesson: lessonRules,
  project: projectRules,
  review: reviewRules,
  verification: verificationRules,
};

export function checkDocument(file: string, doc: unknown, index: DocIndex, ctx?: CheckContext): Issue[] {
  const record = obj(doc);
  if (record === null) return [];
  const schema = str(record["schema"]);
  if (schema === null) return [];
  const rule = RULES[schema];
  if (rule === undefined) return [];
  const rc: RuleContext = { file, doc: record, index, ctx, issues: [] };
  rule(rc);
  return rc.issues;
}

export function checkDocumentRules(ctx: CheckContext): Issue[] {
  const artifacts = loadArtifacts(ctx);
  const index = indexDocuments(artifacts.map((a) => ({ file: a.file, doc: a.value })));
  const found: Issue[] = [];
  for (const artifact of artifacts) {
    found.push(...checkDocument(artifact.file, artifact.value, index, ctx));
  }
  return found;
}
