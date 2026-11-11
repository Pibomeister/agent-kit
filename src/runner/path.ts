import { lstatSync, realpathSync } from "node:fs";
import { delimiter, dirname, isAbsolute, relative, resolve, sep } from "node:path";

/** `..foo` is a descendant. Only `..` and `../` leave the root. */
export function relativeInsideRoot(rel: string): boolean {
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

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
    return relativeInsideRoot(relative(workerRoot, realpathSync(existing)));
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
