/**
 * Read a child transcript and launch configuration into ArmEvidence.
 *
 * The child's answer is split out when the host's event shape is known, so a
 * verdict can ignore it. An unparsed blob is not partitioned: a marker in it
 * cannot be blamed on context, and cannot be called a pass either.
 */
import Ajv2020, { type ValidateFunction } from "ajv/dist/2020.js";

import type { ArmEvidence, ToolTouch } from "./types.ts";

interface LooseObject {
  type?: string;
  subtype?: string;
  name?: string;
  thread_id?: string;
  message?: LooseObject;
  payload?: LooseObject;
  item?: LooseObject;
  content?: string | LooseObject[];
  input?: LooseObject;
  arguments?: string;
  id?: string;
  is_error?: boolean;
  tool_use_id?: string;
  file_path?: string;
  path?: string;
  resume?: boolean;
  fork_context?: boolean;
  fork_turns?: string;
  prompt?: string;
  memory_paths?: string[];
  plugins?: string[];
  skills?: string[];
  agents?: string[];
  mcp_servers?: string[];
  last_agent_message?: string;
  status?: string;
  exit_code?: number;
  aggregated_output?: string;
  parsed_cmd?: LooseObject[];
  kind?: string;
  agent_thread_id?: string;
  cwd?: string;
  text?: string;
  role?: string;
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
    arguments: { type: "string" },
    id: { type: "string" },
    is_error: { type: "boolean" },
    tool_use_id: { type: "string" },
    file_path: { type: "string" },
    path: { type: "string" },
    resume: { type: "boolean" },
    fork_context: { type: "boolean" },
    fork_turns: { type: "string" },
    prompt: { type: "string" },
    last_agent_message: { type: "string" },
    status: { type: "string" },
    exit_code: { type: "number" },
    aggregated_output: { type: "string" },
    kind: { type: "string" },
    agent_thread_id: { type: "string" },
    cwd: { type: "string" },
    role: { type: "string" },
  },
});

const isString: ValidateFunction<string> = ajv.compile({ type: "string", minLength: 1 });

interface LaunchConfig {
  prompt?: string;
  childPrompt?: string;
  resume?: boolean;
  fork_context?: boolean;
  fork_turns?: string;
}

const isLaunchConfig: ValidateFunction<LaunchConfig> = ajv.compile({
  type: "object",
  additionalProperties: true,
  properties: {
    prompt: { type: "string" },
    childPrompt: { type: "string" },
    resume: { type: "boolean" },
    fork_context: { type: "boolean" },
    fork_turns: { type: "string" },
  },
});

function parseLine(line: string): LooseObject | null {
  try {
    // SAFETY: JSON.parse is any; looseObject is the contract before use.
    const value = JSON.parse(line) as unknown;
    return looseObject(value) ? value : null;
  } catch {
    return null;
  }
}

function collectText(event: LooseObject, into: string[]): void {
  const content = event.content ?? event.message?.content ?? event.payload?.content;
  if (Array.isArray(content)) {
    for (const part of content) {
      const kind = part.type;
      if ((kind === "text" || kind === "output_text" || kind === "input_text") && part.text !== undefined) {
        into.push(part.text);
      } else collectText(part, into);
    }
    return;
  }
  if (isString(content)) into.push(content);
}

function pushUnique(list: string[], value: string): void {
  if (value !== "" && !list.includes(value)) list.push(value);
}

function looksLikeInstruction(path: string): boolean {
  const base = path.replaceAll("\\", "/").split("/").pop() ?? path;
  return (
    base === "CLAUDE.md" ||
    base === "AGENTS.md" ||
    base === "MEMORY.md" ||
    (base.endsWith(".md") && (path.includes("memory") || path.includes("instructions")))
  );
}

function recordLoaded(event: LooseObject, loaded: string[]): void {
  const paths = event.memory_paths;
  if (paths !== undefined) {
    for (const path of paths) pushUnique(loaded, path);
  }
  const blob = JSON.stringify(event);
  for (const name of ["CLAUDE.md", "AGENTS.md", "MEMORY.md"]) {
    if (blob.includes(name)) pushUnique(loaded, name);
  }
}

