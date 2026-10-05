/**
 * What every `ak learn` command receives. Tests build one with a scratch
 * config directory and a scripted judge; nothing reads global state directly.
 */
import type { LearnConfig } from "./config.ts";
import type { JudgeFn } from "./judge.ts";
import type { SpanHandle } from "./trace.ts";

export interface LearnIo {
  out: (line: string) => void;
  err: (line: string) => void;
}

export interface LearnContext {
  cwd: string;
  io: LearnIo;
  config: LearnConfig;
  judge: JudgeFn;
  env: NodeJS.ProcessEnv;
  /** Hook payload read from stdin, when the command was started by a host hook. */
  stdin?: string;
  /** The unit of work this context runs inside (`trace.ts`); judge calls name it as their run. */
  span?: SpanHandle;
}

/** Parsed arguments below `ak learn <area> <verb>`. */
export interface LearnArgs {
  positional: string[];
  flags: Map<string, string | true>;
}

export type LearnCommand = (args: LearnArgs, ctx: LearnContext) => number;

/** One `ak learn <area>`: its verbs and a one-line usage per verb. */
export interface LearnArea {
  summary: string;
  verbs: Record<string, { usage: string; run: LearnCommand }>;
}

/** Flags that take a value. Everything else is boolean. Shared so every area parses alike. */
export const LEARN_VALUE_FLAGS = new Set([
  "repo",
  "project",
  "job",
  "since",
  "source",
  "cwd",
  "pr",
  "id",
  "to",
  "config-dir",
  "host",
  "interval",
  "limit",
  "gh-repo",
  "days",
]);

export function parseLearnArgs(argv: readonly string[]): LearnArgs {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    const [name, inline] = token.slice(2).split("=", 2) as [string, string | undefined];
    if (LEARN_VALUE_FLAGS.has(name) && inline === undefined) {
      const value = argv[i + 1];
      if (value !== undefined && !value.startsWith("--")) {
        flags.set(name, value);
        i += 1;
        continue;
      }
    }
    flags.set(name, inline ?? true);
  }
  return { positional, flags };
}

export function flag(args: LearnArgs, name: string): string | undefined {
  const value = args.flags.get(name);
  return typeof value === "string" ? value : undefined;
}
