/**
 * Regressions for the worker-session evidence repairs: native host token
 * counters, failure classification, tool-call pairing, and worktree placement.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { run } from "../../src/learn/core/proc.ts";
import { ensureMemoryLedger } from "../../src/learn/memory/ledger.ts";
import { readWorktrees, type Registry } from "../../src/learn/memory/registry.ts";
import {
  WorkerSessionSource,
  parseCodexSession,
  parseDroidSession,
  parseGrokSession,
  parseKimiSession,
  workerRootResolver,
  type CapturedSession,
} from "../../src/learn/sources/worker-sessions.ts";
import { projectScratch, removeProjectScratch, scratch, testContext, withGitCeiling } from "./helpers.ts";

afterAll(removeProjectScratch);

function requiredSession(value: CapturedSession | null): CapturedSession {
  if (value === null) throw new Error("fixture session did not parse");
  return value;
}

function writeJsonl(path: string, rows: readonly object[]): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, rows.map((row) => JSON.stringify(row)).join("\n"));
  return path;
}

function codexMessage(role: "user" | "assistant", text: string) {
  return { type: "response_item", payload: { type: "message", role, content: [{ type: "input_text", text }] } };
}

function writeRollout(home: string, id: string, cwd: string, rows: readonly object[]): string {
  return writeJsonl(join(home, "sessions", `rollout-${id}.jsonl`), [
    { type: "session_meta", payload: { id, cwd } },
    ...rows,
  ]);
}

const CODEX_TASK_COMPLETE = { type: "event_msg", payload: { type: "task_complete" } };

function tokenCount(input: number, output: number) {
  return {
    type: "event_msg",
    payload: { type: "token_count", info: { total_token_usage: { input_tokens: input, output_tokens: output } } },
  };
}

/** The first observation of a one-turn rollout whose only tool call, named `name`, returned `output`. */
function turnWith(name: string, output: string) {
  const path = writeRollout(scratch("ak-ws-fail-"), `${name}-case`, "/fixture/worktree", [
    codexMessage("user", "check it"),
    { type: "response_item", payload: { type: "custom_tool_call", call_id: "c1", name, input: "{}" } },
    {
      type: "response_item",
      payload: { type: "custom_tool_call_output", call_id: "c1", output: [{ type: "input_text", text: output }] },
    },
    codexMessage("assistant", "done"),
    CODEX_TASK_COMPLETE,
  ]);
  return requiredSession(parseCodexSession(path)).observations[0];
}

interface KimiWireMessage {
  role: string;
  content: ReadonlyArray<{ type: string; text: string }>;
  origin?: { kind: string };
  toolCalls?: ReadonlyArray<{ id: string; name: string; arguments: string }>;
  toolCallId?: string;
}

function kimiAppended(message: KimiWireMessage) {
  return { type: "agent.message.appended", message: { message } };
}

function linkedRepo() {
  const main = join(projectScratch(), "registered");
  mkdirSync(main, { recursive: true });
  run(["git", "init", "-q"], { cwd: main });
  writeFileSync(join(main, "README.md"), "fixture\n");
  run(["git", "add", "-A"], { cwd: main });
  run(["git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init", "--no-gpg-sign"], { cwd: main });
  const linked = join(projectScratch(), "linked");
  const linkedGit = join(main, ".git", "worktrees", "fixture");
  mkdirSync(linkedGit, { recursive: true });
  mkdirSync(linked, { recursive: true });
  writeFileSync(join(linked, ".git"), `gitdir: ${linkedGit}\n`);
  writeFileSync(join(linkedGit, "commondir"), "../..\n");
  writeFileSync(join(linkedGit, "gitdir"), `${join(linked, ".git")}\n`);
  writeFileSync(join(linkedGit, "HEAD"), readFileSync(join(main, ".git", "HEAD"), "utf8"));
  return { main, linked };
}

function storedRows(ledger: ReturnType<typeof ensureMemoryLedger>) {
  return WorkerSessionSource.open(ledger).observationsSince("", 0);
}

