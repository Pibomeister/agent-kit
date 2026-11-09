import { realpathSync } from "node:fs";
import { basename, posix, relative, sep } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import { parse as parseYaml } from "yaml";

import { error, warning, type Issue } from "../validation/types.ts";
import type { KbBinding, ResolvedKb } from "./binding.ts";
import { git, workTreeTop } from "./git.ts";
import {
  documentHash,
  KB_KINDS,
  KEBAB,
  kindProblem,
  normalizeBody,
  PROJECT_SCOPE,
  scopeProblem,
  scopeSegments,
  type KbDocument,
  type KbRefusal,
  type ReadOutcome,
} from "./local-git.ts";

/**
 * The read-only `in-repo` backend (adapters/knowledgebase/backends/in-repo.md):
 * pages committed in the project's own repository, read in place. Nothing here
 * writes: a publish is skipped before it reaches a backend (src/kb/cli.ts), so
 * no project knowledge is ever written into the application repository
 * (adapters/knowledgebase/CONTRACT.md, "Centrality").
 *
 * The revision read is the merge-base of the checkout's HEAD and the binding's
 * base branch, so a page a branch commits, or a status it sets, is not
 * knowledge until it is merged: the same rule local-git keeps by reading only
 * what its own repository committed.
 */
export const IN_REPO = "in-repo";

/** The statuses a page keeps as declared; any other declaration, or none, reads as `unreviewed`. */
const SETTLED_STATUSES = new Set(["accepted", "superseded", "deprecated", "rejected", "proposed"]);

/** Where an in-repo binding reads, once resolved. */
export interface InRepoLocation {
  /** The path as the binding writes it, relative to the project folder. */
  configuredPath: string;
  /** The wiki directory relative to the git top level, forward slashes. */
  path: string;
  /** The base branch as the binding names it. */
  base: string;
  /** The commit read: the merge-base of HEAD and the base ref. */
  revision: string;
  /** Each mapped kind's directory relative to the git top level. */
  kinds: Record<string, string>;
  /** The project folder relative to the git top level ("" at the top), to report paths from it. */
  projectPrefix: string;
}

export interface InRepoResolution {
  location: InRepoLocation | null;
  /** The git top level, by real path, when it was found. */
  top: string | null;
  issues: Issue[];
}

/** The locator schemas/kb-backends/in-repo.schema.json has already admitted, as this backend reads it. */
interface InRepoLocator {
  knowledgebase: string;
  path: string;
  base: string;
  kinds: Record<string, string>;
}

const ajv = new Ajv2020({ strict: false });
const validLocator = ajv.compile<InRepoLocator>({
  type: "object",
  required: ["knowledgebase", "path", "base", "kinds"],
  properties: {
    knowledgebase: { type: "string" },
    path: { type: "string" },
    base: { type: "string" },
    kinds: { type: "object", additionalProperties: { type: "string" } },
  },
});
/** A header mapping whose `title` is a scalar; a list, a map or nothing leaves the title to the body. */
const hasScalarTitle = ajv.compile<{ title: string | number | boolean }>({
  type: "object",
  required: ["title"],
  properties: { title: { type: ["string", "number", "boolean"] } },
});
/** The same for `status`. */
const hasScalarStatus = ajv.compile<{ status: string | number | boolean }>({
  type: "object",
  required: ["status"],
  properties: { status: { type: ["string", "number", "boolean"] } },
});

/** The binding's locator, parsed; empty when it is not an in-repo locator, which check has refused already. */
function locatorOf(binding: KbBinding): InRepoLocator {
  const locator = binding.locator;
  return validLocator(locator) ? locator : { knowledgebase: "", path: "", base: "", kinds: {} };
}

/**
 * The binding-level rule a schema cannot state: no mapped directory equals or
 * contains another, so no page is read under two kinds and no parent mapping
 * pulls in a directory nobody mapped.
 */
