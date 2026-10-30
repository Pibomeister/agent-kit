import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { processScratch } from "./helpers/process-tmp.ts";
import { collectInput } from "../src/semantic-lint/input.ts";
import { enablement, hookOutput, runHook, unwireHook, wireHook } from "../tools/hooks/semantic-lint.ts";
import { STALE_MS, acquireClaim, claimKey, settleClaim } from "../src/semantic-lint/claim.ts";
import { measurement, requestFor } from "../src/semantic-lint/client.ts";
import pin from "../provenance/semantic-lint.json";
import Ajv from "ajv";
import type { AttemptReceipt } from "../src/semantic-lint/client.ts";

interface WireRequest {
  model: string;
  state: { files: Array<{ path: string; content: string }> };
  questions: { [id: string]: { type: string } };
}
interface Wired {
  permissions?: { allow: string[] };
  hooks: { Stop: Array<{ hooks: Array<{ type: string; command: string; timeout?: number }> }> };
}
const ajv = new Ajv({ strict: false });
const isText = ajv.compile<string>({ type: "string" });
const isRequest = ajv.compile<WireRequest>({
  type: "object",
  required: ["model", "state", "questions"],
  properties: {
    model: { type: "string" },
    state: {
      type: "object",
      required: ["files"],
      properties: {
        files: {
          type: "array",
          items: {
            type: "object",
            required: ["path", "content"],
            properties: { path: { type: "string" }, content: { type: "string" } },
          },
        },
      },
    },
    questions: {
      type: "object",
      additionalProperties: { type: "object", required: ["type"], properties: { type: { type: "string" } } },
    },
  },
});
const isReceipt = ajv.compile<AttemptReceipt>({
  type: "object",
  required: ["request", "cost", "traceparent"],
  properties: {
    request: isRequest.schema,
    cost: { type: "object", required: ["estimated_usd"], properties: { estimated_usd: { type: ["number", "null"] } } },
    traceparent: { type: "string" },
  },
});
const isWired = ajv.compile<Wired>({
  type: "object",
  required: ["hooks"],
  properties: {
    hooks: {
      type: "object",
      required: ["Stop"],
      properties: {
        Stop: {
          type: "array",
          items: {
            type: "object",
            required: ["hooks"],
            properties: {
              hooks: {
                type: "array",
                items: { type: "object", required: ["command"], properties: { command: { type: "string" } } },
              },
            },
          },
        },
      },
    },
  },
});

function request(body: string): WireRequest {
  const raw: unknown = JSON.parse(body);
  if (!isRequest(raw)) throw new Error("bad request");
  return raw;
}
function receiptAt(path: string): AttemptReceipt {
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isReceipt(raw)) throw new Error("bad receipt");
  return raw;
}
function wiredAt(path: string): Wired {
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isWired(raw)) throw new Error("bad wiring");
  return raw;
}
/** Attempt receipts only; the claims directory sits beside them. */
function attempts(receipts: string): string[] {
  return readdirSync(receipts).filter((name) => name.endsWith(".json"));
}
async function neverSend(): Promise<Response> {
  throw new Error("must not send");
}
async function slow(_url: string, init: RequestInit): Promise<Response> {
  return new Promise<Response>((_resolve, reject) => {
    init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
  });
}

const ENTRY = resolve(import.meta.dir, "../tools/hooks/semantic-lint.ts");

function git(root: string, ...args: string[]) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout;
}

function fixture() {
  const root = processScratch("semantic-");
  git(root, "init", "-q");
  writeFileSync(join(root, "cart.ts"), "/** Returns null on absence. */\nexport function cart() { return null; }\n");
  writeFileSync(join(root, "README.md"), "The cart returns null on absence.\n");
  git(root, "add", ".");
  git(
    root,
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "user.email=test@example.invalid",
    "-c",
    "user.name=Test",
    "commit",
    "-qm",
    "fixture",
  );
  writeFileSync(
    join(root, "cart.ts"),
    '/** Returns null on absence. */\nexport function cart() { throw new Error("absent"); }\n',
  );
  writeFileSync(join(root, "README.md"), "The cart returns null when it is absent.\n");
  const privateDir = processScratch("semantic-private-");
  const keyFile = join(privateDir, "key.env");
  writeFileSync(keyFile, 'TYPESAFE_API_KEY="fixture-private-key"\n', { mode: 0o600 });
  return { root, keyFile, receipts: join(privateDir, "receipts"), enabled: true };
}

function reply(body: string, score = 0.9) {
  // The request body is the emitted wire contract, not implementation source.
  const payload = request(body);
  return Response.json({
    model: pin.model,
    usage: { input_tokens: 100, output_tokens: 5 },
    answers: Object.fromEntries(
      Object.keys(payload.questions).map((id) => [id, { type: "score", score, confidence: 0.4 }]),
    ),
  });
}

