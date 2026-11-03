/**
 * PATH lookup and `--version` capture shared by the review-isolation probe
 * and `ak doctor`, so both record the same first line.
 */
import { spawnSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { join } from "node:path";

export const VERSION_TIMEOUT_MS = 5_000;

/** Written into a probe note when the host binary is absent. */
export const HOST_VERSION_NOT_ON_PATH = "not on PATH";

const NO_OUTPUT_SUFFIX = " (no version output)";

/** Written into a probe note when `--version` is empty, nonzero, or timed out. */
export function hostVersionNoOutput(bin: string): string {
  return `${bin}${NO_OUTPUT_SUFFIX}`;
}

export function isHostVersionPlaceholder(value: string): boolean {
  return value === HOST_VERSION_NOT_ON_PATH || value.endsWith(NO_OUTPUT_SUFFIX);
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function which(names: readonly string[], pathEnv: string | undefined): string | null {
  const path = pathEnv ?? "";
  for (const name of names) {
    if (name.includes("/")) {
      if (isExecutable(name)) return name;
      continue;
    }
    for (const dir of path.split(":")) {
      if (dir === "") continue;
      const candidate = join(dir, name);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * True when spawnSync hit its timeout.
 *
 * Grandchildren of a wrapper script can outlive `killSignal`: a timeout means
 * this process was killed, not that every descendant stopped.
 */
export function spawnTimedOut(error: Error | undefined): boolean {
  if (error === undefined) return false;
  // SAFETY: spawnSync reports timeout as an ErrnoException with code ETIMEDOUT.
  return (error as NodeJS.ErrnoException).code === "ETIMEDOUT";
}

/**
 * First line of a zero-exit `--version`. Placeholders otherwise, never a throw.
 * `NO_UPDATE_NOTIFIER=1` is set so the CLI does not phone home for an update.
 */
export function captureHostVersion(
  binaries: readonly string[],
  versionArgs: readonly string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number = VERSION_TIMEOUT_MS,
): string {
  const bin = which(binaries, env.PATH);
  if (bin === null) return HOST_VERSION_NOT_ON_PATH;
  const result = spawnSync(bin, [...versionArgs], {
    encoding: "utf8",
    timeout: timeoutMs,
    killSignal: "SIGKILL",
    env: { ...env, NO_UPDATE_NOTIFIER: "1" },
  });
  if (spawnTimedOut(result.error) || result.status !== 0) return hostVersionNoOutput(bin);
  const text = (result.stdout ?? "").trim() || (result.stderr ?? "").trim();
  return text === "" ? hostVersionNoOutput(bin) : (text.split("\n")[0] ?? text);
}
