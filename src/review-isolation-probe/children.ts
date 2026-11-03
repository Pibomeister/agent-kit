/**
 * Host-observed child transcripts and spawn arguments.
 *
 * Freshness and the child session come from the host's own output: Claude's
 * Agent/Task tool_use in the parent stream, Codex spawn_agent / SubAgentActivity
 * started events. Self-authored resume/fork fields are not evidence.
 *
 * Adapted from EGM tests/integration/test_claude.py and test_codex.py at
 * elephant-goldfish-model@403d8881d62022490637d740657b33f01e321ea8.
 */
import { readdirSync, readFileSync, type Dirent } from "node:fs";
import { basename, join } from "node:path";
import Ajv2020, { type ValidateFunction } from "ajv/dist/2020.js";

import { claudeProjectSlug } from "./hosts.ts";

interface LooseObject {
  type?: string;
  subtype?: string;
  name?: string;
  thread_id?: string;
  agent_thread_id?: string;
  kind?: string;
  resume?: boolean | string;
  fork_context?: boolean;
  fork_turns?: string;
  fork?: boolean;
  prompt?: string;
  arguments?: string;
  id?: string;
  tool_use_id?: string;
  agent_id?: string;
  agentId?: string;
  text?: string;
  input?: LooseObject;
  message?: LooseObject;
  payload?: LooseObject;
  item?: LooseObject;
  content?: string | LooseObject[];
}

const ajv = new Ajv2020({ strict: false });
const looseObject: ValidateFunction<LooseObject> = ajv.compile({
  type: "object",
  additionalProperties: true,
  properties: {
    type: { type: "string" },
    subtype: { type: "string" },
    name: { type: "string" },
    thread_id: { type: "string" },
    agent_thread_id: { type: "string" },
    kind: { type: "string" },
    fork_turns: { type: "string" },
    prompt: { type: "string" },
    arguments: { type: "string" },
    id: { type: "string" },
    tool_use_id: { type: "string" },
    agent_id: { type: "string" },
    agentId: { type: "string" },
    text: { type: "string" },
  },
});
const isText: ValidateFunction<string> = ajv.compile({ type: "string" });
const isResumeString: ValidateFunction<string> = ajv.compile({ type: "string" });
const isResumeBool: ValidateFunction<boolean> = ajv.compile({ type: "boolean" });

export interface ObservedSpawn {
  childPrompt: string | null;
  /** True when the host spawn is a resume. */
  resume: boolean | null;
  fork_context: boolean | null;
  fork_turns: string | null;
  parentThreadId: string | null;
  childThreadIds: string[];
  /** Agent/Task tool_use ids, used to join Claude tool_result agent ids. */
  spawnToolIds: string[];
  /** True when an Agent / Task / spawn_agent tool_use was present. */
  observed: boolean;
}

export function emptySpawn(): ObservedSpawn {
  return {
    childPrompt: null,
    resume: null,
    fork_context: null,
    fork_turns: null,
    parentThreadId: null,
    childThreadIds: [],
    spawnToolIds: [],
    observed: false,
  };
}

/**
 * Fresh when the host spawn was observed and is not a resume or fork; otherwise
 * unobservable. On Claude Code this is only the absence of resume/fork in the
 * Agent input, not a positive attestation.
 */
export function freshnessOf(spawn: ObservedSpawn): boolean | null {
  if (!spawn.observed) return null;
  if (spawn.resume === true) return false;
  if (spawn.fork_context === true) return false;
  if (spawn.fork_turns !== null && spawn.fork_turns !== "none") return false;
  return true;
}

interface HostLaunchBody {
  source: string;
  childPrompt?: string;
  resume?: boolean;
  fork_context?: boolean;
  fork_turns?: string;
}

export function toLaunchConfig(spawn: ObservedSpawn): string {
  if (!spawn.observed) return `${JSON.stringify({ source: "absent" }, null, 2)}\n`;
  const body: HostLaunchBody = { source: "host-spawn" };
  if (spawn.childPrompt !== null) body.childPrompt = spawn.childPrompt;
  if (spawn.resume !== null) body.resume = spawn.resume;
  if (spawn.fork_context !== null) body.fork_context = spawn.fork_context;
  if (spawn.fork_turns !== null) body.fork_turns = spawn.fork_turns;
  return `${JSON.stringify(body, null, 2)}\n`;
}

function parseLine(line: string): LooseObject | null {
  try {
    // SAFETY: JSON.parse is any; looseObject is the contract before use.
    const value = JSON.parse(line) as unknown;
    return looseObject(value) ? value : null;
  } catch {
    return null;
  }
}

