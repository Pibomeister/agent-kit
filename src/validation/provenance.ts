import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { DIRECTORY_SECTIONS, entryDir } from "../catalog/layout.ts";
import { isDir, listFiles, readTextIfPresent } from "../util/fs.ts";
import type { CheckContext } from "./context.ts";
import { error, note, skipped, warning, type Issue } from "./types.ts";

const TRANSCRIPT = "research/sources/grok-transcript.md";
const PLAN = "research/sources/engineering-skills-repo-plan.md";
const LOCK = "provenance/upstream.lock.yaml";
/**
 * `provenance/adaptations.yaml` is generated, never authored. Batches write one
 * fragment each under `adaptations.d/`, which is what makes ten sequential
 * batches possible without a merge conflict on every one of them; `ak build`
 * renders the merged file, which is what NOTICE, README, AGENTS.md and
 * catalog.yaml point a downstream consumer at for MIT attribution.
 */
export const ADAPTATIONS_FILE = "provenance/adaptations.yaml";
export const ADAPTATIONS_FRAGMENT_DIR = "provenance/adaptations.d";
const CONVERSATION_MAP = "provenance/conversation-map.yaml";

export interface GLocator {
  start: number;
  end: number;
}

/** `G:L<start>` or `G:L<start>-<end>`. Null when malformed or inverted. */
export function parseGLocator(text: string): GLocator | null {
  const match = /^G:L(\d+)(?:-(\d+))?$/.exec(text.trim());
  if (match === null) return null;
  const start = Number(match[1]);
  const end = match[2] === undefined ? start : Number(match[2]);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 1 || start > end) return null;
  return { start, end };
}

/** The document keywords the locator grammar admits. Both name one file; see DOCUMENT_FILE. */
export type DocumentKeyword = "plan" | "arch";

export type LocatorReference =
  | { kind: "transcript"; start: number; end: number }
  | { kind: "document"; document: DocumentKeyword; section: string }
  | { kind: "amalgam"; left: string; right: string };

/**
 * `plan §7.1`, `arch §3`, `plan §9 (Milestone 7)`.
 *
 * A closed set with a real pattern, on purpose. The design's precedence order
 * puts the document *above* the transcript rather than beneath it, so a document
 * reference is a stronger citation than a transcript range, not a weaker one.
 * Anything outside this shape -- a bare `see the discussion above` -- still
 * fails, or widening the grammar would be an escape hatch instead of a parser.
 *
 * **`plan` and `arch` are two spellings of one file**, and the file's name is
 * the trap: `research/sources/engineering-skills-repo-plan.md` is the governing
 * design document, and its `-repo-plan` suffix is why a second spelling grew for
 * it. `docs/decisions/0001-kb-document-vocabulary.md` gives that path as its
 * authority "§1.2, §8", then calls those same sections "the architecture doc
 * (§1.2, §8)" and cites "arch §8". One document, both names, 676 lines,
 * registered in the lock as local source `plan`.
 *
 * The *implementation* plan is a third document. It is not in this tree and
 * `plan §N` does not mean it: `policies/resolved-conflicts.yaml` writes
 * `plan: "§6.3, §11"` for the architecture document's sections, so anyone
 * reading `plan` as the implementation plan misreads every row that cites one.
 */
export const DOCUMENT_REFERENCE = /^(plan|arch) §(\d+(?:\.\d+)*(?: \([^()]+\))?)$/;

/**
 * Which file each document keyword resolves against.
 *
 * Exhaustive over the keywords DOCUMENT_REFERENCE admits, which is the guard
 * this resolution lacked: `arch` used to reach the plan's index by falling
 * through a default, so `arch §5` matched the plan's §5 and passed without
 * either side establishing which document had been named. It was right by
 * accident. The entries below make it right on purpose.
 *
 * The `Record<DocumentKeyword, ...>` annotation is not the whole enforcement,
 * and the reason is not that types go unchecked here -- an earlier version of
 * this comment claimed that and was wrong. `bunx tsc --noEmit` runs clean on
 * this tree and does catch a widened `DocumentKeyword` with no entry below
 * (TS2741).
 *
 * What it cannot catch is the other half. DOCUMENT_REFERENCE is a runtime regex
 * and DocumentKeyword is a declaration: two surfaces carrying one fact, with no
 * link between them, so widening the *grammar* alone typechecks clean. Measured
 * both ways -- regex widened, type untouched: tsc exits 0 and the test below
 * fails; type widened, regex untouched: tsc exits 1 and the test below passes.
 * Each is blind to exactly what the other catches, which is why both are here.
 *
 * Nothing runs tsc automatically -- it is not a dependency and there is no CI --
 * so the test is the half that runs unprompted.
 *
 * The record records a decision; it does not supply an index. A keyword that
 * ever maps to a different file needs its own index built for it, not just a
 * row added here -- so that test checks the mapped file is one the resolver was
 * actually given an index for.
 */
export const DOCUMENT_FILE: Record<DocumentKeyword, string> = { plan: PLAN, arch: PLAN };

/**
 * `amalgam roles/code-review/frontend-races + roles/doc-review/design-lens`.
 *
 * The locator for a capability that exists only because two donor-derived seats
 * were placed in the same catalog: a boundary neither donor could state, because
 * neither knows the other exists, and the transcript never specified, because it
 * never enumerated seat pairs at this granularity. AGENTS.md opens by saying this
 * repository *amalgamates* six donors; this is the origin that verb produces.
 *
 * Both endpoints are catalog destinations, so this locator is checkable in a way
 * a transcript range is not: `G:L` gets an upper bound and nothing more, while an
 * amalgam reference dangles loudly the moment either seat is renamed or dropped.
 *
 * It also has no bootstrapping problem. A commit SHA would be the obvious anchor
 * and cannot be written, because the row lands in the same commit as the body it
 * describes. Both seats here pre-date the row, so the locator names only things
 * that already exist -- which is the reason to locate a boundary by its endpoints
 * rather than by the act that drew it.
 */
const AMALGAM_REFERENCE = /^amalgam (\S+) \+ (\S+)$/;

/**
 * The origins a map row may declare. `conversation-map.yaml` has no JSON schema,
 * so nothing else constrains this field -- a row with a misspelled value, or with
 * the key itself misspelled, was silently originless before this list existed.
 */
const ORIGINS = ["donor", "conversation", "amalgam"] as const;

/** Render a reference the way the map writes it, so a message quotes the offending one. */
export function formatLocatorReference(reference: LocatorReference): string {
  if (reference.kind === "amalgam") return `amalgam ${reference.left} + ${reference.right}`;
  if (reference.kind === "document") return `${reference.document} §${reference.section}`;
  return reference.start === reference.end ? `G:L${reference.start}` : `G:L${reference.start}-${reference.end}`;
}

