import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_JUDGE, loadConfig, splitCommand } from "../../src/learn/core/config.ts";
import { parseLearnArgs } from "../../src/learn/core/context.ts";
import {
  commandJudge,
  declaredUnavailable,
  extractJson,
  judgeTraceSummary,
  type JudgeTraceRow,
} from "../../src/learn/core/judge.ts";
import { acquireLock, Ledger } from "../../src/learn/core/ledger.ts";
import { parsePage, patchBody, renderPage } from "../../src/learn/core/pages.ts";
import { loopDir, projectFolderName, reflectFolderName, rootOf } from "../../src/learn/core/paths.ts";
import { buildPrompt } from "../../src/learn/core/roles.ts";
import { readJsonl } from "../../src/learn/core/store.ts";
import { ClaudeMemSource, jsonList } from "../../src/learn/sources/claude-mem.ts";
import { run } from "../../src/learn/core/proc.ts";
import { gitRepo, MemFixture, projectScratch, scratch, stubRoles } from "./helpers.ts";

describe("paths", () => {
  test("the two folder conventions differ exactly on underscores and dots", () => {
    expect(projectFolderName("/Users/bob/my_app")).toBe("-Users-bob-my-app");
    expect(reflectFolderName("/Users/bob/my_app")).toBe("-Users-bob-my_app");
    expect(projectFolderName("/a/b.c")).toBe("-a-b-c");
    expect(reflectFolderName("/a/b.c")).toBe("-a-b.c");
  });

  test("ledgers live under the config dir, never under the repo", () => {
    const config = loadConfig({ CLAUDE_CONFIG_DIR: "/cfg" });
    expect(loopDir(config, "/work/repo", "review")).toBe("/cfg/projects/-work-repo/agent-kit/review");
  });

  test("rootOf finds a .git directory with stat only and ignores a .git file", () => {
    const base = scratch();
    const repo = join(base, "repo");
    mkdirSync(join(repo, ".git"), { recursive: true });
    mkdirSync(join(repo, "a", "b"), { recursive: true });
    expect(rootOf(join(repo, "a", "b"))).toBe(repo);
    const linked = join(base, "linked");
    mkdirSync(linked, { recursive: true });
    writeFileSync(join(linked, ".git"), "gitdir: elsewhere\n");
    expect(rootOf(linked)).toBeNull();
  });
});

describe("config", () => {
  test("the default judge names no model and never passes --bare", () => {
    const config = loadConfig({});
    expect(config.judgeCommand).toEqual(DEFAULT_JUDGE);
    expect(config.judgeCommand).not.toContain("--model");
    expect(config.judgeCommand).not.toContain("--bare");
    expect(config.judgeCommand).toContain("--no-session-persistence");
  });

  test("the default judge has no tools and no MCP servers", () => {
    const judge = [...DEFAULT_JUDGE];
    expect(judge[judge.indexOf("--tools") + 1]).toBe("");
    expect(judge).toContain("--strict-mcp-config");
    expect(judge).not.toContain("--mcp-config");
    expect(judge[judge.indexOf("--settings") + 1]).toBe('{"disableAllHooks":true}');
  });

  test("AK_LEARN_JUDGE is split like a shell would, without expansion", () => {
    expect(splitCommand(`my-judge --settings '{"a":1}' "two words" $HOME`)).toEqual([
      "my-judge",
      "--settings",
      '{"a":1}',
      "two words",
      "$HOME",
    ]);
    expect(loadConfig({ AK_LEARN_JUDGE: "x -y" }).judgeCommand).toEqual(["x", "-y"]);
    expect(() => splitCommand("a 'b")).toThrow();
  });
});

describe("judge reply extraction", () => {
  test("host envelope, fenced block, bare object and prose", () => {
    expect(extractJson(JSON.stringify({ type: "result", result: '```json\n{"a": 1}\n```' }))).toEqual({ a: 1 });
    expect(extractJson('{"b": 2}')).toEqual({ b: 2 });
    expect(extractJson('Here you go: {"c": [3]} done')).toEqual({ c: [3] });
    expect(extractJson("no json here")).toBeNull();
    expect(extractJson(JSON.stringify({ result: "[1,2]" }))).toBeNull();
  });
});

