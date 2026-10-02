import { lstatSync, realpathSync } from "node:fs";
import { delimiter, dirname, isAbsolute, relative, resolve } from "node:path";

export function workerControlledPath(path: string, workerRoot: string): boolean {
  if (!isAbsolute(path)) return true;
  let existing = resolve(path);
  for (;;) {
    try {
      lstatSync(existing);
      break;
    } catch (cause) {
      if (!(cause instanceof Error) || !("code" in cause) || cause.code !== "ENOENT") return true;
      const parent = dirname(existing);
      if (parent === existing) return true;
      existing = parent;
    }
  }
  try {
    const rel = relative(workerRoot, realpathSync(existing));
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  } catch {
    return true;
  }
}

export function workerFreePath(path: string | undefined, workerRoot: string): string {
  const entries = (path ?? "")
    .split(delimiter)
    .filter((entry) => entry.length > 0 && !workerControlledPath(entry, workerRoot));
  return entries.length > 0 ? entries.join(delimiter) : "/usr/bin:/bin";
}