/**
 * A whole `locator:` field: one or more references separated by `;`.
 *
 * A capability grounded in three places cites three places. Parsing the field
 * as a single range failed those rows wholesale, which meant none of their
 * `G:L` references were range-checked at all. One bad reference still fails
 * the field.
 *
 * This parser accepts strictly more input than the single-range one it replaced,
 * which reads like a loosened gate and is the opposite. Measured against
 * `provenance/conversation-map.yaml` on the day of the change: the single-range
 * parser accepted **4 of 102** locator fields, so **157 of the 161** `G:L`
 * references in the map were never range-checked at all -- the 98 rejected
 * fields fell out of the check entirely rather than failing it. The field parser
 * resolves all 257 references (161 transcript, 96 document) and range-checks
 * every transcript one. The gate went from covering 4 references to covering
 * 161; it was restored, not widened.
 */
export function parseLocatorField(text: string): LocatorReference[] | null {
  const parts = text.split(";").map((part) => part.trim());
  if (parts.some((part) => part.length === 0)) return null;

  const references: LocatorReference[] = [];
  for (const part of parts) {
    const transcript = parseGLocator(part);
    if (transcript !== null) {
      references.push({ kind: "transcript", start: transcript.start, end: transcript.end });
      continue;
    }
    const amalgam = AMALGAM_REFERENCE.exec(part);
    if (amalgam?.[1] !== undefined && amalgam[2] !== undefined) {
      references.push({ kind: "amalgam", left: amalgam[1], right: amalgam[2] });
      continue;
    }
    const match = DOCUMENT_REFERENCE.exec(part);
    if (match?.[1] === undefined || match[2] === undefined) return null;
    references.push({ kind: "document", document: match[1] === "plan" ? "plan" : "arch", section: match[2] });
  }
  return references;
}

/** `donor@commit:path` */
export interface DonorSource {
  donor: string;
  commit: string;
  path: string;
}

export function parseDonorSource(text: string): DonorSource | null {
  const match = /^([A-Za-z0-9._-]+)@([0-9a-f]{7,64}):(.+)$/.exec(text.trim());
  if (match?.[1] === undefined || match[2] === undefined || match[3] === undefined) return null;
  return { donor: match[1], commit: match[2], path: match[3] };
}

/** `local:<local_source_id>@sha256:<64-hex>[#L<start>-<end>]` */
interface LocalAdaptationSource {
  id: string;
  sha256: string;
  start: number | null;
  end: number | null;
}

function parseLocalAdaptationSource(text: string): LocalAdaptationSource | null {
  const match = /^local:([A-Za-z0-9._-]+)@sha256:([0-9a-f]{64})(?:#L(\d+)-(\d+))?$/.exec(text.trim());
  if (match?.[1] === undefined || match[2] === undefined) return null;
  if (match[3] === undefined || match[4] === undefined) {
    return { id: match[1], sha256: match[2], start: null, end: null };
  }

  const start = Number(match[3]);
  const end = Number(match[4]);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || start > end) return null;
  return { id: match[1], sha256: match[2], start, end };
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function readYaml(root: string, file: string): { value: Record<string, unknown> } | { error: Issue } | null {
  const text = readTextIfPresent(join(root, file));
  if (text === null) return null;
  try {
    return { value: record(parseYaml(text)) };
  } catch (cause) {
    return { error: error("provenance.unparseable", file, cause instanceof Error ? cause.message : String(cause)) };
  }
}

function listOf(doc: Record<string, unknown>, keys: ReadonlyArray<string>): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const key of keys) {
    const raw = doc[key];
    if (!Array.isArray(raw)) continue;
    for (const item of raw) {
      const entry = record(item);
      if (Object.keys(entry).length > 0) out.push(entry);
    }
  }
  return out;
}

interface Donor {
  id: string;
  path: string;
  commit: string;
}

interface LocalSource {
  workingCopy: string;
  sha256: string;
  lines: number;
}

function loadLocalSourceRecords(root: string): Map<string, LocalSource> {
  const sources = new Map<string, LocalSource>();
  const doc = readYaml(root, LOCK);
  if (doc === null || "error" in doc) return sources;

  for (const entry of listOf(doc.value, ["local_sources"])) {
    const id = entry["id"];
    const workingCopy = entry["working_copy"];
    const sha256 = entry["sha256"];
    const lines = entry["lines"];
    if (typeof id !== "string" || typeof workingCopy !== "string" || typeof sha256 !== "string") continue;
    if (typeof lines !== "number" || !Number.isSafeInteger(lines) || lines < 0) continue;
    sources.set(id, { workingCopy, sha256, lines });
  }
  return sources;
}

function loadDonors(root: string): { donors: Map<string, Donor>; issues: Issue[] } {
  const donors = new Map<string, Donor>();
  const issues: Issue[] = [];
  const doc = readYaml(root, LOCK);
  if (doc === null) {
    issues.push(
      note(
        "provenance.lock-unavailable",
        LOCK,
        "No upstream lock; donor pins could not be resolved. Rows naming a donor it would have pinned are reported individually as provenance.unknown-donor, so an unverified row is an error here rather than a silence.",
      ),
    );
    return { donors, issues };
  }
  if ("error" in doc) return { donors, issues: [doc.error] };

  for (const entry of listOf(doc.value, ["donors"])) {
    const id = entry["id"];
    if (typeof id !== "string") continue;
    donors.set(id, {
      id,
      path: typeof entry["path"] === "string" ? entry["path"] : `.donors/${id}`,
      commit: typeof entry["commit"] === "string" ? entry["commit"] : "",
    });
  }
  return { donors, issues };
}

export interface Adaptation {
  path: string;
  source: string;
  /** The fragment this row came from, so a conflict can name both sides. */
  file: string;
  /** The row as written, so fields beyond path and source survive the merge. */
  row: Record<string, unknown>;
}

/**
 * The merged view every other document in the repository refers to.
 *
 * Fragments are the only input, and each adapted path is owned by exactly one
 * fragment. Two fragments claiming the same path is the failure mode this
 * design introduces — the merged file would otherwise depend on fragment order
 * — so it is an error rather than a last-writer-wins merge.
 *
 * Several rows in *one* fragment may share a path: a body adapted from three
 * donor files has three sources and one target, and collapsing that to one row
 * would lose attribution the MIT notices are built from. An exactly repeated
 * `path` + `source` pair is redundant rather than contradictory, so it is a
 * warning and the merge keeps one copy.
 */
