/**
 * Live host invocation for one arm. Tests stub the binaries on PATH; the
 * fixture driver never calls this.
 */
import { spawnSync } from "node:child_process";
import { accessSync, constants, mkdirSync, readdirSync, readFileSync, writeFileSync, type Dirent } from "node:fs";
import { join } from "node:path";
import Ajv2020, { type ValidateFunction } from "ajv/dist/2020.js";

import { claudeProjectSlug, profileFor } from "./hosts.ts";
import type { PlantedArm } from "./plant.ts";
import type { ProbeHost } from "./types.ts";

const ajv = new Ajv2020({ strict: false });
const threadEvent: ValidateFunction<{ thread_id?: string }> = ajv.compile({
  type: "object",
  additionalProperties: true,
  properties: { thread_id: { type: "string", minLength: 1 } },
});

export interface DispatchResult {
  command: string[];
  stdout: string;
  stderr: string;
  code: number;
  timedOut: boolean;
  childTranscript: string | null;
  launchConfig: string;
}

export interface DispatchOptions {
  timeoutMs: number;
  env: NodeJS.ProcessEnv;
  configDir: string;
  sessionId: string;
}

interface ChildLaunch {
  host: ProbeHost;
  command: string[];
  childPrompt: string;
  resume: boolean;
  fork_context: boolean;
  fork_turns: string;
  reason?: string;
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

function firstJsonl(dir: string): string | null {
  try {
    const names = readdirSync(dir);
    for (const name of names) {
      if (name.endsWith(".jsonl")) return join(dir, name);
    }
    return null;
  } catch {
    return null;
  }
}

function findClaudeChild(configDir: string, workspace: string, sessionId: string): string | null {
  const project = join(configDir, "projects", claudeProjectSlug(workspace));
  const nested = firstJsonl(join(project, sessionId, "subagents"));
  if (nested !== null) return readIfPresent(nested);
  // Some host versions drop agent-*.jsonl directly under the project.
  const loose = firstJsonl(join(project, "subagents"));
  if (loose !== null) return readIfPresent(loose);
  return readIfPresent(join(project, `${sessionId}.jsonl`));
}

function findCodexChild(codexHome: string, stdout: string): string | null {
  let thread: string | null = null;
  for (const line of stdout.split("\n")) {
    if (!line.includes("thread_id")) continue;
    try {
      const value: unknown = JSON.parse(line);
      if (threadEvent(value) && value.thread_id !== undefined) thread = value.thread_id;
    } catch {
      continue;
    }
  }
  const stack = [join(codexHome, "sessions")];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (dir === undefined) break;
    let entries: Dirent[] = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(path);
        continue;
      }
      if (entry.name.endsWith(".jsonl") && (thread === null || entry.name.includes(thread))) {
        const text = readIfPresent(path);
        if (text !== null) return text;
      }
    }
  }
  return null;
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

export function dispatchArm(host: ProbeHost, planted: PlantedArm, options: DispatchOptions): DispatchResult {
  const profile = profileFor(host);
  const bin = which(profile.binaries, options.env.PATH);
  const launch: ChildLaunch = {
    host,
    command: [],
    childPrompt: planted.childPrompt,
    resume: false,
    fork_context: false,
    fork_turns: "none",
  };
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
      launchConfig: JSON.stringify({ ...launch, reason }, null, 2),
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
    launch.command = [bin, ...args];
    mkdirSync(options.configDir, { recursive: true });
    const env: NodeJS.ProcessEnv = { ...options.env, CLAUDE_CONFIG_DIR: options.configDir };
    const ran = run(bin, args, { ...options, env }, planted.workspace, undefined);
    const child = findClaudeChild(options.configDir, planted.workspace, options.sessionId);
    writeFileSync(join(planted.workspace, "parent.stdout.jsonl"), ran.stdout);
    return {
      command: launch.command,
      stdout: ran.stdout,
      stderr: ran.stderr,
      code: ran.code,
      timedOut: ran.timedOut,
      childTranscript: child,
      launchConfig: JSON.stringify(launch, null, 2),
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
  launch.command = [bin, ...args];
  const codexHome = join(options.configDir, "codex");
  mkdirSync(codexHome, { recursive: true });
  const env: NodeJS.ProcessEnv = { ...options.env, CODEX_HOME: codexHome };
  const ran = run(bin, args, { ...options, env }, planted.workspace, planted.parentPrompt);
  const child = findCodexChild(codexHome, ran.stdout);
  return {
    command: launch.command,
    stdout: ran.stdout,
    stderr: ran.stderr,
    code: ran.code,
    timedOut: ran.timedOut,
    childTranscript: child,
    launchConfig: JSON.stringify(launch, null, 2),
  };
}
