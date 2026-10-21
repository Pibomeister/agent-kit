import { existsSync, mkdirSync, rmSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { artifactHash, canonicalJson, sha256Hex } from "../util/hash.ts";
import { closest } from "../util/suggest.ts";
import { checkRunArtifact, type RunArtifact } from "./artifacts.ts";
import type { ResolvedKb } from "./binding.ts";
import { git } from "./git.ts";
import { publishTrailRecord } from "./trail-publish.ts";

/**
 * The `local-git` backend (adapters/knowledgebase/backends/local-git.md): a
 * knowledgebase that is a git repository of files on this machine.
 *
 * It carries `readContext` and `publishArtifact` and nothing else. Reads come
 * from the committed tree, never the working files, so what a run reads is
 * what the knowledgebase's history holds; a publish is one commit touching one
 * file, read back from that commit before it is reported. The backend guide
 * §3 defines the storage layout.
 */

/** `common#/$defs/kb_kind`: the nine kinds, and no tenth (ADR-0001 §2). */
export const KB_KINDS = ["adr", "concept", "foundation", "gotcha", "pattern", "prd", "process", "sop", "system"];

/** The scope that means the whole project rather than one component of it. */
export const PROJECT_SCOPE = "project";

/** The one file under `projects/<project>/runs/` that holds the project's run artifacts, a record per line. */
const ARTIFACTS_FILE = "artifacts.jsonl";
const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const ARTIFACT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
/** Names the layout uses, which a scope segment may not reuse: a scope carrying one is a path. */
const RESERVED_SEGMENTS = new Set([...KB_KINDS, PROJECT_SCOPE, "projects", "documents", "runs"]);
const MAX_SCOPE_DEPTH = 8;
const LOCK_ATTEMPTS = 50;
const LOCK_WAIT_MS = 100;
const LOCK_STALE_MS = 120_000;

export interface KbRefusal {
  /** `refused` is a request this backend will not carry; `failed` is a knowledgebase that did not do what was asked. */
  status: "refused" | "failed";
  code: string;
  message: string;
}

export interface KbDocument {
  ref: string;
  kind: string;
  scope: string;
  id: string;
  title: string;
  status: string;
  /** Digest of the page as read, so evidence binds to what was actually read. */
  content_hash: string;
  /** The knowledgebase commit that last changed the page. */
  revision: string;
  body: string;
}

export interface ReadOutcome {
  status: "complete";
  knowledgebase: string;
  project: string;
  documents: KbDocument[];
  coverage: {
    kinds: string[];
    /** The scopes searched, most specific first. */
    scopes: string[];
    /** Committed pages that could not be read as records, named rather than dropped. */
    unreadable: string[];
    /** This backend returns pages only; run artifacts linked from them are not selected. */
    run_artifact_links: "not-selected";
  };
}

export interface PublishOutcome {
  status: "complete";
  ref: string;
  /** The stored digest, read back from the knowledgebase commit. */
  content_hash: string;
  /** The key the stored record carries, which a republish under another run does not change. */
  idempotency_key: string;
  /** The run the stored record was published under; null when a human published it outside any run. */
  run: string | null;
  /** The knowledgebase commit holding the record. */
  revision: string;
  /** `none` when the record was already there and nothing was written; `published` when a commit was made. */
  effect: "published" | "none";
}

export interface DocumentRequest {
  kind: string;
  scope: string;
  id: string;
  title: string;
  body: string;
  /** The run publishing it; null when a human publishes outside any run. */
  run: string | null;
}

interface DocumentMeta {
  ref: string;
  kind: string;
  scope: string;
  id: string;
  title: string;
  status: string;
  published_hash: string;
  idempotency_key: string;
  run: string | null;
}

interface StoredArtifact {
  record: { ref: string; content_hash: string; idempotency_key: string; links: string[] };
  artifact: RunArtifact;
}

type CommittedContent = { status: "found"; text: string } | { status: "absent" } | KbRefusal;
type CommittedRef = { status: "found" } | { status: "absent" } | KbRefusal;

const ajv = new Ajv2020({ strict: false });
const validMeta = ajv.compile<DocumentMeta>({
  type: "object",
  required: ["ref", "kind", "scope", "id", "title", "status", "published_hash", "idempotency_key", "run"],
  properties: {
    ref: { type: "string" },
    kind: { type: "string" },
    scope: { type: "string" },
    id: { type: "string" },
    title: { type: "string" },
    status: { type: "string" },
    published_hash: { type: "string" },
    idempotency_key: { type: "string" },
    run: { type: ["string", "null"] },
  },
});
const validStored = ajv.compile<StoredArtifact>({
  type: "object",
  required: ["record", "artifact"],
  properties: {
    artifact: { type: "object" },
    record: {
      type: "object",
      required: ["ref", "content_hash", "idempotency_key", "links"],
      properties: {
        ref: { type: "string" },
        content_hash: { type: "string" },
        idempotency_key: { type: "string" },
        links: { type: "array", items: { type: "string" } },
      },
    },
  },
});

function refused(code: string, message: string): KbRefusal {
  return { status: "refused", code, message };
}

function failed(code: string, message: string): KbRefusal {
  return { status: "failed", code, message };
}

/**
 * A scope as the segments it names, or null when it is not a scope. A scope is
 * a component, written as kebab-case words joined by `/`; `project` is the
 * whole project. Anything shaped like a location in the knowledgebase -- an
 * extension, a leading slash, a layout directory, a kind -- is a path the
 * caller computed, which ADR-0001 §7 leaves to the knowledgebase.
 */
function scopeSegments(scope: string): string[] | null {
  if (scope === PROJECT_SCOPE) return [];
  const segments = scope.split("/");
  if (segments.length > MAX_SCOPE_DEPTH) return null;
  return segments.every((segment) => KEBAB.test(segment) && !RESERVED_SEGMENTS.has(segment)) ? segments : null;
}

function scopeProblem(scope: string): KbRefusal {
  return refused(
    "kb.scope-is-a-path",
    `'${scope}' is not a scope. Pass the component as kebab-case words joined by '/', or '${PROJECT_SCOPE}' for the whole project; the knowledgebase resolves it to a location, and a path the caller computed is refused (ADR-0001 §7).`,
  );
}

/** ` (did you mean …?)` when a kind is close to the one given, else nothing. */
function nearKind(kind: string): string {
  const near = closest(kind, KB_KINDS);
  return near.length === 0 ? "" : ` (did you mean ${near.join(" or ")}?)`;
}

function kindProblem(kind: string): KbRefusal {
  return refused(
    "kb.kind-unknown",
    `'${kind}' is not a knowledgebase document kind${nearKind(kind)}. The nine are ${KB_KINDS.join(", ")}; there is no tenth (ADR-0001 §2).`,
  );
}

function documentPath(project: string, segments: readonly string[], kind: string, id: string): string {
  return ["projects", project, "documents", ...segments, kind, `${id}.md`].join("/");
}

function documentRef(scope: string, kind: string, id: string): string {
  return `doc:${scope}/${kind}/${id}`;
}

function artifactsPath(project: string): string {
  return ["projects", project, "runs", ARTIFACTS_FILE].join("/");
}

/**
 * The last record the artifacts file holds for `ref`, with its 1-based line,
 * or null when it holds none. A later line for a ref is a later copy of the
 * same record; a line that is not a record names no ref.
 */
function storedArtifact(text: string, ref: string): { line: number; value: StoredArtifact } | null {
  const lines = text.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const value = parseStored(lines[index] ?? "");
    if (value?.record.ref === ref) return { line: index + 1, value };
  }
  return null;
}