function parseArgs(text: string | undefined): LooseObject | null {
  if (text === undefined || text === "") return null;
  try {
    // SAFETY: JSON.parse is any; looseObject is the contract before use.
    const value = JSON.parse(text) as unknown;
    return looseObject(value) ? value : null;
  } catch {
    return null;
  }
}

function claudeSpawnName(name: string): boolean {
  return name === "Agent" || name === "Task";
}

function spawnName(name: string): boolean {
  if (claudeSpawnName(name) || name === "spawn_agent") return true;
  const parts = name.split("__");
  const last = parts[parts.length - 1];
  return last === "spawn_agent";
}

function isResume(value: boolean | string | undefined): boolean | null {
  if (isResumeBool(value)) return value;
  if (isResumeString(value)) return value !== "";
  return null;
}

function pushId(list: string[], value: string | undefined, exclude: string | null): void {
  if (value === undefined || value === "") return;
  if (exclude !== null && value === exclude) return;
  if (!list.includes(value)) list.push(value);
}

function applyInput(spawn: ObservedSpawn, body: LooseObject): void {
  spawn.observed = true;
  if (body.prompt !== undefined) spawn.childPrompt = body.prompt;
  const resume = isResume(body.resume);
  if (resume !== null) spawn.resume = resume;
  if (body.fork === true) spawn.fork_context = true;
  if (body.fork_context === true) spawn.fork_context = true;
  if (body.fork_context === false) spawn.fork_context = spawn.fork_context ?? false;
  if (body.fork_turns !== undefined) spawn.fork_turns = body.fork_turns;
  pushId(spawn.childThreadIds, body.agent_id ?? body.agentId, spawn.parentThreadId);
}

function pushClaudeAgent(spawn: ObservedSpawn, part: LooseObject): void {
  pushId(spawn.spawnToolIds, part.id, null);
  pushId(spawn.childThreadIds, part.id, spawn.parentThreadId);
  pushId(spawn.childThreadIds, part.agent_id ?? part.agentId, spawn.parentThreadId);
  if (part.input !== undefined) applyInput(spawn, part.input);
  else spawn.observed = true;
}

function idsFromContent(spawn: ObservedSpawn, content: string | LooseObject[] | undefined): void {
  if (content === undefined) return;
  if (isText(content)) {
    const parsed = parseArgs(content);
    if (parsed !== null) {
      pushId(spawn.childThreadIds, parsed.agent_id ?? parsed.agentId ?? parsed.id, spawn.parentThreadId);
    }
    return;
  }
  if (!Array.isArray(content)) return;
  for (const part of content) {
    pushId(spawn.childThreadIds, part.agent_id ?? part.agentId ?? part.id, spawn.parentThreadId);
    if (part.text !== undefined) idsFromContent(spawn, part.text);
  }
}

function scan(event: LooseObject, spawn: ObservedSpawn): void {
  if (event.type === "thread.started" && event.thread_id !== undefined && spawn.parentThreadId === null) {
    spawn.parentThreadId = event.thread_id;
  }
  const payload = event.payload;
  const item = event.item ?? payload?.item;
  if (item !== undefined && item.type === "SubAgentActivity" && item.kind === "started") {
    pushId(spawn.childThreadIds, item.agent_thread_id ?? item.thread_id, spawn.parentThreadId);
  }
  pushId(spawn.childThreadIds, event.agent_id ?? event.agentId, spawn.parentThreadId);
  const name = event.name ?? item?.name ?? payload?.name ?? "";
  if (spawnName(name)) {
    const body =
      event.input ??
      item?.input ??
      payload?.input ??
      parseArgs(event.arguments ?? item?.arguments ?? payload?.arguments);
    if (claudeSpawnName(name)) {
      pushClaudeAgent(spawn, { ...event, input: body ?? event.input });
    } else if (body !== null) applyInput(spawn, body);
    else spawn.observed = true;
  }
  const content = event.message?.content ?? event.content ?? payload?.content;
  if (Array.isArray(content)) {
    for (const part of content) {
      if (part.type === "tool_use" && spawnName(part.name ?? "")) {
        const body = part.input ?? parseArgs(part.arguments);
        if (claudeSpawnName(part.name ?? "")) {
          pushClaudeAgent(spawn, { ...part, input: body ?? part.input });
        } else if (body !== null) applyInput(spawn, body);
        else spawn.observed = true;
      }
      if (part.type === "tool_result") {
        const toolId = part.tool_use_id;
        if (toolId !== undefined && spawn.spawnToolIds.includes(toolId)) {
          pushId(spawn.childThreadIds, part.agent_id ?? part.agentId, spawn.parentThreadId);
          idsFromContent(spawn, part.content);
        }
      }
    }
  }
  if (payload !== undefined && payload !== event) scan(payload, spawn);
  if (item !== undefined && item !== event && item !== payload) scan(item, spawn);
}

