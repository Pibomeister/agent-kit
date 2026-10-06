/**
 * `x-validator-rule` checks that bind configuration rather than run artifacts:
 * catalog.yaml, skills/<id>/skill.yaml and packs/<id>/pack.yaml.
 */

import { join } from "node:path";
import { parse as parseYaml } from "yaml";

import { CATALOG_FILE } from "../catalog/load.ts";
import type { CheckContext } from "./context.ts";
import { error, unavailable, warning, type Issue } from "./types.ts";
import { loadArtifacts } from "./artifacts.ts";
import { readTextIfPresent } from "../util/fs.ts";

const RULE_CATALOG_IDS = "catalog.ids-unique-across-all-sections-and-every-entry-has-a-directory";
const RULE_REFERENCE_LOADER = "catalog.reference-loaded-by-names-a-declared-skill";
const RULE_DEFAULT_PROFILE = "catalog.exactly-one-default-profile-matching-package-default-profile";
const RULE_SKILL_INVOCATION = "skill.user-invoked-never-starts-user-invoked";
const RULE_SKILL_BUDGET = "skill.budget-enforces-only-declared-limits";
const RULE_PACK_ACTIVATION = "pack.activation-requires-artifact-and-semantics";
const RULE_PACK_ATTACHMENT = "pack.attachment-records-rationale-and-matched-rule";

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

export function checkCatalogRules(ctx: CheckContext): Issue[] {
  const issues: Issue[] = [];
  const { catalog } = ctx;

  /**
   * Uniqueness within a section is the gate, and `loadCatalog` reports it as
   * `catalog.duplicate-id`: a section is what resolves an id, so two entries
   * sharing one inside a section make the second unreachable.
   *
   * A collision across two sections is a warning instead. No reference form in
   * the package resolves a bare id: profiles list ids grouped by kind,
   * resolved-conflicts `binds` groups by kind, schemas `$ref` by filename, and
   * the packager emits per-section directories. Nothing is ambiguous today, so
   * an error here would be a false gate — but the warning is already in place
   * to promote the day a bare-id reference form is introduced.
   */
  const seen = new Map<string, string>();
  for (const entry of catalog.entries) {
    const previous = seen.get(entry.id);
    if (previous !== undefined && previous !== entry.section) {
      issues.push(
        warning(
          RULE_CATALOG_IDS,
          "catalog.yaml",
          `id ${entry.id} is declared in both ${previous} and ${entry.section}. No reference form in this package resolves a bare id across sections, so nothing is ambiguous today; a reference form that did would make this a collision`,
        ),
      );
    }
    seen.set(entry.id, entry.section);
  }

  const skillIds = catalog.skillIds();
  for (const reference of catalog.bySection("references")) {
    if (reference.loadedBy.length === 0) {
      issues.push(
        error(
          RULE_REFERENCE_LOADER,
          reference.file,
          `reference ${reference.id} declares no loaded_by; progressive disclosure is only checkable when the loaders are named`,
        ),
      );
      continue;
    }
    for (const loader of reference.loadedBy) {
      if (!skillIds.has(loader)) {
        issues.push(
          error(
            RULE_REFERENCE_LOADER,
            reference.file,
            `reference ${reference.id} is loaded_by ${loader}, which is not a declared skill`,
          ),
        );
      }
    }
  }

  const profiles = catalog.bySection("profiles");
  if (profiles.length > 0) {
    const defaults = profiles.filter((p) => p.raw["default"] === true);
    if (defaults.length !== 1) {
      // A fragment's profile is named with its file. The default is
      // package.default_profile's to name, and a fragment cannot carry a
      // package: block, so a second default declared in a fragment is the
      // fragment's defect and the report says where it is.
      const fromFragment = defaults.find((d) => d.file !== CATALOG_FILE);
      issues.push(
        error(
          RULE_DEFAULT_PROFILE,
          fromFragment?.file ?? CATALOG_FILE,
          `${defaults.length} profile(s) carry default: true (${defaults.map((d) => (d.file === CATALOG_FILE ? d.id : `${d.id} in ${d.file}`)).join(", ") || "none"}); exactly one does`,
        ),
      );
    }
    const declared = catalog.package.defaultProfile;
    const first = defaults[0];
    if (first !== undefined && first.id !== declared) {
      issues.push(
        error(
          RULE_DEFAULT_PROFILE,
          first.file,
          `profile ${first.id} is the default but package.default_profile is ${declared}`,
        ),
      );
    }
    if (declared.length > 0 && !profiles.some((p) => p.id === declared)) {
      issues.push(
        error(
          RULE_DEFAULT_PROFILE,
          "catalog.yaml",
          `package.default_profile is ${declared}, which is not a declared profile`,
        ),
      );
    }
  }

  return issues;
}