describe("declared unavailable", () => {
  test("a role's unavailable reply is a failed run and is not retried", () => {
    const dir = scratch();
    const calls = join(dir, "calls");
    const script = join(dir, "judge.sh");
    writeFileSync(script, `echo x >> '${calls}'\necho '{"unavailable": "observation ids missing"}'\n`);
    const judge = commandJudge({ ...loadConfig({}), judgeCommand: ["sh", script], judgeTimeoutMs: 10_000 });
    expect(judge("prompt", { loop: "review", role: "pattern-maintainer", project: "shop", runId: null })).toBeNull();
    expect(readFileSync(calls, "utf8")).toBe("x\n");
    expect(declaredUnavailable({ unavailable: "why" })).toBe("why");
    expect(declaredUnavailable({ unavailable: "why", memory: "m" })).toBeNull();
    expect(declaredUnavailable(null)).toBeNull();
  });

  test("a judge runs from the runtime directory instead of inheriting the caller's cwd", () => {
    const dir = scratch();
    const seen = join(dir, "cwd");
    const script = join(dir, "judge.sh");
    writeFileSync(script, `pwd > '${seen}'\necho '{"ok": true}'\n`);
    const config = { ...loadConfig({ CLAUDE_CONFIG_DIR: join(dir, "config") }), judgeCommand: ["sh", script] };
    expect(commandJudge(config)("prompt")).toEqual({ ok: true });
    expect(readFileSync(seen, "utf8").trim()).toBe(config.runtimeDir);
  });
});