/** Whether a record ref names a committed record, absent when it is not a ref this backend issued. */
function refCommitted(root: string, project: string, ref: string): CommittedRef {
  if (ref.startsWith("doc:")) {
    const parts = ref.slice(4).split("/");
    const id = parts.at(-1) ?? "";
    const kind = parts.at(-2) ?? "";
    const segments = scopeSegments(parts.slice(0, -2).join("/"));
    if (parts.length < 3 || segments === null || !KB_KINDS.includes(kind) || !KEBAB.test(id)) {
      return { status: "absent" };
    }
    const content = committed(root, documentPath(project, segments, kind, id));
    return content.status === "found" ? { status: "found" } : content;
  }
  if (ref.startsWith("run:")) {
    const parts = ref.slice(4).split("/");
    if (parts.length !== 3 || !parts.every((part) => ARTIFACT_ID.test(part))) return { status: "absent" };
    const content = committed(root, artifactsPath(project));
    if (content.status !== "found") return content;
    return { status: storedArtifact(content.text, ref) !== null ? "found" : "absent" };
  }
  return { status: "absent" };
}

function documentHash(request: DocumentRequest): string {
  const subject = {
    kind: request.kind,
    scope: request.scope,
    id: request.id,
    title: request.title,
    body: request.body,
  };
  return `sha256:${sha256Hex(canonicalJson(subject))}`;
}