export function loadAdaptationFragments(root: string): { rows: Adaptation[]; issues: Issue[]; present: boolean } {
  const rows: Adaptation[] = [];
  const issues: Issue[] = [];

  const names = listFiles(join(root, ADAPTATIONS_FRAGMENT_DIR))
    .filter((n) => /\.ya?ml$/.test(n))
    .sort();
  const present = isDir(join(root, ADAPTATIONS_FRAGMENT_DIR));

  /** path -> the one fragment that owns it, and the sources it has already recorded. */
  const claimed = new Map<string, { file: string; sources: Map<string, Adaptation> }>();
  for (const name of names) {
    const file = `${ADAPTATIONS_FRAGMENT_DIR}/${name}`;
    const doc = readYaml(root, file);
    if (doc === null) continue;
    if ("error" in doc) {
      issues.push(doc.error);
      continue;
    }
    for (const entry of listOf(doc.value, ["adaptations"])) {
      const path = entry["path"];
      if (typeof path !== "string") continue;
      const source = typeof entry["source"] === "string" ? entry["source"] : "";
      const row: Adaptation = { path, source, file, row: entry };

      const prior = claimed.get(path);
      if (prior === undefined) {
        claimed.set(path, { file, sources: new Map([[source, row]]) });
        rows.push(row);
        continue;
      }

      const repeated = prior.sources.get(source);
      if (repeated !== undefined) {
        // Both sides say the same thing, so the merge is still well defined and
        // the row survives once. Redundant, not contradictory: a warning.
        issues.push(
          warning(
            "provenance.duplicate-adaptation",
            file,
            `'${path}' is already recorded from ${source || "(no source)"} in ${repeated.file}. The merged file carries it once; the second row adds no attribution.`,
          ),
        );
        continue;
      }

      if (prior.file !== file) {
        issues.push(
          error(
            "provenance.conflicting-adaptation",
            file,
            `'${path}' is recorded here as ${source || "(no source)"} and in ${prior.file} as ${[...prior.sources.keys()].map((s) => s || "(no source)").join(", ")}. One fragment owns each adapted path; resolve which batch owns it rather than letting the merge pick one.`,
          ),
        );
        continue;
      }

      prior.sources.set(source, row);
      rows.push(row);
    }
  }

  if (!present) {
    issues.push(
      note(
        "provenance.adaptations-unavailable",
        ADAPTATIONS_FRAGMENT_DIR,
        `No ${ADAPTATIONS_FRAGMENT_DIR}/; no adapted-file rows to check yet. An empty merge is valid.`,
      ),
    );
  }
  return { rows, issues, present };
}

const GENERATED_HEADER = [
  "# Generated by `ak build` from provenance/adaptations.d/*.yaml. Do not edit this file.",
  "# Write surface: provenance/adaptations.d/<batch>.yaml, one fragment per batch.",
  "# Each adapted file is recorded here with an exact donor@commit:path or anchored local: source.",
  "",
].join("\n");

/** The exact bytes `ak build` writes, so "in sync" is a string comparison. */
export function renderAdaptations(rows: ReadonlyArray<Adaptation>): string {
  const sorted = [...rows].sort((a, b) => a.path.localeCompare(b.path) || a.source.localeCompare(b.source));
  const body = stringifyYaml({ adaptations: sorted.map((r) => r.row) }, { lineWidth: 0 });
  return `${GENERATED_HEADER}${body}`;
}

/** The generated file and its fragments drift the way dist/ drifts, and are reported the same way. */
export function checkAdaptationsSync(ctx: CheckContext): Issue[] {
  const { rows, issues: loadIssues, present } = loadAdaptationFragments(ctx.root);
  const issues = loadIssues.filter((i) => i.severity === "error");
  if (issues.length > 0) return issues; // Nothing coherent to render yet.

  const expected = renderAdaptations(rows);
  const actual = readTextIfPresent(join(ctx.root, ADAPTATIONS_FILE));

  if (actual === null) {
    if (!present && rows.length === 0) {
      return [
        note(
          "provenance.adaptations-not-generated",
          ADAPTATIONS_FILE,
          "Not generated yet. `ak build` writes it from the fragments; with no fragments it is the header and an empty list.",
        ),
      ];
    }
    return [
      error(
        "provenance.adaptations-out-of-sync",
        ADAPTATIONS_FILE,
        `${rows.length} row(s) in ${ADAPTATIONS_FRAGMENT_DIR}/ but no generated file. NOTICE points a downstream consumer at this path. Run \`ak build\`.`,
      ),
    ];
  }

  if (actual !== expected) {
    return [
      error(
        "provenance.adaptations-out-of-sync",
        ADAPTATIONS_FILE,
        `Does not match a merge of ${ADAPTATIONS_FRAGMENT_DIR}/. This file is generated: edit the fragment, then run \`ak build\`.`,
      ),
    ];
  }

  return [];
}

/**
 * Git tree-entry modes, which is what a donor path has to be checked against.
 *
 * The obvious check is `git cat-file -e <commit>:<path>`, and it was the check
 * here. It answers "does the pin contain an object at this path", which is not
 * the question a provenance row asks. `cat-file -t` is no better: git types a
 * symlink as a `blob`, so a row naming one resolves, types as a blob, and
 * records the ten bytes of a target path rather than the text anyone adapted.
 * That is a row that validates while recording nothing -- the same shape as a
 * row keyed on the wrong field, which AUTHORING.md:308 already warns about.
 *
 * Mode is the only field that separates the four cases in one call, so the
 * check reads it and the three rejections say three different things. The
 * citation checker in research/probes/dossier-citations.py keeps `-e` on
 * purpose: a dossier citation points a reader at material, and a directory or a
 * symlink is a fine thing to point a reader at. A row claims text was adapted
 * from one file, which only a file can be.
 */
const MODE_FILE = "100644";
const MODE_EXEC = "100755";
const MODE_SYMLINK = "120000";
const MODE_TREE = "040000";

/** How far a repair suggestion will chase links before giving up. */
const MAX_LINK_HOPS = 4;

function gitOut(root: string, donor: Donor, args: ReadonlyArray<string>): string | null {
  const result = spawnSync("git", ["-C", join(root, donor.path), ...args], { encoding: "utf8" });
  return result.status === 0 ? result.stdout : null;
}

/** The tree-entry mode of `path` at `commit`, or null when the pin has no entry there. */
function modeAtPin(root: string, donor: Donor, commit: string, path: string): string | null {
  const out = gitOut(root, donor, ["ls-tree", "--full-tree", "-z", commit, "--", path]);
  if (out === null) return null;
  for (const entry of out.split("\0")) {
    if (entry === "") continue;
    const tab = entry.indexOf("\t");
    if (tab === -1) continue;
    // A pathspec can match more than the literal path; take the entry that is it.
    if (entry.slice(tab + 1) !== path) continue;
    const mode = entry.slice(0, tab).split(" ")[0] ?? "";
    return mode === "" ? null : mode;
  }
  return null;
}

/** A symlink entry's target, as written in the blob. */
function symlinkTarget(root: string, donor: Donor, commit: string, path: string): string | null {
  const out = gitOut(root, donor, ["cat-file", "blob", `${commit}:${path}`]);
  return out === null ? null : out.trim();
}

/** `target` resolved against `fromDir`, or null when it escapes the tree or is absolute. */
function resolveRelative(fromDir: string, target: string): string | null {
  if (target.startsWith("/")) return null;
  const out: string[] = [];
  for (const part of [...fromDir.split("/"), ...target.split("/")]) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length === 0) return null;
      out.pop();
      continue;
    }
    out.push(part);
  }
  return out.length === 0 ? null : out.join("/");
}

