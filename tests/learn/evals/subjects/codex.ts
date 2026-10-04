/**
 * Codex through app-server stdio. Not a test file.
 *
 *   codex app-server --stdio --disable plugins --disable remote_plugin --disable apps
 *
 * The sandbox is `read-only` unless the request's case grant (`allowedTools`) names a mutating
 * tool, which makes it `workspace-write`.
 * Appended context goes in as `developer_instructions`, a developer message after the host's own
 * instructions; codex has no append-to-system-prompt flag. There is no turn cap flag, so
 * `maxTurns` is not passed. Isolation is a private CODEX_HOME and HOME: codex reads skills from
 * `$CODEX_HOME/skills` and `$HOME/.agents/skills`, AGENTS.md from `$CODEX_HOME`, and fetches
 * remote plugins into `$CODEX_HOME` unless the plugin features are off. The login in the copied
 * `auth.json` also carries the account's connected apps (GitHub, Vercel, Drive and the like) as
 * `codex_apps` tools unless the `apps` feature is off; on 2026-09-28 subjects searched them. The
 * bundle's skills are copied into the private `skills/`.
 * Authentication comes from that copied `auth.json`, not an environment credential, so
 * `OPENAI_API_KEY` is not declared and does not reach the subject. `CODEX_HOME` is admitted only
 * to locate the caller's file before the adapter replaces it with the scratch home.
 *
 * Codex has no Skill or Read tool: a skill is loaded by printing its SKILL.md through the shell.
 * Every shell call becomes a Bash event, and each file it prints also becomes a Read event, so
 * graders that look for a SKILL.md read score codex the way they score the other hosts.
 */
import { mkdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { privateHome } from "./home.ts";
import { readsOf, unwrap } from "./shell.ts";
import type { Isolation, SessionEvent, SessionRequest, SubjectAdapter, TokenUsage } from "./types.ts";

const MUTATING_GRANTS = new Set(["Bash", "Delete", "Edit", "NotebookEdit", "Write"]);
interface RpcMessage {
  id?: number;
  method?: string;
  type?: string;
  item?: Item;
  usage?: UsageLine;
  result?: {
    model?: string;
    thread?: { id?: string; sessionId?: string };
    turn?: { id?: string };
  };
  error?: unknown;
  params?: {
    item?: Item;
    tokenUsage?: { total?: UsageLine };
    threadId?: string;
    turnId?: string;
    turn?: { status?: string };
    fromModel?: string;
    toModel?: string;
  };
}

interface ClientRpcMessage {
  jsonrpc: "2.0";
  method: string;
  id?: number;
  params?: object;
}

function parseWireLine(text: string): RpcMessage | undefined {
  try {
    return JSON.parse(text) as RpcMessage;
  } catch {
    return undefined;
  }
}

export function codexThreadStart(req: SessionRequest, model: string | undefined) {
  return {
    model,
    cwd: req.cwd,
    ephemeral: true,
    approvalPolicy: "never",
    sandbox: req.allowedTools?.some((tool) => MUTATING_GRANTS.has(tool)) === true ? "workspace-write" : "read-only",
    developerInstructions: req.appendSystemPrompt,
  };
}

/**
 * Run one app-server turn and retain the host's JSON-RPC stream verbatim for parsing and receipts.
 * `handshakeOnly` stops after the `thread/start` response: no turn starts and no model is called.
 */
export async function runCodexAppServer(
  req: SessionRequest,
  model: string | undefined,
  options: { cwd: string; env: Record<string, string>; timeoutMs: number; handshakeOnly?: boolean },
  launch?: readonly string[],
): Promise<{ code: number; stdout: string; timedOut: boolean }> {
  const command = launch ?? codex.command(req, model);
  const [binary, ...args] = command;
  if (binary === undefined) throw new Error("codex app-server launch is empty");
  const child = spawn(binary, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const send = (message: ClientRpcMessage) => {
    child.stdin.write(`${JSON.stringify(message)}\n`);
  };
  let output = "";
  let stderr = "";
  let buffered = "";
  let threadId: string | undefined;
  let completed = false;
  let protocolFailed = false;
  let timedOut = false;
  const handle = (text: string) => {
    output += `${text}\n`;
    const message = parseWireLine(text);
    if (message === undefined) return;
    if (message.error !== undefined) {
      protocolFailed = true;
      child.kill();
      return;
    }
    if (message.id === 1) {
      send({ jsonrpc: "2.0", method: "initialized" });
      send({ jsonrpc: "2.0", id: 2, method: "thread/start", params: codexThreadStart(req, model) });
      return;
    }
    if (message.id === 2) {
      threadId = message.result?.thread?.id;
      if (threadId === undefined || message.result?.model === undefined) {
        protocolFailed = true;
        child.kill();
        return;
      }
      if (options.handshakeOnly === true) {
        completed = true;
        child.kill();
        return;
      }
      send({
        jsonrpc: "2.0",
        id: 3,
        method: "turn/start",
        params: { threadId, input: [{ type: "text", text: req.prompt, text_elements: [] }] },
      });
      return;
    }
    if (message.method !== undefined && message.id !== undefined) {
      protocolFailed = true;
      child.kill();
      return;
    }
    if (message.method === "turn/completed" && message.params?.threadId === threadId) {
      completed = message.params?.turn?.status === "completed";
      protocolFailed = !completed;
      child.kill();
    }
  };
  return await new Promise((resolveResult, reject) => {
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, options.timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.stdout.on("data", (chunk: string) => {
      buffered += chunk;
      for (;;) {
        const newline = buffered.indexOf("\n");
        if (newline < 0) break;
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        if (line !== "") handle(line);
      }
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (exitCode) => {
      clearTimeout(timer);
      if (buffered !== "") handle(buffered);
      resolveResult({
        code: completed && !protocolFailed && !timedOut ? 0 : exitCode || 1,
        stdout: stderr === "" ? output : `${output}${JSON.stringify({ type: "app-server-stderr", stderr })}\n`,
        timedOut,
      });
    });
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { clientInfo: { name: "agent-kit-eval", version: "1" }, capabilities: { experimentalApi: true } },
    });
  });
}

interface Item {
  id?: string;
  type?: string;
  text?: string;
  command?: string;
  changes?: Array<{ path?: string; kind?: string | { type?: string } }>;
  server?: string;
  tool?: string;
  arguments?: unknown;
  query?: string;
  aggregatedOutput?: string | null;
}

interface UsageLine {
  input_tokens?: number;
  inputTokens?: number;
  cached_input_tokens?: number;
  cachedInputTokens?: number;
  cache_write_input_tokens?: number;
  cacheWriteInputTokens?: number;
  output_tokens?: number;
  outputTokens?: number;
  reasoning_output_tokens?: number;
  reasoningOutputTokens?: number;
}

const CHANGE_TOOL: Record<string, string> = { add: "Write", update: "Edit", delete: "Delete" };
const tokenCount = (field: number | undefined): field is number => Number.isSafeInteger(field) && Number(field) >= 0;

function tokenUsage(value: UsageLine | undefined): TokenUsage | undefined {
  if (value === undefined) return undefined;
  const {
    input_tokens: snakeInputTokens,
    inputTokens: camelInputTokens,
    cached_input_tokens: snakeCachedInputTokens,
    cachedInputTokens: camelCachedInputTokens,
    cache_write_input_tokens: snakeCacheWriteInputTokens,
    cacheWriteInputTokens: camelCacheWriteInputTokens,
    output_tokens: snakeOutputTokens,
    outputTokens: camelOutputTokens,
    reasoning_output_tokens: snakeReasoningOutputTokens,
    reasoningOutputTokens: camelReasoningOutputTokens,
  } = value;
  const inputTokens = snakeInputTokens ?? camelInputTokens;
  const cachedInputTokens = snakeCachedInputTokens ?? camelCachedInputTokens;
  const cacheWriteInputTokens =
    snakeCacheWriteInputTokens === undefined
      ? camelCacheWriteInputTokens === undefined
        ? 0
        : camelCacheWriteInputTokens
      : snakeCacheWriteInputTokens;
  const outputTokens = snakeOutputTokens ?? camelOutputTokens;
  const reasoningOutputTokens =
    snakeReasoningOutputTokens === undefined
      ? camelReasoningOutputTokens === undefined
        ? 0
        : camelReasoningOutputTokens
      : snakeReasoningOutputTokens;
  if (
    !tokenCount(inputTokens) ||
    !tokenCount(cachedInputTokens) ||
    !tokenCount(cacheWriteInputTokens) ||
    !tokenCount(outputTokens) ||
    !tokenCount(reasoningOutputTokens)
  )
    return undefined;
  if (cachedInputTokens > inputTokens || cacheWriteInputTokens > inputTokens || reasoningOutputTokens > outputTokens)
    return undefined;
  return {
    inputTokens,
    cachedInputTokens,
    cacheWriteInputTokens,
    outputTokens,
    reasoningOutputTokens,
    totalTokens: inputTokens + outputTokens,
  };
}

function itemEvents(item: Item): SessionEvent[] {
  switch (item.type) {
    case "agent_message":
    case "agentMessage":
      return item.text !== undefined && item.text !== "" ? [{ kind: "message", text: item.text }] : [];
    case "command_execution":
    case "commandExecution": {
      const command = unwrap(item.command ?? "");
      const bash: SessionEvent = { kind: "tool", name: "Bash", raw: "command_execution", input: { command } };
      return [
        bash,
        ...readsOf(command).map((file_path): SessionEvent => ({
          kind: "tool",
          name: "Read",
          raw: "command_execution",
          input: { file_path, via: "shell" },
        })),
      ];
    }
    case "file_change":
    case "fileChange":
      return (item.changes ?? []).map((c) => {
        const change = typeof c.kind === "string" ? c.kind : c.kind?.type;
        return {
          kind: "tool",
          name: CHANGE_TOOL[change ?? ""] ?? "Edit",
          raw: "file_change",
          input: { file_path: c.path, change },
        };
      });
    case "mcp_tool_call":
    case "mcpToolCall":
      return [
        {
          kind: "tool",
          name: `mcp__${item.server}__${item.tool}`,
          raw: "mcp_tool_call",
          input: { arguments: item.arguments },
        },
      ];
    case "web_search":
    case "webSearch":
      return [{ kind: "tool", name: "WebSearch", raw: "web_search", input: { query: item.query } }];
    default:
      return [];
  }
}

export const codex: SubjectAdapter = {
  host: "codex",
  env: ["CODEX_HOME"],
  injection: "developer-instructions",
  requestIds: false,
  command(_req: SessionRequest, _model: string | undefined): string[] {
    return [
      "codex",
      "app-server",
      "--stdio",
      "--disable",
      "plugins",
      "--disable",
      "remote_plugin",
      "--disable",
      "apps",
    ];
  },
  run: runCodexAppServer,
  parse(stdout: string) {
    const events: SessionEvent[] = [];
    const started = new Map<string, Item>();
    const done = new Set<string>();
    let reply = "";
    let usage: TokenUsage | undefined;
    let servedModel: string | undefined;
    let sessionId: string | undefined;
    for (const raw of stdout.split("\n")) {
      const line = parseWireLine(raw);
      if (line === undefined) continue;
      if (line.result?.model !== undefined) servedModel = line.result.model;
      if (line.method === "model/rerouted" && line.params?.toModel !== undefined) servedModel = line.params.toModel;
      const reportedSession = line.result?.thread?.sessionId ?? line.result?.thread?.id;
      if (reportedSession !== undefined) sessionId = reportedSession;
      if (line.type === "turn.completed" || line.method === "thread/tokenUsage/updated") {
        const completedUsage = tokenUsage(line.usage ?? line.params?.tokenUsage?.total);
        if (completedUsage !== undefined) usage = completedUsage;
      }
      const item = line.item ?? line.params?.item;
      if (item === undefined) continue;
      const startedItem = line.type === "item.started" || line.method === "item/started";
      const completedItem = line.type === "item.completed" || line.method === "item/completed";
      if (startedItem && item.id !== undefined) started.set(item.id, item);
      if (!completedItem) continue;
      if (item.id !== undefined) done.add(item.id);
      events.push(...itemEvents(item));
      if ((item.type === "agent_message" || item.type === "agentMessage") && typeof item.text === "string")
        reply = item.text.trim();
    }
    // A command still running when the session ended (a timeout) was still called.
    for (const [id, item] of started) if (!done.has(id)) events.push(...itemEvents(item));
    const parsed: ReturnType<SubjectAdapter["parse"]> = { events, reply };
    if (usage !== undefined) parsed.usage = usage;
    if (servedModel !== undefined) {
      parsed.model = servedModel;
      parsed.servedModel = servedModel;
    }
    if (sessionId !== undefined) parsed.sessionId = sessionId;
    return parsed;
  },
  isolate(scratch: string, req: SessionRequest): Isolation {
    const callerHome = req.env.CODEX_HOME ?? join(req.env.HOME ?? homedir(), ".codex");
    const home = privateHome(
      join(scratch, "codex-home"),
      join(callerHome, "auth.json"),
      req.bundleDir === undefined ? undefined : join(req.bundleDir, "skills"),
      "skills",
    );
    mkdirSync(join(scratch, "home"), { recursive: true });
    return {
      env: { CODEX_HOME: home.dir, HOME: join(scratch, "home") },
      leaks: ["the host's built-in system skills"],
      release: () => home.release(),
    };
  },
};
