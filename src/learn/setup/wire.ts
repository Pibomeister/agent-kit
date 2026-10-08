/**
 * `ak learn setup wire` — merge this runtime's hook entries into the host
 * configuration, and point claude-mem at the review-learning mode.
 *
 * Every write is an idempotent merge: an entry of ours is recognised by the
 * `learn hook` marker in its command, updated in place when the command line
 * changed, and never duplicated. Foreign entries are left exactly as found,
 * and every file is copied to `<file>.bak` before it is rewritten.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import Ajv from "ajv";
import type { LearnContext } from "../core/context.ts";
import { run, type RunResult } from "../core/proc.ts";
import { AK_ENTRY, PACKAGE_ROOT } from "../core/roles.ts";
import { writeJson } from "../core/store.ts";
import { assignsHooksKey, hookBlock, tomlHooks, withHookBlock } from "./toml-hooks.ts";
import { unitScopeDiffers } from "./scope.ts";
import embeddedMemMode from "../../../adapters/observation-source/claude-mem/code--review-learning.json" with { type: "json" };

/** Everything setup touches outside the config dir, injectable so tests never reach the real machine. */
export interface SetupDeps {
  home: string;
  platform: NodeJS.Platform;
  uid: number;
  run: (cmd: readonly string[], options?: { env?: NodeJS.ProcessEnv }) => RunResult;
  which: (bin: string) => string | null;
  /** The argv prefix that runs `ak`: bun, then the running entry (`src/cli.ts`, or the bundle's `bin/ak`). */
  ak: string[];
  packageRoot: string;
}

export function defaultDeps(ctx: LearnContext): SetupDeps {
  const which = (bin: string) => Bun.which(bin, { PATH: ctx.env.PATH ?? "" });
  return {
    home: ctx.env.HOME && ctx.env.HOME !== "" ? ctx.env.HOME : homedir(),
    platform: process.platform,
    uid: process.getuid?.() ?? 0,
    run: (cmd, options) => run(cmd, { timeoutMs: 60_000, env: options?.env ?? ctx.env }),
    which,
    ak: [which("bun") ?? "bun", AK_ENTRY],
    packageRoot: PACKAGE_ROOT,
  };
}

/** Single-quote an argument for a POSIX shell when it needs it. */
export function shellQuote(arg: string): string {
  return /^[A-Za-z0-9_@+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, "'\\''")}'`;
}

export interface HookCommands {
  sessionStart: string;
  claudeStop: string;
  codexStop: string;
  codexPrompt: string;
  /** The block, once per session, on a hook whose output the host does hand the model. */
  grokContext: string;
  /** Clears the session's delivery mark, so a resumed or compacted session gets the block again. */
  grokArm: string;
  kimiContext: string;
  kimiArm: string;
}

export function hookCommands(deps: SetupDeps): HookCommands {
  const base = `${deps.ak.map(shellQuote).join(" ")} learn hook`;
  return {
    sessionStart: `${base} session-start`,
    claudeStop: `${base} stop`,
    codexStop: `${base} stop --source codex`,
    codexPrompt: `${base} prompt`,
    grokContext: `${base} session-start --host grok`,
    grokArm: `${base} session-start --host grok --arm`,
    kimiContext: `${base} session-start --host kimi`,
    kimiArm: `${base} session-start --host kimi --arm`,
  };
}

