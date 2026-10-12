/**
 * Runtime configuration for `ak learn`, read from the environment once per run.
 *
 * No setting names a model. The judge is one configurable command, and which
 * model sits behind it is the runner's binding, not this package's (ruling
 * `learning-judge-is-runner-bound`). The tool-call distiller is bound the same
 * way, one command per worker host, and has no default: a host the operator
 * binds nothing to is never sent anywhere.
 */
import { lstatSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export interface LearnConfig {
  /** `$CLAUDE_CONFIG_DIR`, else `~/.claude`. Ledgers live under `<configDir>/projects/`. */
  configDir: string;
  /** Runtime-wide state outside any project: the project registry, the tick log and the judge-call trace. */
  runtimeDir: string;
  /** The judge command as argv. The prompt goes to stdin; JSON comes back on stdout. */
  judgeCommand: string[];
  judgeTimeoutMs: number;
  /**
   * The tool-call distiller per worker host, as argv: `AK_LEARN_DISTILL_<HOST>`, the host's name in
   * capitals. The prompt goes to stdin; JSON comes back on stdout. A host with no entry keeps excerpts.
   * The scheduled tick sees a binding only once `ak learn setup schedule` writes the unit again.
   */
  distillCommands: Readonly<Record<string, readonly string[]>>;
  distillTimeoutMs: number;
  /** The most distiller requests one project's capture makes in a run; calls past it keep their excerpts. */
  distillMaxRequests: number;
  /** `AK_LEARN_TRACE=full`: also write each call's prompt and reply bodies beside the metadata trace. */
  traceFull: boolean;
  /** Maximum bytes in the current judge-call metadata file before rotation. Fixed; not an environment option. */
  traceMaxBytes: number;
  /** claude-mem's SQLite database, opened read-only. */
  memDb: string;
  /** Review loop: events needed before a pattern is active, and before it is promoted. */
  activeAt: number;
  promoteAt: number;
  /** Memory loop. */
  idleS: number;
  reflectTokens: number;
  memoryTokens: number;
  nightlyHour: number;
  batch: number;
  /** Print decisions and prompts; write nothing. */
  dryRun: boolean;
  /**
   * The repo scope: the main repo roots the hooks and the scheduled tick may act on, as absolute
   * paths that existed when read. null is unscoped; an empty list allows nothing.
   */
  repos: readonly string[] | null;
  /** Where the scope came from: `AK_LEARN_REPOS` overrides the file `setup scope` writes. */
  reposSource: "none" | "file" | "env";
}

/**
 * The default judge. `--settings` with every hook disabled keeps the judge's own
 * session out of observers such as claude-mem, and out of this runtime's hooks.
 * `--tools ""` leaves the judge no tools at all: its prompt carries text anyone
 * can write (review comments, observations), and a judge that can read files or
 * run commands turns that text into actions. The judgement needs only the prompt.
 * `--tools ""` covers only the built-in tools; `--strict-mcp-config` with no
 * `--mcp-config` keeps the user's and plugins' MCP servers out as well.
 * `--no-session-persistence` keeps each call from leaving a transcript in the
 * operator's project store.
 * `--bare` is deliberately absent: it also drops the login the call needs.
 */
export const DEFAULT_JUDGE = [
  "claude",
  "-p",
  "--tools",
  "",
  "--strict-mcp-config",
  "--settings",
  '{"disableAllHooks":true}',
  "--no-session-persistence",
  "--output-format",
  "json",
];

function int(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : fallback;
}

/**
 * Split a command string the way a shell would for the simple cases a judge
 * command needs: whitespace separation, single and double quotes, backslash
 * escapes outside single quotes. No expansion of any kind.
 */
export function splitCommand(text: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let started = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (quote === "'") {
      if (ch === "'") quote = null;
      else current += ch;
      continue;
    }
    if (ch === "\\" && i + 1 < text.length) {
      current += text[i + 1];
      i += 1;
      started = true;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = null;
      else current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (started) out.push(current);
      current = "";
      started = false;
      continue;
    }
    current += ch;
    started = true;
  }
  if (quote !== null) throw new Error(`unterminated ${quote} in command: ${text}`);
  if (started) out.push(current);
  return out;
}

/** One distiller binding: a single-word host name, so the stage's other settings never read as a host. */
const DISTILL_BINDING = /^AK_LEARN_DISTILL_([A-Z][A-Z0-9]*)$/;

/** The variable that binds `host`'s tool-call distiller. */
export function distillVariable(host: string): string {
  return `AK_LEARN_DISTILL_${host.toUpperCase()}`;
}

function distillCommands(env: NodeJS.ProcessEnv) {
  const commands: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(env)) {
    const host = DISTILL_BINDING.exec(key)?.[1];
    if (host === undefined || value === undefined || value.trim() === "") continue;
    commands[host.toLowerCase()] = splitCommand(value);
  }
  return commands;
}

