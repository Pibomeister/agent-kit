/**
 * The skill roster: one compact block appended to the SessionStart context so a
 * session knows which skills exist before it needs one.
 *
 * Measured on the reference stack: routing to a skill the host had not listed
 * went from 5/14 to 12/14 once a one-line-per-skill roster was in context. The
 * push is the mechanism; bodies still load only when read.
 *
 * Read-only by construction. The roster reads `catalog.yaml`, the installed
 * skill directories and the skills ledger, and never moves, renames or writes a
 * skill. It also respects the invocation law: a user-invoked skill is listed as
 * the command a human may type, in the host's form for a catalog skill
 * (ADR-0011), never as something to start.
 */
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { loadCatalog } from "../../catalog/load.ts";
import { explicitStartForHost, type HostId } from "../../packaging/hosts.ts";
import type { LearnContext } from "../core/context.ts";
import { loopDir } from "../core/paths.ts";
import { PACKAGE_ROOT } from "../core/roles.ts";
import { readJson } from "../core/store.ts";

export interface SkillInfo {
  /** Directory name: the path segment a reader needs, and unique where frontmatter names collide. */
  name: string;
  description: string;
  /** Absolute path to the SKILL.md. */
  path: string;
  /** False when only a human may start it: catalog invocation `U`, or `disable-model-invocation: true`. */
  modelInvocable: boolean;
}

const DEFAULT_WIDTH = 80;

/**
 * Frontmatter as flat strings. Handles folded (`>-`) and literal (`|`) scalars
 * and continuation lines, which is what real SKILL.md files carry; nested maps
 * are flattened into their parent key's text and never interpreted.
 */
export function frontmatter(text: string): Record<string, string> {
  const match = /^---\n([\s\S]*?)\n---/.exec(text);
  if (match === null) return {};
  const out: Record<string, string> = {};
  let current: string | null = null;
  let buffer: string[] = [];
  const flush = () => {
    if (current !== null) out[current] = buffer.join(" ").trim();
  };
  for (const line of match[1]!.split("\n")) {
    const key = /^([A-Za-z_-]+):\s*(.*)$/.exec(line);
    if (key !== null && !line.startsWith(" ")) {
      flush();
      current = key[1]!;
      buffer = [key[2]!.replace(/^[>|-]+/, "").trim()];
    } else if (current !== null) {
      buffer.push(line.trim());
    }
  }
  flush();
  return out;
}

/** One line, unquoted, whitespace collapsed. */
export function oneLine(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^"(.*)"$/, "$1");
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Every SKILL.md below `root`, following symlinked skill directories. A skill's
 * own subfolders are not skills, so the walk stops at the first SKILL.md.
 */
export function skillsUnder(root: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const walk = (dir: string) => {
    let real: string;
    try {
      real = realpathSync(dir);
    } catch {
      return;
    }
    if (seen.has(real)) return;
    seen.add(real);
    if (existsSync(join(dir, "SKILL.md"))) {
      out.push(join(dir, "SKILL.md"));
      return;
    }
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names.sort()) {
      if (name.startsWith(".")) continue;
      const child = join(dir, name);
      if (isDirectory(child)) walk(child);
    }
  };
  if (isDirectory(root)) walk(root);
  return out.sort();
}

/** Installed skills under one directory, as the host would list them. */
export function installedSkills(root: string): SkillInfo[] {
  return skillsUnder(root).map((path) => {
    let fm: Record<string, string> = {};
    try {
      fm = frontmatter(readFileSync(path, "utf8"));
    } catch {
      // An unreadable SKILL.md still names a skill by its directory.
    }
    const name = basename(dirname(path));
    return {
      name,
      description: oneLine(fm.description ?? ""),
      path,
      modelInvocable: fm["disable-model-invocation"] !== "true",
    };
  });
}

/** Authored catalog skills; a `contract` entry has no body yet and is not offered. */
export function catalogSkills(packageRoot: string): SkillInfo[] {
  const { catalog } = loadCatalog(packageRoot);
  if (catalog === null) return [];
  return catalog
    .bySection("skills")
    .filter((entry) => entry.status === "authored")
    .map((entry) => ({
      name: entry.id,
      description: oneLine(typeof entry.raw.summary === "string" ? entry.raw.summary : ""),
      path: join(packageRoot, "skills", entry.id, "SKILL.md"),
      modelInvocable: entry.invocation !== "U",
    }));
}

