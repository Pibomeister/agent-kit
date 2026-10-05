/**
 * `ak learn setup scope` — the repo scope the hooks and the scheduled tick
 * honour, kept in one runtime-owned file so re-running wire or schedule can
 * never widen it. `AK_LEARN_REPOS`, when present, overrides the file.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { type LearnConfig, loadConfig, parseRepos, scopeFile } from "../core/config.ts";
import type { LearnContext } from "../core/context.ts";

/** The effective scope and where it came from, as verify, doctor and this verb print it. */
export function scopeText(config: LearnConfig): string {
  if (config.repos === null) return "unscoped (every repository)";
  const roots = config.repos.length === 0 ? "nothing allowed" : config.repos.join(":");
  return `${roots} (${config.reposSource === "env" ? "AK_LEARN_REPOS" : "scope file"})`;
}

export function scope(ctx: LearnContext, options: { set?: string; clear?: boolean }): number {
  const path = scopeFile(ctx.config.runtimeDir);
  if (options.set !== undefined) {
    mkdirSync(ctx.config.runtimeDir, { recursive: true });
    writeFileSync(path, `${options.set.trim()}\n`);
    ctx.io.out(`${path}: written`);
    for (const entry of options.set.split(":").map((part) => part.trim())) {
      if (entry !== "" && parseRepos(entry).length === 0)
        ctx.io.out(`  ignored: ${entry} (not an absolute path that exists)`);
    }
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