const OUR_HOOK = /(?:^|[\s/"'])(?:ak|cli\.ts)['"]?\s+learn\s+hook\s+(.*)$/;

/** The `learn hook` arguments of a command of ours (`stop --source codex`), or null for a foreign command. */
export function ourHookVerb(command: unknown): string | null {
  if (typeof command !== "string") return null;
  const match = OUR_HOOK.exec(command.trim());
  return match === null ? null : match[1]!.trim().replace(/\s+/g, " ");
}

interface HookEntry {
  matcher?: string;
  hooks?: Array<{ type?: string; command?: unknown; timeout?: number; [key: string]: unknown }>;
  [key: string]: unknown;
}

export interface HookDoc {
  hooks?: Record<string, HookEntry[]>;
  [key: string]: unknown;
}

/** Any JSON value: what a host keeps in its file beside the hooks, carried through untouched. */
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

/** A hook file as it is written back: the entries the merge edited among everything else that was there. */
export type HookFileContents = { [key: string]: Json | HookEntry[] | HookFileContents };

const ajv = new Ajv({ strict: false });
const isJsonObject = ajv.compile<JsonObject>({ type: "object" });
/** A non-empty list of hook entries, which is what an event holds. */
const isEventList = ajv.compile<HookEntry[]>({
  type: "array",
  minItems: 1,
  items: {
    type: "object",
    properties: { matcher: { type: "string" }, hooks: { type: "array", items: { type: "object" } } },
  },
});
const declaresSessionStart = ajv.compile<{ hooks: { SessionStart: Json } }>({
  type: "object",
  required: ["hooks"],
  properties: { hooks: { type: "object", required: ["SessionStart"] } },
});

/**
 * Add one hook entry unless it is already there. An entry of ours for the same
 * verb whose command line differs (the package moved) is updated in place.
 * Returns true when the document changed.
 */
export function ensureHook(
  doc: HookDoc,
  event: string,
  command: string,
  options: { matcher?: string; timeout?: number } = {},
): boolean {
  const timeout = options.timeout ?? 10;
  doc.hooks ??= {};
  const entries = (doc.hooks[event] ??= []);
  const hooks = entries.flatMap((entry) => entry.hooks ?? []);
  if (hooks.some((hook) => hook.command === command)) return false;
  const verb = ourHookVerb(command);
  const ours = hooks.filter((hook) => verb !== null && ourHookVerb(hook.command) === verb);
  const stale = ours[0];
  if (stale !== undefined) {
    stale.command = command;
    stale.timeout = timeout;
    return true;
  }
  const entry: HookEntry = { hooks: [{ type: "command", command, timeout }] };
  if (options.matcher !== undefined) entry.matcher = options.matcher;
  entries.push(entry);
  return true;
}

/** Remove every hook of ours. An entry left with no hooks goes, and so does an event left with no entries. Returns entries touched. */
export function dropHooks(doc: HookDoc): number {
  let touched = 0;
  const emptied = new Set<string>();
  for (const [event, entries] of Object.entries(doc.hooks ?? {})) {
    const keep: HookEntry[] = [];
    for (const entry of entries) {
      const hooks = entry.hooks ?? [];
      const foreign = hooks.filter((hook) => ourHookVerb(hook.command) === null);
      if (foreign.length === 0 && hooks.length > 0) {
        touched += 1;
        continue;
      }
      // An entry holding none of ours is kept as it is, down to a missing `hooks` key.
      if (foreign.length !== hooks.length) {
        touched += 1;
        entry.hooks = foreign;
      }
      keep.push(entry);
    }
    if (keep.length === 0) emptied.add(event);
    else doc.hooks![event] = keep;
  }
  if (emptied.size > 0) {
    doc.hooks = Object.fromEntries(Object.entries(doc.hooks ?? {}).filter(([event]) => !emptied.has(event)));
  }
  return touched;
}

/** The command lines of every hook of ours, under one event or under all of them. */
export function ourHookCommands(doc: HookDoc, event?: string): string[] {
  const entries = event === undefined ? Object.values(doc.hooks ?? {}).flat() : (doc.hooks?.[event] ?? []);
  return entries
    .flatMap((entry) => entry.hooks ?? [])
    .map((hook) => hook.command)
    .filter((command): command is string => ourHookVerb(command) !== null);
}

/** Count hooks of ours for one verb under one event. */
export function countHook(doc: HookDoc, event: string, verb: string): number {
  return ourHookCommands(doc, event).filter((command) => ourHookVerb(command) === verb).length;
}

/**
 * A JSON object file, strictly: `{}` when the file is absent, null when it
 * exists but is not a JSON object. A lenient read would turn a hand-edit typo
 * into an empty document and the next write would erase the user's settings.
 */
export function readJsonObject<T extends object>(path: string, empty: T): T | null {
  if (!existsSync(path)) return empty;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as T) : null;
  } catch {
    return null;
  }
}

