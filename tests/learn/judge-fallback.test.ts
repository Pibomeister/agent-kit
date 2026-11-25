import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../../src/learn/core/config.ts";
import { commandJudge, type JudgeTraceRow } from "../../src/learn/core/judge.ts";
import { readJsonl } from "../../src/learn/core/store.ts";
import { scratch } from "./helpers.ts";

const CONTEXT = { loop: "memory", role: "reflector", project: "shop", runId: null } as const;

function fixture(primary: string, fallbacks = ['echo \'{"memory":"kept"}\'']) {
  const dir = scratch();
  const commands = [primary, ...fallbacks].map((body, index) => {
    const path = join(dir, `judge-${index}.sh`);
    writeFileSync(path, `cat > '${dir}/input-${index}'\n${body}\n`);
    return `sh ${path}`;
  });
  const config = loadConfig({
    CLAUDE_CONFIG_DIR: join(dir, "config"),
    AK_LEARN_JUDGE: commands[0],
    AK_LEARN_JUDGE_FALLBACKS: JSON.stringify(commands.slice(1)),
  });
  return {
    dir,
    config,
    judge: commandJudge(config),
    rows: () => readJsonl<JudgeTraceRow>(join(config.runtimeDir, "judge-calls.jsonl")),
  };
}

describe("judge fallback configuration", () => {
  test("ordered command strings use the primary command's splitting rules", () => {
    const env = { CLAUDE_CONFIG_DIR: join(scratch(), "config") };
    const config = loadConfig({ ...env, AK_LEARN_JUDGE_FALLBACKS: '["judge-a --json", "judge-b \'two words\'"]' });
    expect(config.judgeFallbackCommands).toEqual([
      ["judge-a", "--json"],
      ["judge-b", "two words"],
    ]);
    expect(loadConfig(env).judgeFallbackCommands).toEqual([]);
    expect(loadConfig({ ...env, AK_LEARN_JUDGE_FALLBACKS: " " }).judgeFallbackCommands).toEqual([]);
  });

  test.each(["bad json", "{}", "[null]", "[1]", "[[]]", '[""]', '[" "]', JSON.stringify(['""']), '["judge \'"]'])(
    "invalid fallback configuration fails closed: %s",
    (value) =>
      expect(() =>
        loadConfig({ CLAUDE_CONFIG_DIR: join(scratch(), "config"), AK_LEARN_JUDGE_FALLBACKS: value }),
      ).toThrow(),
  );
});

