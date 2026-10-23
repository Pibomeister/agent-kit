#!/usr/bin/env bun
/** Optional sibling command hook. It never runs or replaces deterministic lint. */
import { lstatSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import Ajv from "ajv";
import { askBatch, type BatchOptions, type BatchResult } from "../../src/semantic-lint/client.ts";
import { collectInput, type HookInput } from "../../src/semantic-lint/input.ts";
import { carrierOf, parseTraceparent } from "../../src/learn/core/trace.ts";
import { readJsonObject, shellQuote, writeJsonWithBackup, type HookDoc } from "../../src/learn/setup/wire.ts";
import pin from "../../provenance/semantic-lint.json";

export interface HookOptions extends Omit<BatchOptions, "key" | "traceparent"> {
  root: string;
  enabled: boolean;
  keyFile: string;
  traceparent?: string;
}

type HookResult = (
  | BatchResult
  | { status: "skipped"; reason: string; findings: [] }
  | { status: "error"; reason: "input" | "auth"; findings: [] }
) & { advisory: true; excluded: HookInput["excluded"] };

interface HookBase {
  advisory: true;
  excluded: HookInput["excluded"];
}

/** Called only by the sibling command process. The parent shell never parses the key. */
function privateKey(path: string): string | null {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat === undefined) return null;
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o777) !== 0o600 ||
    (process.getuid !== undefined && stat.uid !== process.getuid())
  )
    throw new Error("auth");
  const lines = readFileSync(path, "utf8").split("\n");
  for (const line of lines) {
    const match =
      /^(?:TYPESAFE_API_KEY|TYPESAFEAI_API_KEY)\s*=\s*(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s#'"`$]+))\s*$/.exec(
        line.trim(),
      );
    const value = match?.[1] ?? match?.[2] ?? match?.[3];
    if (value !== undefined) return value;
  }
  throw new Error("auth");
}

export async function runHook(options: HookOptions): Promise<HookResult> {
  const base: HookBase = { advisory: true, excluded: [] };
  if (!options.enabled) return { ...base, status: "skipped", reason: "disabled", findings: [] };
  let key: string | null;
  try {
    key = privateKey(options.keyFile);
  } catch {
    return { ...base, status: "error", reason: "auth", findings: [] };
  }
  if (key === null) return { ...base, status: "skipped", reason: "missing-key", findings: [] };
  let input: HookInput;
  try {
    input = collectInput(options.root);
  } catch {
    return { ...base, status: "error", reason: "input", findings: [] };
  }
  base.excluded = input.excluded;
  if (input.files.length === 0) return { ...base, status: "skipped", reason: "no-input", findings: [] };
  const parent = parseTraceparent(options.traceparent);
  const traceparent =
    parent === null
      ? carrierOf({ traceId: randomBytes(16).toString("hex"), spanId: randomBytes(8).toString("hex") })
      : (options.traceparent ?? carrierOf(parent));
  return { ...base, ...(await askBatch(input, { ...options, key, traceparent })) };
}

export function hookOutput(result: HookResult) {
  const details = result.findings.map(
    (finding) =>
      `${finding.file} (${finding.rule}): score ${finding.score}; confidence ${finding.confidence ?? "unknown"}`,
  );
  return {
    ...result,
    systemMessage: [
      `JEV lint (advisory): ${result.status}${"reason" in result ? ` (${result.reason})` : ""}.`,
      ...details,
      ...result.excluded.map((item) => `${item.path}: excluded (${item.reason})`),
    ].join("\n"),
  };
}

/** Same sibling-entry merge pattern as hostHooks(); foreign commands are untouched. */
const ajv = new Ajv({ strict: false });
const isHookDoc = ajv.compile<HookDoc>({
  type: "object",
  properties: {
    hooks: {
      type: "object",
      additionalProperties: {
        type: "array",
        items: {
          type: "object",
          properties: {
            hooks: { type: "array", items: { type: "object", properties: { command: { type: "string" } } } },
          },
        },
      },
    },
  },
});
const isCommand = ajv.compile<string>({ type: "string" });

export function wireHook(settings: string, entry: string): void {
  const doc = readJsonObject<HookDoc>(settings, {});
  if (doc === null || !isHookDoc(doc)) throw new Error("invalid-settings");
  const command = `${shellQuote(process.execPath)} ${shellQuote(resolve(entry))} hook`;
  doc.hooks ??= {};
  const entries = doc.hooks.Stop ?? [];
  const existing = entries
    .flatMap((item) => item.hooks ?? [])
    .find((hook) => isCommand(hook.command) && /(?:^|\/)semantic-lint\.ts['"]?\s+hook$/.test(hook.command));
  if (existing !== undefined) {
    if (existing.command === command && existing.timeout === 30) return;
    existing.command = command;
    existing.timeout = 30;
  } else entries.push({ hooks: [{ type: "command", command, timeout: 30 }] });
  doc.hooks.Stop = entries;
  writeJsonWithBackup(settings, doc);
}

if (import.meta.main) {
  const [verb, settings, ...extra] = process.argv.slice(2);
  if (verb === "wire" && settings !== undefined && extra.length === 0) {
    try {
      wireHook(settings, import.meta.path);
      console.log(JSON.stringify({ status: "wired", enabled: false }));
    } catch {
      console.log(JSON.stringify({ status: "error", reason: "settings" }));
      process.exitCode = 1;
    }
  } else if (verb === "hook" && settings === undefined) {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    process.once("SIGTERM", cancel);
    process.once("SIGINT", cancel);
    const result = await runHook({
      root: process.cwd(),
      enabled: process.env.AK_JEV_ENABLED === "1",
      keyFile: join(homedir(), pin.key_file),
      receipts: join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "agent-kit", "semantic-lint"),
      traceparent: process.env.TRACEPARENT,
      signal: controller.signal,
    });
    console.log(JSON.stringify(hookOutput(result)));
  } else {
    console.error("usage: bun tools/hooks/semantic-lint.ts hook | wire <settings.json>");
    process.exitCode = 2;
  }
}
