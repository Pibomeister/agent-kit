/**
 * The skill doctor's collector: local Claude Code, Codex and Grok sessions,
 * condensed into short transcripts a judge can score.
 *
 * Adapted from warpdotdev/common-skills' `skill-doctor` collector
 * (`scripts/collect_sessions.py`): the same per-entry limits, the same
 * head-and-tail cut, the same newest-first sampling per skill, and a session
 * kept only when it shows both an assistant turn and a tool call. The changes
 * are local: transcripts pass the shared secret gate before they are written,
 * the output directory may not be a tracked part of a repository, a session's
 * working directory is matched as text so no git process starts in a folder
 * the session named, and each user message is classified by the
 * claude-reflect detector so corrections are counted, not guessed.
 */
import { existsSync, openSync, readFileSync, readSync, closeSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { parseFrontmatter } from "../../util/frontmatter.ts";
import { detectPatterns } from "../review/hooks.ts";
import { scrubCaptured } from "../memory/redact.ts";
import { userHome, workerHomes } from "../sources/worker-sessions.ts";
import { items, object, objects, parseJson, readObject, text as str, type JsonObject, type JsonValue } from "./json.ts";

export type DoctorHost = "claude" | "codex" | "grok";
export const DOCTOR_HOSTS: readonly DoctorHost[] = ["claude", "codex", "grok"];

/** The donor's limits: one message, one tool call or output, and the entries one transcript keeps. */
export const MAX_MSG_CHARS = 1500;
export const MAX_TOOL_CHARS = 500;
export const MAX_TRANSCRIPT_ENTRIES = 160;
export const TRANSCRIPT_HEAD = 100;
export const TRANSCRIPT_TAIL = 40;
export const DEFAULT_DAYS = 45;
export const DEFAULT_MAX_SESSIONS = 12;
export const DEFAULT_PER_SKILL = 3;
export const DEFAULT_NO_SKILL = 4;

/** Bytes read to place a session before it is parsed: its first records carry the working directory. */
const PEEK_BYTES = 64 * 1024;

export interface Entry {
  /** `user`, `assistant`, `tool:<name>`, `output` or `note`. */
  kind: string;
  text: string;
}

export interface SessionStats {
  user_turns: number;
  assistant_turns: number;
  tool_calls: number;
  repeated_tool_calls: number;
  error_outputs: number;
  code_edits: boolean;
  /** User messages the claude-reflect detector classifies as a correction. */
  corrections: number;
}

export interface DoctorSession {
  /** `<host>-<native id>`: the transcript's file name and the id every later step cites. */
  key: string;
  host: DoctorHost;
  id: string;
  cwd: string | null;
  started_at: string | null;
  modified_ms: number;
  stats: SessionStats;
  /** Installed skill names this session used, sorted. */
  skills_used: string[];
  entries: Entry[];
}

export interface SkillInfo {
  name: string;
  path: string;
  scope: "project" | "global";
  description: string;
}

export interface CollectOptions {
  hosts: readonly DoctorHost[];
  /** Repository roots a session's working directory must belong to; empty means every session. */
  repos: readonly string[];
  /** The linked worktrees of `repos`: a session in one of them belongs too. */
  worktrees: readonly string[];
  days: number;
  maxSessions: number;
  perSkill: number;
  noSkill: number;
  includeGlobalSkills: boolean;
  claudeHomes: readonly string[];
  codexHomes: readonly string[];
  grokHomes: readonly string[];
  skillDirs: readonly string[];
  now: number;
}

export interface Collection {
  generated_at: string;
  hosts: DoctorHost[];
  repos: string[];
  window_days: number;
  sessions_scanned: number;
  sessions_matched: number;
  skills: SkillInfo[];
  sampled: DoctorSession[];
}

function parseLine(line: string): JsonObject | null {
  return object(parseJson(line) ?? undefined);
}

function readRows(path: string): JsonObject[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  return text.split("\n").flatMap((line) => {
    const row = line.trim() === "" ? null : parseLine(line);
    return row === null ? [] : [row];
  });
}

/** The complete lines in a file's first `PEEK_BYTES`. */
function peekRows(path: string): JsonObject[] {
  const buffer = Buffer.alloc(PEEK_BYTES);
  let read = 0;
  try {
    const fd = openSync(path, "r");
    try {
      read = readSync(fd, buffer, 0, PEEK_BYTES, 0);
    } finally {
      closeSync(fd);
    }
  } catch {
    return [];
  }
  const lines = buffer.subarray(0, read).toString("utf8").split("\n");
  if (read === PEEK_BYTES) lines.pop();
  return lines.flatMap((line) => {
    const row = line.trim() === "" ? null : parseLine(line);
    return row === null ? [] : [row];
  });
}

export function truncate(text: string, limit: number): string {
  const flat = text.trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit)} [… ${flat.length - limit} chars cut]`;
}

/** Text the host injects into a user turn: environment, instruction and reminder blocks. The donor's tag list. */
const INJECTED_TAGS = [
  "environment_context",
  "user_instructions",
  "ENVIRONMENT",
  "system-reminder",
  "permissions",
  "collaboration_mode",
  "recommended_plugins",
  "turn_context",
  "user_info",
  "local-command-caveat",
  "local-command-stdout",
  "task-notification",
];

export function looksInjected(text: string): boolean {
  const head = text.trimStart().slice(0, 80);
  if (head.startsWith("# AGENTS.md instructions")) return true;
  return head.startsWith("<") && INJECTED_TAGS.some((tag) => head.includes(tag));
}

/** Skill names a tool argument names: a `skills/<name>/` path or a `"skill"` / `"name"` key. The donor's rule. */
export function skillCandidates(text: string): string[] {
  const normalized = text.replaceAll("\\", "/");
  const out = new Set<string>();
  for (const [, name] of normalized.matchAll(/(?:^|\/)skills\/+([^/\s"'`]+)\/+/g))
    if (name !== undefined) out.add(name);
  for (const [, name] of normalized.matchAll(/"(?:skill|name|bundled_skill_id)"\s*:\s*"([^"]+)"/g))
    if (name !== undefined) out.add(name);
  return [...out];
}