export function extractSpawn(text: string): ObservedSpawn {
  const spawn = emptySpawn();
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const event = parseLine(line);
    if (event !== null) scan(event, spawn);
  }
  spawn.childThreadIds = spawn.childThreadIds.filter((id) => id !== spawn.parentThreadId);
  return spawn;
}

function readIfPresent(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function jsonlFiles(dir: string): string[] {
  try {
    const names = readdirSync(dir);
    const out: string[] = [];
    for (const name of names) {
      if (name.endsWith(".jsonl")) out.push(join(dir, name));
    }
    return out;
  } catch {
    return [];
  }
}

function pickJsonl(candidates: string[], ids: readonly string[]): string | null {
  if (candidates.length === 0) return null;
  const matched: string[] = [];
  for (const path of candidates) {
    const name = basename(path);
    for (const id of ids) {
      if (id !== "" && name.includes(id) && !matched.includes(path)) matched.push(path);
    }
  }
  const onlyMatch = matched[0];
  if (matched.length === 1 && onlyMatch !== undefined) return onlyMatch;
  if (matched.length > 1) return null;
  const onlyCandidate = candidates[0];
  if (candidates.length === 1 && onlyCandidate !== undefined) return onlyCandidate;
  return null;
}

/**
 * Child jsonl under the session's subagents directory only, joined on the Agent/Task
 * id in the parent stream. Never the parent session file. Null when join is
 * ambiguous (more than one candidate and no unique id match).
 */
export function findClaudeChild(
  configDir: string,
  workspace: string,
  sessionId: string,
  parentText = "",
): string | null {
  const project = join(configDir, "projects", claudeProjectSlug(workspace));
  const candidates = [...jsonlFiles(join(project, sessionId, "subagents")), ...jsonlFiles(join(project, "subagents"))];
  const ids = extractSpawn(parentText).childThreadIds;
  const picked = pickJsonl(candidates, ids);
  return picked === null ? null : readIfPresent(picked);
}

function jsonlNameMatches(name: string, id: string): boolean {
  if (id === "") return false;
  return name === `${id}.jsonl` || name.endsWith(`-${id}.jsonl`);
}

function sessionJsonlPaths(codexHome: string): string[] {
  const stack = [join(codexHome, "sessions")];
  const out: string[] = [];
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
      if (entry.name.endsWith(".jsonl")) out.push(path);
    }
  }
  return out;
}

function uniqueJsonl(paths: readonly string[], ids: readonly string[]): string | null {
  const matched: string[] = [];
  for (const path of paths) {
    const name = basename(path);
    for (const id of ids) {
      if (jsonlNameMatches(name, id) && !matched.includes(path)) matched.push(path);
    }
  }
  const only = matched[0];
  if (matched.length === 1 && only !== undefined) return only;
  return null;
}

function jsonlMatching(codexHome: string, threadId: string): string | null {
  const picked = uniqueJsonl(sessionJsonlPaths(codexHome), [threadId]);
  return picked === null ? null : readIfPresent(picked);
}

/**
 * Child session joined from SubAgentActivity started / spawn_agent, never the
 * parent thread.started id. Null when no child thread id is observed, or when
 * more than one distinct child id is observed and none joins uniquely.
 */
export function findCodexChild(codexHome: string, stdout: string): string | null {
  const fromStdout = extractSpawn(stdout);
  let parentText = stdout;
  if (fromStdout.parentThreadId !== null) {
    const parentFile = jsonlMatching(codexHome, fromStdout.parentThreadId);
    if (parentFile !== null) parentText = `${stdout}\n${parentFile}`;
  }
  const spawn = extractSpawn(parentText);
  const ids = spawn.childThreadIds.filter((id) => id !== "" && id !== spawn.parentThreadId);
  if (ids.length === 0) return null;
  const picked = uniqueJsonl(sessionJsonlPaths(codexHome), ids);
  return picked === null ? null : readIfPresent(picked);
}

export function extractClaudeLaunch(parentStdout: string, parentSession: string | null): ObservedSpawn {
  return extractSpawn(parentSession === null ? parentStdout : `${parentStdout}\n${parentSession}`);
}

export function extractCodexLaunch(codexHome: string, stdout: string): ObservedSpawn {
  const fromStdout = extractSpawn(stdout);
  if (fromStdout.parentThreadId === null) return fromStdout;
  const parentFile = jsonlMatching(codexHome, fromStdout.parentThreadId);
  if (parentFile === null) return fromStdout;
  return extractSpawn(`${stdout}\n${parentFile}`);
}