/** runner-contract §5: a pure function of the run, the operation, the record and the input digest. */
function idempotencyKey(run: string | null, ref: string, hash: string): string {
  return `sha256:${sha256Hex([run ?? "", "publishArtifact", ref, hash].join("\n"))}`;
}

/** The approvals an artifact carries, each canonical, in a stable order. */
function approvalsOf(artifact: RunArtifact): string[] {
  const approvals: unknown = artifact.approvals;
  return Array.isArray(approvals) ? [...new Set(approvals.map((approval) => canonicalJson(approval)))].toSorted() : [];
}

function headCommit(root: string): string | null {
  const head = git(root, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
  return head.status === 0 ? head.stdout.trim() : null;
}

/** The committed bytes at `path`, absent when not listed, or a failure when git cannot read them. */
function committed(root: string, path: string): CommittedContent {
  const listed = git(root, ["ls-tree", "-z", "HEAD", "--", path]);
  if (listed.status !== 0) return failed("kb.unreadable", `git could not locate ${path}: ${listed.stderr.trim()}`);
  if (listed.stdout === "") return { status: "absent" };
  const shown = git(root, ["show", `HEAD:${path}`]);
  return shown.status === 0
    ? { status: "found", text: shown.stdout }
    : failed("kb.unreadable", `git could not read ${path}: ${shown.stderr.trim()}`);
}

function normalizeBody(body: string): string {
  return `${body.replace(/\r+\n/g, "\n").replace(/^\n+/, "").replace(/\s+$/, "")}\n`;
}

function parseDocument(text: string): { meta: DocumentMeta; body: string } | null {
  if (!text.startsWith("---\n")) return null;
  const end = text.indexOf("\n---\n", 4);
  if (end === -1) return null;
  let value: unknown;
  try {
    value = parseYaml(text.slice(4, end));
  } catch {
    return null;
  }
  if (!validMeta(value)) return null;
  return { meta: value, body: normalizeBody(text.slice(end + 5)) };
}

function parseStored(text: string): StoredArtifact | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  return validStored(value) ? value : null;
}

function renderDocument(meta: DocumentMeta, body: string): string {
  return `---\n${stringifyYaml(meta)}---\n\n${body}`;
}

/**
 * Every scope the project's committed pages sit at, and every scope above one,
 * sorted. `project` is left out: it always resolves. The read path names these
 * when a scope it was given holds nothing, so a typo is not mistaken for a
 * component with no knowledge.
 */