export function invalidJsonMessage(path: string): string {
  return `${path} is not valid JSON; fix it or remove it, nothing written`;
}

/**
 * Write JSON, first copying the previous file to `<path>.bak` when no backup
 * exists yet. The first backup is the user's own file; a later write never
 * replaces it with a copy of ours.
 */
export function writeJsonWithBackup(path: string, doc: unknown): void {
  if (existsSync(path) && !existsSync(`${path}.bak`)) copyFileSync(path, `${path}.bak`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`);
}

export function claudeSettingsPath(ctx: LearnContext): string {
  return join(ctx.config.configDir, "settings.json");
}

export function codexHome(ctx: LearnContext, deps: SetupDeps): string {
  const override = ctx.env.CODEX_HOME;
  return override !== undefined && override.trim() !== "" ? override : join(deps.home, ".codex");
}

/** `$FACTORY_HOME_OVERRIDE/.factory`, else `~/.factory`: Droid's override replaces the home directory, not the folder in it. */
export function droidHome(ctx: LearnContext, deps: SetupDeps): string {
  const override = ctx.env.FACTORY_HOME_OVERRIDE;
  return join(override !== undefined && override.trim() !== "" ? override : deps.home, ".factory");
}

export function grokHome(ctx: LearnContext, deps: SetupDeps): string {
  const override = ctx.env.GROK_HOME;
  return override !== undefined && override.trim() !== "" ? override : join(deps.home, ".grok");
}

export function kimiHome(ctx: LearnContext, deps: SetupDeps): string {
  const override = ctx.env.KIMI_CODE_HOME;
  return override !== undefined && override.trim() !== "" ? override : join(deps.home, ".kimi-code");
}

export function memDir(ctx: LearnContext, deps: SetupDeps): string {
  const override = ctx.env.CLAUDE_MEM_DATA_DIR;
  return override !== undefined && override.trim() !== "" ? override : join(deps.home, ".claude-mem");
}

export const MEM_MODE = "code--review-learning";
/** claude-mem's context budget: its default is 50 observations, which crowds out the merged block. */
export const CONTEXT_OBSERVATIONS = "25";
export const SESSION_MATCHER = "startup|resume|clear|compact";

export function modeSource(deps: SetupDeps): string {
  return join(deps.packageRoot, "adapters", "observation-source", "claude-mem", `${MEM_MODE}.json`);
}

/** The newest claude-mem `worker-service.cjs` under a plugin cache. */
export function memWorkerScript(ctx: LearnContext, deps: SetupDeps): string | null {
  const found: string[] = [];
  for (const base of new Set([ctx.config.configDir, join(deps.home, ".claude")])) {
    const cache = join(base, "plugins", "cache");
    for (const market of safeList(cache)) {
      for (const version of safeList(join(cache, market, "claude-mem"))) {
        const script = join(cache, market, "claude-mem", version, "scripts", "worker-service.cjs");
        if (existsSync(script)) found.push(script);
      }
    }
  }
  return found.sort().at(-1) ?? null;
}

function safeList(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

export const WIRE_HOSTS = ["claude", "codex", "droid", "grok", "kimi"] as const;
export type WireHost = (typeof WIRE_HOSTS)[number];

export function isWireHost(value: string): value is WireHost {
  return WIRE_HOSTS.some((host) => host === value);
}

export interface WireOptions {
  /** One host only, created when absent. By default Claude, and every other host whose home exists. */
  host?: WireHost;
  /** Skip claude-mem's settings and mode file. */
  noMem?: boolean;
  /** Restart claude-mem's worker after a settings change. Off unless asked for. */
  restartWorker?: boolean;
}

export interface HookSpec {
  event: string;
  command: string;
  matcher?: string;
  timeout?: number;
}

/**
 * The hooks each host is wired with. Claude, Codex and Droid hand a
 * SessionStart hook's output to the model, so the block rides there. Grok and
 * Kimi discard it: they take the block once per session on the hook whose
 * output they do deliver, and their SessionStart and PostCompact hooks clear
 * the delivery mark (`../memory/delivery.ts`).
 */
export function hostHooks(commands: HookCommands): Record<WireHost, HookSpec[]> {
  return {
    claude: [
      { event: "SessionStart", command: commands.sessionStart, matcher: SESSION_MATCHER },
      { event: "Stop", command: commands.claudeStop, timeout: 120 },
    ],
    codex: [
      { event: "SessionStart", command: commands.sessionStart },
      { event: "UserPromptSubmit", command: commands.codexPrompt },
      { event: "Stop", command: commands.codexStop, timeout: 30 },
    ],
    droid: [{ event: "SessionStart", command: commands.sessionStart }],
    grok: [
      { event: "PostToolUse", command: commands.grokContext },
      { event: "SessionStart", command: commands.grokArm },
      { event: "PostCompact", command: commands.grokArm },
    ],
    kimi: [
      { event: "UserPromptSubmit", command: commands.kimiContext },
      { event: "SessionStart", command: commands.kimiArm },
      { event: "PostCompact", command: commands.kimiArm },
    ],
  };
}

const HOST_LABEL: Record<WireHost, string> = {
  claude: "Claude",
  codex: "Codex",
  droid: "Droid",
  grok: "Grok",
  kimi: "Kimi",
};

export function hostHome(ctx: LearnContext, deps: SetupDeps, host: WireHost): string {
  if (host === "claude") return ctx.config.configDir;
  if (host === "codex") return codexHome(ctx, deps);
  if (host === "droid") return droidHome(ctx, deps);
  return host === "grok" ? grokHome(ctx, deps) : kimiHome(ctx, deps);
}

/** A JSON file hooks are merged into. */
export interface HookFile {
  path: string;
  /** Keyed by event name directly, with no `hooks` wrapper: Droid's standalone hook files. */
  bare: boolean;
  /** Created by this runtime for itself alone, so `uninstall` removes it once its last hook is gone. */
  owned?: boolean;
}

/** Grok reads every `*.json` under `hooks/`, so this runtime's entries get a file of their own. */
export const GROK_HOOKS_FILE = "agent-kit-learn.json";

export function kimiConfigPath(ctx: LearnContext, deps: SetupDeps): string {
  return join(kimiHome(ctx, deps), "config.toml");
}

/** Droid's standalone hook file: `hooks.json`, or the legacy `hooks/hooks.json` it still loads while the first is absent. */
export function droidStandalonePaths(ctx: LearnContext, deps: SetupDeps): string[] {
  const home = droidHome(ctx, deps);
  return [join(home, "hooks.json"), join(home, "hooks", "hooks.json")];
}

/**
 * The file Droid reads its SessionStart hooks from. An event declared in a
 * standalone hook file replaces the same event under the `hooks` key of
 * `settings.json`, so the entry goes wherever SessionStart is declared
 * already, and a new standalone file is written only when no other hook
 * source exists for it to shadow. A file that is not plain JSON may declare
 * hooks this cannot see: it is returned as the target, and `wire` refuses it.
 */
export function droidHookFile(ctx: LearnContext, deps: SetupDeps): HookFile {
  const settings: HookFile = { path: join(droidHome(ctx, deps), "settings.json"), bare: false };
  const standalone: HookFile = {
    path: droidStandalonePaths(ctx, deps).find((path) => existsSync(path)) ?? join(droidHome(ctx, deps), "hooks.json"),
    bare: true,
  };
  const inStandalone = readJsonObject<JsonObject>(standalone.path, {});
  const inSettings = readJsonObject<JsonObject>(settings.path, {});
  if (inStandalone === null || inStandalone.SessionStart !== undefined) return standalone;
  if (inSettings === null || declaresSessionStart(inSettings)) return settings;
  return existsSync(standalone.path) || inSettings.hooks === undefined ? standalone : settings;
}

export function hookFile(ctx: LearnContext, deps: SetupDeps, host: Exclude<WireHost, "kimi">): HookFile {
  if (host === "claude") return { path: claudeSettingsPath(ctx), bare: false };
  if (host === "codex") return { path: join(codexHome(ctx, deps), "hooks.json"), bare: false };
  if (host === "grok") return { path: join(grokHome(ctx, deps), "hooks", GROK_HOOKS_FILE), bare: false, owned: true };
  return droidHookFile(ctx, deps);
}

/** A hook file opened for editing: `doc` holds its events only, and `contents` is the whole file again with the edits in place. */
export interface OpenHookFile {
  doc: HookDoc;
  /** Keys holding something other than a list of hook entries or an empty list: an event written there would replace it. */
  unreadable: string[];
  contents: () => HookFileContents;
}

/**
 * A hook file as a `HookDoc`, or the reason it cannot be edited. Only the
 * keys that hold a list of hook entries are handed to the merge. A host keeps
 * other things beside its events (Droid records its imports there), and every
 * such key is put back as it was found, in its place.
 */
export function openHookFile(file: HookFile): OpenHookFile | { refuse: string } {
  const raw = readJsonObject<JsonObject>(file.path, {});
  if (raw === null) return { refuse: invalidJsonMessage(file.path) };
  const found = file.bare ? raw : (raw.hooks ?? {});
  if (!isJsonObject(found)) return { refuse: `${file.path}: "hooks" is not an object; nothing written` };
  const events: Record<string, HookEntry[]> = {};
  const unreadable: string[] = [];
  for (const [key, value] of Object.entries(found)) {
    if (isEventList(value)) events[key] = value;
    else if (!Array.isArray(value) || value.length > 0) unreadable.push(key);
  }
  const original = new Set(Object.keys(events));
  const doc: HookDoc = { hooks: events };
  const merged = () => {
    const now = doc.hooks ?? {};
    const out: HookFileContents = {};
    for (const [key, value] of Object.entries(found)) {
      const event = now[key];
      if (event !== undefined) out[key] = event;
      else if (!original.has(key)) out[key] = value;
    }
    return { ...out, ...now };
  };
  return { doc, unreadable, contents: () => (file.bare ? merged() : { ...raw, hooks: merged() }) };
}

/** One part of a wire: the reason it cannot be done, or the write to make. */
type Plan = { refuse: string } | { apply: () => void };

function hookFilePlan(ctx: LearnContext, file: HookFile, specs: readonly HookSpec[]): Plan {
  const opened = openHookFile(file);
  if ("refuse" in opened) return opened;
  const blocked = specs.find((spec) => opened.unreadable.includes(spec.event));
  if (blocked !== undefined) {
    return { refuse: `${file.path}: "${blocked.event}" is not a list of hook entries; nothing written` };
  }
  return {
    apply: () => {
      let changed = 0;
      for (const spec of specs) {
        if (ensureHook(opened.doc, spec.event, spec.command, spec)) changed += 1;
      }
      if (changed > 0) writeJsonWithBackup(file.path, opened.contents());
      ctx.io.out(
        changed > 0 ? `${file.path}: ${changed} hook entries added or updated` : `${file.path}: already wired`,
      );
    },
  };
}

/** Hooks of ours among a TOML file's `[[hooks]]` tables, for one event and verb. */
export function countTomlHook(text: string, event: string, verb: string): number {
  return (tomlHooks(text) ?? []).filter((hook) => hook.event === event && ourHookVerb(hook.command) === verb).length;
}

/** How many hooks of ours a host's configuration carries for one spec. One is wired; none, or a file that cannot be read, is not. */
export function wiredCount(ctx: LearnContext, deps: SetupDeps, host: WireHost, spec: HookSpec): number {
  const verb = ourHookVerb(spec.command) ?? "";
  if (host === "kimi") {
    const path = kimiConfigPath(ctx, deps);
    return existsSync(path) ? countTomlHook(readFileSync(path, "utf8"), spec.event, verb) : 0;
  }
  const opened = openHookFile(hookFile(ctx, deps, host));
  return "refuse" in opened ? 0 : countHook(opened.doc, spec.event, verb);
}

/** The command lines of every hook of ours in a host's configuration; none when the file cannot be read. */
export function wiredCommands(ctx: LearnContext, deps: SetupDeps, host: WireHost): string[] {
  if (host === "kimi") {
    const path = kimiConfigPath(ctx, deps);
    const tables = existsSync(path) ? (tomlHooks(readFileSync(path, "utf8")) ?? []) : [];
    return tables.flatMap((hook) =>
      hook.command !== undefined && ourHookVerb(hook.command) !== null ? [hook.command] : [],
    );
  }
  const opened = openHookFile(hookFile(ctx, deps, host));
  return "refuse" in opened ? [] : ourHookCommands(opened.doc);
}

/** Write text, first copying the previous file to `<path>.bak` when no backup exists yet, as `writeJsonWithBackup` does. */
export function writeTextWithBackup(path: string, text: string): void {
  if (existsSync(path) && !existsSync(`${path}.bak`)) copyFileSync(path, `${path}.bak`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

/** Kimi's hooks are `[[hooks]]` tables in `config.toml`: this runtime's sit in one marked block, and the rest of the file is never rewritten. */
function kimiPlan(ctx: LearnContext, path: string, specs: readonly HookSpec[]): Plan {
  const before = existsSync(path) ? readFileSync(path, "utf8") : "";
  if (tomlHooks(before) === null) {
    return {
      refuse: `${path} cannot be read as TOML by this runtime, whose parser also rejects some valid files, date and time values among them; fix the file or quote that value, nothing written`,
    };
  }
  const block = hookBlock(
    specs.map((spec) => ({ event: spec.event, command: spec.command, timeout: spec.timeout ?? 10 })),
  );
  const after = withHookBlock(before, block);
  const carried =
    after !== null && specs.every((spec) => countTomlHook(after, spec.event, ourHookVerb(spec.command) ?? "") >= 1);
  if (assignsHooksKey(before)) {
    return {
      refuse: `${path} assigns \`hooks\` as a key, which no [[hooks]] table can follow; declare its hooks as [[hooks]] tables, nothing written`,
    };
  }
  if (after === null || !carried) {
    return {
      refuse: `${path} cannot take the agent-kit [[hooks]] block between its two marker lines as they stand; restore the pair or remove both lines, nothing written`,
    };
  }
  return {
    apply: () => {
      if (after !== before) writeTextWithBackup(path, after);
      ctx.io.out(after === before ? `${path}: already wired` : `${path}: hook block written`);
    },
  };
}

