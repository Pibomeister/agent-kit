/**
 * `ak learn setup doctor` — report prerequisites and the resolved environment.
 * Reads only; changes nothing.
 */
import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { LearnContext } from "../core/context.ts";
import { judgeTraceSummary } from "../core/judge.ts";
import { schedulerKind } from "./schedule.ts";
import { codexHome, memDir, memWorkerScript, type SetupDeps } from "./wire.ts";

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

export function doctorChecks(ctx: LearnContext, deps: SetupDeps): Check[] {
  const gh = deps.which("gh");
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
  ctx.io.out(`  scheduler           ${schedulerKind(deps)}`);
  const trace = judgeTraceSummary(ctx.config);
  ctx.io.out(
    `  judge calls (24h)  ${trace.calls} ${trace.calls === 1 ? "call" : "calls"}, ${trace.failures} ${trace.failures === 1 ? "failure" : "failures"}, $${trace.totalCostUsd.toFixed(6)} total cost`,
  );
  const blocked = checks.filter((check) => check.hard && !check.ok).map((check) => check.name);
  if (blocked.length > 0) {
    ctx.io.out(`\nBLOCKED: ${blocked.join(", ")}`);
    return 1;
  }
  ctx.io.out("\nAll hard requirements present.");
  return 0;
}
