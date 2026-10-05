/**
 * Offline capture for worker hosts that already persist their own sessions.
 * The parser never calls a host or a model: it reads Codex rollouts, Grok
 * session folders and Kimi wire logs, then normalizes their public transcript
 * events into the observation-source shape used by the memory loop.
 */
import { createHash } from "node:crypto";
import Ajv from "ajv";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { Ledger } from "../core/ledger.ts";
import { run } from "../core/proc.ts";
import { appendJsonl, readJsonl } from "../core/store.ts";
import type { Registry } from "../memory/registry.ts";
import type { MemoryObservationSource, ObservationRow, SessionRow, SummaryRow } from "./claude-mem.ts";
import { ClaudeMemSource } from "./claude-mem.ts";

export type WorkerHost = "codex" | "grok" | "kimi";

export interface WorkerHomes {
  codex: string[];
  grok: string[];
  kimi: string[];
}

export interface CapturedObservation {
  type: string;
  title: string;
  text: string;
  at: number;
  files_modified: string[];
}

export interface CapturedSession {
  native_id: string;
  memory_session_id: string;
  platform: WorkerHost;
  cwd: string;
  started_at_epoch: number;
  completed_at_epoch: number | null;
  prompt_count: number;
  request: string | null;
  completed: string | null;
  next_steps: string | null;
  files_modified: string[];
  observations: CapturedObservation[];
}

interface StoredSession extends SessionRow {
  native_id: string;
  prompt_count: number;
  request: string | null;
  completed: string | null;
  next_steps: string | null;
  files_modified: string[];
}

type JsonScalar = string | number | boolean | null;
type JsonValue = JsonScalar | JsonValue[] | JsonObject;
interface JsonObject {
  [key: string]: JsonValue;
}

interface ParsedToolInput {
  text: string;
  parsed: JsonValue;
}