describe("judge continuity", () => {
  test("quota failure advances in order with the same prompt and traces the answering binding", () => {
    const f = fixture("echo 'quota exhausted' >&2; exit 1", [
      "echo 'service unavailable' >&2; exit 1",
      'echo \'{"result":"{\\"memory\\":\\"kept\\"}","is_error":false}\'',
    ]);
    expect(f.judge("same prompt", CONTEXT)).toEqual({ memory: "kept" });
    for (let index = 0; index < 3; index += 1) {
      expect(readFileSync(join(f.dir, `input-${index}`), "utf8")).toBe("same prompt");
    }
    const rows = f.rows();
    expect(rows.map((row) => row.outcome)).toEqual(["error", "error", "ok"]);
    expect(rows.map((row) => row.attempt)).toEqual([1, 2, 3]);
    expect(rows.map((row) => row.judge_index)).toEqual([0, 1, 2]);
    expect(rows[2]?.judge_command_sha256).toBe(
      createHash("sha256").update(JSON.stringify(f.config.judgeFallbackCommands[1])).digest("hex"),
    );
    expect(new Set(rows.map((row) => row.trace_id)).size).toBe(1);
    expect(new Set(rows.map((row) => row.span_id)).size).toBe(3);
  });

  test.each([
    "rate limit exceeded",
    "429",
    "HTTP 503",
    "overloaded",
    "insufficient_quota",
    "usage limit reached",
    "hit your limit",
    "rate_limit_error",
    "overloaded_error",
    "RESOURCE_EXHAUSTED",
    "quota_exceeded",
  ])("recognized quota or availability error advances: %s", (message) => {
    const f = fixture(`echo '${message}' >&2; exit 1`);
    expect(f.judge("prompt", CONTEXT)).toEqual({ memory: "kept" });
    expect(f.rows()).toHaveLength(2);
  });

  test("an availability failure retries the same binding when no fallback is configured", () => {
    const dir = scratch();
    const seen = join(dir, "seen");
    const f = fixture(
      `if [ ! -f '${seen}' ]; then echo x > '${seen}'; echo 'service unavailable' >&2; exit 1; fi\necho '{"memory":"kept"}'`,
      [],
    );
    expect(f.config.judgeFallbackCommands).toEqual([]);
    expect(f.judge("prompt", CONTEXT)).toEqual({ memory: "kept" });
    const rows = f.rows();
    expect(rows.map((row) => row.outcome)).toEqual(["error", "ok"]);
    expect(rows.map((row) => row.judge_index)).toEqual([0, 0]);
    expect(rows.map((row) => row.attempt)).toEqual([1, 2]);
    expect(existsSync(join(dir, "input-1"))).toBe(false);
  });

  test("an error envelope with exit zero is a failure, never a usable judgement", () => {
    const f = fixture('echo \'{"is_error":true,"result":"quota exhausted"}\'');
    expect(f.judge("prompt", CONTEXT)).toEqual({ memory: "kept" });
    expect(f.rows().map((row) => row.outcome)).toEqual(["error", "ok"]);
  });

  test("a missing primary executable advances", () => {
    const f = fixture("exit 0");
    f.config.judgeCommand = [join(f.dir, "missing-judge")];
    expect(f.judge("prompt", CONTEXT)).toEqual({ memory: "kept" });
    expect(f.rows().map((row) => row.judge_index)).toEqual([0, 1]);
  });

  test("an authentication error envelope preserves failure reporting and does not advance", () => {
    const f = fixture('echo \'{"is_error":true,"result":"Unauthorized"}\'');
    const failures: unknown[] = [];
    expect(f.judge("prompt", { ...CONTEXT, onProcessResult: (failure) => failures.push(failure) })).toBeNull();
    expect(failures).toEqual(["auth", "auth"]);
    expect(existsSync(join(f.dir, "input-1"))).toBe(false);
  });

  test("timeout advances and a successful fallback clears the process failure", () => {
    const f = fixture("exec sleep 10");
    f.config.judgeTimeoutMs = 1_000;
    const failures: unknown[] = [];
    expect(f.judge("prompt", { ...CONTEXT, onProcessResult: (failure) => failures.push(failure) })).toEqual({
      memory: "kept",
    });
    expect(failures).toEqual(["timeout", null]);
    expect(f.rows().map((row) => row.timed_out)).toEqual([true, false]);
  });

  test("exhausted candidates return null and the next call starts at the primary again", () => {
    const f = fixture("echo 'quota exhausted' >&2; exit 1", ["echo 'service unavailable' >&2; exit 1"]);
    expect(f.judge("prompt", CONTEXT)).toBeNull();
    expect(f.judge("prompt", CONTEXT)).toBeNull();
    expect(f.rows().map((row) => row.judge_index)).toEqual([0, 1, 0, 1]);
  });

  test.each([
    ['echo \'{"memory":"quota exhausted in observed work"}\'', 1],
    ['echo \'{"unavailable":"observation ids missing"}\'', 1],
    ["echo 'malformed reply'", 2],
    ["echo 'Unauthorized' >&2; exit 1", 2],
    ["echo 'bad request' >&2; exit 1", 2],
    ['echo \'{"is_error":true,"result":"invalid request"}\'', 2],
  ] as const)("non-availability replies retain their retry rules: %s", (body, attempts) => {
    const f = fixture(body);
    expect(f.judge("prompt", CONTEXT)).toEqual(
      body.includes("observed work") ? { memory: "quota exhausted in observed work" } : null,
    );
    expect(f.rows()).toHaveLength(attempts);
    expect(existsSync(join(f.dir, "input-1"))).toBe(false);
  });

  test("subscription-only mode never runs an unverified alternative command", () => {
    const f = fixture("echo 'quota exhausted' >&2; exit 1");
    expect(commandJudge(f.config, { subscriptionOnly: true })("prompt", CONTEXT)).toEqual({
      unavailable: "a subscription-only judge must be the claude command, not sh",
    });
    expect(existsSync(join(f.dir, "input-0"))).toBe(false);
    expect(existsSync(join(f.dir, "input-1"))).toBe(false);
  });

  test("subscription-only fallback keeps the host restriction after a verified host fails", () => {
    const f = fixture("exit 0");
    const primary = join(f.dir, "claude");
    writeFileSync(primary, "#!/bin/sh\ncat > /dev/null\necho 'quota exhausted' >&2\nexit 1\n", { mode: 0o755 });
    f.config.judgeCommand = [primary];
    expect(commandJudge(f.config, { subscriptionOnly: true })("prompt", CONTEXT)).toEqual({
      unavailable: "a subscription-only judge must be the claude command, not sh",
    });
    expect(f.rows().map((row) => row.judge_index)).toEqual([0]);
    expect(existsSync(join(f.dir, "input-1"))).toBe(false);
  });
});
