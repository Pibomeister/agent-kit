/**
 * Operator-bound, tool-less chat command. The stage prompt arrives on stdin;
 * one result/usage envelope leaves on stdout. Provider settings stay outside
 * the catalog. Run with bun and bind its absolute path per worker host.
 */
import { readFileSync } from "node:fs";
import Ajv from "ajv";

interface ChatReply {
  choices: [{ finish_reason: "stop"; message: { content: string } }];
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

interface ChatRequest {
  model: string;
  messages: Array<{ role: "user"; content: string }>;
  max_completion_tokens: number;
  store: false;
  reasoning_effort?: string;
}

const validateReply = new Ajv({ strict: false }).compile<ChatReply>({
  type: "object",
  required: ["choices", "usage"],
  properties: {
    choices: {
      type: "array",
      minItems: 1,
      maxItems: 1,
      items: {
        type: "object",
        required: ["finish_reason", "message"],
        properties: {
          finish_reason: { const: "stop" },
          message: {
            type: "object",
            required: ["content"],
            not: { anyOf: [{ required: ["tool_calls"] }, { required: ["function_call"] }] },
            properties: { content: { type: "string", minLength: 1 } },
          },
        },
      },
    },
    usage: {
      type: "object",
      required: ["prompt_tokens", "completion_tokens", "total_tokens"],
      properties: {
        prompt_tokens: { type: "integer", minimum: 0 },
        completion_tokens: { type: "integer", minimum: 0 },
        total_tokens: { type: "integer", minimum: 0 },
      },
    },
  },
});

function setting(name: string): string {
  const value = process.env[`AK_LEARN_DISTILL_API_${name}`]?.trim();
  if (value === undefined || value === "") throw new Error("missing setting");
  return value;
}

async function main(): Promise<void> {
  const url = new URL(setting("URL"));
  const local = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) throw new Error("insecure URL");
  if (url.username !== "" || url.password !== "") throw new Error("URL credentials are not supported");
  const model = setting("MODEL");
  const key = readFileSync(setting("KEY_FILE"), "utf8").trim();
  if (key === "") throw new Error("empty credential");
  const prompt = await Bun.stdin.text();
  if (prompt.trim() === "") throw new Error("empty prompt");
  const body: ChatRequest = {
    model,
    messages: [{ role: "user", content: prompt }],
    max_completion_tokens: 4096,
    store: false,
  };
  const reasoning = process.env.AK_LEARN_DISTILL_API_REASONING?.trim();
  if (reasoning !== undefined && reasoning !== "") body.reasoning_effort = reasoning;
  const response = await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    redirect: "error",
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) {
    process.stderr.write(`chat distiller: HTTP ${response.status}\n`);
    process.exitCode = 1;
    return;
  }
  const reply: unknown = await response.json();
  if (!validateReply(reply)) {
    process.stderr.write("chat distiller: invalid reply\n");
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`${JSON.stringify({ result: reply.choices[0].message.content, usage: reply.usage })}\n`);
}

// Never print a thrown error: transport/provider errors can contain credentials or captured text.
await main().catch(() => {
  process.stderr.write("chat distiller: request failed\n");
  process.exitCode = 1;
});
