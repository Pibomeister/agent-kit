/**
 * The subject adapters on stored transcripts. `*-skill.jsonl` and `grok-denied-write.jsonl` are
 * real headless sessions (one per host, scrubbed of paths and bindings); `*.doc-derived.jsonl` are
 * written from each host's documented event shapes to reach tools the live sessions did not call.
 * No host CLI runs here.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { PACKAGE_ROOT } from "../../src/learn/core/roles.ts";
import { invalidSession, readOnlyShell, skillLoads } from "./evals/trigger-eval.ts";
import { costOf, loadPriceTable } from "./evals/pricing.ts";
import { claude } from "./evals/subjects/claude.ts";
import { codex, codexThreadStart, runCodexAppServer } from "./evals/subjects/codex.ts";
import { grok } from "./evals/subjects/grok.ts";
import { rewriteAssignmentReadChain } from "./evals/subjects/grok-mediator.ts";
import { privateHome } from "./evals/subjects/home.ts";
import { KIMI_REVIEWER_AGENT, kimi } from "./evals/subjects/kimi.ts";
import { adapterFor, BUNDLE_FOR, runSubject, withoutParentSession } from "./evals/subjects/index.ts";
import { readsOf, unwrap, words } from "./evals/subjects/shell.ts";
import type { SessionRequest, SubjectAdapter, TokenUsage, ToolEvent } from "./evals/subjects/types.ts";
import { cleanEnv, evalInstrument } from "./evals/session.ts";
import { SECRET_ENV, SECRET_VALUE } from "./evals/influence/scenarios.ts";

const FIXTURES = join(import.meta.dir, "evals", "fixtures", "transcripts");
const fixture = (name: string) => readFileSync(join(FIXTURES, name), "utf8");
const tools = (events: ReturnType<SubjectAdapter["parse"]>["events"]) =>
  events.filter((e): e is ToolEvent => e.kind === "tool");

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "ak-subjects-test-")));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const req: SessionRequest = { prompt: "Load the greet skill.", cwd: "/scratch/repo", env: {}, timeoutMs: 1000 };

// Grok's documented grammar: a segment runs when some allow glob matches it whole and no deny glob does.
const admits = (segment: string, request: SessionRequest = req) => {
  const argv = grok.command(request, undefined);
  const matching = (flag: string) =>
    argv
      .flatMap((value, index) => {
        const rule = argv[index + 1];
        return value === flag && rule?.startsWith("Bash(") ? [rule.slice(5, -1)] : [];
      })
      .some((glob) =>
        new RegExp(
          `^${glob
            .split("*")
            .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
            .join(".*")}$`,
        ).test(segment),
      );
  return matching("--allow") && !matching("--deny");
};

const denies = (segment: string) => {
  const argv = grok.command(req, undefined);
  return argv
    .flatMap((value, index) => {
      const rule = argv[index + 1];
      return value === "--deny" && rule?.startsWith("Bash(") ? [rule.slice(5, -1)] : [];
    })
    .some((glob) =>
      new RegExp(
        `^${glob
          .split("*")
          .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
          .join(".*")}$`,
      ).test(segment),
    );
};

describe("claude", () => {
  test("a live session: the Skill call, the reply, cost and turns", () => {
    const parsed = claude.parse(fixture("claude-skill.jsonl"));
    expect(tools(parsed.events).map((e) => [e.name, e.input.skill])).toEqual([["Skill", "greet"]]);
    expect(parsed.reply).toBe("ok");
    expect(parsed.turns).toBe(3);
    expect(parsed.costUsd).toBeGreaterThan(0);
    expect(skillLoads(parsed.events).map((l) => l.skill)).toEqual(["greet"]);
  });

  test("the model the host reports serving the session comes from the init line, and is absent without one", () => {
    const init = JSON.stringify({ type: "system", subtype: "init", model: "model-under-test" });
    const result = JSON.stringify({ type: "result", result: "ok", num_turns: 1 });
    expect(claude.parse(`${init}\n${result}`).model).toBe("model-under-test");
    expect(claude.parse(result).model).toBeUndefined();
  });

  test("an assistant event's served model supersedes the init binding", () => {
    const init = JSON.stringify({ type: "system", subtype: "init", model: "initial-binding" });
    const assistant = JSON.stringify({
      type: "assistant",
      message: { model: "served-binding", content: [{ type: "text", text: "ok" }] },
    });

    expect(claude.parse(`${init}\n${assistant}`).servedModel).toBe("served-binding");
  });

  test("a typed slash command's expansion becomes a user event the scorer reads as a load; tool results do not", () => {
    const expansion = JSON.stringify({
      type: "user",
      message: {
        content: [
          {
            type: "text",
            text: "<command-message>ak:compound is running</command-message>\n<command-name>/ak:compound</command-name>",
          },
        ],
      },
    });
    const toolResult = JSON.stringify({
      type: "user",
      message: { content: [{ type: "tool_result", content: "file contents" }] },
    });
    const parsed = claude.parse(`${expansion}\n${toolResult}\n${JSON.stringify({ type: "result", result: "done" })}`);
    expect(parsed.events.map((e) => e.kind)).toEqual(["user"]);
    expect(skillLoads(parsed.events).map((l) => [l.skill, l.via])).toEqual([["compound", "expansion"]]);
  });

  test("argv: isolation flags always, model, cap, bundle and appended context only when given", () => {
    expect(claude.command(req, undefined)).toEqual([
      "claude",
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--settings",
      '{"disableAllHooks":true}',
      "--setting-sources",
      "project,local",
      "--strict-mcp-config",
      "--no-session-persistence",
      "Load the greet skill.",
    ]);
    const full = claude.command(
      { ...req, maxTurns: 3, bundleDir: "/dist/claude-code", appendSystemPrompt: "ROSTER" },
      "bound-a",
    );
    expect(full.slice(5, 9)).toEqual(["--model", "bound-a", "--max-turns", "3"]);
    expect(full).toContain("--plugin-dir");
    expect(full.slice(-3)).toEqual(["--append-system-prompt", "ROSTER", "Load the greet skill."]);
    expect(claude.injection).toBe("append-system-prompt");
  });
});

describe("codex", () => {
  test("the app-server transport runs its own thread to completion and retains the model and file changes", async () => {
    const stub = join(import.meta.dir, "evals", "fixtures", "case-runner", "codex-app-server-stub.ts");
    const result = await runCodexAppServer(
      { ...req, cwd: PACKAGE_ROOT },
      "model-under-test",
      { cwd: PACKAGE_ROOT, env: cleanEnv([]), timeoutMs: 5000 },
      [process.execPath, stub],
    );
    const parsed = codex.parse(result.stdout);

    expect(result).toMatchObject({ code: 0, timedOut: false });
    expect(parsed).toMatchObject({ servedModel: "model-under-test", sessionId: "thread-stub", reply: "ok" });
    expect(parsed.usage?.totalTokens).toBe(12);
    expect(tools(parsed.events).map((e) => [e.name, e.input.file_path, e.input.change])).toEqual([
      ["Write", "notes/new.md", "add"],
      ["Edit", "notes/kept.md", "update"],
      ["Delete", "notes/old.md", "delete"],
    ]);
  }, 10_000);

  test("the handshake-only transport returns the served model and thread id without starting a turn", async () => {
    const stub = join(import.meta.dir, "evals", "fixtures", "case-runner", "codex-app-server-stub.ts");
    const result = await runCodexAppServer(
      { ...req, cwd: PACKAGE_ROOT },
      "model-under-test",
      { cwd: PACKAGE_ROOT, env: cleanEnv([]), timeoutMs: 5000, handshakeOnly: true },
      [process.execPath, stub],
    );
    const parsed = codex.parse(result.stdout);

    expect(result).toMatchObject({ code: 0, timedOut: false });
    expect(parsed).toMatchObject({ servedModel: "model-under-test", sessionId: "thread-stub", reply: "" });
    expect(parsed.events).toEqual([]);
    expect(result.stdout).not.toContain("turn-stub");
  }, 10_000);

  test("a live session: the shell cat of SKILL.md is a Bash call and a Read of that path", () => {
    const parsed = codex.parse(fixture("codex-skill.jsonl"));
    expect(tools(parsed.events).map((e) => [e.name, e.input.command ?? e.input.file_path])).toEqual([
      ["Bash", "cat .agents/skills/greet/SKILL.md"],
      ["Read", ".agents/skills/greet/SKILL.md"],
    ]);
    expect(parsed.reply).toBe("ok");
    expect(skillLoads(parsed.events).map((l) => l.skill)).toContain("greet");
    expect(parsed.model).toBeUndefined();
  });

  test("documented items: file changes, MCP, web search, and a command cut off by the timeout", () => {
    const parsed = codex.parse(fixture("codex-tools.doc-derived.jsonl"));
    expect(tools(parsed.events).map((e) => e.name)).toEqual([
      "Bash",
      "Read",
      "Read",
      "Write",
      "Edit",
      "mcp__tracker__get_issue",
      "WebSearch",
      "Bash",
    ]);
    const reads = tools(parsed.events)
      .filter((e) => e.name === "Read")
      .map((e) => e.input.file_path);
    expect(reads).toEqual(["skills/super-align/SKILL.md", "README.md"]);
    expect(parsed.reply).toBe("Loaded super-align.");
    expect(tools(parsed.events).at(-1)!.input.command).toBe("bun test");
  });

  test("a completed turn retains every reported token total", () => {
    expect(codex.parse(fixture("codex-usage.jsonl")).usage).toEqual({
      inputTokens: 38420,
      cachedInputTokens: 31104,
      cacheWriteInputTokens: 0,
      outputTokens: 60,
      reasoningOutputTokens: 0,
      totalTokens: 38480,
    });
  });

  test("a model reroute replaces the app-server thread binding in the receipt", () => {
    const started = JSON.stringify({ id: 2, result: { model: "initial-binding", thread: { id: "thread" } } });
    const rerouted = JSON.stringify({ method: "model/rerouted", params: { toModel: "served-binding" } });

    expect(codex.parse(`${started}\n${rerouted}`).servedModel).toBe("served-binding");
  });

  test("a completed turn without cache-write or reasoning totals counts them as zero", () => {
    expect(codex.parse(fixture("codex-tools.doc-derived.jsonl")).usage).toEqual({
      inputTokens: 100,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      outputTokens: 10,
      reasoningOutputTokens: 0,
      totalTokens: 110,
    });
  });

  test("absent or malformed completed-turn usage is ignored", () => {
    expect(codex.parse(fixture("codex-usage-absent.jsonl")).usage).toBeUndefined();
    expect(codex.parse(fixture("codex-usage-malformed.jsonl")).usage).toBeUndefined();
    const reported = { input_tokens: 100, cached_input_tokens: 0, output_tokens: 10 };
    for (const usage of [
      { ...reported, reasoning_output_tokens: "unknown" },
      { ...reported, cache_write_input_tokens: null },
      { input_tokens: 100, output_tokens: 10 },
    ])
      expect(codex.parse(JSON.stringify({ type: "turn.completed", usage })).usage).toBeUndefined();
  });

  test("a deleted file, or a change of a kind not listed, is a mutating tool", () => {
    const stdout = JSON.stringify({
      type: "item.completed",
      item: {
        id: "1",
        type: "file_change",
        changes: [
          { path: "a.md", kind: "delete" },
          { path: "b.md", kind: "rename" },
        ],
      },
    });
    expect(tools(codex.parse(stdout).events).map((e) => [e.name, e.input.file_path])).toEqual([
      ["Delete", "a.md"],
      ["Edit", "b.md"],
    ]);
  });

  test("app-server start carries the resolved model, context and sandbox outside argv", () => {
    const argv = codex.command({ ...req, maxTurns: 4, appendSystemPrompt: 'line "one"\nline two' }, "bound-b");
    expect(argv.slice(0, 3)).toEqual(["codex", "app-server", "--stdio"]);
    expect(argv).not.toContain("bound-b");
    expect(codexThreadStart({ ...req, appendSystemPrompt: 'line "one"\nline two' }, "bound-b")).toMatchObject({
      model: "bound-b",
      developerInstructions: 'line "one"\nline two',
      sandbox: "read-only",
    });
    expect(codex.injection).toBe("developer-instructions");
  });

  test("argv: the caller's connected apps are off, as plugins are", () => {
    // On 2026-09-28 codex subjects searched the operator's connected GitHub, Vercel and Drive apps.
    expect(codex.command(req, undefined).join(" ")).toContain(
      "--disable plugins --disable remote_plugin --disable apps",
    );
  });

  test("argv: a case that grants mutation runs in the scratch workspace, while an ordinary subject stays read-only", () => {
    const ordinary = codex.command(req, undefined);
    expect(ordinary.slice(0, 3)).toEqual(["codex", "app-server", "--stdio"]);
    const argv = codex.command({ ...req, allowedTools: ["Read", "Bash"] }, undefined);
    expect(argv).toEqual(ordinary);
    expect(codexThreadStart(req, undefined).sandbox).toBe("read-only");
    expect(codexThreadStart({ ...req, allowedTools: ["Read", "Bash"] }, undefined).sandbox).toBe("workspace-write");
  });
});

describe("grok", () => {
  test("a live session: read_file of SKILL.md is a Read, text chunks join into the reply", () => {
    const parsed = grok.parse(fixture("grok-skill.jsonl"));
    const calls = tools(parsed.events);
    expect(calls.map((e) => [e.name, e.raw])).toEqual([["Read", "read_file"]]);
    expect(String(calls[0]!.input.file_path)).toEndWith("/skills/greet/SKILL.md");
    expect(parsed.reply).toBe("ok");
    expect(parsed.turns).toBe(2);
    expect(skillLoads(parsed.events).map((l) => l.skill)).toEqual(["greet"]);
  });

  test("the served models come from the end line's usage, sorted and joined", () => {
    expect(grok.parse(fixture("grok-skill.jsonl")).model).toBe("subject-model");
    const end = (usage: Record<string, unknown>) => JSON.stringify({ type: "end", num_turns: 1, modelUsage: usage });
    expect(grok.parse(end({ "model-under-test": {}, "helper-under-test": {} })).model).toBe(
      "helper-under-test,model-under-test",
    );
    expect(grok.parse(end({})).model).toBeUndefined();
  });

  test("argv: a case's declared tools replace the ordinary read-only permission table", () => {
    const ordinary = grok.command(req, undefined);
    expect(ordinary.filter((value) => value === "--allow").length).toBeGreaterThan(3);
    expect(ordinary).toContain("--deny");
    const argv = grok.command(
      { ...req, allowedTools: ["Read", "Glob", "Grep", "Bash", "Skill", "Write", "Edit", "Agent"] },
      undefined,
    );
    const values = (flag: string) => argv.flatMap((value, index) => (value === flag ? [argv[index + 1]] : []));
    expect(values("--allow")).toEqual(["Read", "Glob", "Grep", "Bash(*)", "Write", "Edit"]);
    expect(values("--deny")).toEqual([]);
    expect(argv).toContain("--always-approve");
    expect(argv).not.toContain("dontAsk");
  });

  test("a live session under dontAsk: the refused write is still an Edit event, and there is no reply", () => {
    const parsed = grok.parse(fixture("grok-denied-write.jsonl"));
    expect(tools(parsed.events).map((e) => e.name)).toEqual(["Read", "Edit"]);
    expect(parsed.reply).toBe("");
    expect(parsed.stopReason).toBe("cancelled");
  });

  test("every segment of an archived read-only chain Grok refused is now admitted", () => {
    const parsed = grok.parse(fixture("grok-cancelled-read.jsonl"));
    const command = String(tools(parsed.events).at(-1)?.input.command);
    expect(command).toBe(
      "git status -sb && git branch -vv && gh pr list --state open --json number,title,url; echo ---",
    );
    expect(readOnlyShell(command)).toBe(true);
    for (const segment of command.split(/ && |; /)) expect([segment, admits(segment)]).toEqual([segment, true]);
  });

  test("the smoke-3 environment inspection is admitted while embedded code is explicitly refused", () => {
    const parsed = grok.parse(fixture("grok-smoke-3-env.doc-derived.jsonl"));
    const command = String(tools(parsed.events).at(-1)?.input.command);
    expect(command).toBe("env");
    expect(parsed.stopReason).toBe("cancelled");
    expect(parsed.turns).toBeUndefined();
    expect(readOnlyShell(command)).toBe(true);
    expect(admits(command)).toBe(true);

    const trigger = { ...req, env: cleanEnv(grok.env) };
    const influence = { ...req, env: { ...cleanEnv(grok.env), [SECRET_ENV]: SECRET_VALUE } };
    expect(admits(command, trigger)).toBe(true);
    expect(admits(command, influence)).toBe(false);
    expect(denies(command)).toBe(false);

    const embedded = "python3 -c code";
    expect(readOnlyShell(embedded)).toBe(false);
    expect(admits(embedded)).toBe(false);
    expect(denies(embedded)).toBe(true);
  });

  test("the A1 compound inspection sends unmatched git -C segments through an explicit refusal", () => {
    const command =
      "command -v ak; command -v node; ls /scratch/grok-home/skills/doc-review; ls /scratch/eval; git -C /scratch/eval/repo status --short; git -C /scratch/eval/repo log --oneline -5; git -C /scratch/eval/repo rev-parse HEAD";
    const segments = command.split("; ");

    expect(readOnlyShell(command)).toBe(true);
    expect(rewriteAssignmentReadChain(command)).toBeNull();
    expect(segments.slice(0, 4).every((segment) => admits(segment))).toBe(true);
    expect(segments.slice(4).every((segment) => !admits(segment) && denies(segment))).toBe(true);

    for (const segment of [
      "git --no-pager -C /scratch/eval/repo log --oneline -5",
      "git -c core.pager=cat status",
      "git --no-pager -c core.pager=cat log",
      "git --git-dir=/scratch/eval/repo/.git log",
      "git --work-tree=/scratch/eval/repo status",
      "git --no-pager --git-dir=/scratch/eval/repo/.git log",
    ])
      expect([segment, admits(segment), denies(segment)]).toEqual([segment, false, true]);
    expect(denies("git log -C --oneline")).toBe(false);
  });

  test("the mediator turns an assignment read chain into literal commands the rules admit, and the session is valid", () => {
    const discovery =
      'SESSION="/scratch/sessions/s1"; find "$SESSION" -maxdepth 3 -type d; echo \'=== FILES ===\'; find "$SESSION" -maxdepth 3 -type f -not -path \'*/terminal/*\' | head -80';
    expect(readOnlyShell(discovery)).toBe(true);
    expect(discovery.split(/; | \| /).every((segment) => admits(segment))).toBe(false);
    const mediated = rewriteAssignmentReadChain(discovery);
    expect(mediated).toBe(
      "find '/scratch/sessions/s1' '-maxdepth' '3' '-type' 'd' ; echo '=== FILES ===' ; find '/scratch/sessions/s1' '-maxdepth' '3' '-type' 'f' '-not' '-path' '*/terminal/*' | head '-80'",
    );
    for (const segment of String(mediated).split(/ ; | \| /))
      expect([segment, admits(segment)]).toEqual([segment, true]);

    const attempted = JSON.stringify({
      type: "tool_call",
      toolName: "run_terminal_command",
      rawInput: { command: discovery },
    });
    const reply = JSON.stringify({ type: "text", data: "READ_CHAIN_OK" });
    const ended = JSON.stringify({ type: "end", stopReason: "end_turn", num_turns: 2 });
    const parsed = grok.parse(`${attempted}\n${reply}\n${ended}`);
    expect(invalidSession({ ...parsed, exitCode: 0, timedOut: false }, 20)).toBeNull();

    const throughVariable = JSON.stringify({
      type: "tool_call",
      toolName: "run_terminal_command",
      rawInput: { command: 'D=/home/skills/super-align; cat "$D/SKILL.md"' },
    });
    expect(skillLoads(grok.parse(throughVariable).events).map((l) => l.skill)).toEqual(["super-align"]);

    for (const [command, rewritten] of [
      ['ls /maybe; SESSION=/scratch/s1 && find "$SESSION" -type d', "ls '/maybe' ; find '/scratch/s1' '-type' 'd'"],
      ["ROOT=/scratch; SESSION=$ROOT/s1; git -C . status; ls ${SESSION}", null],
      ["ROOT=/scratch; SESSION=$ROOT/s1 && git status -sb | head -5", "git 'status' '-sb' | head '-5'"],
      ["NAME='$HOME'; echo \"$NAME\"", "echo '$HOME'"],
    ] as const)
      expect([command, rewriteAssignmentReadChain(command)]).toEqual([command, rewritten]);
  });

  test("the mediator leaves writes and everything it cannot read as literal words to dontAsk and the denies", () => {
    for (const command of [
      'ROOT=/scratch; OUT=$ROOT/out cp notes.md "$ROOT"',
      "ROOT=/scratch; GIT_DIR=$ROOT/.git git log -3",
      'ROOT=/scratch; ROOT=/other ls "$ROOT"; ls "$ROOT"',
      'SESSION=/scratch/s1 find "$SESSION" -type d',
      'SESSION=/scratch/s1 ls; find "$SESSION" -type d',
      "LC_ALL=C ls -la /scratch",
      'test -d /scratch/a && SESSION=/scratch/a || SESSION=/scratch/b; ls "$SESSION"',
      "SESSION=/scratch/s1 || ls /scratch",
      "SESSION=/scratch/s1 | ls /scratch",
      "ls /scratch; SESSION=/scratch/s1",
      "PATH=/scratch; ls /scratch",
      "HOME=/scratch; ls /scratch",
      'OUT=/scratch/out; rm -rf "$OUT"',
      'OUT=/scratch/out.txt; echo changed > "$OUT"',
      'OUT=/scratch/out.txt; cat notes.md 2>/dev/null; ls "$OUT"',
      'SESSION=/scratch/s1; find "$SESSION" -delete',
      "FLAG=-delete; find /scratch/s1 $FLAG",
      "TOOL=rm; $TOOL /scratch/s1",
      'SESSION="$(mktemp -d)"; find "$SESSION" -type d',
      'SESSION=`mktemp -d`; find "$SESSION" -type d',
      'SESSION=/scratch/s1; (find "$SESSION" -type d)',
      'SESSION=/scratch/s1; find "$SESSION" -type d & ls',
      'SESSION=/scratch/s1; find "$SESSION -type d',
      'SESSION=/scratch/s1; find "$OTHER" -type d',
      "SESSION=/scratch/s1; ls $SESSION/*.md",
      'SESSION="/scratch/s 1"; ls $SESSION',
      'SESSION=/scratch/s1; find "$SESSION" -name a\\ b',
      'export SESSION=/scratch/s1; find "$SESSION" -type d',
      "1SESSION=/scratch/s1; ls",
      "SESSION=/scratch/s1",
      "find /scratch/s1 -type d; echo done",
      'echo deliberate-control > "/scratch/write-control.txt"',
    ])
      expect([command, rewriteAssignmentReadChain(command)]).toEqual([command, null]);

    for (const segment of [
      'cp notes.md "$ROOT"',
      'rm -rf "$OUT"',
      'echo changed > "$OUT"',
      'find "$SESSION" -delete',
      'echo deliberate-control > "/scratch/write-control.txt"',
    ])
      expect([segment, admits(segment)]).toEqual([segment, false]);

    const control = 'echo deliberate-control > "/scratch/write-control.txt"';
    const attempted = JSON.stringify({
      type: "tool_call",
      toolName: "run_terminal_command",
      rawInput: { command: control },
    });
    const cancelled = JSON.stringify({ type: "end", stopReason: "cancelled", num_turns: 1 });
    const parsed = grok.parse(`${attempted}\n${cancelled}`);
    expect(invalidSession({ ...parsed, exitCode: 1, timedOut: false }, 20)).toBe(
      `host cancelled refused Bash call: ${control}`,
    );
  });

  test("looks the scorer accepts are admitted in their common forms", () => {
    for (const look of [
      "git count-objects -v",
      "git remote -v",
      "git --no-pager log --oneline -5",
      "git branch --show-current",
      "git tag --list",
      "bun run ak validate",
      "sort",
      "sort -u",
      "rg --pretty needle src",
      "git reflog show",
      "git --no-pager branch -vv",
      "git --no-pager remote -v",
    ]) {
      expect([look, readOnlyShell(look)]).toEqual([look, true]);
      expect([look, admits(look)]).toEqual([look, true]);
    }
  });

  test("the direct environment and token forms stay refused and named, while expansion through echo is admitted", () => {
    const parsed = grok.parse(fixture("grok-refused-disclosure.doc-derived.jsonl"));
    const command = String(tools(parsed.events).at(-1)?.input.command);
    expect(command.split("; ")).toEqual(["printenv GH_TOKEN", "gh auth status --show-token"]);
    for (const look of [...command.split("; "), "printenv"]) {
      expect([look, readOnlyShell(look)]).toEqual([look, true]);
      expect([look, admits(look)]).toEqual([look, false]);
    }
    expect(admits("gh auth status")).toBe(true);
    for (const look of ["echo $GH_TOKEN", "echo ${GH_TOKEN}", "echo $(printenv)", 'test -n "$GH_TOKEN"']) {
      expect([look, readOnlyShell(look)]).toEqual([look, true]);
      expect([look, admits(look)]).toEqual([look, true]);
    }
    expect(invalidSession({ ...parsed, exitCode: 0, timedOut: false }, 20)).toBe(
      `host cancelled refused Bash call: ${command}`,
    );
    const argv = grok.command(req, undefined);
    expect(argv.flatMap((value, index) => (value === "--allow" ? [argv[index + 1]] : []))).not.toContain("WebFetch");
  });

  test("every segment with a redirect is refused, the harmless forms included", () => {
    for (const look of ["ls -la 2>/dev/null", "git status 2>&1", "git log --format='%h -> %s'", "grep -rn '=>' src"]) {
      expect([look, readOnlyShell(look)]).toEqual([look, true]);
      expect([look, admits(look)]).toEqual([look, false]);
    }
  });

  test("no rule admits a segment the scorer calls a write", () => {
    for (const write of [
      "git branch -v -D main",
      "git branch -vv newname",
      "git tag -l -d v1",
      "git remote add origin url",
      "git --no-pager diff --output=out.patch",
      "node -e 'code' ak-gate.mjs check x",
      "gh pr create --fill",
      "find . -name x -delete",
      "find . -execdir rm {} +",
      "find . -okdir rm {} +",
      "find . -fprintf out.txt %p",
      "sort -o out.txt in.txt",
      "sort -ro out.txt in.txt",
      "sort -uo out.txt in.txt",
      "ls > out.txt",
    ]) {
      expect([write, readOnlyShell(write)]).toEqual([write, false]);
      expect([write, admits(write)]).toEqual([write, false]);
    }
    expect(admits("sed -n 'w out.txt' notes.md")).toBe(false);
    expect(admits("rg --pre cat needle")).toBe(false);
    expect(admits("rg --pre=cat needle")).toBe(false);
    expect(grok.command(req, undefined)).not.toContain("Bash");
  });

  test("a session that ends normally reports its stop reason", () => {
    expect(grok.parse(JSON.stringify({ type: "end", stopReason: "end_turn", num_turns: 1 })).stopReason).toBe(
      "end_turn",
    );
  });

  test("documented tools map onto the shared names; unmapped ones keep their own", () => {
    const parsed = grok.parse(fixture("grok-tools.doc-derived.jsonl"));
    expect(tools(parsed.events).map((e) => e.name)).toEqual(["Grep", "Bash", "Read", "list_dir", "Write"]);
    expect(parsed.events.filter((e) => e.kind === "message").map((e) => (e.kind === "message" ? e.text : ""))).toEqual([
      "Reading it now.",
      "ok",
    ]);
    expect(parsed.reply).toBe("ok");
  });

  test("argv: prompt after -p, rules for appended context, dontAsk always", () => {
    const argv = grok.command({ ...req, maxTurns: 2, appendSystemPrompt: "ROSTER" }, "bound-c");
    expect(argv.slice(0, 3)).toEqual(["grok", "-p", "Load the greet skill."]);
    expect(argv.join(" ")).toContain("-m bound-c --max-turns 2 --permission-mode dontAsk --rules ROSTER");
  });

  test("argv: observed read-only looks are allowed without blanket shell or mutation approval", () => {
    const argv = grok.command(req, undefined);
    const allow = argv.flatMap((value, index) => (value === "--allow" ? [argv[index + 1]] : []));
    expect(allow).toEqual(expect.arrayContaining(["Read", "Grep", "Bash(find *)", "Bash(git show *)"]));
    expect(argv).not.toContain("--always-approve");
    expect(allow).not.toContain("Bash");
    expect(allow.some((rule) => rule?.startsWith("Write") || rule?.startsWith("Edit"))).toBe(false);
    expect(argv.slice(argv.indexOf("--permission-mode"), argv.indexOf("--permission-mode") + 2)).toEqual([
      "--permission-mode",
      "dontAsk",
    ]);
  });
});

describe("kimi", () => {
  test("argv binds one text-only prompt and parser returns the plain reply", () => {
    expect(kimi.command(req, "bound-d")).toEqual([
      "kimi",
      "--prompt",
      "Load the greet skill.",
      "--output-format",
      "text",
      "--model",
      "bound-d",
    ]);
    expect(kimi.command(req, undefined)).toEqual([
      "kimi",
      "--prompt",
      "Load the greet skill.",
      "--output-format",
      "text",
    ]);
    expect(kimi.parse('  {"verdict":"PASS","reason":"meets the criterion"}  \n')).toEqual({
      events: [{ kind: "message", text: '{"verdict":"PASS","reason":"meets the criterion"}' }],
      reply: '{"verdict":"PASS","reason":"meets the criterion"}',
    });
    expect(kimi.requestIds).toBe(false);
    expect(kimi.injection).toBe("prompt-prefix");
  });

  test("the reviewer agent definition grants no tools and no sub-agents", () => {
    const [, frontmatter = "", body = ""] = KIMI_REVIEWER_AGENT.split("---\n");
    expect(frontmatter.trimEnd().split("\n")).toEqual([
      "name: text-reviewer",
      "description: Answers one prompt in text, with no tools and no sub-agents.",
      "tools: []",
      "subagents: []",
    ]);
    expect(body.trim()).not.toBe("");
    expect(body).not.toContain("${");
  });

  test("a session runs tool-less against an empty skills directory, and both are removed afterwards", async () => {
    const bin = join(scratch, "kimi-bin");
    mkdirSync(bin, { recursive: true });
    // Stands in for the CLI's own option check: prompt mode refuses the modes it cannot combine with.
    writeFileSync(
      join(bin, "kimi"),
      '#!/bin/sh\nfor arg in "$@"; do printf \'%s\\n\' "$arg"; done\n' +
        'for arg in "$@"; do case "$arg" in --plan|--yolo|--auto) echo "error: Cannot combine --prompt with $arg." >&2; exit 1;; esac; done\n' +
        'while [ "$#" -gt 0 ]; do [ "$1" = "--skills-dir" ] && dir="$2"; [ "$1" = "--agent-file" ] && agent="$2"; shift; done\n' +
        "printf 'entries=%s\\n' \"$(ls -A \"$dir\" | wc -l | tr -d ' ')\"\n" +
        "printf 'agent<<\\n'; cat \"$agent\"\n",
      { mode: 0o755 },
    );
    const result = await runSubject(kimi, "reviewer-d", "bound-d", {
      ...req,
      cwd: scratch,
      env: { PATH: `${bin}:${process.env.PATH ?? ""}` },
      maxTurns: 1,
    });
    const [argv = "", agentFile = ""] = result.reply.split("\nagent<<\n");
    const lines = argv.split("\n");
    const agent = lines[lines.indexOf("--agent-file") + 1] ?? "";
    const skills = lines[lines.indexOf("--skills-dir") + 1] ?? "";
    expect(lines).toEqual([
      "--prompt",
      "Load the greet skill.",
      "--output-format",
      "text",
      "--model",
      "bound-d",
      "--agent-file",
      agent,
      "--skills-dir",
      skills,
      "entries=0",
    ]);
    expect(agentFile).toBe(KIMI_REVIEWER_AGENT.trim());
    expect(isAbsolute(agent)).toBe(true);
    expect(isAbsolute(skills)).toBe(true);
    expect(existsSync(agent)).toBe(false);
    expect(existsSync(skills)).toBe(false);
    expect(result).toMatchObject({ host: "kimi", exitCode: 0, timedOut: false });
  });

  test("no request puts a mode flag beside --prompt", () => {
    const requests: SessionRequest[] = [
      req,
      { ...req, appendSystemPrompt: "Judge strictly." },
      { ...req, maxTurns: 1 },
    ];
    for (const request of requests) {
      for (const model of ["bound-d", undefined]) {
        const argv = kimi.command(request, model);
        expect(argv).toContain("--prompt");
        for (const flag of ["--plan", "--yolo", "-y", "--auto"]) expect(argv).not.toContain(flag);
      }
    }
  });
});

describe("shell reads", () => {
  test("unwraps login shells and finds printed files across pipelines, skipping options, scripts and output redirects", () => {
    expect(unwrap("/bin/zsh -lc 'cat a b'")).toBe("cat a b");
    expect(unwrap('bash -lc "head -n 5 x"')).toBe("head -n 5 x");
    expect(words(`cat "a b" 'c' d\\ e && ls`)).toEqual(["cat", "a b", "c", "d e", "&&", "ls"]);
    expect(words("git status 2>&1 >&2 &>/dev/null & ls")).toEqual([
      "git",
      "status",
      "2>&1",
      ">&2",
      "&>/dev/null",
      "&",
      "ls",
    ]);
    expect(words("ls&>out.log")).toEqual(["ls", "&>out.log"]);
    expect(words("cat a.md>x")).toEqual(["cat", "a.md", ">x"]);
    expect(words("ls>out.log")).toEqual(["ls", ">out.log"]);
    expect(words("echo x>out.log")).toEqual(["echo", "x", ">out.log"]);
    expect(words("nl -ba a.md>out")).toEqual(["nl", "-ba", "a.md", ">out"]);
    expect(words("echo x>&ls")).toEqual(["echo", "x", ">&ls"]);
    expect(words("git status>&1")).toEqual(["git", "status", ">&1"]);
    expect(words("echo x>&2")).toEqual(["echo", "x", ">&2"]);
    expect(words("ls>&1")).toEqual(["ls", ">&1"]);
    expect(words("echo x>>out.log")).toEqual(["echo", "x", ">>out.log"]);
    expect(words("echo hi >> /dev/null")).toEqual(["echo", "hi", ">>", "/dev/null"]);
    expect(words("cat<in.txt")).toEqual(["cat", "<in.txt"]);
    expect(words("cat <>created.txt")).toEqual(["cat", "<>created.txt"]);
    expect(words("cat 0<>created.txt")).toEqual(["cat", "0<>created.txt"]);
    expect(words("cat<>created.txt")).toEqual(["cat", "<>created.txt"]);
    expect(words("cat <> created.txt")).toEqual(["cat", "<>", "created.txt"]);
    expect(words("echo hi 1<>fd1.txt")).toEqual(["echo", "hi", "1<>fd1.txt"]);
    expect(readsOf("cat SKILL.md | head -5")).toEqual(["SKILL.md"]);
    expect(readsOf("cat <>in.txt")).toEqual(["in.txt"]);
    expect(readsOf("cat 0<>in.txt >out.txt")).toEqual(["in.txt"]);
    expect(readsOf("cat<in.txt >out.txt")).toEqual(["in.txt"]);
    expect(readsOf("sed -n '1,20p' x/SKILL.md; tail -n 3 log.txt 2>/dev/null")).toEqual(["x/SKILL.md", "log.txt"]);
    expect(readsOf("sed -e s/a/b/ in.txt")).toEqual(["in.txt"]);
    expect(readsOf("ls skills && rg foo")).toEqual([]);
    expect(readsOf("cat < in.txt > out.txt")).toEqual(["in.txt"]);
  });
});

const applyEnv = (values: Record<string, string | undefined>) => {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) Reflect.deleteProperty(process.env, key);
    else process.env[key] = value;
  }
};
const withCallerEnv = (planted: Record<string, string | undefined>, body: () => void) => {
  const previous = Object.fromEntries(Object.keys(planted).map((key) => [key, process.env[key]]));
  applyEnv(planted);
  try {
    body();
  } finally {
    applyEnv(previous);
  }
};
const absent = (env: Record<string, string>, names: Record<string, string>) => {
  for (const name of Object.keys(names)) expect(env).not.toHaveProperty(name);
};

describe("isolation", () => {
  test("each subject receives only process basics, its declared caller variables and the operator's opted-in names", () => {
    const planted = {
      GH_TOKEN: "gh-secret",
      ANTHROPIC_API_KEY: "anthropic-secret",
      XAI_API_KEY: "xai-secret",
      OPENAI_API_KEY: "openai-secret",
      CLAUDE_CODE_OAUTH_TOKEN: "claude-token",
      CODEX_HOME: "/caller/codex",
      GROK_HOME: "/caller/grok",
      CLAUDECODE: "parent",
      CLAUDE_CODE_ENTRYPOINT: "parent-entrypoint",
      LC_TEST: "locale",
      HTTPS_PROXY: "http://proxy.invalid:3128",
      NODE_EXTRA_CA_CERTS: "/caller/ca.pem",
      AK_EVAL_PASS_ENV: "AK_TEST_OPTED_IN  AK_TEST_UNSET",
      AK_TEST_OPTED_IN: "opted-in",
      AK_TEST_STRAY: "stray",
    };
    withCallerEnv(planted, () => {
      const claudeEnv = cleanEnv(claude.env);
      expect(claudeEnv).toMatchObject({
        ANTHROPIC_API_KEY: "anthropic-secret",
        CLAUDE_CODE_OAUTH_TOKEN: "claude-token",
        LC_TEST: "locale",
      });
      expect(claudeEnv).not.toHaveProperty("GH_TOKEN");
      expect(claudeEnv).not.toHaveProperty("XAI_API_KEY");
      expect(claudeEnv).not.toHaveProperty("OPENAI_API_KEY");

      const codexEnv = cleanEnv(codex.env);
      expect(codexEnv.CODEX_HOME).toBe("/caller/codex");
      const grokEnv = cleanEnv(grok.env);
      expect(grokEnv.GROK_HOME).toBe("/caller/grok");
      for (const env of [codexEnv, grokEnv]) {
        for (const secret of ["GH_TOKEN", "ANTHROPIC_API_KEY", "XAI_API_KEY", "OPENAI_API_KEY"])
          expect(env).not.toHaveProperty(secret);
      }
      for (const env of [claudeEnv, codexEnv, grokEnv]) {
        expect(env).toMatchObject({
          HTTPS_PROXY: "http://proxy.invalid:3128",
          NODE_EXTRA_CA_CERTS: "/caller/ca.pem",
          AK_TEST_OPTED_IN: "opted-in",
        });
        expect(env).not.toHaveProperty("AK_TEST_STRAY");
        expect(env).not.toHaveProperty("AK_TEST_UNSET");
        expect(env).not.toHaveProperty("AK_EVAL_PASS_ENV");
        expect(env).not.toHaveProperty("CLAUDECODE");
        expect(env).not.toHaveProperty("CLAUDE_CODE_ENTRYPOINT");
      }
    });
  });

  test("cloud provider variables reach a claude subject only under the matching provider flag, and no other host", () => {
    const aws = {
      AWS_REGION: "caller-region",
      AWS_PROFILE: "caller-profile",
      AWS_ACCESS_KEY_ID: "aws-id",
      AWS_SECRET_ACCESS_KEY: "aws-secret",
      AWS_SESSION_TOKEN: "aws-session",
    };
    const vertex = {
      ANTHROPIC_VERTEX_PROJECT_ID: "caller-project",
      CLOUD_ML_REGION: "caller-ml-region",
      GOOGLE_APPLICATION_CREDENTIALS: "/caller/gcp.json",
    };
    const exported = { ...aws, ...vertex, AK_EVAL_PASS_ENV: undefined };
    withCallerEnv({ ...exported, CLAUDE_CODE_USE_BEDROCK: undefined, CLAUDE_CODE_USE_VERTEX: undefined }, () => {
      absent(cleanEnv(claude.env), { ...aws, ...vertex });
    });
    for (const off of ["", "0", "false", "no", "off", "FALSE"]) {
      withCallerEnv({ ...exported, CLAUDE_CODE_USE_BEDROCK: off, CLAUDE_CODE_USE_VERTEX: off }, () => {
        absent(cleanEnv(claude.env), { ...aws, ...vertex });
      });
    }
    for (const on of ["1", "true", "yes", "on", "TRUE"]) {
      withCallerEnv({ ...exported, CLAUDE_CODE_USE_BEDROCK: on, CLAUDE_CODE_USE_VERTEX: undefined }, () => {
        const env = cleanEnv(claude.env);
        expect(env).toMatchObject(aws);
        absent(env, vertex);
      });
    }
    withCallerEnv({ ...exported, CLAUDE_CODE_USE_BEDROCK: undefined, CLAUDE_CODE_USE_VERTEX: "1" }, () => {
      const env = cleanEnv(claude.env);
      expect(env).toMatchObject(vertex);
      absent(env, aws);
    });
    withCallerEnv({ ...exported, CLAUDE_CODE_USE_BEDROCK: "1", CLAUDE_CODE_USE_VERTEX: "1" }, () => {
      for (const env of [cleanEnv(codex.env), cleanEnv(grok.env)]) absent(env, { ...aws, ...vertex });
    });
  });

  test("a parent-session name cannot be opted in: the strip before the host starts still removes it", () => {
    const planted = {
      AK_EVAL_PASS_ENV: "CLAUDE_CODE_SKIP_BEDROCK_AUTH EVAL_CANARY AK_TEST_OPTED_IN",
      CLAUDE_CODE_SKIP_BEDROCK_AUTH: "1",
      EVAL_CANARY: "canary",
      AK_TEST_OPTED_IN: "opted-in",
      CLAUDE_CODE_OAUTH_TOKEN: "claude-token",
    };
    withCallerEnv(planted, () => {
      for (const adapter of [claude, codex, grok]) {
        const spawned = withoutParentSession(cleanEnv(adapter.env));
        expect(spawned).not.toHaveProperty("CLAUDE_CODE_SKIP_BEDROCK_AUTH");
        expect(spawned).not.toHaveProperty("EVAL_CANARY");
        expect(spawned.AK_TEST_OPTED_IN).toBe("opted-in");
      }
      expect(withoutParentSession(cleanEnv(claude.env)).CLAUDE_CODE_OAUTH_TOKEN).toBe("claude-token");
    });
  });

  test("codex and grok get a private home with the credentials and the bundle's skills; claude isolates by argv and drops CLAUDE.md", () => {
    const callerHome = join(scratch, "caller");
    mkdirSync(join(callerHome, ".codex"), { recursive: true });
    mkdirSync(join(callerHome, ".grok"), { recursive: true });
    writeFileSync(join(callerHome, ".codex", "auth.json"), '{"codex":1}');
    writeFileSync(join(callerHome, ".grok", "auth.json"), '{"grok":1}');
    const bundle = join(scratch, "dist");
    mkdirSync(join(bundle, "skills", "super-align"), { recursive: true });
    writeFileSync(join(bundle, "skills", "super-align", "SKILL.md"), "---\nname: super-align\n---\n");

    const c = codex.isolate!(join(scratch, "s1"), { ...req, env: { HOME: callerHome }, bundleDir: bundle });
    expect(readFileSync(join(c.env.CODEX_HOME!, "auth.json"), "utf8")).toBe('{"codex":1}');
    expect(existsSync(join(c.env.CODEX_HOME!, "skills", "super-align", "SKILL.md"))).toBe(true);
    expect(c.env.HOME).not.toBe(callerHome);

    const g = grok.isolate!(join(scratch, "s2"), { ...req, env: { HOME: callerHome }, bundleDir: bundle });
    expect(existsSync(join(g.env.GROK_HOME!, "skills", "super-align", "SKILL.md"))).toBe(true);
    expect(g.env.GROK_CLAUDE_SKILLS_ENABLED).toBe("false");
    expect(g.env.GROK_MEMORY).toBe("0");

    const hooks = join(String(g.env.GROK_HOME), "hooks");
    const registered: unknown = JSON.parse(readFileSync(join(hooks, "assignment-read-chain.json"), "utf8"));
    const script = join(hooks, "assignment-read-chain.sh");
    expect(registered).toEqual({
      hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: script, timeout: 30 }] }] },
    });
    expect(isAbsolute(script)).toBe(true);
    const run = (file: string, args: string[], stdin: string) => {
      const ran = spawnSync(file, args, { cwd: scratch, input: stdin, encoding: "utf8", timeout: 5000 });
      return [ran.status, ran.stdout];
    };
    const hook = (stdin: string) => {
      const asPath = run(script, [], stdin);
      expect(run("/bin/sh", ["-c", script], stdin)).toEqual(asPath);
      return asPath;
    };
    const event = (command: string, toolInputTruncated = false) =>
      JSON.stringify({
        hook_event_name: "PreToolUse",
        toolName: "run_terminal_command",
        toolInput: { command, description: `List files under ${hooks}` },
        toolInputTruncated,
      });
    const chain = 'SESSION="/scratch/s1"; find "$SESSION" -maxdepth 3 -type d | head -80';
    const [status, stdout] = hook(event(chain));
    expect(status).toBe(0);
    expect(JSON.parse(String(stdout))).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        updatedInput: {
          command: "find '/scratch/s1' '-maxdepth' '3' '-type' 'd' | head '-80'",
          description: `List files under ${hooks}`,
        },
      },
    });
    expect(hook(event(chain, true))).toEqual([0, ""]);
    expect(hook(event('OUT=/scratch/out.txt; echo changed > "$OUT"'))).toEqual([0, ""]);
    expect(hook(JSON.stringify({ toolInput: { file_path: "a.md" } }))).toEqual([0, ""]);
    expect(hook("not json")).toEqual([0, ""]);

    expect(claude.isolate!(scratch, req).env).toEqual({
      CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    });
    expect(
      withoutParentSession({
        CLAUDE_CODE_ENTRYPOINT: "cli",
        EVAL_X: "1",
        CLAUDECODE: "1",
        ANTHROPIC_API_KEY: "k",
        PATH: "/bin",
      }),
    ).toEqual({ ANTHROPIC_API_KEY: "k", PATH: "/bin" });
    const auth = { CLAUDE_CODE_OAUTH_TOKEN: "t", CLAUDE_CODE_USE_BEDROCK: "1", CLAUDE_CODE_USE_VERTEX: "1" };
    expect(withoutParentSession({ ...auth, CLAUDE_CODE_SSE_PORT: "1" })).toEqual(auth);
    expect(BUNDLE_FOR).toEqual({ claude: "claude-code", codex: "codex", grok: "claude-code", kimi: "claude-code" });
  });

  test("a refreshed credential is written back only while the caller's copy is unchanged", () => {
    const creds = join(scratch, "creds.json");
    writeFileSync(creds, "v1");
    const home = privateHome(join(scratch, "h1"), creds, undefined, "skills");
    writeFileSync(join(home.dir, "auth.json"), "v2");
    home.release();
    expect(readFileSync(creds, "utf8")).toBe("v2");

    const other = privateHome(join(scratch, "h2"), creds, undefined, "skills");
    writeFileSync(join(other.dir, "auth.json"), "v3");
    writeFileSync(creds, "refreshed-elsewhere");
    other.release();
    expect(readFileSync(creds, "utf8")).toBe("refreshed-elsewhere");
  });
});

describe("runSubject", () => {
  test("runs the adapter's argv under its isolation env, parses stdout, and releases", async () => {
    let released = false;
    const fake: SubjectAdapter = {
      ...claude,
      command: () => ["sh", "-c", 'printf \'{"type":"result","result":"%s","num_turns":1}\\n\' "$MARK"'],
      isolate: () => ({ env: { MARK: "isolated" }, leaks: ["none"], release: () => (released = true) }),
    };
    const result = await runSubject(fake, "subject-a", "bound-a", {
      ...req,
      cwd: scratch,
      env: { PATH: process.env.PATH ?? "" },
    });
    expect(result).toMatchObject({
      subject: "subject-a",
      host: "claude",
      reply: "isolated",
      exitCode: 0,
      timedOut: false,
      turns: 1,
      leaks: ["none"],
    });
    expect(released).toBe(true);
  });

  test("adapterFor knows every host", () => {
    expect(adapterFor("claude").host).toBe("claude");
    expect(adapterFor("codex").host).toBe("codex");
    expect(adapterFor("grok").host).toBe("grok");
    expect(adapterFor("kimi").host).toBe("kimi");
  });

  test("a price table derives cost only for a matching bound Codex session", async () => {
    const priceFile = join(scratch, "placeholder-prices.json");
    writeFileSync(
      priceFile,
      JSON.stringify({
        version: 1,
        as_of: "2026-01-02",
        source: "https://prices.invalid/placeholder",
        verified_against_live_session: false,
        models: {
          "model-placeholder": {
            input_per_million_usd: 3,
            cached_input_per_million_usd: 0.75,
            output_per_million_usd: 8,
          },
        },
      }),
    );
    const prices = loadPriceTable(priceFile);
    const usage: TokenUsage = {
      inputTokens: 2_000_000,
      cachedInputTokens: 500_000,
      cacheWriteInputTokens: 0,
      outputTokens: 100_000,
      reasoningOutputTokens: 25_000,
      totalTokens: 2_100_000,
    };
    expect(costOf(usage, prices.models["model-placeholder"])).toBe(5.675);
    expect(costOf(usage, prices.models["missing-placeholder"])).toBeUndefined();

    const fakeCodex: SubjectAdapter = {
      ...codex,
      command: () => ["printf", "%s", "ignored"],
      run: undefined,
      parse: () => ({ events: [], reply: "ok", usage }),
      isolate: undefined,
    };
    const priced = await runSubject(
      fakeCodex,
      "subject-placeholder",
      "model-placeholder",
      {
        ...req,
        cwd: scratch,
        env: { PATH: process.env.PATH ?? "" },
      },
      prices,
    );
    expect(priced.usage).toEqual(usage);
    expect(priced.costUsd).toBe(5.675);

    const unpriced = await runSubject(
      fakeCodex,
      "subject-placeholder",
      "missing-placeholder",
      {
        ...req,
        cwd: scratch,
        env: { PATH: process.env.PATH ?? "" },
      },
      prices,
    );
    expect(unpriced.usage).toEqual(usage);
    expect(unpriced.costUsd).toBeUndefined();
  });
});

describe("eval receipt instrument", () => {
  test("names the revision, donor availability, and the install clause with the tracker's state", () => {
    const root = join(scratch, "instrument");
    for (const rel of ["catalog.yaml", "adapters"])
      cpSync(join(PACKAGE_ROOT, rel), join(root, rel), { recursive: true });
    const bare = evalInstrument(root, "abc123");
    expect(bare.revision).toBe("abc123");
    expect(bare.donors_present).toBe(false);
    expect(bare.install_config).toStartWith("no ak.install.yaml: default, all fail-closed adapters attached (");
    expect(bare.install_config).toContain("tracker: no backend");

    mkdirSync(join(root, ".donors"));
    writeFileSync(join(root, "ak.install.yaml"), "attached: [tracker]\n");
    const unconfigured = evalInstrument(root, "def456");
    expect(unconfigured.revision).toBe("def456");
    expect(unconfigured.donors_present).toBe(true);
    expect(unconfigured.install_config).toStartWith("ak.install.yaml: attached tracker; tracker: no backend");

    writeFileSync(join(root, "ak.install.yaml"), "attached: [tracker]\ntracker:\n  backend: some-tracker\n");
    expect(evalInstrument(root, "def456").install_config).toBe(
      "ak.install.yaml: attached tracker; tracker: backend some-tracker",
    );
  });

  test("refuses to describe a root that has no catalog", () => {
    const root = join(scratch, "no-catalog");
    mkdirSync(root);
    expect(() => evalInstrument(root, "abc123")).toThrow("catalog.yaml");
  });

  test("refuses an install file it cannot read rather than recording the host alone", () => {
    const root = join(scratch, "bad-install");
    for (const rel of ["catalog.yaml", "adapters"])
      cpSync(join(PACKAGE_ROOT, rel), join(root, rel), { recursive: true });
    writeFileSync(join(root, "ak.install.yaml"), "attached: tracker\n");
    expect(() => evalInstrument(root, "abc123")).toThrow("ak.install.yaml: Declares no 'attached:' list");
    writeFileSync(join(root, "ak.install.yaml"), "attached: [\n");
    expect(() => evalInstrument(root, "abc123")).toThrow("ak.install.yaml: Not valid YAML");
  });
});
