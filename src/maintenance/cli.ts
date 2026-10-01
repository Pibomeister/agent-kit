#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import Ajv, { type ValidateFunction } from "ajv";
import Ajv2020 from "ajv/dist/2020.js";
import { parseDocument } from "yaml";

import commonSchema from "../../schemas/common.schema.json" with { type: "json" };
import trackerSchema from "../../schemas/tracker-binding.schema.json" with { type: "json" };

type Level = "PASS" | "WARN" | "FAIL";
export interface Finding {
  level: Level;
  check: string;
  detail: string;
  remedy: string;
}

interface HostPlugin {
  id?: string;
  pluginId?: string;
  version?: string;
  enabled?: boolean;
  scope?: string;
  projectPath?: string;
}
interface PublishedManifest {
  name: string;
  version: string;
}
interface ProjectSettings {
  enabledPlugins?: Record<string, boolean>;
}
interface TrackerBinding {
  backend: string;
  token_file: string;
  defaults: Record<string, string>;
}
interface BindingCheck {
  finding: Finding;
  token: string | null;
  backend: string | null;
}

const ajv = new Ajv();
const pluginSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    pluginId: { type: "string" },
    version: { type: "string" },
    enabled: { type: "boolean" },
    scope: { type: "string" },
    projectPath: { type: "string" },
  },
  additionalProperties: true,
};
const validPluginList = ajv.compile<HostPlugin[]>({ type: "array", items: pluginSchema });
const validCodexList = ajv.compile<{ installed: HostPlugin[] }>({
  type: "object",
  required: ["installed"],
  properties: { installed: { type: "array", items: pluginSchema } },
  additionalProperties: true,
});
const validManifest = ajv.compile<PublishedManifest>({
  type: "object",
  required: ["name", "version"],
  properties: { name: { type: "string" }, version: { type: "string" } },
  additionalProperties: true,
});
const validSettings = ajv.compile<ProjectSettings>({
  type: "object",
  properties: { enabledPlugins: { type: "object", additionalProperties: { type: "boolean" } } },
  additionalProperties: true,
});
const bindingAjv = new Ajv2020({ strict: false });
bindingAjv.addSchema(commonSchema);
const validBinding = bindingAjv.compile<TrackerBinding>(trackerSchema);

const ID = "ak@agent-kit";
const ROOT = process.env.AK_PUBLISHED_ROOT ?? "https://raw.githubusercontent.com/Pibomeister/agent-kit/published";

function finding(level: Level, check: string, detail: string, remedy: string): Finding {
  return { level, check, detail, remedy };
}

function command(binary: string, args: string[], cwd = process.cwd()) {
  const run = spawnSync(binary, args, { cwd, encoding: "utf8", env: process.env });
  return { ok: run.status === 0, output: (run.stdout || run.stderr || run.error?.message || "").trim() };
}

function parseJson<T>(source: string, validate: ValidateFunction<T>): T | null {
  try {
    const value: unknown = JSON.parse(source);
    return validate(value) ? value : null;
  } catch {
    return null;
  }
}

function jsonCommand(binary: string, args: string[]) {
  const run = command(binary, args);
  return run.ok ? run.output : null;
}

function projectRoot(): string {
  const top = command("git", ["rev-parse", "--show-toplevel"]);
  return realpathSync(top.ok ? top.output : process.cwd());
}

export function inProject(row: HostPlugin, root: string): boolean {
  if (row.projectPath === undefined) return true;
  try {
    return realpathSync(row.projectPath) === root;
  } catch {
    return false;
  }
}

function claudeRecords(root: string): HostPlugin[] {
  const output = jsonCommand("claude", ["plugin", "list", "--json"]);
  const rows = output ? (parseJson(output, validPluginList) ?? []) : [];
  return rows.filter((row) => inProject(row, root));
}

function codexRecords(): HostPlugin[] {
  const output = jsonCommand("codex", ["plugin", "list", "--json"]);
  return output ? (parseJson(output, validCodexList)?.installed ?? []) : [];
}

export function checkPlugin(host: string, installed: HostPlugin[], latest: string | null): Finding {
  const matches = installed.filter((row) => row.id === ID || row.pluginId === ID);
  if (matches.length === 0)
    return finding("WARN", `${host} plugin`, "ak is not installed", `Install ${ID} in ${host}.`);
  if (matches.some((row) => row.enabled !== true))
    return finding("FAIL", `${host} plugin`, "ak is disabled", `Enable ${ID} in ${host}.`);
  const versions = [...new Set(matches.map((row) => row.version ?? "unknown"))];
  if (latest && versions.some((version) => version !== latest)) {
    return finding("WARN", `${host} plugin`, `installed ${versions.join(", ")}; published ${latest}`, "Run ak update.");
  }
  return finding(
    "PASS",
    `${host} plugin`,
    `enabled; installed ${versions.join(", ")}${latest ? `; published ${latest}` : ""}`,
    "No action needed.",
  );
}

