/**
 * Where learning state lives, and how a working directory maps to a project.
 *
 * Ledgers are written under `<configDir>/projects/<folder>/agent-kit/<loop>/`
 * and never inside a repository: no candidate directory, no `.git/info/exclude`
 * edit, nothing a `git status` in the project would show.
 */
import { readFileSync, statSync } from "node:fs";
import { delimiter, dirname, join, relative, resolve, sep } from "node:path";
import type { LearnConfig } from "./config.ts";
import { run } from "./proc.ts";

export type Loop = "review" | "memory" | "skills";

/** Claude Code's convention: every non-alphanumeric except `-` becomes `-`. `/Users/bob/my_app` -> `-Users-bob-my-app`. */
export function projectFolderName(path: string): string {
  return resolve(path).replace(/[^A-Za-z0-9-]/g, "-");
}

/**
 * claude-reflect's own convention keeps underscores and dots: `/Users/bob/my_app` -> `-Users-bob-my_app`.
 * Both are needed because each tool reads its own directory under `projects/`.
 */
export function reflectFolderName(path: string): string {
  return `-${resolve(path).replace(/[\\/]/g, "-").replace(/^-+/, "")}`;
}

/**
 * The main worktree root, so every linked worktree shares one ledger. Spawns git,
 * so it is for foreground use only; a scheduled tick uses `rootOf` instead.
 */
export function mainRepoRoot(cwd: string): string | null {
  const result = run(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, timeoutMs: 10_000 });
  if (result.code !== 0) return null;
  const common = result.stdout.trim();
  if (common === "") return null;
  return common.endsWith("/.git") || common.endsWith("\\.git") ? dirname(common) : common;
}

/** The top of the worktree holding `cwd`, linked or main. Spawns git, so foreground only, like `mainRepoRoot`. */
export function worktreeRoot(cwd: string): string | null {
  const result = run(["git", "rev-parse", "--show-toplevel"], { cwd, timeoutMs: 10_000 });
  const top = result.stdout.trim();
  return result.code !== 0 || top === "" ? null : resolve(top);
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** `cwd` and each directory above it, as far as git would search: a directory listed in GIT_CEILING_DIRECTORIES is not searched from below. */
function searched(cwd: string): string[] {
  const ceilings = new Set(
    (process.env.GIT_CEILING_DIRECTORIES ?? "")
      .split(delimiter)
      .filter((entry) => entry !== "")
      .map((entry) => resolve(entry)),
  );
  const dirs = [resolve(cwd)];
  for (;;) {
    const dir = dirs[dirs.length - 1] ?? "";
    const parent = dirname(dir);
    if (parent === dir || ceilings.has(parent)) return dirs;
    dirs.push(parent);
  }
}

/**
 * Main repo root found by walking up for a `.git` directory, with stat only.
 *
 * Never opens a file and never spawns git. Under a macOS scheduler, opening a
 * file inside a protected folder blocks uninterruptibly on the privacy prompt
 * and ignores every timeout, so discovery may only stat. A linked worktree
 * (whose `.git` is a file) returns null; its main root registers from its own
 * foreground sessions instead.
 *
 * Stops where git stops, so this walk and `mainRepoRoot` agree on what is outside.
 */
export function rootOf(cwd: string): string | null {
  return searched(cwd).find((dir) => isDirectory(join(dir, ".git"))) ?? null;
}

/**
 * Whether `path` is one of the macOS privacy-protected folders under `home` (Documents, Desktop,
 * Downloads) or sits inside one. Decided from the two paths as text, so asking can never raise the
 * prompt the answer exists to avoid; names compare without case, as the default macOS volume does.
 * False on every other platform.
 */
export function inProtectedFolder(path: string, home: string, platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== "darwin") return false;
  const [folder] = relative(resolve(home).toLowerCase(), resolve(path).toLowerCase()).split(sep);
  return folder === "documents" || folder === "desktop" || folder === "downloads";
}

/**
 * The linked worktree holding `cwd` and the main root it belongs to, without git: the first `.git`
 * above `cwd` is a file whose `gitdir: <root>/.git/worktrees/<name>` line names the root. That
 * pointer is the one file read, and nothing else in the worktree is opened. Null in a main
 * worktree, outside a repository, and once the worktree is removed.
 */
export function linkedWorktree(cwd: string): { worktree: string; root: string } | null {
  for (const worktree of searched(cwd)) {
    const pointer = join(worktree, ".git");
    try {
      const stat = statSync(pointer, { throwIfNoEntry: false });
      if (stat === undefined) continue;
      if (!stat.isFile()) return null;
      const gitdir = /^gitdir: (.+)$/m.exec(readFileSync(pointer, "utf8"))?.[1];
      if (gitdir === undefined) return null;
      const root = /^(.+)[\\/]\.git[\\/]worktrees[\\/][^\\/]+$/.exec(resolve(worktree, gitdir.trim()))?.[1];
      return root === undefined ? null : { worktree, root };
    } catch {
      return null;
    }
  }
  return null;
}

/** `<configDir>/projects/<folder>/agent-kit`. */
export function projectLedgerRoot(config: LearnConfig, repoRoot: string): string {
  return join(config.configDir, "projects", projectFolderName(repoRoot), "agent-kit");
}

/** One git repository per loop, so each loop commits and reverts on its own history. */
export function loopDir(config: LearnConfig, repoRoot: string, loop: Loop): string {
  return join(projectLedgerRoot(config, repoRoot), loop);
}

/** The runtime-wide project registry: folder -> { root, mem_project, last_seen }. */
export function registryPath(config: LearnConfig): string {
  return join(config.runtimeDir, "projects.json");
}

/** Linked worktree path -> registered root, written by foreground sessions for the scheduled tick to read. */
export function worktreesPath(config: LearnConfig): string {
  return join(config.runtimeDir, "worktrees.json");
}

export function tickLogPath(config: LearnConfig): string {
  return join(config.runtimeDir, "tick.log");
}