export function committedScopes(kb: ResolvedKb): string[] {
  if (headCommit(kb.root) === null) return [];
  const base = ["projects", kb.binding.project, "documents"].join("/");
  const listed = git(kb.root, ["ls-tree", "-r", "-z", "--name-only", "HEAD", `${base}/`]);
  if (listed.status !== 0) return [];
  const scopes = new Set<string>();
  for (const path of listed.stdout.split("\0")) {
    if (!path.endsWith(".md")) continue;
    // <base>/<segment>…/<kind>/<id>.md: the segments between base and kind are the scope.
    const segments = path
      .slice(base.length + 1)
      .split("/")
      .slice(0, -2);
    for (let depth = 1; depth <= segments.length; depth += 1) scopes.add(segments.slice(0, depth).join("/"));
  }
  return [...scopes].toSorted();
}

/**
 * `readContext`: the committed pages of the given kinds at `scope` and at each
 * scope above it, most specific first. A project with no pages returns an
 * empty list, which is a fact and not an error.
 */
export function readContext(kb: ResolvedKb, kinds: readonly string[], scope: string): ReadOutcome | KbRefusal {
  const unknown = kinds.find((kind) => !KB_KINDS.includes(kind));
  if (unknown !== undefined) return kindProblem(unknown);
  const segments = scopeSegments(scope);
  if (segments === null) return scopeProblem(scope);
  const project = kb.binding.project;
  const scopes = Array.from({ length: segments.length + 1 }, (_, depth) => segments.slice(0, segments.length - depth));
  const outcome: ReadOutcome = {
    status: "complete",
    knowledgebase: kb.knowledgebase,
    project,
    documents: [],
    coverage: {
      kinds: [...kinds],
      scopes: scopes.map((at) => (at.length === 0 ? PROJECT_SCOPE : at.join("/"))),
      unreadable: [],
      run_artifact_links: "not-selected",
    },
  };
  if (headCommit(kb.root) === null) return outcome;
  for (const at of scopes) {
    for (const kind of kinds) {
      const dir = ["projects", project, "documents", ...at, kind].join("/");
      const listed = git(kb.root, ["ls-tree", "-z", "--name-only", "HEAD", `${dir}/`]);
      if (listed.status !== 0) return failed("kb.unreadable", `git could not list ${dir}: ${listed.stderr.trim()}`);
      for (const path of listed.stdout.split("\0").filter((name) => name.endsWith(".md"))) {
        const content = committed(kb.root, path);
        if (content.status !== "found" && content.status !== "absent") return content;
        const parsed = parseDocument(content.status === "found" ? content.text : "");
        if (parsed === null) {
          outcome.coverage.unreadable.push(path);
          continue;
        }
        const revision = git(kb.root, ["log", "-1", "--format=%H", "HEAD", "--", path]).stdout.trim();
        outcome.documents.push({
          ref: parsed.meta.ref,
          kind: parsed.meta.kind,
          scope: parsed.meta.scope,
          id: parsed.meta.id,
          title: parsed.meta.title,
          status: parsed.meta.status,
          content_hash: documentHash({ ...parsed.meta, body: parsed.body }),
          revision,
          body: parsed.body,
        });
      }
    }
  }
  return outcome;
}

interface RecordIdentity {
  ref: string;
  hash: string;
  key: string;
  links: readonly string[];
  /** The approvals sent, each canonical; empty when the request carries none. */
  approvals: readonly string[];
}

