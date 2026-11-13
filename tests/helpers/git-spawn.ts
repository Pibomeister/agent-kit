/**
 * Retries a git spawn that did not finish.
 *
 * Loaded from `tests/preload.ts` before any test file binds `node:child_process`.
 * `spawnSync` is replaced on the builtin module at that moment: a later static
 * import in product code (`src/lifecycle/gate.ts`, `src/kb/git.ts`) and in the
 * tests receives this wrapper. A finished git process, any exit status, is
 * returned as it is. An assertion is never retried.
 *
 * A null status is a signal or a spawn that produced no process. A spawn error
 * is the same class (`EAGAIN`, `EMFILE`, and the rest). A read that must print
 * a path or a hash (`rev-parse`, a `symbolic-ref` read, `merge-base` other than
 * `--is-ancestor`, `blame --porcelain`, a hash `--format`) exits 0 only with
 * output. Empty output there is that same lost spawn, which is how a loaded
 * host reports "not a git checkout" with nothing after the colon and then
 * copies the work tree itself as if it were the index. Setting or deleting a
 * symbolic ref, and an ancestor check, exit 0 with no output; those are not
 * tried again.
 */
import { Buffer } from "node:buffer";

import type { SpawnSyncOptions, SpawnSyncReturns } from "node:child_process";

export const GIT_SPAWN_ATTEMPTS = 3;

const RETRY_PAUSE_MS = 50;

export interface GitSpawnView {
  status: number | null;
  error?: Error | undefined;
  stdout: string | Uint8Array | null;
  stderr: string | Uint8Array | null;
}

function outputText(value: string | Uint8Array | null): string {
  if (value === null) return "";
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  if (value instanceof Uint8Array) return Buffer.from(value).toString("utf8");
  return value;
}

function blank(value: string | Uint8Array | null): boolean {
  return outputText(value).trim() === "";
}

function positionalsAfter(args: readonly string[], command: string): string[] {
  const start = args.indexOf(command);
  if (start < 0) return [];
  return args.slice(start + 1).filter((arg) => !arg.startsWith("-"));
}

/** Commands whose successful run always writes a path or a hash. */
export function commandMustPrint(args: readonly string[]): boolean {
  if (args.includes("rev-parse")) return true;
  if (args.includes("merge-base")) return !args.includes("--is-ancestor");
  if (args.includes("symbolic-ref")) {
    const writing =
      args.includes("-d") || args.includes("--delete") || positionalsAfter(args, "symbolic-ref").length !== 1;
    return !writing;
  }
  if (args.includes("blame") && args.includes("--porcelain")) return true;
  return args.some((arg) => arg.startsWith("--format=%") && arg.length > "--format=%".length);
}

export function gitSpawnTransient(args: readonly string[], result: GitSpawnView): boolean {
  if (result.error !== undefined || result.status === null) return true;
  return result.status === 0 && blank(result.stdout) && blank(result.stderr) && commandMustPrint(args);
}

function pause(): void {
  Bun.sleepSync(RETRY_PAUSE_MS);
}

function shouldRetry(args: readonly string[], result: GitSpawnView): boolean {
  if (!gitSpawnTransient(args, result)) return false;
  // The PATH shim already retried an empty successful read. Doing it again here
  // would multiply the three attempts.
  if (process.env.AK_GIT_SHIM === "1" && result.error === undefined && result.status !== null) return false;
  return true;
}

export function retryGitSpawn<T extends GitSpawnView>(args: readonly string[], spawn: () => T): T {
  let result = spawn();
  for (let attempt = 1; attempt < GIT_SPAWN_ATTEMPTS && shouldRetry(args, result); attempt++) {
    pause();
    result = spawn();
  }
  return result;
}

type GitSpawn = typeof import("node:child_process").spawnSync;

const retried = new WeakSet<object>();

function isGitCommand(command: string): boolean {
  return command === "git" || command.endsWith("/git");
}

function isArgv(value: readonly string[] | SpawnSyncOptions | undefined): value is readonly string[] {
  return Array.isArray(value);
}

type SpawnObserver = (
  command: string,
  argv: readonly string[],
  options: SpawnSyncOptions | undefined,
  result: SpawnSyncReturns<string | Buffer>,
  elapsedMs: number,
) => void;

let observeSpawn: SpawnObserver | undefined;

/** Registered by the journal after this wrapper is installed, so the import does not bind `spawnSync` early. */
export function bindSpawnObserver(observe: SpawnObserver): void {
  observeSpawn = observe;
}

function callGit(
  original: GitSpawn,
  command: string,
  args: readonly string[] | SpawnSyncOptions | undefined,
  options: SpawnSyncOptions | undefined,
): SpawnSyncReturns<string | Buffer> {
  // Record the raw return before retry reads it. The same object goes back to the caller.
  const started = Date.now();
  const result = isArgv(args) ? original(command, args, options) : original(command, args);
  observeSpawn?.(command, isArgv(args) ? args : [], isArgv(args) ? options : args, result, Date.now() - started);
  return result;
}

export function installGitSpawnRetry(): void {
  const childProcess = process.getBuiltinModule("node:child_process");
  if (retried.has(childProcess.spawnSync)) return;
  const original: GitSpawn = childProcess.spawnSync;
  function wrapped(
    command: string,
    args?: readonly string[] | SpawnSyncOptions,
    options?: SpawnSyncOptions,
  ): SpawnSyncReturns<string | Buffer> {
    if (!isGitCommand(command)) return callGit(original, command, args, options);
    const argv = isArgv(args) ? args : [];
    return retryGitSpawn(argv, () => callGit(original, command, args, options));
  }
  retried.add(wrapped);
  // The overload set on spawnSync cannot be implemented by one function, so the
  // replacement is written through Reflect rather than an assertion.
  Reflect.set(childProcess, "spawnSync", wrapped);
}

installGitSpawnRetry();

/** The wrapper installed on `spawnSync`, so a test can see that the binding is live. */
export function installedGitSpawn(): GitSpawn {
  const current = process.getBuiltinModule("node:child_process").spawnSync;
  if (!retried.has(current)) throw new Error("git spawn retry is not installed");
  return current;
}