export const CAPTURE_ID_BASE = 4_000_000_000_000_000;
export const CAPTURE_OBSERVATIONS_FILE = "raw/worker-observations.jsonl";
export const CAPTURE_SESSIONS_FILE = "raw/worker-sessions.jsonl";
const MAX_OBSERVATIONS = 999;
const MAX_TEXT = 8_000;
const FAILURE_WORDS = "(?:error|fail(?:ed|ure|ing)?|warnings?|regression|timeout|blocked|finding|violation)";
const FAILURE_TEXT = new RegExp(`\\b${FAILURE_WORDS}\\b`, "i");
const ZERO_FAILURES = new RegExp(`\\b(?:0|no)\\s+${FAILURE_WORDS}\\b`, "gi");
const CODEX_INJECTED = /^\s*(?:# AGENTS\.md instructions for |<environment_context>)/;
const WRITE_TOOLS = /(?:apply[_-]?patch|write|edit|replace|search_replace|notebookedit)/i;
const jsonValidator = new Ajv({ strict: false });
const validateJsonValue = jsonValidator.compile<JsonValue>({
  $defs: {
    value: {
      anyOf: [
        { type: "string" },
        { type: "number" },
        { type: "boolean" },
        { type: "null" },
        { type: "array", items: { $ref: "#/$defs/value" } },
        { type: "object", additionalProperties: { $ref: "#/$defs/value" } },
      ],
    },
  },
  $ref: "#/$defs/value",
});
const validateObject = jsonValidator.compile<JsonObject>({ type: "object" });
const validateString = jsonValidator.compile<string>({ type: "string" });
const validateNumber = jsonValidator.compile<number>({ type: "number" });

function object(value: JsonValue | undefined): JsonObject | null {
  return value !== undefined && validateObject(value) ? value : null;
}

function string(value: JsonValue | undefined): string | null {
  return value !== undefined && validateString(value) && value.trim() !== "" ? value : null;
}

function number(value: JsonValue | undefined): number | null {
  return value !== undefined && validateNumber(value) && Number.isFinite(value) ? value : null;
}

function parseJson(value: string): JsonValue | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return validateJsonValue(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function readObject(path: string): JsonObject | null {
  if (!existsSync(path)) return null;
  return object(parseJson(readFileSync(path, "utf8")));
}

function readJsonLines(path: string): JsonObject[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .flatMap((line) => {
      if (line.trim() === "") return [];
      const row = object(parseJson(line));
      return row === null ? [] : [row];
    });
}

function epoch(value: JsonValue | undefined, fallback: number): number {
  const direct = number(value);
  if (direct !== null) return direct > 10_000_000_000 ? direct : Math.round(direct * 1000);
  const text = string(value);
  if (text === null) return fallback;
  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function clipped(value: string): string {
  return value
    .replace(/\p{Cc}/gu, (character) => (character === "\n" || character === "\t" ? character : " "))
    .trim()
    .slice(0, MAX_TEXT);
}

/** Public text parts only. Encrypted content and Kimi `think` parts are deliberately excluded. */
function publicText(value: JsonValue | undefined): string {
  if (value !== undefined && validateString(value)) return clipped(value);
  if (!Array.isArray(value)) return "";
  return clipped(
    value
      .flatMap((part) => {
        const item = object(part);
        if (item === null || item.type === "encrypted_content" || item.type === "think") return [];
        const text = string(item.text);
        return text === null ? [] : [text];
      })
      .join("\n"),
  );
}

function stableSessionId(host: WorkerHost, nativeId: string): string {
  return createHash("sha256").update(`${host}:${nativeId}`).digest("hex").slice(0, 32);
}

function observation(type: string, title: string, text: string, at: number, files: string[] = []): CapturedObservation {
  return { type, title, text: clipped(text), at, files_modified: [...new Set(files)].toSorted() };
}

function resultType(text: string): string {
  return FAILURE_TEXT.test(text.replace(ZERO_FAILURES, "")) ? "error" : "tool-result";
}

function normalizedFile(path: string, cwd: string): string | null {
  const clean = path.trim();
  if (clean === "" || clean.includes("\n")) return null;
  if (!isAbsolute(clean)) return clean.replace(/^\.\//, "");
  const rel = relative(cwd, clean);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel) ? rel : clean;
}

function filesFromValue(value: JsonValue | undefined, cwd: string): string[] {
  const found = new Set<string>();
  const visit = (item: JsonValue | undefined, key = "") => {
    if (item !== undefined && validateString(item)) {
      if (/^(?:file_path|path|filename)$/i.test(key)) {
        const path = normalizedFile(item, cwd);
        if (path !== null) found.add(path);
      }
      for (const match of item.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) {
        const matchedPath = match[1];
        if (matchedPath === undefined) continue;
        const path = normalizedFile(matchedPath, cwd);
        if (path !== null) found.add(path);
      }
      return;
    }
    if (Array.isArray(item)) {
      for (const child of item) visit(child, key);
      return;
    }
    const record = object(item);
    if (record !== null) for (const [childKey, child] of Object.entries(record)) visit(child, childKey);
  };
  visit(value);
  return [...found].toSorted();
}

function toolInput(value: JsonValue | undefined): ParsedToolInput {
  if (value !== undefined && validateString(value)) return { text: clipped(value), parsed: parseJson(value) ?? value };
  return { text: clipped(JSON.stringify(value ?? {})), parsed: value ?? {} };
}

function session(
  host: WorkerHost,
  nativeId: string,
  cwd: string,
  started: number,
  ended: number | null,
  observations: CapturedObservation[],
  files: Set<string>,
): CapturedSession | null {
  const kept = observations.filter((row) => row.text !== "").slice(0, MAX_OBSERVATIONS);
  if (kept.length === 0) return null;
  const prompts = kept.filter((row) => row.type === "prompt");
  const assistants = kept.filter((row) => row.type === "assistant");
  return {
    native_id: nativeId,
    memory_session_id: stableSessionId(host, nativeId),
    platform: host,
    cwd,
    started_at_epoch: started,
    completed_at_epoch: ended === null ? null : Math.max(started, ended),
    prompt_count: prompts.length,
    request: prompts[0]?.text ?? null,
    completed: assistants.at(-1)?.text ?? null,
    next_steps: null,
    files_modified: [...files].toSorted(),
    observations: kept,
  };
}

/** A Codex user message without the instruction and environment blocks the host injects. */
function codexUserContent(value: JsonValue | undefined): JsonValue | undefined {
  if (Array.isArray(value)) return value.filter((part) => !CODEX_INJECTED.test(string(object(part)?.text) ?? ""));
  return CODEX_INJECTED.test(string(value) ?? "") ? undefined : value;
}

export function parseCodexSession(path: string): CapturedSession | null {
  const rows = readJsonLines(path);
  const meta = rows.find((row) => row.type === "session_meta" && object(row.payload)?.cwd !== undefined);
  const payload = object(meta?.payload);
  const cwd = string(payload?.cwd);
  const nativeId = string(payload?.id) ?? string(payload?.session_id);
  if (cwd === null || nativeId === null) return null;
  const fallback = statSync(path).mtimeMs;
  const started = epoch(payload?.timestamp ?? meta?.timestamp, fallback);
  let ended: number | null = null;
  const observations: CapturedObservation[] = [];
  const files = new Set<string>();
  let offset = 0;
  for (const row of rows) {
    const event = object(row.payload);
    if (event === null) continue;
    const at = epoch(row.timestamp ?? event.timestamp, started + offset++);
    if (event.type === "task_started") ended = null;
    if (event.type === "task_complete") ended = Math.max(ended ?? 0, epoch(event.completed_at, at));
    if (event.type === "message" && (event.role === "user" || event.role === "assistant")) {
      const text = publicText(event.role === "user" ? codexUserContent(event.content) : event.content);
      if (text !== "")
        observations.push(
          observation(event.role === "user" ? "prompt" : "assistant", `${event.role} message`, text, at),
        );
      continue;
    }
    if (event.type === "custom_tool_call" || event.type === "function_call") {
      const name = string(event.name) ?? "tool";
      const input = toolInput(event.input ?? event.arguments);
      const touched = WRITE_TOOLS.test(name) ? filesFromValue(input.parsed, cwd) : [];
      for (const file of touched) files.add(file);
      observations.push(observation("tool-use", name, input.text, at, touched));
      continue;
    }
    if (event.type === "custom_tool_call_output" || event.type === "function_call_output") {
      const text = publicText(event.output);
      if (text !== "") observations.push(observation(resultType(text), "tool result", text, at));
    }
  }
  return session("codex", nativeId, cwd, started, ended, observations, files);
}

export function parseGrokSession(dir: string): CapturedSession | null {
  const historyPath = join(dir, "chat_history.jsonl");
  if (!existsSync(historyPath)) return null;
  const summary = readObject(join(dir, "summary.json"));
  const info = object(summary?.info);
  let cwd = string(info?.cwd);
  if (cwd === null) {
    try {
      cwd = decodeURIComponent(basename(dirname(dir)));
    } catch {
      return null;
    }
  }
  const nativeId = string(info?.id) ?? basename(dir);
  const fallback = statSync(historyPath).mtimeMs;
  const started = epoch(summary?.created_at, fallback);
  let ended: number | null = null;
  const observations: CapturedObservation[] = [];
  const files = new Set<string>();
  let offset = 0;
  const history = readJsonLines(historyPath);
  for (const row of history) {
    const at = started + offset++;
    if (row.type === "user" && row.synthetic_reason === undefined) {
      const text = publicText(row.content);
      if (text !== "") observations.push(observation("prompt", "user message", text, at));
    } else if (row.type === "assistant") {
      const text = publicText(row.content);
      if (text !== "") observations.push(observation("assistant", "assistant message", text, at));
      for (const call of Array.isArray(row.tool_calls) ? row.tool_calls : []) {
        const tool = object(call);
        const fn = object(tool?.function);
        const name = string(fn?.name ?? tool?.name) ?? "tool";
        const input = toolInput(fn?.arguments ?? tool?.arguments);
        const touched = WRITE_TOOLS.test(name) ? filesFromValue(input.parsed, cwd) : [];
        for (const file of touched) files.add(file);
        observations.push(observation("tool-use", name, input.text, at, touched));
      }
    } else if (row.type === "tool_result") {
      const text = publicText(row.content);
      if (text !== "") observations.push(observation(resultType(text), "tool result", text, at));
    }
  }
  const lastPublic = history.findLast(
    (row) => row.type === "user" || row.type === "assistant" || row.type === "tool_result",
  );
  if (
    lastPublic?.type === "assistant" &&
    publicText(lastPublic.content) !== "" &&
    (!Array.isArray(lastPublic.tool_calls) || lastPublic.tool_calls.length === 0)
  )
    ended = epoch(summary?.last_active_at ?? summary?.updated_at, fallback);
  return session("grok", nativeId, cwd, started, ended, observations, files);
}

export function parseKimiSession(dir: string): CapturedSession | null {
  const state = readObject(join(dir, "state.json"));
  const path = join(dir, "agents", "main", "wire.jsonl");
  if (state === null || !existsSync(path)) return null;
  const cwd = string(state.cwd);
  const nativeId = string(state.id) ?? basename(dir);
  if (cwd === null) return null;
  const fallback = statSync(path).mtimeMs;
  const started = epoch(state.createdAt, fallback);
  let ended: number | null = null;
  const observations: CapturedObservation[] = [];
  const files = new Set<string>();
  for (const row of readJsonLines(path)) {
    const at = epoch(row.time, started);
    if (row.type === "turn.prompt" || row.type === "agent.turn.started" || row.type === "turn.steer") ended = null;
    if (row.type === "turn.ended" || row.type === "agent.turn.ended") {
      ended = Math.max(ended ?? 0, at);
      continue;
    }
    if (row.type !== "agent.message.appended") continue;
    const envelope = object(row.message);
    const message = object(envelope?.message);
    if (message === null) continue;
    const role = string(message.role);
    const origin = object(message.origin) ?? object(object(envelope?.meta)?.origin);
    if (role === "user" && origin?.kind !== "user") continue;
    if (role === "user" || role === "assistant" || role === "tool") {
      const text = publicText(message.content);
      if (text !== "") {
        const type = role === "user" ? "prompt" : role === "assistant" ? "assistant" : resultType(text);
        observations.push(observation(type, `${role} message`, text, at));
      }
    }
    if (role !== "assistant") continue;
    for (const call of Array.isArray(message.toolCalls) ? message.toolCalls : []) {
      const tool = object(call);
      if (tool === null) continue;
      const name = string(tool.name) ?? "tool";
      const input = toolInput(tool.arguments);
      const touched = WRITE_TOOLS.test(name) ? filesFromValue(input.parsed, cwd) : [];
      for (const file of touched) files.add(file);
      observations.push(observation("tool-use", name, input.text, at, touched));
    }
  }
  const parsed = session("kimi", nativeId, cwd, started, ended, observations, files);
  if (parsed !== null && parsed.request === null) parsed.request = string(state.lastPrompt);
  return parsed;
}

function splitHomes(value: string | undefined, fallback: string): string[] {
  const homes =
    value
      ?.split(delimiter)
      .map((entry) => entry.trim())
      .filter((entry) => entry !== "") ?? [];
  return homes.length > 0 ? [...new Set(homes.map((entry) => resolve(entry)))] : [fallback];
}

export function workerHomes(env: NodeJS.ProcessEnv = process.env): WorkerHomes {
  const home = env.HOME && env.HOME.trim() !== "" ? env.HOME : homedir();
  const codex = env.CODEX_HOME && env.CODEX_HOME.trim() !== "" ? env.CODEX_HOME : join(home, ".codex");
  const grok = env.GROK_HOME && env.GROK_HOME.trim() !== "" ? env.GROK_HOME : join(home, ".grok");
  const kimi = env.KIMI_HOME && env.KIMI_HOME.trim() !== "" ? env.KIMI_HOME : join(home, ".kimi-code");
  return {
    codex: splitHomes(env.AK_LEARN_CODEX_HOMES, codex),
    grok: splitHomes(env.AK_LEARN_GROK_HOMES, grok),
    kimi: splitHomes(env.AK_LEARN_KIMI_HOMES, kimi),
  };
}

function walk(dir: string, accept: (path: string) => boolean): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const pending = [dir];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) break;
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile() && accept(path)) out.push(path);
    }
  }
  return out.toSorted();
}