/** `$defs/capability` from schemas/common.schema.json, or null when it cannot be read. */
function capabilityVocabulary(root: string): Set<string> | null {
  const text = readTextIfPresent(join(root, "schemas/common.schema.json"));
  if (text === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const members = arr(obj(obj(obj(parsed)?.["$defs"])?.["capability"])?.["enum"])
    .map(str)
    .filter((value): value is string => value !== null);
  return members.length === 0 ? null : new Set(members);
}

/**
 * Every id a profile lists as a capability is a host capability.
 *
 * A profile is what an installer reads to decide what the host must supply, so
 * a side-effect id there (`skill-source-write` was one) asks the host for a
 * capability no adapter contract defines and no skill's `requires` can name.
 * No schema is applied to profiles/, so the vocabulary is read from common
 * rather than restated. Unreadable while a profile lists capabilities, the
 * lists are present and unexamined, which blocks like
 * rulings.discharge-vocabulary-unavailable does.
 */
export function checkProfileCapabilities(ctx: CheckContext): Issue[] {
  const issues: Issue[] = [];
  const vocabulary = capabilityVocabulary(ctx.root);
  const unexamined: string[] = [];

  for (const profile of ctx.catalog.bySection("profiles")) {
    const file = `profiles/${profile.id}.yaml`;
    const manifest = readManifest(ctx, file, "profile.unparseable", issues);
    if (manifest === null) continue;
    const capabilities = obj(obj(manifest.doc["includes"])?.["capabilities"]);
    if (capabilities === null) continue;
    // Every list under includes.capabilities names capabilities, whatever it
    // is called; only `note` is prose. A fixed list of keys would pass a new
    // one unexamined.
    for (const [list, values] of Object.entries(capabilities)) {
      if (list === "note" || !Array.isArray(values)) continue;
      for (const value of values) {
        const id = str(value);
        if (id === null) continue;
        if (vocabulary === null) {
          if (!unexamined.includes(file)) unexamined.push(file);
          continue;
        }
        if (!vocabulary.has(id)) {
          issues.push(
            error(
              "profile.unknown-capability",
              file,
              `includes.capabilities.${list} lists ${id}, which is not in schemas/common.schema.json#/$defs/capability; a host is asked to supply only capabilities, never a side effect or a free-form name`,
            ),
          );
        }
      }
    }
  }

  if (unexamined.length > 0) {
    issues.push(
      unavailable(
        "profile.capability-vocabulary-unavailable",
        "schemas/common.schema.json",
        "profile capabilities",
        `schemas/common.schema.json has no readable $defs/capability enum, so the capability lists in ${unexamined.join(", ")} were not checked.`,
      ),
    );
  }
  return issues;
}

interface ManifestFile {
  readonly file: string;
  readonly doc: Record<string, unknown>;
}

function readManifest(ctx: CheckContext, file: string, rule: string, issues: Issue[]): ManifestFile | null {
  const text = readTextIfPresent(join(ctx.root, file));
  if (text === null) return null;
  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch (cause) {
    issues.push(
      error(rule, file, `manifest could not be parsed: ${cause instanceof Error ? cause.message : String(cause)}`),
    );
    return null;
  }
  const doc = obj(parsed);
  return doc === null ? null : { file, doc };
}

export function checkSkillManifests(ctx: CheckContext): Issue[] {
  const issues: Issue[] = [];
  const { catalog } = ctx;

  const manifests = new Map<string, ManifestFile>();
  for (const skill of catalog.bySection("skills")) {
    const manifest = readManifest(ctx, `skills/${skill.id}/skill.yaml`, RULE_SKILL_INVOCATION, issues);
    if (manifest !== null) manifests.set(skill.id, manifest);
  }

  /** A child's invocation lives in the child's own file; the catalog is the fallback. */
  const invocationOf = (id: string): "U" | "M" | null => {
    const declared = str(manifests.get(id)?.doc["invocation"] ?? null);
    if (declared === "U" || declared === "M") return declared;
    const entry = catalog.get("skills", id);
    return entry?.invocation ?? null;
  };

  for (const [id, manifest] of manifests) {
    const invocation = invocationOf(id);
    if (invocation === "U") {
      for (const child of arr(manifest.doc["child_skills"])) {
        const childId = str(child);
        if (childId === null) continue;
        if (!catalog.skillIds().has(childId)) {
          issues.push(
            error(RULE_SKILL_INVOCATION, manifest.file, `child_skills names ${childId}, which is not a declared skill`),
          );
          continue;
        }
        if (invocationOf(childId) === "U") {
          issues.push(
            error(
              RULE_SKILL_INVOCATION,
              manifest.file,
              `user-invoked ${id} lists user-invoked ${childId} in child_skills; the only permitted path between two U skills is a declared phase operation under a runner-validated grant`,
            ),
          );
        }
      }
    }

    /**
     * An output bound to a run-artifact schema is a durable, hash-bound record
     * (docs/decisions/0001-kb-document-vocabulary.md §3, run-artifact column),
     * so the skill cannot run without `artifact-write`. `outputs[].schema` is
     * typed `$defs/schema_id` by skill.schema.json, so any value here is a
     * run-artifact schema; a value outside the enum is schemas.document-invalid.
     *
     * One direction only. research, source-driven, simplify and writing-skills
     * write envelope artifacts that no schema_id names yet, so requiring a
     * schema-bound output of every skill that needs the capability would report
     * correct manifests.
     */
    const bound = arr(manifest.doc["outputs"])
      .map((output) => {
        const record = obj(output);
        return record === null ? null : { id: str(record["id"]) ?? "?", schema: str(record["schema"]) };
      })
      .filter((output): output is { id: string; schema: string } => output !== null && output.schema !== null);
    const requires = arr(manifest.doc["requires"]).map(str);
    if (bound.length > 0 && !requires.includes("artifact-write")) {
      issues.push(
        error(
          "capability.artifact-write-missing",
          manifest.file,
          `${id} emits run artifacts (${bound.map((o) => `${o.id}: ${o.schema}`).join(", ")}) but its requires does not list artifact-write; a host that cannot store and hash-bind them would expose the skill as if it could`,
        ),
      );
    }

    const budget = obj(manifest.doc["budget"]);
    if (budget !== null) {
      const providedBy = str(budget["provided_by"]);
      if (providedBy !== "runner") {
        issues.push(
          error(
            RULE_SKILL_BUDGET,
            manifest.file,
            `budget.provided_by is ${providedBy ?? "unset"}; budgets are handed in by the runner and never computed here`,
          ),
        );
      }
      const limits = obj(manifest.doc["limits"]) ?? {};
      for (const enforced of arr(budget["enforces"])) {
        const name = str(enforced);
        if (name === null) continue;
        if (!(name in limits)) {
          issues.push(
            error(
              RULE_SKILL_BUDGET,
              manifest.file,
              `budget.enforces names ${name}, which is not one of this skill's declared limits (${Object.keys(limits).join(", ") || "none"}); this package enforces only the cap it was handed`,
            ),
          );
        }
      }
    }
  }

  return issues;
}

export function checkPackManifests(ctx: CheckContext): Issue[] {
  const issues: Issue[] = [];

  for (const pack of ctx.catalog.bySection("packs")) {
    const manifest = readManifest(ctx, `packs/${pack.id}/pack.yaml`, RULE_PACK_ACTIVATION, issues);
    if (manifest === null) continue;
    const activation = obj(manifest.doc["activation"]);
    if (activation === null) continue;

    const rules = arr(activation["rules"]);
    if (rules.length === 0) {
      issues.push(error(RULE_PACK_ACTIVATION, manifest.file, "activation declares no rules"));
    }
    for (const [i, rule] of rules.entries()) {
      const record = obj(rule);
      if (record === null) continue;
      const id = str(record["id"]) ?? `#${i}`;
      const kinds = arr(record["artifact_kinds"]).filter((k) => str(k) !== null);
      const semantics = arr(record["semantics"]).filter((s) => str(s) !== null);
      if (kinds.length === 0 || semantics.length === 0) {
        issues.push(
          error(
            RULE_PACK_ACTIVATION,
            manifest.file,
            `activation rule ${id} declares ${kinds.length} artifact kind(s) and ${semantics.length} semantic(s); both are required, so a rule that fires on a file extension alone is not expressible`,
          ),
        );
      }
    }

    const examples = arr(activation["examples"]).map(obj);
    if (examples.length < 2) {
      issues.push(
        error(
          RULE_PACK_ACTIVATION,
          manifest.file,
          `activation declares ${examples.length} example(s); at least two are required`,
        ),
      );
    }
    if (examples.length > 0 && !examples.some((e) => e !== null && e["attaches"] === false)) {
      issues.push(
        error(
          RULE_PACK_ACTIVATION,
          manifest.file,
          "activation examples contain no negative case; a rule with no example that does not attach has no demonstrated boundary",
        ),
      );
    }
  }

  const artifacts = loadArtifacts(ctx);
  for (const artifact of artifacts) {
    for (const [i, attachment] of arr(artifact.value["packs_attached"]).entries()) {
      const record = obj(attachment);
      if (record === null) continue;
      const pack = str(record["pack"]) ?? `#${i}`;
      if (arr(record["matched_rules"]).length === 0) {
        issues.push(
          error(
            RULE_PACK_ATTACHMENT,
            artifact.file,
            `packs_attached[${i}] (${pack}) names no matched rule; the reason a pack attached is recorded, never reconstructed`,
          ),
        );
      }
      if (str(record["rationale"]) === null) {
        issues.push(error(RULE_PACK_ATTACHMENT, artifact.file, `packs_attached[${i}] (${pack}) records no rationale`));
      }
      for (const key of ["grant", "grants", "approval", "approvals", "authority"]) {
        if (record[key] !== undefined) {
          issues.push(
            error(
              RULE_PACK_ATTACHMENT,
              artifact.file,
              `packs_attached[${i}] (${pack}) carries ${key}; attaching a pack authorizes nothing`,
            ),
          );
        }
      }
    }
  }

  return issues;
}