function hostPlan(ctx: LearnContext, deps: SetupDeps, host: WireHost): Plan {
  const specs = hostHooks(hookCommands(deps))[host];
  return host === "kimi"
    ? kimiPlan(ctx, kimiConfigPath(ctx, deps), specs)
    : hookFilePlan(ctx, hookFile(ctx, deps, host), specs);
}

/** Why `wire` leaves a host's configuration alone as it stands, or null when it can be wired. */
export function wireRefusal(ctx: LearnContext, deps: SetupDeps, host: WireHost): string | null {
  const plan = hostPlan(ctx, deps, host);
  return "refuse" in plan ? plan.refuse : null;
}

/** Install the mode file and set the observation budget. Returns true when claude-mem's settings changed. */
export function wireMem(ctx: LearnContext, deps: SetupDeps): boolean {
  const dir = memDir(ctx, deps);
  const source = modeSource(deps);
  const target = join(dir, "modes", `${MEM_MODE}.json`);
  const text = existsSync(source) ? readFileSync(source, "utf8") : `${JSON.stringify(embeddedMemMode, null, 2)}\n`;
  if (!existsSync(target) || JSON.stringify(readJsonObject(target, {})) !== JSON.stringify(JSON.parse(text))) {
    if (existsSync(target) && !existsSync(`${target}.bak`)) copyFileSync(target, `${target}.bak`);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text);
    ctx.io.out(`${target}: mode installed`);
  }
  const settingsPath = join(dir, "settings.json");
  const doc = readJsonObject<Record<string, unknown>>(settingsPath, {}) ?? {};
  const before = JSON.stringify(doc);
  const previous = memPreviousPath(ctx);
  if (!existsSync(previous)) {
    writeJson(previous, {
      CLAUDE_MEM_CONTEXT_OBSERVATIONS: doc.CLAUDE_MEM_CONTEXT_OBSERVATIONS ?? null,
      CLAUDE_MEM_MODE: doc.CLAUDE_MEM_MODE ?? null,
    });
  }
  doc.CLAUDE_MEM_CONTEXT_OBSERVATIONS = CONTEXT_OBSERVATIONS;
  if (doc.CLAUDE_MEM_MODE === undefined) doc.CLAUDE_MEM_MODE = MEM_MODE;
  if (JSON.stringify(doc) === before) {
    ctx.io.out(`${settingsPath}: already set`);
    return false;
  }
  writeJsonWithBackup(settingsPath, doc);
  ctx.io.out(
    `${settingsPath}: CLAUDE_MEM_CONTEXT_OBSERVATIONS=${CONTEXT_OBSERVATIONS}, mode=${String(doc.CLAUDE_MEM_MODE ?? "unchanged")}`,
  );
  return true;
}