/** `path` with its first symlinked component replaced by that link's target. */
function rewriteFirstLink(root: string, donor: Donor, commit: string, path: string): string | null {
  const parts = path.split("/").filter((p) => p.length > 0);
  for (let i = 0; i < parts.length; i += 1) {
    const prefix = parts.slice(0, i + 1).join("/");
    const mode = modeAtPin(root, donor, commit, prefix);
    if (mode === null) return null;
    if (mode !== MODE_SYMLINK) continue;
    const target = symlinkTarget(root, donor, commit, prefix);
    if (target === null) return null;
    const resolved = resolveRelative(parts.slice(0, i).join("/"), target);
    if (resolved === null) return null;
    const rest = parts.slice(i + 1);
    return rest.length === 0 ? resolved : `${resolved}/${rest.join("/")}`;
  }
  return null;
}

/**
 * The path that reaches the same file without crossing a symlink, or null.
 *
 * Verified at the pin before it is returned, and that is not belt-and-braces.
 * Both symlinked skill directories in the pinned donors were tested:
 * compound-engineering's `.agy/skills -> ../skills` resolves to a file that is
 * there, and its `.claude/skills -> ../.agents/skills` resolves to a path the
 * pin does not contain at all. One of the two real cases would have produced a
 * confident repair pointing at nothing, in an error message about a path that
 * points at nothing. So a suggestion is printed only when it resolves to a file,
 * and the plain rejection stands otherwise.
 */
function resolveThroughLinks(root: string, donor: Donor, commit: string, path: string): string | null {
  let current = path;
  for (let hop = 0; hop < MAX_LINK_HOPS; hop += 1) {
    const rewritten = rewriteFirstLink(root, donor, commit, current);
    if (rewritten === null) return null;
    const mode = modeAtPin(root, donor, commit, rewritten);
    if (mode === MODE_FILE || mode === MODE_EXEC) return rewritten;
    if (mode !== null && mode !== MODE_SYMLINK) return null;
    current = rewritten;
  }
  return null;
}

/** The rejection for a donor path that is not a file at its pin, or null when it is one. */
function checkPathAtPin(root: string, donor: Donor, parsed: DonorSource, row: Adaptation): Issue | null {
  const { donor: id, commit, path } = parsed;
  const at = `${id}@${commit}`;
  const mode = modeAtPin(root, donor, commit, path);
  if (mode === MODE_FILE || mode === MODE_EXEC) return null;

  const repair = resolveThroughLinks(root, donor, commit, path);

  if (mode === MODE_SYMLINK) {
    const suggestion = repair === null ? "" : ` Cite '${repair}', the file it points at.`;
    return error(
      "provenance.source-is-symlink",
      row.file,
      `'${path}' is a symlink at ${at}, not a file. Git types a symlink as a blob, so the row for '${row.path}' resolves and then records the target path rather than the text it claims was adapted: it validates while recording nothing.${suggestion}`,
    );
  }
  if (mode === MODE_TREE) {
    return error(
      "provenance.source-is-directory",
      row.file,
      `'${path}' is a directory at ${at}. A row records the one file its text was adapted from, and a directory names a set without saying which member. The row for '${row.path}' needs the file.`,
    );
  }
  const suggestion =
    repair === null ? "" : ` Cite '${repair}', which is the same file reached without crossing the link.`;
  return error(
    "provenance.source-not-at-pin",
    row.file,
    `'${path}' does not exist in ${id} at ${commit} (checked with git ls-tree in ${donor.path}). The row for '${row.path}' cites a path the pin does not contain.${suggestion}`,
  );
}

/**
 * Every numbered heading in the governing plan, as a set of section ids.
 *
 * Null when the plan is absent, which is a skip rather than a pass: a document
 * reference that resolves against nothing looks exactly like one that resolves.
 *
 * `research/probes/map-coverage.py` reads the same headings with the same regex
 * for a different question -- which sections no row claims. This is the other
 * half: whether a cited section exists at all. The probe is run by hand, so the
 * half that belongs in a gate is here.
 */
function planSections(root: string): Set<string> | null {
  const text = readTextIfPresent(join(root, PLAN));
  if (text === null) return null;
  const out = new Set<string>();
  for (const line of text.split("\n")) {
    const match = /^#{2,6}\s+(?:§\s*)?(\d+(?:\.\d+)*)[.\s)]+\S/.exec(line);
    if (match?.[1] !== undefined) out.add(match[1]);
  }
  return out;
}

function transcriptLineCount(root: string): number | null {
  const text = readTextIfPresent(join(root, TRANSCRIPT));
  if (text === null) return null;
  const lines = text.split("\n");
  return lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
}

/**
 * Every `local_sources:` entry checked against the file it names.
 *
 * WHAT THIS MAKES TRUE THAT WAS NOT
 * ---------------------------------
 * A `G:L` range is a position, and a position is evidence only about the content
 * it was taken against. Before this check, inserting a paragraph into the middle
 * of the transcript repointed all 99 later ranges, and every one still parsed,
 * still passed its bounds check against the new longer file, and still validated
 * clean while pointing at the wrong text. The instrument returned the same answer
 * whether the locators were right or wrong, so it was not evidence about them.
 * A digest converts that silent repoint into a loud failure.
 *
 * WHAT IT STILL DOES NOT SEE
 * --------------------------
 * Whether any locator points at the *right* part of an unmodified file. A range
 * cited against the wrong paragraph of a file that never changed passes here and
 * always will; this check knows the content is what the digest was taken against
 * and nothing about what any row claims to find in it.
 *
 * The line count is checked separately rather than treated as implied by the
 * digest. If the content matches and `lines` does not, the file is right and the
 * register misrecords it -- a defect in this block rather than in the tree, and
 * one the digest alone would report as clean.
 */
function checkLocalSources(root: string): Issue[] {
  const issues: Issue[] = [];
  const doc = readYaml(root, LOCK);
  if (doc === null || "error" in doc) return issues;

  for (const entry of listOf(doc.value, ["local_sources"])) {
    const id = typeof entry["id"] === "string" ? entry["id"] : "(unnamed)";
    const workingCopy = entry["working_copy"];
    if (typeof workingCopy !== "string") continue;

    const recordedHash = entry["sha256"];
    const recordedLines = entry["lines"];
    if (typeof recordedHash !== "string" || typeof recordedLines !== "number") {
      // An error rather than a warning, because an unanchored entry is the exact
      // state this check exists to end, and it reads as complete: the file is
      // registered, named and described, and only the two fields that make a
      // citation into it mean anything are absent.
      issues.push(
        error(
          "provenance.local-source-unanchored",
          LOCK,
          `Local source '${id}' names ${workingCopy} with no sha256 and lines. A citation into an unanchored file is a position with nothing behind it: the content can change under every reference to it and this run will not say so. Take the digest with 'shasum -a 256'. For 'lines', do not use 'wc -l': it counts newlines, so it undercounts a file with no trailing newline by one and would disagree with the bounds check this field underwrites. Record 0 and this check reports the count to use.`,
        ),
      );
      continue;
    }

    const text = readTextIfPresent(join(root, workingCopy));
    if (text === null) {
      issues.push(
        skipped(
          "provenance.local-source-unavailable",
          LOCK,
          "local source anchors",
          `Local source '${id}' names ${workingCopy}, which is not in the tree, so its digest went unverified. Rows citing it were range-checked against nothing.`,
        ),
      );
      continue;
    }

    const actualHash = createHash("sha256").update(text, "utf8").digest("hex");
    if (actualHash !== recordedHash) {
      issues.push(
        error(
          "provenance.local-source-modified",
          workingCopy,
          `${workingCopy} is not the file local source '${id}' was anchored to: recorded sha256 ${recordedHash.slice(0, 12)}, found ${actualHash.slice(0, 12)}. Every locator citing it now points into content it was not taken against. Restore the file, or re-derive the locators that cite it and update sha256 and lines in ${LOCK} in the same commit. Do not update the digest alone -- that silences the check without fixing what it found.`,
        ),
      );
      continue;
    }

    const lines = text.split("\n");
    const actualLines = lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
    if (actualLines !== recordedLines) {
      issues.push(
        error(
          "provenance.local-source-line-count",
          LOCK,
          `Local source '${id}' records ${recordedLines} lines and ${workingCopy} has ${actualLines}, while the digest matches. The file is the right one, so the register is wrong here rather than the tree; correct lines to ${actualLines}.`,
        ),
      );
    }
  }
  return issues;
}