describe("native token counters", () => {
  test("a Codex token_count row lands in the stored row beside the excerpt size", () => {
    const path = writeRollout(scratch("ak-ws-codex-tokens-"), "tok", "/fixture/worktree", [
      codexMessage("user", "Run the checks."),
      {
        type: "response_item",
        payload: { type: "custom_tool_call", call_id: "call_1", name: "shell", input: "bun test" },
      },
      {
        type: "response_item",
        payload: {
          type: "custom_tool_call_output",
          call_id: "call_1",
          output: [{ type: "input_text", text: "4 pass" }],
        },
      },
      {
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            last_token_usage: { input_tokens: 1200, output_tokens: 300 },
            total_token_usage: { input_tokens: 1200, output_tokens: 300 },
          },
        },
      },
      codexMessage("assistant", "Done."),
      CODEX_TASK_COMPLETE,
    ]);
    const session = requiredSession(parseCodexSession(path));
    expect(session.tokens_in).toBe(1200);
    expect(session.tokens_out).toBe(300);
    expect(session.observations[0]).toMatchObject({ tokens_in: 1200, tokens_out: 300, usage_basis: "incremental" });

    const ledger = ensureMemoryLedger(scratch("ak-ws-ledger-"));
    WorkerSessionSource.open(ledger).capture([session]);
    const rows = storedRows(ledger);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tokens_in: 1200, tokens_out: 300, usage_basis: "incremental" });
    // The excerpt size stays the excerpt size and is never the consumption figure.
    expect(rows[0]?.discovery_tokens).toBe(Math.ceil((rows[0]?.facts ?? "").length / 4));
    expect(WorkerSessionSource.open(ledger).newTokensSince("", 0)).toEqual({ tokens: 1500, count: 1 });
  });

  test("cumulative Codex totals are split into per-turn increments", () => {
    const path = writeRollout(scratch("ak-ws-codex-total-"), "tot", "/fixture/worktree", [
      codexMessage("user", "first"),
      tokenCount(1000, 100),
      codexMessage("assistant", "one"),
      codexMessage("user", "second"),
      tokenCount(1500, 150),
      codexMessage("assistant", "two"),
      CODEX_TASK_COMPLETE,
    ]);
    const session = requiredSession(parseCodexSession(path));
    expect(session.observations.map((row) => [row.tokens_in, row.tokens_out])).toEqual([
      [1000, 100],
      [500, 50],
    ]);
    expect(session.tokens_in).toBe(1500);
    expect(session.tokens_out).toBe(150);
  });

  test("a session with no host counter is stored as estimated with no native tokens", () => {
    const path = writeRollout(scratch("ak-ws-codex-est-"), "est", "/fixture/worktree", [
      codexMessage("user", "hello"),
      codexMessage("assistant", "hi"),
      CODEX_TASK_COMPLETE,
    ]);
    const ledger = ensureMemoryLedger(scratch("ak-ws-ledger-"));
    WorkerSessionSource.open(ledger).capture([requiredSession(parseCodexSession(path))]);
    const rows = storedRows(ledger);
    expect(rows[0]).toMatchObject({ tokens_in: null, tokens_out: null, usage_basis: "estimated" });
    expect(WorkerSessionSource.open(ledger).newTokensSince("", 0)).toEqual({ tokens: 0, count: 1 });
  });

  test("Droid row usage and settings counters are stored, without their provider fields", () => {
    const home = scratch("ak-ws-droid-tokens-");
    const byRow = writeJsonl(join(home, "sessions", "-fixture-worktree", "rowusage.jsonl"), [
      { type: "session_start", id: "rowusage", cwd: "/fixture/worktree" },
      { type: "message", message: { role: "user", content: [{ type: "text", text: "work" }] } },
      {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "done" }],
          usage: { input_tokens: 700, output_tokens: 70 },
        },
      },
      { type: "agent_turn_outcome" },
    ]);
    expect(requiredSession(parseDroidSession(byRow)).observations[0]).toMatchObject({
      tokens_in: 700,
      tokens_out: 70,
      usage_basis: "incremental",
    });

    const bySettings = writeJsonl(join(home, "sessions", "-fixture-worktree", "setusage.jsonl"), [
      { type: "session_start", id: "setusage", cwd: "/fixture/worktree" },
      { type: "message", message: { role: "user", content: [{ type: "text", text: "work" }] } },
      { type: "message", message: { role: "assistant", content: [{ type: "text", text: "done" }] } },
      { type: "agent_turn_outcome" },
    ]);
    writeFileSync(
      join(home, "sessions", "-fixture-worktree", "setusage.settings.json"),
      JSON.stringify({ provider: "provider-secret-name", usage: { input_tokens: 900, output_tokens: 90 } }),
    );
    const fromSettings = requiredSession(parseDroidSession(bySettings));
    expect(fromSettings.observations[0]).toMatchObject({ tokens_in: 900, tokens_out: 90, usage_basis: "raw_total" });
    expect(JSON.stringify(fromSettings)).not.toContain("provider-secret-name");
  });

  test("a Grok summary total and a Kimi StatusUpdate counter are stored", () => {
    const grokDir = join(scratch("ak-ws-grok-tokens-"), "grok-session");
    mkdirSync(grokDir, { recursive: true });
    writeFileSync(
      join(grokDir, "summary.json"),
      JSON.stringify({
        info: { id: "grok-tok", cwd: "/fixture/worktree" },
        created_at: "2026-10-04T13:00:00.000Z",
        last_active_at: "2026-10-04T13:05:00.000Z",
        usage: { input_tokens: 5000, output_tokens: 500 },
      }),
    );
    writeJsonl(join(grokDir, "chat_history.jsonl"), [
      { type: "user", content: [{ type: "text", text: "review it" }] },
      { type: "assistant", content: "looked" },
    ]);
    expect(requiredSession(parseGrokSession(grokDir)).observations[0]).toMatchObject({
      tokens_in: 5000,
      tokens_out: 500,
      usage_basis: "raw_total",
    });

    const kimiDir = join(scratch("ak-ws-kimi-tokens-"), "kimi-session");
    mkdirSync(join(kimiDir, "agents", "main"), { recursive: true });
    writeFileSync(join(kimiDir, "state.json"), JSON.stringify({ id: "kimi-tok", cwd: "/fixture/worktree" }));
    writeJsonl(join(kimiDir, "agents", "main", "wire.jsonl"), [
      {
        type: "agent.message.appended",
        message: { message: { role: "user", content: [{ type: "text", text: "work" }], origin: { kind: "user" } } },
      },
      { type: "StatusUpdate", token_usage: { input_tokens: 2000, output_tokens: 200 } },
      {
        type: "agent.message.appended",
        message: { message: { role: "assistant", content: [{ type: "text", text: "done" }] } },
      },
      { type: "turn.ended" },
    ]);
    expect(requiredSession(parseKimiSession(kimiDir)).observations[0]).toMatchObject({
      tokens_in: 2000,
      tokens_out: 200,
      usage_basis: "incremental",
    });
  });
});