/** claude-mem's settings as they were before the first wire, so uninstall restores them rather than deleting them. */
export function memPreviousPath(ctx: LearnContext): string {
  return join(ctx.config.runtimeDir, "claude-mem-previous.json");
}

export function restartWorker(ctx: LearnContext, deps: SetupDeps): void {
  const script = memWorkerScript(ctx, deps);
  const runner = deps.which("bun") ?? deps.which("node");
  if (script === null || runner === null) {
    ctx.io.out("restart the claude-mem worker by hand so the new settings take effect");
    return;
  }
  const result = deps.run([runner, script, "restart"]);
  const last = result.stdout.trim().split("\n").at(-1) ?? "";
  ctx.io.out(
    `claude-mem worker: ${result.code === 0 && last !== "" ? last : `restart failed; run it by hand: ${runner} ${script} restart`}`,
  );
}

function memPlan(ctx: LearnContext, deps: SetupDeps, options: WireOptions): Plan {
  const settings = join(memDir(ctx, deps), "settings.json");
  if (readJsonObject(settings, {}) === null) return { refuse: invalidJsonMessage(settings) };
  return {
    apply: () => {
      if (ctx.config.repos !== null)
        ctx.io.out(
          "note: the repo scope covers agent-kit's hooks and tick only; claude-mem still observes every session",
        );
      const changed = wireMem(ctx, deps);
      if (changed && options.restartWorker === true) restartWorker(ctx, deps);
      else if (changed)
        ctx.io.out("restart the claude-mem worker for the new settings to apply (or rerun with --restart-worker)");
    },
  };
}

