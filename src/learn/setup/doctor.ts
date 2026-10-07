/**
 * `ak learn setup doctor` — report prerequisites, registry hygiene, the
 * scheduled judge's login, the resolved environment and the last 24 hours of
 * judge calls and spans.
 * Reads only; changes nothing.
 */
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { DEFAULT_JUDGE } from "../core/config.ts";
import type { LearnContext } from "../core/context.ts";
import { judgeTraceSummary } from "../core/judge.ts";
import { readRegistry, registryHygiene } from "../memory/registry.ts";
import { schedulerKind, unitEnvironment } from "./schedule.ts";
import { scopeText } from "./scope.ts";
import { codexHome, hostHome, memDir, memWorkerScript, type SetupDeps } from "./wire.ts";
import { runsLine } from "../stats.ts";
import { workerHomes } from "../sources/worker-sessions.ts";

export interface Check {
  name: string;
  ok: boolean;
  /** A hard requirement blocks setup; a soft one only narrows what the runtime can see. */
  hard: boolean;
  why: string;
}

/** The judge command's binary, resolved the way the runtime will spawn it. */
export function judgeBinary(ctx: LearnContext, deps: SetupDeps): string | null {
  const bin = ctx.config.judgeCommand[0];
  if (bin === undefined) return null;
  if (isAbsolute(bin) || bin.includes("/")) return existsSync(bin) ? bin : null;
  return deps.which(bin);
}

/** What a scheduler gives a unit before the unit's own environment is applied. */
const SCHEDULER_BASE = ["HOME", "USER", "LOGNAME"];

/**
 * Whether the default judge is logged in under the environment `setup schedule`
 * would give the unit now, not the operator's shell and not an already
 * installed unit. Free: it asks the host CLI for its auth status and makes no
 * judge call. Null for a custom judge command, whose login this cannot read.
 */
function scheduledJudgeAuth(ctx: LearnContext, deps: SetupDeps): Check | null {
  if (
    ctx.config.judgeCommand.length !== DEFAULT_JUDGE.length ||
    ctx.config.judgeCommand.some((arg, index) => arg !== DEFAULT_JUDGE[index])
  ) {
    return null;
  }
  const binary = judgeBinary(ctx, deps);
  if (binary === null) {
    return { name: "scheduled judge auth", ok: false, hard: false, why: "judge command is unavailable" };
  }
  const env: NodeJS.ProcessEnv = {};
  for (const key of SCHEDULER_BASE) {
    if (ctx.env[key] !== undefined) env[key] = ctx.env[key];
  }
  for (const [key, value] of unitEnvironment(ctx)) env[key] = value;
  const result = deps.run([binary, "auth", "status"], { env });
  const loggedIn = result.code === 0 && /"loggedIn"\s*:\s*true/.test(result.stdout);
  return {
    name: "scheduled judge auth",
    ok: loggedIn,
    hard: false,
    why: loggedIn ? "logged in" : "not logged in",
  };
}

export function doctorChecks(ctx: LearnContext, deps: SetupDeps): Check[] {
  const gh = deps.which("gh");
  const auth = scheduledJudgeAuth(ctx, deps);
  const registryWarnings = registryHygiene(readRegistry(ctx.config)).warnings;
  return [
    { name: "bun", ok: deps.which("bun") !== null, hard: true, why: "runs `ak learn` from hooks and the scheduler" },
    { name: "git", ok: deps.which("git") !== null, hard: true, why: "every ledger is a git repository" },
    {
      name: `judge (${ctx.config.judgeCommand[0] ?? "unset"})`,
      ok: judgeBinary(ctx, deps) !== null,
      hard: true,
      why: "the one judgement call; set AK_LEARN_JUDGE to change it",
    },
    {
      name: "claude-mem db",
      ok: existsSync(ctx.config.memDb),
      hard: false,
      why: "observations for the memory loop and skill discovery",
    },
    {
      name: "claude-mem worker script",
      ok: memWorkerScript(ctx, deps) !== null,
      hard: false,
      why: "restarting after a settings change",
    },
    {
      name: "gh authenticated",
      ok: gh !== null && deps.run([gh, "auth", "status"]).code === 0,
      hard: false,
      why: "PR review threads for the review loop",
    },
    {
      name: "registry hygiene",
      ok: registryWarnings.length === 0,
      hard: false,
      why: registryWarnings.length === 0 ? "one eligible root per claude-mem project" : registryWarnings.join("; "),
    },
    ...(auth === null ? [] : [auth]),
  ];
}

export function doctor(ctx: LearnContext, deps: SetupDeps): number {
  const checks = doctorChecks(ctx, deps);
  const width = Math.max(...checks.map((check) => check.name.length));
  for (const check of checks) {
    const state = check.ok ? "OK" : check.hard ? "MISSING" : "absent";
    ctx.io.out(
      `  ${check.name.padEnd(width)}  ${state.padEnd(8)} ${(check.hard ? "hard" : "soft").padEnd(5)} ${check.why}`,
    );
  }
  ctx.io.out("");
  ctx.io.out("Resolved environment");
  ctx.io.out(
    `  CLAUDE_CONFIG_DIR   ${ctx.config.configDir}${ctx.env.CLAUDE_CONFIG_DIR ? "" : "   (default, not exported)"}`,
  );
  ctx.io.out(`  runtime state       ${ctx.config.runtimeDir}`);
  ctx.io.out(`  ak command          ${deps.ak.join(" ")}`);
  ctx.io.out(`  judge command       ${ctx.config.judgeCommand.join(" ")}`);
  ctx.io.out(`  claude-mem dir      ${memDir(ctx, deps)}   (db ${ctx.config.memDb})`);
  ctx.io.out(`  codex home          ${codexHome(ctx, deps)}${existsSync(codexHome(ctx, deps)) ? "" : "   (absent)"}`);
  for (const host of ["droid", "grok", "kimi"] as const) {
    const home = hostHome(ctx, deps, host);
    ctx.io.out(`  ${`${host} home`.padEnd(19)} ${home}${existsSync(home) ? "" : "   (absent)"}`);
  }
  const stores = workerHomes(ctx.env);
  for (const host of ["codex", "droid", "grok", "kimi"] as const) {
    const homes = stores[host];
    const present = homes.filter((home) => existsSync(join(home, "sessions"))).length;
    ctx.io.out(`  ${host} session stores  ${present}/${homes.length} present   ${homes.join(", ")}`);
  }
  ctx.io.out(`  scheduler           ${schedulerKind(deps)}`);
  ctx.io.out(`  repo scope          ${scopeText(ctx.config)}`);
  const trace = judgeTraceSummary(ctx.config);
  ctx.io.out(
    `  judge calls (24h)  ${trace.calls} ${trace.calls === 1 ? "call" : "calls"}, ${trace.failures} ${trace.failures === 1 ? "failure" : "failures"}, $${trace.totalCostUsd.toFixed(6)} total cost`,
  );
  ctx.io.out(runsLine(ctx.config));
  const blocked = checks.filter((check) => check.hard && !check.ok).map((check) => check.name);
  if (blocked.length > 0) {
    ctx.io.out(`\nBLOCKED: ${blocked.join(", ")}`);
    return 1;
  }
  ctx.io.out("\nAll hard requirements present.");
  return 0;
}