/** Every recent host session that parses. An unreadable record is skipped and reported through `warn`. */
export function scanWorkerSessions(
  homes: WorkerHomes,
  options: { sinceMs?: number; warn?: (line: string) => void } = {},
): CapturedSession[] {
  const sinceMs = options.sinceMs ?? Date.now() - 30 * 86_400_000;
  const recent = (path: string) => {
    try {
      return statSync(path).mtimeMs >= sinceMs;
    } catch {
      return false;
    }
  };
  const sessions: CapturedSession[] = [];
  const collect = (path: string, parse: () => CapturedSession | null) => {
    try {
      const parsed = parse();
      if (parsed !== null) sessions.push(parsed);
    } catch (error) {
      options.warn?.(`worker session skipped: ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  for (const home of homes.codex) {
    for (const path of walk(
      join(home, "sessions"),
      (file) => basename(file).startsWith("rollout-") && file.endsWith(".jsonl"),
    )) {
      if (recent(path)) collect(path, () => parseCodexSession(path));
    }
  }
  for (const home of homes.grok) {
    for (const path of walk(join(home, "sessions"), (file) => basename(file) === "chat_history.jsonl")) {
      if (recent(path)) collect(path, () => parseGrokSession(dirname(path)));
    }
  }
  for (const home of homes.kimi) {
    for (const path of walk(join(home, "sessions"), (file) => basename(file) === "state.json")) {
      if (existsSync(join(dirname(path), "agents", "main", "wire.jsonl")) && recent(path))
        collect(path, () => parseKimiSession(dirname(path)));
    }
  }
  return sessions.toSorted(
    (a, b) => a.started_at_epoch - b.started_at_epoch || a.memory_session_id.localeCompare(b.memory_session_id),
  );
}

function commonDir(cwd: string): string | null {
  const result = run(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, timeoutMs: 10_000 });
  if (result.code !== 0 || result.stdout.trim() === "") return null;
  try {
    return realpathSync(result.stdout.trim());
  } catch {
    return resolve(cwd, result.stdout.trim());
  }
}

function isWorktree(root: string): boolean {
  return run(["git", "rev-parse", "--is-inside-work-tree"], { cwd: root, timeoutMs: 10_000 }).stdout.trim() === "true";
}

/** Match by repository identity, never by a same-looking cwd or basename. */
export function registeredRootForCwd(registry: Registry, cwd: string): string | null {
  const target = commonDir(cwd);
  if (target === null) return null;
  return registeredRootsByCommonDir(registry).get(target) ?? null;
}

function registeredRootsByCommonDir(registry: Registry): Map<string, string> {
  const roots = new Map<string, string>();
  for (const entry of Object.values(registry)) {
    for (const candidate of [entry.root, ...(entry.aliases ?? [])]) {
      if (!isWorktree(candidate)) continue;
      const common = commonDir(candidate);
      if (common !== null) roots.set(common, entry.root);
    }
  }
  return roots;
}

export function sessionsByRegisteredRoot(
  registry: Registry,
  sessions: readonly CapturedSession[],
): Map<string, CapturedSession[]> {
  const grouped = new Map<string, CapturedSession[]>();
  const roots = registeredRootsByCommonDir(registry);
  const cache = new Map<string, string | null>();
  for (const item of sessions) {
    let root = cache.get(item.cwd);
    if (root === undefined) {
      const common = commonDir(item.cwd);
      root = common === null ? null : (roots.get(common) ?? null);
      cache.set(item.cwd, root);
    }
    if (root === null) continue;
    const rows = grouped.get(root) ?? [];
    rows.push(item);
    grouped.set(root, rows);
  }
  return grouped;
}

function storedObservation(item: CapturedSession, row: CapturedObservation, id: number): ObservationRow {
  return {
    id,
    memory_session_id: item.memory_session_id,
    project: "",
    type: row.type,
    title: row.title,
    subtitle: null,
    narrative: row.text,
    facts: JSON.stringify([row.text]),
    concepts: JSON.stringify([]),
    files_read: JSON.stringify([]),
    files_modified: JSON.stringify(row.files_modified),
    discovery_tokens: Math.ceil(row.text.length / 4),
    created_at: new Date(row.at).toISOString(),
    created_at_epoch: row.at,
    platform_source: item.platform,
  };
}

function storedSession(item: CapturedSession, observationCount: number): StoredSession {
  return {
    id: 0,
    memory_session_id: item.memory_session_id,
    platform_source: item.platform,
    started_at_epoch: item.started_at_epoch,
    completed_at_epoch: item.completed_at_epoch,
    observation_count: observationCount,
    native_id: item.native_id,
    prompt_count: item.prompt_count,
    request: item.request,
    completed: item.completed,
    next_steps: item.next_steps,
    files_modified: item.files_modified,
  };
}

/** Append only the newly grown suffix of each host session. Returns observations appended. */
export function captureWorkerSessions(
  ledger: Ledger,
  sessions: readonly CapturedSession[],
  options: { dryRun?: boolean } = {},
): number {
  const observations = readJsonl<ObservationRow>(ledger.path(CAPTURE_OBSERVATIONS_FILE));
  const counts = new Map<string, number>();
  for (const row of observations) counts.set(row.memory_session_id, (counts.get(row.memory_session_id) ?? 0) + 1);
  let nextId = CAPTURE_ID_BASE - 1;
  for (const row of observations) nextId = Math.max(nextId, row.id);
  const fresh: ObservationRow[] = [];
  const revisions: StoredSession[] = [];
  for (const item of sessions) {
    const before = counts.get(item.memory_session_id) ?? 0;
    const appended = item.observations.slice(before).map((row) => storedObservation(item, row, ++nextId));
    if (appended.length === 0) continue;
    fresh.push(...appended);
    const total = before + appended.length;
    counts.set(item.memory_session_id, total);
    revisions.push(storedSession(item, total));
  }
  if (fresh.length > 0 && options.dryRun !== true) {
    appendJsonl(ledger.path(CAPTURE_OBSERVATIONS_FILE), fresh);
    appendJsonl(ledger.path(CAPTURE_SESSIONS_FILE), revisions);
  }
  return fresh.length;
}

export function isCapturedObservation(row: Pick<ObservationRow, "id">): boolean {
  return row.id >= CAPTURE_ID_BASE;
}

export class WorkerSessionSource implements MemoryObservationSource {
  private readonly observations: ObservationRow[];
  private readonly sessionRows: Map<string, StoredSession>;

  private constructor(observations: ObservationRow[], sessions: StoredSession[]) {
    this.observations = observations.toSorted((a, b) => a.id - b.id);
    this.sessionRows = new Map(sessions.map((row) => [row.memory_session_id, row]));
  }

  static open(ledger: Ledger): WorkerSessionSource {
    return new WorkerSessionSource(
      readJsonl<ObservationRow>(ledger.path(CAPTURE_OBSERVATIONS_FILE)),
      readJsonl<StoredSession>(ledger.path(CAPTURE_SESSIONS_FILE)),
    );
  }

  close(): void {}

  lastActivityMs(_project: string): number {
    return this.observations.reduce((latest, row) => Math.max(latest, row.created_at_epoch), 0);
  }

  newTokensSince(_project: string, afterId: number) {
    const rows = this.observations.filter((row) => row.id > afterId);
    return { tokens: rows.reduce((sum, row) => sum + (row.discovery_tokens ?? 0), 0), count: rows.length };
  }

  observationsSince(
    _project: string,
    afterId: number,
    options: { sinceEpochMs?: number; newestFirst?: boolean } = {},
  ): ObservationRow[] {
    const rows = this.observations.filter(
      (row) => row.id > afterId && row.created_at_epoch >= (options.sinceEpochMs ?? 0),
    );
    return rows.toSorted((a, b) => (options.newestFirst === true ? b.id - a.id : a.id - b.id));
  }

  observationsById(ids: readonly number[]): ObservationRow[] {
    const wanted = new Set(ids);
    return this.observations.filter((row) => wanted.has(row.id));
  }

  sessionObservations(memorySessionId: string): ObservationRow[] {
    return this.observations.filter((row) => row.memory_session_id === memorySessionId);
  }

  observationSessions(ids: readonly number[]): Map<number, string> {
    const wanted = new Set(ids);
    const sessions = new Map<number, string>();
    for (const row of this.observations) if (wanted.has(row.id)) sessions.set(row.id, row.memory_session_id);
    return sessions;
  }

  sessions(_project: string, sinceMs: number, staleBeforeMs: number): SessionRow[] {
    return [...this.sessionRows.values()]
      .filter(
        (row) =>
          row.started_at_epoch >= sinceMs && (row.completed_at_epoch !== null || row.started_at_epoch < staleBeforeMs),
      )
      .toSorted((a, b) => a.started_at_epoch - b.started_at_epoch);
  }

  latestSummary(memorySessionId: string): SummaryRow | null {
    const row = this.sessionRows.get(memorySessionId);
    return row === undefined
      ? null
      : {
          memory_session_id: row.memory_session_id,
          request: row.request,
          completed: row.completed,
          next_steps: row.next_steps,
        };
  }

  summaries(memorySessionIds: readonly string[]): SummaryRow[] {
    return memorySessionIds.flatMap((sid) => {
      const row = this.latestSummary(sid);
      return row === null ? [] : [row];
    });
  }

  promptCount(_sessionDbId: number, memorySessionId?: string): number {
    return memorySessionId === undefined ? 0 : (this.sessionRows.get(memorySessionId)?.prompt_count ?? 0);
  }

  editedFiles(memorySessionId: string): string[] {
    return this.sessionRows.get(memorySessionId)?.files_modified ?? [];
  }
}

/** The memory loop sees claude-mem and this project's captured workers as one read-only source. */
export class ProjectMemorySource implements MemoryObservationSource {
  constructor(
    private readonly claude: ClaudeMemSource | null,
    readonly workers: WorkerSessionSource,
  ) {}

  close(): void {
    // The tick owns the shared claude-mem handle; a per-project view does not close it.
  }

  lastActivityMs(project: string): number {
    return Math.max(this.claude?.lastActivityMs(project) ?? 0, this.workers.lastActivityMs(project));
  }

  newTokensSince(project: string, afterId: number) {
    return this.claude?.newTokensSince(project, afterId) ?? { tokens: 0, count: 0 };
  }

  capturedTokensSince(project: string, afterId: number) {
    return this.workers.newTokensSince(project, afterId);
  }

  observationsSince(
    project: string,
    afterId: number,
    options: { sinceEpochMs?: number; newestFirst?: boolean } = {},
  ): ObservationRow[] {
    return this.claude?.observationsSince(project, afterId, options) ?? [];
  }

  capturedObservationsSince(
    project: string,
    afterId: number,
    options: { sinceEpochMs?: number; newestFirst?: boolean } = {},
  ): ObservationRow[] {
    return this.workers.observationsSince(project, afterId, options);
  }

  observationsById(ids: readonly number[]): ObservationRow[] {
    const native = ids.filter((observationId) => observationId < CAPTURE_ID_BASE);
    const captured = ids.filter((observationId) => observationId >= CAPTURE_ID_BASE);
    return [...(this.claude?.observationsById(native) ?? []), ...this.workers.observationsById(captured)].toSorted(
      (a, b) => a.id - b.id,
    );
  }

  sessionObservations(memorySessionId: string): ObservationRow[] {
    const captured = this.workers.sessionObservations(memorySessionId);
    return captured.length > 0 ? captured : (this.claude?.sessionObservations(memorySessionId) ?? []);
  }

  observationSessions(ids: readonly number[]): Map<number, string> {
    const out =
      this.claude?.observationSessions(ids.filter((observationId) => observationId < CAPTURE_ID_BASE)) ??
      new Map<number, string>();
    for (const [observationId, sid] of this.workers.observationSessions(
      ids.filter((candidateId) => candidateId >= CAPTURE_ID_BASE),
    ))
      out.set(observationId, sid);
    return out;
  }

  sessions(project: string, sinceMs: number, staleBeforeMs: number): SessionRow[] {
    return [
      ...(this.claude?.sessions(project, sinceMs, staleBeforeMs) ?? []),
      ...this.workers.sessions(project, sinceMs, staleBeforeMs),
    ].toSorted((a, b) => a.started_at_epoch - b.started_at_epoch);
  }

  latestSummary(memorySessionId: string): SummaryRow | null {
    return this.workers.latestSummary(memorySessionId) ?? this.claude?.latestSummary(memorySessionId) ?? null;
  }

  summaries(memorySessionIds: readonly string[]): SummaryRow[] {
    return memorySessionIds.flatMap((sid) => {
      const row = this.latestSummary(sid);
      return row === null ? [] : [row];
    });
  }

  promptCount(sessionDbId: number, memorySessionId?: string): number {
    return this.workers.promptCount(sessionDbId, memorySessionId) || this.claude?.promptCount(sessionDbId) || 0;
  }

  editedFiles(memorySessionId: string): string[] {
    return [
      ...new Set([...this.workers.editedFiles(memorySessionId), ...(this.claude?.editedFiles(memorySessionId) ?? [])]),
    ].toSorted();
  }
}
