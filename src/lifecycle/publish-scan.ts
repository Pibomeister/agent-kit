/**
 * The publish scan: before a pull request is opened or edited on a repository outside the operator's
 * own organization, its title, body and commit messages are checked against the operator's internal
 * markers, so text meant for the operator's own agents does not become public.
 *
 * The markers live in one file outside every checkout, because the names they hold are the ones a
 * public repository must not carry: `--markers <file>`, else `AK_PUBLISH_MARKERS`, else
 * `~/.agent-kit/publish-markers`. One `kind: value` entry per line; blank lines and `#` lines are
 * skipped:
 *
 *   owner: example-org
 *   marker: example-org
 *   marker: build.example.internal
 *   marker: @example.com
 *   instructions: ~/.config/agents/brief.md
 *
 * An `owner` is a forge owner whose private repositories are internal. A `marker` matches
 * case-insensitively anywhere in the text: organization and people names, internal hostnames, work
 * e-mail domains. `instructions` names one of the operator's own agent instruction files, relative to
 * the markers file or under `~`; any run of INSTRUCTION_WORDS consecutive words from it, repeated in
 * the text, is a hit.
 *
 * The scan applies unless the target is private or internal AND its owner is configured. An
 * unstated visibility is treated as public. With no markers file the scan has nothing to check and
 * says so; a markers file that cannot be read refuses, because unknown is not clean.
 *
 * This file ships inside `bin/ak-gate.mjs`, so it imports only `node:` built-ins.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

/** Consecutive words that count as copied instruction text. */
export const INSTRUCTION_WORDS = 8;

export interface PublishMarkers {
  owners: string[];
  markers: string[];
  /** Word runs of each instruction file, keyed by the run, valued by the file it came from. */
  instructions: Map<string, string>;
}

export interface PublishText {
  /** Where the text came from: `title`, `body`, or `commit <sha>`. */
  source: string;
  text: string;
}

export interface PublishHit {
  source: string;
  kind: "marker" | "instruction";
  /** The marker, or the copied words. */
  match: string;
  /** The instruction file the copied words came from. */
  file?: string;
}

export function defaultMarkersPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.AK_PUBLISH_MARKERS ?? join(userInfo().homedir, ".agent-kit", "publish-markers");
}

const words = (text: string): string[] => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

function wordRuns(text: string): string[] {
  const all = words(text);
  const runs: string[] = [];
  for (let i = 0; i + INSTRUCTION_WORDS <= all.length; i += 1) runs.push(all.slice(i, i + INSTRUCTION_WORDS).join(" "));
  return runs;
}

/** Read the markers file. Undefined when it does not exist; throws when it exists and cannot be used. */
export function loadMarkers(path: string): PublishMarkers | undefined {
  if (!existsSync(path)) return undefined;
  const markers: PublishMarkers = { owners: [], markers: [], instructions: new Map() };
  for (const [i, raw] of readFileSync(path, "utf8").split("\n").entries()) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const colon = line.indexOf(":");
    const kind = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (colon < 0 || value === "") throw new Error(`line ${i + 1} is not \`kind: value\``);
    if (kind === "owner") markers.owners.push(value.toLowerCase());
    else if (kind === "marker") markers.markers.push(value);
    else if (kind === "instructions") {
      const home = value === "~" || value.startsWith("~/") ? join(userInfo().homedir, value.slice(1)) : value;
      const text = readFileSync(isAbsolute(home) ? home : resolve(dirname(path), home), "utf8");
      for (const run of wordRuns(text)) if (!markers.instructions.has(run)) markers.instructions.set(run, value);
    } else throw new Error(`line ${i + 1}: unknown kind "${kind}"; use owner, marker or instructions`);
  }
  return markers;
}

