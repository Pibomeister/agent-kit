/**
 * Run spans: the span helper, the trace carrier, the project and session keys and the capped append.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import schema from "../../schemas/learn-span.schema.json" with { type: "json" };
import { loadConfig } from "../../src/learn/core/config.ts";
import { commandJudge, type JudgeTraceRow } from "../../src/learn/core/judge.ts";
import {
  appendCapped,
  carrierOf,
  parseTraceparent,
  projectKey,
  recordJudgeAttempt,
  runOf,
  sessionKey,
  span,
  SPAN_FILE,
  spanRows,
  type SpanRow,
} from "../../src/learn/core/trace.ts";
import { readJsonl } from "../../src/learn/core/store.ts";
import { removeStartScratch, scratch, startScratch, testContext } from "./helpers.ts";

const validate = new Ajv2020({ strict: false }).compile(schema);
const AMBIENT = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

function spans(ctx: { config: { runtimeDir: string } }): SpanRow[] {
  return readJsonl<SpanRow>(join(ctx.config.runtimeDir, SPAN_FILE));
}

function only(ctx: { config: { runtimeDir: string } }): SpanRow {
  const [row] = spans(ctx);
  if (row === undefined) throw new Error("expected a span row");
  return row;
}

describe("span rows", () => {
  test("a nested pair writes two schema-valid rows, child first, linked by parent id", () => {
    const ctx = testContext();
    const root = scratch();
    const value = span(ctx, "review.run", "cli", (outer) => {
      outer.span?.project(root);
      return span(outer, "review.maintain", "cli", (inner) => {
        inner.span?.attr("findings", 3);
        inner.span?.attr("not-allowed", 1);
        inner.span?.status("nothing");
        return 42;
      });
    });
    expect(value).toBe(42);
    const rows = spans(ctx);
    expect(rows.map((row) => row.name)).toEqual(["review.maintain", "review.run"]);
    for (const row of rows) expect(validate(row)).toBe(true);
    const [child, parent] = rows;
    if (child === undefined || parent === undefined) throw new Error("expected two span rows");
    expect(child.parent_span_id).toBe(parent.span_id);
    expect(child.trace_id).toBe(parent.trace_id);
    expect(parent.parent_span_id).toBeNull();
    expect(child.status).toBe("nothing");
    expect(child.attrs).toEqual({ findings: 3 });
    expect(parent.status).toBe("ok");
    expect(parent.project_key).toMatch(/^[0-9a-f]{12}$/);
    expect(child.project_key).toBeNull();
  });

  test("a throw records failed/error and rethrows the same error", () => {
    const ctx = testContext();
    const boom = new Error("boom");
    expect(() =>
      span(ctx, "skills.run", "cli", () => {
        throw boom;
      }),
    ).toThrow(boom);
    expect(spans(ctx)[0]).toMatchObject({ name: "skills.run", status: "failed", reason: "error", loop: "skills" });
  });

  test("a row that fails the schema is dropped, not written", () => {
    const ctx = testContext();
    span(ctx, "hook.stop", "hook", (inner) => {
      inner.span?.commit("not a sha");
    });
    expect(existsSync(join(ctx.config.runtimeDir, SPAN_FILE))).toBe(false);
  });

  test("runOf names the enclosing span, or nothing outside one", () => {
    const ctx = testContext();
    expect(runOf(ctx)).toEqual({ runId: null, traceId: null });
    const seen = span(ctx, "memory.reflect", "tick", (inner) => runOf(inner));
    const row = only(ctx);
    expect(seen).toEqual({ runId: row.span_id, traceId: row.trace_id });
  });

  test("spanRows reads both generations and skips malformed lines", () => {
    const ctx = testContext();
    span(ctx, "hook.prompt", "hook", () => undefined);
    const current = join(ctx.config.runtimeDir, SPAN_FILE);
    writeFileSync(join(ctx.config.runtimeDir, "spans.1.jsonl"), `${readFileSync(current, "utf8")}not json\n{"v":2}\n`);
    expect(spanRows(ctx.config)).toHaveLength(2);
  });
});

describe("judge totals", () => {
  test("attempts add to the open span and a closing child rolls its totals into the parent", () => {
    const ctx = testContext();
    span(ctx, "review.run", "cli", (outer) => {
      recordJudgeAttempt(runOf(outer).runId, { ok: true, costUsd: 0.25, inputTokens: 100, outputTokens: 10 });
      span(outer, "review.maintain", "cli", (inner) => {
        recordJudgeAttempt(runOf(inner).runId, { ok: false, costUsd: null, inputTokens: 5, outputTokens: 0 });
        recordJudgeAttempt(runOf(inner).runId, { ok: true, costUsd: 0.5, inputTokens: 7, outputTokens: 3 });
      });
      recordJudgeAttempt("ffffffffffffffff", { ok: true, costUsd: 9, inputTokens: 9, outputTokens: 9 });
      recordJudgeAttempt(null, { ok: true, costUsd: 9, inputTokens: 9, outputTokens: 9 });
    });
    const [child, parent] = spans(ctx);
    if (child === undefined || parent === undefined) throw new Error("expected two span rows");
    expect(child.judge).toEqual({
      calls: 2,
      failures: 1,
      cost_usd: 0.5,
      cost_known: false,
      input_tokens: 12,
      output_tokens: 3,
    });
    expect(parent.judge).toEqual({
      calls: 3,
      failures: 1,
      cost_usd: 0.75,
      cost_known: false,
      input_tokens: 112,
      output_tokens: 13,
    });
  });

  test("a span with no judge call reports zero calls and known cost", () => {
    const ctx = testContext();
    span(ctx, "hook.prompt", "hook", () => undefined);
    expect(only(ctx).judge).toEqual({
      calls: 0,
      failures: 0,
      cost_usd: 0,
      cost_known: true,
      input_tokens: 0,
      output_tokens: 0,
    });
  });
});

describe("closed schema", () => {
  test.each([
    ["top level", (row: SpanRow) => ({ ...row, note: "free text" })],
    ["judge", (row: SpanRow) => ({ ...row, judge: { ...row.judge, model: "x" } })],
    ["attrs", (row: SpanRow) => ({ ...row, attrs: { prompt: "free text" } })],
    ["a string attr", (row: SpanRow) => ({ ...row, attrs: { shown: ["/Users/bob/app"] } })],
    ["a session attr", (row: SpanRow) => ({ ...row, attrs: { session: "0b9d4c1e-7a52-4f6e-9c1d-2f1e6a7b8c9d" } })],
  ])("an extra or prose field at the %s is invalid", (_label, mutate) => {
    const ctx = testContext();
    span(ctx, "hook.session-start", "hook", () => undefined);
    const row = only(ctx);
    expect(validate(row)).toBe(true);
    expect(validate(mutate(row))).toBe(false);
  });
});

describe("trace carrier", () => {
  test("a valid ambient carrier is adopted as trace id and parent", () => {
    const ctx = testContext({ env: { TRACEPARENT: AMBIENT } });
    span(ctx, "hook.session-start", "hook", () => undefined);
    expect(spans(ctx)[0]).toMatchObject({
      trace_id: "4bf92f3577b34da6a3ce929d0e0e4736",
      parent_span_id: "00f067aa0ba902b7",
    });
  });

  test.each([
    ["malformed", "garbage"],
    ["wrong version", "ff-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"],
    ["uppercase", "00-4BF92F3577B34DA6A3CE929D0E0E4736-00F067AA0BA902B7-01"],
    ["all-zero trace", "00-00000000000000000000000000000000-00f067aa0ba902b7-01"],
    ["all-zero span", "00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01"],
  ])("a %s carrier is re-rooted", (_label, value) => {
    expect(parseTraceparent(value)).toBeNull();
    const ctx = testContext({ env: { TRACEPARENT: value } });
    span(ctx, "hook.session-start", "hook", () => undefined);
    const row = only(ctx);
    expect(row.parent_span_id).toBeNull();
    expect(row.trace_id).not.toBe("4bf92f3577b34da6a3ce929d0e0e4736");
    expect(row.trace_id).toMatch(/^[0-9a-f]{32}$/);
  });

  test("a judge called inside a span adopting the command's carrier is that span's child, not the carrier's", () => {
    const dir = scratch();
    const seen = join(dir, "seen");
    const script = join(dir, "judge.sh");
    writeFileSync(script, `printf '%s' "$TRACEPARENT" > '${seen}'\necho '{"ok": true}'\n`);
    const ctx = testContext({ env: { TRACEPARENT: AMBIENT } });
    const judge = commandJudge({ ...ctx.config, judgeCommand: ["sh", script] });
    span(ctx, "review.maintain", "cli", (inner) =>
      judge("prompt", { ...runOf(inner), loop: "review", role: "pattern-maintainer", project: "shop" }),
    );
    const row = only(ctx);
    const [call] = readJsonl<JudgeTraceRow>(join(ctx.config.runtimeDir, "judge-calls.jsonl"));
    if (call === undefined) throw new Error("expected a judge trace row");
    expect(row).toMatchObject({ trace_id: "4bf92f3577b34da6a3ce929d0e0e4736", parent_span_id: "00f067aa0ba902b7" });
    expect(call).toMatchObject({ run_id: row.span_id, parent_span_id: row.span_id, trace_id: row.trace_id });
    expect(readFileSync(seen, "utf8")).toBe(`00-${row.trace_id}-${call.span_id}-01`);
    expect(row.judge.calls).toBe(1);
  });

  test("carrierOf formats a sampled W3C traceparent", () => {
    const ref = { traceId: "4bf92f3577b34da6a3ce929d0e0e4736", spanId: "00f067aa0ba902b7" };
    expect(carrierOf(ref)).toBe(AMBIENT);
    expect(parseTraceparent(carrierOf(ref))).toEqual(ref);
  });
});

describe("best effort", () => {
  test("an unwritable span file and unreadable salt leave the body's result and error unchanged", () => {
    const ctx = testContext();
    mkdirSync(join(ctx.config.runtimeDir, SPAN_FILE), { recursive: true });
    mkdirSync(join(ctx.config.runtimeDir, ".salt"), { recursive: true });
    const root = scratch();
    expect(
      span(ctx, "review.run", "cli", (inner) => {
        inner.span?.project(root);
        return "kept";
      }),
    ).toBe("kept");
    const boom = new Error("still thrown");
    expect(() =>
      span(ctx, "review.run", "cli", () => {
        throw boom;
      }),
    ).toThrow(boom);
    expect(statSync(join(ctx.config.runtimeDir, SPAN_FILE)).isDirectory()).toBe(true);
  });
});

describe("capped append", () => {
  test("rotates to exactly one previous generation when the next line would pass the cap", () => {
    const dir = scratch();
    const path = join(dir, "tick.log");
    appendCapped(path, "a".repeat(60), 100);
    appendCapped(path, "b".repeat(30), 100);
    expect(readFileSync(path, "utf8")).toBe(`${"a".repeat(60)}${"b".repeat(30)}`);
    appendCapped(path, "c".repeat(30), 100);
    expect(readFileSync(join(dir, "tick.1.log"), "utf8")).toBe(`${"a".repeat(60)}${"b".repeat(30)}`);
    expect(readFileSync(path, "utf8")).toBe("c".repeat(30));
    appendCapped(path, "d".repeat(80), 100);
    expect(readFileSync(join(dir, "tick.1.log"), "utf8")).toBe("c".repeat(30));
    expect(readFileSync(path, "utf8")).toBe("d".repeat(80));
  });

  test("the span file rotates under the configured cap", () => {
    const ctx = testContext();
    const config = { ...ctx.config, traceMaxBytes: 1_000 };
    const small = { ...ctx, config };
    for (let i = 0; i < 8; i += 1) span(small, "hook.prompt", "hook", () => undefined);
    expect(existsSync(join(config.runtimeDir, "spans.1.jsonl"))).toBe(true);
    expect(statSync(join(config.runtimeDir, SPAN_FILE)).size).toBeLessThanOrEqual(1_000);
    expect(spanRows(config).length).toBeGreaterThan(0);
  });

  test("a dot-named log rotates beside itself", () => {
    const dir = scratch();
    const path = join(dir, ".pipeline.log");
    appendCapped(path, "x".repeat(10), 10);
    appendCapped(path, "y", 10);
    expect(readFileSync(join(dir, ".pipeline.1.log"), "utf8")).toBe("x".repeat(10));
  });
});

describe("project key", () => {
  afterAll(removeStartScratch);

  test("concurrent first use agrees on one salt and one key", async () => {
    const dir = scratch();
    const config = loadConfig({ CLAUDE_CONFIG_DIR: join(dir, "config") });
    const root = scratch();
    const core = join(import.meta.dir, "..", "..", "src", "learn", "core");
    // Bun scans script ancestors at startup; a crowded macOS TMPDIR delayed each child by 13s.
    const file = join(startScratch(), "key.ts");
    writeFileSync(
      file,
      `import { projectKey } from ${JSON.stringify(join(core, "trace.ts"))};
import { loadConfig } from ${JSON.stringify(join(core, "config.ts"))};
console.log(projectKey(loadConfig({ CLAUDE_CONFIG_DIR: ${JSON.stringify(config.configDir)} }), ${JSON.stringify(root)}));`,
    );
    const children = Array.from({ length: 4 }, () => Bun.spawn([process.execPath, file], { stdout: "pipe" }));
    const keys = await Promise.all(children.map(async (child) => (await new Response(child.stdout).text()).trim()));
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toMatch(/^[0-9a-f]{12}$/);
    expect(projectKey(config, root)).toBe(keys[0] ?? "");
    expect(statSync(join(config.runtimeDir, ".salt")).mode & 0o777).toBe(0o600);
  });

  test("a malformed salt yields no key and is left as it was", () => {
    const dir = scratch();
    const config = loadConfig({ CLAUDE_CONFIG_DIR: join(dir, "config") });
    mkdirSync(config.runtimeDir, { recursive: true });
    writeFileSync(join(config.runtimeDir, ".salt"), "abc");
    expect(projectKey(config, scratch())).toBeNull();
    expect(readFileSync(join(config.runtimeDir, ".salt"), "utf8")).toBe("abc");
  });

  test("a symlinked root and its real path share a key; different roots do not", () => {
    const dir = scratch();
    const config = loadConfig({ CLAUDE_CONFIG_DIR: join(dir, "config") });
    const root = scratch();
    const link = join(dir, "link");
    symlinkSync(root, link);
    expect(projectKey(config, link)).toBe(projectKey(config, root));
    expect(projectKey(config, scratch())).not.toBe(projectKey(config, root));
  });

  test("the key is not a bare hash of the root: another install's salt gives another key", () => {
    const root = scratch();
    const a = loadConfig({ CLAUDE_CONFIG_DIR: join(scratch(), "config") });
    const b = loadConfig({ CLAUDE_CONFIG_DIR: join(scratch(), "config") });
    expect(projectKey(a, root)).not.toBe(projectKey(b, root));
  });
});

describe("session key", () => {
  test("one id gives one 16-hex key per install, carried by the session-start span and by no other", () => {
    const ctx = testContext();
    const id = "0b9d4c1e-7a52-4f6e-9c1d-2f1e6a7b8c9d";
    const key = sessionKey(ctx.config, id);
    expect(key).toMatch(/^[0-9a-f]{16}$/);
    expect(sessionKey(ctx.config, id)).toBe(key);
    expect(sessionKey(ctx.config, `${id}0`)).not.toBe(key);
    expect(sessionKey(loadConfig({ CLAUDE_CONFIG_DIR: join(scratch(), "config") }), id)).not.toBe(key);
    span(ctx, "hook.session-start", "hook", (traced) => traced.span?.attr("session", key ?? ""));
    span(ctx, "hook.prompt", "hook", (traced) => traced.span?.attr("session", key ?? ""));
    const [start, prompt] = spans(ctx);
    expect(start?.attrs).toEqual({ session: key ?? "" });
    expect(prompt?.attrs).toEqual({});
    expect(validate(start)).toBe(true);
  });

  test("a path that is also a session's id does not share the project's key", () => {
    const ctx = testContext();
    const root = scratch();
    expect(projectKey(ctx.config, root)).not.toBeNull();
    expect(sessionKey(ctx.config, root)?.slice(0, 12)).not.toBe(projectKey(ctx.config, root));
  });

  test("no id or a malformed salt yields no key", () => {
    const ctx = testContext();
    expect(sessionKey(ctx.config, "")).toBeNull();
    const config = loadConfig({ CLAUDE_CONFIG_DIR: join(scratch(), "config") });
    mkdirSync(config.runtimeDir, { recursive: true });
    writeFileSync(join(config.runtimeDir, ".salt"), "abc");
    expect(sessionKey(config, "a-session")).toBeNull();
  });
});
