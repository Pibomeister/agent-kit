/**
 * Grok in headless mode. Not a test file.
 *
 *   grok -p PROMPT --output-format streaming-json [-m M] [--max-turns N]
 *     --permission-mode dontAsk [--rules TEXT]
 *
 * `--rules` appends to the system prompt. `dontAsk` refuses any call that would need approval
 * instead of waiting for one; a refused call ends the turn with `stopReason: cancelled` and no
 * reply, so the attempt is still in the stream but the session is cut short. The adapter therefore
 * supplies narrow `--allow` rules for read tools and the shell looks observed in the cross-host
 * run, while `dontAsk` continues to refuse every unlisted call. The read-only sandbox remains
 * unsuitable on a machine whose `/var/run/docker.sock` is a symlink. The parse reports
 * `stopReason`, and the eval lists a refused session as invalid with that reason. Isolation is a
 * private GROK_HOME and HOME with the Claude and Cursor compatibility scans and cross-session
 * memory off: by default grok also reads
 * `~/.claude` skills, rules, plugins and hooks, and `~/.agents/skills`. The bundle's skills are
 * copied into the private `skills/`.
 *
 * Grok loads a skill by reading its SKILL.md with `read_file`, which maps to Read.
 */
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { privateHome } from "./home.ts";
import { readsOf } from "./shell.ts";
import type { Isolation, SessionEvent, SessionRequest, SubjectAdapter } from "./types.ts";

/** Grok tool names onto the shared vocabulary. Unlisted names pass through. */
const TOOLS: Record<string, string> = {
  read_file: "Read",
  write: "Write",
  search_replace: "Edit",
  run_terminal_command: "Bash",
  grep: "Grep",
  web_search: "WebSearch",
  web_fetch: "WebFetch",
  todo_write: "TodoWrite",
  spawn_subagent: "Task",
};

interface Line {
  type?: string;
  data?: string;
  toolName?: string;
  rawInput?: Record<string, unknown>;
  stopReason?: string;
  total_cost_usd?: number;
  num_turns?: number;
  modelUsage?: Record<string, unknown>;
}

const COMPAT_OFF = ["CLAUDE", "CURSOR"].flatMap((vendor) =>
  ["SKILLS", "RULES", "AGENTS", "MCPS", "HOOKS"].map((cell) => [`GROK_${vendor}_${cell}_ENABLED`, "false"] as const),
);

const READ_ONLY_ALLOW = [
  "Read",
  "Grep",
  "Bash(ls)",
  "Bash(ls *)",
  "Bash(find *)",
  "Bash(head)",
  "Bash(head *)",
  "Bash(tail)",
  "Bash(tail *)",
  "Bash(cat *)",
  "Bash(rg *)",
  "Bash(grep *)",
  "Bash(git status)",
  "Bash(git status *)",
  "Bash(git log)",
  "Bash(git log *)",
  "Bash(git diff)",
  "Bash(git diff *)",
  "Bash(git show)",
  "Bash(git show *)",
  "Bash(git rev-parse *)",
] as const;

export const grok: SubjectAdapter = {
  host: "grok",
  injection: "append-system-prompt",
  command(req: SessionRequest, model: string | undefined): string[] {
    return [
      "grok",
      "-p",
      req.prompt,
      "--output-format",
      "streaming-json",
      ...READ_ONLY_ALLOW.flatMap((rule) => ["--allow", rule]),
      ...(model === undefined ? [] : ["-m", model]),
      ...(req.maxTurns === undefined ? [] : ["--max-turns", String(req.maxTurns)]),
      "--permission-mode",
      "dontAsk",
      ...(req.appendSystemPrompt === undefined ? [] : ["--rules", req.appendSystemPrompt]),
    ];
  },
  parse(stdout: string) {
    const events: SessionEvent[] = [];
    let text = "";
    let costUsd: number | undefined;
    let turns: number | undefined;
    let model: string | undefined;
    let stopReason: string | undefined;
    const flush = () => {
      if (text.trim() !== "") events.push({ kind: "message", text });
      text = "";
    };
    for (const raw of stdout.split("\n")) {
      let line: Line;
      try {
        line = JSON.parse(raw) as Line;
      } catch {
        continue;
      }
      if (line.type === "text" && typeof line.data === "string") {
        text += line.data;
      } else if (line.type === "tool_call" && typeof line.toolName === "string") {
        flush();
        const rawInput = line.rawInput ?? {};
        const name = TOOLS[line.toolName] ?? line.toolName;
        const file = rawInput.target_file ?? rawInput.file_path ?? rawInput.path;
        events.push({ kind: "tool", name, raw: line.toolName, input: typeof file === "string" ? { ...rawInput, file_path: file } : rawInput });
        if (name === "Bash" && typeof rawInput.command === "string") {
          for (const file_path of readsOf(rawInput.command)) events.push({ kind: "tool", name: "Read", raw: line.toolName, input: { file_path, via: "shell" } });
        }
      } else if (line.type === "end") {
        costUsd = line.total_cost_usd;
        turns = line.num_turns;
        stopReason = line.stopReason;
        // Usage is keyed by the models that served the session; more than one is kept as a list.
        const served = Object.keys(line.modelUsage ?? {}).sort();
        if (served.length > 0) model = served.join(",");
      }
    }
    flush();
    const last = events.at(-1);
    const reply = last?.kind === "message" ? last.text.trim() : "";
    return { events, reply, ...(costUsd === undefined ? {} : { costUsd }), ...(turns === undefined ? {} : { turns }), ...(model === undefined ? {} : { model }), ...(stopReason === undefined ? {} : { stopReason }) };
  },
  isolate(scratch: string, req: SessionRequest): Isolation {
    const callerHome = req.env.GROK_HOME ?? join(req.env.HOME ?? homedir(), ".grok");
    const home = privateHome(join(scratch, "grok-home"), join(callerHome, "auth.json"), req.bundleDir === undefined ? undefined : join(req.bundleDir, "skills"), "skills");
    mkdirSync(join(scratch, "home"), { recursive: true });
    return {
      env: { GROK_HOME: home.dir, HOME: join(scratch, "home"), GROK_DISABLE_AUTOUPDATER: "1", GROK_MEMORY: "0", ...Object.fromEntries(COMPAT_OFF) },
      leaks: ["the host's bundled platform skills, fetched into the private home at start and advertised beside the bundle's"],
      release: home.release,
    };
  },
};
