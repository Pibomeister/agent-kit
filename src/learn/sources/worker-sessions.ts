/**
 * Offline capture for worker hosts that already persist their own sessions.
 * The parser never calls a host or a model: it reads Codex rollouts, Grok
 * session folders and Kimi wire logs, then condenses their public transcript
 * into one observation per turn, in the observation-source shape used by the
 * memory loop. Captured text is scrubbed of credentials and home directories
 * and cut to short excerpts before it is stored; full tool output never is.
 */
import { createHash } from "node:crypto";
import Ajv from "ajv";
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Ledger } from "../core/ledger.ts";
import { linkedWorktree } from "../core/paths.ts";
import { appendJsonl, readJsonl, writeJsonl } from "../core/store.ts";
import { sid8 } from "../memory/ledger.ts";
import { scrubSecrets } from "../memory/redact.ts";
import type { Registry, Worktrees } from "../memory/registry.ts";
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
  /** When the host last wrote the record. */
  modified_at_epoch: number;
  prompt_count: number;
  request: string | null;
  completed: string | null;
  next_steps: string | null;
  files_modified: string[];
  observations: CapturedObservation[];
}

interface StoredSession extends SessionRow {
  native_id: string;
  modified_at_epoch: number;
  prompt_count: number;
  request: string | null;
  completed: string | null;
  next_steps: string | null;
  files_modified: string[];
}

