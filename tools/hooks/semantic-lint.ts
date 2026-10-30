#!/usr/bin/env bun
/** Advisory sibling command hook. It never runs or replaces deterministic lint. */
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import Ajv from "ajv";
import {
  askBatch,
  requestFor,
  scoreCriteria,
  type BatchOptions,
  type BatchResult,
} from "../../src/semantic-lint/client.ts";
import { acquireClaim, claimKey, settleClaim } from "../../src/semantic-lint/claim.ts";
import { collectInput, type HookInput } from "../../src/semantic-lint/input.ts";
import { readKeyFile } from "../../src/semantic-lint/key.ts";
import { carrierOf, parseTraceparent } from "../../src/learn/core/trace.ts";
import { readJsonObject, shellQuote, writeJsonWithBackup, type HookDoc } from "../../src/learn/setup/wire.ts";
import pin from "../../provenance/semantic-lint.json";

export interface HookOptions extends Omit<BatchOptions, "key" | "traceparent"> {
  root: string;
  enabled: boolean;
  keyFile: string;
  traceparent?: string;
}

export type Enablement = { enabled: boolean; explicit: boolean };

/** "0" and "1" are explicit; unset or any other value runs by default, with quiet skips. */
export function enablement(flag: string | undefined): Enablement {
  if (flag === "0") return { enabled: false, explicit: true };
  if (flag === "1") return { enabled: true, explicit: true };
  return { enabled: true, explicit: false };
}

export interface OutputOptions {
  explicit?: boolean;
  host?: "claude-code" | "codex";
}

type HookResult = (
  | BatchResult
  | { status: "skipped"; reason: "duplicate"; findings: []; priorTrace: string | null }
  | { status: "skipped"; reason: "in-progress"; findings: [] }
  | { status: "skipped"; reason: string; findings: [] }
  | { status: "error"; reason: "input" | "auth"; findings: [] }
) & { advisory: true; excluded: HookInput["excluded"]; excludedOmitted: number; traceparent?: string };

interface HookBase {
  advisory: true;
  excluded: HookInput["excluded"];
  excludedOmitted: number;
}

