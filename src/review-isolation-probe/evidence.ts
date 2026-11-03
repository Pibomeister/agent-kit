/**
 * Read a child transcript and launch configuration into ArmEvidence.
 *
 * The child's answer is split out when the host's event shape is known, so a
 * verdict can ignore it. An unparsed blob is not partitioned: a marker in it
 * cannot be blamed on context, and cannot be called a pass either.
 */
import Ajv2020, { type ValidateFunction } from "ajv/dist/2020.js";

import { extractSpawn, freshnessOf } from "./children.ts";
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
  agent_id?: string;
  agentId?: string;
  session_id?: string;
  transcript_path?: string;
  hook_event_name?: string;
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
    agent_id: { type: "string" },
    agentId: { type: "string" },
    session_id: { type: "string" },
    transcript_path: { type: "string" },
    hook_event_name: { type: "string" },
    cwd: { type: "string" },
    role: { type: "string" },
  },
});

const isString: ValidateFunction<string> = ajv.compile({ type: "string", minLength: 1 });

interface LaunchConfig {
  source?: string;
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
    source: { type: "string" },
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
  return value.childPrompt ?? null;
}

function launchFresh(launch: string): LaunchFresh {
  try {
    // SAFETY: JSON.parse is any; isLaunchConfig is the contract before use.
    const value = JSON.parse(launch) as unknown;
    if (!isLaunchConfig(value)) return { fresh: null, prompt: null, text: launch, parsed: false };
    const resume = value.resume === true;
    const forked = value.fork_context === true || (value.fork_turns !== undefined && value.fork_turns !== "none");
    const observed =
      value.source === "host-spawn" ||
      value.resume !== undefined ||
      value.fork_context !== undefined ||
      value.fork_turns !== undefined;
    const childPrompt = childFacingPrompt(value);
    const facing: ChildFacingLaunch = {
      childPrompt,
      resume: value.resume,
      fork_context: value.fork_context,
      fork_turns: value.fork_turns,
    };
    return {
      fresh: observed ? !resume && !forked : null,
      prompt: childPrompt,
      text: JSON.stringify(facing),
      parsed: true,
    };
  } catch {
    return { fresh: null, prompt: null, text: launch, parsed: false };
  }
}

export interface EvidenceExtras {
  preToolUseLog?: string | null;
  childIds?: readonly string[];
  parentSessionId?: string | null;
}

function childHookFired(log: string, childIds: readonly string[], parentSessionId: string | null): boolean {
  for (const line of log.split("\n")) {
    if (line.trim() === "") continue;
    const event = parseLine(line);
    if (event === null) continue;
    const agent = event.agent_id ?? event.agentId;
    if (agent === undefined || agent === "") continue;
    if (parentSessionId !== null && agent === parentSessionId) continue;
    if (childIds.length === 0 || childIds.includes(agent)) return true;
  }
  return false;
}

/** Parse the child's transcript and launch configuration. Empty inputs are valid: they mean "not observed". */
export function readEvidence(
  transcript: string | null,
  launchConfig: string | null,
  extras: EvidenceExtras = {},
): ArmEvidence {
  const wholeParts: string[] = [];
  const context: string[] = [];
  const answers: string[] = [];
  const loaded: string[] = [];
  const touches: ToolTouch[] = [];
  let parsed = 0;
  let unparsed = 0;
  let fresh: boolean | null = null;
  let childPrompt: string | null = null;
  let preToolUseFired: boolean | null = null;
  let finalAnswerText = "";

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
      if (line.includes("PreToolUse") || line.includes('"hookEventName"') || line.includes('"hook_event_name"')) {
        preToolUseFired = true;
      }
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
        if (bits.length > 0) {
          const text = bits.join("\n");
          answers.push(text);
          finalAnswerText = text;
        }
        collectTouches(event, touches);
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
        if (last !== undefined) {
          answers.push(last);
          finalAnswerText = last;
        }
        continue;
      }
      collectTouches(event, touches);
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

  if (transcript !== null && transcript !== "") {
    const fromHost = extractSpawn(transcript);
    const hostFresh = freshnessOf(fromHost);
    if (hostFresh === false) fresh = false;
    else if (fresh === null) fresh = hostFresh;
    if (fromHost.childPrompt !== null) childPrompt = childPrompt ?? fromHost.childPrompt;
  }

  const partitioned = parsed > 0 && unparsed === 0;
  let combinedFresh: boolean | null = null;
  if (launchFreshness === false || fresh === false) combinedFresh = false;
  else if (launchFreshness === true || fresh === true) combinedFresh = true;
  let hookFired = preToolUseFired;
  if (extras.preToolUseLog !== undefined && extras.preToolUseLog !== null && extras.preToolUseLog.trim() !== "") {
    const fromChild = childHookFired(extras.preToolUseLog, extras.childIds ?? [], extras.parentSessionId ?? null);
    if (fromChild) hookFired = true;
  }
  return {
    transcriptPresent: transcript !== null && transcript !== "",
    launchPresent: launchConfig !== null && launchConfig !== "",
    partitioned,
    contextText: context.join("\n"),
    answerText: answers.join("\n"),
    wholeText: wholeParts.join("\n"),
    loadedFiles: loaded,
    toolTouches: touches,
    freshSubagent: combinedFresh,
    childPrompt,
    preToolUseFired: hookFired,
    finalAnswerText,
  };
}