export function checkSource(host: string, published: PublishedManifest | null): Finding {
  if (!published || published.name !== "ak") {
    return finding(
      "FAIL",
      `${host} marketplace source`,
      "published bundle manifest does not resolve",
      "Publish the validated bundle branch, then retry.",
    );
  }
  return finding("PASS", `${host} marketplace source`, `resolves to ak ${published.version}`, "No action needed.");
}

export function checkProjectEnablement(project: string): Finding {
  const top = command("git", ["rev-parse", "--show-toplevel"], project);
  const file = join(top.ok ? top.output : project, ".claude", "settings.json");
  let settings: ProjectSettings | null;
  try {
    settings = parseJson(readFileSync(file, "utf8"), validSettings);
  } catch {
    return finding(
      "WARN",
      "project enablement",
      "no readable .claude/settings.json",
      `Set enabledPlugins["${ID}"] to true in ${file}.`,
    );
  }
  if (settings?.enabledPlugins?.[ID] !== true) {
    return finding(
      "WARN",
      "project enablement",
      `${ID} is not enabled for this repo`,
      `Set enabledPlugins["${ID}"] to true in ${file}.`,
    );
  }
  return finding("PASS", "project enablement", `${ID} is enabled in this repo`, "No action needed.");
}

export function findBindingRoot(start: string): string | null {
  const topResult = command("git", ["rev-parse", "--show-toplevel"], start);
  const top = topResult.ok ? realpathSync(topResult.output) : realpathSync(start);
  for (let dir = realpathSync(start); ; dir = dirname(dir)) {
    if (existsSync(join(dir, "ak.tracker.yaml"))) return dir;
    if (dir === top || dirname(dir) === dir || relative(top, dir).startsWith("..")) return null;
  }
}

export function parseBinding(root: string | null): BindingCheck {
  if (!root)
    return {
      finding: finding(
        "WARN",
        "tracker binding",
        "no ak.tracker.yaml",
        "Add a project tracker binding if this repo uses an external tracker.",
      ),
      token: null,
      backend: null,
    };
  const file = join(root, "ak.tracker.yaml");
  try {
    const parsed = parseDocument(readFileSync(file, "utf8"), { uniqueKeys: true });
    if (parsed.errors.length > 0) throw parsed.errors[0];
    const data: unknown = parsed.toJS();
    if (!validBinding(data)) throw new Error("binding does not match tracker-binding.schema.json");
    return {
      finding: finding("PASS", "tracker binding", `${data.backend} parses`, "No action needed."),
      token: data.token_file,
      backend: data.backend,
    };
  } catch (cause) {
    return {
      finding: finding(
        "FAIL",
        "tracker binding",
        cause instanceof Error ? (cause.message.split("\n")[0] ?? "invalid YAML") : "invalid YAML",
        `Repair ${file}, then run ak tracker check.`,
      ),
      token: null,
      backend: null,
    };
  }
}

export function checkToken(root: string | null, token: string | null): Finding {
  if (!root || !token)
    return finding("WARN", "tracker token", "no binding token_file to check", "Add a valid tracker binding first.");
  const file = resolve(root, token);
  if (isAbsolute(token) || relative(root, file).startsWith("..") || !existsSync(file)) {
    return finding(
      "FAIL",
      "tracker token",
      "token file is absent or outside the project",
      "Create the token file inside the project.",
    );
  }
  if (relative(realpathSync(root), realpathSync(file)).startsWith("..")) {
    return finding(
      "FAIL",
      "tracker token",
      "token file resolves outside the project",
      "Keep the token file inside the project.",
    );
  }
  const mode = statSync(file).mode & 0o777;
  if (mode !== 0o600)
    return finding("FAIL", "tracker token", `mode ${mode.toString(8)}, expected 600`, `Run chmod 600 ${file}.`);
  const ignored = command("git", ["check-ignore", "-q", "--no-index", "--", file], root).ok;
  const tracked = command("git", ["ls-files", "--error-unmatch", "--", file], root).ok;
  if (!ignored || tracked)
    return finding(
      "FAIL",
      "tracker token",
      tracked ? "token is tracked by git" : "token is not gitignored",
      `Ignore ${token} in the project's .gitignore and remove it from git history if tracked.`,
    );
  return finding("PASS", "tracker token", "exists, mode 600, gitignored and untracked", "No action needed.");
}

export function checkLinearis(root: string | null, backend: string | null): Finding {
  if (!root || backend !== "linear-linearis")
    return finding(
      "WARN",
      "linearis",
      "no linear-linearis binding to check",
      "Add the binding if this repo uses Linear.",
    );
  const topResult = command("git", ["rev-parse", "--show-toplevel"], root);
  const top = topResult.ok ? topResult.output : root;
  for (const base of new Set([root, top])) {
    const binary = join(base, "node_modules", ".bin", "linearis");
    if (!existsSync(binary)) continue;
    const target = realpathSync(binary);
    if (relative(join(base, "node_modules"), target).startsWith("..")) continue;
    const version = command(binary, ["--version"], root);
    if (version.ok && version.output === "2026.8.0")
      return finding("PASS", "linearis", `${binary} is project-local at 2026.8.0`, "No action needed.");
    return finding(
      "FAIL",
      "linearis",
      `project-local binary reports ${version.output || "an error"}`,
      "Install linearis@2026.8.0 as an exact project dev dependency.",
    );
  }
  return finding(
    "FAIL",
    "linearis",
    "no project-local executable; a global PATH command does not count",
    "Install linearis@2026.8.0 as an exact project dev dependency.",
  );
}

