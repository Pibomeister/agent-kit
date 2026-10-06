import { join } from "node:path";
import { parse as parseYaml } from "yaml";

import { readTextIfPresent } from "../util/fs.ts";
import { isSkillMode, type SkillMode } from "./hosts.ts";

/**
 * What a skill declares about one adapter, from `packaging.hosts[]`.
 *
 * This is the only place a skill.yaml may say it. The packager used to read an
 * `autonomy:` block instead -- `modes` and `requires_enforced` -- which
 * `schemas/skill.schema.json` forbids outright: it sets
 * `additionalProperties: false` and lists no `autonomy` key, so a skill
 * declaring one fails `ak validate` with `schemas.document-invalid`. No skill
 * in the tree ever declared it and none could, so `wantsAutonomous` was false
 * for every skill on every host and every bundle shipped `mode: manual`
 * whatever its author wrote here.
 *
 * `unsupported` is prose, not a vocabulary. `adapters/claude-code/CONTRACT.md`
 * §3 calls it "the `unsupported` semantics this host cannot enforce" and
 * `adapters/codex/CONTRACT.md` §3.1 has each U skill name its unsuppressed
 * model invocation in it. It is deliberately not checked against
 * `RESTRICTIONS`: that set is what a host *enforces*, `requires[]` speaks a
 * third vocabulary again (`common#/$defs/capability`), and conflating any two
 * of them is what produced a comparison between a key that cannot exist and a
 * set it was never drawn from.
 */
export interface HostPackaging {
  adapter: string;
  /** Absent when the row states none, or states one outside the schema's enum. */
  mode?: SkillMode;
  unsupported: string[];
}

export interface SkillManifest {
  id?: string;
  invocation?: "U" | "M";
  argumentHint?: string;
  allowedTools?: string[];
  /**
   * `requires[]`: the host capabilities this skill asks for.
   *
   * `schemas/common.schema.json#/$defs/capability` is the vocabulary, and
   * `adapters/claude-code/CONTRACT.md` §3 states what each host does with each
   * value. Together those two are the only pair in this package that can
   * compute a ceiling on a skill's mode, which is why this field is read at
   * all: the packager had `unsupported` prose and a restriction set drawn from
   * a different enum, and neither of them speaks this vocabulary.
   *
   * Read without validating against the enum. `ak validate` fails a skill.yaml
   * whose `requires[]` leaves it, and a second copy of the enum here would be
   * one more thing to keep in step; a value outside it has no row in §3's table
   * and is capped as unstated, which is the same treatment and says so.
   */
  requires: string[];
  /** `packaging.hosts[]`, keyed by adapter. */
  hosts: Record<string, HostPackaging>;
  /**
   * Adapters declared by more than one row.
   *
   * Carried rather than resolved here. The schema puts no uniqueness constraint
   * on `hosts[]`, so `ak validate` passes a file naming one adapter twice, and
   * a loader that silently kept the first or the last would let whichever row
   * it happened to keep decide the mode with nothing saying so. The packager
   * reports it; this only records that there was something to report.
   */
  duplicateHosts: string[];
  /**
   * Skills and phase operations this skill declares it may start, from every
   * key that declares one -- `model_operations` included, so the invocation
   * graph sees each edge whatever authority it runs under.
   */
  calls: string[];
  /**
   * The entries of `calls` declared under `calls`, `child_operations` or
   * `invokes`, by source key. An id listed there and under `model_operations`
   * appears in both this and `modelOperations`, so each edge is judged by the
   * key that declared it.
   */
  delegatedCalls: string[];
  /**
   * The entries of `calls` declared under `model_operations`: model-authority
   * phase operations, which run on no grant and so are judged against their
   * `callable_by` rather than against the delegated-grant rule.
   */
  modelOperations: string[];
  raw: Record<string, unknown>;
  parseError?: string;
}