describe("failure classification", () => {
  test("read and search tools never fail on their output's wording", () => {
    for (const name of ["read_file", "Read", "Grep", "grep", "Glob", "LS"]) {
      const row = turnWith(name, "error: finding violation in schemas/finding.schema.json");
      expect(row?.type).toBe("turn");
      expect(row?.detail?.calls[0]?.failed).toBe(false);
    }
  });

  test("a command tool still fails on its wording, and any tool fails on a recorded status or envelope", () => {
    expect(turnWith("shell", "error: preview quota exceeded")?.type).toBe("error");
    expect(turnWith("bash", "3 tests failed")?.type).toBe("error");
    expect(turnWith("read_file", "Process exited with code 2\nnothing")?.type).toBe("error");
    expect(turnWith("read_file", '{"is_error": true, "message": "denied"}')?.type).toBe("error");
    expect(turnWith("read_file", '{"status": "error", "message": "denied"}')?.type).toBe("error");
  });
});

describe("tool-call pairing", () => {
  test("Codex outputs join the call their id names, out of order", () => {
    const path = writeRollout(scratch("ak-ws-pair-"), "pair", "/fixture/worktree", [
      codexMessage("user", "gather"),
      { type: "response_item", payload: { type: "custom_tool_call", call_id: "a", name: "shell", input: "first" } },
      {
        type: "response_item",
        payload: { type: "custom_tool_call", call_id: "b", name: "read_file", input: "second" },
      },
      {
        type: "response_item",
        payload: {
          type: "custom_tool_call_output",
          call_id: "b",
          output: [{ type: "input_text", text: "beta result" }],
        },
      },
      {
        type: "response_item",
        payload: {
          type: "custom_tool_call_output",
          call_id: "a",
          output: [{ type: "input_text", text: "alpha result" }],
        },
      },
      codexMessage("assistant", "done"),
      CODEX_TASK_COMPLETE,
    ]);
    const text = requiredSession(parseCodexSession(path)).observations[0]?.text ?? "";
    expect(text).toContain("shell first -> alpha result");
    expect(text).toContain("read_file second -> beta result");
  });

  test("an empty Codex output resolves its call instead of shifting the next output onto it", () => {
    const path = writeRollout(scratch("ak-ws-empty-"), "empty", "/fixture/worktree", [
      codexMessage("user", "gather"),
      { type: "response_item", payload: { type: "custom_tool_call", name: "shell", input: "first" } },
      { type: "response_item", payload: { type: "custom_tool_call", name: "shell", input: "second" } },
      {
        type: "response_item",
        payload: { type: "custom_tool_call_output", output: [{ type: "input_text", text: "" }] },
      },
      {
        type: "response_item",
        payload: { type: "custom_tool_call_output", output: [{ type: "input_text", text: "second result" }] },
      },
      codexMessage("assistant", "done"),
      CODEX_TASK_COMPLETE,
    ]);
    const text = requiredSession(parseCodexSession(path)).observations[0]?.text ?? "";
    expect(text).toContain("shell first -> [empty]");
    expect(text).toContain("shell second -> second result");
  });

  test("Grok and Kimi outputs join the call their id names", () => {
    const grokDir = join(scratch("ak-ws-grok-pair-"), "grok-session");
    mkdirSync(grokDir, { recursive: true });
    writeFileSync(
      join(grokDir, "summary.json"),
      JSON.stringify({
        info: { id: "grok-pair", cwd: "/fixture/worktree" },
        created_at: "2026-10-04T13:00:00.000Z",
        last_active_at: "2026-10-04T13:05:00.000Z",
      }),
    );
    writeJsonl(join(grokDir, "chat_history.jsonl"), [
      { type: "user", content: [{ type: "text", text: "gather" }] },
      {
        type: "assistant",
        content: "working",
        tool_calls: [
          { id: "g1", function: { name: "shell", arguments: "first" } },
          { id: "g2", function: { name: "read_file", arguments: "second" } },
        ],
      },
      { type: "tool_result", tool_call_id: "g2", content: "beta result" },
      { type: "tool_result", tool_call_id: "g1", content: "alpha result" },
      { type: "assistant", content: "done" },
    ]);
    const grokText = requiredSession(parseGrokSession(grokDir)).observations[0]?.text ?? "";
    expect(grokText).toContain("shell first -> alpha result");
    expect(grokText).toContain("read_file second -> beta result");

    const kimiDir = join(scratch("ak-ws-kimi-pair-"), "kimi-session");
    mkdirSync(join(kimiDir, "agents", "main"), { recursive: true });
    writeFileSync(join(kimiDir, "state.json"), JSON.stringify({ id: "kimi-pair", cwd: "/fixture/worktree" }));
    writeJsonl(join(kimiDir, "agents", "main", "wire.jsonl"), [
      kimiAppended({ role: "user", content: [{ type: "text", text: "gather" }], origin: { kind: "user" } }),
      kimiAppended({
        role: "assistant",
        content: [{ type: "text", text: "working" }],
        toolCalls: [
          { id: "k1", name: "shell", arguments: "first" },
          { id: "k2", name: "read_file", arguments: "second" },
        ],
      }),
      kimiAppended({ role: "tool", toolCallId: "k2", content: [{ type: "text", text: "beta result" }] }),
      kimiAppended({ role: "tool", toolCallId: "k1", content: [{ type: "text", text: "alpha result" }] }),
      kimiAppended({ role: "assistant", content: [{ type: "text", text: "done" }] }),
      { type: "turn.ended" },
    ]);
    const kimiText = requiredSession(parseKimiSession(kimiDir)).observations[0]?.text ?? "";
    expect(kimiText).toContain("shell first -> alpha result");
    expect(kimiText).toContain("read_file second -> beta result");
  });
});