/** Whether a target must be scanned: everything but a private or internal repository of a configured owner. */
export function scanApplies(markers: PublishMarkers, repo: string, visibility: string | undefined): boolean {
  const owner = repo.split("/")[0]?.toLowerCase() ?? "";
  const closed = visibility !== undefined && ["private", "internal"].includes(visibility.toLowerCase());
  return !(closed && markers.owners.includes(owner));
}

export function scanText(markers: PublishMarkers, texts: readonly PublishText[]): PublishHit[] {
  const hits: PublishHit[] = [];
  for (const { source, text } of texts) {
    const lower = text.toLowerCase();
    for (const marker of markers.markers)
      if (lower.includes(marker.toLowerCase())) hits.push({ source, kind: "marker", match: marker });
    const seen = new Set<string>();
    for (const run of wordRuns(text)) {
      const file = markers.instructions.get(run);
      if (file === undefined || seen.has(file)) continue;
      seen.add(file);
      hits.push({ source, kind: "instruction", match: run, file });
    }
  }
  return hits;
}

/** The commit messages in a range, newest first, or the reason git could not list them. */
export function commitMessages(project: string, range: string): { texts: PublishText[] } | { error: string } {
  const proc = spawnSync("git", ["log", "--format=%H%x00%B%x1e", range, "--"], { cwd: project, encoding: "utf8" });
  if (proc.error !== undefined) return { error: `cannot run git in ${project}: ${proc.error.message}` };
  if (proc.status !== 0) return { error: `git log ${range} failed: ${proc.stderr.trim()}` };
  const texts = proc.stdout
    .split("\x1e")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "")
    .map((entry) => {
      const [sha = "", message = ""] = entry.split("\x00");
      return { source: `commit ${sha.slice(0, 12)}`, text: message };
    });
  return { texts };
}

export interface PublishScanArgs {
  repo: string;
  visibility?: string;
  title?: string;
  bodyFile?: string;
  commits?: string;
  markersPath: string;
  project: string;
  io: { out: (line: string) => void; err: (line: string) => void };
}

/** Exit 0 when clean or not applicable, 1 when a hit or an unreadable input refuses. */
export function runPublishScan(a: PublishScanArgs): number {
  const sub = "ak lifecycle publish-scan";
  let markers: PublishMarkers | undefined;
  try {
    markers = loadMarkers(a.markersPath);
  } catch (e) {
    a.io.err(`${sub}: ${a.markersPath}: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  if (markers === undefined) {
    a.io.out(`ok: no markers file at ${a.markersPath}; nothing to scan for (record the scan as not run)`);
    return 0;
  }
  if (!scanApplies(markers, a.repo, a.visibility)) {
    a.io.out(`ok: ${a.repo} is ${a.visibility} and its owner is configured; not scanned`);
    return 0;
  }
  const texts: PublishText[] = [];
  if (a.title !== undefined) texts.push({ source: "title", text: a.title });
  if (a.bodyFile !== undefined) {
    try {
      texts.push({ source: "body", text: readFileSync(resolve(a.project, a.bodyFile), "utf8") });
    } catch (e) {
      a.io.err(`${sub}: cannot read --body-file: ${e instanceof Error ? e.message : String(e)}`);
      return 1;
    }
  }
  if (a.commits !== undefined) {
    const messages = commitMessages(a.project, a.commits);
    if ("error" in messages) {
      a.io.err(`${sub}: ${messages.error}`);
      return 1;
    }
    texts.push(...messages.texts);
  }
  const hits = scanText(markers, texts);
  for (const hit of hits)
    a.io.err(
      hit.kind === "marker"
        ? `refused: ${hit.source} contains the internal marker "${hit.match}"`
        : `refused: ${hit.source} repeats instruction text from ${hit.file}: "${hit.match}"`,
    );
  if (hits.length > 0) {
    a.io.err(`${sub}: ${hits.length} hit(s) in text bound for ${a.repo}; rewrite it before publishing`);
    return 1;
  }
  a.io.out(`ok: ${texts.length} text(s) bound for ${a.repo} carry no internal marker`);
  return 0;
}