/** What a committed record says of itself. */
interface StoredRecord {
  /** The knowledgebase commit that wrote this copy of the record. */
  revision: () => string;
  /** The digest it was published with. */
  published: string;
  /** The digest recomputed from the committed bytes. */
  observed: string;
  key: string;
  run: string | null;
  links: readonly string[];
  approvals: readonly string[];
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Run `write` holding the knowledgebase's publish lock. Two runs publishing at
 * once are serialized here, by the knowledgebase and not by the callers
 * (CONTRACT.md §5); a lock nobody released within its stale window is taken.
 */
function withLock(root: string, write: () => PublishOutcome | KbRefusal): PublishOutcome | KbRefusal {
  const gitDir = git(root, ["rev-parse", "--absolute-git-dir"]).stdout.trim();
  const lock = join(gitDir, "ak-kb-publish.lock");
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
    try {
      mkdirSync(lock);
    } catch {
      if (existsSync(lock) && Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) rmSync(lock, { recursive: true });
      else sleep(LOCK_WAIT_MS);
      continue;
    }
    try {
      return write();
    } finally {
      rmdirSync(lock);
    }
  }
  return failed("kb.locked", "Another publish held the knowledgebase for too long. Nothing was written; retry.");
}

/** How one placement keeps its records in the file at `path`. */
interface RecordFile {
  path: string;
  /** The record's stored copy in the committed file: null when the file holds none, `unreadable` when it holds one that does not parse. */
  find: (text: string) => StoredRecord | "unreadable" | null;
  /** The whole file with this record written, given what is committed there now. */
  write: (text: string | null) => string;
}

/**
 * Write one record into its file, commit that file alone and read the record
 * back. `find` reads the record's stored copy. Its published digest is how an
 * unchanged republish becomes a no-op and a changed one a refusal
 * (runner-contract §5), and its links may not change either. Approvals are
 * outside the digest, so a republish that brings every approval the record
 * holds and at least one more commits a new stored copy. Every result reports what
 * the knowledgebase holds, not what was sent.
 */
function commitRecord(kb: ResolvedKb, store: RecordFile, identity: RecordIdentity): PublishOutcome | KbRefusal {
  return withLock(kb.root, () => {
    const path = store.path;
    const before = headCommit(kb.root);
    const content: CommittedContent = before === null ? { status: "absent" } : committed(kb.root, path);
    if (content.status !== "found" && content.status !== "absent") return content;
    const existing = content.status === "found" ? content.text : null;
    const file = join(kb.root, path);
    const uncommitted = failed(
      "kb.uncommitted-record",
      `${path} has uncommitted content in the knowledgebase checkout. Nothing was written over it; commit or remove it there first.`,
    );
    const stored = existing === null ? null : store.find(existing);
    if (stored !== null) {
      if (stored === "unreadable" || stored.published !== identity.hash) {
        return refused(
          "kb.changed-under-reused-record",
          `${identity.ref} is already published with a different digest (${stored === "unreadable" ? stored : stored.published}). A changed artifact under a reused record is refused rather than overwritten; publish the change as a new record that supersedes this one.`,
        );
      }
      const linked = [...new Set(stored.links)].toSorted();
      const wanted = [...new Set(identity.links)].toSorted();
      if (linked.join("\n") !== wanted.join("\n")) {
        return refused(
          "kb.changed-under-reused-record",
          `${identity.ref} is already published with other links (${linked.join(", ") || "none"}). A stored record's links are not rewritten; publish the linked artifact as a new record that supersedes this one.`,
        );
      }
      if (identity.approvals.every((approval) => stored.approvals.includes(approval))) {
        return {
          status: "complete",
          ref: identity.ref,
          content_hash: stored.published,
          idempotency_key: stored.key,
          run: stored.run,
          revision: stored.revision(),
          effect: "none",
        };
      }
      if (!stored.approvals.every((approval) => identity.approvals.includes(approval))) {
        return refused(
          "kb.changed-under-reused-record",
          `${identity.ref} is already published with approvals this copy does not carry. Stored approvals are added to, never replaced; republish the copy that holds every approval already stored.`,
        );
      }
    }
    if (
      existing === null ? existsSync(file) : git(kb.root, ["status", "--porcelain", "--", path]).stdout.trim() !== ""
    ) {
      return uncommitted;
    }
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, store.write(existing));
    const added = git(kb.root, ["add", "--", path]);
    const made =
      added.status === 0
        ? git(kb.root, [
            "commit",
            "-q",
            "-m",
            `kb(${kb.binding.project}): publish ${identity.ref}`,
            "-m",
            `Idempotency-Key: ${identity.key}`,
            "--",
            path,
          ])
        : added;
    if (made.status !== 0) {
      git(kb.root, ["reset", "-q", "--", path]);
      if (existing === null) rmSync(file, { force: true });
      else git(kb.root, ["checkout", "-q", "HEAD", "--", path]);
      return failed(
        "kb.commit-failed",
        `The knowledgebase did not take the record: ${made.stderr.trim().split("\n")[0] ?? "git failed"}`,
      );
    }
    const readBack = committed(kb.root, path);
    if (readBack.status !== "found" && readBack.status !== "absent") return readBack;
    const after = headCommit(kb.root);
    const written = readBack.status === "absent" ? null : store.find(readBack.text);
    if (
      written === null ||
      written === "unreadable" ||
      after === null ||
      after === before ||
      written.observed !== identity.hash ||
      written.approvals.join("\n") !== identity.approvals.join("\n")
    ) {
      return failed(
        "kb.read-back-mismatch",
        `${identity.ref} was written but its read-back does not match what was sent.`,
      );
    }
    return {
      status: "complete",
      ref: identity.ref,
      content_hash: written.observed,
      idempotency_key: written.key,
      run: written.run,
      revision: after,
      effect: "published",
    };
  });
}

