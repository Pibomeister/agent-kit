#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative } from "node:path";
import Ajv, { type ValidateFunction } from "ajv";
import Ajv2020 from "ajv/dist/2020.js";

import commonSchema from "../../schemas/common.schema.json" with { type: "json" };
import trackerSchema from "../../schemas/tracker-binding.schema.json" with { type: "json" };
import linearisSchema from "../../schemas/tracker-backends/linear-linearis.schema.json" with { type: "json" };
import {
  BINDING_FILE,
  checkTrackerSecret,
  findProjectRoot,
  loadTrackerBinding,
  type BindingValidators,
  type TrackerBinding,
} from "../tracker/binding.ts";

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
  projectEnabled?: boolean;
}
interface ClaudeMarketplace {
  name: string;
  source: string;
  repo?: string;
  url?: string;
}
interface CodexConfig {
  marketplaces?: Record<string, { source?: string; ref?: string }>;
}
interface PublishedManifest {
  name: string;
  version: string;
}
type ManifestFailure = { reason: "network" | "missing" | "invalid" | "http-error"; status?: number };
interface PublishedResult {
  value: PublishedManifest | null;
  failure?: ManifestFailure;
}
interface ProjectSettings {
  enabledPlugins?: Record<string, boolean>;
}
interface BindingCheck {
  finding: Finding;
  binding: TrackerBinding | null;
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
    projectEnabled: { type: "boolean" },
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
const validClaudeMarketplaces = ajv.compile<ClaudeMarketplace[]>({
  type: "array",
  items: {
    type: "object",
    required: ["name", "source"],
    properties: {
      name: { type: "string" },
      source: { type: "string" },
      repo: { type: "string" },
      url: { type: "string" },
    },
    additionalProperties: true,
  },
});
const validCodexConfig = ajv.compile<CodexConfig>({
  type: "object",
  properties: {
    marketplaces: {
      type: "object",
      additionalProperties: {
        type: "object",
        properties: { source: { type: "string" }, ref: { type: "string" } },
        additionalProperties: true,
      },
    },
  },
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
const validLinearis = bindingAjv.compile<TrackerBinding>(linearisSchema);
const bindingValidators: BindingValidators = {
  binding: validBinding,
  backends: new Map([["linear-linearis", validLinearis]]),
};

const ID = "ak@agent-kit";
const ROOT = process.env.AK_PUBLISHED_ROOT ?? "https://raw.githubusercontent.com/Pibomeister/agent-kit/published";
const COMMAND_TIMEOUT_MS = 15_000;
const MUTATION_TIMEOUT_MS = 300_000;
const FETCH_TIMEOUT_MS = 5_000;

function finding(level: Level, check: string, detail: string, remedy: string): Finding {
  return { level, check, detail, remedy };
}

export function command(
  binary: string,
  args: string[],
  cwd = process.cwd(),
  env = process.env,
  timeoutMs = COMMAND_TIMEOUT_MS,
) {
  const safeEnv =
    binary === "git" ? Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith("GIT_"))) : env;
  const run = spawnSync(binary, args, { cwd, encoding: "utf8", env: safeEnv, timeout: timeoutMs });
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

function jsonCommand(binary: string, args: string[], cwd = process.cwd()) {
  const run = command(binary, args, cwd);
  return run.ok ? run.output : null;
}

function projectRoot(): string {
  const top = command("git", ["rev-parse", "--show-toplevel"]);
  return realpathSync(top.ok ? top.output : process.cwd());
}

export function inProject(row: HostPlugin, root: string): boolean {
  if (row.projectEnabled === true) return true;
  if (row.projectPath === undefined) return true;
  try {
    return realpathSync(row.projectPath) === root;
  } catch {
    return false;
  }
}

function claudeRecords(root: string): HostPlugin[] {
  const output = jsonCommand("claude", ["plugin", "list", "--json"], root);
  const rows = output ? (parseJson(output, validPluginList) ?? []) : [];
  return rows.filter((row) => inProject(row, root));
}

export function isClaudeSource(marketplace: ClaudeMarketplace): boolean {
  if (marketplace.name !== "agent-kit") return false;
  if (marketplace.source === "github") return marketplace.repo?.toLowerCase() === "pibomeister/agent-kit";
  return (
    marketplace.source === "git" &&
    /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)pibomeister\/agent-kit(?:\.git)?$/i.test(
      marketplace.url ?? "",
    )
  );
}

function claudeSourceConfigured(root: string): boolean {
  const output = jsonCommand("claude", ["plugin", "marketplace", "list", "--json"], root);
  return output ? (parseJson(output, validClaudeMarketplaces) ?? []).some(isClaudeSource) : false;
}

export function isCodexSource(source: string | undefined, ref: string | undefined): boolean {
  return (
    ref === "published" &&
    (source === "Pibomeister/agent-kit" ||
      source === "https://github.com/Pibomeister/agent-kit.git" ||
      source === "https://github.com/Pibomeister/agent-kit")
  );
}

function codexSourceConfigured(): boolean {
  const file = join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "config.toml");
  try {
    const value: unknown = Bun.TOML.parse(readFileSync(file, "utf8"));
    if (!validCodexConfig(value)) return false;
    const source = value.marketplaces?.["agent-kit"];
    return isCodexSource(source?.source, source?.ref);
  } catch {
    return false;
  }
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

export function checkSource(
  host: string,
  published: PublishedManifest | null,
  configured = true,
  failure?: ManifestFailure,
): Finding {
  if (!published || published.name !== "ak") {
    if (failure?.reason === "network")
      return finding(
        "FAIL",
        `${host} marketplace source`,
        "cannot reach the published bundle manifest",
        "Check network access to the published bundle source and retry.",
      );
    if (failure?.reason === "missing" || failure?.reason === "http-error")
      return finding(
        "FAIL",
        `${host} marketplace source`,
        failure.status
          ? `published bundle manifest returned HTTP ${failure.status}`
          : "published bundle manifest is missing",
        failure.status === 404
          ? "Check that the published branch contains this host's bundle, then retry."
          : "Check the published bundle source and retry.",
      );
    return finding(
      "FAIL",
      `${host} marketplace source`,
      failure?.reason === "invalid"
        ? "published bundle manifest is invalid"
        : "published bundle manifest does not resolve",
      "Publish the validated bundle branch, then retry.",
    );
  }
  if (!configured)
    return finding(
      "FAIL",
      `${host} marketplace source`,
      "configured marketplace is local or points at another source",
      "Re-add agent-kit from Pibomeister/agent-kit (Codex: --ref published).",
    );
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
  const root = findProjectRoot(start);
  return existsSync(join(root, BINDING_FILE)) ? root : null;
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
      binding: null,
    };
  const loaded = loadTrackerBinding(root, "", bindingValidators);
  if (loaded.binding === null) {
    const issue = loaded.issues[0];
    return {
      finding: finding(
        "FAIL",
        "tracker binding",
        issue?.message ?? "invalid binding",
        `Repair ${join(root, BINDING_FILE)}, then run ak tracker check.`,
      ),
      binding: null,
    };
  }
  return {
    finding: finding("PASS", "tracker binding", `${loaded.binding.backend} parses`, "No action needed."),
    binding: loaded.binding,
  };
}