export async function runHook(options: HookOptions): Promise<HookResult> {
  const base: HookBase = { advisory: true, excluded: [], excludedOmitted: 0 };
  if (!options.enabled) return { ...base, status: "skipped", reason: "disabled", findings: [] };
  let key: string | null;
  try {
    key = readKeyFile(options.keyFile);
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
  base.excludedOmitted = input.excludedOmitted ?? 0;
  if (input.files.length === 0) return { ...base, status: "skipped", reason: "no-input", findings: [] };
  const parent = parseTraceparent(options.traceparent);
  const traceparent =
    parent === null
      ? carrierOf({ traceId: randomBytes(16).toString("hex"), spanId: randomBytes(8).toString("hex") })
      : (options.traceparent ?? carrierOf(parent));
  const acquired = acquireClaim(options.receipts, claimKey(JSON.stringify(requestFor(input).request)), traceparent);
  if (acquired.kind === "error") return { ...base, status: "error", reason: "receipt", findings: [] };
  if (acquired.kind === "duplicate")
    return { ...base, status: "skipped", reason: "duplicate", findings: [], priorTrace: acquired.trace };
  if (acquired.kind === "in-progress") return { ...base, status: "skipped", reason: "in-progress", findings: [] };
  let settled: "complete" | "released" = "released";
  try {
    const result = await askBatch(input, { ...options, key, traceparent });
    if (result.status === "reviewed") settled = "complete";
    return { ...base, ...result, traceparent };
  } finally {
    settleClaim(acquired.claim, settled, traceparent);
  }
}

/** What the host reads on stdout: the structured result, or for Codex only the message. */
export type HostOutput = (HookResult & { systemMessage?: string }) | { systemMessage?: string };

/** Default mode keeps skips quiet; errors and reviewed results always carry the message. */
export function hookOutput(result: HookResult, options: OutputOptions = {}): HostOutput {
  if (options.explicit === false && result.status === "skipped") return options.host === "codex" ? {} : { ...result };
  const details = result.findings.map((finding) => {
    const label = scoreCriteria[Math.floor(finding.score)] ?? "unknown";
    return `${JSON.stringify(finding.file)} (${finding.rule}): score ${finding.score}/3 (${label}); confidence ${finding.confidence ?? "unknown"}`;
  });
  const systemMessage = [
    `JEV lint (advisory): ${result.status}${"reason" in result ? ` (${result.reason})` : ""}.`,
    ...(result.traceparent === undefined ? [] : [`Receipt trace: ${result.traceparent}`]),
    ...("priorTrace" in result && result.priorTrace !== null ? [`Prior receipt trace: ${result.priorTrace}`] : []),
    ...details,
    ...(result.findings.some((finding) => finding.score >= 2)
      ? ["JEV does not identify the exact claim; inspect the named files manually before changing code."]
      : []),
    ...result.excluded.map((item) => `${JSON.stringify(item.path)}: excluded (${item.reason})`),
    ...(result.excludedOmitted === 0 ? [] : [`${result.excludedOmitted} additional paths excluded (details omitted)`]),
  ].join("\n");
  return options.host === "codex" ? { systemMessage } : { ...result, systemMessage };
}

/** The one Stop entry both the source file and the bundled `ak semantic-lint hook` run. 2 is a usage error. */
export async function hookMain(argv: string[]): Promise<number> {
  const codex = argv.length === 2 && argv[0] === "--host" && argv[1] === "codex";
  if (argv.length > 0 && !codex) return 2;
  const { enabled, explicit } = enablement(process.env.AK_JEV_ENABLED);
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once("SIGTERM", cancel);
  process.once("SIGINT", cancel);
  const result = await runHook({
    root: process.cwd(),
    enabled,
    keyFile: join(homedir(), pin.key_file),
    receipts: join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "agent-kit", "semantic-lint"),
    traceparent: process.env.TRACEPARENT,
    signal: controller.signal,
  });
  console.log(JSON.stringify(hookOutput(result, { explicit, host: codex ? "codex" : "claude-code" })));
  return 0;
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
const isSemanticCommand = (command: string) => /(?:^|\/)semantic-lint\.ts['"]?\s+hook$/.test(command);

export function wireHook(settings: string, entry: string): void {
  const doc = readJsonObject<HookDoc>(settings, {});
  if (doc === null || !isHookDoc(doc)) throw new Error("invalid-settings");
  const command = `${shellQuote(process.execPath)} ${shellQuote(resolve(entry))} hook`;
  doc.hooks ??= {};
  const entries = doc.hooks.Stop ?? [];
  const existing = entries
    .flatMap((item) => item.hooks ?? [])
    .find((hook) => isCommand(hook.command) && isSemanticCommand(hook.command));
  if (existing !== undefined) {
    if (existing.command === command && existing.timeout === 30) return;
    existing.command = command;
    existing.timeout = 30;
  } else entries.push({ hooks: [{ type: "command", command, timeout: 30 }] });
  doc.hooks.Stop = entries;
  writeJsonWithBackup(settings, doc);
}

export function unwireHook(settings: string): void {
  const doc = readJsonObject<HookDoc>(settings, {});
  if (doc === null || !isHookDoc(doc)) throw new Error("invalid-settings");
  const entries = doc.hooks?.Stop;
  if (entries === undefined) return;
  const kept: typeof entries = [];
  let changed = false;
  for (const entry of entries) {
    if (entry.hooks === undefined) {
      kept.push(entry);
      continue;
    }
    const hooks = entry.hooks.filter((hook) => !isCommand(hook.command) || !isSemanticCommand(hook.command));
    if (hooks.length === entry.hooks.length) kept.push(entry);
    else {
      changed = true;
      if (hooks.length > 0) kept.push({ ...entry, hooks });
    }
  }
  if (!changed || doc.hooks === undefined) return;
  if (kept.length === 0) delete doc.hooks.Stop;
  else doc.hooks.Stop = kept;
  if (Object.keys(doc.hooks).length === 0) delete doc.hooks;
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
  } else if (verb === "unwire" && settings !== undefined && extra.length === 0) {
    try {
      unwireHook(settings);
      console.log(JSON.stringify({ status: "unwired" }));
    } catch {
      console.log(JSON.stringify({ status: "error", reason: "settings" }));
      process.exitCode = 1;
    }
  } else {
    const code = verb === "hook" ? await hookMain(process.argv.slice(3)) : 2;
    if (code === 2)
      console.error("usage: bun tools/hooks/semantic-lint.ts hook | wire <settings.json> | unwire <settings.json>");
    process.exitCode = code;
  }
}
