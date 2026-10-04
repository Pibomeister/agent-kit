import { stringify as stringifyYaml } from "yaml";

import type { CatalogEntry } from "../catalog/load.ts";
import type { Frontmatter } from "../util/frontmatter.ts";
import { HOST_FRONTMATTER_KEYS, type HostId, type SkillMode } from "./hosts.ts";
import { isUserInvoked, type SkillManifest } from "./manifest.ts";

export interface GeneratedFrontmatter {
  keys: Record<string, unknown>;
  text: string;
}

/**
 * Host frontmatter is generated, never copied: the canonical file carries only
 * Agent Skills spec keys. `disable-model-invocation: true` would be emitted for
 * every U skill on a host that defines it; no host does any more
 * (docs/decisions/0003-model-invocation.md), and the guard stays so a host that
 * adds the key back gets it for exactly the U skills.
 *
 * `host` is a parameter because it was not one, and a function that generates
 * host frontmatter without knowing the host generated the same frontmatter for
 * both: the codex bundle shipped `disable-model-invocation` and `allowed-tools`
 * verbatim, two keys `adapters/codex/CONTRACT.md` §3 records as not emitted
 * on that host.
 *
 * Removing them takes no protection away, which is the part worth stating
 * plainly. The key was never honored there, so what it changed was the bundle's
 * claim rather than the host's behavior -- and a U skill on codex is exactly as
 * startable now as it was before, with the difference that the bundle has
 * stopped saying otherwise. What actually restrains it on that host is §3.1's
 * description clause and the skill's own authority check.
 */
export function generateHostFrontmatter(
  entry: CatalogEntry,
  canonical: Frontmatter,
  manifest: SkillManifest,
  mode: SkillMode,
  unenforceable: ReadonlyArray<string>,
  host: HostId,
): GeneratedFrontmatter {
  // Each host-specific key is guarded at its own emit site rather than filtered
  // out afterwards. A key added later without a guard is visible here, in the
  // three lines that emit them, instead of being silently dropped by a filter
  // for every host that did not list it.
  const defines = (key: string) => HOST_FRONTMATTER_KEYS[host].includes(key);

  const keys: Record<string, unknown> = {};
  keys["name"] = entry.id;
  if (typeof canonical.data["description"] === "string") keys["description"] = canonical.data["description"];
  if (canonical.data["license"] !== undefined) keys["license"] = canonical.data["license"];

  if (defines("disable-model-invocation") && isUserInvoked(entry, manifest)) {
    keys["disable-model-invocation"] = true;
  }
  if (defines("argument-hint") && manifest.argumentHint !== undefined) keys["argument-hint"] = manifest.argumentHint;
  if (defines("allowed-tools") && manifest.allowedTools !== undefined) keys["allowed-tools"] = manifest.allowedTools;

  const inherited =
    canonical.data["metadata"] !== null &&
    typeof canonical.data["metadata"] === "object" &&
    !Array.isArray(canonical.data["metadata"])
      ? (canonical.data["metadata"] as Record<string, unknown>)
      : {};
  const ak: Record<string, unknown> = { mode };
  if (unenforceable.length > 0) ak["autonomy_unenforceable"] = [...unenforceable];
  keys["metadata"] = { ...inherited, ak };

  const text = `---\n${stringifyYaml(keys, { lineWidth: 0 })}---\n`;
  return { keys, text };
}