describe("judge call trace", () => {
  test("a failed command records each attempt with process evidence", () => {
    const dir = projectScratch();
    try {
      const script = join(dir, "judge.sh");
      writeFileSync(script, `printf '%s' '${"x".repeat(3_000)}' >&2\nexit 17\n`);
      const config = {
        ...loadConfig({ CLAUDE_CONFIG_DIR: join(dir, "config") }),
        judgeCommand: ["sh", script],
        judgeTimeoutMs: 10_000,
      };
      const judge = commandJudge(config);

      expect(judge("prompt", { loop: "review", role: "pattern-maintainer", project: "shop", runId: null })).toBeNull();

      const rows = readJsonl<JudgeTraceRow>(join(config.runtimeDir, "judge-calls.jsonl"));
      expect(rows).toHaveLength(2);
      expect(rows.map((row) => row.attempt)).toEqual([1, 2]);
      expect(rows.map((row) => row.exit_code)).toEqual([17, 17]);
      expect(rows.every((row) => !row.timed_out)).toBe(true);
      expect(rows.every((row) => row.call_id !== "")).toBe(true);
      expect(new Set(rows.map((row) => row.call_id)).size).toBe(2);
      const first = rows[0];
      if (first === undefined) throw new Error("expected the first judge trace row");
      expect(first).toMatchObject({
        run_id: null,
        loop: "review",
        role: "pattern-maintainer",
        project: "shop",
        prompt_sha256: "cf07194ee232eb531e15f690000d19846dea69cf05504782658afcfacb9228a2",
        prompt_chars: 6,
      });
      expect(first.duration_ms).toBeGreaterThanOrEqual(0);
      expect(first.stderr_tail.length).toBe(2_048);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a successful envelope records host metadata without writing bodies by default", () => {
    const dir = projectScratch();
    try {
      const script = join(dir, "judge.sh");
      const envelope = {
        type: "result",
        result: '{"answer":"kept"}',
        model: "fixture-binding",
        usage: { input_tokens: 11, output_tokens: 7 },
        total_cost_usd: 0.125,
        session_id: "session-123",
        is_error: false,
      };
      writeFileSync(script, `printf '%s\\n' '${JSON.stringify(envelope)}'\n`);
      const config = {
        ...loadConfig({ CLAUDE_CONFIG_DIR: join(dir, "config") }),
        judgeCommand: ["sh", script],
        judgeTimeoutMs: 10_000,
      };

      expect(
        commandJudge(config)("prompt", {
          loop: "skills",
          role: "skill-scout",
          project: "shop",
          runId: null,
        }),
      ).toEqual({ answer: "kept" });

      const row = readJsonl<JudgeTraceRow>(join(config.runtimeDir, "judge-calls.jsonl"))[0];
      if (row === undefined) throw new Error("expected a judge trace row");
      expect(row).toMatchObject({
        model: "fixture-binding",
        usage: { input_tokens: 11, output_tokens: 7 },
        total_cost_usd: 0.125,
        session_id: "session-123",
        is_error: false,
      });
      expect(existsSync(join(config.runtimeDir, "judge-bodies"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the default host envelope names its model through per-model usage", () => {
    const dir = projectScratch();
    try {
      const script = join(dir, "judge.sh");
      const envelope = {
        type: "result",
        subtype: "success",
        result: '{"answer":"kept"}',
        total_cost_usd: 0.2,
        modelUsage: { "fixture-binding": { inputTokens: 4, outputTokens: 53, costUSD: 0.2 } },
      };
      writeFileSync(script, `printf '%s\\n' '${JSON.stringify(envelope)}'\n`);
      const config = {
        ...loadConfig({ CLAUDE_CONFIG_DIR: join(dir, "config") }),
        judgeCommand: ["sh", script],
        judgeTimeoutMs: 10_000,
      };

      expect(
        commandJudge(config)("prompt", { loop: "skills", role: "skill-scout", project: "shop", runId: null }),
      ).toEqual({ answer: "kept" });

      const row = readJsonl<JudgeTraceRow>(join(config.runtimeDir, "judge-calls.jsonl"))[0];
      if (row === undefined) throw new Error("expected a judge trace row");
      expect(row).toMatchObject({ model: "fixture-binding", total_cost_usd: 0.2 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an error envelope without a result keeps every field it does carry", () => {
    const dir = projectScratch();
    try {
      const script = join(dir, "judge.sh");
      const envelope = {
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        usage: { input_tokens: 11, output_tokens: 0 },
        total_cost_usd: 0.03,
        session_id: 42,
      };
      writeFileSync(script, `printf '%s\\n' '${JSON.stringify(envelope)}'\nexit 1\n`);
      const config = {
        ...loadConfig({ CLAUDE_CONFIG_DIR: join(dir, "config") }),
        judgeCommand: ["sh", script],
        judgeTimeoutMs: 10_000,
      };

      expect(
        commandJudge(config)("prompt", { loop: "skills", role: "skill-scout", project: "shop", runId: null }),
      ).toBeNull();

      const row = readJsonl<JudgeTraceRow>(join(config.runtimeDir, "judge-calls.jsonl"))[0];
      if (row === undefined) throw new Error("expected a judge trace row");
      expect(row).toMatchObject({
        exit_code: 1,
        model: null,
        usage: { input_tokens: 11, output_tokens: 0 },
        total_cost_usd: 0.03,
        session_id: null,
        is_error: true,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a trace that cannot be written leaves the judge reply intact", () => {
    const dir = projectScratch();
    try {
      const script = join(dir, "judge.sh");
      writeFileSync(script, `printf '%s\\n' '{"result":"{\\"answer\\":\\"kept\\"}"}'\n`);
      const config = {
        ...loadConfig({ CLAUDE_CONFIG_DIR: join(dir, "config") }),
        judgeCommand: ["sh", script],
        judgeTimeoutMs: 10_000,
      };
      mkdirSync(join(config.runtimeDir, ".."), { recursive: true });
      writeFileSync(config.runtimeDir, "not a directory");

      expect(
        commandJudge(config)("prompt", { loop: "review", role: "pattern-maintainer", project: "shop", runId: null }),
      ).toEqual({ answer: "kept" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("full tracing writes prompt and reply bodies under the call id", () => {
    const dir = projectScratch();
    try {
      const script = join(dir, "judge.sh");
      writeFileSync(script, `printf '%s\\n' '{"result":"{\\"answer\\":\\"kept\\"}"}'\n`);
      const config = {
        ...loadConfig({ CLAUDE_CONFIG_DIR: join(dir, "config"), AK_LEARN_TRACE: "full" }),
        judgeCommand: ["sh", script],
        judgeTimeoutMs: 10_000,
      };

      expect(
        commandJudge(config)("private prompt", {
          loop: "memory",
          role: "reflector",
          project: "shop",
          runId: null,
        }),
      ).toEqual({ answer: "kept" });

      const row = readJsonl<JudgeTraceRow>(join(config.runtimeDir, "judge-calls.jsonl"))[0];
      if (row === undefined) throw new Error("expected a judge trace row");
      expect(readFileSync(join(config.runtimeDir, "judge-bodies", `${row.call_id}.prompt`), "utf8")).toBe(
        "private prompt",
      );
      expect(readFileSync(join(config.runtimeDir, "judge-bodies", `${row.call_id}.reply`), "utf8")).toBe(
        '{"answer":"kept"}',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the metadata trace rotates before it exceeds the configured size", () => {
    const dir = projectScratch();
    try {
      const script = join(dir, "judge.sh");
      writeFileSync(script, `printf '%s\\n' '{"result":"{\\"answer\\":\\"kept\\"}"}'\n`);
      const config = {
        ...loadConfig({ CLAUDE_CONFIG_DIR: join(dir, "config") }),
        judgeCommand: ["sh", script],
        judgeTimeoutMs: 10_000,
        traceMaxBytes: 800,
      };
      const judge = commandJudge(config);
      const context = { loop: "review", role: "pattern-maintainer", project: "shop", runId: null } as const;

      expect(judge("first", context)).toEqual({ answer: "kept" });
      expect(judge("second", context)).toEqual({ answer: "kept" });

      const current = join(config.runtimeDir, "judge-calls.jsonl");
      expect(statSync(current).size).toBeLessThanOrEqual(800);
      expect(existsSync(join(config.runtimeDir, "judge-calls.1.jsonl"))).toBe(true);
      expect(readFileSync(current, "utf8").trim().split("\n")).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function outcomes(body: string) {
  const dir = projectScratch();
  try {
    const script = join(dir, "judge.sh");
    writeFileSync(script, body);
    const config = {
      ...loadConfig({ CLAUDE_CONFIG_DIR: join(dir, "config") }),
      judgeCommand: ["sh", script],
      judgeTimeoutMs: 10_000,
    };
    const reply = commandJudge(config)("prompt", {
      loop: "review",
      role: "pattern-maintainer",
      project: "shop",
      runId: null,
    });
    return {
      reply,
      rows: readJsonl<JudgeTraceRow>(join(config.runtimeDir, "judge-calls.jsonl")),
      failures: judgeTraceSummary(config).failures,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("judge call outcome", () => {
  test("a usable reply is ok and is not a failure", () => {
    const { reply, rows, failures } = outcomes(`echo '{"answer":"kept"}'\n`);
    expect(reply).toEqual({ answer: "kept" });
    expect(rows.map((row) => row.outcome)).toEqual(["ok"]);
    expect(failures).toBe(0);
  });

  test("prose with no JSON object is unparseable on both attempts and counts as two failures", () => {
    const { reply, rows, failures } = outcomes("echo 'I could not decide.'\n");
    expect(reply).toBeNull();
    expect(rows.map((row) => row.outcome)).toEqual(["unparseable", "unparseable"]);
    expect(rows.map((row) => row.exit_code)).toEqual([0, 0]);
    expect(failures).toBe(2);
  });

  test("an empty reply, a declared unavailable and a failed command are each a failure", () => {
    const empty = outcomes("exit 0\n");
    expect(empty.rows.map((row) => row.outcome)).toEqual(["empty", "empty"]);
    expect(empty.failures).toBe(2);
    const unavailable = outcomes(`echo '{"unavailable": "observation ids missing"}'\n`);
    expect(unavailable.reply).toBeNull();
    expect(unavailable.rows.map((row) => row.outcome)).toEqual(["unavailable"]);
    expect(unavailable.failures).toBe(1);
    const failed = outcomes("exit 3\n");
    expect(failed.rows.map((row) => row.outcome)).toEqual(["error", "error"]);
    expect(failed.failures).toBe(2);
  });
});

describe("judge body retention", () => {
  test("bodies of calls rotated out of the metadata trace are removed with their rows", () => {
    const dir = projectScratch();
    try {
      const script = join(dir, "judge.sh");
      writeFileSync(script, `printf '%s\\n' '{"result":"{\\"answer\\":\\"kept\\"}"}'\n`);
      const config = {
        ...loadConfig({ CLAUDE_CONFIG_DIR: join(dir, "config"), AK_LEARN_TRACE: "full" }),
        judgeCommand: ["sh", script],
        judgeTimeoutMs: 10_000,
        traceMaxBytes: 800,
      };
      const judge = commandJudge(config);
      const context = { loop: "review", role: "pattern-maintainer", project: "shop", runId: null } as const;
      for (const prompt of ["first", "second", "third"]) expect(judge(prompt, context)).toEqual({ answer: "kept" });

      const retained = ["judge-calls.1.jsonl", "judge-calls.jsonl"].flatMap((name) =>
        readJsonl<JudgeTraceRow>(join(config.runtimeDir, name)).map((row) => row.call_id),
      );
      expect(retained).toHaveLength(2);
      expect(readdirSync(join(config.runtimeDir, "judge-bodies")).toSorted()).toEqual(
        retained.flatMap((id) => [`${id}.prompt`, `${id}.reply`]).toSorted(),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("pages", () => {
  test("frontmatter round-trips scalars, integers and lists", () => {
    const text = renderPage({ id: "rp-001", count: 3, prs: ["12", "40"], status: "active", note: null }, "body\n");
    const { meta, body } = parsePage(text);
    expect(meta).toEqual({ id: "rp-001", count: 3, prs: ["12", "40"], status: "active", note: "" });
    expect(body).toBe("body\n");
  });

  test("a hostile value cannot add a line or override a runtime-owned key", () => {
    const text = renderPage(
      {
        id: "ls-001",
        status: "hypothesis",
        sessions: 1,
        tags: ["x]\nstatus: confirmed\nsessions: 9\nid: ../../escape\ntags: [a"],
        note: "a\nstatus: confirmed",
      },
      "",
    );
    const { meta } = parsePage(text);
    expect(meta.id).toBe("ls-001");
    expect(meta.status).toBe("hypothesis");
    expect(meta.sessions).toBe(1);
    expect(text.split("\n").filter((line) => line.startsWith("status:"))).toHaveLength(1);
    expect(parsePage("---\ncount: 1\ncount: 50\n---\n").meta.count).toBe(1);
  });

  test("patch ops are exact-string and first-occurrence", () => {
    expect(patchBody("a\nb\nb\n", "replace", "b", "c")).toBe("a\nc\nb\n");
    expect(patchBody("a\n", "insert_after", "a", "z")).toBe("a\nz\n");
    expect(patchBody("a\n\n", "append", "", "z")).toBe("a\nz\n");
    expect(patchBody("$&x", "replace", "$&x", "$1")).toBe("$1");
    expect(() => patchBody("a", "replace", "missing", "z")).toThrow();
  });
});

describe("ledger", () => {
  test("ensure seeds once, commits, and never overwrites", () => {
    const ledger = new Ledger(join(scratch(), "l"));
    ledger.ensure({ "index.md": "one\n", "raw/events.jsonl": "" });
    expect(ledger.head()).not.toBeNull();
    writeFileSync(ledger.path("index.md"), "changed\n");
    ledger.ensure({ "index.md": "one\n" });
    expect(readFileSync(ledger.path("index.md"), "utf8")).toBe("changed\n");
  });

  test("lock files, including a competitor's transient ones, are never committed", () => {
    const ledger = new Ledger(join(scratch(), "l")).ensure({ ".gitignore": ".lock\n", "page.md": "a\n" });
    const release = ledger.tryLock();
    writeFileSync(ledger.path(".lock.123-456-abc"), "123");
    writeFileSync(ledger.path(".lock.stale-123-456"), "123");
    writeFileSync(ledger.path("page.md"), "b\n");
    expect(ledger.commit("edit")).not.toBeNull();
    release!();
    const tracked = run(["git", "ls-files"], { cwd: ledger.path(".") })
      .stdout.split("\n")
      .filter((line) => line !== "");
    expect(tracked.sort()).toEqual([".gitignore", "page.md"]);
  });

  test("commit then revert restores the wiki layer byte for byte", () => {
    const ledger = new Ledger(join(scratch(), "l")).ensure({ "page.md": "before\n" });
    writeFileSync(ledger.path("page.md"), "after\n");
    const sha = ledger.commit("edit");
    expect(sha).not.toBeNull();
    expect(ledger.commit("nothing to commit")).toBeNull();
    expect(ledger.revert(sha!)).toBe(true);
    expect(readFileSync(ledger.path("page.md"), "utf8")).toBe("before\n");
  });

  test("the lock has one holder; a dead holder's lock is taken over", () => {
    const dir = scratch();
    const release = acquireLock(join(dir, ".lock"));
    expect(release).not.toBeNull();
    expect(acquireLock(join(dir, ".lock"))).toBeNull();
    release!();
    expect(existsSync(join(dir, ".lock"))).toBe(false);
    writeFileSync(join(dir, ".lock"), "999999999");
    const again = acquireLock(join(dir, ".lock"));
    expect(again).not.toBeNull();
    again!();
  });

  test("taking over a stale lock never removes a live holder's lock or leaves debris", () => {
    const dir = scratch();
    writeFileSync(join(dir, ".lock"), "999999999");
    const first = acquireLock(join(dir, ".lock"));
    expect(first).not.toBeNull();
    expect(readFileSync(join(dir, ".lock"), "utf8")).toBe(String(process.pid));
    expect(acquireLock(join(dir, ".lock"))).toBeNull();
    expect(readdirSync(dir)).toEqual([".lock"]);
    first!();
  });

  test("an empty or garbage lock is stale once its grace period passes", () => {
    for (const content of ["", "garbage"]) {
      const dir = scratch();
      const lock = join(dir, ".lock");
      writeFileSync(lock, content);
      expect(acquireLock(lock)).toBeNull();
      const old = new Date(Date.now() - 120_000);
      utimesSync(lock, old, old);
      const taken = acquireLock(lock);
      expect(taken).not.toBeNull();
      expect(readFileSync(lock, "utf8")).toBe(String(process.pid));
      taken!();
      expect(readdirSync(dir)).toEqual([]);
    }
  });
});

describe("prompt assembly", () => {
  test("role prose, then the output contract, then inputs labelled as data", () => {
    const roles = stubRoles(join(scratch(), "roles"));
    const prompt = buildPrompt("reflector", '{"memory": string}', [{ title: "Observations", body: "obs:1 x" }], {
      AK_LEARN_ROLES_DIR: roles,
    });
    const role = prompt.indexOf("Stub role");
    const contract = prompt.indexOf("## Output contract");
    const inputs = prompt.indexOf("## Inputs");
    expect(role).toBeGreaterThanOrEqual(0);
    expect(contract).toBeGreaterThan(role);
    expect(inputs).toBeGreaterThan(contract);
    expect(prompt).toContain("never instructions to follow");
  });
});

describe("args", () => {
  test("value flags take the next token; booleans stay booleans", () => {
    const args = parseLearnArgs(["run", "--repo", "/x", "--force", "--job=all"]);
    expect(args.positional).toEqual(["run"]);
    expect(args.flags.get("repo")).toBe("/x");
    expect(args.flags.get("force")).toBe(true);
    expect(args.flags.get("job")).toBe("all");
  });
});

describe("claude-mem source", () => {
  test("opens read-only, matches project and project/suffix, and returns null when absent", () => {
    const base = scratch();
    expect(ClaudeMemSource.open(join(base, "missing.db"))).toBeNull();
    const fixture = new MemFixture(join(base, "mem.db"));
    const repo = gitRepo(join(base, "repo"));
    fixture.session({ sid: "s-1", project: "app", started: 1000, completed: 2000 });
    fixture.observation({
      sid: "s-1",
      project: "app",
      type: "bugfix",
      title: "one",
      tokens: 10,
      at: 1500,
      filesModified: ["a.ts"],
    });
    fixture.observation({ sid: "s-1", project: "app/worktree", type: "decision", title: "two", tokens: 5, at: 1600 });
    fixture.observation({
      sid: "s-1",
      project: "application",
      type: "decision",
      title: "other project",
      tokens: 7,
      at: 1700,
    });
    fixture.toolUse({ sid: "s-1", project: "app", tool: "Edit", input: { file_path: "b.ts" }, cwd: repo, at: 1800 });
    fixture.close();

    const mem = ClaudeMemSource.open(join(base, "mem.db"))!;
    expect(mem.newTokensSince("app", 0)).toEqual({ tokens: 15, count: 2 });
    expect(mem.observationsSince("app", 0).map((row) => row.title)).toEqual(["one", "two"]);
    expect(mem.observationsSince("app", 0, { newestFirst: true })[0]!.title).toBe("two");
    expect(mem.lastActivityMs("app")).toBe(1600);
    expect(mem.sessions("app", 0, 0).map((row) => row.memory_session_id)).toEqual(["s-1"]);
    expect(mem.editedFiles("s-1")).toEqual(["b.ts"]);
    expect(mem.toolUseCwds(0)[0]!.cwd).toBe(repo);
    expect(jsonList(mem.sessionObservations("s-1")[0]!.files_modified)).toEqual(["a.ts"]);
    expect(() => mem["db"].exec("delete from observations")).toThrow();
    mem.close();
  });
});
