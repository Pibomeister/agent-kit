/**
 * Codex in exec mode. Not a test file.
 *
 *   codex exec --json --ephemeral --skip-git-repo-check --ignore-rules --sandbox read-only
 *     --disable plugins --disable remote_plugin --disable apps [-m M] [-c developer_instructions=TEXT] PROMPT
 *
 * Appended context goes in as `developer_instructions`, a developer message after the host's own
 * instructions; codex has no append-to-system-prompt flag. There is no turn cap flag, so
 * `maxTurns` is not passed. Isolation is a private CODEX_HOME and HOME: codex reads skills from
 * `$CODEX_HOME/skills` and `$HOME/.agents/skills`, AGENTS.md from `$CODEX_HOME`, and fetches
 * remote plugins into `$CODEX_HOME` unless the plugin features are off. The login in the copied
 * `auth.json` also carries the account's connected apps (GitHub, Vercel, Drive and the like) as
 * `codex_apps` tools unless the `apps` feature is off; on 2026-09-28 subjects searched them. The
 * bundle's skills are copied into the private `skills/`.
 *
 * Codex has no Skill or Read tool: a skill is loaded by printing its SKILL.md through the shell.
 * Every shell call becomes a Bash event, and each file it prints also becomes a Read event, so
 * graders that look for a SKILL.md read score codex the way they score the other hosts.
 */
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { privateHome } from "./home.ts";
import { readsOf, unwrap } from "./shell.ts";
import type { Isolation, SessionEvent, SessionRequest, SubjectAdapter, TokenUsage } from "./types.ts";

interface Item {
  id?: string;
  type?: string;
  text?: string;
  command?: string;
  changes?: Array<{ path?: string; kind?: string }>;
  server?: string;
  tool?: string;
  arguments?: unknown;
  query?: string;
}

interface Line {
  type?: string;
  item?: Item;
  usage?: UsageLine;
}

interface UsageLine {
  input_tokens?: number;
  cached_input_tokens?: number;
  cache_write_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
}

const CHANGE_TOOL: Record<string, string> = { add: "Write", update: "Edit", delete: "Delete" };
const tokenCount = (field: number | undefined): field is number => Number.isSafeInteger(field) && Number(field) >= 0;

function tokenUsage(value: UsageLine | undefined): TokenUsage | undefined {
  if (value === undefined) return undefined;
  const {
    input_tokens: inputTokens,
    cached_input_tokens: cachedInputTokens,
    cache_write_input_tokens: cacheWriteInputTokens = 0,
    output_tokens: outputTokens,
    reasoning_output_tokens: reasoningOutputTokens = 0,
  } = value;
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
      return typeof item.text === "string" && item.text !== "" ? [{ kind: "message", text: item.text }] : [];
    case "command_execution": {
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
      return (item.changes ?? []).map((c) => ({
        kind: "tool",
        name: CHANGE_TOOL[c.kind ?? ""] ?? "Edit",
        raw: "file_change",
        input: { file_path: c.path, change: c.kind },
      }));
    case "mcp_tool_call":
      return [
        {
          kind: "tool",
          name: `mcp__${item.server}__${item.tool}`,
          raw: "mcp_tool_call",
          input: { arguments: item.arguments },
        },
      ];
    case "web_search":
      return [{ kind: "tool", name: "WebSearch", raw: "web_search", input: { query: item.query } }];
    default:
      return [];
  }
}

export const codex: SubjectAdapter = {
  host: "codex",
  injection: "developer-instructions",
  command(req: SessionRequest, model: string | undefined): string[] {
    return [
      "codex",
      "exec",
      "--json",
      "--ephemeral",
      "--skip-git-repo-check",
      "--ignore-rules",
      "--sandbox",
      "read-only",
      "--disable",
      "plugins",
      "--disable",
      "remote_plugin",
      "--disable",
      "apps",
      ...(model === undefined ? [] : ["-m", model]),
      // A JSON string is a valid TOML basic string, which is how `-c` parses the value.
      ...(req.appendSystemPrompt === undefined
        ? []
        : ["-c", `developer_instructions=${JSON.stringify(req.appendSystemPrompt)}`]),
      req.prompt,
    ];
  },
  parse(stdout: string) {
    const events: SessionEvent[] = [];
    const started = new Map<string, Item>();
    const done = new Set<string>();
    let reply = "";
    let usage: TokenUsage | undefined;
    for (const raw of stdout.split("\n")) {
      let line: Line;
      try {
        line = JSON.parse(raw) as Line;
      } catch {
        continue;
      }
      if (line.type === "turn.completed") {
        const completedUsage = tokenUsage(line.usage);
        if (completedUsage !== undefined) usage = completedUsage;
      }
      const item = line.item;
      if (item === undefined) continue;
      if (line.type === "item.started" && item.id !== undefined) started.set(item.id, item);
      if (line.type !== "item.completed") continue;
      if (item.id !== undefined) done.add(item.id);
      events.push(...itemEvents(item));
      if (item.type === "agent_message" && typeof item.text === "string") reply = item.text.trim();
    }
    // A command still running when the session ended (a timeout) was still called.
    for (const [id, item] of started) if (!done.has(id)) events.push(...itemEvents(item));
    return usage === undefined ? { events, reply } : { events, reply, usage };
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
