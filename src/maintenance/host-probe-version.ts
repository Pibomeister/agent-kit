/**
 * `ak doctor` comparison of an installed host CLI version against the last
 * review-isolation probe note (PRD R3.6). Local files and a timed `--version`
 * spawn only: no model call, no fetch. A finding is emitted only when a note
 * holds a real version and the host is installed: WARN on mismatch, PASS on
 * match. Missing host, missing note, or placeholder version: no finding and,
 * when there is no real note, no `--version` spawn.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  captureHostVersion,
  isHostVersionPlaceholder,
  VERSION_TIMEOUT_MS,
} from "../review-isolation-probe/host-cli.ts";
import { profileFor } from "../review-isolation-probe/hosts.ts";
import { HOSTS } from "../review-isolation-probe/types.ts";

export { VERSION_TIMEOUT_MS };

/** Probe hosts plus Cursor's CLI, compared only when a real probe note exists. */
export const DOCTOR_PROBE_HOSTS = [...HOSTS, "cursor"] as const;
export type DoctorProbeHost = (typeof DOCTOR_PROBE_HOSTS)[number];

export type ProbeVersionLevel = "PASS" | "WARN";

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
 * `scripts/review-isolation-probe.sh`. Probe placeholders (missing binary,
 * empty `--version`, fixture run) are not a version: the caller keeps
 * walking to older notes.
 */
export function parseProbedHostVersion(note: string): string | null {
  const match = HOST_VERSION_ROW.exec(note.replaceAll("\r\n", "\n"));
  const raw = match?.[1]?.trim();
  if (raw === undefined || raw === "") return null;
  const version = raw.replaceAll("\\|", "|");
  return isHostVersionPlaceholder(version) ? null : version;
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
  installed: string,
  probedVersion: string,
  probedDate: string,
): ProbeVersionFinding {
  const check = checkName(host);
  const when = ` (${probedDate})`;
  if (installed === probedVersion) {
    return {
      level: "PASS",
      check,
      detail: `installed ${installed} matches last probed ${probedVersion}${when}`,
      remedy: "No action needed.",
    };
  }
  const remedy =
    host === "cursor"
      ? "Re-probe Cursor's review isolation and record a new research/host-facts/<date>/review-isolation-cursor.md note for this version. Probe results apply only to the version they recorded."
      : `Re-run scripts/review-isolation-probe.sh ${host} on this host version. Probe results apply only to the version they recorded.`;
  return {
    level: "WARN",
    check,
    detail: `installed ${installed} differs from last probed ${probedVersion}${when}`,
    remedy,
  };
}

interface HostProbePair {
  host: DoctorProbeHost;
  probed: { date: string; version: string; path: string };
}

/** Resolved `{host, probed}` pairs so each note is read once. */
function hostsToCheck(factsRoot: string): HostProbePair[] {
  const pairs: HostProbePair[] = [];
  for (const host of DOCTOR_PROBE_HOSTS) {
    const probed = readLatestProbedHostVersion(factsRoot, host);
    if (probed !== null) pairs.push({ host, probed });
  }
  return pairs;
}

export function probedHostVersionFindings(
  factsRoot: string,
  readInstalled: ReadInstalledHostVersion,
): ProbeVersionFinding[] {
  const items: ProbeVersionFinding[] = [];
  for (const { host, probed } of hostsToCheck(factsRoot)) {
    const installed = readInstalled(host);
    if (installed === null) continue;
    items.push(checkProbedHostVersion(host, installed, probed.version, probed.date));
  }
  return items;
}

/** First line of a zero-exit `<bin> --version`, or null when missing, timed out, or nonzero. */
export function readInstalledHostVersion(
  host: DoctorProbeHost,
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs: number = VERSION_TIMEOUT_MS,
): string | null {
  const captured = captureHostVersion(binariesFor(host), versionArgsFor(host), {
    requireZeroExit: true,
    env,
    timeoutMs,
  });
  return isHostVersionPlaceholder(captured) ? null : captured;
}
