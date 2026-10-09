import { join } from "node:path";
import { parse as parseYaml } from "yaml";

import { readTextIfPresent } from "../util/fs.ts";
import { error, type Issue } from "../validation/types.ts";

export type HostId = "claude-code" | "codex" | "grok" | "kimi";

export const HOST_IDS: ReadonlyArray<HostId> = ["claude-code", "codex", "grok", "kimi"];

/**
 * Render the explicit human start a packaged skill recognizes on this host.
 *
 * The canonical command remains catalog.package.namespace + skill id. Source
 * validation and the invocation graph read that one spelling. Packaging owns
 * the host translation so canonical skills never need a list of host syntaxes
 * and a prose request still matches none of them (ADR-0011).
 *
 * Codex lists a plugin's skill as `<plugin>:<id>` and mentions it with a
 * leading `$`; the namespace already carries that `<plugin>:` stem after its
 * slash (adapters/codex/CONTRACT.md §3.1 records the probe).
 */
export function explicitStartForHost(host: HostId, namespace: string, skillId: string): string {
  if (host === "grok") return `/${skillId}`;
  if (host === "kimi") return `/skill:${skillId}`;
  return host === "codex" ? `$${namespace.slice(1)}${skillId}` : `${namespace}${skillId}`;
}

function escapeForPattern(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Every exact occurrence of one of `commands`, the one definition of where a
 * command ends. A longer id is not a match: `/ak:compound-refresh` is not the
 * command `/ak:compound` followed by text.
 */
export function explicitStartPattern(commands: ReadonlyArray<string>): RegExp {
  return new RegExp(`(?:${commands.map(escapeForPattern).join("|")})(?![a-z0-9]|-[a-z0-9])`, "g");
}

/**
 * Rewrite exact canonical U-skill command references in host-facing prose.
 *
 * M ids are absent from the input, so their automatic-invocation contract is
 * not converted into an explicit gate by packaging.
 */
export function rewriteExplicitStarts(
  text: string,
  host: HostId,
  namespace: string,
  userSkillIds: ReadonlyArray<string>,
): string {
  const native = new Map<string, string>();
  for (const skillId of userSkillIds) {
    const canonical = `${namespace}${skillId}`;
    const rendered = explicitStartForHost(host, namespace, skillId);
    if (canonical !== rendered) native.set(canonical, rendered);
  }
  if (native.size === 0) return text;
  return text.replace(explicitStartPattern([...native.keys()]), (found) => native.get(found) ?? found);
}

/**
 * How much of itself a skill is allowed to run on a given host.
 *
 * The vocabulary is `schemas/skill.schema.json`'s `packaging.hosts[].mode`
 * enum, and it lives here rather than beside the frontmatter generator because
 * it is a host-facing vocabulary like `RESTRICTIONS` below -- and because the
 * generator now reads it from the same module that defines what each host is.
 *
 * Deliberately not the same axis as `RESTRICTIONS`. A mode is what this package
 * exposes; a restriction is what the host enforces. They were compared to each
 * other once, through a `skill.yaml` key the schema forbids, and the comparison
 * never ran.
 */
export type SkillMode = "autonomous" | "guided" | "manual";

export const SKILL_MODES: ReadonlyArray<SkillMode> = ["autonomous", "guided", "manual"];

export function isSkillMode(value: unknown): value is SkillMode {
  return typeof value === "string" && (SKILL_MODES as ReadonlyArray<string>).includes(value);
}

/**
 * Restrictions a skill may require a host to actually enforce.
 *
 * `tool-allowlist-enforced` is deliberately separate from "the host accepts an
 * allowed-tools key". In Claude Code `allowed-tools` is a pre-approval list: it
 * removes permission prompts, it does not confine the agent. Claiming it as a
 * sandbox would weaken every autonomy contract that depends on confinement.
 */
export const RESTRICTIONS: ReadonlyArray<string> = [
  "no-model-invocation",
  "tool-allowlist-enforced",
  "filesystem-sandbox",
  "network-block",
  "process-exec-block",
];

/**
 * The generated frontmatter keys each host actually defines.
 *
 * Deliberately not derived from `enforces`, and the two must never be
 * conflated. `allowed-tools` is a key claude-code defines and enforces nothing
 * with -- it is pre-approval, per RESTRICTIONS above -- so a host's key set and
 * a host's guarantees are different questions with different answers.
 *
 * No host gets `disable-model-invocation`. claude-code honors the key, and
 * this package stopped emitting it (docs/decisions/0003-model-invocation.md):
 * every skill is loadable by the model, and a U skill's gate is its own
 * authority step, as it always was on codex.
 *
 * codex gets neither of the two claude-code keys. `adapters/codex/CONTRACT.md`
 * §3: the host's per-skill model-invocation suppression is "not emitted by
 * this package", and tool restriction is "Not emitted" because the host's
 * confinement is an OS-level sandbox the operator owns. §5 makes a key from one host's set
 * appearing in the other's bundle a failure in its own right.
 *
 * Kimi gets no host-specific keys: its native skill command is `/skill:<id>`,
 * and its U gate remains the first workflow step (ADR-0011).
 *
 * `argument-hint` is on both existing hosts' lists because neither contract takes it away from
 * codex: §3's table names exactly two differences, and §5's leaked-key test
 * names exactly the same two.
 */
export const HOST_FRONTMATTER_KEYS: Record<HostId, ReadonlyArray<string>> = {
  "claude-code": ["argument-hint", "allowed-tools"],
  codex: ["argument-hint"],
  grok: ["argument-hint", "allowed-tools"],
  kimi: [],
};

export interface HostCapabilities {
  id: HostId;
  enforces: Set<string>;
  notes: string[];
  issues: Issue[];
  /** True when the declaration came from adapters/<host>/, not from the built-in default. */
  declared: boolean;
}

const DEFAULTS: Record<HostId, { enforces: string[]; notes: string[] }> = {
  kimi: {
    enforces: [],
    notes: ["No restriction is claimed. U skills rely on their first-step authority check (ADR-0003, ADR-0011)."],
  },
  "claude-code": {
    enforces: [],
    notes: [
      "disable-model-invocation is honored by the host, but this package does not emit it (docs/decisions/0003-model-invocation.md), so no-model-invocation is NOT claimed.",
      "allowed-tools is a pre-approval mechanism, not a sandbox; tool-allowlist-enforced is NOT claimed.",
      "No filesystem, network or process confinement is claimed.",
    ],
  },
  codex: {
    enforces: [],
    notes: [
      "No restriction is claimed by default. adapters/codex/CONTRACT.md must declare what the host really enforces.",
    ],
  },
  grok: {
    enforces: [],
    notes: ["No restriction is claimed. allowed-tools grants and restricts nothing on this host."],
  },
};

function declarationFor(root: string, host: HostId): { value: unknown; file: string } | null {
  const yamlFile = `adapters/${host}/capabilities.yaml`;
  const yamlText = readTextIfPresent(join(root, yamlFile));
  if (yamlText !== null) {
    try {
      return { value: parseYaml(yamlText), file: yamlFile };
    } catch {
      return { value: null, file: yamlFile };
    }
  }

  const contractFile = `adapters/${host}/CONTRACT.md`;
  const contract = readTextIfPresent(join(root, contractFile));
  if (contract === null) return null;
  for (const match of contract.matchAll(/```ya?ml\n([\s\S]*?)```/g)) {
    const block = match[1];
    if (block === undefined || !/^\s*enforces\s*:/m.test(block)) continue;
    try {
      return { value: parseYaml(block), file: contractFile };
    } catch {
      return { value: null, file: contractFile };
    }
  }
  return null;
}

/**
 * What this host really enforces. Absent or unreadable declarations fall back to
 * the conservative built-in default rather than assuming enforcement.
 */
export function loadHostCapabilities(root: string, host: HostId): HostCapabilities {
  const fallback = DEFAULTS[host];
  const issues: Issue[] = [];
  const declaration = declarationFor(root, host);

  if (declaration === null) {
    return {
      id: host,
      enforces: new Set(fallback.enforces),
      notes: [...fallback.notes, "Source: built-in default; no adapter declaration found."],
      issues,
      declared: false,
    };
  }

  const record =
    declaration.value !== null && typeof declaration.value === "object" && !Array.isArray(declaration.value)
      ? (declaration.value as Record<string, unknown>)
      : {};
  const raw = Array.isArray(record["enforces"]) ? (record["enforces"] as unknown[]) : null;
  if (raw === null) {
    return {
      id: host,
      enforces: new Set(fallback.enforces),
      notes: [...fallback.notes, `Source: built-in default; ${declaration.file} declared no usable 'enforces' list.`],
      issues,
      declared: false,
    };
  }

  const enforces = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "string") continue;
    if (!RESTRICTIONS.includes(item)) {
      issues.push(
        error(
          "packaging.unknown-restriction",
          declaration.file,
          `'${item}' is not a known restriction. Known: ${RESTRICTIONS.join(", ")}.`,
        ),
      );
      continue;
    }
    enforces.add(item);
  }

  const notes = Array.isArray(record["notes"])
    ? (record["notes"] as unknown[]).filter((n): n is string => typeof n === "string")
    : [];

  return {
    id: host,
    enforces,
    notes: [...notes, ...fallback.notes.filter((n) => n.includes("pre-approval")), `Source: ${declaration.file}.`],
    issues,
    declared: true,
  };
}
