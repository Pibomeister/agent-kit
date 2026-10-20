/**
 * One temporary directory per process, removed when the process exits.
 *
 * Fixtures created through processScratch share this directory, so these
 * helpers add one entry to the temporary parent and a killed process leaves
 * one entry, not one per fixture. Other fixture builders manage their own paths.
 * On macOS the directory sits under `/tmp`, not `os.tmpdir()`: the
 * per-user `$TMPDIR` collects entries until each create in it stalls, and bun
 * lists every directory above a script it starts. Elsewhere it sits under
 * `os.tmpdir()`.
 *
 * - `processDir()` is the directory, with one canonical spelling. The first
 *   call creates it and registers its removal on exit.
 * - `processScratch(prefix)` is a fresh child of it, for one fixture.
 *
 * Nothing here lists a directory: finding leaks from earlier runs is not a
 * test's job.
 */
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string | undefined;

/** Where the process directory is created on `platform`. */
export function processTmpParent(platform: NodeJS.Platform = process.platform): string {
  return platform === "darwin" ? "/tmp" : tmpdir();
}

export function processDir(): string {
  if (dir === undefined) {
    const created = realpathSync(mkdtempSync(join(processTmpParent(), "ak-proc-")));
    process.on("exit", removeProcessDir);
    dir = created;
  }
  return dir;
}

/** Bun's test runner uses suite teardown instead of emitting the process exit event. */
export function removeProcessDir(): void {
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
}

export function processScratch(prefix: string): string {
  return mkdtempSync(join(processDir(), prefix));
}