export function inRepoBindingIssues(binding: KbBinding, file: string): Issue[] {
  const dirs = Object.entries(locatorOf(binding).kinds);
  for (const [kind, dir] of dirs) {
    for (const [other, otherDir] of dirs) {
      if (kind !== other && (dir === otherDir || otherDir.startsWith(`${dir}/`))) {
        return [
          error(
            "kb.binding-invalid",
            file,
            `locator.kinds maps ${kind} to '${dir}' and ${other} to '${otherDir}': one directory equals or contains the other, so a page would be read under two kinds.`,
          ),
        ];
      }
    }
  }
  return [];
}

/** How to clear kb.in-repo-missing, said once for ak kb and ak doctor. */
export const IN_REPO_MISSING_REMEDY =
  "Commit the knowledgebase path on the base branch, fetch the base, or repair the binding.";

function missing(file: string, message: string): Issue[] {
  return [
    warning(
      "kb.in-repo-missing",
      file,
      `${message} No knowledgebase is read, a coverage limit: reads are unavailable and a publish is skipped. ${IN_REPO_MISSING_REMEDY}`,
    ),
  ];
}

function baseRevision(top: string, base: string): string | null {
  for (const ref of [`refs/remotes/origin/${base}`, `refs/heads/${base}`]) {
    // The ref alone, not peeled: a ref whose object git cannot read reaches merge-base and fails there.
    const found = git(top, ["rev-parse", "--verify", "--quiet", ref]);
    if (found.status === 0) return found.stdout.trim();
  }
  return null;
}

/** Where the binding of the project at `projectRoot` reads, or why it reads nothing (kb.in-repo-missing). */
export function resolveInRepo(projectRoot: string, binding: KbBinding, file: string): InRepoResolution {
  const project = realpathSync(projectRoot);
  const top = workTreeTop(project);
  if (top === null) return { location: null, top, issues: missing(file, `${project} is not in a git work tree.`) };
  const locator = locatorOf(binding);
  const base = locator.base;
  const baseSha = baseRevision(top, base);
  if (baseSha === null) {
    return {
      location: null,
      top,
      issues: missing(
        file,
        `The base branch '${base}' resolves as neither refs/remotes/origin/${base} nor refs/heads/${base}.`,
      ),
    };
  }
  // Unpeeled, so only an unborn HEAD lands here; a HEAD whose commit object is lost fails at merge-base.
  if (git(top, ["rev-parse", "--verify", "--quiet", "HEAD"]).status !== 0) {
    return { location: null, top, issues: missing(file, "HEAD names no commit yet, so there is no revision to read.") };
  }
  const merged = git(top, ["merge-base", "HEAD", baseSha]);
  // git merge-base exits 1 when the two share no ancestor, and higher when git itself failed.
  if (merged.status === 1) {
    return { location: null, top, issues: missing(file, `HEAD shares no history with the base branch '${base}'.`) };
  }
  if (merged.status !== 0) {
    return {
      location: null,
      top,
      issues: [error("kb.unreadable", file, `git merge-base failed: ${merged.stderr.trim()}`)],
    };
  }
  const revision = merged.stdout.trim();
  const projectPrefix = relative(top, project).split(sep).join("/");
  const path = posix.join(projectPrefix, locator.path);
  const listed = git(top, ["ls-tree", "--full-tree", revision, "--", path]);
  if (listed.status !== 0) {
    return {
      location: null,
      top,
      issues: [error("kb.unreadable", file, `git could not list ${path}: ${listed.stderr.trim()}`)],
    };
  }
  if (!/^\d+ tree [0-9a-f]+\t/.test(listed.stdout)) {
    return {
      location: null,
      top,
      issues: missing(
        file,
        `'${locator.path}' is not a directory at ${revision.slice(0, 12)}, the merge-base of HEAD and '${base}'.`,
      ),
    };
  }
  const kinds = Object.fromEntries(Object.entries(locator.kinds).map(([kind, dir]) => [kind, posix.join(path, dir)]));
  return { location: { configuredPath: locator.path, path, base, revision, kinds, projectPrefix }, top, issues: [] };
}