/** A name as an installed skill would carry it: a plugin prefix (`ak:`) dropped, lowercased. */
export function skillName(raw: string): string {
  const trimmed = raw.trim().replace(/^\//, "");
  const colon = trimmed.lastIndexOf(":");
  return (colon >= 0 ? trimmed.slice(colon + 1) : trimmed).toLowerCase();
}

const TEXT_PARTS = new Set(["text", "input_text", "output_text"]);

/** Text of one content part: a string, or a text-typed part's text. */
function partText(part: JsonValue): string[] {
  const plain = str(part);
  if (plain !== null) return [plain];
  const item = object(part);
  if (item === null) return [];
  const type = str(item.type);
  if (type !== null && !TEXT_PARTS.has(type)) return [];
  const found = str(item.text);
  return found === null ? [] : [found];
}

/** Text of a message content value: a string, the text parts of a part list, or an object's text or output. */
function textOf(value: JsonValue | undefined): string {
  const plain = str(value);
  if (plain !== null) return plain;
  const item = object(value);
  if (item !== null) return str(item.text) ?? str(item.output) ?? "";
  return items(value).flatMap(partText).join("\n");
}

function argText(value: JsonValue | undefined): string {
  if (value === undefined || value === null) return "";
  return str(value) ?? JSON.stringify(value);
}

const ERROR_WORDS = /\b(?:error|failed|traceback|exception)\b|exit code:? [1-9]|"exit_code":\s*[1-9]/i;
const CODE_EDIT_TOOLS = new Set(["edit", "write", "multiedit", "notebookedit", "apply_patch", "search_replace"]);
const CODE_EDIT_HINT = /\*\*\* (?:Begin|Update File|Add File)|apply_patch/;

/** The per-session accumulator every host parser feeds. */
class SessionLog {
  entries: Entry[] = [];
  stats: SessionStats = {
    user_turns: 0,
    assistant_turns: 0,
    tool_calls: 0,
    repeated_tool_calls: 0,
    error_outputs: 0,
    code_edits: false,
    corrections: 0,
  };
  candidates = new Set<string>();
  private seen = new Map<string, number>();

  user(text: string): void {
    const clean = text.trim();
    if (clean === "" || looksInjected(clean)) return;
    this.stats.user_turns += 1;
    const detection = detectPatterns(clean);
    if (detection.type !== null && detection.sentiment === "correction") this.stats.corrections += 1;
    this.entries.push({ kind: "user", text: truncate(clean, MAX_MSG_CHARS) });
  }

  assistant(text: string): void {
    const clean = text.trim();
    if (clean === "") return;
    this.stats.assistant_turns += 1;
    this.entries.push({ kind: "assistant", text: truncate(clean, MAX_MSG_CHARS) });
  }

  tool(name: string, args: string): void {
    this.stats.tool_calls += 1;
    const key = `${name}\u0000${args}`;
    const count = (this.seen.get(key) ?? 0) + 1;
    this.seen.set(key, count);
    if (count > 1) this.stats.repeated_tool_calls += 1;
    if (CODE_EDIT_TOOLS.has(name.toLowerCase()) || CODE_EDIT_HINT.test(args)) this.stats.code_edits = true;
    for (const candidate of skillCandidates(args)) this.candidates.add(candidate);
    this.entries.push({ kind: `tool:${name}`, text: truncate(args, MAX_TOOL_CHARS) });
  }

  output(text: string, failed: boolean): void {
    if (failed || ERROR_WORDS.test(text.slice(0, 2000))) this.stats.error_outputs += 1;
    this.entries.push({ kind: "output", text: truncate(text, MAX_TOOL_CHARS) });
  }

  note(text: string): void {
    this.entries.push({ kind: "note", text });
  }
}

interface Parsed {
  id: string;
  cwd: string | null;
  started_at: string | null;
  log: SessionLog;
}

const COMMAND_NAME = /<command-name>\s*\/?([^<\s]+)\s*<\/command-name>/;
const COMMAND_ARGS = /<command-args>([\s\S]*?)<\/command-args>/;

/** One Claude Code project-history file. Sidechain rows are subagent work and are left out. */
export function parseClaudeSession(path: string): Parsed | null {
  const log = new SessionLog();
  let id: string | null = null;
  let cwd: string | null = null;
  let started: string | null = null;
  for (const row of readRows(path)) {
    if (row.isSidechain === true) continue;
    id ??= str(row.sessionId);
    cwd ??= str(row.cwd);
    started ??= str(row.timestamp);
    const message = object(row.message);
    const content = message?.content;
    if (row.type === "user") {
      const typed = str(content);
      if (typed !== null) {
        const command = COMMAND_NAME.exec(typed)?.[1];
        if (command !== undefined) {
          log.candidates.add(command);
          log.note(`/${command} ${truncate(COMMAND_ARGS.exec(typed)?.[1] ?? "", MAX_MSG_CHARS)}`.trim());
          log.stats.user_turns += 1;
        } else if (row.isMeta !== true) log.user(typed);
        continue;
      }
      for (const item of objects(content)) {
        if (item.type === "text" && row.isMeta !== true) log.user(str(item.text) ?? "");
        else if (item.type === "tool_result") log.output(textOf(item.content), item.is_error === true);
      }
    } else if (row.type === "assistant") {
      for (const item of objects(content)) {
        if (item.type === "text") log.assistant(str(item.text) ?? "");
        else if (item.type === "tool_use") {
          const name = str(item.name) ?? "tool";
          const skill = name === "Skill" ? str(object(item.input)?.skill) : null;
          if (skill !== null) log.candidates.add(skill);
          log.tool(name, argText(item.input));
        }
      }
    }
  }
  if (id === null) id = basename(path, ".jsonl");
  return { id, cwd, started_at: started, log };
}

const CODEX_SKILL = /^\s*<skill>\s*<name>([^<]+)<\/name>/;

function codexMeta(rows: readonly JsonObject[]): JsonObject | null {
  const first = rows[0];
  return first?.type === "session_meta" ? object(first.payload) : null;
}

function codexSubagent(meta: JsonObject | null): boolean {
  if (meta === null) return false;
  if (str(meta.agent_path) !== null) return true;
  const source = object(meta.source);
  return source !== null && "subagent" in source;
}

/** One Codex rollout. A `<skill>` user block is the host loading a skill, recorded as its use. */
export function parseCodexSession(path: string): Parsed | null {
  const rows = readRows(path);
  const meta = codexMeta(rows);
  if (meta === null || codexSubagent(meta)) return null;
  const log = new SessionLog();
  for (const row of rows) {
    const payload = object(row.payload);
    if (payload === null) continue;
    const type = str(payload.type);
    if (type === "message") {
      const role = str(payload.role);
      const content = payload.content ?? null;
      const listed = items(content);
      const parts = listed.length > 0 ? listed : [content];
      for (const part of parts) {
        const said = partText(part).join("\n");
        if (said.trim() === "") continue;
        if (role === "user") {
          const skill = CODEX_SKILL.exec(said)?.[1]?.trim();
          if (skill !== undefined) {
            log.candidates.add(skill);
            log.note(`[skill loaded: ${skill}]`);
          } else log.user(said);
        } else if (role === "assistant") log.assistant(said);
      }
    } else if (type === "function_call" || type === "custom_tool_call" || type === "local_shell_call") {
      log.tool(str(payload.name) ?? type, argText(payload.arguments ?? payload.input ?? payload.action));
    } else if (type === "function_call_output" || type === "custom_tool_call_output") {
      log.output(textOf(payload.output), false);
    }
  }
  return {
    id: str(meta.id) ?? basename(path, ".jsonl"),
    cwd: str(meta.cwd),
    started_at: str(meta.timestamp) ?? str(rows[0]?.timestamp),
    log,
  };
}

function grokCwd(dir: string, summary: JsonObject | null): string | null {
  const recorded = str(summary?.cwd) ?? str(object(summary?.info)?.cwd);
  if (recorded !== null) return recorded;
  try {
    const decoded = decodeURIComponent(basename(dirname(dir)));
    return decoded.startsWith("/") ? decoded : null;
  } catch {
    return null;
  }
}

/** One Grok session directory (`chat_history.jsonl` beside `summary.json`). */
export function parseGrokSession(dir: string): Parsed | null {
  const history = join(dir, "chat_history.jsonl");
  if (!existsSync(history)) return null;
  const summary = readObject(join(dir, "summary.json"));
  const log = new SessionLog();
  for (const row of readRows(history)) {
    if (row.type === "user" && row.synthetic_reason === undefined) {
      const said = textOf(row.content);
      const slash = /^\s*\/([a-z0-9][a-z0-9:_-]*)/i.exec(said)?.[1];
      if (slash !== undefined) log.candidates.add(slash);
      log.user(said);
    } else if (row.type === "assistant") {
      log.assistant(textOf(row.content));
      for (const tool of objects(row.tool_calls)) {
        const fn = object(tool.function);
        log.tool(str(fn?.name) ?? str(tool.name) ?? "tool", argText(fn?.arguments ?? tool.arguments));
      }
    } else if (row.type === "tool_result") {
      log.output(textOf(row.content), row.is_error === true);
    }
  }
  return {
    id: str(object(summary?.info)?.id) ?? basename(dir),
    cwd: grokCwd(dir, summary),
    started_at: str(summary?.created_at),
    log,
  };
}

/** Whether `cwd` is `root` or inside it. */
function belongsTo(cwd: string, root: string): boolean {
  const top = resolve(root);
  const place = resolve(cwd);
  return place === top || place.startsWith(`${top}${sep}`);
}

interface Located {
  host: DoctorHost;
  path: string;
  modified: number;
  cwd: string | null;
}

function files(dir: string, accept: (name: string) => boolean, depth: number): string[] {
  if (depth < 0 || !existsSync(dir)) return [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return files(path, accept, depth - 1);
    return entry.isFile() && accept(entry.name) ? [path] : [];
  });
}