async function manifest(host: "claude-code" | "codex"): Promise<PublishedManifest | null> {
  const suffix = `dist/${host}/.${host === "codex" ? "codex" : "claude"}-plugin/plugin.json`;
  try {
    if (isAbsolute(ROOT)) return parseJson(readFileSync(join(ROOT, suffix), "utf8"), validManifest);
    else {
      const response = await fetch(`${ROOT}/${suffix}`);
      if (!response.ok) return null;
      return parseJson(await response.text(), validManifest);
    }
  } catch {
    return null;
  }
}

function print(items: Finding[]): number {
  for (const item of items) console.log(`${item.level} ${item.check}: ${item.detail}. Remedy: ${item.remedy}`);
  return items.some((item) => item.level === "FAIL") ? 1 : 0;
}

async function doctor(): Promise<number> {
  const [claudeSource, codexSource] = await Promise.all([manifest("claude-code"), manifest("codex")]);
  const claude = claudeRecords(projectRoot());
  const codex = codexRecords();
  const root = findBindingRoot(process.cwd());
  const binding = parseBinding(root);
  const items = [
    checkSource("Claude Code", claudeSource),
    checkSource("Codex", codexSource),
    checkPlugin("Claude Code", claude, claudeSource?.version ?? null),
    checkPlugin("Codex", codex, codexSource?.version ?? null),
    checkProjectEnablement(process.cwd()),
    binding.finding,
    checkToken(root, binding.token),
    checkLinearis(root, binding.backend),
  ];
  if (!claude.some((row) => row.id === ID) && !codex.some((row) => row.pluginId === ID)) {
    items.push(
      finding(
        "FAIL",
        "installation",
        "ak is absent from both hosts",
        "Install ak from the published marketplace in Claude Code or Codex.",
      ),
    );
  }
  return print(items);
}

async function update(): Promise<number> {
  const [claudeSource, codexSource] = await Promise.all([manifest("claude-code"), manifest("codex")]);
  if (!claudeSource && !codexSource) return print([checkSource("published", null)]);
  let failures = 0;
  const root = projectRoot();
  const claudeBefore = claudeRecords(root).filter((row) => row.id === ID);
  if (claudeBefore.length > 0) {
    const marketplace = command("claude", ["plugin", "marketplace", "update", "agent-kit"]);
    if (!marketplace.ok) {
      console.error(`FAIL Claude Code update: ${marketplace.output}`);
      failures += 1;
    } else
      for (const scope of new Set(claudeBefore.map((row) => row.scope ?? "user"))) {
        const oldVersion = claudeBefore.find((row) => (row.scope ?? "user") === scope)?.version ?? "unknown";
        const result = command("claude", ["plugin", "update", ID, "--scope", scope, "--json"], root);
        const after = claudeRecords(root).find((row) => row.id === ID && (row.scope ?? "user") === scope);
        const current = after?.version ?? "unknown";
        const okay = result.ok && current === claudeSource?.version;
        console.log(
          `${okay ? "PASS" : "FAIL"} Claude Code ${scope}: ${oldVersion} -> ${current}${okay ? "" : `; ${result.output || "published version not installed"}`}`,
        );
        if (!okay) failures += 1;
      }
  }
  const codexBefore = codexRecords().find((row) => row.pluginId === ID);
  if (codexBefore) {
    const refresh = command("codex", ["plugin", "marketplace", "upgrade", "agent-kit", "--json"]);
    const localMarketplace = refresh.output.includes("not configured as a Git marketplace");
    const result = refresh.ok || localMarketplace ? command("codex", ["plugin", "add", ID, "--json"]) : refresh;
    const after = codexRecords().find((row) => row.pluginId === ID);
    const current = after?.version ?? "unknown";
    const okay = result.ok && current === codexSource?.version;
    console.log(
      `${okay ? "PASS" : "FAIL"} Codex: ${codexBefore.version ?? "unknown"} -> ${current}${okay ? "" : `; ${result.output || "published version not installed"}`}`,
    );
    if (!okay) failures += 1;
  }
  if (claudeBefore.length === 0 && !codexBefore)
    return print([finding("FAIL", "installation", "ak is absent from both hosts", "Install ak before updating.")]);
  return failures ? 1 : 0;
}

if (import.meta.main) {
  const action = process.argv[2];
  process.exitCode =
    action === "doctor"
      ? await doctor()
      : action === "update"
        ? await update()
        : (console.error("Usage: ak doctor|update"), 2);
}
