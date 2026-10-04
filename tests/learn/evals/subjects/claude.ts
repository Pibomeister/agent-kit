/**
 * Claude Code in print mode. Its tool names are the shared vocabulary, so parsing only flattens
 * stream-json into events. Not a test file.
 *
 *   claude -p --output-format stream-json --verbose [--model M] [--max-turns N]
 *     --settings '{"disableAllHooks":true}' --setting-sources project,local --strict-mcp-config
 *     --no-session-persistence [--tools LIST --allowedTools LIST]
 *     [--plugin-dir BUNDLE] [--append-system-prompt TEXT] PROMPT
 *
 * A case grant (`allowedTools`) is passed as both `--tools` and `--allowedTools`; without one
 * neither flag is passed.
 *
 * Isolation is argv only. A scratch CLAUDE_CONFIG_DIR loses the keychain login unless an API key
 * is in the environment, so the session keeps the caller's config dir; `--setting-sources` without
 * `user` drops the caller's plugins, skills and hooks from it, and `--strict-mcp-config` their MCP
 * servers. A skill is installed with `--plugin-dir`, and a Skill call names it `<plugin>:<id>`.
 * `--setting-sources` does not keep out the caller's CLAUDE.md: from a cwd under $HOME the host
 * walks up to $HOME and reads ~/.claude/CLAUDE.md as an ancestor's project instructions, and
 * auto-memory names the caller's real memory dir. `CLAUDE_CODE_DISABLE_CLAUDE_MDS` (what
 * `claude plugin eval` sets for its own children) and `CLAUDE_CODE_DISABLE_AUTO_MEMORY` close
 * both; `--no-session-persistence` keeps the run out of the caller's transcript store.
 * Claude reads its login and provider credentials from the environment, so the adapter declares
 * only those inputs below. The region, profile and credential variables Bedrock and Vertex read
 * are declared only while the caller's matching `CLAUDE_CODE_USE_*` flag holds a value the host
 * reads as on (`1`, `true`, `yes`, `on`, in any case), so cloud credentials exported for other
 * work stay out; unrelated caller credentials are removed before the host starts.
 * research/evals/2026-09-25-isolation.md, "Direct `claude -p` subjects", has the measurements.
 */
import type { Isolation, SessionEvent, SessionRequest, SubjectAdapter } from "./types.ts";

interface Part {
  type?: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
}

interface Line {
  type?: string;
  subtype?: string;
  model?: string;
  request_id?: string;
  session_id?: string;
  slash_commands?: unknown;
  message?: { content?: Part[] | string; model?: string };
  result?: string;
  total_cost_usd?: number;
  num_turns?: number;
}

const BEDROCK_ENV = ["AWS_REGION", "AWS_PROFILE", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"];
const VERTEX_ENV = ["ANTHROPIC_VERTEX_PROJECT_ID", "CLOUD_ML_REGION", "GOOGLE_APPLICATION_CREDENTIALS"];
const TRUTHY = new Set(["1", "true", "yes", "on"]);
const flagged = (name: string) => TRUTHY.has((process.env[name] ?? "").trim().toLowerCase());

export const claude: SubjectAdapter = {
  host: "claude",
  get env() {
    return [
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "ANTHROPIC_BASE_URL",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "CLAUDE_CODE_USE_BEDROCK",
      ...(flagged("CLAUDE_CODE_USE_BEDROCK") ? BEDROCK_ENV : []),
      "CLAUDE_CODE_USE_VERTEX",
      ...(flagged("CLAUDE_CODE_USE_VERTEX") ? VERTEX_ENV : []),
      "CLAUDE_CONFIG_DIR",
    ];
  },
  injection: "append-system-prompt",
  requestIds: true,
  command(req: SessionRequest, model: string | undefined): string[] {
    return [
      "claude",
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      ...(model === undefined ? [] : ["--model", model]),
      ...(req.maxTurns === undefined ? [] : ["--max-turns", String(req.maxTurns)]),
      "--settings",
      '{"disableAllHooks":true}',
      "--setting-sources",
      "project,local",
      "--strict-mcp-config",
      "--no-session-persistence",
      ...(req.allowedTools === undefined
        ? []
        : ["--tools", req.allowedTools.join(","), "--allowedTools", req.allowedTools.join(",")]),
      ...(req.bundleDir === undefined ? [] : ["--plugin-dir", req.bundleDir]),
      ...(req.appendSystemPrompt === undefined ? [] : ["--append-system-prompt", req.appendSystemPrompt]),
      req.prompt,
    ];
  },
  parse(stdout: string) {
    const events: SessionEvent[] = [];
    let reply = "";
    let costUsd: number | undefined;
    let turns: number | undefined;
    let model: string | undefined;
    let sessionId: string | undefined;
    const requestIds: string[] = [];
    let slashCommands: string[] | undefined;
    for (const raw of stdout.split("\n")) {
      let line: Line;
      try {
        line = JSON.parse(raw) as Line;
      } catch {
        continue;
      }
      if (line.type === "system" && line.subtype === "init") {
        if (line.model !== undefined) model = line.model;
        if (line.session_id !== undefined) sessionId = line.session_id;
        // A typed `/ak:<id>` expands on the client with no stream line; this list is how the scorer sees it.
        if (Array.isArray(line.slash_commands))
          slashCommands = line.slash_commands.filter((c): c is string => typeof c === "string");
      } else if (line.type === "assistant" && Array.isArray(line.message?.content)) {
        if (line.message.model !== undefined) model = line.message.model;
        if (line.request_id !== undefined && !requestIds.includes(line.request_id)) requestIds.push(line.request_id);
        for (const part of line.message.content) {
          if (part.type === "text" && typeof part.text === "string" && part.text !== "")
            events.push({ kind: "message", text: part.text });
          if (part.type === "tool_use" && typeof part.name === "string")
            events.push({ kind: "tool", name: part.name, raw: part.name, input: part.input ?? {} });
        }
      } else if (line.type === "user") {
        // A typed slash command's expansion arrives as a user line; tool results are not user text.
        const content = line.message?.content;
        if (typeof content === "string" && content !== "") events.push({ kind: "user", text: content });
        else if (Array.isArray(content)) {
          for (const part of content)
            if (part.type === "text" && typeof part.text === "string" && part.text !== "")
              events.push({ kind: "user", text: part.text });
        }
      } else if (line.type === "result") {
        reply = (line.result ?? "").trim();
        costUsd = line.total_cost_usd;
        turns = line.num_turns;
      }
    }
    const parsed: ReturnType<SubjectAdapter["parse"]> = { events, reply };
    if (costUsd !== undefined) parsed.costUsd = costUsd;
    if (turns !== undefined) parsed.turns = turns;
    if (model !== undefined) {
      parsed.model = model;
      parsed.servedModel = model;
    }
    if (requestIds.length > 0) parsed.requestIds = requestIds;
    if (sessionId !== undefined) parsed.sessionId = sessionId;
    if (slashCommands !== undefined) parsed.slashCommands = slashCommands;
    return parsed;
  },
  isolate(): Isolation {
    return {
      env: { CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1", CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" },
      leaks: ["the caller's config dir and login", "the host's built-in skills"],
      release: () => {},
    };
  },
};