function spawnFresh(event: LooseObject, current: boolean | null): boolean | null {
  const name = event.name ?? "";
  const isAgent = name === "Agent" || name.endsWith("spawn_agent") || name === "spawn_agent";
  const input = event.input;
  const argsText = event.arguments;
  let body: LooseObject | null = input ?? null;
  if (body === null && argsText !== undefined) {
    try {
      // SAFETY: JSON.parse is any; looseObject is the contract before use.
      const parsed = JSON.parse(argsText) as unknown;
      body = looseObject(parsed) ? parsed : null;
    } catch {
      body = null;
    }
  }
  if (!isAgent && body === null) return current;
  const resume = body?.resume === true;
  const forkTurns = body?.fork_turns;
  const forkContext = body?.fork_context;
  const forked = forkContext === true || (forkTurns !== undefined && forkTurns !== "none");
  if (isAgent || body !== null) return !resume && !forked;
  return current;
}

function collectTouches(event: LooseObject, touches: ToolTouch[]): void {
  const content = event.message?.content ?? event.content;
  if (Array.isArray(content)) {
    for (const part of content) {
      if (part.type === "tool_use") {
        const path = part.input?.file_path ?? part.input?.path;
        if (path !== undefined) touches.push({ path, denied: false, succeeded: false });
      }
      if (part.type === "tool_result") {
        const path = part.file_path ?? part.path;
        const denied = part.is_error === true;
        const succeeded = part.is_error !== true;
        if (path !== undefined) touches.push({ path, denied, succeeded });
        else if (touches.length > 0 && part.tool_use_id !== undefined) {
          const last = touches[touches.length - 1];
          if (last !== undefined) {
            last.denied = denied;
            last.succeeded = succeeded && !denied;
          }
        }
      }
    }
  }
  const item = event.item ?? event.payload?.item;
  if (item !== undefined && item.type === "CommandExecution") {
    const output = item.aggregated_output ?? "";
    const failed = item.status === "failed" || (item.exit_code !== undefined && item.exit_code !== 0);
    const cmds = item.parsed_cmd;
    if (cmds !== undefined) {
      for (const cmd of cmds) {
        if (cmd.type === "read" && cmd.path !== undefined) {
          touches.push({ path: cmd.path, denied: failed, succeeded: !failed && output !== "" });
        }
      }
    }
  }
}

function childPromptOf(event: LooseObject): string | null {
  const input = event.input;
  if (input?.prompt !== undefined) return input.prompt;
  if (event.arguments !== undefined) {
    try {
      // SAFETY: JSON.parse is any; looseObject is the contract before use.
      const parsed = JSON.parse(event.arguments) as unknown;
      if (looseObject(parsed) && parsed.prompt !== undefined) return parsed.prompt;
    } catch {
      return null;
    }
  }
  return null;
}

interface ChildFacingLaunch {
  childPrompt: string | null;
  resume?: boolean;
  fork_context?: boolean;
  fork_turns?: string;
}

interface LaunchFresh {
  fresh: boolean | null;
  prompt: string | null;
  text: string;
  parsed: boolean;
}

function childFacingPrompt(value: LaunchConfig): string | null {
  if (value.childPrompt !== undefined) return value.childPrompt;
  return value.prompt ?? null;
}

function launchFresh(launch: string): LaunchFresh {
  try {
    // SAFETY: JSON.parse is any; isLaunchConfig is the contract before use.
    const value = JSON.parse(launch) as unknown;
    if (!isLaunchConfig(value)) return { fresh: null, prompt: null, text: launch, parsed: false };
    const resume = value.resume === true;
    const forked = value.fork_context === true || (value.fork_turns !== undefined && value.fork_turns !== "none");
    const named = value.resume !== undefined || value.fork_context !== undefined || value.fork_turns !== undefined;
    const childPrompt = childFacingPrompt(value);
    const facing: ChildFacingLaunch = {
      childPrompt,
      resume: value.resume,
      fork_context: value.fork_context,
      fork_turns: value.fork_turns,
    };
    return {
      fresh: named ? !resume && !forked : null,
      prompt: childPrompt,
      text: JSON.stringify(facing),
      parsed: true,
    };
  } catch {
    return { fresh: null, prompt: null, text: launch, parsed: false };
  }
}

