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
 * is the same class (`EAGAIN`, `EMFILE`, and the rest). `rev-parse`,
 * `symbolic-ref`, `merge-base`, `blame --porcelain`, and a hash `--format` exit
 * 0 only with output; empty output there is that same lost spawn, which is how
 * a loaded host reports "not a git checkout" with nothing after the colon and
 * then copies the work tree itself as if it were the index.
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

/** Commands whose successful run always writes a path or a hash. */
function commandMustPrint(args: readonly string[]): boolean {
  if (args.includes("rev-parse") || args.includes("symbolic-ref") || args.includes("merge-base")) return true;
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

export function retryGitSpawn<T extends GitSpawnView>(args: readonly string[], spawn: () => T): T {
  let result = spawn();
  for (let attempt = 1; attempt < GIT_SPAWN_ATTEMPTS && gitSpawnTransient(args, result); attempt++) {
    pause();
    result = spawn();
  }
  return result;
}

const retried = new WeakSet<object>();
let activeSpawn: typeof import("node:child_process").spawnSync | undefined;

function isGitCommand(command: string): boolean {
  return command === "git" || command.endsWith("/git");
}

function callGit(
  original: typeof import("node:child_process").spawnSync,
  command: string,
  args: readonly string[] | SpawnSyncOptions | undefined,
  options: SpawnSyncOptions | undefined,
): SpawnSyncReturns<string | Buffer> {
  if (Array.isArray(args)) return original(command, args, options);
  return original(command, args);
}

export function installGitSpawnRetry(): void {
  const childProcess = process.getBuiltinModule("node:child_process");
  if (retried.has(childProcess.spawnSync)) return;
  const original = childProcess.spawnSync.bind(childProcess);
  const wrapped: typeof childProcess.spawnSync = (command, args, options) => {
    if (!isGitCommand(command)) return callGit(original, command, args, options);
    const argv = Array.isArray(args) ? args : [];
    return retryGitSpawn(argv, () => callGit(original, command, args, options));
  };
  retried.add(wrapped);
  activeSpawn = wrapped;
  childProcess.spawnSync = wrapped;
}

installGitSpawnRetry();

/** The wrapper installed on `spawnSync`, so a test can see that the binding is live. */
export function installedGitSpawn(): typeof import("node:child_process").spawnSync | undefined {
  return activeSpawn;
}
