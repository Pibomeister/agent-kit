/**
 * The subject adapters on stored transcripts. `*-skill.jsonl` and `grok-denied-write.jsonl` are
 * real headless sessions (one per host, scrubbed of paths and bindings); `*.doc-derived.jsonl` are
 * written from each host's documented event shapes to reach tools the live sessions did not call.
 * No host CLI runs here.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PACKAGE_ROOT } from "../../src/learn/core/roles.ts";
import { skillLoads } from "./evals/trigger-eval.ts";
import { claude } from "./evals/subjects/claude.ts";
import { codex } from "./evals/subjects/codex.ts";
import { grok } from "./evals/subjects/grok.ts";
import { privateHome } from "./evals/subjects/home.ts";
import { adapterFor, BUNDLE_FOR, runSubject, withoutParentSession } from "./evals/subjects/index.ts";
import { readsOf, unwrap, words } from "./evals/subjects/shell.ts";
import type { SessionRequest, SubjectAdapter, ToolEvent } from "./evals/subjects/types.ts";
import { evalInstrument } from "./evals/session.ts";

const FIXTURES = join(import.meta.dir, "evals", "fixtures", "transcripts");
const fixture = (name: string) => readFileSync(join(FIXTURES, name), "utf8");
const tools = (events: ReturnType<SubjectAdapter["parse"]>["events"]) => events.filter((e): e is ToolEvent => e.kind === "tool");

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "ak-subjects-test-")));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const req: SessionRequest = { prompt: "Load the greet skill.", cwd: "/scratch/repo", env: {}, timeoutMs: 1000 };

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

  test("a typed slash command's expansion becomes a user event the scorer reads as a load; tool results do not", () => {
    const expansion = JSON.stringify({
      type: "user",
      message: { content: [{ type: "text", text: "<command-message>ak:compound is running</command-message>\n<command-name>/ak:compound</command-name>" }] },
    });
    const toolResult = JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", content: "file contents" }] } });
    const parsed = claude.parse(`${expansion}\n${toolResult}\n${JSON.stringify({ type: "result", result: "done" })}`);
    expect(parsed.events.map((e) => e.kind)).toEqual(["user"]);
    expect(skillLoads(parsed.events).map((l) => [l.skill, l.via])).toEqual([["compound", "expansion"]]);
  });

  test("argv: isolation flags always, model, cap, bundle and appended context only when given", () => {
    expect(claude.command(req, undefined)).toEqual([
      "claude", "-p", "--output-format", "stream-json", "--verbose",
      "--settings", '{"disableAllHooks":true}', "--setting-sources", "project,local", "--strict-mcp-config",
      "--no-session-persistence",
      "Load the greet skill.",
    ]);
    const full = claude.command({ ...req, maxTurns: 3, bundleDir: "/dist/claude-code", appendSystemPrompt: "ROSTER" }, "bound-a");
    expect(full.slice(5, 9)).toEqual(["--model", "bound-a", "--max-turns", "3"]);
    expect(full).toContain("--plugin-dir");
    expect(full.slice(-3)).toEqual(["--append-system-prompt", "ROSTER", "Load the greet skill."]);
    expect(claude.injection).toBe("append-system-prompt");
  });
});

describe("codex", () => {
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
      "Bash", "Read", "Read", "Write", "Edit", "mcp__tracker__get_issue", "WebSearch", "Bash",
    ]);
    const reads = tools(parsed.events).filter((e) => e.name === "Read").map((e) => e.input.file_path);
    expect(reads).toEqual(["skills/super-align/SKILL.md", "README.md"]);
    expect(parsed.reply).toBe("Loaded super-align.");
    expect(tools(parsed.events).at(-1)!.input.command).toBe("bun test");
  });

  test("a deleted file, or a change of a kind not listed, is a mutating tool", () => {
    const stdout = JSON.stringify({ type: "item.completed", item: { id: "1", type: "file_change", changes: [{ path: "a.md", kind: "delete" }, { path: "b.md", kind: "rename" }] } });
    expect(tools(codex.parse(stdout).events).map((e) => [e.name, e.input.file_path])).toEqual([
      ["Delete", "a.md"],
      ["Edit", "b.md"],
    ]);
  });

  test("argv: appended context is a developer_instructions TOML string; no turn cap flag exists", () => {
    const argv = codex.command({ ...req, maxTurns: 4, appendSystemPrompt: 'line "one"\nline two' }, "bound-b");
    expect(argv.slice(0, 2)).toEqual(["codex", "exec"]);
    expect(argv).toContain("--json");
    expect(argv.slice(argv.indexOf("-m"), argv.indexOf("-m") + 2)).toEqual(["-m", "bound-b"]);
    expect(argv).toContain('developer_instructions="line \\"one\\"\\nline two"');
    expect(argv.join(" ")).not.toContain("turn");
    expect(argv.at(-1)).toBe("Load the greet skill.");
    expect(codex.injection).toBe("developer-instructions");
  });

  test("argv: the caller's connected apps are off, as plugins are", () => {
    // On 2026-09-28 codex subjects searched the operator's connected GitHub, Vercel and Drive apps.
    expect(codex.command(req, undefined).join(" ")).toContain("--disable plugins --disable remote_plugin --disable apps");
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
    expect(grok.parse(end({ "model-under-test": {}, "helper-under-test": {} })).model).toBe("helper-under-test,model-under-test");
    expect(grok.parse(end({})).model).toBeUndefined();
  });

  test("a live session under dontAsk: the refused write is still an Edit event, and there is no reply", () => {
    const parsed = grok.parse(fixture("grok-denied-write.jsonl"));
    expect(tools(parsed.events).map((e) => e.name)).toEqual(["Read", "Edit"]);
    expect(parsed.reply).toBe("");
    expect(parsed.stopReason).toBe("cancelled");
  });

  test("a session that ends normally reports its stop reason", () => {
    expect(grok.parse(JSON.stringify({ type: "end", stopReason: "end_turn", num_turns: 1 })).stopReason).toBe("end_turn");
  });

  test("documented tools map onto the shared names; unmapped ones keep their own", () => {
    const parsed = grok.parse(fixture("grok-tools.doc-derived.jsonl"));
    expect(tools(parsed.events).map((e) => e.name)).toEqual(["Grep", "Bash", "Read", "list_dir", "Write"]);
    expect(parsed.events.filter((e) => e.kind === "message").map((e) => (e.kind === "message" ? e.text : ""))).toEqual(["Reading it now.", "ok"]);
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
    expect(allow).toEqual([
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
    ]);
    expect(argv).not.toContain("--always-approve");
    expect(allow).not.toContain("Bash");
    expect(allow.some((rule) => rule?.startsWith("Write") || rule?.startsWith("Edit"))).toBe(false);
    expect(argv.slice(argv.indexOf("--permission-mode"), argv.indexOf("--permission-mode") + 2)).toEqual(["--permission-mode", "dontAsk"]);
  });
});

describe("shell reads", () => {
  test("unwraps login shells and finds printed files across pipelines, skipping options, scripts and output redirects", () => {
    expect(unwrap("/bin/zsh -lc 'cat a b'")).toBe("cat a b");
    expect(unwrap("bash -lc \"head -n 5 x\"")).toBe("head -n 5 x");
    expect(words(`cat "a b" 'c' d\\ e && ls`)).toEqual(["cat", "a b", "c", "d e", "&&", "ls"]);
    expect(words("git status 2>&1 >&2 &>/dev/null & ls")).toEqual(["git", "status", "2>&1", ">&2", "&>/dev/null", "&", "ls"]);
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

describe("isolation", () => {
  test("codex and grok get a private home with the credentials and the bundle's skills; claude isolates by argv and drops CLAUDE.md", () => {
    const callerHome = join(scratch, "caller");
    mkdirSync(join(callerHome, ".codex"), { recursive: true });
    mkdirSync(join(callerHome, ".grok"), { recursive: true });
    writeFileSync(join(callerHome, ".codex", "auth.json"), "{\"codex\":1}");
    writeFileSync(join(callerHome, ".grok", "auth.json"), "{\"grok\":1}");
    const bundle = join(scratch, "dist");
    mkdirSync(join(bundle, "skills", "super-align"), { recursive: true });
    writeFileSync(join(bundle, "skills", "super-align", "SKILL.md"), "---\nname: super-align\n---\n");

    const c = codex.isolate!(join(scratch, "s1"), { ...req, env: { HOME: callerHome }, bundleDir: bundle });
    expect(readFileSync(join(c.env.CODEX_HOME!, "auth.json"), "utf8")).toBe("{\"codex\":1}");
    expect(existsSync(join(c.env.CODEX_HOME!, "skills", "super-align", "SKILL.md"))).toBe(true);
    expect(c.env.HOME).not.toBe(callerHome);

    const g = grok.isolate!(join(scratch, "s2"), { ...req, env: { HOME: callerHome }, bundleDir: bundle });
    expect(existsSync(join(g.env.GROK_HOME!, "skills", "super-align", "SKILL.md"))).toBe(true);
    expect(g.env.GROK_CLAUDE_SKILLS_ENABLED).toBe("false");
    expect(g.env.GROK_MEMORY).toBe("0");

    expect(claude.isolate!(scratch, req).env).toEqual({ CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1", CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" });
    expect(withoutParentSession({ CLAUDE_CODE_ENTRYPOINT: "cli", EVAL_X: "1", CLAUDECODE: "1", ANTHROPIC_API_KEY: "k", PATH: "/bin" })).toEqual({ ANTHROPIC_API_KEY: "k", PATH: "/bin" });
    const auth = { CLAUDE_CODE_OAUTH_TOKEN: "t", CLAUDE_CODE_USE_BEDROCK: "1", CLAUDE_CODE_USE_VERTEX: "1" };
    expect(withoutParentSession({ ...auth, CLAUDE_CODE_SSE_PORT: "1" })).toEqual(auth);
    expect(BUNDLE_FOR).toEqual({ claude: "claude-code", codex: "codex", grok: "claude-code" });
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
    const result = await runSubject(fake, "subject-a", "bound-a", { ...req, cwd: scratch, env: { PATH: process.env.PATH ?? "" } });
    expect(result).toMatchObject({ subject: "subject-a", host: "claude", reply: "isolated", exitCode: 0, timedOut: false, turns: 1, leaks: ["none"] });
    expect(released).toBe(true);
  });

  test("adapterFor knows every host", () => {
    expect(adapterFor("claude").host).toBe("claude");
    expect(adapterFor("codex").host).toBe("codex");
    expect(adapterFor("grok").host).toBe("grok");
  });
});

describe("eval receipt instrument", () => {
  test("names the revision, donor availability, and the install clause with the tracker's state", () => {
    const root = join(scratch, "instrument");
    for (const rel of ["catalog.yaml", "adapters"]) cpSync(join(PACKAGE_ROOT, rel), join(root, rel), { recursive: true });
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
    expect(evalInstrument(root, "def456").install_config).toBe("ak.install.yaml: attached tracker; tracker: backend some-tracker");
  });

  test("refuses to describe a root that has no catalog", () => {
    const root = join(scratch, "no-catalog");
    mkdirSync(root);
    expect(() => evalInstrument(root, "abc123")).toThrow("catalog.yaml");
  });
});