interface PageMeta {
  title: string | null;
  status: string | null;
}

/** A page split into what its header declares and the body after it. */
interface Page {
  meta: PageMeta;
  body: string;
}

/**
 * A page's own header, when it has one: `---`, YAML, `---`. A header that is not
 * closed, does not parse or is not a mapping reads as absent, and a title or
 * status that is not a scalar reads as absent too, so the page falls back to its
 * heading, its id and the status its body declares.
 */
function splitFrontMatter(text: string): Page {
  const normalized = text.replace(/\r+\n/g, "\n");
  if (!normalized.startsWith("---\n")) return { meta: { title: null, status: null }, body: normalized };
  const end = normalized.indexOf("\n---\n", 3);
  if (end === -1) return { meta: { title: null, status: null }, body: normalized };
  return { meta: headerMeta(normalized.slice(4, end)), body: normalized.slice(end + 5) };
}

/** The title and status a header's YAML gives, each absent unless it is a scalar; YAML that does not parse gives neither. */
function headerMeta(yaml: string): PageMeta {
  try {
    const parsed: unknown = parseYaml(yaml);
    return {
      title: hasScalarTitle(parsed) ? String(parsed.title) : null,
      status: hasScalarStatus(parsed) ? String(parsed.status) : null,
    };
  } catch {
    return { title: null, status: null };
  }
}

