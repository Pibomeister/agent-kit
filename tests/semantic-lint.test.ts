import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { processScratch } from "./helpers/process-tmp.ts";
import { collectInput } from "../src/semantic-lint/input.ts";
import { hookOutput, runHook, wireHook } from "../tools/hooks/semantic-lint.ts";
import { measurement } from "../src/semantic-lint/client.ts";
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
    const { systemMessage, ...structured } = JSON.parse(JSON.stringify(output));
    expect(structured).toEqual(result);
    expect(systemMessage).toBe(
      [
        "JEV lint (advisory): reviewed.",
        `README.md (code-claims): score ${score}; confidence 0.4`,
        `cart.ts (code-claims): score ${score}; confidence 0.4`,
        `(batch) (code-doc): score ${score}; confidence 0.4`,
        "large.ts: excluded (size-limit)",
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
    const files = readdirSync(options.receipts);
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
      "access_token",
      "access-token",
      "accessToken",
      "password",
      "authorization",
    ];
    const excluded: Array<{ path: string; reason: string }> = [];
    for (const [index, field] of fields.entries()) {
      for (const [style, quote] of ["", "'", '"'].entries()) {
        for (const separator of [":", "="]) {
          const path = `config-${index}-${style}-${separator === ":" ? "colon" : "equals"}.txt`;
          writeFileSync(join(options.root, path), `${quote}${field}${quote} ${separator} "opaque-provider-secret"`);
          git(options.root, "add", path);
          if (separator === "=")
            writeFileSync(join(options.root, path), `${quote}${field}${quote} ${separator} 'opaque-provider-secret'`);
          excluded.push({ path, reason: "secret-content" });
        }
      }
    }
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
        return reply(init.body);
      },
    });
    expect(calls).toBe(1);
    expect(result.status).toBe("reviewed");
    expect(result.excluded).toEqual(excluded.toSorted((left, right) => left.path.localeCompare(right.path)));
    expect(result.findings.map((finding) => finding.file)).toEqual([
      "README.md",
      "cart.ts",
      "config.json",
      "(batch)",
    ]);
    const receipts = readdirSync(options.receipts);
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
    expect(readdirSync(options.receipts)).toHaveLength(2);
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
    const first = readdirSync(options.receipts)[0] ?? "";
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

  test("Noul values stay separate from probability and confidence", () => {
    expect(measurement({ type: "noul", noul: -2.5, confidence: 0.99 })).toEqual({
      noulScore: -2.5,
      score: null,
      probability: null,
      confidence: null,
    });
    expect(measurement({ type: "score", score: 0.8, confidence: 0.4 })).toEqual({
      noulScore: null,
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
