/**
 * `ak learn setup uninstall` — remove this runtime's hook entries, scheduler
 * unit and claude-mem budget. Foreign hooks are untouched, and the ledgers are
 * kept: they are the user's data, removed only with `--purge`.
 */
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { LearnContext } from "../core/context.ts";
import { readJson } from "../core/store.ts";
import { LABEL, schedulerKind, unitPaths } from "./schedule.ts";
import { withHookBlock } from "./toml-hooks.ts";
import {
  CONTEXT_OBSERVATIONS,
  droidHome,
  droidStandalonePaths,
  dropHooks,
  type HookFile,
  hookFile,
  invalidJsonMessage,
  kimiConfigPath,
  MEM_MODE,
  memDir,
  memPreviousPath,
  openHookFile,
  ourHookVerb,
  readJsonObject,
  type SetupDeps,
  writeJsonWithBackup,
  writeTextWithBackup,
} from "./wire.ts";

/** Every `<configDir>/projects/*\/agent-kit` ledger root. */
export function ledgerRoots(ctx: LearnContext): string[] {
  const projects = join(ctx.config.configDir, "projects");
  let folders: string[] = [];
  try {
    folders = readdirSync(projects);
  } catch {
    return [];
  }
  return folders.map((folder) => join(projects, folder, "agent-kit")).filter((dir) => existsSync(dir));
}

/**
 * Put claude-mem's budget and mode back to what they were before the first
 * wire. A key is restored only while it still holds the value wire set, so a
 * change the user made since is kept.
 */
function restoreMem(ctx: LearnContext, deps: SetupDeps): void {
  const settingsPath = join(memDir(ctx, deps), "settings.json");
  if (!existsSync(settingsPath)) {
    rmSync(memPreviousPath(ctx), { force: true });
    return;
  }
  const settings = readJsonObject<Record<string, unknown>>(settingsPath, {});
  if (settings === null) {
    ctx.io.err(invalidJsonMessage(settingsPath));
    return;
  }
  const previous = readJson<Record<string, unknown>>(memPreviousPath(ctx), {});
  const ours: Array<[string, unknown]> = [
    ["CLAUDE_MEM_CONTEXT_OBSERVATIONS", CONTEXT_OBSERVATIONS],
    ["CLAUDE_MEM_MODE", MEM_MODE],
  ];
  let changed = false;
  const unset = new Set<string>();
  for (const [key, value] of ours) {
    if (settings[key] !== value) continue;
    const before = previous[key];
    if (before === undefined || before === null) unset.add(key);
    else settings[key] = before;
    changed = true;
  }
  // The record is spent once read, matched or not; a later wire records afresh.
  rmSync(memPreviousPath(ctx), { force: true });
  if (!changed) return;
  writeJsonWithBackup(settingsPath, Object.fromEntries(Object.entries(settings).filter(([key]) => !unset.has(key))));
  ctx.io.out(`${settingsPath}: observation budget and mode restored to their values before wire`);
}

/** Every JSON file `wire` may have merged hooks into. Droid has three, because the entry goes wherever SessionStart was declared. */
function hookFiles(ctx: LearnContext, deps: SetupDeps): HookFile[] {
  return [
    hookFile(ctx, deps, "claude"),
    hookFile(ctx, deps, "codex"),
    hookFile(ctx, deps, "grok"),
    { path: join(droidHome(ctx, deps), "settings.json"), bare: false },
    ...droidStandalonePaths(ctx, deps).map((path) => ({ path, bare: true })),
  ];
}

/** Whether a line of a file this runtime cannot parse runs a hook of ours; false when the file cannot be read at all. */
function namesOurHook(path: string): boolean {
  try {
    return readFileSync(path, "utf8")
      .split("\n")
      .some((line) => ourHookVerb(line) !== null);
  } catch {
    return false;
  }
}

/** Take the managed block out of Kimi's `config.toml`; the rest of the file is left byte for byte. */
function unwireKimi(ctx: LearnContext, deps: SetupDeps): void {
  const path = kimiConfigPath(ctx, deps);
  if (!existsSync(path)) return;
  const before = readFileSync(path, "utf8");
  const after = withHookBlock(before, null);
  if (after === null) {
    ctx.io.err(`${path}: the agent-kit hook block is not one marked pair; remove it by hand`);
    return;
  }
  if (after !== before) writeTextWithBackup(path, after);
  ctx.io.out(`${path}: hook block ${after === before ? "not present" : "removed"}`);
}

export function uninstall(ctx: LearnContext, deps: SetupDeps, options: { purge?: boolean } = {}): number {
  for (const file of hookFiles(ctx, deps)) {
    if (!existsSync(file.path)) continue;
    const opened = openHookFile(file);
    if ("refuse" in opened) {
      if (namesOurHook(file.path)) ctx.io.err(opened.refuse);
      else ctx.io.out(`${file.path}: cannot be read and names no agent-kit hook; left as it is`);
      continue;
    }
    const removed = dropHooks(opened.doc);
    const left = Object.keys(opened.doc.hooks ?? {}).length;
    if (file.owned === true && left === 0) rmSync(file.path, { force: true });
    else if (removed > 0) writeJsonWithBackup(file.path, opened.contents());
    ctx.io.out(`${file.path}: ${removed} hook entries removed`);
  }
  unwireKimi(ctx, deps);

  const kind = schedulerKind(deps);
  const paths = unitPaths(deps, kind);
  if (kind === "launchd" && paths !== null && existsSync(paths.unit)) {
    deps.run(["launchctl", "bootout", `gui/${deps.uid}/${LABEL}`]);
    rmSync(paths.unit, { force: true });
    ctx.io.out(`${paths.unit}: unloaded and removed`);
  } else if (kind === "systemd" && paths !== null && (existsSync(paths.unit) || existsSync(paths.timer!))) {
    deps.run(["systemctl", "--user", "disable", "--now", `${LABEL}.timer`]);
    rmSync(paths.unit, { force: true });
    rmSync(paths.timer!, { force: true });
    deps.run(["systemctl", "--user", "daemon-reload"]);
    ctx.io.out(`${paths.unit}: disabled and removed`);
  } else if (kind === "cron") {
    ctx.io.out("remove the `learn memory tick` line with `crontab -e` if you added one");
  }

  restoreMem(ctx, deps);

  if (options.purge === true) {
    for (const dir of ledgerRoots(ctx)) {
      rmSync(dir, { recursive: true, force: true });
      ctx.io.out(`${dir}: purged`);
    }
    rmSync(ctx.config.runtimeDir, { recursive: true, force: true });
    ctx.io.out(`${ctx.config.runtimeDir}: purged`);
  } else {
    ctx.io.out(
      `ledgers under ${join(ctx.config.configDir, "projects")}/*/agent-kit were kept (they are your data; --purge removes them)`,
    );
  }
  return 0;
}