/**
 * `publishArtifact` with a `kb-document` placement: one curated page of one of
 * the nine kinds, placed by scope. An `adr` is stored `proposed`; every other
 * kind is stored `unreviewed`. No request can say otherwise, because the
 * status is not a field of the request and a body may not carry its own
 * header: acceptance and review are a human's edit in the knowledgebase
 * (ADR-0001 §4).
 */
export function publishDocument(kb: ResolvedKb, request: DocumentRequest): PublishOutcome | KbRefusal {
  if (!KB_KINDS.includes(request.kind)) return kindProblem(request.kind);
  const segments = scopeSegments(request.scope);
  if (segments === null) return scopeProblem(request.scope);
  if (!KEBAB.test(request.id) || request.id.length > 64) {
    return refused("kb.id-invalid", `'${request.id}' is not a record id: lowercase words joined by single hyphens.`);
  }
  if (request.title.trim() === "" || request.title.includes("\n")) {
    return refused("kb.title-invalid", "A page needs a one-line title.");
  }
  if (request.run !== null && !ARTIFACT_ID.test(request.run)) {
    return refused("kb.run-invalid", `'${request.run}' is not a run id.`);
  }
  if (request.body.trim() === "") return refused("kb.body-empty", "A page with no body is not published.");
  if (/^\s*---\s*\n/.test(request.body)) {
    return refused(
      "kb.body-has-header",
      "The page body begins with a metadata header. The knowledgebase writes that header, status included, so a body that brings its own is refused.",
    );
  }
  const body = normalizeBody(request.body);
  const subject = { ...request, title: request.title.trim(), body };
  const ref = documentRef(request.scope, request.kind, request.id);
  const hash = documentHash(subject);
  const key = idempotencyKey(request.run, ref, hash);
  const meta: DocumentMeta = {
    ref,
    kind: request.kind,
    scope: request.scope,
    id: request.id,
    title: subject.title,
    status: request.kind === "adr" ? "proposed" : "unreviewed",
    published_hash: hash,
    idempotency_key: key,
    run: request.run,
  };
  const path = documentPath(kb.binding.project, segments, request.kind, request.id);
  const store: RecordFile = {
    path,
    find: (text) => {
      const parsed = parseDocument(text);
      if (parsed === null) return "unreadable";
      return {
        revision: () => git(kb.root, ["log", "-1", "--format=%H", "HEAD", "--", path]).stdout.trim(),
        published: parsed.meta.published_hash,
        observed: documentHash({ ...parsed.meta, body: parsed.body }),
        key: parsed.meta.idempotency_key,
        run: parsed.meta.run,
        links: [],
        approvals: [],
      };
    },
    write: () => renderDocument(meta, body),
  };
  return commitRecord(kb, store, { ref, hash, key, links: [], approvals: [] });
}