/**
 * Whether only a human may start this skill.
 *
 * One predicate for the whole packager, because two of them disagreed. Most
 * skills state `invocation` in catalog.yaml and not in skill.yaml -- twenty of
 * them in this tree -- so a reader of skill.yaml alone sees `undefined` for a
 * skill the catalog calls U, while `generateHostFrontmatter`, which reads both,
 * would write `disable-model-invocation: true` for exactly those skills on a host that defined it. A second
 * reader of skill.yaml alone would have produced a bundle saying a skill is U
 * in its frontmatter and packaging it as though it were not.
 */
export function isUserInvoked(entry: { invocation?: string }, manifest: SkillManifest): boolean {
  return entry.invocation === "U" || manifest.invocation === "U";
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function pick<V, T>(raw: Record<string, V>, parse: (value: V | undefined) => T, ...keys: string[]): T {
  for (const key of keys) if (raw[key] !== undefined) return parse(raw[key]);
  return parse(undefined);
}

export const EMPTY_MANIFEST: SkillManifest = {
  requires: [],
  hosts: {},
  duplicateHosts: [],
  calls: [],
  delegatedCalls: [],
  modelOperations: [],
  raw: {},
};

/** `packaging.hosts[]` as `adapter -> row`, plus the adapters declared twice. */
function hostRows(packaging: Record<string, unknown>): {
  hosts: Record<string, HostPackaging>;
  duplicateHosts: string[];
} {
  const hosts: Record<string, HostPackaging> = {};
  const duplicateHosts: string[] = [];
  const rows = Array.isArray(packaging["hosts"]) ? (packaging["hosts"] as unknown[]) : [];
  for (const item of rows) {
    const row = record(item);
    const adapter = row["adapter"];
    // A row naming no adapter says nothing about any host. Dropped rather than
    // keyed under "undefined", which is a host nothing is ever packaged for and
    // would sit in the map looking like a declaration.
    if (typeof adapter !== "string" || adapter === "") continue;
    if (hosts[adapter] !== undefined) {
      if (!duplicateHosts.includes(adapter)) duplicateHosts.push(adapter);
      continue;
    }
    const entry: HostPackaging = { adapter, unsupported: strings(row["unsupported"]) };
    // Only a value the schema's enum allows becomes a mode. Anything else is
    // left absent, and the packager's own default applies -- which is `manual`,
    // the conservative end, so a typo degrades rather than escalates.
    if (isSkillMode(row["mode"])) entry.mode = row["mode"];
    hosts[adapter] = entry;
  }
  return { hosts, duplicateHosts };
}

/** Read skills/<id>/skill.yaml, accepting both snake_case and kebab-case keys. */
export function loadSkillManifest(root: string, skillId: string): SkillManifest {
  const text = readTextIfPresent(join(root, "skills", skillId, "skill.yaml"));
  if (text === null) return { ...EMPTY_MANIFEST };

  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch (cause) {
    return { ...EMPTY_MANIFEST, parseError: cause instanceof Error ? cause.message : String(cause) };
  }

  const raw = record(parsed);
  const modelOperations = pick(raw, strings, "model_operations", "model-operations");
  const delegatedCalls = [
    ...pick(raw, strings, "calls"),
    ...pick(raw, strings, "child_operations", "child-operations"),
    ...pick(raw, strings, "invokes"),
  ];
  const manifest: SkillManifest = {
    ...hostRows(pick(raw, record, "packaging")),
    requires: pick(raw, strings, "requires"),
    calls: [...delegatedCalls, ...modelOperations],
    delegatedCalls,
    modelOperations,
    raw,
  };

  if (typeof raw["id"] === "string") manifest.id = raw["id"];
  if (raw["invocation"] === "U" || raw["invocation"] === "M") manifest.invocation = raw["invocation"];
  const hint = pick(raw, (value) => (typeof value === "string" ? value : undefined), "argument_hint", "argument-hint");
  if (hint !== undefined) manifest.argumentHint = hint;
  const tools = pick(raw, strings, "allowed_tools", "allowed-tools");
  if (tools.length > 0) manifest.allowedTools = tools;

  return manifest;
}
