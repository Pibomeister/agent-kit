/**
 * PRD R3.6: `ak doctor` warns when an installed host version differs from the
 * last review-isolation probe note. Findings are WARN/NOTE/PASS, never FAIL.
 * Version detection is stubbed; tests do not spawn real host CLIs or fetch.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  binariesFor,
  checkProbedHostVersion,
  DOCTOR_PROBE_HOSTS,
  parseProbedHostVersion,
  probedHostVersionFindings,
  readInstalledHostVersion,
  readLatestProbedHostVersion,
  VERSION_TIMEOUT_MS,
  type DoctorProbeHost,
  type ProbeVersionFinding,
} from "../src/maintenance/host-probe-version.ts";
import { renderNote } from "../src/review-isolation-probe/note.ts";
import type { ProbeHost, ProbeReport } from "../src/review-isolation-probe/types.ts";
import { processScratch } from "./helpers/process-tmp.ts";

function line(item: ProbeVersionFinding): string {
  return `${item.level} ${item.check}: ${item.detail}. Remedy: ${item.remedy}`;
}

function sampleNote(host: ProbeHost, version: string, date: string): string {
  const report: ProbeReport = {
    host,
    hostVersion: version,
    pluginsAndHooks: "none",
    date,
    driver: "live",
    commands: [],
    work: "/tmp/ak-probe-work",
    verdictPath: "/tmp/ak-probe-verdict.json",
    notePath: `/tmp/review-isolation-${host}.md`,
    arms: [],
  };
  return renderNote(report);
}

function writeProbeNote(factsRoot: string, host: DoctorProbeHost, date: string, version: string): string {
  const dir = join(factsRoot, date);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `review-isolation-${host}.md`);
  const body = host === "cursor" ? cursorNote(version, date) : sampleNote(host, version, date);
  writeFileSync(path, body);
  return path;
}

function cursorNote(version: string, date: string): string {
  return [
    "# Review isolation probe — cursor",
    "",
    date,
    "",
    "## Instrument",
    "",
    "| Item | Value |",
    "|---|---|",
    "| Host | cursor |",
    `| Host version | ${version} |`,
    "| Plugins / hooks | none |",
    "| Driver | live |",
    "| Work | /tmp/ak-probe-work |",
    "| Verdict JSON | /tmp/ak-probe-verdict.json |",
    "",
  ].join("\n");
}

function stubInstalled(
  versions: Partial<Record<DoctorProbeHost, string | null>>,
): (host: DoctorProbeHost) => string | null {
  return (host) => (host in versions ? (versions[host] ?? null) : null);
}

function runDoctor(root: string, path: string) {
  mkdirSync(join(root, "claude-home"), { recursive: true });
  mkdirSync(join(root, "codex-home"), { recursive: true });
  const result = spawnSync(process.execPath, [join(import.meta.dir, "../src/maintenance/cli.ts"), "doctor"], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: path,
      CLAUDE_CONFIG_DIR: join(root, "claude-home"),
      CODEX_HOME: join(root, "codex-home"),
      AK_PUBLISHED_ROOT: join(root, "missing-published"),
    },
  });
  return { status: result.status, stdout: result.stdout };
}

describe("ak doctor host-version probe check", () => {
  test("reads Host version from the note format the probe script writes", () => {
    const note = sampleNote("claude-code", "2.0.1 (Claude Code)", "2026-11-03");
    expect(note).toContain("| Host version | 2.0.1 (Claude Code) |");
    expect(parseProbedHostVersion(note)).toBe("2.0.1 (Claude Code)");
  });

  test("a fixture with a mismatched version prints WARN and never FAIL", () => {
    const facts = join(processScratch("ak-doctor-probe-mismatch-"), "facts");
    writeProbeNote(facts, "claude-code", "2026-11-03", "2.0.1 (Claude Code)");
    const items = probedHostVersionFindings(facts, stubInstalled({ "claude-code": "2.1.0 (Claude Code)" }));
    const claude = items.find((item) => item.check === "claude-code isolation probe");
    expect(claude).toBeDefined();
    if (claude === undefined) return;
    expect(claude.level).toBe("WARN");
    expect(line(claude)).toContain(
      "WARN claude-code isolation probe: installed 2.1.0 (Claude Code) differs from last probed 2.0.1 (Claude Code) (2026-11-03)",
    );
    for (const item of items)
      expect(item.level === "PASS" || item.level === "WARN" || item.level === "NOTE").toBe(true);
  });

  test("matching versions print no warning", () => {
    const facts = join(processScratch("ak-doctor-probe-match-"), "facts");
    writeProbeNote(facts, "codex", "2026-11-03", "codex-cli 0.153.4");
    const items = probedHostVersionFindings(facts, stubInstalled({ codex: "codex-cli 0.153.4" }));
    const codex = items.find((item) => item.check === "codex isolation probe");
    expect(codex).toBeDefined();
    if (codex === undefined) return;
    expect(codex.level).toBe("PASS");
    expect(line(codex)).not.toContain("WARN");
    expect(items.some((item) => item.check === "codex isolation probe" && item.level === "WARN")).toBe(false);
  });

  test("a missing host or missing note is NOTE, not a warning, and does not error", () => {
    const facts = join(processScratch("ak-doctor-probe-missing-"), "facts");
    writeProbeNote(facts, "claude-code", "2026-11-03", "2.0.1");
    const missingHost = checkProbedHostVersion("claude-code", null, "2.0.1", "2026-11-03");
    const missingNote = checkProbedHostVersion("codex", "codex-cli 0.1.0", null, null);
    const missingBoth = checkProbedHostVersion("mastracode", null, null, null);
    expect(missingHost.level).toBe("NOTE");
    expect(missingNote.level).toBe("NOTE");
    expect(missingBoth.level).toBe("NOTE");
    expect(line(missingHost)).toStartWith("NOTE ");
    expect(line(missingNote)).not.toContain("WARN");
    const items = probedHostVersionFindings(facts, stubInstalled({}));
    expect(items.every((item) => item.level === "NOTE" || item.level === "PASS")).toBe(true);
    expect(items.every((item) => item.level !== "WARN")).toBe(true);
  });

  test("the newest dated probe note is the last probed version", () => {
    const facts = join(processScratch("ak-doctor-probe-latest-"), "facts");
    writeProbeNote(facts, "claude-code", "2026-10-01", "1.0.0");
    writeProbeNote(facts, "claude-code", "2026-11-03", "2.0.1");
    const latest = readLatestProbedHostVersion(facts, "claude-code");
    expect(latest?.date).toBe("2026-11-03");
    expect(latest?.version).toBe("2.0.1");
    const match = checkProbedHostVersion("claude-code", "2.0.1", latest?.version ?? null, latest?.date ?? null);
    expect(match.level).toBe("PASS");
    const stale = checkProbedHostVersion("claude-code", "1.0.0", latest?.version ?? null, latest?.date ?? null);
    expect(stale.level).toBe("WARN");
  });

  test("historical host-facts that are not review-isolation notes are ignored", () => {
    const facts = join(processScratch("ak-doctor-probe-oldfacts-"), "facts");
    const dir = join(facts, "2026-10-03");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "claude-code-1-hook-failures.md"), "| Host version | should-not-count |\n");
    expect(readLatestProbedHostVersion(facts, "claude-code")).toBeNull();
    expect(checkProbedHostVersion("claude-code", "1.0.0", null, null).level).toBe("NOTE");
  });

  test("every doctor probe host is checked and cursor uses cursor-agent", () => {
    expect([...DOCTOR_PROBE_HOSTS]).toEqual(["claude-code", "codex", "mastracode", "cursor"]);
    expect(binariesFor("cursor")).toEqual(["cursor-agent"]);
    expect(binariesFor("claude-code")).toEqual(["claude"]);
    expect(binariesFor("codex")).toEqual(["codex"]);
    const facts = join(processScratch("ak-doctor-probe-all-"), "facts");
    const items = probedHostVersionFindings(facts, stubInstalled({}));
    expect(items).toHaveLength(3);
    expect(items.map((item) => item.check)).toEqual([
      "claude-code isolation probe",
      "codex isolation probe",
      "mastracode isolation probe",
    ]);
    for (const item of items) expect(item.level).toBe("NOTE");
    writeProbeNote(facts, "cursor", "2026-11-03", "cursor-agent 0.1.0");
    const withCursor = probedHostVersionFindings(facts, stubInstalled({ cursor: "cursor-agent 0.2.0" }));
    expect(withCursor).toHaveLength(4);
    const cursor = withCursor.find((item) => item.check === "cursor isolation probe");
    expect(cursor).toBeDefined();
    if (cursor === undefined) return;
    expect(cursor.level).toBe("WARN");
  });
});

describe("installed host version detection (stub binaries, not real host CLIs)", () => {
  test("returns the first line of a stub --version and null when missing", () => {
    const root = processScratch("ak-doctor-probe-bin-");
    const binDir = join(root, "bin");
    mkdirSync(binDir);
    writeFileSync(join(binDir, "claude"), "#!/bin/sh\nprintf '%s\\n' '2.1.0 (Claude Code)' 'ignored'\\n");
    chmodSync(join(binDir, "claude"), 0o755);
    const env = { ...process.env, PATH: binDir };
    expect(readInstalledHostVersion("claude-code", env)).toBe("2.1.0 (Claude Code)");
    expect(readInstalledHostVersion("codex", env)).toBeNull();
    expect(readInstalledHostVersion("cursor", { ...process.env, PATH: "/usr/bin:/bin" })).toBeNull();
  });

  test("a timed-out stub is missing, not an error", () => {
    const root = processScratch("ak-doctor-probe-timeout-");
    const binDir = join(root, "bin");
    mkdirSync(binDir);
    writeFileSync(join(binDir, "codex"), "#!/bin/sh\nexec sleep 5\n");
    chmodSync(join(binDir, "codex"), 0o755);
    const start = Date.now();
    expect(readInstalledHostVersion("codex", { ...process.env, PATH: `${binDir}:/usr/bin:/bin` }, 100)).toBeNull();
    expect(Date.now() - start).toBeLessThan(2000);
    expect(VERSION_TIMEOUT_MS).toBe(5_000);
  });
});

describe("ak doctor CLI host-version wiring", () => {
  test("doctor prints WARN on a mismatched stub version and NOTE when the host is missing", () => {
    const root = processScratch("ak-doctor-probe-cli-");
    spawnSync("git", ["init", "-q", root]);
    writeProbeNote(join(root, "research/host-facts"), "claude-code", "2026-11-03", "2.0.1 (Claude Code)");
    const binDir = join(root, "bin");
    mkdirSync(binDir);
    writeFileSync(
      join(binDir, "claude"),
      `#!/bin/sh
if [ "$1" = --version ]; then printf '%s\\n' '2.1.0 (Claude Code)'; exit 0; fi
printf '%s\\n' '[]'
`,
    );
    chmodSync(join(binDir, "claude"), 0o755);
    const mismatch = runDoctor(root, `${binDir}:/usr/bin:/bin`);
    expect(mismatch.stdout).toContain(
      "WARN claude-code isolation probe: installed 2.1.0 (Claude Code) differs from last probed 2.0.1 (Claude Code) (2026-11-03)",
    );
    expect(mismatch.stdout).toContain("NOTE mastracode isolation probe:");
    expect(mismatch.stdout).not.toContain("NOTE cursor isolation probe:");
    expect(mismatch.stdout).not.toMatch(/FAIL [a-z-]+ isolation probe:/);
    const missing = runDoctor(root, "/usr/bin:/bin");
    expect(missing.stdout).toContain(
      "NOTE claude-code isolation probe: not installed; last probed 2.0.1 (Claude Code) (2026-11-03)",
    );
    expect(missing.status).not.toBe(2);
  });

  test("doctor prints no isolation-probe warning when the stub version matches", () => {
    const root = processScratch("ak-doctor-probe-cli-match-");
    spawnSync("git", ["init", "-q", root]);
    writeProbeNote(join(root, "research/host-facts"), "claude-code", "2026-11-03", "2.0.1 (Claude Code)");
    const binDir = join(root, "bin");
    mkdirSync(binDir);
    writeFileSync(
      join(binDir, "claude"),
      `#!/bin/sh
if [ "$1" = --version ]; then printf '%s\\n' '2.0.1 (Claude Code)'; exit 0; fi
printf '%s\\n' '[]'
`,
    );
    chmodSync(join(binDir, "claude"), 0o755);
    const match = runDoctor(root, `${binDir}:/usr/bin:/bin`);
    expect(match.stdout).toContain(
      "PASS claude-code isolation probe: installed 2.0.1 (Claude Code) matches last probed 2.0.1 (Claude Code) (2026-11-03)",
    );
    expect(match.stdout).not.toContain("WARN claude-code isolation probe:");
  });
});