/** The scope file `ak learn setup scope` manages. */
export function scopeFile(runtimeDir: string): string {
  return join(runtimeDir, "repos");
}

/**
 * A path's file identity, read with stat alone: the scheduled tick may stat inside a repository
 * but never open there (`rootOf`), and resolving symlinks opens each directory on the way. Two
 * spellings of one directory, through a symlink or in another case, share an identity.
 */
export function identity(path: string): string | null {
  try {
    const stat = statSync(path, { bigint: true, throwIfNoEntry: false });
    return stat === undefined ? null : `${stat.dev}:${stat.ino}`;
  } catch {
    return null;
  }
}

/**
 * A `:`-separated scope. An entry counts only when it is absolute and exists; anything else
 * matches nothing, so a blank or mistyped scope fails closed rather than meaning every repo.
 */
export function parseRepos(text: string): string[] {
  return text
    .split(":")
    .map((entry) => entry.trim())
    .filter((entry) => isAbsolute(entry) && identity(entry) !== null)
    .map((entry) => resolve(entry));
}

/** Whether the hooks and the scheduled tick may act on `root`, a main repo root (null outside any repo). */
export function repoAllowed(config: LearnConfig, root: string | null): boolean {
  if (config.repos === null) return true;
  const id = root === null ? null : identity(root);
  return id !== null && config.repos.some((entry) => identity(entry) === id);
}

/**
 * Whether the scope file is there, by lstat: a dangling symlink or an entry that cannot be checked
 * counts as present, so it reads as a scope that allows nothing rather than as no scope at all.
 */
function scopePresent(path: string): boolean {
  try {
    return lstatSync(path, { throwIfNoEntry: false }) !== undefined;
  } catch {
    return true;
  }
}

function identities(roots: readonly string[]): Set<string> {
  return new Set(roots.map((root) => identity(root) ?? root));
}

/** Whether two scopes allow the same repositories, by file identity: spelling and order do not count. */
export function sameScope(a: readonly string[] | null, b: readonly string[] | null): boolean {
  if (a === null || b === null) return a === b;
  const [x, y] = [identities(a), identities(b)];
  return x.size === y.size && [...x].every((id) => y.has(id));
}

/** The scope file's text; one that cannot be read is a scope that allows nothing. */
function readScope(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): LearnConfig {
  const configDir =
    env.CLAUDE_CONFIG_DIR && env.CLAUDE_CONFIG_DIR.trim() !== "" ? env.CLAUDE_CONFIG_DIR : join(homedir(), ".claude");
  const memDir =
    env.CLAUDE_MEM_DATA_DIR && env.CLAUDE_MEM_DATA_DIR.trim() !== ""
      ? env.CLAUDE_MEM_DATA_DIR
      : join(homedir(), ".claude-mem");
  const judge =
    env.AK_LEARN_JUDGE && env.AK_LEARN_JUDGE.trim() !== "" ? splitCommand(env.AK_LEARN_JUDGE) : DEFAULT_JUDGE;
  const runtimeDir = join(configDir, "agent-kit", "learn");
  // Presence, not content: a blank variable is a scope that allows nothing.
  const scope =
    env.AK_LEARN_REPOS !== undefined
      ? { text: env.AK_LEARN_REPOS, source: "env" as const }
      : scopePresent(scopeFile(runtimeDir))
        ? { text: readScope(scopeFile(runtimeDir)), source: "file" as const }
        : null;
  return {
    configDir,
    runtimeDir,
    judgeCommand: judge,
    judgeTimeoutMs: int(env, "AK_LEARN_JUDGE_TIMEOUT_S", 300) * 1000,
    distillCommands: distillCommands(env),
    distillTimeoutMs: int(env, "AK_LEARN_DISTILL_TIMEOUT_S", 120) * 1000,
    distillMaxRequests: Math.max(0, int(env, "AK_LEARN_DISTILL_MAX_REQUESTS", 20)),
    traceFull: env.AK_LEARN_TRACE === "full",
    traceMaxBytes: 10 * 1024 * 1024,
    memDb:
      env.AK_LEARN_MEM_DB && env.AK_LEARN_MEM_DB.trim() !== "" ? env.AK_LEARN_MEM_DB : join(memDir, "claude-mem.db"),
    activeAt: int(env, "AK_LEARN_ACTIVE_AT", 2),
    promoteAt: int(env, "AK_LEARN_PROMOTE_AT", 3),
    idleS: int(env, "AK_LEARN_IDLE_S", 300),
    reflectTokens: int(env, "AK_LEARN_REFLECT_TOKENS", 25_000),
    memoryTokens: int(env, "AK_LEARN_MEMORY_TOKENS", 2_500),
    nightlyHour: int(env, "AK_LEARN_NIGHTLY_HOUR", 2),
    batch: int(env, "AK_LEARN_BATCH", 24),
    dryRun: env.AK_LEARN_DRY_RUN === "1",
    repos: scope === null ? null : parseRepos(scope.text),
    reposSource: scope?.source ?? "none",
  };
}