/** The first word of a declaration, lowercased, without markdown emphasis or punctuation. */
function firstWord(text: string): string | null {
  const word =
    text
      .replaceAll(/[*_`[\]]/g, " ")
      .trim()
      .split(/\s+/)[0] ?? "";
  const cleaned = word.toLowerCase().replaceAll(/[^a-z0-9-]/g, "");
  return cleaned === "" ? null : cleaned;
}

/** Front matter `status`, then an inline `**Status:** X`, then the first line of a `## Status` section. */
function declaredStatus(meta: PageMeta, body: string): string | null {
  if (meta.status !== null) return firstWord(meta.status);
  const inline = /^\s*\*\*Status:?\*\*:?[ \t]*(\S.*)$/im.exec(body);
  if (inline?.[1] !== undefined) return firstWord(inline[1]);
  const section = /^##[ \t]+Status[ \t]*\n+(?:[ \t]*\n)*[ \t]*(\S.*)$/im.exec(body);
  return section?.[1] === undefined ? null : firstWord(section[1]);
}

function titleOf(meta: PageMeta, body: string, id: string): string {
  if (meta.title !== null && meta.title.trim() !== "") return meta.title.trim();
  const heading = /^#[ \t]+(\S.*)$/m.exec(body);
  return heading?.[1]?.trim() ?? id;
}

function unreadable(message: string): KbRefusal {
  return { status: "failed", code: "kb.unreadable", message };
}

/** The commit at `revision` that last changed each path under `dirs`, from one log walk. */
function lastChanges(top: string, revision: string, dirs: readonly string[]): Map<string, string> | KbRefusal {
  const log = git(top, ["-c", "core.quotePath=false", "log", "--format=@%H", "--name-only", revision, "--", ...dirs]);
  if (log.status !== 0) return unreadable(`git could not walk the history of ${dirs.join(", ")}: ${log.stderr.trim()}`);
  const changed = new Map<string, string>();
  let commit = "";
  for (const line of log.stdout.split("\n")) {
    if (line.startsWith("@")) commit = line.slice(1);
    else if (line !== "" && !changed.has(line)) changed.set(line, commit);
  }
  return changed;
}

interface Listed {
  kind: string;
  path: string;
}

/** The regular markdown files under each requested kind's directory, `index.md` excepted. */
function listPages(top: string, location: InRepoLocation, kinds: readonly string[]): Listed[] | KbRefusal {
  const pages: Listed[] = [];
  for (const kind of kinds) {
    const dir = location.kinds[kind];
    if (dir === undefined) continue;
    const listed = git(top, ["ls-tree", "-r", "-z", "--full-tree", location.revision, "--", `${dir}/`]);
    if (listed.status !== 0) {
      return unreadable(`git could not list ${dir}: ${listed.stderr.trim()}`);
    }
    for (const entry of listed.stdout.split("\0")) {
      const tab = entry.indexOf("\t");
      if (tab === -1) continue;
      const [mode, type] = entry.slice(0, tab).split(" ");
      const path = entry.slice(tab + 1);
      if (type !== "blob" || (mode !== "100644" && mode !== "100755")) continue;
      if (!path.endsWith(".md") || basename(path) === "index.md") continue;
      pages.push({ kind, path });
    }
  }
  return pages;
}

/**
 * `readContext` for an in-repo binding: the mapped pages of the given kinds.
 * Every page is filed at scope `project`, so any valid scope returns them, the
 * scope and every scope above it.
 */
export function readInRepoContext(
  kb: ResolvedKb,
  location: InRepoLocation,
  kinds: readonly string[],
  scope: string,
): ReadOutcome | KbRefusal {
  const top = kb.root;
  const unknown = kinds.find((kind) => !KB_KINDS.includes(kind));
  if (unknown !== undefined) return kindProblem(unknown);
  const segments = scopeSegments(scope);
  if (segments === null) return scopeProblem(scope);
  const scopes = Array.from({ length: segments.length + 1 }, (_, depth) => segments.slice(0, segments.length - depth));
  const outcome: ReadOutcome = {
    status: "complete",
    knowledgebase: kb.knowledgebase,
    project: kb.binding.project,
    documents: [],
    coverage: {
      kinds: [...kinds],
      scopes: scopes.map((at) => (at.length === 0 ? PROJECT_SCOPE : at.join("/"))),
      unreadable: [],
      run_artifact_links: "not-selected",
    },
  };
  const listed = listPages(top, location, kinds);
  if (!Array.isArray(listed)) return listed;
  const shown = (path: string) =>
    location.projectPrefix === "" ? path : path.slice(location.projectPrefix.length + 1);
  const stems = new Map<string, number>();
  for (const page of listed) {
    const key = `${page.kind}/${basename(page.path, ".md")}`;
    stems.set(key, (stems.get(key) ?? 0) + 1);
  }
  const changes = lastChanges(top, location.revision, [
    ...new Set(listed.map((page) => location.kinds[page.kind] ?? "")),
  ]);
  if (!(changes instanceof Map)) return changes;
  for (const page of listed) {
    const id = basename(page.path, ".md");
    if (!KEBAB.test(id) || (stems.get(`${page.kind}/${id}`) ?? 0) > 1) {
      outcome.coverage.unreadable.push(shown(page.path));
      continue;
    }
    const content = git(top, ["show", `${location.revision}:${page.path}`]);
    if (content.status !== 0) return unreadable(`git could not read ${page.path}: ${content.stderr.trim()}`);
    const parsed = splitFrontMatter(content.stdout);
    const body = normalizeBody(parsed.body);
    const title = titleOf(parsed.meta, body, id);
    const declared = declaredStatus(parsed.meta, body);
    const status = declared !== null && SETTLED_STATUSES.has(declared) ? declared : "unreviewed";
    const document: KbDocument & { declared_status: string | null } = {
      ref: `doc:${PROJECT_SCOPE}/${page.kind}/${id}`,
      kind: page.kind,
      scope: PROJECT_SCOPE,
      id,
      title,
      status,
      declared_status: declared,
      content_hash: documentHash({ kind: page.kind, scope: PROJECT_SCOPE, id, title, body, run: null }),
      revision: changes.get(page.path) ?? location.revision,
      body,
    };
    outcome.documents.push(document);
  }
  return outcome;
}
