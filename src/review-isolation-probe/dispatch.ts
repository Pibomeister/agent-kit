/**
 * Live host invocation for one arm. Tests stub the binaries on PATH; the
 * fixture driver never calls this.
 *
 * Launch configuration is parsed from the host's own output. resume / fork_*
 * are never self-authored.
 */
import { spawnSync } from "node:child_process";
import { accessSync, constants, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  extractClaudeLaunch,
  extractCodexLaunch,
  findClaudeChild,
  findCodexChild,
  toLaunchConfig,
} from "./children.ts";
import { claudeProjectSlug, profileFor } from "./hosts.ts";
import type { PlantedArm } from "./plant.ts";
import type { ProbeHost } from "./types.ts";

export { findClaudeChild, findCodexChild, extractSpawn, extractClaudeLaunch, extractCodexLaunch } from "./children.ts";

export interface DispatchResult {
  command: string[];
  stdout: string;
  stderr: string;
  code: number;
  timedOut: boolean;
  childTranscript: string | null;
  launchConfig: string;
  preToolUseLog: string | null;
}

export interface DispatchOptions {
  timeoutMs: number;
  env: NodeJS.ProcessEnv;
  configDir: string;
  sessionId: string;
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
  const timedOut = result.error !== undefined && result.error.message.includes("ETIMEDOUT");
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? result.error?.message ?? "",
    code: result.status ?? 1,
    timedOut,
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
  const bin = which(profile.binaries, env.PATH);
  if (bin === null) return "not on PATH";
  const result = spawnSync(bin, [...profile.versionArgs], {
    encoding: "utf8",
    timeout: 5_000,
    killSignal: "SIGKILL",
    env,
  });
  const text = (result.stdout ?? "").trim() || (result.stderr ?? "").trim();
  return text === "" ? `${bin} (no version output)` : (text.split("\n")[0] ?? text);
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
    const child = findClaudeChild(options.configDir, planted.workspace, options.sessionId);
    writeFileSync(join(planted.workspace, "parent.stdout.jsonl"), ran.stdout);
    const project = join(options.configDir, "projects", claudeProjectSlug(planted.workspace));
    const parentSession = readIfPresent(join(project, `${options.sessionId}.jsonl`));
    const spawn = extractClaudeLaunch(ran.stdout, parentSession);
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
  };
}
