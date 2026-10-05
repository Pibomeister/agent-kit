/**
 * The project registry, `<runtimeDir>/projects.json`: ledger folder -> the
 * main repo root, its claude-mem project name and when it was last seen.
 *
 * Written three ways: a session start registers its own repo (the only path
 * that covers a linked worktree, whose `.git` is a file), the tick discovers
 * repos from claude-mem's tool-use working directories, and `ak learn memory
 * run` registers the repo it was pointed at. Discovery resolves a root with
 * `rootOf`, which only stats: a scheduled process may not open a file inside a
 * repository or spawn git there.
 */
import { statSync } from "node:fs";
import { basename, resolve, sep } from "node:path";
import type { LearnConfig } from "../core/config.ts";
import { projectFolderName, registryPath, rootOf } from "../core/paths.ts";
import { nowMs, readJson, writeJson } from "../core/store.ts";
import type { CwdRow } from "../sources/claude-mem.ts";

export interface RegistryEntry {
  root: string;
  mem_project: string;
  last_seen: number;
}

export type Registry = Record<string, RegistryEntry>;

/** Working directories never worth a ledger: plugin caches and scratch space. */
const SKIP_CWD = ["/plugins/cache/", "/tmp/", "/private/tmp/"];

export const DISCOVERY_DAYS = 14;

export function readRegistry(config: LearnConfig): Registry {
  return readJson<Registry>(registryPath(config), {});
}

function registrableRoot(root: string): boolean {
  const resolved = resolve(root);
  if (`${resolved}${sep}`.includes(`${sep}.no-mistakes${sep}repos${sep}`)) return false;
  try {
    return statSync(resolve(resolved, ".git")).isDirectory();
  } catch {
    return false;
  }
}

export interface RegistryHygiene {
  registry: Registry;
  warnings: string[];
}

/** Remove ineligible roots and keep only the newest root for each claude-mem project. */
export function registryHygiene(input: Registry): RegistryHygiene {
  const registry: Registry = {};
  const warnings: string[] = [];
  const entries = Object.values(input).toSorted((a, b) => b.last_seen - a.last_seen || a.root.localeCompare(b.root));
  const byProject = new Map<string, RegistryEntry>();
  for (const entry of entries) {
    if (!registrableRoot(entry.root)) {
      warnings.push(`registry warning: unregistering ${entry.root}; root is bare, missing, or managed by no-mistakes`);
      continue;
    }
    const kept = byProject.get(entry.mem_project);
    if (kept !== undefined) {
      warnings.push(
        `registry warning: claude-mem project '${entry.mem_project}' has multiple roots; keeping ${kept.root}, unregistering ${entry.root}`,
      );
      continue;
    }
    byProject.set(entry.mem_project, entry);
    registry[projectFolderName(entry.root)] = entry;
  }
  return { registry, warnings };
}

/** Record a main repo root; its claude-mem project is the folder basename. */
export function registerRoot(config: LearnConfig, root: string, at = nowMs()): Registry {
  const current = readRegistry(config);
  const before = JSON.stringify(current);
  const resolved = resolve(root);
  if (registrableRoot(resolved))
    current[projectFolderName(resolved)] = { root: resolved, mem_project: basename(resolved), last_seen: at };
  const clean = registryHygiene(current);
  if (!config.dryRun && JSON.stringify(clean.registry) !== before) writeJson(registryPath(config), clean.registry);
  return clean.registry;
}

/**
 * Merge claude-mem's latest working directory per project into the registry.
 * A worktree-suffixed project name (`app/branch`) registers under `app`, and
 * the newest sighting of a folder wins.
 */
export function discoverProjects(
  config: LearnConfig,
  rows: readonly CwdRow[],
  warn: (message: string) => void = () => undefined,
): Registry {
  const registry = readRegistry(config);
  const before = JSON.stringify(registry);
  const found: Registry = {};
  for (const row of rows) {
    if (SKIP_CWD.some((skip) => `${row.cwd}/`.includes(skip))) continue;
    const root = rootOf(row.cwd);
    if (root === null) continue;
    if (registrableRoot(root))
      found[projectFolderName(root)] = { root, mem_project: row.project.split("/")[0]!, last_seen: row.last_seen };
  }
  for (const [folder, entry] of Object.entries(found)) {
    if ((registry[folder]?.last_seen ?? 0) < entry.last_seen) registry[folder] = entry;
  }
  const clean = registryHygiene(registry);
  for (const warning of clean.warnings) warn(warning);
  if (!config.dryRun && JSON.stringify(clean.registry) !== before) writeJson(registryPath(config), clean.registry);
  return clean.registry;
}

/** Discovery's look-back window, as the `sinceMs` for `ClaudeMemSource.toolUseCwds`. */
export function discoverySince(now = nowMs(), days = DISCOVERY_DAYS): number {
  return now - days * 86_400_000;
}