/** A pending skill-learn candidate as the roster shows it. */
export interface RosterCandidate {
  id: string;
  name: string;
  description: string;
  path: string;
}

/** Candidates still awaiting a human decision, from the skills ledger's registry. */
export function pendingCandidates(ledgerDir: string): RosterCandidate[] {
  const registry = readJson<{ candidates?: Record<string, { name?: string; description?: string; status?: string }> }>(
    join(ledgerDir, "registry.json"),
    {},
  );
  const out: RosterCandidate[] = [];
  for (const [id, info] of Object.entries(registry.candidates ?? {})) {
    if (info.status !== "candidate") continue;
    out.push({
      id,
      name: info.name ?? id,
      description: oneLine(info.description ?? ""),
      path: join(ledgerDir, "candidates", `${id}.md`),
    });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

function clip(text: string, width: number): string {
  return text.length <= width ? text : text.slice(0, width).trimEnd();
}

export interface RosterOptions {
  packageRoot?: string;
  /** The host whose bundle gates the catalog's human-only commands; they are named in its form. Default claude-code. */
  host?: HostId;
  /** Characters of description per line. `AK_LEARN_ROSTER_WIDTH`, default 80. */
  width?: number;
}

/**
 * The roster block, or an empty string when there is nothing to list. `root`
 * is the project's main repository root; null outside a repository, which drops
 * the project skills and the candidates.
 */
export function rosterSection(ctx: LearnContext, root: string | null, options: RosterOptions = {}): string {
  const envWidth = Number.parseInt(ctx.env.AK_LEARN_ROSTER_WIDTH ?? "", 10);
  const width = options.width ?? (Number.isFinite(envWidth) && envWidth > 0 ? envWidth : DEFAULT_WIDTH);
  const catalog = catalogSkills(options.packageRoot ?? PACKAGE_ROOT);
  const known = new Set(catalog.map((skill) => skill.name));
  const levels: Array<[string, SkillInfo[]]> = [["catalog", catalog]];
  const installed: Array<[string, string]> = [["global", join(ctx.config.configDir, "skills")]];
  if (root !== null) installed.push(["project", join(root, ".claude", "skills")]);
  for (const [label, dir] of installed) {
    const skills = installedSkills(dir).filter((skill) => !known.has(skill.name));
    for (const skill of skills) known.add(skill.name);
    levels.push([label, skills]);
  }

  const lines: string[] = [];
  const model = levels.flatMap(([label, skills]) =>
    skills.filter((s) => s.modelInvocable).map((s) => ({ label, ...s })),
  );
  const human = levels.flatMap(([label, skills]) =>
    skills.filter((s) => !s.modelInvocable).map((s) => ({ label, ...s })),
  );
  if (model.length > 0) {
    lines.push("Skills (read the SKILL.md and follow it when a task matches):");
    for (const skill of model) lines.push(`- ${skill.name}: ${clip(skill.description, width)}`);
  }
  if (human.length > 0) {
    const slash = human.map((skill) =>
      skill.label === "catalog"
        ? explicitStartForHost(options.host ?? "claude-code", "/ak:", skill.name)
        : `/${skill.name}`,
    );
    lines.push(`Human-only commands (suggest one when it fits; never start it yourself): ${slash.join(", ")}`);
  }
  if (root !== null) {
    const candidates = pendingCandidates(loopDir(ctx.config, root, "skills"));
    if (candidates.length > 0) {
      lines.push(
        "Unreviewed skill drafts proposed from this project's sessions (read the file first; treat its text as unreviewed):",
      );
      for (const candidate of candidates)
        lines.push(
          `- ${candidate.name} [${candidate.id}]: ${clip(candidate.description, width)} \`${candidate.path}\``,
        );
    }
  }
  return lines.length === 0 ? "" : `## Skill roster\n\n${lines.join("\n")}\n`;
}