describe("worktree placement", () => {
  test("resolving a linked worktree persists it, so its sessions still place after it is removed", () => {
    const { main, linked } = linkedRepo();
    const registry: Registry = { registered: { root: main, mem_project: "registered", last_seen: 1 } };
    const persisted: Array<[string, string]> = [];
    const worktrees: Record<string, string> = {};
    const rootFor = workerRootResolver(registry, worktrees, {
      home: scratch("ak-ws-home-"),
      persist: (worktree, root) => persisted.push([worktree, root]),
    });
    expect(rootFor(join(linked, "src"))).toBe(main);
    expect(persisted).toEqual([[linked, main]]);
    expect(worktrees).toEqual({ [linked]: main });

    rmSync(linked, { recursive: true });
    expect(rootFor(join(linked, "src"))).toBe(main);
  });

  test("with a config, resolving a linked worktree records it in the worktree record", () => {
    const { main, linked } = linkedRepo();
    const ctx = testContext({ cwd: linked });
    const registry: Registry = { registered: { root: main, mem_project: "registered", last_seen: 1 } };
    const rootFor = workerRootResolver(registry, {}, { home: ctx.config.configDir, config: ctx.config });
    withGitCeiling(dirname(linked), () => expect(rootFor(linked)).toBe(main));
    expect(readWorktrees(ctx.config)).toEqual({ [linked]: main });
  });

  test("a no-mistakes worktree places at the registered repository that shares its origin", () => {
    const base = scratch("ak-ws-nm-");
    const parent = join(base, "projects", "shop");
    const clone = join(base, ".no-mistakes", "repos", "abc123");
    const worktree = join(base, ".no-mistakes", "worktrees", "gate-1");
    for (const repo of [parent, clone]) {
      mkdirSync(join(repo, ".git"), { recursive: true });
      writeFileSync(join(repo, ".git", "config"), '[remote "origin"]\n\turl = https://github.com/owner/shop.git\n');
    }
    mkdirSync(join(clone, ".git", "worktrees", "gate-1"), { recursive: true });
    mkdirSync(join(worktree, "src"), { recursive: true });
    writeFileSync(join(worktree, ".git"), `gitdir: ${join(clone, ".git", "worktrees", "gate-1")}\n`);
    const registry: Registry = { shop: { root: parent, mem_project: "shop", last_seen: 1 } };
    expect(workerRootResolver(registry, {}, { home: base })(join(worktree, "src"))).toBe(parent);
  });

  test("a deleted worktree path places by its container and project name, and only there", () => {
    const registry: Registry = { shop: { root: "/code/shop", mem_project: "shop", last_seen: 1 } };
    const rootFor = workerRootResolver(registry, {}, { home: "/home/dev" });
    expect(rootFor("/Users/dev/orca/workspaces/shop/fix-cart/src")).toBe("/code/shop");
    expect(rootFor("/Users/dev/.treehouse/shop-a1b2c3/src")).toBe("/code/shop");
    expect(rootFor("/workspaces/shop/other-branch")).toBeNull();
    expect(rootFor("/elsewhere/shop")).toBeNull();
  });
});
