/**
 * Grok in headless mode. Not a test file.
 *
 *   grok -p PROMPT --output-format streaming-json --allow RULE... --deny RULE... [-m M]
 *     [--max-turns N] --permission-mode dontAsk [--rules TEXT]
 *
 * `--rules` appends to the system prompt. `dontAsk` refuses any call that would need approval
 * instead of waiting for one; a refused call ends the turn with `stopReason: cancelled` and no
 * reply, so the attempt is still in the stream but the session is cut short. The adapter therefore
 * supplies `--allow` rules generated from the scorer's read-only program, git and gh tables, plus
 * matching denies for write-shaped flags and redirects; `dontAsk` continues to refuse every
 * unlisted call. Grok's glob grammar cannot safely express the scorer's semantic subsets for awk,
 * sed, curl, gh api, shell loops, arbitrary help/version calls, the ship gate's `check`, a
 * `git branch` or `git tag` listing beyond its exact forms, or harmless output redirection without
 * also approving a writing redirect. The redirect deny is a new refusal relative to the earlier
 * list, whose prefix rules had no deny beside them: `2>/dev/null`, `2>&1`, a `'%h -> %s'` format
 * and a `'=>'` pattern are refused now. Whether the earlier rules admitted them on the live host
 * is unverified. The direct `printenv`, `gh auth status --show-token` and `web_fetch` forms are
 * looks to the scorer and are refused here on purpose. The harness now allowlists the environment,
 * closing that disclosure path. A chain that assigns a variable and passes it to `find` has no
 * rule that covers it: the Grok 1.0.46 user guide (`22-permissions-and-safety.md`, Rule Matching
 * Reference) lets an allow rule cover a variable argument only as an `ls` or `rg` file operand, and
 * says other programs still prompt, which `dontAsk` refuses. The private home therefore carries one
 * `PreToolUse` hook for Bash, `grok-mediator.ts`, which rewrites such a chain into the literal
 * commands it stands for when these rules admit every one of them, and leaves every other call to
 * `dontAsk` and the denies. The stream still reports the call as the subject wrote it, so `parse`
 * derives shell reads from the same rewrite, the command the host ran.
 * Variable expansion and command substitution through an admitted program remain scored
 * read-only. Whether the live host expands variables before permission matching is unverified.
 * A refused call leaves the session invalid, and the receipt names the attempted call. The
 * read-only sandbox
 * remains unsuitable on a machine whose `/var/run/docker.sock` is a symlink. The parse reports `stopReason`. Isolation is a
 * private GROK_HOME and HOME with the Claude and Cursor compatibility scans and cross-session
 * memory off: by default grok also reads
 * `~/.claude` skills, rules, plugins and hooks, and `~/.agents/skills`. The bundle's skills are
 * copied into the private `skills/`.
 * Authentication comes from the copied `auth.json`, not an environment credential. `GROK_HOME` is
 * admitted only to locate the caller's file before the adapter replaces it with the scratch home.
 *
 * Grok loads a skill by reading its SKILL.md with `read_file`, which maps to Read.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { shellQuote } from "./grok-mediator.ts";
import { privateHome } from "./home.ts";
import { rewriteAssignmentReadChain } from "./grok-mediator.ts";
import { grokReadOnlyPermissionRules, readsOf } from "./shell.ts";
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

const READ_ONLY_RULES = grokReadOnlyPermissionRules();
const READ_ONLY_ALLOW = ["Read", "Grep", ...READ_ONLY_RULES.allow] as const;

export const grok: SubjectAdapter = {
  host: "grok",
  env: ["GROK_HOME"],
  injection: "append-system-prompt",
  command(req: SessionRequest, model: string | undefined): string[] {
    return [
      "grok",
      "-p",
      req.prompt,
      "--output-format",
      "streaming-json",
      ...READ_ONLY_ALLOW.flatMap((rule) => ["--allow", rule]),
      ...READ_ONLY_RULES.deny.flatMap((rule) => ["--deny", rule]),
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
        events.push({
          kind: "tool",
          name,
          raw: line.toolName,
          input: typeof file === "string" ? { ...rawInput, file_path: file } : rawInput,
        });
        if (name === "Bash" && typeof rawInput.command === "string") {
          for (const file_path of readsOf(rewriteAssignmentReadChain(rawInput.command) ?? rawInput.command))
            events.push({ kind: "tool", name: "Read", raw: line.toolName, input: { file_path, via: "shell" } });
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
    const parsed: ReturnType<SubjectAdapter["parse"]> = { events, reply };
    if (costUsd !== undefined) parsed.costUsd = costUsd;
    if (turns !== undefined) parsed.turns = turns;
    if (model !== undefined) parsed.model = model;
    if (stopReason !== undefined) parsed.stopReason = stopReason;
    return parsed;
  },
  isolate(scratch: string, req: SessionRequest): Isolation {
    const callerHome = req.env.GROK_HOME ?? join(req.env.HOME ?? homedir(), ".grok");
    const home = privateHome(
      join(scratch, "grok-home"),
      join(callerHome, "auth.json"),
      req.bundleDir === undefined ? undefined : join(req.bundleDir, "skills"),
      "skills",
    );
    mkdirSync(join(scratch, "home"), { recursive: true });
    const hooks = join(home.dir, "hooks");
    mkdirSync(hooks, { recursive: true });
    const script = join(hooks, "assignment-read-chain.sh");
    writeFileSync(
      script,
      `#!/bin/sh\ncd ${shellQuote(import.meta.dir)} && exec ${shellQuote(process.execPath)} grok-mediator.ts\n`,
      { mode: 0o755 },
    );
    writeFileSync(
      join(hooks, "assignment-read-chain.json"),
      JSON.stringify({
        hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: script, timeout: 30 }] }] },
      }),
    );
    return {
      env: {
        GROK_HOME: home.dir,
        HOME: join(scratch, "home"),
        GROK_DISABLE_AUTOUPDATER: "1",
        GROK_MEMORY: "0",
        ...Object.fromEntries(COMPAT_OFF),
      },
      leaks: [
        "the host's bundled platform skills, fetched into the private home at start and advertised beside the bundle's",
      ],
      release: () => home.release(),
    };
  },
};
