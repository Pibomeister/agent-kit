/**
 * Structural validation of policies/invocation.yaml.
 *
 * The policy file states, in its own header, what `ak validate` must fail on:
 * an invocation that disagrees with catalog.yaml, a U -> U edge not carried by a
 * declared phase operation (checkInvocation owns that one), an operation whose
 * exposed_by skill is not in the catalog, an authority outside
 * common#/$defs/authority, and an operation id outside common#/$defs/operation_id.
 *
 * No policy schema exists among the fourteen declared schemas, so this check is
 * hand-written and reads the vocabularies out of schemas/common.schema.json when
 * it is present, falling back to the values plan 7.2 fixes when it is not.
 */

import { join } from "node:path";
import { parse as parseYaml } from "yaml";

import type { CheckContext } from "./context.ts";
import { error, note, type Issue } from "./types.ts";
import { readTextIfPresent } from "../util/fs.ts";

const POLICY_FILE = "policies/invocation.yaml";
const OPERATION_ID = /^[a-z0-9]+(-[a-z0-9]+)*\.[a-z0-9]+(-[a-z0-9]+)*$/;

const FALLBACK_AUTHORITY = [
  "explicit",
  "explicit-or-standing",
  "explicit-or-delegated",
  "delegated-grant",
  "active-review-run",
  "model",
];
const FALLBACK_REMOTE_SIDE_EFFECTS = [
  "remote-push",
  "pr-open",
  "pr-comment",
  "pr-thread-resolve",
  "kb-publish",
  "tracker-write",
];

/**
 * Authorities an operation is reached through a runner-validated grant.
 *
 * `on_unvalidatable_grant` says what happens when that grant cannot be
 * validated, so it only has something to govern for these three. An operation
 * with `authority: model` declares no grant, and `authority: explicit` is a
 * human asking in this session; for those, `not-applicable` is the literal
 * truth rather than a side door, and demanding `stop-for-explicit-invocation`
 * applies a grant rule to an operation outside the grant system.
 */
const GRANT_BEARING_AUTHORITY: ReadonlySet<string> = new Set([
  "delegated-grant",
  "explicit-or-delegated",
  "active-review-run",
]);
const FALLBACK_COVERS = [
  "align-answer",
  "spec-approval",
  "ticket-approval",
  "build-go",
  "finding-adjudication",
  "delta-closure",
  "ship-pr",
  "ci-repair",
  "lesson-publication",
  "plan-conflict-ruling",
];

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

/** The authority, checkpoint, grantable and sensitive vocabularies, from common when available. */
function vocabularies(root: string): { authority: Set<string>; covers: Set<string>; remoteSideEffects: Set<string> } {
  const text = readTextIfPresent(join(root, "schemas/common.schema.json"));
  const authority = new Set(FALLBACK_AUTHORITY);
  const covers = new Set(FALLBACK_COVERS);
  const remoteSideEffects = new Set(FALLBACK_REMOTE_SIDE_EFFECTS);
  const fallback = { authority, covers, remoteSideEffects };
  if (text === null) return fallback;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return fallback;
  }
  const defs = obj(obj(parsed)?.["$defs"]);
  if (defs === null) return fallback;
  const readEnum = (name: string, into: Set<string>): void => {
    const values = arr(obj(defs[name])?.["enum"]);
    if (values.length === 0) return;
    if (name === "authority" || name === "remote_side_effect") into.clear();
    for (const value of values) {
      const member = str(value);
      if (member !== null) into.add(member);
    }
  };
  readEnum("authority", authority);
  readEnum("remote_side_effect", remoteSideEffects);
  covers.clear();
  for (const name of ["checkpoint_category", "grantable_action", "sensitive_action"]) readEnum(name, covers);
  if (covers.size === 0) for (const value of FALLBACK_COVERS) covers.add(value);
  return { authority, covers, remoteSideEffects };
}

