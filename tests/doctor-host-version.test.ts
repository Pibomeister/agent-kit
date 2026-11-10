/**
 * PRD R3.6: `ak doctor` warns when an installed host version differs from the
 * last review-isolation probe note. Findings are PASS or WARN only, and only
 * when a real note exists and the host is installed. Version detection is
 * stubbed; tests do not spawn real host CLIs or fetch.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
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
import {
  HOST_VERSION_FIXTURE,
  HOST_VERSION_NOT_ON_PATH,
  hostVersion,
  hostVersionNoOutput,
} from "../src/review-isolation-probe/dispatch.ts";
import { captureHostVersion } from "../src/review-isolation-probe/host-cli.ts";
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

function recordingInstalled(log: DoctorProbeHost[]) {
  return (host: DoctorProbeHost) => {
    log.push(host);
    return "should-not-spawn";
  };
}

function runDoctor(root: string, path: string) {
  mkdirSync(join(root, "claude-home"), { recursive: true });
  mkdirSync(join(root, "codex-home"), { recursive: true });
  mkdirSync(join(root, ".config"), { recursive: true });
  const env = {
    ...process.env,
    PATH: path,
    HOME: root,
    XDG_CONFIG_HOME: join(root, ".config"),
    CLAUDE_CONFIG_DIR: join(root, "claude-home"),
    CODEX_HOME: join(root, "codex-home"),
    AK_PUBLISHED_ROOT: join(root, "missing-published"),
  };
  delete env.AK_JEV_ENABLED;
  const result = spawnSync(process.execPath, [join(import.meta.dir, "../src/maintenance/cli.ts"), "doctor"], {
    cwd: root,
    encoding: "utf8",
    env,
  });
  return { status: result.status, stdout: result.stdout };
}

describe("ak doctor host-version probe check", () => {
  test("reads Host version from the note format the probe script writes", () => {
    const note = sampleNote("claude-code", "2.0.1 (Claude Code)", "2026-11-03");
    expect(note).toContain("| Host version | 2.0.1 (Claude Code) |");
    expect(parseProbedHostVersion(note)).toBe("2.0.1 (Claude Code)");
  });

  test("a fixture with a mismatched version prints WARN", () => {
    const facts = join(processScratch("ak-doctor-probe-mismatch-"), "facts");
    writeProbeNote(facts, "claude-code", "2026-11-03", "2.0.1 (Claude Code)");
    const items = probedHostVersionFindings(facts, (host) => (host === "claude-code" ? "2.1.0 (Claude Code)" : null));
    expect(items).toHaveLength(1);
    const claude = items[0];
    expect(claude).toBeDefined();
    if (claude === undefined) return;
    expect(claude.level).toBe("WARN");
    expect(line(claude)).toContain(
      "WARN claude-code isolation probe: installed 2.1.0 (Claude Code) differs from last probed 2.0.1 (Claude Code) (2026-11-03)",
    );
  });

  test("matching versions print no warning", () => {
    const facts = join(processScratch("ak-doctor-probe-match-"), "facts");
    writeProbeNote(facts, "codex", "2026-11-03", "codex-cli 0.153.4");
    const items = probedHostVersionFindings(facts, (host) => (host === "codex" ? "codex-cli 0.153.4" : null));
    expect(items).toHaveLength(1);
    const codex = items[0];
    expect(codex).toBeDefined();
    if (codex === undefined) return;
    expect(codex.level).toBe("PASS");
    expect(line(codex)).not.toContain("WARN");
  });

  test("a missing host or missing note emits no finding", () => {
    const facts = join(processScratch("ak-doctor-probe-missing-"), "facts");
    writeProbeNote(facts, "claude-code", "2026-11-03", "2.0.1");
    const spawned: DoctorProbeHost[] = [];
    const items = probedHostVersionFindings(facts, (host) => {
      spawned.push(host);
      return null;
    });
    expect(items).toEqual([]);
    expect(spawned).toEqual(["claude-code"]);
    const noNote: DoctorProbeHost[] = [];
    expect(probedHostVersionFindings(join(facts, "empty"), recordingInstalled(noNote))).toEqual([]);
    expect(noNote).toEqual([]);
  });

  test("no probe note means no finding and no --version spawn", () => {
    const facts = join(processScratch("ak-doctor-probe-nospawn-"), "facts");
    mkdirSync(facts, { recursive: true });
    const spawned: DoctorProbeHost[] = [];
    expect(probedHostVersionFindings(facts, recordingInstalled(spawned))).toEqual([]);
    expect(spawned).toEqual([]);
  });

  test("a newer fixture note is not a version; doctor compares against the older real one", () => {
    const facts = join(processScratch("ak-doctor-probe-fixture-"), "facts");
    writeProbeNote(facts, "claude-code", "2026-11-03", HOST_VERSION_FIXTURE);
    writeProbeNote(facts, "claude-code", "2026-10-01", "2.0.1");
    expect(parseProbedHostVersion(sampleNote("claude-code", HOST_VERSION_FIXTURE, "2026-11-03"))).toBeNull();
    expect(readLatestProbedHostVersion(facts, "claude-code")?.version).toBe("2.0.1");
    expect(readLatestProbedHostVersion(facts, "claude-code")?.date).toBe("2026-10-01");
    const items = probedHostVersionFindings(facts, (host) => (host === "claude-code" ? "2.0.1" : null));
    expect(items).toHaveLength(1);
    const claude = items[0];
    expect(claude).toBeDefined();
    if (claude === undefined) return;
    expect(claude.level).toBe("PASS");
    expect(line(claude)).toContain("matches last probed 2.0.1 (2026-10-01)");
    expect(line(claude)).not.toContain(HOST_VERSION_FIXTURE);
  });

  test("placeholder Host version is not a version and older real notes still count", () => {
    const facts = join(processScratch("ak-doctor-probe-placeholder-"), "facts");
    writeProbeNote(facts, "claude-code", "2026-11-03", HOST_VERSION_NOT_ON_PATH);
    writeProbeNote(facts, "claude-code", "2026-10-01", "2.0.1");
    writeProbeNote(facts, "codex", "2026-11-03", hostVersionNoOutput("/usr/bin/codex"));
    writeProbeNote(facts, "codex", "2026-09-01", "codex-cli 0.153.4");
    expect(parseProbedHostVersion(sampleNote("claude-code", HOST_VERSION_NOT_ON_PATH, "2026-11-03"))).toBeNull();
    expect(parseProbedHostVersion(sampleNote("codex", hostVersionNoOutput("/usr/bin/codex"), "2026-11-03"))).toBeNull();
    expect(readLatestProbedHostVersion(facts, "claude-code")?.version).toBe("2.0.1");
    expect(readLatestProbedHostVersion(facts, "claude-code")?.date).toBe("2026-10-01");
    expect(readLatestProbedHostVersion(facts, "codex")?.version).toBe("codex-cli 0.153.4");
    const items = probedHostVersionFindings(facts, (host) => {
      if (host === "claude-code") return "2.0.1";
      if (host === "codex") return "codex-cli 0.9.0";
      return null;
    });
    expect(items.map((item) => `${item.level} ${item.check}`)).toEqual([
      "PASS claude-code isolation probe",
      "WARN codex isolation probe",
    ]);
  });

  test("the newest dated probe note is the last probed version", () => {
    const facts = join(processScratch("ak-doctor-probe-latest-"), "facts");
    writeProbeNote(facts, "claude-code", "2026-10-01", "1.0.0");
    writeProbeNote(facts, "claude-code", "2026-11-03", "2.0.1");
    const latest = readLatestProbedHostVersion(facts, "claude-code");
    expect(latest?.date).toBe("2026-11-03");
    expect(latest?.version).toBe("2.0.1");
    expect(checkProbedHostVersion("claude-code", "2.0.1", latest?.version ?? "", latest?.date ?? "").level).toBe(
      "PASS",
    );
    expect(checkProbedHostVersion("claude-code", "1.0.0", latest?.version ?? "", latest?.date ?? "").level).toBe(
      "WARN",
    );
  });

  test("historical host-facts that are not review-isolation notes are ignored", () => {
    const facts = join(processScratch("ak-doctor-probe-oldfacts-"), "facts");
    const dir = join(facts, "2026-10-03");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "claude-code-1-hook-failures.md"), "| Host version | should-not-count |\n");
    expect(readLatestProbedHostVersion(facts, "claude-code")).toBeNull();
    const spawned: DoctorProbeHost[] = [];
    expect(probedHostVersionFindings(facts, recordingInstalled(spawned))).toEqual([]);
    expect(spawned).toEqual([]);
  });

  test("cursor is compared only when a real probe note exists", () => {
    expect([...DOCTOR_PROBE_HOSTS]).toEqual(["claude-code", "codex", "mastracode", "cursor"]);
    expect(binariesFor("cursor")).toEqual(["cursor-agent"]);
    const facts = join(processScratch("ak-doctor-probe-all-"), "facts");
    const spawned: DoctorProbeHost[] = [];
    expect(probedHostVersionFindings(facts, recordingInstalled(spawned))).toEqual([]);
    expect(spawned).toEqual([]);
    writeProbeNote(facts, "cursor", "2026-11-03", "cursor-agent 0.1.0");
    const withCursor = probedHostVersionFindings(facts, (host) => (host === "cursor" ? "cursor-agent 0.2.0" : null));
    expect(withCursor).toHaveLength(1);
    expect(withCursor[0]?.level).toBe("WARN");
  });

  test("a cursor version mismatch does not name the probe script", () => {
    const finding = checkProbedHostVersion("cursor", "cursor-agent 0.2.0", "cursor-agent 0.1.0", "2026-11-03");
    expect(finding.level).toBe("WARN");
    expect(finding.remedy).not.toContain("scripts/review-isolation-probe.sh");
    expect(finding.remedy).toContain("Re-probe Cursor's review isolation");
    expect(finding.remedy).toContain("research/host-facts/<date>/review-isolation-cursor.md");
  });
});

describe("installed host version detection (stub binaries, not real host CLIs)", () => {
  test("probe and doctor capture the same first line from a zero-exit --version", () => {
    const root = processScratch("ak-doctor-probe-bin-");
    const binDir = join(root, "bin");
    mkdirSync(binDir);
    writeFileSync(
      join(binDir, "claude"),
      `#!/bin/sh
if [ "$NO_UPDATE_NOTIFIER" = 1 ]; then printf '%s\\n' 'notifier-suppressed'; exit 0; fi
printf '%s\\n' '2.1.0 (Claude Code)' 'ignored'
`,
    );
    chmodSync(join(binDir, "claude"), 0o755);
    const env = { ...process.env, PATH: binDir };
    expect(hostVersion("claude-code", env)).toBe("2.1.0 (Claude Code)");
    expect(readInstalledHostVersion("claude-code", env)).toBe("2.1.0 (Claude Code)");
    expect(captureHostVersion(["claude"], ["--version"], { requireZeroExit: false, env })).toBe("2.1.0 (Claude Code)");
    expect(captureHostVersion(["claude"], ["--version"], { requireZeroExit: true, env })).toBe("2.1.0 (Claude Code)");
    expect(readInstalledHostVersion("codex", env)).toBeNull();
    expect(hostVersion("codex", env)).toBe(HOST_VERSION_NOT_ON_PATH);
  });

  test("probe records a printed --version line on nonzero exit; doctor treats it as no version", () => {
    const root = processScratch("ak-doctor-probe-nonzero-");
    const binDir = join(root, "bin");
    mkdirSync(binDir);
    const claude = join(binDir, "claude");
    writeFileSync(claude, "#!/bin/sh\nprintf '%s\\n' '2.1.0 (Claude Code)'\nexit 1\n");
    chmodSync(claude, 0o755);
    const env = { ...process.env, PATH: binDir };
    expect(hostVersion("claude-code", env)).toBe("2.1.0 (Claude Code)");
    expect(readInstalledHostVersion("claude-code", env)).toBeNull();
    expect(captureHostVersion(["claude"], ["--version"], { requireZeroExit: false, env })).toBe("2.1.0 (Claude Code)");
    expect(captureHostVersion(["claude"], ["--version"], { requireZeroExit: true, env })).toBe(
      hostVersionNoOutput(claude),
    );
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
  test("doctor prints WARN on a mismatched stub version and nothing when the host is missing", () => {
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
    expect(mismatch.stdout).not.toContain("NOTE ");
    expect(mismatch.stdout).not.toContain("mastracode isolation probe");
    const missing = runDoctor(root, "/usr/bin:/bin");
    expect(missing.stdout).not.toContain("isolation probe");
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

  test("a project without probe notes does not spawn --version", () => {
    const root = processScratch("ak-doctor-probe-cli-nospawn-");
    spawnSync("git", ["init", "-q", root]);
    const binDir = join(root, "bin");
    mkdirSync(binDir);
    const marker = join(root, "version-called");
    writeFileSync(
      join(binDir, "claude"),
      `#!/bin/sh
if [ "$1" = --version ]; then printf 'called\\n' > "${marker}"; printf '%s\\n' '2.1.0'; exit 0; fi
printf '%s\\n' '[]'
`,
    );
    chmodSync(join(binDir, "claude"), 0o755);
    const run = runDoctor(root, `${binDir}:/usr/bin:/bin`);
    expect(run.stdout).not.toContain("isolation probe");
    expect(existsSync(marker)).toBe(false);
  });
});
