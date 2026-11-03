/**
 * `ak doctor` comparison of an installed host CLI version against the last
 * review-isolation probe note (PRD R3.6). Local files and a timed `--version`
 * spawn only: no model call, no fetch, never FAIL.
 */
import { spawnSync } from "node:child_process";
import { accessSync, constants, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { profileFor } from "../review-isolation-probe/hosts.ts";
import { HOSTS } from "../review-isolation-probe/types.ts";

export const VERSION_TIMEOUT_MS = 5_000;

/** Probe hosts plus Cursor's CLI, which doctor detects with `cursor-agent --version`. */
export const DOCTOR_PROBE_HOSTS = [...HOSTS, "cursor"] as const;
export type DoctorProbeHost = (typeof DOCTOR_PROBE_HOSTS)[number];

export type ProbeVersionLevel = "PASS" | "WARN" | "NOTE";

export interface ProbeVersionFinding {
  level: ProbeVersionLevel;
  check: string;
  detail: string;
  remedy: string;
}

export type ReadInstalledHostVersion = (host: DoctorProbeHost) => string | null;

const DATE_DIR = /^\d{4}-\d{2}-\d{2}$/;
const HOST_VERSION_ROW = /^\| Host version \| (.*) \|$/m;
const CURSOR_BINARIES = ["cursor-agent"] as const;
const CURSOR_VERSION_ARGS = ["--version"] as const;

export function isDoctorProbeHost(value: string): value is DoctorProbeHost {
  for (const host of DOCTOR_PROBE_HOSTS) if (host === value) return true;
  return false;
}

export function binariesFor(host: DoctorProbeHost): readonly string[] {
  if (host === "cursor") return CURSOR_BINARIES;
  return profileFor(host).binaries;
}

export function versionArgsFor(host: DoctorProbeHost): readonly string[] {
  if (host === "cursor") return CURSOR_VERSION_ARGS;
  return profileFor(host).versionArgs;
}

export function checkName(host: DoctorProbeHost): string {
  return `${host} isolation probe`;
}

/**
 * The `Host version` cell from a note written by `renderNote` /
 * `scripts/review-isolation-probe.sh`. Anything else is not a probe note.
 */
export function parseProbedHostVersion(note: string): string | null {
  const match = HOST_VERSION_ROW.exec(note.replaceAll("\r\n", "\n"));
  const raw = match?.[1]?.trim();
  if (raw === undefined || raw === "") return null;
  return raw.replaceAll("\\|", "|");
}

export function readLatestProbedHostVersion(
  factsRoot: string,
  host: DoctorProbeHost,
): { date: string; version: string; path: string } | null {
  const dates: string[] = [];
  try {
    for (const entry of readdirSync(factsRoot, { withFileTypes: true })) {
      if (entry.isDirectory() && DATE_DIR.test(entry.name)) dates.push(entry.name);
    }
  } catch {
    return null;
  }
  for (const date of dates.toSorted().toReversed()) {
    const path = join(factsRoot, date, `review-isolation-${host}.md`);
    try {
      const version = parseProbedHostVersion(readFileSync(path, "utf8"));
      if (version !== null) return { date, version, path };
    } catch {
      continue;
    }
  }
  return null;
}

export function checkProbedHostVersion(
  host: DoctorProbeHost,
  installed: string | null,
  probedVersion: string | null,
  probedDate: string | null,
): ProbeVersionFinding {
  const check = checkName(host);
  if (installed !== null && probedVersion !== null && installed === probedVersion) {
    const when = probedDate === null ? "" : ` (${probedDate})`;
    return {
      level: "PASS",
      check,
      detail: `installed ${installed} matches last probed ${probedVersion}${when}`,
      remedy: "No action needed.",
    };
  }
  if (installed !== null && probedVersion !== null) {
    const when = probedDate === null ? "" : ` (${probedDate})`;
    return {
      level: "WARN",
      check,
      detail: `installed ${installed} differs from last probed ${probedVersion}${when}`,
      remedy: `Re-run scripts/review-isolation-probe.sh ${host} on this host version. Probe results apply only to the version they recorded.`,
    };
  }
  if (installed === null && probedVersion === null) {
    return {
      level: "NOTE",
      check,
      detail: "not installed; no review-isolation probe note",
      remedy:
        host === "cursor"
          ? "Install cursor-agent. Isolation probe notes for this host are recorded as research/host-facts/<date>/review-isolation-cursor.md."
          : `Install ${binariesFor(host).join("/")} and run scripts/review-isolation-probe.sh ${host} to record a version.`,
    };
  }
  if (installed === null) {
    const when = probedDate === null ? "" : ` (${probedDate})`;
    return {
      level: "NOTE",
      check,
      detail: `not installed; last probed ${probedVersion}${when}`,
      remedy:
        host === "cursor"
          ? "Install cursor-agent to compare against the last isolation probe."
          : `Install ${binariesFor(host).join("/")} to compare against the last isolation probe.`,
    };
  }
  return {
    level: "NOTE",
    check,
    detail: `installed ${installed}; no review-isolation probe note`,
    remedy:
      host === "cursor"
        ? "Record research/host-facts/<date>/review-isolation-cursor.md with a Host version cell for the installed cursor-agent."
        : `Run scripts/review-isolation-probe.sh ${host} to record the installed host version.`,
  };
}

function hostsToCheck(factsRoot: string): DoctorProbeHost[] {
  const hosts: DoctorProbeHost[] = [...HOSTS];
  // Cursor has no probe driver yet; compare it only when a note already exists.
  if (readLatestProbedHostVersion(factsRoot, "cursor") !== null) hosts.push("cursor");
  return hosts;
}

export function probedHostVersionFindings(
  factsRoot: string,
  readInstalled: ReadInstalledHostVersion,
): ProbeVersionFinding[] {
  const items: ProbeVersionFinding[] = [];
  for (const host of hostsToCheck(factsRoot)) {
    const probed = readLatestProbedHostVersion(factsRoot, host);
    items.push(checkProbedHostVersion(host, readInstalled(host), probed?.version ?? null, probed?.date ?? null));
  }
  return items;
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function which(names: readonly string[], pathEnv: string | undefined): string | null {
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

/** First line of `<bin> --version`, or null when the host is not on PATH. Timed; no network. */
export function readInstalledHostVersion(
  host: DoctorProbeHost,
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs: number = VERSION_TIMEOUT_MS,
): string | null {
  const bin = which(binariesFor(host), env.PATH);
  if (bin === null) return null;
  const result = spawnSync(bin, [...versionArgsFor(host)], {
    encoding: "utf8",
    timeout: timeoutMs,
    killSignal: "SIGKILL",
    env: { ...env, NO_UPDATE_NOTIFIER: "1" },
  });
  if (result.error !== undefined && result.error.message.includes("ETIMEDOUT")) return null;
  const text = (result.stdout ?? "").trim() || (result.stderr ?? "").trim();
  if (text === "") return null;
  return text.split("\n")[0] ?? text;
}