function checkLocalAdaptation(
  row: Adaptation,
  parsed: LocalAdaptationSource,
  sources: ReadonlyMap<string, LocalSource>,
): Issue[] {
  const source = sources.get(parsed.id);
  if (source === undefined) {
    return [
      error(
        "provenance.unknown-local-source",
        row.file,
        `Source for '${row.path}' names local source '${parsed.id}', which ${LOCK} does not register.`,
      ),
    ];
  }

  const issues: Issue[] = [];
  if (parsed.sha256 !== source.sha256) {
    issues.push(
      error(
        "provenance.local-adaptation-digest-mismatch",
        row.file,
        `Source for '${row.path}' cites local source '${parsed.id}' at sha256 ${parsed.sha256.slice(0, 12)}, but ${LOCK} registers ${source.sha256.slice(0, 12)}. Copy the registered digest after confirming the cited range against ${source.workingCopy}.`,
      ),
    );
  }

  if (parsed.start !== null && parsed.end !== null && parsed.end > source.lines) {
    issues.push(
      error(
        "provenance.local-adaptation-range",
        row.file,
        `Source for '${row.path}' cites ${parsed.id}#L${parsed.start}-${parsed.end}, but ${source.workingCopy} has ${source.lines} lines. Re-read the report and cite an in-range passage; do not clamp the number mechanically.`,
      ),
    );
  }

  return issues;
}

/**
 * The numbered release scenarios in plan §10.
 *
 * Returns null rather than an empty set when the section yields nothing, because
 * the two are not the same claim. An empty set would make every scenario a map
 * row cites unknown, and this check would report forty confident errors naming
 * the wrong defect when what actually happened is that §10 moved.
 */
