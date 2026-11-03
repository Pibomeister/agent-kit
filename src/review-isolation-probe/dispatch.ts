/**
 * Live host invocation for one arm. Tests stub the binaries on PATH; the
 * fixture driver never calls this.
 *
 * Launch configuration is parsed from the host's own output. resume / fork_*
 * are never self-authored.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  extractClaudeLaunch,
  extractCodexLaunch,
  findClaudeChild,
  findCodexChild,
  toLaunchConfig,
} from "./children.ts";
import { captureHostVersion, spawnTimedOut, VERSION_TIMEOUT_MS, which } from "./host-cli.ts";
import { claudeProjectSlug, profileFor } from "./hosts.ts";
import type { PlantedArm } from "./plant.ts";
import type { ProbeHost } from "./types.ts";

export { findClaudeChild, findCodexChild, extractSpawn, extractClaudeLaunch, extractCodexLaunch } from "./children.ts";
export { HOST_VERSION_NOT_ON_PATH, hostVersionNoOutput } from "./host-cli.ts";

export interface DispatchResult {
  command: string[];
  stdout: string;
  stderr: string;
  code: number;
  timedOut: boolean;
  childTranscript: string | null;
  launchConfig: string;
  preToolUseLog: string | null;
  childIds: string[];
  parentSessionId: string | null;
}

export interface DispatchOptions {
  timeoutMs: number;
  env: NodeJS.ProcessEnv;
  configDir: string;
  sessionId: string;
}

interface ProcRun {
  stdout: string;
  stderr: string;
  code: number;
  timedOut: boolean;
}

function run(bin: string, args: string[], options: DispatchOptions, cwd: string, input: string | undefined): ProcRun {
  const result = spawnSync(bin, args, {
    cwd,
    input,
    encoding: "utf8",
    timeout: options.timeoutMs,
    killSignal: "SIGKILL",
    env: options.env,
  });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? result.error?.message ?? "",
    code: result.status ?? 1,
    timedOut: spawnTimedOut(result.error),
  };
}

function readIfPresent(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

export function hostVersion(host: ProbeHost, env: NodeJS.ProcessEnv): string {
  const profile = profileFor(host);
  return captureHostVersion(profile.binaries, profile.versionArgs, env, VERSION_TIMEOUT_MS);
}

function recordedCommand(bin: string, args: string[], parentPrompt: string): string[] {
  const recorded: string[] = [bin];
  for (const arg of args) {
    recorded.push(arg === parentPrompt ? "(parent prompt omitted from evidence)" : arg);
  }
  return recorded;
}

export function dispatchArm(host: ProbeHost, planted: PlantedArm, options: DispatchOptions): DispatchResult {
  const profile = profileFor(host);
  const bin = which(profile.binaries, options.env.PATH);
  writeFileSync(join(planted.workspace, "parent.prompt.txt"), planted.parentPrompt);

  if (host === "mastracode" || bin === null) {
    const reason =
      host === "mastracode"
        ? "no CLI dispatch path in this package (no mastracode adapter on main)"
        : `${profile.binaries.join("/")} not on PATH`;
    return {
      command: [],
      stdout: "",
      stderr: reason,
      code: 0,
      timedOut: false,
      childTranscript: null,
      launchConfig: JSON.stringify({ source: "absent", reason }, null, 2),
      preToolUseLog: null,
      childIds: [],
      parentSessionId: null,
    };
  }

  if (host === "claude-code") {
    const args = [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--session-id",
      options.sessionId,
      "--settings",
      planted.settingsPath,
      "--allowedTools",
      "Agent,Read",
      "--strict-mcp-config",
      "--mcp-config",
      '{"mcpServers":{}}',
      "--",
      planted.parentPrompt,
    ];
    mkdirSync(options.configDir, { recursive: true });
    const env: NodeJS.ProcessEnv = { ...options.env, CLAUDE_CONFIG_DIR: options.configDir };
    const ran = run(bin, args, { ...options, env }, planted.workspace, undefined);
    writeFileSync(join(planted.workspace, "parent.stdout.jsonl"), ran.stdout);
    const project = join(options.configDir, "projects", claudeProjectSlug(planted.workspace));
    const parentSession = readIfPresent(join(project, `${options.sessionId}.jsonl`));
    const parentText = parentSession === null ? ran.stdout : `${ran.stdout}\n${parentSession}`;
    const spawn = extractClaudeLaunch(ran.stdout, parentSession);
    const child = findClaudeChild(options.configDir, planted.workspace, options.sessionId, parentText);
    const log = planted.preToolUseLogPath === null ? null : readIfPresent(planted.preToolUseLogPath);
    return {
      command: recordedCommand(bin, args, planted.parentPrompt),
      stdout: ran.stdout,
      stderr: ran.stderr,
      code: ran.code,
      timedOut: ran.timedOut,
      childTranscript: child,
      launchConfig: toLaunchConfig(spawn),
      preToolUseLog: log,
      childIds: spawn.childThreadIds,
      parentSessionId: options.sessionId,
    };
  }

  const args = [
    "exec",
    "--ignore-user-config",
    "--skip-git-repo-check",
    "--sandbox",
    "workspace-write",
    "--json",
    "-c",
    'approval_policy="never"',
    "-c",
    "features.multi_agent=true",
    "-C",
    planted.workspace,
    "-",
  ];
  const codexHome = join(options.configDir, "codex");
  mkdirSync(codexHome, { recursive: true });
  const env: NodeJS.ProcessEnv = { ...options.env, CODEX_HOME: codexHome };
  const ran = run(bin, args, { ...options, env }, planted.workspace, planted.parentPrompt);
  const child = findCodexChild(codexHome, ran.stdout);
  const spawn = extractCodexLaunch(codexHome, ran.stdout);
  return {
    command: recordedCommand(bin, args, planted.parentPrompt),
    stdout: ran.stdout,
    stderr: ran.stderr,
    code: ran.code,
    timedOut: ran.timedOut,
    childTranscript: child,
    launchConfig: toLaunchConfig(spawn),
    preToolUseLog: null,
    childIds: spawn.childThreadIds,
    parentSessionId: spawn.parentThreadId,
  };
}
