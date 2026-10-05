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
import { basename, resolve } from "node:path";
import type { LearnConfig } from "../core/config.ts";
import { projectFolderName, registryPath, rootOf } from "../core/paths.ts";
import { nowMs, readJson, writeJson } from "../core/store.ts";
import { unknownSelector } from "../../util/suggest.ts";
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

/**
 * What a `--repo` that resolves to no repository is told: the registered roots
 * nearest the path it named, so a typo is not read as a project with no
 * history.
 */
export function unknownRepo(config: LearnConfig, path: string): string {
  return unknownSelector(
    "repository",
    resolve(path),
    Object.values(readRegistry(config)).map((entry) => entry.root),
  );
}

/** Record a main repo root; its claude-mem project is the folder basename. */
export function registerRoot(config: LearnConfig, root: string, at = nowMs()): Registry {
  const registry = readRegistry(config);
  const resolved = resolve(root);
  registry[projectFolderName(resolved)] = { root: resolved, mem_project: basename(resolved), last_seen: at };
  if (!config.dryRun) writeJson(registryPath(config), registry);
  return registry;
}

/**
 * Merge claude-mem's latest working directory per project into the registry.
 * A worktree-suffixed project name (`app/branch`) registers under `app`, and
 * the newest sighting of a folder wins.
 */
export function discoverProjects(config: LearnConfig, rows: readonly CwdRow[]): Registry {
  const registry = readRegistry(config);
  const found: Registry = {};
  for (const row of rows) {
    if (SKIP_CWD.some((skip) => `${row.cwd}/`.includes(skip))) continue;
    const root = rootOf(row.cwd);
    if (root === null) continue;
    found[projectFolderName(root)] = { root, mem_project: row.project.split("/")[0]!, last_seen: row.last_seen };
  }
  for (const [folder, entry] of Object.entries(found)) {
    if ((registry[folder]?.last_seen ?? 0) < entry.last_seen) registry[folder] = entry;
  }
  if (!config.dryRun && Object.keys(found).length > 0) writeJson(registryPath(config), registry);
  return registry;
}

/** Discovery's look-back window, as the `sinceMs` for `ClaudeMemSource.toolUseCwds`. */
export function discoverySince(now = nowMs(), days = DISCOVERY_DAYS): number {
  return now - days * 86_400_000;
}