/**
 * `publishArtifact` with a `run-artifact` placement: one schema-bound record,
 * appended as one line to the project's artifacts file and linked from the
 * records in `links`. It is validated against its own schema before anything
 * is written, and a link that names no committed record is refused rather
 * than stored dangling.
 */
export function publishRunArtifact(
  kb: ResolvedKb,
  text: string,
  run: string,
  links: readonly string[],
  trailAttempts?: string,
): PublishOutcome | KbRefusal {
  if (!ARTIFACT_ID.test(run)) return refused("kb.run-invalid", `'${run}' is not a run id.`);
  const checked = checkRunArtifact(text);
  if (checked.artifact === null) {
    return refused("kb.artifact-invalid", `The artifact is refused before any write: ${checked.problem}.`);
  }
  const artifact = checked.artifact;
  const project = kb.binding.project;
  if (artifact.project.id !== project) {
    return refused(
      "kb.project-mismatch",
      `The artifact belongs to project '${artifact.project.id}' and this checkout is bound to '${project}'.`,
    );
  }
  if (artifact.run_id !== null && artifact.run_id !== run) {
    return refused("kb.run-mismatch", `The artifact names run '${artifact.run_id}', not '${run}'.`);
  }
  const head = headCommit(kb.root);
  for (const link of links) {
    const resolved: CommittedRef = head === null ? { status: "absent" } : refCommitted(kb.root, project, link);
    if (resolved.status !== "found" && resolved.status !== "absent") return resolved;
    if (resolved.status === "absent") {
      return refused(
        "kb.link-unresolved",
        `'${link}' names no record in the knowledgebase, so nothing can link from it.`,
      );
    }
  }
  const ref = `run:${run}/${artifact.schema}/${artifact.id}`;
  const hash = artifactHash(artifact);
  const key = idempotencyKey(run, ref, hash);
  const stored = { record: { ref, content_hash: hash, idempotency_key: key, links: [...links] }, artifact };
  const path = artifactsPath(project);
  const store: RecordFile = {
    path,
    find: (lines) => {
      const found = storedArtifact(lines, ref);
      if (found === null) return null;
      const { line, value } = found;
      return {
        revision: () => {
          const blamed = git(kb.root, ["blame", "--porcelain", "-L", `${line},${line}`, "HEAD", "--", path]);
          return blamed.stdout.split(" ")[0] ?? "";
        },
        published: value.record.content_hash,
        observed: artifactHash(value.artifact),
        key: value.record.idempotency_key,
        run,
        links: value.record.links,
        approvals: approvalsOf(value.artifact),
      };
    },
    write: (lines) => {
      const kept = lines === null || lines === "" || lines.endsWith("\n") ? (lines ?? "") : `${lines}\n`;
      return `${kept}${JSON.stringify(stored)}\n`;
    },
  };
  const publishArtifact = () => commitRecord(kb, store, { ref, hash, key, links, approvals: approvalsOf(artifact) });
  if (artifact.schema === "trail" || artifact.schema === "trail-audit") {
    if (trailAttempts === undefined) {
      return refused("kb.trail-attempts-required", "Trail and trail-audit publication needs --trail-attempts.");
    }
    return publishTrailRecord(trailAttempts, `${kb.knowledgebase}/${project}/${ref}`, publishArtifact);
  }
  if (trailAttempts !== undefined) {
    return refused("kb.trail-attempts-unexpected", "Only trail and trail-audit artifacts accept --trail-attempts.");
  }
  return publishArtifact();
}
