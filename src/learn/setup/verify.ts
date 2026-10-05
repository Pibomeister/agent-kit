/**
 * `ak learn setup verify` — check that the wiring, the scheduler unit, the
 * ledgers and the judge are all in place. Reads only.
 */
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { LearnContext } from "../core/context.ts";
import { type Loop, loopDir, mainRepoRoot } from "../core/paths.ts";
import { readJson } from "../core/store.ts";
import { readRegistry, unknownRepo } from "../memory/registry.ts";
import { judgeBinary } from "./doctor.ts";
import { LABEL, schedulerKind, unitPaths } from "./schedule.ts";
import {
  CONTEXT_OBSERVATIONS,
  claudeSettingsPath,
  codexHome,
  countHook,
  type HookDoc,
  MEM_MODE,
  memDir,
  type SetupDeps,
} from "./wire.ts";

export interface VerifyResult {
  label: string;
  ok: boolean;
  detail: string;
}

const LOOPS: readonly Loop[] = ["review", "memory", "skills"];

export function verifyChecks(ctx: LearnContext, deps: SetupDeps, repo?: string): VerifyResult[] {
  const out: VerifyResult[] = [];
  const check = (label: string, ok: boolean, detail = "") => out.push({ label, ok, detail });

  const claude = readJson<HookDoc>(claudeSettingsPath(ctx), {});
  for (const [event, verb] of [
    ["SessionStart", "session-start"],
    ["Stop", "stop"],
  ] as const) {
    const n = countHook(claude, event, verb);
    check(`claude ${event} hook`, n === 1, `${n} entries`);
  }
  const codexHooks = join(codexHome(ctx, deps), "hooks.json");
  if (existsSync(codexHooks)) {
    const codex = readJson<HookDoc>(codexHooks, {});
    for (const [event, verb] of [
      ["SessionStart", "session-start"],
      ["UserPromptSubmit", "prompt"],
      ["Stop", "stop --source codex"],
    ] as const) {
      const n = countHook(codex, event, verb);
      check(`codex ${event} hook`, n === 1, `${n} entries`);
    }
  }

  if (existsSync(ctx.config.memDb)) {
    const dir = memDir(ctx, deps);
    const settings = readJson<Record<string, unknown>>(join(dir, "settings.json"), {});
    check(
      "claude-mem observation budget",
      settings.CLAUDE_MEM_CONTEXT_OBSERVATIONS === CONTEXT_OBSERVATIONS,
      String(settings.CLAUDE_MEM_CONTEXT_OBSERVATIONS),
    );
    check("claude-mem mode file", existsSync(join(dir, "modes", `${MEM_MODE}.json`)));
  }

  const kind = schedulerKind(deps);
  const paths = unitPaths(deps, kind);
  if (paths !== null) {
    check(`${kind} unit written`, existsSync(paths.unit), paths.unit);
    if (paths.timer !== undefined) check(`${kind} timer written`, existsSync(paths.timer), paths.timer);
    if (kind === "launchd") check("launchd job loaded", deps.run(["launchctl", "list"]).stdout.includes(LABEL));
  } else if (kind === "cron") {
    check("crontab line", deps.run(["crontab", "-l"]).stdout.includes("learn memory tick"));
  } else {
    check("scheduler", false, "no launchd, systemd or cron; run the tick from your own scheduler");
  }

  const roots: string[] = [];
  if (repo !== undefined) {
    const start = resolve(ctx.cwd, repo);
    const root = mainRepoRoot(start);
    if (root === null) check("repository", false, `not inside a git repository: ${unknownRepo(ctx.config, start)}`);
    roots.push(root ?? start);
  } else {
    roots.push(...Object.values(readRegistry(ctx.config)).map((entry) => entry.root));
  }
  if (roots.length === 0) check("seeded projects", false, "none registered; run `ak learn setup seed --repo P`");
  for (const root of roots) {
    for (const loop of LOOPS) {
      const dir = loopDir(ctx.config, root, loop);
      check(`${loop} ledger (${root})`, existsSync(join(dir, ".git")), dir);
    }
  }

  const judge = judgeBinary(ctx, deps);
  check("judge command resolvable", judge !== null, judge ?? ctx.config.judgeCommand.join(" "));
  return out;
}

export function verify(ctx: LearnContext, deps: SetupDeps, repo?: string): number {
  const results = verifyChecks(ctx, deps, repo);
  for (const result of results)
    ctx.io.out(`  ${result.ok ? "PASS" : "FAIL"}  ${result.label}${result.detail === "" ? "" : `  ${result.detail}`}`);
  const failed = results.filter((result) => !result.ok).length;
  ctx.io.out(failed === 0 ? "\nall checks passed" : `\n${failed} checks failed`);
  return failed === 0 ? 0 : 1;
}
