/**
 * `ak learn` — the opt-in learning runtime.
 *
 * This is a host adapter, not catalog content: hooks and the scheduler live
 * here and only here, under the opt-in `learning` profile, and no packaged
 * skill body depends on them (ruling `learning-runtime-is-host-adapter`).
 */
import { readFileSync } from "node:fs";
import { loadConfig } from "./core/config.ts";
import type { LearnArea, LearnContext, LearnIo } from "./core/context.ts";
import { parseLearnArgs } from "./core/context.ts";
import type { DistillFn } from "./core/distill.ts";
import { commandJudge, type JudgeFn } from "./core/judge.ts";

/**
 * Each area is loaded when its command runs, not at startup: the host calls
 * `ak learn hook …` on every session start, prompt and stop, and that path
 * must not evaluate the areas it never calls. The load is `import()`, not
 * `require`: a module Bun first loads through `require` gets its
 * `with { type: "text" }` imports as file paths, which empties the unit
 * templates and the role prompts.
 */
const LEARN_AREAS: Readonly<Record<string, () => Promise<LearnArea>>> = {
  review: async () => (await import("./review/cli.ts")).reviewArea,
  memory: async () => (await import("./memory/cli.ts")).memoryArea,
  skills: async () => (await import("./skills/cli.ts")).skillsArea,
  setup: async () => (await import("./setup/cli.ts")).setupArea,
  hook: async () => (await import("./hooks.ts")).hookArea,
  stats: async () => (await import("./stats.ts")).statsArea,
};

export async function learnUsage(): Promise<string[]> {
  const lines = ["ak learn — the opt-in learning runtime (profile `learning`)", ""];
  for (const [name, load] of Object.entries(LEARN_AREAS)) {
    const area = await load();
    lines.push(`  ak learn ${name}  ${area.summary}`);
    for (const verb of Object.values(area.verbs)) lines.push(`      ${verb.usage}`);
  }
  return lines;
}

/** The host's hook payload on stdin, read only for `ak learn hook …`; `argv` is the whole command line after `ak`. */
export function readHookStdin(argv: readonly string[]): string | undefined {
  if (argv[0] !== "learn" || argv[1] !== "hook" || process.stdin.isTTY) return undefined;
  try {
    return readFileSync(0, "utf8");
  } catch {
    return undefined;
  }
}

export interface RunLearnOptions {
  cwd: string;
  io: LearnIo;
  env?: NodeJS.ProcessEnv;
  judge?: JudgeFn;
  distill?: DistillFn;
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
export async function runLearn(argv: readonly string[], options: RunLearnOptions): Promise<number> {
  if (argv[0] !== "hook") return dispatch(argv, options);
  try {
    await dispatch(argv, options);
  } catch (error) {
    options.io.err(`ak learn hook: ${(error as Error).message}`);
  }
  return 0;
}

async function dispatch(argv: readonly string[], options: RunLearnOptions): Promise<number> {
  const [areaName, ...afterArea] = argv;
  const area = areaName === undefined ? undefined : await LEARN_AREAS[areaName]?.();
  const fallback = area?.default;
  const defaulted = fallback !== undefined && (afterArea[0] === undefined || afterArea[0].startsWith("--"));
  const [verbName, ...rest] = defaulted ? [fallback, ...afterArea] : afterArea;
  if (area === undefined) {
    if (areaName !== undefined) options.io.err(`ak learn: unknown area ${areaName}`);
    for (const line of await learnUsage()) options.io.err(line);
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
    distill: options.distill,
    env,
    stdin: options.stdin,
  };
  return verb.run(parseLearnArgs(rest), ctx);
}