/** Parse the child's transcript and launch configuration. Empty inputs are valid: they mean "not observed". */
export function readEvidence(transcript: string | null, launchConfig: string | null): ArmEvidence {
  const wholeParts: string[] = [];
  const context: string[] = [];
  const answers: string[] = [];
  const loaded: string[] = [];
  const touches: ToolTouch[] = [];
  let parsed = 0;
  let unparsed = 0;
  let fresh: boolean | null = null;
  let childPrompt: string | null = null;

  if (transcript !== null && transcript !== "") {
    wholeParts.push(transcript);
    for (const line of transcript.split("\n")) {
      if (line.trim() === "") continue;
      const event = parseLine(line);
      if (event === null) {
        // Keep the blob in wholeText only. An unparsed line cannot be blamed on
        // context rather than the answer, so it must not join contextText.
        unparsed += 1;
        continue;
      }
      parsed += 1;
      const type = event.type ?? "";
      const subtype = event.subtype;
      const payload = event.payload;
      const payloadType = payload?.type;
      const payloadRole = payload?.role;
      if (type === "system" && subtype === "init") {
        context.push(line);
        recordLoaded(event, loaded);
        continue;
      }
      const assistantMessage = type === "assistant" || (payloadType === "message" && payloadRole === "assistant");
      if (assistantMessage) {
        const bits: string[] = [];
        collectText(event, bits);
        for (const bit of bits) answers.push(bit);
        collectTouches(event, touches);
        fresh = spawnFresh(event, fresh);
        const prompt = childPromptOf(event);
        if (prompt !== null) childPrompt = prompt;
        // Tool uses are context (what the child was allowed to do), not its answer.
        const content = event.message?.content ?? event.content;
        if (Array.isArray(content)) {
          for (const part of content) {
            if (looseObject(part) && part.type === "tool_use") context.push(JSON.stringify(part));
          }
        }
        continue;
      }
      if (payloadType === "task_complete") {
        const last = payload?.last_agent_message;
        if (last !== undefined) answers.push(last);
        continue;
      }
      collectTouches(event, touches);
      fresh = spawnFresh(event, fresh);
      const prompt = childPromptOf(event);
      if (prompt !== null) childPrompt = prompt;
      if (payload !== undefined) {
        const item = payload.item;
        if (item?.type === "SubAgentActivity") {
          if (item.kind === "started") fresh = fresh ?? true;
        }
      }
      context.push(line);
      recordLoaded(event, loaded);
    }
  }

  let launchFreshness: boolean | null = null;
  if (launchConfig !== null && launchConfig !== "") {
    const decoded = launchFresh(launchConfig);
    wholeParts.push(decoded.parsed ? decoded.text : launchConfig);
    if (decoded.parsed) {
      context.push(decoded.text);
      launchFreshness = decoded.fresh;
      if (decoded.prompt !== null) childPrompt = childPrompt ?? decoded.prompt;
      for (const name of ["CLAUDE.md", "AGENTS.md", "MEMORY.md"]) {
        if (decoded.text.includes(name)) pushUnique(loaded, name);
      }
    } else {
      unparsed += 1;
    }
  }

  for (const touch of touches) {
    if (looksLikeInstruction(touch.path) && touch.succeeded) pushUnique(loaded, touch.path);
  }

  const partitioned = parsed > 0 && unparsed === 0;
  return {
    transcriptPresent: transcript !== null && transcript !== "",
    launchPresent: launchConfig !== null && launchConfig !== "",
    partitioned,
    contextText: context.join("\n"),
    answerText: answers.join("\n"),
    wholeText: wholeParts.join("\n"),
    loadedFiles: loaded,
    toolTouches: touches,
    freshSubagent: launchFreshness ?? fresh,
    childPrompt,
  };
}