interface StoredObservation extends ObservationRow {
  /** Digest of the row's title and text, which is how a later scan recognizes it. */
  key: string;
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

interface ToolCall {
  name: string;
  input: string;
  output: string;
}

/** One user prompt and everything the worker did until the next one. */
interface Turn {
  prompt: string;
  reply: string;
  calls: ToolCall[];
  files: string[];
  at: number;
}

export const CAPTURE_ID_BASE = 4_000_000_000_000_000;
export const CAPTURE_OBSERVATIONS_FILE = "raw/worker-observations.jsonl";
export const CAPTURE_SESSIONS_FILE = "raw/worker-sessions.jsonl";
/** How far back the scan reads host records, and how long the ledger keeps a session its host stopped writing. */
export const CAPTURE_WINDOW_MS = 30 * 86_400_000;
export const MAX_OBSERVATIONS = 999;
/** A turn nobody ended counts as over once its record has been quiet this long. */
const IDLE_MS = 3_600_000;
const READ_TEXT = 8_000;
const MAX_TEXT = 2_000;
const PROMPT_CHARS = 110;
const REPLY_CHARS = 110;
const FAILED_CHARS = 50;
const INPUT_CHARS = 120;
const OUTPUT_CHARS = 300;
const FAILURE_WORDS =
  "(?:errors?|fail(?:s|ed|ures?|ing)?|warnings?|regressions?|timeouts?|blocked|findings?|violations?)";
const FAILURE_TEXT = new RegExp(`\\b${FAILURE_WORDS}\\b`, "i");
const ZERO_FAILURES = new RegExp(`\\b(?:0|no)\\s+${FAILURE_WORDS}\\b`, "gi");
const CODEX_INJECTED = /^\s*(?:# AGENTS\.md instructions\b|<environment_context>|<skill>)/;
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

/** The first line of a file, read without loading the rest. */
function firstLine(path: string): string {
  const fd = openSync(path, "r");
  try {
    const chunks: Buffer[] = [];
    const buffer = Buffer.alloc(65_536);
    for (;;) {
      const read = readSync(fd, buffer, 0, buffer.length, null);
      if (read === 0) break;
      const end = buffer.subarray(0, read).indexOf(10);
      chunks.push(Buffer.from(buffer.subarray(0, end === -1 ? read : end)));
      if (end !== -1) break;
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

function epoch(value: JsonValue | undefined, fallback: number): number {
  const direct = number(value);
  if (direct !== null) return direct > 10_000_000_000 ? direct : Math.round(direct * 1000);
  const text = string(value);
  if (text === null) return fallback;
  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? fallback : parsed;
}

/** Host text made storable: control characters dropped, scrubbed, then cut. Scrubbing runs before the cut so no cut leaves half a credential. */
function clipped(value: string): string {
  return scrubSecrets(
    value
      .replace(/\p{Cc}/gu, (character) => (character === "\n" || character === "\t" ? character : " "))
      .trim()
      .slice(0, READ_TEXT),
  ).slice(0, MAX_TEXT);
}

function excerpt(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
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

function reportsFailure(text: string): boolean {
  return FAILURE_TEXT.test(text.replace(ZERO_FAILURES, ""));
}

function normalizedFile(path: string, cwd: string): string | null {
  const clean = path.trim();
  if (clean === "" || clean.includes("\n")) return null;
  if (!isAbsolute(clean)) return clean.replace(/^\.\//, "");
  const rel = relative(cwd, clean);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel) ? rel : scrubSecrets(clean);
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

/** Collects a session's events into turns. A prompt opens a turn; a tool output joins the oldest call still waiting for one. */
function turnLog() {
  const turns: Turn[] = [];
  const start = (prompt: string, at: number): Turn => {
    const turn: Turn = { prompt, reply: "", calls: [], files: [], at };
    turns.push(turn);
    return turn;
  };
  const current = (at: number): Turn => {
    const turn = turns.at(-1) ?? start("", at);
    turn.at = at;
    return turn;
  };
  return {
    turns,
    prompt(text: string, at: number): void {
      start(text, at);
    },
    reply(text: string, at: number): void {
      current(at).reply = text;
    },
    call(name: string, input: ParsedToolInput, cwd: string, at: number): void {
      const turn = current(at);
      turn.calls.push({ name, input: input.text, output: "" });
      if (WRITE_TOOLS.test(name)) turn.files.push(...filesFromValue(input.parsed, cwd));
    },
    output(text: string, at: number): void {
      const turn = current(at);
      const waiting = turn.calls.find((call) => call.output === "");
      if (waiting === undefined) turn.calls.push({ name: "tool", input: "", output: text });
      else waiting.output = text;
    },
  };
}

/**
 * One turn as one observation. It leads with a summary of at most 300 characters, which is as far
 * as the shortest judge excerpt reads: the prompt, the last reply and the names of the calls that
 * failed. The detail follows: how often each tool ran, then each call with short excerpts of its
 * arguments and output, failing calls first. A turn with a failing output is typed `error`.
 */
function turnObservation(turn: Turn): CapturedObservation {
  const failing = turn.calls.filter((call) => reportsFailure(call.output));
  const counts = new Map<string, number>();
  for (const call of turn.calls) counts.set(call.name, (counts.get(call.name) ?? 0) + 1);
  const lines: string[] = [];
  if (turn.prompt !== "") lines.push(`prompt: ${excerpt(turn.prompt, PROMPT_CHARS)}`);
  if (turn.reply !== "") lines.push(`reply: ${excerpt(turn.reply, REPLY_CHARS)}`);
  if (failing.length > 0)
    lines.push(`failed: ${excerpt([...new Set(failing.map((call) => call.name))].join(", "), FAILED_CHARS)}`);
  if (counts.size > 0) lines.push(`tools: ${[...counts].map(([name, count]) => `${name} x${count}`).join(", ")}`);
  for (const call of [...failing, ...turn.calls.filter((item) => !failing.includes(item))])
    lines.push(`${call.name} ${excerpt(call.input, INPUT_CHARS)} -> ${excerpt(call.output, OUTPUT_CHARS)}`);
  return {
    type: failing.length > 0 ? "error" : "turn",
    title: "worker turn",
    text: lines.join("\n").slice(0, MAX_TEXT),
    at: turn.at,
    files_modified: [...new Set(turn.files)].toSorted(),
  };
}

/**
 * The session as stored. A last turn still running is left for a later scan, since its outcome is
 * not written yet. Past `MAX_OBSERVATIONS` the first prompt and the newest turns are kept, with a
 * marker row counting what was left out between them.
 */
function session(
  host: WorkerHost,
  nativeId: string,
  cwd: string,
  times: { started: number; ended: number | null; modified: number; now: number },
  log: readonly Turn[],
): CapturedSession | null {
  const settled = times.ended !== null || times.now - times.modified > IDLE_MS;
  const turns = (settled ? log : log.slice(0, -1)).filter(
    (turn) => turn.prompt !== "" || turn.reply !== "" || turn.calls.length > 0,
  );
  if (turns.length === 0) return null;
  const prompts = turns.filter((turn) => turn.prompt !== "");
  const tail = turns.length > MAX_OBSERVATIONS ? turns.slice(2 - MAX_OBSERVATIONS) : turns;
  const head = prompts.slice(0, 1).filter((turn) => !tail.includes(turn));
  const dropped = turns.length - tail.length - head.length;
  const marker: CapturedObservation[] =
    dropped > 0
      ? [
          {
            type: "truncated",
            title: "worker turns omitted",
            text: `${dropped} earlier turns of this session were left out`,
            at: tail[0]?.at ?? times.started,
            files_modified: [],
          },
        ]
      : [];
  return {
    native_id: nativeId,
    memory_session_id: stableSessionId(host, nativeId),
    platform: host,
    cwd,
    started_at_epoch: times.started,
    completed_at_epoch: times.ended === null ? null : Math.max(times.started, times.ended),
    modified_at_epoch: times.modified,
    prompt_count: prompts.length,
    request: prompts[0]?.prompt ?? null,
    completed: turns.findLast((turn) => turn.reply !== "")?.reply ?? null,
    next_steps: null,
    files_modified: [...new Set(turns.flatMap((turn) => turn.files))].toSorted(),
    observations: [...head.map(turnObservation), ...marker, ...tail.map(turnObservation)],
  };
}

/** A Codex user message without the instruction and environment blocks the host injects. */
function codexUserContent(value: JsonValue | undefined): JsonValue | undefined {
  if (Array.isArray(value)) return value.filter((part) => !CODEX_INJECTED.test(string(object(part)?.text) ?? ""));
  return CODEX_INJECTED.test(string(value) ?? "") ? undefined : value;
}

/** A rollout opens with its `session_meta` line, which is all the scan reads to place a session. */
function codexMeta(row: JsonObject | null | undefined): JsonObject | null {
  return row?.type === "session_meta" ? object(row.payload) : null;
}

function codexNativeId(payload: JsonObject | null): string | null {
  return string(payload?.id) ?? string(payload?.session_id);
}

function grokNativeId(dir: string, summary: JsonObject | null): string {
  return string(object(summary?.info)?.id) ?? basename(dir);
}

function kimiNativeId(dir: string, state: JsonObject | null): string {
  return string(state?.id) ?? basename(dir);
}

export function parseCodexSession(path: string, now = Date.now()): CapturedSession | null {
  const rows = readJsonLines(path);
  const meta = rows[0];
  const payload = codexMeta(meta);
  const cwd = string(payload?.cwd);
  const nativeId = codexNativeId(payload);
  if (cwd === null || nativeId === null) return null;
  const modified = statSync(path).mtimeMs;
  const started = epoch(payload?.timestamp ?? meta?.timestamp, modified);
  let ended: number | null = null;
  const log = turnLog();
  let offset = 0;
  for (const row of rows) {
    const event = object(row.payload);
    if (event === null) continue;
    const at = epoch(row.timestamp ?? event.timestamp, started + offset++);
    if (event.type === "task_started") ended = null;
    if (event.type === "task_complete") ended = Math.max(ended ?? 0, epoch(event.completed_at, at));
    if (event.type === "message" && (event.role === "user" || event.role === "assistant")) {
      const text = publicText(event.role === "user" ? codexUserContent(event.content) : event.content);
      if (text === "") continue;
      if (event.role === "user") log.prompt(text, at);
      else log.reply(text, at);
      continue;
    }
    if (event.type === "custom_tool_call" || event.type === "function_call") {
      log.call(string(event.name) ?? "tool", toolInput(event.input ?? event.arguments), cwd, at);
      continue;
    }
    if (event.type === "custom_tool_call_output" || event.type === "function_call_output") {
      const text = publicText(event.output);
      if (text !== "") log.output(text, at);
    }
  }
  return session("codex", nativeId, cwd, { started, ended, modified, now }, log.turns);
}

function grokCwd(dir: string, summary: JsonObject | null): string | null {
  const recorded = string(object(summary?.info)?.cwd);
  if (recorded !== null) return recorded;
  try {
    return decodeURIComponent(basename(dirname(dir)));
  } catch {
    return null;
  }
}

export function parseGrokSession(dir: string, now = Date.now()): CapturedSession | null {
  const historyPath = join(dir, "chat_history.jsonl");
  if (!existsSync(historyPath)) return null;
  const summary = readObject(join(dir, "summary.json"));
  const cwd = grokCwd(dir, summary);
  if (cwd === null) return null;
  const nativeId = grokNativeId(dir, summary);
  const modified = statSync(historyPath).mtimeMs;
  const started = epoch(summary?.created_at, modified);
  let ended: number | null = null;
  const log = turnLog();
  let offset = 0;
  const history = readJsonLines(historyPath);
  for (const row of history) {
    const at = started + offset++;
    if (row.type === "user" && row.synthetic_reason === undefined) {
      const text = publicText(row.content);
      if (text !== "") log.prompt(text, at);
    } else if (row.type === "assistant") {
      const text = publicText(row.content);
      if (text !== "") log.reply(text, at);
      for (const call of Array.isArray(row.tool_calls) ? row.tool_calls : []) {
        const tool = object(call);
        const fn = object(tool?.function);
        log.call(string(fn?.name ?? tool?.name) ?? "tool", toolInput(fn?.arguments ?? tool?.arguments), cwd, at);
      }
    } else if (row.type === "tool_result") {
      const text = publicText(row.content);
      if (text !== "") log.output(text, at);
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
    ended = epoch(summary?.last_active_at ?? summary?.updated_at, modified);
  return session("grok", nativeId, cwd, { started, ended, modified, now }, log.turns);
}

export function parseKimiSession(dir: string, now = Date.now()): CapturedSession | null {
  const state = readObject(join(dir, "state.json"));
  const path = join(dir, "agents", "main", "wire.jsonl");
  if (state === null || !existsSync(path)) return null;
  const cwd = string(state.cwd);
  const nativeId = kimiNativeId(dir, state);
  if (cwd === null) return null;
  const modified = statSync(path).mtimeMs;
  const started = epoch(state.createdAt, modified);
  let ended: number | null = null;
  const log = turnLog();
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
    const text = publicText(message.content);
    if (text !== "") {
      if (role === "user") log.prompt(text, at);
      else if (role === "assistant") log.reply(text, at);
      else if (role === "tool") log.output(text, at);
    }
    if (role !== "assistant") continue;
    for (const call of Array.isArray(message.toolCalls) ? message.toolCalls : []) {
      const tool = object(call);
      if (tool !== null) log.call(string(tool.name) ?? "tool", toolInput(tool.arguments), cwd, at);
    }
  }
  const parsed = session("kimi", nativeId, cwd, { started, ended, modified, now }, log.turns);
  const lastPrompt = string(state.lastPrompt);
  if (parsed !== null && parsed.request === null && lastPrompt !== null) parsed.request = clipped(lastPrompt);
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

/**
 * Where a recorded cwd belongs: the deepest registered root, or worktree recorded for one, that
 * contains it, compared as text. A cwd none of them contains is placed by the `.git` pointer of
 * the linked worktree it sits in, when that names a registered root.
 */
export function workerRootResolver(registry: Registry, worktrees: Worktrees): (cwd: string) => string | null {
  const roots = new Set(Object.values(registry).map((entry) => entry.root));
  const places = [
    ...[...roots].map((root): [string, string] => [root, root]),
    ...Object.entries(worktrees).filter(([, root]) => roots.has(root)),
  ].toSorted((a, b) => b[0].length - a[0].length);
  return (cwd) => {
    const path = resolve(cwd);
    const placed = places.find(([place]) => path === place || path.startsWith(`${place}${sep}`))?.[1];
    if (placed !== undefined) return placed;
    const root = linkedWorktree(path)?.root;
    return root !== undefined && roots.has(root) ? root : null;
  };
}

function writtenAt(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

export interface WorkerScan {
  /** Parsed sessions by the registered root their cwd resolved to, oldest first. */
  sessions: Map<string, CapturedSession[]>;
  /** When a worker was last active under each root, counting the sessions left unparsed because the ledger holds them. */
  activity: Map<string, number>;
  /** Recent sessions whose cwd resolved to no registered root; these are never parsed. */
  unmatched: number;
}

/**
 * Recent host sessions under a registered root. Only a record's cwd and id are read before `rootFor`
 * places it, so a session of an unregistered project costs one small read. Every record is placed
 * before any is parsed: `wanted` is asked once per root with the newest time a host wrote under it,
 * and a root it refuses has none of its sessions parsed. A session the root's `stored` rows already
 * hold complete as its record stands is not parsed either. An unreadable record is skipped and
 * reported through `warn`.
 */
export function scanWorkerSessions(
  homes: WorkerHomes,
  rootFor: (cwd: string) => string | null,
  options: {
    sinceMs?: number;
    warn?: (line: string) => void;
    wanted?: (root: string, newestMs: number) => boolean;
    stored?: (root: string) => WorkerSessionSource | null;
  } = {},
): WorkerScan {
  const sinceMs = options.sinceMs ?? Date.now() - CAPTURE_WINDOW_MS;
  const scan: WorkerScan = { sessions: new Map(), activity: new Map(), unmatched: 0 };
  const active = (root: string, at: number) => scan.activity.set(root, Math.max(scan.activity.get(root) ?? 0, at));
  const placed = new Map<string, { newest: number; read: Array<() => void> }>();
  const guarded = (path: string, step: () => void) => {
    try {
      step();
    } catch (error) {
      options.warn?.(`worker session skipped: ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const collect = (
    host: WorkerHost,
    path: string,
    record: string,
    identify: () => { cwd: string | null; nativeId: string | null },
    parse: () => CapturedSession | null,
  ) => {
    const touched = writtenAt(path);
    if (touched < sinceMs) return;
    guarded(path, () => {
      const { cwd, nativeId } = identify();
      if (cwd === null) return;
      const root = rootFor(cwd);
      if (root === null) {
        scan.unmatched += 1;
        return;
      }
      const modified = statSync(record).mtimeMs;
      const place = placed.get(root) ?? { newest: 0, read: [] };
      placed.set(root, place);
      place.newest = Math.max(place.newest, touched, modified);
      place.read.push(() =>
        guarded(path, () => {
          const held =
            nativeId !== null && modified >= sinceMs
              ? (options.stored?.(root)?.completedAt(stableSessionId(host, nativeId), modified) ?? null)
              : null;
          if (held !== null) {
            active(root, held);
            return;
          }
          const parsed = parse();
          if (parsed === null) return;
          scan.sessions.set(root, [...(scan.sessions.get(root) ?? []), parsed]);
          active(root, parsed.completed_at_epoch ?? parsed.observations.at(-1)?.at ?? parsed.started_at_epoch);
        }),
      );
    });
  };
  for (const home of homes.codex) {
    for (const path of walk(
      join(home, "sessions"),
      (file) => basename(file).startsWith("rollout-") && file.endsWith(".jsonl"),
    ))
      collect(
        "codex",
        path,
        path,
        () => {
          const meta = codexMeta(object(parseJson(firstLine(path))));
          return { cwd: string(meta?.cwd), nativeId: codexNativeId(meta) };
        },
        () => parseCodexSession(path),
      );
  }
  for (const home of homes.grok) {
    for (const path of walk(join(home, "sessions"), (file) => basename(file) === "chat_history.jsonl")) {
      const dir = dirname(path);
      collect(
        "grok",
        path,
        path,
        () => {
          const summary = readObject(join(dir, "summary.json"));
          return { cwd: grokCwd(dir, summary), nativeId: grokNativeId(dir, summary) };
        },
        () => parseGrokSession(dir),
      );
    }
  }
  for (const home of homes.kimi) {
    for (const path of walk(join(home, "sessions"), (file) => basename(file) === "state.json")) {
      const dir = dirname(path);
      const wire = join(dir, "agents", "main", "wire.jsonl");
      if (existsSync(wire))
        collect(
          "kimi",
          path,
          wire,
          () => {
            const state = readObject(path);
            return { cwd: string(state?.cwd), nativeId: kimiNativeId(dir, state) };
          },
          () => parseKimiSession(dir),
        );
    }
  }
  for (const [root, place] of placed)
    if (options.wanted?.(root, place.newest) !== false) for (const read of place.read) read();
  for (const rows of scan.sessions.values())
    rows.sort(
      (a, b) => a.started_at_epoch - b.started_at_epoch || a.memory_session_id.localeCompare(b.memory_session_id),
    );
  return scan;
}

function rowKey(row: CapturedObservation): string {
  return createHash("sha256").update(`${row.title}\n${row.text}`).digest("hex").slice(0, 16);
}

function storedObservation(item: CapturedSession, row: CapturedObservation, id: number): StoredObservation {
  return {
    id,
    key: rowKey(row),
    memory_session_id: item.memory_session_id,
    project: "",
    type: row.type,
    title: row.title,
    subtitle: null,
    narrative: null,
    facts: row.text,
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
    modified_at_epoch: item.modified_at_epoch,
    observation_count: observationCount,
    native_id: item.native_id,
    prompt_count: item.prompt_count,
    request: item.request,
    completed: item.completed,
    next_steps: item.next_steps,
    files_modified: item.files_modified,
  };
}

export function isCapturedObservation(row: Pick<ObservationRow, "id">): boolean {
  return row.id >= CAPTURE_ID_BASE;
}

/** A project's captured worker rows, read from its ledger once and kept in step with what `capture` writes. */
export class WorkerSessionSource implements MemoryObservationSource {
  private observations: StoredObservation[] = [];
  private readonly bySession = new Map<string, StoredObservation[]>();
  private sessionRows = new Map<string, StoredSession>();

  private constructor(
    private readonly observationsPath: string,
    private readonly sessionsPath: string,
  ) {
    this.hold(readJsonl<StoredObservation>(observationsPath), readJsonl<StoredSession>(sessionsPath));
  }

  static open(ledger: Ledger): WorkerSessionSource {
    return new WorkerSessionSource(ledger.path(CAPTURE_OBSERVATIONS_FILE), ledger.path(CAPTURE_SESSIONS_FILE));
  }

  private hold(observations: readonly StoredObservation[], sessions: readonly StoredSession[]): void {
    this.observations = observations.toSorted((a, b) => a.id - b.id);
    this.sessionRows = new Map(sessions.map((row) => [row.memory_session_id, row]));
    this.bySession.clear();
    for (const row of this.observations) {
      const rows = this.bySession.get(row.memory_session_id);
      if (rows === undefined) this.bySession.set(row.memory_session_id, [row]);
      else rows.push(row);
    }
  }

  /**
   * Append the rows of each host session the ledger does not hold yet, matched by a digest of title
   * and text rather than position, since a host may rewrite its record. A stored session that is not
   * in `sessions` and whose host last wrote it before `sinceMs` is dropped, so the files hold the same
   * window the scan reads; the newest row stays until a newer one is appended, which keeps ids rising.
   * A finished session whose record changed without a new row has its session row rewritten, so the
   * scan can tell the ledger is level with the record. Returns observations appended and session rows
   * written; a dry run counts them and changes nothing.
   */
  capture(sessions: readonly CapturedSession[], options: { dryRun?: boolean; sinceMs?: number } = {}) {
    const held = this.observations;
    const scanned = new Set(sessions.map((item) => item.memory_session_id));
    const expired = (sid: string) =>
      !scanned.has(sid) && (this.sessionRows.get(sid)?.modified_at_epoch ?? 0) < (options.sinceMs ?? 0);
    const newestId = held.at(-1)?.id ?? CAPTURE_ID_BASE - 1;
    let nextId = newestId;
    const fresh: StoredObservation[] = [];
    const revisions: StoredSession[] = [];
    for (const item of sessions) {
      const stored = this.bySession.get(item.memory_session_id) ?? [];
      const unseen = new Map<string, number>();
      for (const row of stored) unseen.set(row.key, (unseen.get(row.key) ?? 0) + 1);
      const appended: StoredObservation[] = [];
      for (const row of item.observations) {
        const key = rowKey(row);
        const count = unseen.get(key) ?? 0;
        if (count > 0) unseen.set(key, count - 1);
        else appended.push(storedObservation(item, row, ++nextId));
      }
      const row = this.sessionRows.get(item.memory_session_id);
      if (
        appended.length === 0 &&
        (row === undefined ||
          item.completed_at_epoch === null ||
          (row.modified_at_epoch === item.modified_at_epoch && row.completed_at_epoch === item.completed_at_epoch))
      )
        continue;
      fresh.push(...appended);
      revisions.push(storedSession(item, stored.length + appended.length));
    }
    const written = { observations: fresh.length, sessions: revisions.length };
    if (options.dryRun === true) return written;
    const kept = held.filter((row) => !expired(row.memory_session_id) || (fresh.length === 0 && row.id === newestId));
    const pruned = kept.length < held.length;
    const latest = [...this.sessionRows.values(), ...revisions].filter(
      (row) => !pruned || !expired(row.memory_session_id),
    );
    if (pruned) {
      writeJsonl(this.observationsPath, [...kept, ...fresh]);
      writeJsonl(this.sessionsPath, [...new Map(latest.map((row) => [row.memory_session_id, row])).values()]);
    } else {
      appendJsonl(this.observationsPath, fresh);
      appendJsonl(this.sessionsPath, revisions);
    }
    this.hold([...kept, ...fresh], latest);
    return written;
  }

  /** When the stored session ended, if the ledger holds it complete as its host record stood at `modifiedMs`. */
  completedAt(memorySessionId: string, modifiedMs: number): number | null {
    const row = this.sessionRows.get(memorySessionId);
    return row !== undefined && row.modified_at_epoch === modifiedMs ? row.completed_at_epoch : null;
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
    return this.bySession.get(memorySessionId) ?? [];
  }

  observationSessions(ids: readonly number[]): Map<number, string> {
    const wanted = new Set(ids);
    const sessions = new Map<number, string>();
    for (const row of this.observations) if (wanted.has(row.id)) sessions.set(row.id, row.memory_session_id);
    return sessions;
  }

  /** Whether a lesson evidence id names a worker row: an `obs:N` in the captured range, held or dropped, or an `S<sid>` of a session held here. */
  owns(evidence: string): boolean {
    if (evidence.startsWith("obs:")) return isCapturedObservation({ id: Number(evidence.slice(4)) });
    return this.sessionRows.keys().some((sid) => sid8(sid) === evidence);
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
