/**
 * The explicit start a host's bundle recognizes, for the eval harness. Not a test file.
 *
 * Prompt sets and graders are written once, in the canonical `/ak:<id>` form. A session types what
 * the installed bundle gates on, and a reply is read back into the canonical form before grading,
 * both through the packager's `explicitStartForHost` (ADR-0011).
 */
import { loadCatalog } from "../../../src/catalog/load.ts";
import { PACKAGE_ROOT } from "../../../src/learn/core/roles.ts";
import {
  explicitStartForHost,
  explicitStartPattern,
  type HostId,
  rewriteExplicitStarts,
} from "../../../src/packaging/hosts.ts";
import { BUNDLE_FOR } from "./subjects/index.ts";
import type { HostKind } from "./subjects/types.ts";

export interface StartVocabulary {
  /** Canonical text as the host is sent it: each U command in the bundle's form. */
  typed(text: string): string;
  /**
   * Host text as the canonical graders read it. The two spellings trade places, so a reply that
   * names the canonical command on a host whose bundle gates on another form does not match.
   */
  canonical(text: string): string;
}

export function startVocabulary(host: HostId, namespace: string, userSkillIds: ReadonlyArray<string>): StartVocabulary {
  const other = new Map<string, string>();
  for (const id of userSkillIds) {
    const canonical = `${namespace}${id}`;
    const native = explicitStartForHost(host, namespace, id);
    if (canonical === native) continue;
    other.set(canonical, native);
    other.set(native, canonical);
  }
  const command = explicitStartPattern([...other.keys()]);
  return {
    typed: (text) => rewriteExplicitStarts(text, host, namespace, userSkillIds),
    canonical: (text) => (other.size === 0 ? text : text.replace(command, (found) => other.get(found) ?? found)),
  };
}

let catalogStarts: { namespace: string; userSkillIds: string[] } | undefined;

/** The vocabulary of the bundle `host` installs, from this package's catalog. */
export function startsFor(host: HostKind): StartVocabulary {
  if (catalogStarts === undefined) {
    const { catalog } = loadCatalog(PACKAGE_ROOT);
    if (catalog === null) throw new Error(`no catalog at ${PACKAGE_ROOT}`);
    catalogStarts = {
      namespace: catalog.package.namespace,
      userSkillIds: catalog
        .bySection("skills")
        .filter((entry) => entry.invocation === "U")
        .map((entry) => entry.id),
    };
  }
  return startVocabulary(BUNDLE_FOR[host], catalogStarts.namespace, catalogStarts.userSkillIds);
}
