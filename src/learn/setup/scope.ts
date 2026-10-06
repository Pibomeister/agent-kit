/**
 * `ak learn setup scope` — the repo scope the hooks and the scheduled tick
 * honour, kept in one runtime-owned file so re-running wire or schedule can
 * never widen it. `AK_LEARN_REPOS`, when present, overrides the file.
 */
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { identity, type LearnConfig, loadConfig, parseRepos, sameScope, scopeFile } from "../core/config.ts";
import type { LearnContext } from "../core/context.ts";
import { mainRepoRoot } from "../core/paths.ts";
import { run } from "../core/proc.ts";

/** The effective scope and where it came from, as verify, doctor and this verb print it. */
export function scopeText(config: LearnConfig): string {
  if (config.repos === null) return "unscoped (every repository)";
  const roots = config.repos.length === 0 ? "nothing allowed" : config.repos.join(":");
  return `${roots} (${config.reposSource === "env" ? "AK_LEARN_REPOS" : "scope file"})`;
}

/**
 * The scope a process started without `AK_LEARN_REPOS` sees, which is the scheduler unit's: the
 * unit never carries the variable, so only the scope file reaches the tick.
 */
export function fileScope(ctx: LearnContext): LearnConfig {
  const { AK_LEARN_REPOS: _scope, ...env } = ctx.env;
  return loadConfig(env);
}

/** Whether the tick would run with a different scope than this shell's, because the scope lives only in the variable. */
export function unitScopeDiffers(ctx: LearnContext): boolean {
  return ctx.config.reposSource === "env" && !sameScope(fileScope(ctx).repos, ctx.config.repos);
}

/** The top of the working tree `dir` sits in, or null outside one. */
function workTreeTop(dir: string): string | null {
  const result = run(["git", "rev-parse", "--show-toplevel"], { cwd: dir, timeoutMs: 10_000 });
  return result.code === 0 && result.stdout.trim() !== "" ? result.stdout.trim() : null;
}

export function scope(ctx: LearnContext, options: { set?: string; clear?: boolean }): number {
  const path = scopeFile(ctx.config.runtimeDir);
  if (options.set !== undefined) {
    // The hooks compare against a session's main repo root, so a linked worktree is stored as its main
    // root. Only a working-tree top level is accepted: git resolves any directory below one, and a plain
    // folder under a repository-tracked home would otherwise widen the scope to that whole home.
    const entries = options.set.split(":").map((part) => part.trim());
    const roots = entries.flatMap((entry) => {
      const top = parseRepos(entry).length === 0 ? null : workTreeTop(entry);
      const root = top !== null && identity(top) === identity(entry) ? mainRepoRoot(entry) : null;
      if (root === null) {
        if (entry !== "") ctx.io.out(`  ignored: ${entry} (not a repository root or a linked worktree)`);
        return [];
      }
      if (identity(root) !== identity(entry)) ctx.io.out(`  ${entry}: stored as its main repository root ${root}`);
      return [root];
    });
    mkdirSync(ctx.config.runtimeDir, { recursive: true });
    // Hooks and the tick read this file at any moment, so it is replaced whole, never rewritten in place.
    writeFileSync(`${path}.tmp`, `${roots.join(":")}\n`);
    renameSync(`${path}.tmp`, path);
    ctx.io.out(`${path}: written`);
  } else if (options.clear === true) {
    const existed = existsSync(path);
    rmSync(path, { recursive: true, force: true });
    ctx.io.out(existed ? `${path}: removed` : `${path}: no scope file`);
  }
  const config = loadConfig(ctx.env);
  ctx.io.out(`scope: ${scopeText(config)}`);
  if (config.reposSource === "env" && existsSync(path)) ctx.io.out(`  (AK_LEARN_REPOS overrides ${path})`);
  return 0;
}
