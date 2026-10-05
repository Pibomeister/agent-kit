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
 *
 * One root owns each claude-mem project. The owner keeps it while its
 * directory exists, and a second root is refused with a warning. An owner
 * whose directory is gone (ENOENT on the root itself, no other stat failure)
 * is released to the next root that registers. Roots contesting a project
 * with no owner, in one discovery pass or in a registry written before this
 * rule, are settled in favour of the one named after the project, then the
 * newest.
 *
 * Known limit: claude-mem names a project after its folder, so two unrelated
 * repositories with the same basename share one claude-mem project. Only one
 * of them can be registered; the other is refused with the same warning.
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

/** True only when the root itself is positively gone; any other stat failure decides nothing. */
function absent(root: string): boolean {
  try {
    statSync(root);
    return false;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "ENOENT";
  }
}

/** Ownership order among roots contesting one claude-mem project: one that still exists, then one named after the project, then the newest. */
function byClaim(a: RegistryEntry, b: RegistryEntry): number {
  return (
    Number(absent(a.root)) - Number(absent(b.root)) ||
    Number(basename(b.root) === b.mem_project) - Number(basename(a.root) === a.mem_project) ||
    b.last_seen - a.last_seen ||
    a.root.localeCompare(b.root)
  );
}

interface Held {
  held: Map<string, RegistryEntry>;
  warnings: string[];
}

/** Drop ineligible roots and reduce every claude-mem project that several roots share to one owner. */
function clean(input: Registry): Held {
  const held = new Map<string, RegistryEntry>();
  const warnings: string[] = [];
  for (const [folder, entry] of Object.entries(input)) {
    const reason = ineligible(entry.root);
    if (reason === null) held.set(folder, entry);
    else warnings.push(ineligibleWarning(entry.root, reason));
  }
  for (const project of new Set([...held.values()].map((entry) => entry.mem_project))) {
    const contenders = [...held]
      .filter(([, entry]) => entry.mem_project === project)
      .toSorted(([, a], [, b]) => byClaim(a, b));
    const owner = contenders[0];
    if (owner === undefined) continue;
    for (const [folder, entry] of contenders.slice(1)) {
      held.delete(folder);
      warnings.push(
        `registry warning: claude-mem project '${project}' has multiple roots; ${owner[1].root} owns it and ${entry.root} is not kept in the registry`,
      );
    }
  }
  return { held, warnings };
}

export interface RegistryHygiene {
  registry: Registry;
  warnings: string[];
}

/** The registry as the next write would leave it, with a warning for every root dropped. Writes nothing. */
export function registryHygiene(input: Registry): RegistryHygiene {
  const { held, warnings } = clean(input);
  return { registry: Object.fromEntries(held), warnings };
}

/**
 * Add or refresh one root. A root taking a claude-mem project that another root
 * holds is refused, with the warning returned, unless that owner's directory is
 * gone, in which case the owner is released and the handover is logged.
 */
function admit({ held, warnings }: Held, entry: RegistryEntry): string | null {
  const folder = projectFolderName(entry.root);
  const owner = [...held].find(([other, kept]) => other !== folder && kept.mem_project === entry.mem_project);
  if (owner !== undefined) {
    const [ownerFolder, { root }] = owner;
    if (!absent(root))
      return `registry warning: claude-mem project '${entry.mem_project}' is already registered at ${root}; refusing ${entry.root}`;
    held.delete(ownerFolder);
    warnings.push(
      `registry warning: ${root} no longer exists; claude-mem project '${entry.mem_project}' now belongs to ${entry.root}`,
    );
  }
  held.set(folder, entry);
  return null;
}

function save(config: LearnConfig, before: string, held: Map<string, RegistryEntry>): Registry {
  const registry: Registry = Object.fromEntries(held);
  if (!config.dryRun && JSON.stringify(registry) !== before) writeJson(registryPath(config), registry);
  return registry;
}

export interface Registration extends RegistryHygiene {
  /** Why the root was not registered, or null when it was. Also among `warnings`. */
  refusal: string | null;
}

/** Record a main repo root; its claude-mem project is the folder basename. */
export function registerRoot(config: LearnConfig, root: string, at = nowMs()): Registration {
  const current = readRegistry(config);
  const cleaned = clean(current);
  const resolved = resolve(root);
  const reason = ineligible(resolved);
  const refusal =
    reason === null
      ? admit(cleaned, { root: resolved, mem_project: basename(resolved), last_seen: at })
      : ineligibleWarning(resolved, reason);
  const { held, warnings } = cleaned;
  if (refusal !== null && !warnings.includes(refusal)) warnings.push(refusal);
  return { registry: save(config, JSON.stringify(current), held), warnings, refusal };
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
 * newest sighting of a folder wins, and a root contesting a claude-mem project
 * is settled by the ownership rules above, with a warning for each refusal.
 * A root `allow` refuses is never written.
 */
export function discoverProjects(
  config: LearnConfig,
  rows: readonly CwdRow[],
  warn: (message: string) => void = () => undefined,
  allow: (root: string) => boolean = () => true,
): Registry {
  const current = readRegistry(config);
  const cleaned = clean(current);
  const { held, warnings } = cleaned;
  const found: Registry = {};
  for (const row of rows) {
    if (SKIP_CWD.some((skip) => `${row.cwd}/`.includes(skip))) continue;
    if (ineligible(resolve(row.cwd)) !== null) continue;
    const root = rootOf(row.cwd);
    if (root === null || !allow(root)) continue;
    found[projectFolderName(root)] = { root, mem_project: row.project.split("/")[0]!, last_seen: row.last_seen };
  }
  for (const entry of Object.values(found).toSorted(byClaim)) {
    if ((held.get(projectFolderName(entry.root))?.last_seen ?? 0) >= entry.last_seen) continue;
    const refusal = admit(cleaned, entry);
    if (refusal !== null) warnings.push(refusal);
  }
  for (const warning of warnings) warn(warning);
  return save(config, JSON.stringify(current), held);
}

/** Discovery's look-back window, as the `sinceMs` for `ClaudeMemSource.toolUseCwds`. */
export function discoverySince(now = nowMs(), days = DISCOVERY_DAYS): number {
  return now - days * 86_400_000;
}