export function wire(ctx: LearnContext, deps: SetupDeps, options: WireOptions = {}): number {
  if (unitScopeDiffers(ctx)) {
    ctx.io.err(
      "ak learn setup wire: AK_LEARN_REPOS is not carried into the hook commands, and the scope file differs, " +
        "so the hooks would run with another scope; run `ak learn setup scope --set` with the same roots first",
    );
    return 1;
  }
  const plans: Array<[WireHost, Plan]> = [];
  for (const host of WIRE_HOSTS) {
    if (options.host !== undefined && options.host !== host) continue;
    const home = hostHome(ctx, deps, host);
    if (host !== "claude" && options.host !== host && !existsSync(home)) {
      const skipped = `${home} not present; skipping ${HOST_LABEL[host]} hooks (pass --host ${host} to create it)`;
      plans.push([host, { apply: () => ctx.io.out(skipped) }]);
      continue;
    }
    plans.push([host, hostPlan(ctx, deps, host)]);
  }
  if (options.noMem !== true && (options.host === undefined || options.host === "claude")) {
    plans.push(["claude", memPlan(ctx, deps, options)]);
  }
  // Every file is checked before any is written. A host with a refused file is skipped whole, and the others are wired.
  const refused = new Set(plans.flatMap(([host, plan]) => ("refuse" in plan ? [host] : [])));
  for (const [host, plan] of plans) {
    if ("refuse" in plan) ctx.io.err(plan.refuse);
    else if (!refused.has(host)) plan.apply();
  }
  return refused.size > 0 ? 1 : 0;
}