function planScenarios(root: string): Set<number> | null {
  const text = readTextIfPresent(join(root, PLAN));
  if (text === null) return null;
  const out = new Set<number>();
  let inside = false;
  for (const line of text.split("\n")) {
    if (/^#{2,6}\s+(?:§\s*)?10[.\s)]/.test(line)) {
      inside = true;
      continue;
    }
    if (!inside) continue;
    if (/^#{2,6}\s+(?:§\s*)?\d+(?:\.\d+)*[.\s)]/.test(line)) break;
    const match = /^\s*(\d+)\.\s+\S/.exec(line);
    if (match?.[1] !== undefined) out.add(Number(match[1]));
  }
  return out.size === 0 ? null : out;
}

/**
 * Scenario numbers the map cites, checked against the list plan §10 actually has.
 *
 * This gates the dangling number and nothing else. Whether the scenarios are
 * *covered* is reported by research/probes/scenario-coverage.py and does not
 * gate, because an uncovered scenario is a gap someone may be carrying on
 * purpose. A cited number that names no scenario is not a gap: it is a row
 * claiming coverage that cannot exist, and it reads as coverage to every human
 * reader and to every tally built by grepping this file.
 *
 * The map tags scenarios in prose rather than in a field, which is why nothing
 * constrained them before and why this is worth a gate at all: a schema would
 * have made `release scenario 25` impossible to write.
 */
function checkScenarioReferences(root: string, scenarios: Set<number> | null): Issue[] {
  const text = readTextIfPresent(join(root, CONVERSATION_MAP));
  if (text === null) return [];

  const cited: { value: number; line: number }[] = [];
  text.split("\n").forEach((line, index) => {
    for (const match of line.matchAll(/release scenarios?\s+([0-9][0-9,\s]*(?:and\s+\d+)?)/g)) {
      for (const digits of match[1]?.match(/\d+/g) ?? []) cited.push({ value: Number(digits), line: index + 1 });
    }
  });
  if (cited.length === 0) return [];

  if (scenarios === null) {
    return [
      skipped(
        "provenance.plan-scenarios-unavailable",
        CONVERSATION_MAP,
        "release scenario numbers",
        `${cited.length} scenario reference${cited.length === 1 ? "" : "s"} went unchecked: no numbered list was found under §10 of ${PLAN}. A reference to a scenario that does not exist reads exactly like one that does.`,
      ),
    ];
  }

  const known = [...scenarios].sort((a, b) => a - b);
  return cited
    .values()
    .filter((c) => !scenarios.has(c.value))
    .map((c) =>
      error(
        "provenance.unknown-scenario",
        CONVERSATION_MAP,
        `Release scenario ${c.value} is not one of the ${known.length} numbered in §10 of ${PLAN} (${known[0]}-${known[known.length - 1]}). A row naming a scenario that does not exist asserts coverage nothing can satisfy, and it counts as coverage in every tally taken from this file. Cite the scenario the capability actually tests, or drop the reference if it tests none.`,
        c.line,
      ),
    )
    .toArray();
}

/**
 * A section number inside a `rationale:`, with the token in front of it.
 *
 * Scoped to `§<number>`. "Section 5" and "the table above" are the same defect
 * in prose and this does not reach them; §8 states the rule and a reader is
 * what enforces it there. What this owns is the spelling that shipped.
 */
const RATIONALE_SECTION = /(?:(\S+)[ \t]+)?§\s*(\d+(?:\.\d+)*)/g;

/**
 * `plan` and `arch`, the same closed set `DOCUMENT_REFERENCE` accepts, read
 * through surrounding punctuation so a backticked or parenthesised name counts.
 */
function sectionAnchor(token: string | undefined): "plan" | "arch" | null {
  if (token === undefined) return null;
  const word = token.replace(/[^A-Za-z]/g, "").toLowerCase();
  return word === "plan" || word === "arch" ? word : null;
}

interface RationaleCitation {
  file: string;
  path: string;
  anchor: "plan" | "arch" | null;
  section: string;
  text: string;
}

/**
 * Every section reference in an adaptation `rationale:`, on both surfaces.
 *
 * The fragment is the write surface and the generated file is what `NOTICE`
 * points a downstream consumer at. The merge copies each row verbatim, so a
 * dangling reference exists in two files from the moment it is written, and
 * repairing the fragment leaves the published record still asserting it. Both
 * are read here rather than one, because a check that read only the write
 * surface would go green on a half-done repair -- which is the same shape as a
 * repair that parses as done.
 *
 * Only the `adaptations:` list. Keys beside it are dropped by the merge and
 * never reach the published record, so they are the sibling-key rule's subject
 * rather than this one's.
 */
function rationaleCitations(root: string, rows: ReadonlyArray<Adaptation>): RationaleCitation[] {
  const out: RationaleCitation[] = [];

  const add = (file: string, entry: Record<string, unknown>): void => {
    const rationale = entry["rationale"];
    if (typeof rationale !== "string") return;
    const path = typeof entry["path"] === "string" ? entry["path"] : "(no path)";
    for (const match of rationale.matchAll(RATIONALE_SECTION)) {
      out.push({ file, path, anchor: sectionAnchor(match[1]), section: match[2] ?? "", text: match[0].trim() });
    }
  };

  for (const row of rows) add(row.file, row.row);

  const generated = readYaml(root, ADAPTATIONS_FILE);
  if (generated !== null && !("error" in generated)) {
    for (const entry of listOf(generated.value, ["adaptations"])) add(ADAPTATIONS_FILE, entry);
  }

  return out;
}

/**
 * §5: a `rationale:` that cites a section names the document, or it cites
 * nothing.
 *
 * `per dossier §24.2` shipped into `provenance/adaptations.yaml` at `ae061b2`
 * and a reviewer caught it, not a check. It fails twice: it is a cross-document
 * positional reference, which the dossier renumbers out from under, and it names
 * no dossier at all, so a reader of the published record cannot tell which
 * document it was measured against.
 *
 * Anchoring is not resolution, and both halves are here. A named `plan §N` is
 * checked against the plan's own headings, because the reason §8 distrusts a
 * positional reference into a live document is precisely that it keeps parsing
 * after the document moves -- accepting the spelling without resolving it would
 * leave the second half of the defect in place while looking like a gate for it.
 *
 * WHAT THIS DOES NOT REACH
 *   A rationale that names one document and cites another's section. The
 *   citation resolves, the name is present, and only reading both settles it --
 *   §8's "a citation that resolves at the wrong authority is caught by nothing",
 *   which this is an instance of rather than an exception to.
 */
function checkAdaptationRationales(root: string, rows: ReadonlyArray<Adaptation>): Issue[] {
  const citations = rationaleCitations(root, rows);
  if (citations.length === 0) return [];

  const planIndex = planSections(root);
  const issues: Issue[] = [];
  let unresolved = 0;

  for (const citation of citations) {
    const { file, path, text, section } = citation;
    if (citation.anchor === null) {
      issues.push(
        error(
          "provenance.rationale-unanchored-section",
          file,
          `Rationale for '${path}' cites '${text}' without naming the document that section belongs to. A reader of the generated record cannot tell which document it was measured against, and the section renumbers without this row moving with it. Write 'plan §${section}' where it is the plan, or name the section rather than its position.`,
        ),
      );
      continue;
    }
    // Both keywords resolve against the same index because both name the same
    // file; `DOCUMENT_FILE` above is where that is decided, and a keyword that
    // ever named a second document would need its own index there rather than a
    // branch here.
    if (planIndex === null) {
      unresolved += 1;
      continue;
    }
    if (planIndex.has(section)) continue;
    issues.push(
      error(
        "provenance.rationale-section-unresolved",
        file,
        `Rationale for '${path}' cites '${text}', which is not a numbered section of ${PLAN}. A reference that parses is not a reference that resolves; if the section was renumbered, the row needs re-locating rather than the number nudging.`,
      ),
    );
  }

  if (unresolved > 0) {
    issues.push(
      skipped(
        "provenance.rationale-plan-unavailable",
        PLAN,
        "plan sections cited in rationales",
        `Plan absent; ${unresolved} section reference${unresolved === 1 ? "" : "s"} in adaptation rationales went unresolved. A reference to a section that does not exist reads the same as one that does.`,
      ),
    );
  }

  return issues;
}

export function checkProvenance(ctx: CheckContext): Issue[] {
  const { root } = ctx;
  const issues: Issue[] = [];

  const { donors, issues: donorIssues } = loadDonors(root);
  const localSources = loadLocalSourceRecords(root);
  issues.push(...donorIssues);
  issues.push(...checkLocalSources(root));
  issues.push(...checkScenarioReferences(root, planScenarios(root)));
  const { rows, issues: adaptationIssues } = loadAdaptationFragments(root);
  issues.push(...adaptationIssues);
  issues.push(...checkAdaptationsSync(ctx));
  issues.push(...checkAdaptationRationales(root, rows));

  const donorRows = rows.filter((row) => parseDonorSource(row.source) !== null);
  const donorsPresent = isDir(join(root, ".donors"));
  if (!donorsPresent && donorRows.length > 0) {
    issues.push(
      skipped(
        "provenance.donors-unavailable",
        ".donors",
        "donor paths at pin",
        `.donors/ is absent (gitignored and reproducible from upstream.lock.yaml). ${donorRows.length} donor row${donorRows.length === 1 ? "" : "s"} went unverified: no row's path was checked against the tree its pin names, so a row citing a path the pin does not contain reads exactly like one that checks out. Clone the donors and re-run before treating this run as provenance evidence.`,
      ),
    );
  }

  for (const row of rows) {
    if (row.source === "") {
      issues.push(
        error(
          "provenance.malformed-source",
          row.file,
          `Row for '${row.path}' has no source. Expected donor@commit:path or local:<id>@sha256:<digest>[#L<start>-<end>].`,
        ),
      );
      continue;
    }
    const local = parseLocalAdaptationSource(row.source);
    if (local !== null) {
      issues.push(...checkLocalAdaptation(row, local, localSources));
      continue;
    }
    const parsed = parseDonorSource(row.source);
    if (parsed === null) {
      issues.push(
        error(
          "provenance.malformed-source",
          row.file,
          `Source '${row.source}' for '${row.path}' is neither donor@commit:path nor local:<id>@sha256:<digest>[#L<start>-<end>].`,
        ),
      );
      continue;
    }
    const donor = donors.get(parsed.donor);
    if (donor === undefined) {
      issues.push(
        error(
          "provenance.unknown-donor",
          row.file,
          `Source for '${row.path}' names donor '${parsed.donor}', which ${LOCK} does not pin.`,
        ),
      );
      continue;
    }
    if (donor.commit !== "" && donor.commit !== parsed.commit) {
      issues.push(
        warning(
          "provenance.commit-not-pinned",
          row.file,
          `Source for '${row.path}' cites ${parsed.donor}@${parsed.commit} but ${LOCK} pins ${donor.commit}.`,
        ),
      );
    }
    if (!donorsPresent || !isDir(join(root, donor.path))) continue;
    const atPin = checkPathAtPin(root, donor, parsed, row);
    if (atPin !== null) issues.push(atPin);
  }

  issues.push(...checkEntryOrigins(ctx, donorRows));
  return issues;
}

/**
 * Dispositions that land a capability somewhere in the catalog.
 *
 * `excluded` is named in a source and deliberately not built, and `optional` is
 * recognised by the design but carried outside the engineering catalog; both
 * have a null destination by contract (conversation-map.yaml's own header). The
 * three below claim a home, so a row with one and no destination is a capability
 * the map can no longer prove landed anywhere.
 */
const DISPOSITIONS_THAT_LAND: ReadonlyArray<string> = ["retained", "folded", "reference"];

/**
 * Both directions between catalog.yaml and provenance/conversation-map.yaml.
 *
 * The map is capability-keyed, not entry-keyed: one row per capability named in
 * the design sources, each carrying a `destination` that points at the entry it
 * landed in. One capability lands in one destination and one destination may
 * carry several capabilities, so coverage is a many-to-many join through
 * `destination` -- never an id lookup, which would assume a file shape that
 * does not exist.
 */
function checkEntryOrigins(ctx: CheckContext, donorRows: ReadonlyArray<Adaptation>): Issue[] {
  const { root, catalog } = ctx;
  const issues: Issue[] = [];

  const mapDoc = readYaml(root, CONVERSATION_MAP);
  const mapRows =
    mapDoc !== null && !("error" in mapDoc) ? listOf(mapDoc.value, ["capabilities", "entries", "mechanisms"]) : [];
  if (mapDoc !== null && "error" in mapDoc) issues.push(mapDoc.error);
  const mapAvailable = mapDoc !== null;

  /**
   * Both of the next two report a check that did not run, and both are a skip only
   * when something existed for it to run on. The criterion is the subject, not the
   * absent file: an entry declaring conversation origin goes unchecked without the
   * map, and a locator goes unrange-checked without the transcript, but a tree with
   * neither has nothing unexamined and a skip term there is noise that teaches a
   * reader to stop reading the term.
   */
  const conversationEntries = DIRECTORY_SECTIONS.flatMap((section) =>
    catalog
      .bySection(section)
      .filter((entry) => entry.status === "authored" && entry.provenanceOrigin === "conversation"),
  ).length;
  if (!mapAvailable) {
    const message = `No conversation map; conversation-origin entries could not be checked.`;
    issues.push(
      conversationEntries > 0
        ? skipped(
            "provenance.conversation-map-unavailable",
            CONVERSATION_MAP,
            "conversation origins",
            `${message} ${conversationEntries} authored entr${conversationEntries === 1 ? "y declares" : "ies declare"} provenance_origin: conversation and nothing confirmed the capability is recorded.`,
          )
        : note(
            "provenance.conversation-map-unavailable",
            CONVERSATION_MAP,
            `${message} No authored entry declares it, so nothing went unexamined.`,
          ),
    );
  }

  const transcriptLines = transcriptLineCount(root);
  if (transcriptLines === null) {
    const message = "Transcript absent; G:L locator ranges could not be checked.";
    issues.push(
      mapRows.length > 0
        ? skipped(
            "provenance.transcript-unavailable",
            TRANSCRIPT,
            "G:L locator ranges",
            `${message} ${mapRows.length} capability row${mapRows.length === 1 ? "" : "s"} parsed; a range past the end of the transcript reads the same as one inside it.`,
          )
        : note(
            "provenance.transcript-unavailable",
            TRANSCRIPT,
            `${message} The map has no rows, so no range went unchecked.`,
          ),
    );
  }

  const planIndex = planSections(root);
  if (planIndex === null) {
    // Same criterion as the transcript above: the subject is the rows that cite a
    // section, not the absent file. A map with no document references has nothing
    // unexamined and a skip term there would be noise.
    const citing = mapRows.filter((row) => {
      const raw = row["locator"] ?? row["g_locator"] ?? row["gl"];
      return typeof raw === "string" && (parseLocatorField(raw) ?? []).some((r) => r.kind === "document");
    }).length;
    const message = "Plan absent; plan and arch section references could not be resolved.";
    issues.push(
      citing > 0
        ? skipped(
            "provenance.plan-unavailable",
            PLAN,
            "plan section references",
            `${message} ${citing} capability row${citing === 1 ? "" : "s"} cite${citing === 1 ? "s" : ""} a section, and a reference to a section that does not exist reads the same as one that does.`,
          )
        : note("provenance.plan-unavailable", PLAN, `${message} No row cites a section, so nothing went unresolved.`),
    );
  }

  // A destination may name any declared entry, file-backed sections included:
  // the map points at schemas, policies and adapters as readily as at skills.
  const owned = new Set(catalog.entries.map((entry) => `${entry.section}/${entry.id}`));

  /** destination -> the capability rows that landed there. */
  const byDestination = new Map<string, Record<string, unknown>[]>();

  for (const row of mapRows) {
    const id = typeof row["id"] === "string" && row["id"].length > 0 ? row["id"] : "(unnamed capability)";
    const disposition = typeof row["disposition"] === "string" ? row["disposition"] : "";
    const destination =
      typeof row["destination"] === "string" && row["destination"].length > 0 ? row["destination"] : null;

    if (destination === null) {
      if (DISPOSITIONS_THAT_LAND.includes(disposition)) {
        issues.push(
          warning(
            "provenance.capability-without-destination",
            CONVERSATION_MAP,
            `'${id}' is disposition: ${disposition} but names no destination. A capability that was kept lands in a declared entry; only excluded and optional rows have a null destination.`,
          ),
        );
      }
    } else {
      if (!owned.has(destination)) {
        issues.push(
          error(
            "provenance.destination-without-entry",
            CONVERSATION_MAP,
            `'${id}' lands in '${destination}', which catalog.yaml declares no entry for. Either the entry was renamed or removed without the map following, or the map points at something that was never declared.`,
          ),
        );
      }
      const prior = byDestination.get(destination);
      if (prior === undefined) byDestination.set(destination, [row]);
      else prior.push(row);
    }

    const origin = row["origin"];
    if (typeof origin !== "string" || !ORIGINS.includes(origin as (typeof ORIGINS)[number])) {
      issues.push(
        error(
          "provenance.unknown-origin",
          CONVERSATION_MAP,
          `'${id}' declares origin: ${origin === undefined ? "(absent)" : String(origin)}. Every capability says where it came from, and the value is one of ${ORIGINS.join(", ")}.`,
        ),
      );
    }

    if (
      (origin === "conversation" || origin === "amalgam") &&
      typeof row["source"] === "string" &&
      row["source"].length > 0
    ) {
      issues.push(
        error(
          "provenance.fabricated-source",
          CONVERSATION_MAP,
          `'${id}' has origin: ${origin} but carries a donor source '${row["source"]}'. A capability absent upstream carries a locator, never a source path.`,
        ),
      );
    }

    issues.push(...checkLocatorField(id, row, transcriptLines, planIndex));
    issues.push(...checkAmalgamOrigin(id, row, destination, owned));
  }

  for (const section of DIRECTORY_SECTIONS) {
    for (const entry of catalog.bySection(section)) {
      if (entry.status !== "authored") continue;
      const dir = entryDir(section, entry.id);

      if (entry.provenanceOrigin === "donor") {
        const covered = donorRows.some((r) => r.path === dir || r.path.startsWith(`${dir}/`));
        if (!covered) {
          issues.push(
            error(
              "provenance.missing-adaptation",
              dir,
              `${section}/${entry.id} declares provenance_origin: donor but no donor@commit:path row in ${ADAPTATIONS_FILE} covers a file under ${dir}/.`,
            ),
          );
        }
        continue;
      }

      if (entry.provenanceOrigin !== "conversation") continue;
      if (!mapAvailable) continue;

      const landed = byDestination.get(dir);
      if (landed === undefined) {
        issues.push(
          error(
            "provenance.missing-conversation-origin",
            CONVERSATION_MAP,
            `${section}/${entry.id} declares provenance_origin: conversation but no capability in ${CONVERSATION_MAP} has destination: ${dir}.`,
          ),
        );
        continue;
      }
      if (!landed.some((r) => r["origin"] === "conversation")) {
        // Named rather than assumed: with three origins in the map, "not conversation"
        // no longer implies "donor", and a message that guesses wrong sends the reader
        // to check something the row does not say.
        const found = [
          ...new Set(landed.map((r) => (typeof r["origin"] === "string" ? r["origin"] : "(absent)"))),
        ].sort();
        issues.push(
          error(
            "provenance.missing-conversation-origin",
            CONVERSATION_MAP,
            `${section}/${entry.id} declares provenance_origin: conversation but every capability landing in ${dir} is recorded as origin: ${found.join(", ")}. One of the two is wrong about where the capability came from.`,
          ),
        );
      }
    }
  }

  return issues;
}

/**
 * An `origin: amalgam` row against the seats it claims to sit between.
 *
 * Three things have to hold, and each corresponds to a way the row could be a
 * placeholder wearing a locator's clothes. The origin and the locator form must
 * agree, or `amalgam` becomes a label anything can carry. Both endpoints must be
 * declared, or the boundary is drawn against something that does not exist. And
 * the row must land on one of its own endpoints, because a boundary is owned by
 * the seats it separates -- a third party describing someone else's boundary is
 * how a rationale drifts out of reach of the thing it explains.
 *
 * Reciprocity is deliberately not required. Two of the first three rows are a
 * matched pair recorded from both sides, and the third is a single row resolving
 * a distinction that turned out not to be a counterpart family at all. Demanding
 * a partner row would force the writer to invent one.
 */
function checkAmalgamOrigin(
  id: string,
  row: Record<string, unknown>,
  destination: string | null,
  owned: ReadonlySet<string>,
): Issue[] {
  const raw = row["locator"];
  const references = typeof raw === "string" ? (parseLocatorField(raw) ?? []) : [];
  const pairs = references.filter((reference) => reference.kind === "amalgam");
  const isAmalgam = row["origin"] === "amalgam";

  if (!isAmalgam) {
    if (pairs.length === 0) return [];
    return [
      error(
        "provenance.amalgam-origin-mismatch",
        CONVERSATION_MAP,
        `'${id}' carries an amalgam locator but origin: ${String(row["origin"])}. A boundary between two seats is not in either donor and is not in the transcript; the origin has to say so.`,
      ),
    ];
  }

  if (pairs.length === 0) {
    return [
      error(
        "provenance.amalgam-origin-mismatch",
        CONVERSATION_MAP,
        `'${id}' has origin: amalgam but no 'amalgam <destination> + <destination>' reference in its locator. This origin exists to name the two seats whose pairing created the capability, and a row that names neither has recorded nothing.`,
      ),
    ];
  }

  const issues: Issue[] = [];
  for (const pair of pairs) {
    if (pair.kind !== "amalgam") continue;
    for (const endpoint of [pair.left, pair.right]) {
      if (owned.has(endpoint)) continue;
      issues.push(
        error(
          "provenance.amalgam-endpoint-unknown",
          CONVERSATION_MAP,
          `'${id}' draws a boundary against '${endpoint}', which catalog.yaml declares no entry for. An amalgam locator is only as good as its endpoints: if a seat was renamed or dropped, the capability between them needs re-deciding, not repointing.`,
        ),
      );
    }
    if (destination !== null && pair.left !== destination && pair.right !== destination) {
      issues.push(
        error(
          "provenance.amalgam-destination-outside-pair",
          CONVERSATION_MAP,
          `'${id}' lands in '${destination}' but sits between '${pair.left}' and '${pair.right}'. A boundary is recorded on a seat it separates, so the reader who opens that seat finds it.`,
        ),
      );
    }
  }
  return issues;
}

/** Every reference in a row's locator field, range-checked against the transcript. */
function checkLocatorField(
  id: string,
  row: Record<string, unknown>,
  transcriptLines: number | null,
  planIndex: Set<string> | null,
): Issue[] {
  const raw = row["locator"] ?? row["g_locator"] ?? row["gl"];
  if (typeof raw !== "string") {
    return [
      error(
        "provenance.g-locator-missing",
        CONVERSATION_MAP,
        `'${id}' carries no locator; every capability cites where it came from.`,
      ),
    ];
  }

  const references = parseLocatorField(raw);
  if (references === null) {
    return [
      error(
        "provenance.g-locator-invalid",
        CONVERSATION_MAP,
        `'${id}' has locator '${raw}', which is not a ';'-separated list of G:L<start>[-<end>] transcript ranges, 'plan §<section>' or 'arch §<section>' document references, and 'amalgam <destination> + <destination>' seat pairs.`,
      ),
    ];
  }

  const issues: Issue[] = [];
  for (const reference of references) {
    if (reference.kind === "transcript") {
      if (transcriptLines === null || reference.end <= transcriptLines) continue;
      issues.push(
        error(
          "provenance.g-locator-out-of-range",
          CONVERSATION_MAP,
          `'${id}' cites ${formatLocatorReference(reference)} but ${TRANSCRIPT} has ${transcriptLines} lines.`,
        ),
      );
      continue;
    }
    if (reference.kind !== "document") continue;
    // Both keywords resolve here because both name this file; DOCUMENT_FILE is
    // where that is decided rather than assumed.
    if (planIndex === null) continue;
    // `plan §9 (Milestone 7)` carries a parenthetical for the reader; the heading
    // it resolves against does not, so match on the number alone.
    const section = reference.section.replace(/\s*\([^()]*\)$/, "");
    if (planIndex.has(section)) continue;
    issues.push(
      error(
        "provenance.document-reference-unresolved",
        CONVERSATION_MAP,
        `'${id}' cites ${formatLocatorReference(reference)}, which is not a numbered section of ${DOCUMENT_FILE[reference.document]}. A reference that parses is not a reference that resolves; if the section was renumbered, the capability needs re-locating rather than the number nudging.`,
      ),
    );
  }
  return issues;
}