export function checkPolicies(ctx: CheckContext): Issue[] {
  const issues: Issue[] = [];
  const text = readTextIfPresent(join(ctx.root, POLICY_FILE));
  if (text === null) {
    return [
      note(
        "policy.invocation-unavailable",
        POLICY_FILE,
        "the invocation policy is not present; the invocation graph falls back to catalog.yaml and no operation counts as grant-validated",
      ),
    ];
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch (cause) {
    return [
      error(
        "policy.unparseable",
        POLICY_FILE,
        `could not be parsed: ${cause instanceof Error ? cause.message : String(cause)}`,
      ),
    ];
  }
  const policy = obj(parsed);
  if (policy === null) {
    return [error("policy.unparseable", POLICY_FILE, "the invocation policy is not a mapping")];
  }

  const { authority: AUTHORITY, covers: COVERS, remoteSideEffects } = vocabularies(ctx.root);
  const catalogSkills = new Map(ctx.catalog.bySection("skills").map((e) => [e.id, e]));
  const classified = new Set<string>();

  const entrypoints = obj(policy["entrypoints"]) ?? {};
  for (const [group, expected] of [
    ["user_invoked", "U"],
    ["model_invoked", "M"],
  ] as const) {
    const block = obj(entrypoints[group]);
    if (block === null) continue;

    const declaredAuthority = str(block["authority"]);
    if (declaredAuthority !== null && !AUTHORITY.has(declaredAuthority)) {
      issues.push(
        error(
          "policy.unknown-authority",
          POLICY_FILE,
          `entrypoints.${group}.authority is ${declaredAuthority}, which is not a value of common#/$defs/authority`,
        ),
      );
    }

    const listed = arr(block["skills"])
      .map(str)
      .filter((v): v is string => v !== null);
    const count = block["count"];
    if (typeof count === "number" && count !== listed.length) {
      issues.push(
        error(
          "policy.entrypoint-count-mismatch",
          POLICY_FILE,
          `entrypoints.${group}.count is ${count} but ${listed.length} skill(s) are listed`,
        ),
      );
    }

    for (const id of listed) {
      const entry = catalogSkills.get(id);
      if (entry === undefined) {
        issues.push(
          error(
            "policy.skill-not-in-catalog",
            POLICY_FILE,
            `entrypoints.${group} lists ${id}, which catalog.yaml does not declare`,
          ),
        );
        continue;
      }
      classified.add(id);
      if (entry.invocation !== undefined && entry.invocation !== expected) {
        issues.push(
          error(
            "policy.invocation-disagrees-with-catalog",
            POLICY_FILE,
            `${id} is listed under entrypoints.${group} but catalog.yaml declares invocation ${entry.invocation}`,
          ),
        );
      }
    }
  }

  for (const [id, entry] of catalogSkills) {
    if (!classified.has(id) && Object.keys(entrypoints).length > 0) {
      issues.push(
        error(
          "policy.skill-not-classified",
          POLICY_FILE,
          `catalog skill ${id} (invocation ${entry.invocation ?? "unset"}) appears under neither user_invoked nor model_invoked`,
        ),
      );
    }
  }

  // `per_entrypoint` is a key of `entrypoints`, not of the document. Reading it
  // from the document root is where these four checks used to look, and the
  // authored policy has never had it there -- so every one of them was dead on
  // `policies/invocation.yaml` while passing a unit test that appended the
  // block at column 0. A check that cannot fire is worse than an absent one,
  // because the clean run is read as evidence.
  const perEntrypoint = obj(entrypoints["per_entrypoint"]) ?? {};
  if (obj(policy["per_entrypoint"]) !== null) {
    issues.push(
      error(
        "policy.per-entrypoint-misplaced",
        POLICY_FILE,
        "per_entrypoint is declared at the document root; it is read at entrypoints.per_entrypoint and a block at the root is never checked against catalog.yaml.",
      ),
    );
  }
  for (const [skillId, named] of Object.entries(perEntrypoint)) {
    const entry = catalogSkills.get(skillId);
    if (entry === undefined) {
      issues.push(
        error(
          "policy.skill-not-in-catalog",
          POLICY_FILE,
          `per_entrypoint names ${skillId}, which catalog.yaml does not declare`,
        ),
      );
      continue;
    }
    // Agreement is entry-for-entry, so it fails in both directions. Only the
    // policy-declares-extra direction was checked; a catalog entrypoint the
    // policy omits left the law with no machine-readable authority for it.
    for (const name of Object.keys(entry.entrypoints ?? {})) {
      if (obj(named)?.[name] === undefined) {
        issues.push(
          error(
            "policy.entrypoint-disagrees-with-catalog",
            POLICY_FILE,
            `catalog.yaml declares entrypoint ${name} on ${skillId}, which per_entrypoint.${skillId} omits`,
          ),
        );
      }
    }
    for (const [name, value] of Object.entries(obj(named) ?? {})) {
      const record = obj(value);
      if (record === null) continue;
      const declaredAuthority = str(record["authority"]);
      if (declaredAuthority !== null && !AUTHORITY.has(declaredAuthority)) {
        issues.push(
          error(
            "policy.unknown-authority",
            POLICY_FILE,
            `per_entrypoint.${skillId}.${name}.authority is ${declaredAuthority}, which is not a value of common#/$defs/authority`,
          ),
        );
      }
      const catalogEntrypoint = entry.entrypoints?.[name];
      if (catalogEntrypoint === undefined) {
        issues.push(
          error(
            "policy.entrypoint-disagrees-with-catalog",
            POLICY_FILE,
            `per_entrypoint.${skillId} declares entrypoint ${name}, which catalog.yaml does not`,
          ),
        );
        continue;
      }
      const invocation = str(record["invocation"]);
      if (
        invocation !== null &&
        catalogEntrypoint.invocation !== undefined &&
        invocation !== catalogEntrypoint.invocation
      ) {
        issues.push(
          error(
            "policy.entrypoint-disagrees-with-catalog",
            POLICY_FILE,
            `per_entrypoint.${skillId}.${name}.invocation is ${invocation} but catalog.yaml declares ${catalogEntrypoint.invocation}`,
          ),
        );
      }
      if (
        declaredAuthority !== null &&
        catalogEntrypoint.authority !== undefined &&
        declaredAuthority !== catalogEntrypoint.authority
      ) {
        issues.push(
          error(
            "policy.entrypoint-disagrees-with-catalog",
            POLICY_FILE,
            `per_entrypoint.${skillId}.${name}.authority is ${declaredAuthority} but catalog.yaml declares ${catalogEntrypoint.authority}`,
          ),
        );
      }
    }
  }

  const seen = new Set<string>();
  for (const [i, operation] of arr(policy["operations"]).entries()) {
    const record = obj(operation);
    if (record === null) {
      issues.push(error("policy.malformed-operation-id", POLICY_FILE, `operations[${i}] is not a mapping`));
      continue;
    }
    const id = str(record["id"]);
    if (id === null || !OPERATION_ID.test(id)) {
      issues.push(
        error(
          "policy.malformed-operation-id",
          POLICY_FILE,
          `operations[${i}] id ${id ?? "is missing"} does not match common#/$defs/operation_id (<domain>.<action>)`,
        ),
      );
    } else if (seen.has(id)) {
      issues.push(error("policy.duplicate-operation-id", POLICY_FILE, `operation id ${id} is declared more than once`));
    } else {
      seen.add(id);
    }

    const label = id ?? `operations[${i}]`;
    const exposedBy = str(record["exposed_by"]);
    if (exposedBy === null) {
      issues.push(
        error("policy.operation-exposed-by-unknown-skill", POLICY_FILE, `${label} declares no exposed_by skill`),
      );
    } else if (!catalogSkills.has(exposedBy)) {
      issues.push(
        error(
          "policy.operation-exposed-by-unknown-skill",
          POLICY_FILE,
          `${label} is exposed_by ${exposedBy}, which catalog.yaml does not declare`,
        ),
      );
    }

    const entrypointName = str(record["entrypoint"]);
    if (entrypointName !== null && exposedBy !== null) {
      const entry = catalogSkills.get(exposedBy);
      if (entry !== undefined && entry.entrypoints !== undefined && entry.entrypoints[entrypointName] === undefined) {
        issues.push(
          error(
            "policy.entrypoint-disagrees-with-catalog",
            POLICY_FILE,
            `${label} names entrypoint ${entrypointName} on ${exposedBy}, which catalog.yaml does not declare`,
          ),
        );
      }
    }

    for (const caller of arr(record["callable_by"])) {
      const callerId = str(caller);
      if (callerId === null) continue;
      if (!catalogSkills.has(callerId)) {
        issues.push(
          error(
            "policy.operation-callable-by-unknown-skill",
            POLICY_FILE,
            `${label} is callable_by ${callerId}, which catalog.yaml does not declare`,
          ),
        );
      }
    }

    const operationAuthority = str(record["authority"]);
    if (operationAuthority === null) {
      issues.push(error("policy.unknown-authority", POLICY_FILE, `${label} declares no authority`));
    } else if (!AUTHORITY.has(operationAuthority)) {
      issues.push(
        error(
          "policy.unknown-authority",
          POLICY_FILE,
          `${label} authority is ${operationAuthority}, which is not a value of common#/$defs/authority`,
        ),
      );
    }

    for (const grant of [record["grant"], ...arr(record["also_requires"])]) {
      const grantRecord = obj(grant);
      if (grantRecord === null) continue;
      const covers = str(grantRecord["covers"]);
      if (covers !== null && !COVERS.has(covers)) {
        issues.push(
          error(
            "policy.unknown-grant-cover",
            POLICY_FILE,
            `${label} requires a grant covering ${covers}, which is not a checkpoint_category, grantable_action or sensitive_action in common`,
          ),
        );
      }
    }

    const onUnvalidatable = str(record["on_unvalidatable_grant"]);
    if (
      operationAuthority !== null &&
      GRANT_BEARING_AUTHORITY.has(operationAuthority) &&
      onUnvalidatable !== "stop-for-explicit-invocation"
    ) {
      issues.push(
        error(
          "policy.side-door-on-unvalidatable-grant",
          POLICY_FILE,
          `${label} is reached through a grant (authority: ${operationAuthority}) but declares on_unvalidatable_grant: ${onUnvalidatable ?? "nothing"}; an operation whose grant cannot be validated stops for explicit invocation, or it is a side door around the invocation law`,
        ),
      );
    }

    /**
     * The side door the rule above was reaching for. "No grant required" is
     * exactly what a side door would claim, so the thing to fail is not the
     * absence of a grant but a durable, external effect reached without one: an
     * operation the model may start on its own that pushes, opens a PR,
     * comments, publishes to the knowledge base or writes to the tracker.
     * Producing a local draft under model authority is the shape this leaves
     * alone, and it is the shape the design intends.
     */
    if (operationAuthority === "model") {
      const remote = arr(record["side_effects"])
        .map((value) => str(value))
        .filter((value): value is string => value !== null && remoteSideEffects.has(value));
      if (remote.length > 0) {
        issues.push(
          error(
            "policy.remote-side-effect-under-model-authority",
            POLICY_FILE,
            `${label} is authority: model but declares the remote side effect(s) ${remote.join(", ")}; an effect outside this workspace is reached through a grant or an explicit invocation, never because the model decided the description matched`,
          ),
        );
      }
    }
  }

  return issues;
}
