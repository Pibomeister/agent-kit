/**
 * Regressions for the worker-session evidence repairs: native host token
 * counters, failure classification, tool-call pairing, and worktree placement.
 */
import { afterAll, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { dirname, join } from "node:path";
import { inProtectedFolder } from "../../src/learn/core/paths.ts";
import { run } from "../../src/learn/core/proc.ts";
import { ensureMemoryLedger } from "../../src/learn/memory/ledger.ts";
import { readWorktrees, type Registry } from "../../src/learn/memory/registry.ts";
import {
  WorkerSessionSource,
  MAX_OBSERVATIONS,
  PROTECTED_FOLDER,
  parseCodexSession,
  parseDroidSession,
  parseGrokSession,
  parseKimiSession,
  workerRootResolver,
  type CapturedSession,
} from "../../src/learn/sources/worker-sessions.ts";
import { projectScratch, removeProjectScratch, scratch, testContext, withGitCeiling } from "./helpers.ts";

afterAll(removeProjectScratch);

const { mkdirSync, readFileSync, rmSync, writeFileSync } = fs;

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

function gateFixture(base: string, origin: string) {
  const common = join(base, ".no-mistakes", "repos", "gate.git");
  const administrative = join(common, "worktrees", "gate");
  const worktree = join(base, ".no-mistakes", "worktrees", "gate");
  mkdirSync(administrative, { recursive: true });
  mkdirSync(worktree, { recursive: true });
  writeFileSync(join(common, "config"), `[remote "origin"]\nurl = ${origin}\n`);
  writeFileSync(join(administrative, "commondir"), "../..\n");
  writeFileSync(join(worktree, ".git"), `gitdir: ${administrative}\n`);
  return { common, administrative, worktree };
}

function toolSessions(name: string, content: string, outcome: object = {}) {
  const base = scratch("ak-ws-outcome-");
  const codex = writeRollout(join(base, "codex"), "outcome", "/fixture/worktree", [
    codexMessage("user", "check"),
    { type: "response_item", payload: { type: "function_call", name, call_id: "a" } },
    { type: "response_item", payload: { type: "function_call_output", call_id: "a", output: content, ...outcome } },
    CODEX_TASK_COMPLETE,
  ]);
  const droid = writeJsonl(join(base, "droid", "session.jsonl"), [
    { type: "session_start", id: "outcome", cwd: "/fixture/worktree" },
    { type: "message", message: { role: "user", content: [{ type: "text", text: "check" }] } },
    { type: "message", message: { role: "assistant", content: [{ type: "tool_use", name, id: "a" }] } },
    { type: "message", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "a", content, ...outcome }] } },
    { type: "agent_turn_outcome" },
  ]);
  const grok = join(base, "grok");
  writeJsonl(join(grok, "chat_history.jsonl"), [
    { type: "user", content: "check" },
    { type: "assistant", tool_calls: [{ id: "a", function: { name } }] },
    { type: "tool_result", tool_call_id: "a", content, ...outcome },
    { type: "assistant", content: "done" },
  ]);
  writeFileSync(join(grok, "summary.json"), JSON.stringify({ info: { id: "outcome", cwd: "/fixture/worktree" } }));
  const kimi = join(base, "kimi");
  writeJsonl(join(kimi, "agents", "main", "wire.jsonl"), [
    kimiAppended({ role: "user", content: [{ type: "text", text: "check" }], origin: { kind: "user" } }),
    kimiAppended({ role: "assistant", content: [], toolCalls: [{ id: "a", name, arguments: "{}" }] }),
    { type: "agent.message.appended", message: { message: { role: "tool", toolCallId: "a", content, ...outcome } } },
    { type: "turn.ended" },
  ]);
  writeFileSync(join(kimi, "state.json"), JSON.stringify({ id: "outcome", cwd: "/fixture/worktree" }));
  return [parseCodexSession(codex), parseDroidSession(droid), parseGrokSession(grok), parseKimiSession(kimi)]
    .map(requiredSession);
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

  test.each(["grok", "droid"])("resumed %s snapshots add only uncaptured input and output usage", (host) => {
    const dir = scratch("ak-ws-resumed-usage-");
    const ledger = ensureMemoryLedger(join(dir, "ledger"));
    const path = join(dir, host === "grok" ? "chat_history.jsonl" : "session.jsonl");
    const capture = (turns: number, input: number, output: number) => {
      const rows: object[] = host === "droid" ? [{ type: "session_start", id: "resume", cwd: "/fixture/worktree" }] : [];
      for (let i = 0; i < turns; i++) {
        if (host === "grok") rows.push({ type: "user", content: `prompt ${i}` }, { type: "assistant", content: `reply ${i}` });
        else rows.push(
          { type: "message", message: { role: "user", content: [{ type: "text", text: `prompt ${i}` }] } },
          { type: "message", message: { role: "assistant", content: [{ type: "text", text: `reply ${i}` }] } },
          { type: "agent_turn_outcome" },
        );
      }
      writeJsonl(path, rows);
      writeFileSync(join(dir, host === "grok" ? "summary.json" : "session.settings.json"), JSON.stringify({
        info: { id: "resume", cwd: "/fixture/worktree" }, usage: { input_tokens: input, output_tokens: output },
      }));
      return requiredSession(host === "grok" ? parseGrokSession(dir) : parseDroidSession(path));
    };
    WorkerSessionSource.open(ledger).capture([capture(1, 1000, 100)]);
    const firstId = storedRows(ledger).at(-1)?.id ?? 0;
    const resumed = capture(2, 1500, 170);
    const source = WorkerSessionSource.open(ledger);
    source.capture([resumed], { dryRun: true });
    expect(source.newTokensSince("", 0).tokens).toBe(1100);
    source.capture([resumed]);
    expect(source.newTokensSince("", firstId).tokens).toBe(570);
    expect(WorkerSessionSource.open(ledger).newTokensSince("", 0).tokens).toBe(1670);
    source.capture([resumed]);
    expect(source.newTokensSince("", 0).tokens).toBe(1670);
    source.capture([capture(3, 1900, 200)]);
    expect(WorkerSessionSource.open(ledger).newTokensSince("", 0).tokens).toBe(2100);
  });

  test("the observation cap retains native usage without recounting a moving omission window", () => {
    const home = scratch("ak-ws-capped-usage-");
    const ledger = ensureMemoryLedger(join(home, "ledger"));
    const capture = (turns: number) => {
      const rows: object[] = [];
      for (let i = 0; i < turns; i++) rows.push(
        codexMessage("user", `prompt ${i}`),
        tokenCount((i + 1) * 10, (i + 1) * 2),
        codexMessage("assistant", `reply ${i}`),
      );
      rows.push(CODEX_TASK_COMPLETE);
      return requiredSession(parseCodexSession(writeRollout(home, "capped", "/fixture/worktree", rows)));
    };
    const session = capture(1005);
    expect(session.observations).toHaveLength(MAX_OBSERVATIONS);
    expect(session.observations.find((row) => row.type === "truncated")).toMatchObject({ tokens_in: 70, tokens_out: 14 });
    WorkerSessionSource.open(ledger).capture([session]);
    const firstId = storedRows(ledger).at(-1)?.id ?? 0;
    expect(WorkerSessionSource.open(ledger).newTokensSince("", 0).tokens).toBe(1005 * 12);
    const resumed = capture(1006);
    const source = WorkerSessionSource.open(ledger);
    source.capture([resumed]);
    expect(source.newTokensSince("", firstId).tokens).toBe(12);
    expect(WorkerSessionSource.open(ledger).newTokensSince("", 0).tokens).toBe(1006 * 12);
    source.capture([resumed]);
    expect(source.newTokensSince("", 0).tokens).toBe(1006 * 12);
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

  test("a command tool still fails on its wording and exit wrapper", () => {
    expect(turnWith("shell", "error: preview quota exceeded")?.type).toBe("error");
    expect(turnWith("bash", "3 tests failed")?.type).toBe("error");
    expect(turnWith("shell", "Process exited with code 2\nnothing")?.type).toBe("error");
  });

  test("recorded outcomes override output wording and command wrappers for every host", () => {
    for (const name of ["shell", "read_file"]) {
      for (const outcome of [{ is_error: false }, { isError: false }, { status: "success" }, { exit_code: 0 }]) {
        for (const item of toolSessions(name, "Process exited with code 2\nerror budget ok\n[Process exited with code 3]", outcome)) {
          expect(item.observations[0]?.type).toBe("turn");
        }
      }
      for (const outcome of [{ is_error: true }, { isError: true }, { status: "error" }, { exit_code: 2 }]) {
        for (const item of toolSessions(name, "Process exited with code 0\nall fine\n[Process exited with code 0]", outcome)) {
          expect(item.observations[0]?.type).toBe("error");
        }
      }
    }
  });

  test("read payloads cannot become exit statuses, while command wrappers retain their outcomes", () => {
    for (const name of ["read_file", "Grep", "Glob", "LS"]) {
      for (const content of [
        "Process exited with code 2\nsaved log",
        "Exit code: 2\nsaved log",
        "exit: 2\nsaved log",
        '[{"chunk_id":"a","wall_time_seconds":0.1,"exit_code":2}]',
        "saved log\n[Process exited with code 2]",
      ]) for (const item of toolSessions(name, content)) {
        expect(item.observations[0]?.type).toBe("turn");
      }
    }
    for (const status of [0, 2]) {
      const items = toolSessions("shell", `Process exited with code ${status}\nerror budget\n[Process exited with code ${status}]`);
      for (const item of items) expect(item.observations[0]?.type).toBe(status === 0 ? "turn" : "error");
      const footer = toolSessions("Execute", `error budget\n[Process exited with code ${status}]`)[1];
      expect(footer?.observations[0]?.type).toBe(status === 0 ? "turn" : "error");
    }
  });

  test("empty unmatched outputs retain recorded success and failure", () => {
    for (const failed of [false, true]) {
      const path = writeRollout(scratch("ak-ws-empty-outcome-"), "empty-outcome", "/fixture/worktree", [
        codexMessage("user", "check"),
        { type: "response_item", payload: { type: "function_call_output", call_id: "unknown", output: "", is_error: failed } },
        CODEX_TASK_COMPLETE,
      ]);
      const observation = requiredSession(parseCodexSession(path)).observations[0];
      expect(observation?.type).toBe(failed ? "error" : "turn");
      expect(observation?.detail?.calls[0]).toMatchObject({ output: "[empty]", failed });
    }
  });

  test("JSON error fields in returned text are content, while host envelopes are failures", () => {
    for (const content of ['27: const sample = {"status": "error"};', '{"is_error":true}', '{"status":"error"}']) {
      for (const failed of [false, true]) {
        const codex = writeRollout(scratch("ak-ws-json-codex-"), "json", "/fixture/worktree", [
          codexMessage("user", "search"),
          { type: "response_item", payload: { type: "function_call", name: "grep", call_id: "a" } },
          { type: "response_item", payload: { type: "function_call_output", call_id: "a", output: content, is_error: failed } },
          CODEX_TASK_COMPLETE,
        ]);
        const droid = writeJsonl(join(scratch("ak-ws-json-droid-"), "session.jsonl"), [
          { type: "session_start", id: "json", cwd: "/fixture/worktree" },
          { type: "message", message: { role: "user", content: [{ type: "text", text: "search" }] } },
          { type: "message", message: { role: "assistant", content: [{ type: "tool_use", name: "Grep", id: "a" }] } },
          { type: "message", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "a", content, is_error: failed }] } },
          { type: "agent_turn_outcome" },
        ]);
        const grok = scratch("ak-ws-json-grok-");
        writeFileSync(join(grok, "summary.json"), JSON.stringify({ info: { id: "json", cwd: "/fixture/worktree" } }));
        writeJsonl(join(grok, "chat_history.jsonl"), [
          { type: "user", content: "search" },
          { type: "assistant", tool_calls: [{ id: "a", function: { name: "grep" } }] },
          { type: "tool_result", tool_call_id: "a", content, status: failed ? "error" : "success" },
          { type: "assistant", content: "done" },
        ]);
        const kimi = scratch("ak-ws-json-kimi-");
        writeFileSync(join(kimi, "state.json"), JSON.stringify({ id: "json", cwd: "/fixture/worktree" }));
        writeJsonl(join(kimi, "agents", "main", "wire.jsonl"), [
          kimiAppended({ role: "user", content: [{ type: "text", text: "search" }], origin: { kind: "user" } }),
          kimiAppended({ role: "assistant", content: [], toolCalls: [{ id: "a", name: "grep", arguments: "{}" }] }),
          { type: "agent.message.appended", message: { message: { role: "tool", toolCallId: "a", content, isError: failed } } },
          { type: "turn.ended" },
        ]);
        for (const session of [parseCodexSession(codex), parseDroidSession(droid), parseGrokSession(grok), parseKimiSession(kimi)]) {
          expect(requiredSession(session).observations[0]?.type).toBe(failed ? "error" : "turn");
        }
      }
    }
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

  test.each([false, true])("a no-mistakes worktree resolves origin through its common directory (bare: %s)", (bare) => {
    const base = scratch("ak-ws-nm-");
    const parent = join(base, "projects", "shop");
    const clone = join(base, ".no-mistakes", "repos", bare ? "abc123.git" : "abc123");
    const common = bare ? clone : join(clone, ".git");
    const worktree = join(base, ".no-mistakes", "worktrees", "gate-1");
    mkdirSync(parent, { recursive: true });
    expect(run(["git", "init", "-q"], { cwd: parent }).code).toBe(0);
    mkdirSync(dirname(clone), { recursive: true });
    expect(run(["git", "clone", "-q", ...(bare ? ["--bare"] : []), parent, clone]).code).toBe(0);
    for (const dir of [join(parent, ".git"), common]) {
      writeFileSync(join(dir, "config"), `[remote "upstream"]\n\turl = https://github.com/other/${dir === common ? "gate" : "parent"}.git\n${readFileSync(join(dir, "config"), "utf8")}\n[remote "origin"]\n\turl = https://github.com/owner/shop.git\n`);
    }
    const administrative = join(common, "worktrees", "gate-1");
    mkdirSync(administrative, { recursive: true });
    writeFileSync(join(administrative, "commondir"), "../..\n");
    writeFileSync(join(administrative, "HEAD"), readFileSync(join(common, "HEAD"), "utf8"));
    writeFileSync(join(administrative, "gitdir"), `${join(worktree, ".git")}\n`);
    mkdirSync(join(worktree, "src"), { recursive: true });
    writeFileSync(join(worktree, ".git"), `gitdir: ${administrative}\n`);
    const registry: Registry = { shop: { root: parent, mem_project: "shop", last_seen: 1 } };
    const ctx = testContext();
    expect(workerRootResolver(registry, {}, { home: base, config: ctx.config })(join(worktree, "src"))).toBe(parent);
    rmSync(worktree, { recursive: true });
    expect(workerRootResolver(registry, readWorktrees(ctx.config), { home: base })(join(worktree, "src"))).toBe(parent);
  });

  test.each([
    ["https://git.company.example/team/shop.git", false],
    ["https://github.com/another/team/shop.git", false],
    ["ssh://git@github.com:2222/team/shop.git", false],
    ["https://github.com/Team/shop.git", false],
    ["/code/team/shop.git", false],
    ["git@github.com:team/shop.git", true],
    ["ssh://git@github.com:22/team/shop.git", true],
    ["https://GITHUB.com/team/shop.git/", true],
  ] as const)("origin matching preserves host and complete repository path: %s", (origin, matches) => {
    const base = projectScratch();
    const root = join(base, "registered");
    mkdirSync(join(root, ".git"), { recursive: true });
    writeFileSync(join(root, ".git", "config"), '[remote "origin"]\nurl = https://github.com/team/shop.git\n');
    const { worktree } = gateFixture(base, origin);
    const registry: Registry = { shop: { root, mem_project: "shop", last_seen: 1 } };
    const worktrees: Record<string, string> = {};
    const rootFor = workerRootResolver(registry, worktrees, { home: base });
    expect(rootFor(worktree)).toBe(matches ? root : null);
    expect(worktrees).toEqual(matches ? { [worktree]: root } : {});
    rmSync(worktree, { recursive: true });
    expect(rootFor(worktree)).toBe(matches ? root : null);
  });

  test.each(["Documents", "Desktop", "Downloads"])("origin matching skips protected registered configs in %s", (folder) => {
    const home = projectScratch();
    const root = join(home, folder, "shop");
    mkdirSync(join(root, ".git"), { recursive: true });
    writeFileSync(join(root, ".git", "config"), '[remote "origin"]\nurl = https://github.com/team/shop.git\n');
    const { worktree } = gateFixture(home, "git@github.com:team/shop.git");
    const registry: Registry = { shop: { root, mem_project: "shop", last_seen: 1 } };
    const worktrees: Record<string, string> = {};
    const rootFor = workerRootResolver(registry, worktrees, { home, platform: "darwin" });
    const read = spyOn(fs, "readFileSync");
    try {
      expect(rootFor(worktree)).toBe(PROTECTED_FOLDER);
      expect(rootFor(worktree)).toBe(PROTECTED_FOLDER);
      expect(read.mock.calls.length).toBeGreaterThan(0);
      expect(read.mock.calls.some(([path]) => typeof path === "string" && inProtectedFolder(path, home, "darwin"))).toBe(false);
      expect(worktrees).toEqual({});
    } finally {
      read.mockRestore();
    }
    expect(workerRootResolver(registry, {}, { home, platform: "linux" })(worktree)).toBe(root);
    expect(workerRootResolver(registry, { [worktree]: root }, { home, platform: "darwin" })(worktree)).toBe(root);
  });

  test.each(["root", "commondir", "common"])("a protected candidate %s cannot hide a readable origin match", (target) => {
    for (const protectedFirst of [false, true]) {
      const home = projectScratch();
      const protectedRoot = target === "root" ? join(home, "Documents", "other") : join(home, "other");
      const common = target === "root" ? join(protectedRoot, ".git") : join(home, "Documents", "other.git");
      mkdirSync(common, { recursive: true });
      writeFileSync(join(common, "config"), '[remote "origin"]\nurl = https://github.com/team/other.git\n');
      if (target !== "root") {
        const administrative = target === "commondir"
          ? join(common, "worktrees", "other")
          : join(home, "metadata", "other");
        mkdirSync(administrative, { recursive: true });
        mkdirSync(protectedRoot, { recursive: true });
        writeFileSync(join(protectedRoot, ".git"), `gitdir: ${administrative}\n`);
        writeFileSync(join(administrative, "commondir"), `${common}\n`);
      }
      const root = join(home, "readable", "shop");
      mkdirSync(join(root, ".git"), { recursive: true });
      writeFileSync(join(root, ".git", "config"), '[remote "origin"]\nurl = https://github.com/team/shop.git\n');
      const protectedEntry = { root: protectedRoot, mem_project: "other", last_seen: 1 };
      const readableEntry = { root, mem_project: "shop", last_seen: 1 };
      const registry: Registry = protectedFirst
        ? { other: protectedEntry, shop: readableEntry }
        : { shop: readableEntry, other: protectedEntry };
      const first = gateFixture(join(home, "first"), "git@github.com:team/shop.git");
      const second = gateFixture(join(home, "second"), "https://github.com/team/shop.git");
      const worktrees: Record<string, string> = {};
      const rootFor = workerRootResolver(registry, worktrees, { home, platform: "darwin" });
      const read = spyOn(fs, "readFileSync");
      try {
        expect(rootFor(first.worktree)).toBe(root);
        expect(rootFor(second.worktree)).toBe(root);
        expect(read.mock.calls.length).toBeGreaterThan(0);
        expect(read.mock.calls.some(([path]) => typeof path === "string" && inProtectedFolder(path, home, "darwin"))).toBe(false);
        expect(worktrees).toEqual({ [first.worktree]: root, [second.worktree]: root });
        rmSync(first.worktree, { recursive: true });
        expect(rootFor(first.worktree)).toBe(root);
      } finally {
        read.mockRestore();
      }
    }
  });

  test.each(["commondir", "common"])("linked worktree discovery guards the resolved %s target", (target) => {
    const home = projectScratch();
    const root = join(home, "Documents", "shop");
    const common = join(root, ".git");
    const { worktree, administrative } = gateFixture(home, "https://github.com/team/shop.git");
    const gitdir = target === "commondir" ? join(common, "worktrees", "external") : administrative;
    mkdirSync(gitdir, { recursive: true });
    writeFileSync(join(gitdir, "commondir"), `${common}\n`);
    writeFileSync(join(worktree, ".git"), `gitdir: ${gitdir}\n`);
    const worktrees: Record<string, string> = {};
    const rootFor = workerRootResolver({ shop: { root, mem_project: "shop", last_seen: 1 } }, worktrees, { home, platform: "darwin" });
    const read = spyOn(fs, "readFileSync");
    try {
      expect(rootFor(worktree)).toBe(PROTECTED_FOLDER);
      expect(read.mock.calls.length).toBeGreaterThan(0);
      expect(read.mock.calls.some(([path]) => typeof path === "string" && inProtectedFolder(path, home, "darwin"))).toBe(false);
      expect(worktrees).toEqual({});
    } finally {
      read.mockRestore();
    }
  });

  test("origin matching guards pointers in candidate registered worktrees", () => {
    const home = projectScratch();
    const root = join(home, "registered");
    const common = join(home, "Downloads", "shop.git");
    const administrative = join(common, "worktrees", "registered");
    mkdirSync(administrative, { recursive: true });
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, ".git"), `gitdir: ${administrative}\n`);
    writeFileSync(join(administrative, "commondir"), "../..\n");
    writeFileSync(join(common, "config"), '[remote "origin"]\nurl = https://github.com/team/shop.git\n');
    const { worktree } = gateFixture(home, "https://github.com/team/shop.git");
    const worktrees: Record<string, string> = {};
    const rootFor = workerRootResolver({ shop: { root, mem_project: "shop", last_seen: 1 } }, worktrees, { home, platform: "darwin" });
    const read = spyOn(fs, "readFileSync");
    try {
      expect(rootFor(worktree)).toBe(PROTECTED_FOLDER);
      expect(read.mock.calls.length).toBeGreaterThan(0);
      expect(read.mock.calls.some(([path]) => typeof path === "string" && inProtectedFolder(path, home, "darwin"))).toBe(false);
      expect(worktrees).toEqual({});
    } finally {
      read.mockRestore();
    }
  });

  test("container names cannot place an unrecorded worktree", () => {
    const registry: Registry = {
      shop: { root: "/code/shop", mem_project: "shop", last_seen: 1 },
      admin: { root: "/code/shop-admin", mem_project: "shop-admin", last_seen: 1 },
    };
    const rootFor = workerRootResolver(registry, {}, { home: "/home/dev" });
    expect(rootFor("/Users/dev/orca/workspaces/shop/fix-cart/src")).toBeNull();
    expect(rootFor("/Users/dev/.treehouse/shop-admin-a1b2c3/src")).toBeNull();
    expect(rootFor("/Users/dev/.treehouse/blog-feature/shop/src")).toBeNull();
    expect(rootFor("/workspaces/shop/other-branch")).toBeNull();
    expect(rootFor("/elsewhere/shop")).toBeNull();
    const base = projectScratch();
    const live = join(base, ".treehouse", "shop-feature");
    mkdirSync(join(live, ".git"), { recursive: true });
    withGitCeiling(base, () => expect(rootFor(join(live, "shop", "src"))).toBeNull());
  });
});