export function checkToken(root: string | null, binding: TrackerBinding | null): Finding {
  if (!root || !binding)
    return finding("WARN", "tracker token", "no binding token_file to check", "Add a valid tracker binding first.");
  try {
    const issues = checkTrackerSecret(root, binding);
    const error = issues.find((issue) => issue.severity === "error");
    if (error)
      return finding("FAIL", "tracker token", error.message, "Repair the token file, then run ak tracker check.");
    const warning = issues.find((issue) => issue.severity === "warning");
    if (warning) return finding("WARN", "tracker token", warning.message, "Run ak tracker check for details.");
    return finding("PASS", "tracker token", "exists, mode 600, gitignored and untracked", "No action needed.");
  } catch (cause) {
    return finding(
      "FAIL",
      "tracker token",
      cause instanceof Error ? cause.message : "token check failed",
      "Run ak tracker check for details.",
    );
  }
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
  const top = topResult.ok ? realpathSync(topResult.output) : realpathSync(root);
  for (const base of new Set([root, top])) {
    const binary = join(base, "node_modules", ".bin", "linearis");
    if (!existsSync(binary)) continue;
    const target = realpathSync(binary);
    if ([root, top].every((folder) => relative(join(realpathSync(folder), "node_modules"), target).startsWith("..")))
      return finding(
        "FAIL",
        "linearis",
        "project binary resolves outside the dependency tree",
        "Install linearis in this project's node_modules.",
      );
    const version = command(binary, ["--version"], root, { ...process.env, NO_UPDATE_NOTIFIER: "1" });
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

export async function manifest(
  host: "claude-code" | "codex",
  root = ROOT,
  timeoutMs = FETCH_TIMEOUT_MS,
): Promise<PublishedResult> {
  const suffix = `dist/${host}/.${host === "codex" ? "codex" : "claude"}-plugin/plugin.json`;
  try {
    if (isAbsolute(root)) {
      const value = parseJson(readFileSync(join(root, suffix), "utf8"), validManifest);
      return { value, failure: value ? undefined : { reason: "invalid" } };
    } else {
      const response = await fetch(`${root}/${suffix}`, { signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok)
        return {
          value: null,
          failure: { reason: response.status === 404 ? "missing" : "http-error", status: response.status },
        };
      const value = parseJson(await response.text(), validManifest);
      return { value, failure: value ? undefined : { reason: "invalid" } };
    }
  } catch {
    return { value: null, failure: { reason: isAbsolute(root) ? "missing" : "network" } };
  }
}

function print(items: Finding[], json = false): number {
  if (json) console.log(JSON.stringify({ findings: items }));
  else for (const item of items) console.log(`${item.level} ${item.check}: ${item.detail}. Remedy: ${item.remedy}`);
  return items.some((item) => item.level === "FAIL") ? 1 : 0;
}

async function doctor(json = false): Promise<number> {
  const [claudeSource, codexSource] = await Promise.all([manifest("claude-code"), manifest("codex")]);
  const hostRoot = projectRoot();
  const claude = claudeRecords(hostRoot);
  const codex = codexRecords();
  const hasClaude = claude.some((row) => row.id === ID);
  const hasCodex = codex.some((row) => row.pluginId === ID);
  const claudeConfigured = claudeSourceConfigured(hostRoot);
  const codexConfigured = codexSourceConfigured();
  const root = findBindingRoot(process.cwd());
  const binding = parseBinding(root);
  const items = [
    hasClaude || claudeConfigured
      ? checkSource("Claude Code", claudeSource.value, claudeConfigured, claudeSource.failure)
      : finding("WARN", "Claude Code marketplace source", "not configured", "Install ak from Pibomeister/agent-kit."),
    hasCodex || codexConfigured
      ? checkSource("Codex", codexSource.value, codexConfigured, codexSource.failure)
      : finding("WARN", "Codex marketplace source", "not configured", "Add Pibomeister/agent-kit --ref published."),
    checkPlugin("Claude Code", claude, claudeSource.value?.version ?? null),
    checkPlugin("Codex", codex, codexSource.value?.version ?? null),
    checkProjectEnablement(process.cwd()),
    binding.finding,
    checkToken(root, binding.binding),
    checkLinearis(root, binding.binding?.backend ?? null),
  ];
  if (!hasClaude && !hasCodex) {
    items.push(
      finding(
        "FAIL",
        "installation",
        "ak is absent from both hosts",
        "Install ak from the published marketplace in Claude Code or Codex.",
      ),
    );
  }
  return print(items, json);
}

export function checkMaintenanceCommand(current: string, published: string): Finding {
  if (current === published)
    return finding("PASS", "maintenance command", "installed bin/ak matches the published bundle", "No action needed.");
  return finding(
    "WARN",
    "maintenance command",
    "installed bin/ak differs from the published bundle",
    `Download ${ROOT}/dist/claude-code/bin/ak again and make it executable.`,
  );
}

async function maintenanceCommandNotice(): Promise<Finding | null> {
  const path = process.argv[1];
  if (!path || basename(path) !== "ak") return null;
  try {
    const current = readFileSync(path, "utf8");
    const published = isAbsolute(ROOT)
      ? readFileSync(join(ROOT, "dist/claude-code/bin/ak"), "utf8")
      : await (async () => {
          const response = await fetch(`${ROOT}/dist/claude-code/bin/ak`, {
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
          });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          return response.text();
        })();
    return checkMaintenanceCommand(current, published);
  } catch {
    return finding(
      "WARN",
      "maintenance command",
      "could not compare installed bin/ak with the published bundle",
      `Check ${ROOT}/dist/claude-code/bin/ak and retry.`,
    );
  }
}

async function update(): Promise<number> {
  const [claudeSource, codexSource] = await Promise.all([manifest("claude-code"), manifest("codex")]);
  if (!claudeSource.value && !codexSource.value)
    return print([checkSource("published", null, true, claudeSource.failure ?? codexSource.failure)]);
  let failures = 0;
  const root = projectRoot();
  const claudeBefore = claudeRecords(root).filter((row) => row.id === ID);
  if (claudeBefore.length > 0) {
    const source = checkSource("Claude Code", claudeSource.value, claudeSourceConfigured(root), claudeSource.failure);
    const marketplace =
      source.level === "PASS"
        ? command("claude", ["plugin", "marketplace", "update", "agent-kit"], root, process.env, MUTATION_TIMEOUT_MS)
        : { ok: false, output: `${source.detail}. Remedy: ${source.remedy}` };
    if (!marketplace.ok) {
      console.error(`FAIL Claude Code update: ${marketplace.output}`);
      failures += 1;
    } else
      for (const scope of new Set(claudeBefore.map((row) => row.scope ?? "user"))) {
        const installation = claudeBefore.find((row) => (row.scope ?? "user") === scope);
        const oldVersion = installation?.version ?? "unknown";
        const updateRoot = scope === "user" ? root : (installation?.projectPath ?? root);
        const result = command(
          "claude",
          ["plugin", "update", ID, "--scope", scope, "--json"],
          updateRoot,
          process.env,
          MUTATION_TIMEOUT_MS,
        );
        const after = claudeRecords(root).find((row) => row.id === ID && (row.scope ?? "user") === scope);
        const current = after?.version ?? "unknown";
        const okay = result.ok && current === claudeSource.value?.version;
        console.log(
          `${okay ? "PASS" : "FAIL"} Claude Code ${scope}: ${oldVersion} -> ${current}${okay ? "" : `; ${result.output || "published version not installed"}`}`,
        );
        if (!okay) failures += 1;
      }
  }
  const codexBefore = codexRecords().find((row) => row.pluginId === ID);
  if (codexBefore) {
    const source = checkSource("Codex", codexSource.value, codexSourceConfigured(), codexSource.failure);
    const refresh =
      source.level === "PASS"
        ? command(
            "codex",
            ["plugin", "marketplace", "upgrade", "agent-kit", "--json"],
            process.cwd(),
            process.env,
            MUTATION_TIMEOUT_MS,
          )
        : { ok: false, output: `${source.detail}. Remedy: ${source.remedy}` };
    const result = refresh.ok
      ? command("codex", ["plugin", "add", ID, "--json"], process.cwd(), process.env, MUTATION_TIMEOUT_MS)
      : refresh;
    const after = codexRecords().find((row) => row.pluginId === ID);
    const current = after?.version ?? "unknown";
    const okay = result.ok && current === codexSource.value?.version;
    console.log(
      `${okay ? "PASS" : "FAIL"} Codex: ${codexBefore.version ?? "unknown"} -> ${current}${okay ? "" : `; ${result.output || "published version not installed"}`}`,
    );
    if (!okay) failures += 1;
  }
  if (claudeBefore.length === 0 && !codexBefore)
    return print([finding("FAIL", "installation", "ak is absent from both hosts", "Install ak before updating.")]);
  const maintenance = await maintenanceCommandNotice();
  if (maintenance) print([maintenance]);
  return failures ? 1 : 0;
}

if (import.meta.main) {
  const action = process.argv[2];
  const flags = process.argv.slice(3);
  if (
    (action === "doctor" && flags.every((flag) => flag === "--json") && flags.length <= 1) ||
    (action === "update" && flags.length === 0)
  )
    process.exitCode = action === "doctor" ? await doctor(flags[0] === "--json") : await update();
  else {
    console.error("Usage: ak doctor [--json] | ak update");
    process.exitCode = 2;
  }
}
