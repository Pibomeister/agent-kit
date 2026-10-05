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
import { appendFileSync, mkdirSync, statSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { LearnConfig } from "../core/config.ts";
import { projectFolderName, registryPath, rootOf, tickLogPath } from "../core/paths.ts";
import { nowIso, nowMs, readJson, writeJson } from "../core/store.ts";
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

/** Why a root may never hold a ledger, or null. Stat only, and a root that cannot be read is not judged. */
function ineligible(root: string): string | null {
  if (`${root}${sep}`.includes(`${sep}.no-mistakes${sep}repos${sep}`)) return "managed by no-mistakes";
  try {
    const bare =
      statSync(join(root, ".git"), { throwIfNoEntry: false }) === undefined &&
      statSync(join(root, "HEAD")).isFile() &&
      statSync(join(root, "objects")).isDirectory();
    return bare ? "a bare repository" : null;
  } catch {
    return null;
  }
}

function ineligibleWarning(root: string, reason: string): string {
  return `registry warning: ${root} is ${reason} and cannot be registered`;
}

export interface RegistryHygiene {
  registry: Registry;
  warnings: string[];
}

/** Drop ineligible roots and flag every claude-mem project that more than one root shares. */
export function registryHygiene(input: Registry): RegistryHygiene {
  const registry: Registry = {};
  const warnings: string[] = [];
  const roots = new Map<string, string[]>();
  for (const [folder, entry] of Object.entries(input)) {
    const reason = ineligible(entry.root);
    if (reason !== null) {
      warnings.push(ineligibleWarning(entry.root, reason));
      continue;
    }
    registry[folder] = entry;
    roots.set(entry.mem_project, [...(roots.get(entry.mem_project) ?? []), entry.root]);
  }
  for (const [project, shared] of roots) {
    if (shared.length > 1)
      warnings.push(`registry warning: claude-mem project '${project}' has multiple roots: ${shared.join(", ")}`);
  }
  return { registry, warnings };
}

/** Add or refresh one root. A root new to the registry is refused, with the warning returned, when its claude-mem project already has one. */
function admit(registry: Registry, entry: RegistryEntry): string | null {
  const folder = projectFolderName(entry.root);
  if (registry[folder] === undefined) {
    const established = Object.values(registry).find((other) => other.mem_project === entry.mem_project);
    if (established !== undefined)
      return `registry warning: claude-mem project '${entry.mem_project}' is already registered at ${established.root}; refusing ${entry.root}`;
  }
  registry[folder] = entry;
  return null;
}

export interface Registration extends RegistryHygiene {
  /** Why the root was not registered, or null when it was. Also among `warnings`. */
  refusal: string | null;
}

/** Record a main repo root; its claude-mem project is the folder basename. */
export function registerRoot(config: LearnConfig, root: string, at = nowMs()): Registration {
  const current = readRegistry(config);
  const before = JSON.stringify(current);
  const { registry, warnings } = registryHygiene(current);
  const resolved = resolve(root);
  const reason = ineligible(resolved);
  const refusal =
    reason === null
      ? admit(registry, { root: resolved, mem_project: basename(resolved), last_seen: at })
      : ineligibleWarning(resolved, reason);
  if (refusal !== null && !warnings.includes(refusal)) warnings.push(refusal);
  if (!config.dryRun && JSON.stringify(registry) !== before) writeJson(registryPath(config), registry);
  return { registry, warnings, refusal };
}

/** Append registry warnings raised outside a tick to the tick log, leaving the caller's own output alone. */
export function logRegistryWarnings(config: LearnConfig, warnings: readonly string[]): void {
  if (config.dryRun || warnings.length === 0) return;
  const path = tickLogPath(config);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, warnings.map((warning) => `${nowIso()} ${warning}\n`).join(""));
}

/**
 * Merge claude-mem's latest working directory per project into the registry.
 * A worktree-suffixed project name (`app/branch`) registers under `app`, the
 * newest sighting of a folder wins, and a second root for a claude-mem project
 * that already has one is refused with a warning.
 */
export function discoverProjects(
  config: LearnConfig,
  rows: readonly CwdRow[],
  warn: (message: string) => void = () => undefined,
): Registry {
  const current = readRegistry(config);
  const before = JSON.stringify(current);
  const { registry, warnings } = registryHygiene(current);
  const found: Registry = {};
  for (const row of rows) {
    if (SKIP_CWD.some((skip) => `${row.cwd}/`.includes(skip))) continue;
    const root = rootOf(row.cwd);
    if (root === null || ineligible(root) !== null) continue;
    found[projectFolderName(root)] = { root, mem_project: row.project.split("/")[0]!, last_seen: row.last_seen };
  }
  for (const [folder, entry] of Object.entries(found)) {
    if ((registry[folder]?.last_seen ?? 0) >= entry.last_seen) continue;
    const refusal = admit(registry, entry);
    if (refusal !== null) warnings.push(refusal);
  }
  for (const warning of warnings) warn(warning);
  if (!config.dryRun && JSON.stringify(registry) !== before) writeJson(registryPath(config), registry);
  return registry;
}

/** Discovery's look-back window, as the `sinceMs` for `ClaudeMemSource.toolUseCwds`. */
export function discoverySince(now = nowMs(), days = DISCOVERY_DAYS): number {
  return now - days * 86_400_000;
}