describe("optional semantic sibling hook", () => {
  test("disabled command reports skip without reading the private key or repository", () => {
    const run = spawnSync(process.execPath, [ENTRY, "hook"], {
      cwd: processScratch("semantic-disabled-"),
      env: { PATH: process.env.PATH, HOME: "/does-not-exist", AK_JEV_ENABLED: "0" },
      encoding: "utf8",
    });
    expect(run.status).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({
      status: "skipped",
      reason: "disabled",
      systemMessage: "JEV lint (advisory): skipped (disabled).",
    });
  });

  test("unset enable variable runs by default and skips quietly without a key file", () => {
    const root = processScratch("semantic-default-");
    const run = (flag: Record<string, string>) =>
      spawnSync(process.execPath, [ENTRY, "hook"], {
        cwd: root,
        env: { PATH: process.env.PATH, HOME: root, ...flag },
        encoding: "utf8",
      });
    const explicit = run({ AK_JEV_ENABLED: "1" });
    expect(explicit.status).toBe(0);
    expect(JSON.parse(explicit.stdout)).toEqual({
      status: "skipped",
      reason: "missing-key",
      findings: [],
      advisory: true,
      excluded: [],
      excludedOmitted: 0,
      systemMessage: "JEV lint (advisory): skipped (missing-key).",
    });
    const unset = run({});
    expect(unset.status).toBe(0);
    expect(unset.stderr).toBe("");
    expect(JSON.parse(unset.stdout)).toEqual({
      status: "skipped",
      reason: "missing-key",
      findings: [],
      advisory: true,
      excluded: [],
      excludedOmitted: 0,
    });
  });

  test("command surfaces auth errors as non-blocking host feedback", () => {
    const root = processScratch("semantic-auth-output-");
    const keyFile = join(root, pin.key_file);
    mkdirSync(join(keyFile, ".."), { recursive: true });
    writeFileSync(keyFile, "fixture", { mode: 0o644 });
    const run = spawnSync(process.execPath, [ENTRY, "hook"], {
      cwd: root,
      env: { PATH: process.env.PATH, HOME: root, AK_JEV_ENABLED: "1" },
      encoding: "utf8",
    });
    expect(run.status).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({
      status: "error",
      reason: "auth",
      findings: [],
      systemMessage: "JEV lint (advisory): error (auth).",
    });
    expect(run.stderr).toBe("");
  });

  test("slow Git discovery returns an advisory input error within the host hook deadline", () => {
    const root = processScratch("semantic-slow-git-");
    const bin = join(root, "bin");
    mkdirSync(bin);
    const fakeGit = join(bin, "git");
    writeFileSync(fakeGit, "#!/bin/sh\nwhile :; do :; done\n");
    chmodSync(fakeGit, 0o755);
    const keyFile = join(root, pin.key_file);
    mkdirSync(join(keyFile, ".."), { recursive: true });
    writeFileSync(keyFile, "TYPESAFE_API_KEY=fixture-private-key\n", { mode: 0o600 });
    const started = Date.now();
    const run = spawnSync(process.execPath, [ENTRY, "hook"], {
      cwd: root,
      env: { PATH: `${bin}:${process.env.PATH}`, HOME: root, AK_JEV_ENABLED: "1" },
      encoding: "utf8",
      timeout: 8_000,
    });
    expect(Date.now() - started).toBeLessThan(4_000);
    expect(run.status).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({ status: "error", reason: "input", advisory: true });
  });

  test.each([".", "nested"])("command collects the active checkout from %s", (directory) => {
    const original = fixture();
    const active = fixture();
    for (const options of [original, active]) git(options.root, "checkout", "--", ".");
    writeFileSync(join(active.root, "active-only.ts"), Buffer.from([1, 0, 2]));
    git(active.root, "add", "active-only.ts");
    const keyFile = join(active.root, pin.key_file);
    mkdirSync(join(keyFile, ".."), { recursive: true });
    writeFileSync(keyFile, "TYPESAFE_API_KEY=fixture-private-key\n", { mode: 0o600 });
    mkdirSync(join(active.root, directory), { recursive: true });
    const run = spawnSync(process.execPath, [ENTRY, "hook"], {
      cwd: join(active.root, directory),
      env: {
        PATH: process.env.PATH,
        HOME: active.root,
        CLAUDE_PROJECT_DIR: original.root,
        AK_JEV_ENABLED: "1",
      },
      encoding: "utf8",
    });
    expect(run.status).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({
      status: "skipped",
      reason: "no-input",
      excluded: [{ path: "active-only.ts", reason: "binary" }],
    });
    expect(run.stderr).toBe("");
  });

  test.each([0, 1, 2, 2.5, 3])("retains score %s for every file and code-doc question", async (score) => {
    const options = fixture();
    writeFileSync(join(options.root, "large.ts"), "x".repeat(16_385));
    git(options.root, "add", "large.ts");
    const result = await runHook({
      ...options,
      transport: async (_url, init) => {
        if (!isText(init.body)) throw new Error("non-text request");
        return reply(init.body, score);
      },
    });
    expect(result).toMatchObject({ status: "reviewed" });
    expect(result.findings.map(({ file, rule, score: value }) => ({ file, rule, score: value }))).toEqual([
      { file: "README.md", rule: "code-claims", score },
      { file: "cart.ts", rule: "code-claims", score },
      { file: "(batch)", rule: "code-doc", score },
    ]);
    const output = hookOutput(result);
    const parsed: unknown = JSON.parse(JSON.stringify(output));
    const isOutput = ajv.compile<{ systemMessage: string }>({
      type: "object",
      required: ["systemMessage"],
      properties: { systemMessage: { type: "string" } },
    });
    if (!isOutput(parsed)) {
      throw new Error("invalid hook output");
    }
    const { systemMessage, ...structured } = parsed;
    expect(structured).toEqual(result);
    const rubric = [
      "No relevant claim to assess",
      "The claim matches the supplied implementation",
      "A possible mismatch needs human review",
      "A clear mismatch is visible in the supplied implementation",
    ];
    expect(systemMessage).toBe(
      [
        "JEV lint (advisory): reviewed.",
        `Receipt trace: ${result.traceparent}`,
        `"README.md" (code-claims): score ${score}/3 (${rubric[Math.floor(score)]}); confidence 0.4`,
        `"cart.ts" (code-claims): score ${score}/3 (${rubric[Math.floor(score)]}); confidence 0.4`,
        `"(batch)" (code-doc): score ${score}/3 (${rubric[Math.floor(score)]}); confidence 0.4`,
        ...(score >= 2
          ? ["JEV does not identify the exact claim; inspect the named files manually before changing code."]
          : []),
        '"large.ts": excluded (size-limit)',
      ].join("\n"),
    );
    expect(output).not.toHaveProperty("decision");
    expect(output).not.toHaveProperty("continue");
  });

  test("missing key is a skip and unsafe key permissions are an auth error", async () => {
    const options = fixture();
    expect(await runHook({ ...options, keyFile: join(options.root, "absent"), transport: neverSend })).toMatchObject({
      status: "skipped",
      reason: "missing-key",
    });
    chmodSync(options.keyFile, 0o644);
    expect(await runHook({ ...options, transport: neverSend })).toMatchObject({ status: "error", reason: "auth" });
  });

  test("batches staged and unstaged code and document checks and records every wire input", async () => {
    const options = fixture();
    git(options.root, "add", "cart.ts");
    const sent: string[] = [];
    const result = await runHook({
      ...options,
      traceparent: "00-11111111111111111111111111111111-2222222222222222-01",
      transport: async (_url, init) => {
        const body = init.body;
        if (!isText(body)) throw new Error("non-text request");
        sent.push(body);
        expect(new Headers(init.headers).get("authorization")).toBe("Bearer fixture-private-key");
        return reply(body);
      },
    });
    expect(sent).toHaveLength(1);
    const payload = request(sent[0] ?? "{}");
    expect(payload.model).toBe(pin.model);
    expect(payload.state.files.map((file: { path: string }) => file.path)).toEqual(["README.md", "cart.ts"]);
    expect(Object.keys(payload.questions)).toHaveLength(3);
    expect(result).toMatchObject({ status: "reviewed", advisory: true });
    expect(result.findings.length).toBe(3);
    const files = attempts(options.receipts);
    expect(files).toHaveLength(1);
    const receipt = receiptAt(join(options.receipts, files[0] ?? ""));
    expect(payload).toEqual(receipt.request);
    expect(receipt).toMatchObject({
      resolved_model: pin.model,
      usage: { input_tokens: 100, output_tokens: 5 },
      status: "reviewed",
    });
    expect(receipt.cost.estimated_usd).toBeCloseTo(0.0000042, 12);
    expect(receipt.traceparent).toBe("00-11111111111111111111111111111111-2222222222222222-01");
    expect(result.traceparent).toBe(receipt.traceparent);
    expect(hookOutput(result).systemMessage).toContain(`Receipt trace: ${receipt.traceparent}`);
    expect(JSON.stringify(receipt)).not.toContain("fixture-private-key");
    expect(statSync(join(options.receipts, files[0] ?? "")).mode & 0o777).toBe(0o600);
  });

  test("excludes untracked files, sensitive files, binary data and symlink escapes", () => {
    const options = fixture();
    mkdirSync(join(options.root, "private"));
    writeFileSync(join(options.root, "private", "credentials.json"), '{"password":"never-send"}');
    writeFileSync(join(options.root, "binary.ts"), Buffer.from([1, 0, 2]));
    writeFileSync(join(options.root, "client.ts"), 'const api_key = "never-send";');
    symlinkSync(options.keyFile, join(options.root, "link.ts"));
    git(options.root, "add", "private", "binary.ts", "client.ts", "link.ts");
    writeFileSync(join(options.root, "untracked.ts"), "never-send");
    const input = collectInput(options.root);
    expect(input.files.map((file) => file.path)).toEqual(["README.md", "cart.ts"]);
    expect(input.excluded.map((item) => item.reason).toSorted()).toEqual([
      "binary",
      "secret-content",
      "sensitive-path",
      "symlink",
    ]);
  });

  test("credential assignments are excluded before batching and recording", async () => {
    const options = fixture();
    const fields = [
      "api_key",
      "api-key",
      "apiKey",
      "OPENAI_API_KEY",
      "openaiApiKey",
      "STRIPE_SECRET_KEY",
      "stripeClientSecret",
      "AWS_SECRET_ACCESS_KEY",
      "client_secret",
      "access_token",
      "access-token",
      "accessToken",
      "password",
      "authorization",
    ];
    const excluded: Array<{ path: string; reason: string }> = [];
    const unstaged: Array<{ path: string; content: string }> = [];
    for (const [index, field] of fields.entries()) {
      for (const [style, quote] of ["", "'", '"'].entries()) {
        for (const separator of [":", "="]) {
          const path = `config-${index}-${style}-${separator === ":" ? "colon" : "equals"}.txt`;
          writeFileSync(join(options.root, path), `${quote}${field}${quote} ${separator} "opaque-provider-secret"`);
          if (separator === "=")
            unstaged.push({ path, content: `${quote}${field}${quote} ${separator} 'opaque-provider-secret'` });
          excluded.push({ path, reason: "secret-content" });
        }
      }
    }
    const values = [
      'const STRIPE = "sk_live_abcdefghijklmnop1234";',
      'const restricted = "rk_test_abcdefghijklmnop1234";',
      'slack = "xoxb-1234567890-abcdefghij"',
      'maps = "AIzaSyAbcdefghijklmnopqrstuvwxyz0123456"',
      "aws = AKIAABCDEFGHIJKLMNOP",
      'url = "postgres://u:hunter2@db"',
    ];
    for (const [index, value] of values.entries()) {
      const path = `value-${index}.txt`;
      writeFileSync(join(options.root, path), value);
      excluded.push({ path, reason: "secret-content" });
    }
    git(options.root, "add", ...excluded.map((item) => item.path));
    for (const item of unstaged) writeFileSync(join(options.root, item.path), item.content);
    writeFileSync(join(options.root, "config.json"), '{"description":"safe configuration"}');
    git(options.root, "add", "config.json");
    let calls = 0;
    const result = await runHook({
      ...options,
      transport: async (_url, init) => {
        calls += 1;
        if (!isText(init.body)) throw new Error("non-text request");
        expect(request(init.body).state.files.map((file) => file.path)).toEqual([
          "README.md",
          "cart.ts",
          "config.json",
        ]);
        expect(init.body).not.toContain("opaque-provider-secret");
        expect(init.body).not.toContain("hunter2");
        return reply(init.body);
      },
    });
    expect(calls).toBe(1);
    expect(result.status).toBe("reviewed");
    expect(result.excluded).toEqual(excluded.toSorted((left, right) => left.path.localeCompare(right.path)));
    expect(result.findings.map((finding) => finding.file)).toEqual(["README.md", "cart.ts", "config.json", "(batch)"]);
    const receipts = attempts(options.receipts);
    expect(receipts).toHaveLength(1);
    const receipt = receiptAt(join(options.receipts, receipts[0] ?? ""));
    expect(receipt.request.state.files.map((file) => file.path)).toEqual(["README.md", "cart.ts", "config.json"]);
    expect(JSON.stringify(receipt)).not.toContain("opaque-provider-secret");
  });

  test("empty eligible input is an explicit skip", async () => {
    const options = fixture();
    git(options.root, "checkout", "--", ".");
    expect(
      await runHook({
        ...options,
        transport: async () => {
          throw new Error("must not send");
        },
      }),
    ).toMatchObject({ status: "skipped", reason: "no-input" });
  });

  test.each([401, 403])("auth HTTP %i is distinct from findings and is not retried", async (status) => {
    const options = fixture();
    let calls = 0;
    const result = await runHook({
      ...options,
      transport: async () => {
        calls += 1;
        return new Response("private server text", { status });
      },
    });
    expect(result).toMatchObject({ status: "error", reason: "auth", findings: [] });
    expect(calls).toBe(1);
    expect(JSON.stringify(result)).not.toContain("private server text");
  });

  test("bounded transient retries produce separate attempt receipts", async () => {
    const options = fixture();
    let calls = 0;
    const result = await runHook({
      ...options,
      transport: async () => {
        calls += 1;
        return new Response("busy", { status: 503 });
      },
    });
    expect(calls).toBe(2);
    expect(result).toMatchObject({ status: "error", reason: "http", findings: [] });
    expect(attempts(options.receipts)).toHaveLength(2);
  });

  test("network failures stay distinct from findings", async () => {
    const options = fixture();
    const result = await runHook({
      ...options,
      transport: async () => {
        throw new Error("fixture-private-key");
      },
    });
    expect(result).toMatchObject({ status: "error", reason: "network", findings: [] });
    expect(JSON.stringify(result)).not.toContain("fixture-private-key");
  });

  test("timeouts cover the response body and remain distinct from cancellation", async () => {
    const options = fixture();
    expect(await runHook({ ...options, timeoutMs: 10, transport: slow })).toMatchObject({
      status: "error",
      reason: "timeout",
    });
    const controller = new AbortController();
    controller.abort();
    expect(await runHook({ ...options, signal: controller.signal, transport: slow })).toMatchObject({
      status: "error",
      reason: "cancelled",
    });
  });

  test("a stalled response body has a deadline", async () => {
    const options = fixture();
    const result = await runHook({
      ...options,
      timeoutMs: 10,
      transport: async (_url, init) =>
        new Response(
          new ReadableStream({
            start(controller) {
              init.signal?.addEventListener("abort", () => controller.error(init.signal?.reason), { once: true });
            },
          }),
        ),
    });
    expect(result).toMatchObject({ status: "error", reason: "timeout", findings: [] });
    const first = attempts(options.receipts)[0] ?? "";
    expect(receiptAt(join(options.receipts, first))).toMatchObject({
      http_status: 200,
      status: "timeout",
      usage: null,
      cost: { estimated_usd: null, known: false },
    });
  });

  test("cancellation interrupts a retry wait before another request", async () => {
    const options = fixture();
    const controller = new AbortController();
    let calls = 0;
    const result = await runHook({
      ...options,
      signal: controller.signal,
      transport: async () => {
        calls += 1;
        setTimeout(() => controller.abort(), 10);
        return new Response("busy", { status: 429 });
      },
    });
    expect(result).toMatchObject({ status: "error", reason: "cancelled" });
    expect(calls).toBe(1);
  });

  test("different resolved identities and invalid answer numbers are refused", async () => {
    const options = fixture();
    const result = await runHook({
      ...options,
      transport: async () =>
        Response.json({ model: "unexpected-runtime", usage: { input_tokens: 100, output_tokens: 5 }, answers: {} }),
    });
    expect(result).toMatchObject({ status: "error", reason: "response", findings: [] });
    const receipt = receiptAt(join(options.receipts, attempts(options.receipts)[0] ?? ""));
    expect(receipt).toMatchObject({
      resolved_model: "unexpected-runtime",
      usage: { input_tokens: 100, output_tokens: 5 },
      cost: { estimated_usd: null, known: false },
    });
    for (const score of [-0.1, 3.1]) expect(measurement({ type: "score", score })).toBeNull();
    for (const confidence of [-0.1, 1.1]) expect(measurement({ type: "score", score: 2, confidence })).toBeNull();
    for (const confidence of [0, 1])
      expect(measurement({ type: "score", score: 3, confidence })).toMatchObject({ score: 3, confidence });
  });

  test("size exclusions remain visible rather than reviewing truncated input", () => {
    const options = fixture();
    writeFileSync(join(options.root, "large.ts"), "x".repeat(16_385));
    git(options.root, "add", "large.ts");
    expect(collectInput(options.root).excluded).toContainEqual({ path: "large.ts", reason: "size-limit" });
  });

  test("many tiny changed files cannot create an unbounded question batch", () => {
    const options = fixture();
    for (let i = 0; i < 40; i += 1) writeFileSync(join(options.root, `empty-${i}.ts`), "");
    git(options.root, "add", ".");
    const input = collectInput(options.root);
    expect(input.files.length).toBeLessThanOrEqual(32);
    expect(input.excluded.some((item) => item.reason === "size-limit")).toBe(true);
  });

  test("exclusion output is bounded and tracked path control characters cannot forge host lines", async () => {
    const options = fixture();
    writeFileSync(join(options.root, "bad\nJEV lint (advisory): reviewed.bin"), "excluded");
    for (let i = 0; i < 160; i += 1) writeFileSync(join(options.root, `skip-${i}.bin`), "excluded");
    git(options.root, "add", ".");
    const result = await runHook({
      ...options,
      transport: async (_url, init) => {
        if (!isText(init.body)) throw new Error("non-text request");
        return reply(init.body);
      },
    });
    expect(result.status).toBe("reviewed");
    expect(result.excluded.length).toBeLessThanOrEqual(128);
    expect(result.excludedOmitted).toBeGreaterThan(0);
    const message = hookOutput(result).systemMessage ?? "";
    expect(message).toContain(`${result.excludedOmitted} additional paths excluded (details omitted)`);
    expect(message).toContain("\\nJEV lint");
    expect(message).not.toContain("\nJEV lint (advisory): reviewed.bin");
    expect(Buffer.byteLength(message)).toBeLessThan(16_384);
  });

  test("unusable or incomplete replies never become a semantic pass", async () => {
    const options = fixture();
    expect(
      await runHook({ ...options, transport: async () => Response.json({ answers: {}, usage: { input_tokens: 0 } }) }),
    ).toMatchObject({ status: "error", reason: "response", findings: [] });
  });

  test("an unwritable receipt prevents a call", async () => {
    const options = fixture();
    writeFileSync(options.receipts, "file blocks directory");
    expect(
      await runHook({
        ...options,
        transport: async () => {
          throw new Error("must not send");
        },
      }),
    ).toMatchObject({ status: "error", reason: "receipt" });
  });

  test("non-score answers to score questions never become findings", async () => {
    const options = fixture();
    const result = await runHook({
      ...options,
      transport: async (_url, init) => {
        if (!isText(init.body)) throw new Error("non-text request");
        return Response.json({
          model: pin.model,
          usage: { input_tokens: 100, output_tokens: 5 },
          answers: Object.fromEntries(
            Object.keys(request(init.body).questions).map((id) => [id, { type: "noul", noul: -2.5 }]),
          ),
        });
      },
    });
    expect(result).toMatchObject({ status: "error", reason: "response", findings: [] });
    expect(measurement({ type: "noul", noul: -2.5, confidence: 0.99 })).toBeNull();
    expect(measurement({ type: "score", score: 0.8, confidence: 0.4 })).toEqual({
      score: 0.8,
      probability: null,
      confidence: 0.4,
    });
    expect(measurement({ type: "score", score: "bad" })).toBeNull();
  });

  test("wire preserves deterministic and foreign sibling hooks and is idempotent", () => {
    const options = fixture();
    const path = join(options.root, "settings.json");
    const original = {
      permissions: { allow: ["Read"] },
      hooks: { Stop: [{ hooks: [{ type: "command", command: "bun run lint" }] }] },
    };
    writeFileSync(path, JSON.stringify(original));
    wireHook(path, ENTRY);
    wireHook(path, ENTRY);
    const wired = wiredAt(path);
    expect(wired.permissions).toEqual(original.permissions);
    expect(wired.hooks.Stop).toHaveLength(2);
    expect(wired.hooks.Stop[0]).toEqual(original.hooks.Stop[0]);
    expect(wired.hooks.Stop[1]?.hooks[0]).toMatchObject({ type: "command", timeout: 30 });
    expect(JSON.parse(readFileSync(`${path}.bak`, "utf8"))).toEqual(original);
  });

  test("wire replaces only its own stale sibling command", () => {
    const options = fixture();
    const path = join(options.root, "settings.json");
    writeFileSync(
      path,
      JSON.stringify({
        hooks: {
          Stop: [
            { hooks: [{ type: "command", command: "bun run lint" }] },
            { hooks: [{ type: "command", command: "bun /old/semantic-lint.ts hook", timeout: 10 }] },
          ],
        },
      }),
    );
    wireHook(path, ENTRY);
    const entries = wiredAt(path).hooks.Stop;
    expect(entries).toHaveLength(2);
    expect(entries[0]?.hooks[0]?.command).toBe("bun run lint");
    expect(entries[1]?.hooks[0]).toMatchObject({ type: "command", timeout: 30 });
    expect(entries[1]?.hooks[0]?.command).toContain(ENTRY);
  });

  test("unwire removes only its semantic sibling and preserves foreign settings", () => {
    const options = fixture();
    const path = join(options.root, "settings.json");
    const original = {
      permissions: { allow: ["Read"] },
      hooks: { Stop: [{ hooks: [{ type: "command", command: "bun run lint" }] }] },
    };
    writeFileSync(path, JSON.stringify(original));
    wireHook(path, ENTRY);
    const run = spawnSync(process.execPath, [ENTRY, "unwire", path], { encoding: "utf8" });
    expect(run.status).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({ status: "unwired" });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(original);
    unwireHook(path);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(original);
  });

  test("invalid settings are refused without overwriting them", () => {
    const options = fixture();
    const path = join(options.root, "settings.json");
    writeFileSync(path, '{"hooks":{"Stop":"invalid"}}');
    expect(() => wireHook(path, ENTRY)).toThrow();
    expect(readFileSync(path, "utf8")).toBe('{"hooks":{"Stop":"invalid"}}');
  });

  test("a disabled semantic sibling leaves a failing deterministic result visible", async () => {
    const root = processScratch("semantic-siblings-");
    const deterministic = Bun.spawn(
      [process.execPath, "-e", 'console.log("deterministic-lint-error"); process.exit(1)'],
      { cwd: root, stdout: "pipe", stderr: "pipe" },
    );
    const semantic = Bun.spawn([process.execPath, ENTRY, "hook"], {
      cwd: root,
      env: { PATH: process.env.PATH, AK_JEV_ENABLED: "0" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [deterministicCode, semanticCode, deterministicText, semanticText] = await Promise.all([
      deterministic.exited,
      semantic.exited,
      new Response(deterministic.stdout).text(),
      new Response(semantic.stdout).text(),
    ]);
    expect(deterministicCode).toBe(1);
    expect(deterministicText).toBe("deterministic-lint-error\n");
    expect(semanticCode).toBe(0);
    expect(JSON.parse(semanticText)).toMatchObject({ status: "skipped", reason: "disabled" });
  });
});

function claimDir(options: { root: string; receipts: string }) {
  const body = JSON.stringify(requestFor(collectInput(options.root)).request);
  return join(options.receipts, "claims", claimKey(body));
}
const noFindings: [] = [];
/** The claim key written out independently of claim.ts: version 1, revision, endpoint, exact body. */
function claimOracle(revision: string, endpoint: string, text: string): string {
  return createHash("sha256")
    .update(JSON.stringify([1, revision, endpoint, text]))
    .digest("hex");
}
interface ClaimView {
  names: string[];
  state: string | null;
}
function claimState(dir: string): ClaimView {
  const names = readdirSync(dir).toSorted();
  const last = names
    .filter((name) => /^[1-9][0-9]*$/.test(name))
    .map(Number)
    .toSorted((a, b) => a - b)
    .at(-1);
  const raw: unknown = JSON.parse(readFileSync(join(dir, String(last)), "utf8"));
  const isState = ajv.compile<{ state: string }>({ type: "object", required: ["state"] });
  return { names, state: isState(raw) ? raw.state : null };
}

describe("default-on enablement and one check per input", () => {
  test("only 0 and 1 are explicit; unset or any other value runs by default", () => {
    expect(enablement("0")).toEqual({ enabled: false, explicit: true });
    expect(enablement("1")).toEqual({ enabled: true, explicit: true });
    for (const flag of [undefined, "", "true", "yes", " 1"])
      expect(enablement(flag)).toEqual({ enabled: true, explicit: false });
  });

  test("default mode makes exactly one call and reports the reviewed result with its message", async () => {
    const options = fixture();
    const mode = enablement(undefined);
    let calls = 0;
    const result = await runHook({
      ...options,
      enabled: mode.enabled,
      transport: async (_url, init) => {
        calls += 1;
        if (!isText(init.body)) throw new Error("non-text request");
        return reply(init.body);
      },
    });
    expect(calls).toBe(1);
    expect(result.status).toBe("reviewed");
    const output = hookOutput(result, { explicit: mode.explicit });
    expect(output.systemMessage).toStartWith("JEV lint (advisory): reviewed.\nReceipt trace: ");
    expect(hookOutput(result, { explicit: mode.explicit, host: "codex" })).toEqual({
      systemMessage: output.systemMessage,
    });
  });

  test("the off switch reads no key file", async () => {
    const options = fixture();
    chmodSync(options.keyFile, 0o644);
    expect(await runHook({ ...options, enabled: true, transport: neverSend })).toMatchObject({ reason: "auth" });
    const off = await runHook({ ...options, enabled: enablement("0").enabled, transport: neverSend });
    expect(off).toMatchObject({ status: "skipped", reason: "disabled" });
    expect(hookOutput(off, { explicit: true }).systemMessage).toBe("JEV lint (advisory): skipped (disabled).");
  });

  test("default mode skips are quiet while errors and reviewed results keep their message", () => {
    const base = { advisory: true as const, excluded: [], excludedOmitted: 0, findings: noFindings };
    const skips = [
      { ...base, status: "skipped" as const, reason: "missing-key" },
      { ...base, status: "skipped" as const, reason: "no-input" },
      { ...base, status: "skipped" as const, reason: "duplicate" as const, priorTrace: null },
      { ...base, status: "skipped" as const, reason: "in-progress" as const },
    ];
    for (const skip of skips) {
      expect(hookOutput(skip, { explicit: false })).toEqual(skip);
      expect(hookOutput(skip, { explicit: false, host: "codex" })).toEqual({});
      expect(hookOutput(skip, { explicit: true }).systemMessage).toBe(`JEV lint (advisory): skipped (${skip.reason}).`);
    }
    const loud = [
      { ...base, status: "error" as const, reason: "auth" as const },
      { ...base, status: "error" as const, reason: "receipt" as const },
      { ...base, status: "reviewed" as const },
    ];
    for (const result of loud)
      for (const explicit of [true, false]) {
        expect(hookOutput(result, { explicit })).toHaveProperty("systemMessage");
        const codex = hookOutput(result, { explicit, host: "codex" });
        expect(Object.keys(codex)).toEqual(["systemMessage"]);
      }
  });

  test("the Codex host form prints only the documented Stop fields and other arguments are usage errors", () => {
    const root = processScratch("semantic-codex-");
    const run = (args: string[], flag: Record<string, string>) =>
      spawnSync(process.execPath, [ENTRY, "hook", ...args], {
        cwd: root,
        env: { PATH: process.env.PATH, HOME: root, ...flag },
        encoding: "utf8",
      });
    const quiet = run(["--host", "codex"], {});
    expect(quiet.status).toBe(0);
    expect(JSON.parse(quiet.stdout)).toEqual({});
    const explicit = run(["--host", "codex"], { AK_JEV_ENABLED: "1" });
    expect(JSON.parse(explicit.stdout)).toEqual({ systemMessage: "JEV lint (advisory): skipped (missing-key)." });
    for (const args of [["--host"], ["--host", "claude"], ["extra"], ["--host", "codex", "extra"]]) {
      const bad = run(args, { AK_JEV_ENABLED: "0" });
      expect(bad.status).toBe(2);
      expect(bad.stdout).toBe("");
      expect(bad.stderr).toStartWith("usage: ");
    }
  });

  test("a completed check makes an identical later Stop a duplicate in both modes, with no call", async () => {
    const options = fixture();
    const first = await runHook({
      ...options,
      transport: async (_url, init) => {
        if (!isText(init.body)) throw new Error("non-text request");
        return reply(init.body);
      },
    });
    expect(first.status).toBe("reviewed");
    expect(claimState(claimDir(options)).state).toBe("complete");
    const again = await runHook({ ...options, transport: neverSend });
    expect(again).toEqual({
      status: "skipped",
      reason: "duplicate",
      findings: [],
      priorTrace: first.traceparent ?? "",
      advisory: true,
      excluded: [],
      excludedOmitted: 0,
    });
    expect(hookOutput(again, { explicit: true }).systemMessage).toBe(
      `JEV lint (advisory): skipped (duplicate).\nPrior receipt trace: ${first.traceparent}`,
    );
    expect(hookOutput(again, { explicit: false })).not.toHaveProperty("systemMessage");
    for (const file of readdirSync(claimDir(options))) {
      const text = readFileSync(join(claimDir(options), file), "utf8");
      expect(text).not.toContain("fixture-private-key");
      expect(text).not.toContain("Returns null on absence");
      expect(statSync(join(claimDir(options), file)).mode & 0o777).toBe(0o600);
    }
    expect(statSync(claimDir(options)).mode & 0o777).toBe(0o700);
  });

  test("overlapping runs on the same input make one call; a changed file makes a new one", async () => {
    const options = fixture();
    const gate = Promise.withResolvers<void>();
    let calls = 0;
    const owner = runHook({
      ...options,
      transport: async (_url, init) => {
        calls += 1;
        await gate.promise;
        if (!isText(init.body)) throw new Error("non-text request");
        return reply(init.body);
      },
    });
    const overlap = await runHook({ ...options, transport: neverSend });
    expect(overlap).toMatchObject({ status: "skipped", reason: "in-progress", findings: [] });
    gate.resolve();
    expect((await owner).status).toBe("reviewed");
    expect(calls).toBe(1);
    writeFileSync(join(options.root, "cart.ts"), "export function cart() { return 1; }\n");
    const changed = await runHook({
      ...options,
      transport: async (_url, init) => {
        calls += 1;
        if (!isText(init.body)) throw new Error("non-text request");
        return reply(init.body);
      },
    });
    expect(changed.status).toBe("reviewed");
    expect(calls).toBe(2);
  });

  test("the claim identity covers the protocol version, pinned revision, endpoint and exact request", () => {
    const body = JSON.stringify({ model: pin.model, state: { files: [] }, questions: {} });
    expect(claimKey(body)).toBe(claimOracle(pin.revision, pin.endpoint, body));
    expect(claimKey(body)).not.toBe(claimOracle("0".repeat(40), pin.endpoint, body));
    expect(claimKey(body)).not.toBe(claimOracle(pin.revision, "https://example.invalid/v1", body));
    expect(claimKey(`${body} `)).not.toBe(claimKey(body));
  });

  test("an error releases the input so a later Stop checks it again, with no added retry", async () => {
    const options = fixture();
    let calls = 0;
    const failed = await runHook({
      ...options,
      transport: async () => {
        calls += 1;
        return new Response("busy", { status: 503 });
      },
    });
    expect(failed).toMatchObject({ status: "error", reason: "http" });
    expect(calls).toBe(2);
    expect(claimState(claimDir(options))).toEqual({ names: ["1"], state: "released" });
    const retried = await runHook({
      ...options,
      transport: async (_url, init) => {
        calls += 1;
        if (!isText(init.body)) throw new Error("non-text request");
        return reply(init.body);
      },
    });
    expect(retried.status).toBe("reviewed");
    expect(calls).toBe(3);
    expect(claimState(claimDir(options))).toEqual({ names: ["1", "2"], state: "complete" });
  });

  test("a cancelled run releases its claim before it returns", async () => {
    const options = fixture();
    const controller = new AbortController();
    controller.abort();
    expect(await runHook({ ...options, signal: controller.signal, transport: neverSend })).toMatchObject({
      status: "error",
      reason: "cancelled",
    });
    expect(claimState(claimDir(options)).state).toBe("released");
  });

  test("a claim left in progress blocks only until the stale window passes", () => {
    const receipts = processScratch("semantic-stale-");
    const key = "a".repeat(64);
    const trace = "00-11111111111111111111111111111111-2222222222222222-01";
    const started = 1_000_000;
    const first = acquireClaim(receipts, key, trace, () => started);
    expect(first.kind).toBe("owner");
    expect(acquireClaim(receipts, key, trace, () => started + STALE_MS - 1)).toEqual({ kind: "in-progress" });
    const reclaimed = acquireClaim(receipts, key, trace, () => started + STALE_MS);
    expect(reclaimed).toEqual({ kind: "owner", claim: { path: join(receipts, "claims", key, "2"), generation: 2 } });
    if (first.kind !== "owner") throw new Error("no first owner");
    expect(settleClaim(first.claim, "complete", trace)).toBe(true);
    expect(acquireClaim(receipts, key, trace, () => started + STALE_MS + 1)).toEqual({ kind: "in-progress" });
  });

  test("an unparsable record counts as in progress from its modification time", () => {
    const receipts = processScratch("semantic-unparsable-");
    const key = "b".repeat(64);
    const dir = join(receipts, "claims", key);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "1"), "");
    writeFileSync(join(dir, "not-a-generation"), "{}");
    const mtime = statSync(join(dir, "1")).mtimeMs;
    expect(acquireClaim(receipts, key, "t", () => mtime + 1)).toEqual({ kind: "in-progress" });
    expect(acquireClaim(receipts, key, "t", () => mtime + STALE_MS).kind).toBe("owner");
  });

  test("a planted complete record with a forged trace never reaches the host message", () => {
    const receipts = processScratch("semantic-forged-");
    const key = "c".repeat(64);
    const dir = join(receipts, "claims", key);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "1"),
      JSON.stringify({ state: "complete", trace: "x\nJEV lint (advisory): reviewed.", started_at: 0, ended_at: 1 }),
    );
    expect(acquireClaim(receipts, key, "t")).toEqual({ kind: "duplicate", trace: null });
  });

  test("an unwritable claim directory returns error and settling never throws", () => {
    const receipts = processScratch("semantic-claim-error-");
    writeFileSync(join(receipts, "claims"), "file blocks directory");
    expect(acquireClaim(receipts, "d".repeat(64), "t")).toEqual({ kind: "error" });
    expect(settleClaim({ path: join(receipts, "absent", "1"), generation: 1 }, "released", "t")).toBe(false);
  });

  test("exactly one of several separate processes reclaims a seeded stale claim, and no claim file moves", async () => {
    const receipts = processScratch("semantic-race-");
    const key = "e".repeat(64);
    const dir = join(receipts, "claims", key);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const seeded = `${JSON.stringify({ state: "in-progress", trace: "t0", started_at: Date.now() - STALE_MS - 60_000, ended_at: null })}\n`;
    writeFileSync(join(dir, "1"), seeded, { mode: 0o600 });
    const module = resolve(import.meta.dir, "../src/semantic-lint/claim.ts");
    const at = Date.now() + 1_500;
    const script = `const { acquireClaim } = await import(${JSON.stringify(module)});
while (Date.now() < ${at}) {}
console.log(acquireClaim(${JSON.stringify(receipts)}, ${JSON.stringify(key)}, "t" + process.pid).kind);`;
    const children = Array.from({ length: 8 }, () =>
      Bun.spawn([process.execPath, "-e", script], { env: { PATH: process.env.PATH }, stdout: "pipe", stderr: "pipe" }),
    );
    const kinds = await Promise.all(children.map(async (child) => (await new Response(child.stdout).text()).trim()));
    expect(await Promise.all(children.map((child) => child.exited))).toEqual(Array.from({ length: 8 }, () => 0));
    expect(kinds.filter((kind) => kind === "owner")).toHaveLength(1);
    expect(kinds.filter((kind) => kind === "in-progress")).toHaveLength(7);
    expect(readdirSync(dir).toSorted()).toEqual(["1", "2"]);
    expect(readFileSync(join(dir, "1"), "utf8")).toBe(seeded);
  });
});
