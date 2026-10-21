import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";

import { CATALOG_FRAGMENT_DIR, type Catalog } from "../catalog/load.ts";
import { readTextIfPresent } from "../util/fs.ts";
import { candidatesClause } from "../util/suggest.ts";
import { error, note, type Issue } from "../validation/types.ts";
import { compileSchemas } from "../validation/schemas.ts";

export interface ProfileMembership {
  /**
   * The profile actually applied, or `"all"` when none was. Returned rather
   * than left to each caller to re-derive: the caller that recorded it in the
   * bundle and the caller that printed it had each worked it out separately and
   * had stopped agreeing.
   */
  profile: string;
  skills: string[];
  issues: Issue[];
}
interface AutonomyProjectRecord {
  autonomy?: { default: boolean };
}

/** What `--profile` accepts: every profile catalog.yaml declares, and `all`. */
export function profileIds(catalog: Catalog): string[] {
  const declared = catalog.bySection("profiles").map((e) => e.id);
  return declared.includes("all") ? declared : [...declared, "all"];
}

/**
 * A profile's member list. profiles/<id>.yaml is authoritative; when it is not
 * authored yet the catalog's per-skill `profiles:` field answers the same
 * question, and the substitution is reported.
 *
 * A build that names no profile or project record installs `package.default_profile`.
 * A validated project record can opt into autonomy; an explicit `--profile` wins.
 * Ignoring the package default once made a no-flag build select every skill while
 * announcing the default's name.
 *
 * The fallback is taken only when the default names a profile the catalog
 * declares. A `default_profile` naming nothing is a defect in that field, and
 * `catalog.exactly-one-default-profile-matching-package-default-profile` is the
 * rule that says so; honoring
 * it here as well would empty the bundle, and an empty bundle takes every check
 * that reads a plan down with it -- `links.broken-bundle` stops reporting
 * because there is nothing left to link. One bad field would silence an
 * unrelated check. Selecting everything and saying `"all"` keeps both the build
 * and the complaint honest.
 *
 * `--profile all` asks for that same everything on purpose: every catalog skill,
 * whatever profile it belongs to. The routing eval builds it so each skill its
 * prompts target, and each command the roster lists, is installed. A catalog
 * that declares its own profile named `all` keeps it.
 */
export function resolveProfile(
  root: string,
  catalog: Catalog,
  profileId: string | undefined,
  projectPath?: string,
): ProfileMembership {
  const all = catalog.bySection("skills").map((e) => e.id);
  const declaredDefault = catalog.package.defaultProfile;
  const hasDefault = declaredDefault.length > 0 && catalog.get("profiles", declaredDefault) !== undefined;
  let projectDefault = false;
  if (projectPath !== undefined) {
    const path = resolve(root, projectPath);
    try {
      const content = readTextIfPresent(path);
      if (content === null) throw new Error("project record is missing");
      const value: unknown = parseYaml(content);
      const validate = compileSchemas(root).ajv.getSchema<AutonomyProjectRecord>(
        "https://agent-kit.local/schemas/project.schema.json",
      );
      if (validate === undefined) throw new Error("project schema is unavailable");
      const isProject = (candidate: unknown): candidate is AutonomyProjectRecord => validate(candidate) === true;
      if (!isProject(value))
        throw new Error(`project record does not validate: ${JSON.stringify(validate?.errors ?? [])}`);
      projectDefault = value.autonomy?.default === true;
    } catch (cause) {
      return {
        profile: profileId ?? declaredDefault,
        skills: [],
        issues: [
          error("packaging.project-invalid", projectPath, cause instanceof Error ? cause.message : String(cause)),
        ],
      };
    }
  }
  const selected = profileId ?? (projectDefault ? "autonomy" : hasDefault ? declaredDefault : undefined);
  if (selected === "all" && catalog.get("profiles", "all") === undefined)
    return { profile: "all", skills: all, issues: [] };
  if (selected === undefined) return { profile: "all", skills: all, issues: [] };

  if (catalog.get("profiles", selected) === undefined) {
    return {
      profile: selected,
      skills: [],
      issues: [
        error(
          "packaging.unknown-profile",
          "catalog.yaml",
          `Profile '${selected}' is not declared in catalog.yaml or a ${CATALOG_FRAGMENT_DIR}/ fragment; ${candidatesClause(selected, profileIds(catalog))}`,
        ),
      ],
    };
  }

  const file = `profiles/${selected}.yaml`;
  const text = readTextIfPresent(join(root, file));
  if (text !== null) {
    try {
      const parsed = parseYaml(text) as unknown;
      const record =
        parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : {};
      const declared = Array.isArray(record["skills"])
        ? (record["skills"] as unknown[]).filter((s): s is string => typeof s === "string")
        : null;
      if (declared !== null) {
        const issues: Issue[] = [];
        const known = new Set(all);
        for (const id of declared) {
          if (!known.has(id)) {
            issues.push(
              error(
                "packaging.profile-unknown-member",
                file,
                `Profile '${selected}' lists skill '${id}', which catalog.yaml does not declare.`,
              ),
            );
          }
        }
        return { profile: selected, skills: declared.filter((id) => known.has(id)), issues };
      }
    } catch (cause) {
      return {
        profile: selected,
        skills: [],
        issues: [error("packaging.profile-unparseable", file, cause instanceof Error ? cause.message : String(cause))],
      };
    }
  }

  const fromCatalog = catalog
    .bySection("skills")
    .filter((e) => e.profiles.includes(selected))
    .map((e) => e.id);
  return {
    profile: selected,
    skills: fromCatalog,
    issues: [
      note(
        "packaging.profile-from-catalog",
        file,
        `${file} has no 'skills:' list; membership was taken from catalog.yaml's per-skill profiles field.`,
      ),
    ],
  };
}
