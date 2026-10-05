/**
 * `ak learn` — the opt-in learning runtime.
 *
 * This is a host adapter, not catalog content: hooks and the scheduler live
 * here and only here, under the opt-in `learning` profile, and no packaged
 * skill body depends on them (ruling `learning-runtime-is-host-adapter`).
 */
import { loadConfig } from "./core/config.ts";
import type { LearnArea, LearnContext, LearnIo } from "./core/context.ts";
import { parseLearnArgs } from "./core/context.ts";
import { commandJudge, type JudgeFn } from "./core/judge.ts";
import { hookArea } from "./hooks.ts";
import { memoryArea } from "./memory/cli.ts";
import { reviewArea } from "./review/cli.ts";
import { setupArea } from "./setup/cli.ts";
import { skillsArea } from "./skills/cli.ts";
import { statsArea } from "./stats.ts";

export const LEARN_AREAS: Readonly<Record<string, LearnArea>> = {
  review: reviewArea,
  memory: memoryArea,
  skills: skillsArea,
  setup: setupArea,
  hook: hookArea,
  stats: statsArea,
};

export function learnUsage(): string[] {
  const lines = ["ak learn — the opt-in learning runtime (profile `learning`)", ""];
  for (const [name, area] of Object.entries(LEARN_AREAS)) {
    lines.push(`  ak learn ${name}  ${area.summary}`);
    for (const verb of Object.values(area.verbs)) lines.push(`      ${verb.usage}`);
  }
  return lines;
}

export interface RunLearnOptions {
  cwd: string;
  io: LearnIo;
  env?: NodeJS.ProcessEnv;
  judge?: JudgeFn;
  stdin?: string;
}

/**
 * `argv` is everything after `ak learn`.
 *
 * `ak learn hook …` is called by the host on every session start, prompt and
 * stop, so nothing on that path may fail the session: a malformed setting, an
 * unknown verb (a newer wiring against an older package) or any throw is
 * reported on stderr and the exit code is 0. A Stop hook exiting 2 would block
 * the session from stopping.
 */
export function runLearn(argv: readonly string[], options: RunLearnOptions): number {
  if (argv[0] !== "hook") return dispatch(argv, options);
  try {
    dispatch(argv, options);
  } catch (error) {
    options.io.err(`ak learn hook: ${(error as Error).message}`);
  }
  return 0;
}

function dispatch(argv: readonly string[], options: RunLearnOptions): number {
  const [areaName, ...afterArea] = argv;
  const area = areaName === undefined ? undefined : LEARN_AREAS[areaName];
  const fallback = area?.default;
  const defaulted = fallback !== undefined && (afterArea[0] === undefined || afterArea[0].startsWith("--"));
  const [verbName, ...rest] = defaulted ? [fallback, ...afterArea] : afterArea;
  if (area === undefined) {
    if (areaName !== undefined) options.io.err(`ak learn: unknown area ${areaName}`);
    for (const line of learnUsage()) options.io.err(line);
    return 2;
  }
  const verb = verbName === undefined ? undefined : area.verbs[verbName];
  if (verb === undefined) {
    if (verbName !== undefined) options.io.err(`ak learn ${areaName}: unknown verb ${verbName}`);
    options.io.err(`ak learn ${areaName} — ${area.summary}`);
    for (const entry of Object.values(area.verbs)) options.io.err(`  ${entry.usage}`);
    return 2;
  }
  const env = options.env ?? process.env;
  const config = loadConfig(env);
  const ctx: LearnContext = {
    cwd: options.cwd,
    io: options.io,
    config,
    judge: options.judge ?? commandJudge(config),
    env,
    stdin: options.stdin,
  };
  return verb.run(parseLearnArgs(rest), ctx);
}