function mtime(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

/** The working directory the first Claude Code record that names one carries. */
function firstCwd(rows: JsonObject[]): string | null {
  return str(rows.find((row) => str(row.cwd) !== null)?.cwd);
}

/** Every session file in the window, placed by the working directory its first records name, read past the peek when it misses. */
function locate(options: CollectOptions): Located[] {
  const since = options.now - options.days * 86_400_000;
  const out: Located[] = [];
  const keep = (host: DoctorHost, path: string, cwd: (path: string) => string | null, stamp = path) => {
    const modified = mtime(stamp);
    if (modified >= since) out.push({ host, path, modified, cwd: cwd(path) });
  };
  if (options.hosts.includes("claude")) {
    for (const home of options.claudeHomes) {
      for (const path of files(join(home, "projects"), (name) => name.endsWith(".jsonl"), 1)) {
        keep("claude", path, (p) => firstCwd(peekRows(p)) ?? firstCwd(readRows(p)));
      }
    }
  }
  if (options.hosts.includes("codex")) {
    for (const home of options.codexHomes) {
      for (const path of files(join(home, "sessions"), (name) => /^rollout-.*\.jsonl$/.test(name), 4)) {
        keep("codex", path, (p) => str(codexMeta(peekRows(p))?.cwd) ?? str(codexMeta(readRows(p))?.cwd));
      }
    }
  }
  if (options.hosts.includes("grok")) {
    for (const home of options.grokHomes) {
      for (const history of files(join(home, "sessions"), (name) => name === "chat_history.jsonl", 2)) {
        const dir = dirname(history);
        keep("grok", dir, (d) => grokCwd(d, readObject(join(d, "summary.json"))), history);
      }
    }
  }
  return out;
}

interface SkillFront {
  name: string | null;
  description: string | null;
}

/** The `name` and `description` of a SKILL.md frontmatter block, read as YAML; a field that is absent or not text is null. */
export function frontmatter(source: string): SkillFront {
  // The YAML core schema yields only JSON values, so the round trip decodes the block without changing it.
  const data = object(parseJson(JSON.stringify(parseFrontmatter(source).data)));
  const field = (key: string): string | null => str(data?.[key])?.trim() ?? null;
  return { name: field("name"), description: field("description") };
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** The skills directly under `root`. A skill directory or file may be a symlink, as installed skills usually are. */
function skillsIn(root: string, scope: SkillInfo["scope"]): SkillInfo[] {
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }
  return names
    .map((name) => join(root, name, "SKILL.md"))
    .filter(isFile)
    .map((path) => {
      const meta = frontmatter(readFileSync(path, "utf8"));
      return {
        name: skillName(meta.name ?? basename(dirname(path))),
        path,
        scope,
        description: truncate(meta.description ?? "", 300),
      };
    });
}

/** Project skills under each repository, then global skills when asked for. The first skill of a name wins. */
export function discoverSkills(options: CollectOptions, env: NodeJS.ProcessEnv): SkillInfo[] {
  const project = options.repos.flatMap((repo) =>
    ["skills", ".agents/skills", ".claude/skills", ".codex/skills"].map((dir) => join(repo, dir)),
  );
  const home = userHome(env);
  const global = options.includeGlobalSkills
    ? [
        ...options.claudeHomes.map((dir) => join(dir, "skills")),
        join(home, ".agents", "skills"),
        ...options.codexHomes.map((dir) => join(dir, "skills")),
        ...options.grokHomes.map((dir) => join(dir, "skills")),
      ]
    : [];
  const found = new Map<string, SkillInfo>();
  const roots: Array<[string, SkillInfo["scope"]]> = [
    ...project.map((dir): [string, SkillInfo["scope"]] => [dir, "project"]),
    ...options.skillDirs.map((dir): [string, SkillInfo["scope"]] => [resolve(dir), "project"]),
    ...global.map((dir): [string, SkillInfo["scope"]] => [dir, "global"]),
  ];
  for (const [root, scope] of roots) {
    for (const skill of skillsIn(root, scope)) if (!found.has(skill.name)) found.set(skill.name, skill);
  }
  return [...found.values()].toSorted((a, b) => a.name.localeCompare(b.name));
}

/** The default homes for each host: Claude's configuration directory, and the worker homes the learning runtime reads. */
export function defaultHomes(
  env: NodeJS.ProcessEnv,
  configDir: string,
): Pick<CollectOptions, "claudeHomes" | "codexHomes" | "grokHomes"> {
  const homes = workerHomes(env);
  return { claudeHomes: [configDir], codexHomes: homes.codex, grokHomes: homes.grok };
}

function parse(located: Located): Parsed | null {
  if (located.host === "claude") return parseClaudeSession(located.path);
  if (located.host === "codex") return parseCodexSession(located.path);
  return parseGrokSession(located.path);
}

/**
 * Sample newest first: up to `perSkill` sessions for each installed skill, then up to
 * `noSkill` sessions that used none, never more than `maxSessions`. The donor's order.
 */
export function sample(
  sessions: readonly DoctorSession[],
  options: Pick<CollectOptions, "maxSessions" | "perSkill" | "noSkill">,
): DoctorSession[] {
  const ordered = sessions.toSorted((a, b) => b.modified_ms - a.modified_ms);
  const picked = new Set<string>();
  const perSkill = new Map<string, number>();
  for (const session of ordered) {
    if (picked.size >= options.maxSessions) break;
    for (const name of session.skills_used) {
      if ((perSkill.get(name) ?? 0) < options.perSkill) {
        perSkill.set(name, (perSkill.get(name) ?? 0) + 1);
        picked.add(session.key);
        break;
      }
    }
  }
  let noSkill = 0;
  for (const session of ordered) {
    if (picked.size >= options.maxSessions || noSkill >= options.noSkill) break;
    if (session.skills_used.length === 0 && !picked.has(session.key)) {
      picked.add(session.key);
      noSkill += 1;
    }
  }
  return ordered.filter((session) => picked.has(session.key));
}

/** Scan, place, parse and sample. Nothing is written here; `writeCollection` does that behind the secret gate. */
export function collect(options: CollectOptions, env: NodeJS.ProcessEnv): Collection {
  const skills = discoverSkills(options, env);
  const installed = new Set(skills.map((skill) => skill.name));
  const located = locate(options);
  const places = [...options.repos, ...options.worktrees];
  const matched = located.filter((entry) => {
    const { cwd } = entry;
    return options.repos.length === 0 || (cwd !== null && places.some((place) => belongsTo(cwd, place)));
  });
  const sessions: DoctorSession[] = [];
  for (const entry of matched) {
    const parsed = parse(entry);
    if (parsed === null) continue;
    const { log } = parsed;
    if (log.stats.assistant_turns === 0 || log.stats.tool_calls === 0) continue;
    const used = new Set(
      [...log.candidates].flatMap((candidate) => {
        const name = skillName(candidate);
        return installed.has(name) ? [name] : [];
      }),
    );
    sessions.push({
      key: `${entry.host}-${parsed.id}`.replaceAll(/[^A-Za-z0-9._-]/g, "_"),
      host: entry.host,
      id: parsed.id,
      cwd: parsed.cwd ?? entry.cwd,
      started_at: parsed.started_at,
      modified_ms: entry.modified,
      stats: log.stats,
      skills_used: [...used].toSorted(),
      entries: log.entries,
    });
  }
  return {
    generated_at: new Date(options.now).toISOString(),
    hosts: [...options.hosts],
    repos: options.repos.map((repo) => resolve(repo)),
    window_days: options.days,
    sessions_scanned: located.length,
    sessions_matched: sessions.length,
    skills,
    sampled: sample(sessions, options),
  };
}

/** The transcript one judge call reads: a header of counts, then the condensed entries, every line scrubbed. */
export function renderTranscript(session: DoctorSession): string {
  const s = session.stats;
  const lines = [
    `# Session ${session.key}`,
    `- host: ${session.host}`,
    `- cwd: ${session.cwd ?? "(unknown)"}`,
    `- started: ${session.started_at ?? "(unknown)"}`,
    `- skills detected: ${session.skills_used.join(", ") || "(none)"}`,
    `- stats: ${s.user_turns} user turns, ${s.assistant_turns} assistant turns, ${s.tool_calls} tool calls (${s.repeated_tool_calls} repeated), ${s.error_outputs} error-ish outputs, code edits: ${s.code_edits}`,
    `- user corrections (claude-reflect detector): ${s.corrections}`,
    "",
    "## Condensed transcript",
    "",
  ];
  let shown = session.entries;
  if (shown.length > MAX_TRANSCRIPT_ENTRIES) {
    const omitted = shown.length - TRANSCRIPT_HEAD - TRANSCRIPT_TAIL;
    shown = [
      ...shown.slice(0, TRANSCRIPT_HEAD),
      { kind: "note", text: `[… ${omitted} entries omitted …]` },
      ...shown.slice(-TRANSCRIPT_TAIL),
    ];
  }
  for (const entry of shown) lines.push(`[${entry.kind}] ${entry.text}`, "");
  return scrubCaptured(lines.join("\n"));
}
