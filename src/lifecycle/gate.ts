/**
 * Lifecycle fidelity: each phase leaves a gate record bound to the snapshot it judged, and super-ship
 * refuses to start until every phase before it has one for the head it would ship.
 *
 * The strengthened standalone path opens a task-bound run and keeps a pointer from the branch to it.
 * The compatible v1 path still names a run after its branch. Its earlier records are bounded by the
 * fork point from the default branch, but after a squash or rebase merge a reused branch can keep old
 * `build-checks` and `review-full` records in its history. A successful check prints that known limit
 * when the record predates the branch last taking the default branch.
 *
 * An opened run has no fork-point bound and prints no note. A run never closed by `ship-preflight`
 * stays the branch's default until a new `open`, so every new task opens a new run.
 *
 * An opened run, or a check given `--evidence`, is also judged on evidence. `open` and
 * `record --gate verify --receipt` copy the ticket, each receipt and its captured output into
 * `<store>/<run>/artifacts/` by content hash, and the v2 `verify` record holds references to them, not
 * a verdict. The check re-hashes what the references name, judges it against the run's ticket and the
 * head, and appends its decision under `<store>/<run>/decisions/`. A v1 record stays readable as phase
 * history and never counts as evidence.
 *
 * This is core. It needs no Firstmate: a standalone session keeps its records under the repository's
 * git common directory, and a Firstmate worker passes the binding's evidence store and run id instead.
 *
 * The file imports only `node:` built-ins, because `ak build` type-strips it into each plugin bundle as
 * `bin/ak-gate.mjs`, where a session without this checkout runs it with `node`. `ak lifecycle` runs the
 * same `main` in place.
 */
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// ── the snapshot ─────────────────────────────────────────────────────────────

/**
 * The source snapshot a record binds to: the committed revision and the digest of the working-tree
 * diff over it (common#/$defs/revision_ref).
 *
 * Untracked files count as intent-to-add, as the definition says. They are marked on a temporary copy
 * of the index, so taking a snapshot never changes the project's own index.
 *
 * The copy keeps the index's mtime. Git trusts a file's cached stat only when the file is older than
 * the index; a copy stamped "now" would make a same-size edit made in the second of the last index
 * write look clean, and the snapshot would miss it.
 */
export interface Snapshot {
  repo: string;
  revision: string;
  diff_hash: string;
}

export interface GitResult {
  code: number;
  stdout: Uint8Array;
  text: string;
  stderr: string;
}

export function git(cwd: string, args: readonly string[], env?: Record<string, string>): GitResult {
  const proc = spawnSync("git", [...args], {
    cwd,
    env: env === undefined ? process.env : { ...process.env, ...env },
    maxBuffer: 1 << 30,
  });
  if (proc.error !== undefined) {
    return { code: -1, stdout: new Uint8Array(), text: "", stderr: `cannot run git in ${cwd}: ${proc.error.message}` };
  }
  const stdout = proc.stdout ?? new Uint8Array();
  return {
    code: proc.status ?? -1,
    stdout,
    text: new TextDecoder().decode(stdout).trim(),
    stderr: (proc.stderr ?? "").toString().trim(),
  };
}

export function takeSnapshot(project: string): Snapshot | string {
  const head = git(project, ["rev-parse", "HEAD"]);
  if (head.code !== 0 || !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(head.text)) {
    return `${project} has no committed revision: ${head.stderr || head.text}`;
  }
  const indexPath = git(project, ["rev-parse", "--git-path", "index"]);
  if (indexPath.code !== 0) return `cannot locate the index of ${project}`;
  const index = isAbsolute(indexPath.text) ? indexPath.text : join(project, indexPath.text);

  const scratch = mkdtempSync(join(tmpdir(), "ak-index-"));
  const temp = join(scratch, "index");
  try {
    if (existsSync(index)) {
      copyFileSync(index, temp);
      const { atime, mtime } = statSync(index);
      utimesSync(temp, atime, mtime);
    }
    const env = { GIT_INDEX_FILE: temp };
    const untracked = git(project, ["ls-files", "--others", "--exclude-standard", "-z"], env);
    if (untracked.code !== 0) return `cannot list untracked files in ${project}: ${untracked.stderr}`;
    const paths = untracked.text.split("\0").filter((p) => p !== "");
    if (paths.length > 0) {
      const add = git(project, ["add", "--intent-to-add", "--", ...paths], env);
      if (add.code !== 0) return `cannot mark untracked files in ${project}: ${add.stderr}`;
    }
    const diff = git(project, ["diff", "--no-ext-diff", "--binary", head.text], env);
    if (diff.code !== 0) return `cannot diff ${project} against ${head.text}: ${diff.stderr}`;
    const digest = createHash("sha256").update(diff.stdout).digest("hex");

    const remote = git(project, ["config", "--get", "remote.origin.url"]);
    return {
      repo: remote.code === 0 && remote.text !== "" ? remote.text : project,
      revision: head.text,
      diff_hash: `sha256:${digest}`,
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// ── gates and records ────────────────────────────────────────────────────────

/** The gates a phase records, in lifecycle order. */
export const GATES = [
  "build-checks",
  "verify",
  "review-full",
  "review-delta",
  "review-readiness",
  "ship-preflight",
] as const;
export type Gate = (typeof GATES)[number];
export const DELEGATION_CLASSES = ["green", "yellow-agent", "yellow-owner", "red"] as const;
export type DelegationClass = (typeof DELEGATION_CLASSES)[number];
export const AUTHOR_KINDS = ["human", "agent"] as const;
export type AuthorKind = (typeof AUTHOR_KINDS)[number];

const BUNDLED_ADAPTER_IDS: readonly string[] = [];

/** The ids a gate record's host may carry: the directories under `adapters/`, which `ak build` writes into the bundled copy. */
export function adapterIds(): readonly string[] {
  if (BUNDLED_ADAPTER_IDS.length > 0) return BUNDLED_ADAPTER_IDS;
  const at = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "adapters");
  if (!existsSync(at)) return [];
  return readdirSync(at, { withFileTypes: true })
    .flatMap((entry) => (entry.isDirectory() ? [entry.name] : []))
    .toSorted();
}

/** What super-ship checks before it starts: every phase before it. */
export const PRE_SHIP_GATES: readonly Gate[] = ["build-checks", "verify", "review-full", "review-readiness"];

/**
 * Gates judged once per run, before any fix cycle. A later fix moves the head, and the lifecycle
 * answers it with verify again and `review-delta`, not by rebuilding or re-running the full panel. So
 * these need a record on an ancestor of the head, not on the head itself; `review-full` is also current
 * when a `review-delta` record is.
 */
const EARLIER: ReadonlySet<Gate> = new Set<Gate>(["build-checks", "review-full"]);

export interface GateRecord {
  schema: "lifecycle-gate";
  schema_version: 1 | 2;
  run_id: string;
  gate: Gate;
  snapshot: Snapshot;
  recorded_at: string;
  class?: DelegationClass;
  implementer?: { author_kind: AuthorKind; host: string };
  evidence?: ArtifactRef[];
  /** Present when the phase was started under a bypass grant rather than a typed command (ADR-0008). */
  authority?: BypassAttribution;
}

export interface ArtifactRef {
  id: string;
  schema: "verification";
  hash: string;
}

export interface RunRecord {
  run_id: string;
  ticket: { id: string; hash: string };
  opened_at: string;
  branch: string;
  base: string;
  closed_at?: string;
}

const isGate = (g: string): g is Gate => (GATES as readonly string[]).includes(g);
const short = (s: Snapshot) => `${s.revision.slice(0, 12)}/${s.diff_hash.replace(/^sha256:/, "").slice(0, 12)}`;
const same = (a: Snapshot, b: Snapshot) => a.revision === b.revision && a.diff_hash === b.diff_hash;

/**
 * Where a standalone run keeps its records: under the git common directory, so every worktree of the
 * repository finds them and none is ever committed.
 */
export function defaultEvidenceDir(project: string): string {
  const common = git(project, ["rev-parse", "--git-common-dir"]);
  if (common.code !== 0 || common.text === "") throw new Error(`${project} is not a git checkout: ${common.stderr}`);
  const dir = isAbsolute(common.text) ? common.text : join(project, common.text);
  return join(dir, "agent-kit", "evidence");
}

export const safeRunId = (id: string): string => id.replace(/[^A-Za-z0-9._:-]/g, "-").slice(0, 128);

const atomicJson = (path: string, value: unknown): void => {
  mkdirSync(dirname(path), { recursive: true });
  const staging = `${path}.partial-${process.pid}`;
  writeFileSync(staging, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(staging, path);
};

const atomicBytes = (path: string, value: Uint8Array): void => {
  mkdirSync(dirname(path), { recursive: true });
  const staging = `${path}.partial-${process.pid}`;
  writeFileSync(staging, value);
  renameSync(staging, path);
};

const sha256 = (value: Uint8Array | string): string => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const hashHex = (hash: string): string | undefined => /^sha256:([0-9a-f]{64})$/.exec(hash)?.[1];
const artifactPath = (dir: string, run: string, hash: string): string | undefined => {
  const hex = hashHex(hash);
  return hex === undefined ? undefined : join(dir, safeRunId(run), "artifacts", hex);
};

function storeArtifact(dir: string, run: string, bytes: Uint8Array): string {
  const hash = sha256(bytes);
  const path = artifactPath(dir, run, hash)!;
  if (!existsSync(path) || sha256(readFileSync(path)) !== hash) atomicBytes(path, bytes);
  return hash;
}

/** The artifact hash form of common#/$defs/hash: keys sorted, no insignificant whitespace, `approvals` left out. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, member]) => member !== undefined)
    .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0));
  return `{${entries.map(([key, member]) => `${JSON.stringify(key)}:${canonicalJson(member)}`).join(",")}}`;
}

/** The receipt a reference names, while the store still holds it under that hash. */
function storedReceipt(dir: string, run: string, ref: ArtifactRef): Record<string, unknown> | undefined {
  const path = artifactPath(dir, run, ref.hash);
  if (path === undefined || !existsSync(path)) return undefined;
  const bytes = readFileSync(path);
  if (sha256(bytes) !== ref.hash) return undefined;
  try {
    return object(JSON.parse(new TextDecoder().decode(bytes)));
  } catch {
    return undefined;
  }
}

const boundTo = (receipt: Record<string, unknown>, snapshot: Snapshot): boolean => {
  const source = object(receipt.source_revision);
  return source?.revision === snapshot.revision && source?.diff_hash === snapshot.diff_hash;
};

/** Whether the store still holds this reference as a well-formed failed receipt at this snapshot, which no re-record replaces. */
function storedFailure(dir: string, run: string, ref: ArtifactRef, snapshot: Snapshot): boolean {
  const receipt = storedReceipt(dir, run, ref);
  return (
    receipt !== undefined &&
    receipt.status === "failed" &&
    boundTo(receipt, snapshot) &&
    verificationShapeReasons(receipt).length === 0
  );
}

const runRecordPath = (dir: string, run: string): string => join(dir, "runs", safeRunId(run), "run.json");
const branchPointerPath = (dir: string, branch: string): string =>
  join(dir, "branches", `${safeRunId(branch)}-${createHash("sha256").update(branch).digest("hex").slice(0, 12)}.json`);

function readObject(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function readRunRecord(dir: string, run: string): RunRecord | undefined {
  const value = readObject(runRecordPath(dir, run));
  if (
    value === undefined ||
    value.run_id !== run ||
    typeof value.opened_at !== "string" ||
    typeof value.branch !== "string" ||
    typeof value.base !== "string" ||
    value.ticket === null ||
    typeof value.ticket !== "object"
  ) {
    return undefined;
  }
  const ticket = value.ticket as Record<string, unknown>;
  if (typeof ticket.id !== "string" || typeof ticket.hash !== "string") return undefined;
  if (value.closed_at !== undefined && typeof value.closed_at !== "string") return undefined;
  return value as unknown as RunRecord;
}

export interface OpenArgs {
  dir: string;
  project: string;
  ticket: string;
}

export function openRun(a: OpenArgs): { ok: true; run: RunRecord } | { ok: false; reason: string } {
  const branch = git(a.project, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (branch.code !== 0 || branch.text === "") return { ok: false, reason: `${a.project} is on a detached head` };
  const head = git(a.project, ["rev-parse", "HEAD"]);
  if (head.code !== 0 || head.text === "") return { ok: false, reason: `${a.project} has no committed revision` };

  let ticket: unknown;
  try {
    ticket = JSON.parse(readFileSync(a.ticket, "utf8"));
  } catch (e) {
    return { ok: false, reason: `cannot read ticket ${a.ticket}: ${(e as Error).message}` };
  }
  const id = (ticket as { id?: unknown } | null)?.id;
  if (typeof id !== "string" || id.trim() === "") return { ok: false, reason: `ticket ${a.ticket} has no id` };

  const openedAt = new Date().toISOString();
  const canonical = new TextEncoder().encode(
    canonicalJson(
      Object.fromEntries(Object.entries(ticket as Record<string, unknown>).filter(([key]) => key !== "approvals")),
    ),
  );
  const ticketHash = sha256(canonical);
  const nonce = randomBytes(16).toString("hex");
  const suffix = createHash("sha256")
    .update(JSON.stringify([id, ticketHash, head.text, openedAt, nonce]))
    .digest("hex")
    .slice(0, 12);
  const branchId = safeRunId(branch.text)
    .replace(/^[^A-Za-z0-9]+/, "")
    .slice(0, 128 - suffix.length - 1);
  const runId = branchId === "" ? suffix : `${branchId}-${suffix}`;
  const run: RunRecord = {
    run_id: runId,
    ticket: { id, hash: ticketHash },
    opened_at: openedAt,
    branch: branch.text,
    base: head.text,
  };
  atomicJson(runRecordPath(a.dir, runId), run);
  storeArtifact(a.dir, runId, canonical);
  atomicJson(branchPointerPath(a.dir, branch.text), { run_id: runId });
  return { ok: true, run };
}

function closeRun(dir: string, run: string, closedAt: string): void {
  const record = readRunRecord(dir, run);
  if (record === undefined || record.closed_at !== undefined) return;
  atomicJson(runRecordPath(dir, run), { ...record, closed_at: closedAt });
}

function pointerRun(dir: string, branch: string): { run?: string; error?: string } {
  const path = branchPointerPath(dir, branch);
  if (!existsSync(path)) return {};
  const pointer = readObject(path);
  if (pointer === undefined || typeof pointer.run_id !== "string" || pointer.run_id === "") {
    return { error: `branch run pointer ${path} is not valid` };
  }
  const run = readRunRecord(dir, pointer.run_id);
  if (run === undefined) return { error: `branch run pointer ${path} does not name an opened run` };
  return run.branch === branch ? { run: pointer.run_id } : {};
}

export interface RecordArgs {
  dir: string;
  run: string;
  gate: Gate;
  project: string;
  receipts?: readonly string[];
  delegationClass?: DelegationClass;
  implementer?: { author_kind: AuthorKind; host: string };
  bypass?: BypassAttribution;
  now?: () => Date;
}

function implementerWellFormed(implementer: GateRecord["implementer"]): boolean {
  return (
    implementer === undefined ||
    (AUTHOR_KINDS.includes(implementer?.author_kind) && adapterIds().includes(implementer?.host))
  );
}

export function recordGate(
  a: RecordArgs,
): { ok: true; path: string; record: GateRecord; skipped: string[] } | { ok: false; reason: string } {
  if (!implementerWellFormed(a.implementer)) {
    return {
      ok: false,
      reason: `the implementer needs an author kind of human or agent and a host that is one of ${adapterIds().join(", ")}`,
    };
  }
  const snapshot = takeSnapshot(a.project);
  if (typeof snapshot === "string") return { ok: false, reason: snapshot };
  if ((a.receipts?.length ?? 0) > 0 && readRunRecord(a.dir, a.run) === undefined) {
    return {
      ok: false,
      reason: `run ${a.run} has no task-bound run record; open it with --ticket before recording receipts`,
    };
  }
  const refs: ArtifactRef[] = [];
  const skipped: string[] = [];
  for (const receiptPath of a.receipts ?? []) {
    let bytes: Uint8Array;
    let receipt: Record<string, unknown>;
    try {
      bytes = readFileSync(receiptPath);
      const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
        throw new Error("receipt is not an object");
      receipt = parsed as Record<string, unknown>;
    } catch (e) {
      return { ok: false, reason: `cannot read receipt ${receiptPath}: ${(e as Error).message}` };
    }
    if (receipt.schema !== "verification" || typeof receipt.id !== "string" || receipt.id === "") {
      return { ok: false, reason: `receipt ${receiptPath} must name schema verification and a non-empty id` };
    }
    if (!boundTo(receipt, snapshot)) {
      skipped.push(
        `receipt ${receiptPath} is bound to revision ${String(object(receipt.source_revision)?.revision)}, not ${short(snapshot)}; not recorded`,
      );
      continue;
    }
    const output = receipt.output_digest;
    if (typeof output === "string") {
      const log = (Array.isArray(receipt.artifacts) ? receipt.artifacts : [])
        .map(object)
        .flatMap((entry) =>
          entry !== undefined && entry.digest === output && typeof entry.path === "string"
            ? [resolve(dirname(receiptPath), entry.path), resolve(a.project, entry.path)]
            : [],
        )
        .filter((candidate) => existsSync(candidate) && statSync(candidate).isFile())
        .map((candidate) => readFileSync(candidate))
        .find((candidate) => sha256(candidate) === output);
      if (log === undefined) {
        return {
          ok: false,
          reason: `receipt ${receiptPath} names output ${output}, but none of its artifacts entries resolves to a log with that digest`,
        };
      }
      storeArtifact(a.dir, a.run, log);
    }
    refs.push({ id: receipt.id, schema: "verification", hash: storeArtifact(a.dir, a.run, bytes) });
  }

  const strengthenedVerify = a.gate === "verify" && (refs.length > 0 || readRunRecord(a.dir, a.run) !== undefined);
  const record: GateRecord = {
    schema: "lifecycle-gate",
    schema_version: strengthenedVerify ? 2 : 1,
    run_id: a.run,
    gate: a.gate,
    snapshot,
    recorded_at: (a.now ?? (() => new Date()))().toISOString(),
    ...(strengthenedVerify ? { evidence: refs } : {}),
  };
  // One file per gate and snapshot: re-recording the same state is idempotent, and a fix cycle adds a
  // record rather than replacing the one before it.
  const name = `${snapshot.revision}-${snapshot.diff_hash.replace(/^sha256:/, "").slice(0, 16)}.json`;
  const path = join(a.dir, safeRunId(a.run), a.gate, name);
  const previous = readObject(path) as Partial<GateRecord> | undefined;
  const recordedClass = a.delegationClass ?? DELEGATION_CLASSES.find((known) => known === previous?.class);
  const implementer =
    a.implementer ?? (implementerWellFormed(previous?.implementer) ? previous?.implementer : undefined);
  if (recordedClass !== undefined) record.class = recordedClass;
  if (implementer !== undefined) record.implementer = implementer;
  const authority = a.bypass ?? (bypassWellFormed(previous?.authority) ? previous?.authority : undefined);
  if (authority !== undefined) record.authority = authority;
  if (record.schema_version === 2 && previous?.schema_version === 2 && Array.isArray(previous.evidence)) {
    const recorded = new Set(refs.map((ref) => ref.id));
    const earlier = previous.evidence.filter((ref) => {
      const stored = storedReceipt(a.dir, a.run, ref);
      if (stored !== undefined && !boundTo(stored, snapshot)) return false;
      return !recorded.has(ref.id) || storedFailure(a.dir, a.run, ref, snapshot);
    });
    record.evidence = [...earlier, ...refs].filter(
      (ref, index, all) =>
        all.findIndex((candidate) => candidate.hash === ref.hash && candidate.id === ref.id) === index,
    );
  }
  atomicJson(path, record);
  return { ok: true, path, record, skipped };
}

/** Every well-formed record for this run and gate. A file that is not one is ignored, never trusted. */
export function readRecords(dir: string, run: string, gate: Gate): GateRecord[] {
  const at = join(dir, safeRunId(run), gate);
  if (!existsSync(at)) return [];
  const out: GateRecord[] = [];
  for (const name of readdirSync(at).sort()) {
    if (!name.endsWith(".json")) continue;
    let r: unknown;
    try {
      r = JSON.parse(readFileSync(join(at, name), "utf8"));
    } catch {
      continue;
    }
    const g = r as Partial<GateRecord> | null;
    if (
      g !== null &&
      typeof g === "object" &&
      g.schema === "lifecycle-gate" &&
      (g.schema_version === 1 || g.schema_version === 2) &&
      g.run_id === run &&
      g.gate === gate &&
      typeof g.recorded_at === "string" &&
      typeof g.snapshot?.revision === "string" &&
      typeof g.snapshot?.diff_hash === "string" &&
      (g.class === undefined || DELEGATION_CLASSES.includes(g.class)) &&
      implementerWellFormed(g.implementer) &&
      bypassWellFormed(g.authority)
    ) {
      const evidenceValid =
        g.schema_version === 1 ||
        (Array.isArray(g.evidence) &&
          g.evidence.every(
            (ref) =>
              ref !== null &&
              typeof ref === "object" &&
              ref.schema === "verification" &&
              typeof ref.id === "string" &&
              typeof ref.hash === "string" &&
              hashHex(ref.hash) !== undefined,
          ));
      if (evidenceValid) out.push(g as GateRecord);
    }
  }
  return out;
}

export interface CheckArgs {
  dir: string;
  run: string;
  gates: readonly Gate[];
  /** The checkout whose history answers "is this revision an ancestor of the head". */
  project: string;
  /**
   * The head the gates must be current for. Absent, the project's live snapshot: what super-ship is
   * about to ship. `status complete` passes the ship-preflight record's snapshot instead, because a
   * publish has moved the tree since.
   */
  head?: Snapshot;
  /**
   * Bound earlier records by the fork point from the default branch. Only for a run named after its
   * branch, which a reused branch would otherwise share with an old run; an explicit or opened run id
   * is unique.
   */
  forkBound?: boolean;
  /** Require receipt-backed verification. Opened runs enable this even when the caller omits it. */
  evidence?: boolean;
  now?: () => Date;
}

export interface DecisionReason {
  code: string;
  detail: string;
  criterion?: string;
  evidence?: string;
}

export interface DecisionRecord {
  run_id: string;
  transition: "ship";
  head: Snapshot;
  outcome: "allowed" | "refused" | "unavailable";
  reasons: DecisionReason[];
  inputs: { phase: string[]; evidence: ArtifactRef[] };
  trust: "worker-attested" | "collector-attested";
  decided_at: string;
}

export interface CheckResult {
  ok: boolean;
  head?: Snapshot;
  refusals: string[];
  notes: string[];
  decision?: DecisionRecord;
  decisionPath?: string;
}

const isAncestor = (project: string, older: string, newer: string): boolean =>
  older === newer || git(project, ["merge-base", "--is-ancestor", older, newer]).code === 0;

const EMPTY_DIFF = `sha256:${createHash("sha256").digest("hex")}`;

/**
 * Where this branch left the default branch (origin/HEAD, else main, else master): the merge-base of
 * the head with it. Undefined when none of them resolves, and when the default branch itself is checked
 * out, which has no fork point to bound by.
 */
function forkPoint(project: string, head: string): { branch: string; base: string } | undefined {
  const current = git(project, ["symbolic-ref", "--quiet", "--short", "HEAD"]).text;
  for (const key of ["refs/remotes/origin/HEAD", "main", "master"]) {
    const ref = git(project, ["rev-parse", "--verify", "--quiet", `${key}^{commit}`]);
    if (ref.code !== 0) continue;
    const name =
      key === "main" || key === "master"
        ? key
        : git(project, ["symbolic-ref", "--quiet", "--short", key]).text.replace(/^origin\//, "");
    if (current !== "" && current === name) return undefined;
    const base = git(project, ["merge-base", head, ref.text]);
    return base.code === 0 ? { branch: name === "" ? "origin/HEAD" : name, base: base.text } : undefined;
  }
  return undefined;
}

/**
 * An earlier record is on this branch's line when its revision is in the head's history and its
 * snapshot is not already on the default branch: a branch reused after a merge does not inherit the
 * old run's records. A record at the head's own revision always is.
 */
function onBranchLine(project: string, r: Snapshot, head: string, fork: { base: string } | undefined): boolean {
  if (r.revision === head) return true;
  if (!isAncestor(project, r.revision, head)) return false;
  if (fork === undefined) return true;
  if (r.revision === fork.base) return r.diff_hash !== EMPTY_DIFF;
  return !isAncestor(project, r.revision, fork.base);
}

const HASH = /^sha256:[0-9a-f]{64}$/;
const REVISION = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const ARTIFACT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const AC = /^AC-[0-9]+$/;
const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
const strings = (value: unknown): string[] | undefined =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value : undefined;
const nonempty = (value: unknown): value is string => typeof value === "string" && /\S/.test(value);

/** The schema-shape half of the bundled predicate. Cross-checked against ajv in lifecycle tests. */
export function verificationShapeReasons(value: unknown): string[] {
  const receipt = object(value);
  if (receipt === undefined) return ["receipt is not an object"];
  const reasons: string[] = [];
  const allowed = new Set([
    "schema",
    "schema_version",
    "id",
    "project",
    "run_id",
    "created_by",
    "inputs",
    "source_revision",
    "created_at",
    "updated_at",
    "status",
    "supersedes",
    "approvals",
    "tracker",
    "kind",
    "check",
    "command",
    "probe",
    "manual",
    "exit_status",
    "exit_disagreement",
    "output_digest",
    "output_excerpt",
    "artifacts",
    "environment",
    "supports",
    "ticket",
    "finding",
    "reason",
    "invalidation",
    "notes",
    "weakened_checks",
  ]);
  for (const key of Object.keys(receipt)) if (!allowed.has(key)) reasons.push(`unknown member ${key}`);
  const required = [
    "schema",
    "schema_version",
    "id",
    "project",
    "run_id",
    "created_by",
    "inputs",
    "source_revision",
    "created_at",
    "status",
    "kind",
    "environment",
    "supports",
  ];
  for (const key of required) if (!(key in receipt)) reasons.push(`missing ${key}`);
  if (receipt.schema !== "verification") reasons.push("schema is not verification");
  if (receipt.schema_version !== 1) reasons.push("schema_version is not 1");
  if (!nonempty(receipt.id) || !ARTIFACT_ID.test(receipt.id)) reasons.push("id is invalid");
  const project = object(receipt.project);
  if (project === undefined || !nonempty(project.id) || !KEBAB.test(project.id)) reasons.push("project is invalid");
  if (receipt.run_id !== null && (!nonempty(receipt.run_id) || !ARTIFACT_ID.test(receipt.run_id)))
    reasons.push("run_id is invalid");
  const creator = object(receipt.created_by);
  if (creator === undefined || !nonempty(creator.role)) reasons.push("created_by is invalid");
  const artifactRefValid = (candidate: unknown): boolean => {
    const ref = object(candidate);
    return (
      ref !== undefined &&
      nonempty(ref.id) &&
      ARTIFACT_ID.test(ref.id) &&
      typeof ref.hash === "string" &&
      HASH.test(ref.hash)
    );
  };
  if (!Array.isArray(receipt.inputs) || !receipt.inputs.every(artifactRefValid)) reasons.push("inputs is invalid");
  const revision = object(receipt.source_revision);
  if (
    revision === undefined ||
    !nonempty(revision.repo) ||
    typeof revision.revision !== "string" ||
    !REVISION.test(revision.revision)
  ) {
    reasons.push("source_revision is invalid");
  } else if (
    revision.diff_hash !== undefined &&
    (typeof revision.diff_hash !== "string" || !HASH.test(revision.diff_hash))
  ) {
    reasons.push("source_revision.diff_hash is invalid");
  }
  if (typeof receipt.created_at !== "string" || !Number.isFinite(Date.parse(receipt.created_at)))
    reasons.push("created_at is invalid");
  const statuses = ["passed", "failed", "not-run", "not-applicable", "inconclusive"];
  const kinds = ["command", "probe", "manual"];
  if (!statuses.includes(String(receipt.status))) reasons.push("status is invalid");
  if (!kinds.includes(String(receipt.kind))) reasons.push("kind is invalid");
  const supports = strings(receipt.supports);
  if (supports === undefined || supports.length === 0 || supports.some((id) => !AC.test(id)))
    reasons.push("supports is invalid");
  if (
    receipt.check !== undefined &&
    (typeof receipt.check !== "string" || receipt.check.length > 64 || !KEBAB.test(receipt.check))
  )
    reasons.push("check is invalid");
  if (receipt.ticket !== undefined && !artifactRefValid(receipt.ticket)) reasons.push("ticket is invalid");
  if (receipt.finding !== undefined && !artifactRefValid(receipt.finding)) reasons.push("finding is invalid");
  const environment = object(receipt.environment);
  if (
    environment === undefined ||
    typeof environment.id !== "string" ||
    !KEBAB.test(environment.id) ||
    typeof environment.isolated !== "boolean" ||
    !["none", "test-only", "production-approved"].includes(String(environment.secrets_policy))
  ) {
    reasons.push("environment is invalid");
  }
  const output = receipt.output_digest;
  if (
    ["passed", "failed", "inconclusive"].includes(String(receipt.status)) &&
    (typeof output !== "string" || !HASH.test(output))
  ) {
    reasons.push("output_digest is required for a check that ran");
  }
  if (receipt.kind === "command") {
    const command = object(receipt.command);
    if (
      command === undefined ||
      !Array.isArray(command.argv) ||
      command.argv.length === 0 ||
      !command.argv.every(nonempty)
    )
      reasons.push("command is invalid");
  }
  if (receipt.kind === "probe") {
    const probe = object(receipt.probe);
    if (probe === undefined || !nonempty(probe.name) || !nonempty(probe.target)) reasons.push("probe is invalid");
  }
  if (receipt.kind === "manual") {
    const manual = object(receipt.manual);
    if (manual === undefined || manual.performed_by !== "human" || !nonempty(manual.procedure))
      reasons.push("manual is invalid");
  }
  if (receipt.kind === "command" && receipt.status === "passed" && receipt.exit_status !== 0)
    reasons.push("passing command exit_status is not 0");
  if (receipt.kind === "command" && receipt.status === "failed") {
    if (!Number.isInteger(receipt.exit_status)) reasons.push("failed command has no integer exit_status");
    if (receipt.exit_status === 0) {
      const disagreement = object(receipt.exit_disagreement);
      if (
        disagreement === undefined ||
        disagreement.verdict_from !== "output" ||
        !nonempty(disagreement.output_reports)
      )
        reasons.push("zero-exit failure has no output disagreement");
    }
  }
  if (
    receipt.exit_disagreement !== undefined &&
    !(receipt.kind === "command" && receipt.status === "failed" && receipt.exit_status === 0)
  ) {
    reasons.push("exit_disagreement is inconsistent");
  }
  if (["not-run", "not-applicable"].includes(String(receipt.status))) {
    if (!nonempty(receipt.reason)) reasons.push("reason is required when nothing ran");
    if (receipt.exit_status !== undefined || receipt.output_digest !== undefined)
      reasons.push("unrun check carries execution evidence");
  }
  if (receipt.status === "inconclusive" && !nonempty(receipt.reason)) reasons.push("inconclusive check has no reason");
  return reasons;
}

function recordPath(dir: string, run: string, record: GateRecord): string {
  const name = `${record.snapshot.revision}-${record.snapshot.diff_hash.replace(/^sha256:/, "").slice(0, 16)}.json`;
  return join(dir, safeRunId(run), record.gate, name);
}

function evaluateEvidence(
  a: CheckArgs,
  head: Snapshot,
): { outcome: DecisionRecord["outcome"]; reasons: DecisionReason[]; refs: ArtifactRef[] } {
  const run = readRunRecord(a.dir, a.run);
  if (run === undefined)
    return {
      outcome: "unavailable",
      reasons: [{ code: "unavailable", detail: `run ${a.run} has no task-bound run record` }],
      refs: [],
    };
  const ticketPath = artifactPath(a.dir, a.run, run.ticket.hash);
  if (ticketPath === undefined || !existsSync(ticketPath)) {
    return {
      outcome: "unavailable",
      reasons: [{ code: "unavailable", detail: `ticket ${run.ticket.id} is absent from the run store` }],
      refs: [],
    };
  }
  const ticketBytes = readFileSync(ticketPath);
  if (sha256(ticketBytes) !== run.ticket.hash) {
    return {
      outcome: "unavailable",
      reasons: [{ code: "unavailable", detail: `ticket ${run.ticket.id} does not match ${run.ticket.hash}` }],
      refs: [],
    };
  }
  let ticket: Record<string, unknown>;
  try {
    ticket = JSON.parse(new TextDecoder().decode(ticketBytes)) as Record<string, unknown>;
  } catch {
    return {
      outcome: "unavailable",
      reasons: [{ code: "unavailable", detail: `ticket ${run.ticket.id} is malformed` }],
      refs: [],
    };
  }
  const criteria = (Array.isArray(ticket.acceptance_criteria) ? ticket.acceptance_criteria : [])
    .map(object)
    .map((criterion) => criterion?.id)
    .filter((id): id is string => typeof id === "string" && AC.test(id));
  const checks = new Set(
    (Array.isArray(ticket.verification) ? ticket.verification : [])
      .map(object)
      .map((check) => check?.id)
      .filter((id): id is string => typeof id === "string" && KEBAB.test(id)),
  );
  if (criteria.length === 0 || checks.size === 0) {
    return {
      outcome: "unavailable",
      reasons: [
        { code: "unavailable", detail: `ticket ${run.ticket.id} has no acceptance criteria or named verification` },
      ],
      refs: [],
    };
  }

  const current = readRecords(a.dir, a.run, "verify").filter(
    (record) => record.schema_version === 2 && same(record.snapshot, head),
  );
  const refs = current
    .flatMap((record) => record.evidence ?? [])
    .filter(
      (ref, index, all) =>
        all.findIndex((candidate) => candidate.id === ref.id && candidate.hash === ref.hash) === index,
    );
  const reasons: DecisionReason[] = [];
  const passed = new Set<string>();
  const failed = new Set<string>();
  if (refs.length === 0)
    reasons.push({ code: "missing", detail: "the current verify marker has no verification evidence references" });

  for (const ref of refs) {
    const path = artifactPath(a.dir, a.run, ref.hash);
    if (path === undefined || !existsSync(path)) {
      reasons.push({ code: "missing", detail: `receipt ${ref.id} is absent from the run store`, evidence: ref.id });
      continue;
    }
    const bytes = readFileSync(path);
    if (sha256(bytes) !== ref.hash) {
      reasons.push({
        code: "digest-mismatch",
        detail: `receipt ${ref.id} does not hash to ${ref.hash}`,
        evidence: ref.id,
      });
      continue;
    }
    let receipt: Record<string, unknown>;
    try {
      receipt = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
    } catch {
      reasons.push({ code: "malformed", detail: `receipt ${ref.id} is not JSON`, evidence: ref.id });
      continue;
    }
    if (receipt.schema_version !== 1) {
      reasons.push({
        code: "unsupported-version",
        detail: `receipt ${ref.id} has schema version ${String(receipt.schema_version)}`,
        evidence: ref.id,
      });
      continue;
    }
    const shape = verificationShapeReasons(receipt);
    if (shape.length > 0) {
      reasons.push({ code: "malformed", detail: `receipt ${ref.id}: ${shape.join("; ")}`, evidence: ref.id });
      continue;
    }
    if (receipt.id !== ref.id)
      reasons.push({
        code: "malformed",
        detail: `receipt ${ref.id} contains id ${String(receipt.id)}`,
        evidence: ref.id,
      });
    const before = reasons.length;
    if (receipt.run_id !== a.run)
      reasons.push({
        code: "wrong-run",
        detail: `receipt ${ref.id} is for run ${String(receipt.run_id)}, not ${a.run}`,
        evidence: ref.id,
      });
    if (!boundTo(receipt, head)) {
      reasons.push({
        code: "wrong-revision",
        detail: `receipt ${ref.id} does not name ${short(head)}`,
        evidence: ref.id,
      });
    }
    const task = object(receipt.ticket);
    if (
      task?.id !== run.ticket.id ||
      task?.hash !== run.ticket.hash ||
      (task?.schema !== undefined && task.schema !== "ticket")
    ) {
      reasons.push({
        code: "wrong-task",
        detail: `receipt ${ref.id} does not name ticket ${run.ticket.id} at ${run.ticket.hash}`,
        evidence: ref.id,
      });
    }
    const bound = reasons.length === before;
    if (receipt.invalidation !== undefined)
      reasons.push({ code: "invalidated", detail: `receipt ${ref.id} has been invalidated`, evidence: ref.id });
    const output = receipt.output_digest as string | undefined;
    if (output !== undefined) {
      const outputPath = artifactPath(a.dir, a.run, output);
      if (outputPath === undefined || !existsSync(outputPath) || sha256(readFileSync(outputPath)) !== output) {
        reasons.push({
          code: "output-missing",
          detail: `receipt ${ref.id} output ${output} is absent or changed`,
          evidence: ref.id,
        });
      }
    }
    if (typeof receipt.check !== "string" || !checks.has(receipt.check)) {
      reasons.push({
        code: "unknown-check",
        detail: `receipt ${ref.id} names unknown check ${String(receipt.check)}`,
        evidence: ref.id,
      });
    }
    const environment = object(receipt.environment)!;
    const expectedEnvironment = object((run as unknown as Record<string, unknown>).environment);
    if (!nonempty(environment.id) || (expectedEnvironment !== undefined && environment.id !== expectedEnvironment.id)) {
      reasons.push({
        code: "environment-mismatch",
        detail: `receipt ${ref.id} environment does not match the run`,
        evidence: ref.id,
      });
    }
    for (const criterion of bound ? (receipt.supports as string[]) : []) {
      if (receipt.status === "passed") passed.add(criterion);
      if (receipt.status === "failed") failed.add(criterion);
    }
  }
  for (const criterion of criteria) {
    if (failed.has(criterion) && passed.has(criterion))
      reasons.push({
        code: "unstable",
        detail: `${criterion} has both failed and passed evidence at this head`,
        criterion,
      });
    else if (failed.has(criterion))
      reasons.push({ code: "failed", detail: `${criterion} has failed evidence at this head`, criterion });
    else if (!passed.has(criterion))
      reasons.push({ code: "uncovered", detail: `${criterion} has no passed evidence at this head`, criterion });
  }
  return { outcome: reasons.length === 0 ? "allowed" : "refused", reasons, refs };
}

function writeDecision(a: CheckArgs, decision: DecisionRecord): string {
  const base = join(a.dir, safeRunId(a.run), "decisions", `${decision.decided_at}-ship`);
  let path = `${base}.json`;
  for (let suffix = 1; existsSync(path); suffix += 1) path = `${base}-${suffix}.json`;
  atomicJson(path, decision);
  return path;
}

export function checkGates(a: CheckArgs): CheckResult {
  let head = a.head;
  if (head === undefined) {
    const live = takeSnapshot(a.project);
    if (typeof live === "string") return { ok: false, refusals: [`refused: ${live}`], notes: [] };
    head = live;
  }
  const refusals: string[] = [];
  const notes: string[] = [];
  const stale = (g: Gate, why: string) => refusals.push(`refused: gate ${g} has no current evidence (${why})`);
  const fork =
    a.forkBound === true && a.gates.some((g) => EARLIER.has(g)) ? forkPoint(a.project, head.revision) : undefined;

  for (const gate of a.gates) {
    const records = readRecords(a.dir, a.run, gate).sort((x, y) => x.recorded_at.localeCompare(y.recorded_at));
    if (records.length === 0) {
      stale(gate, `no record for run ${a.run} in ${a.dir}`);
      continue;
    }
    if (records.some((r) => same(r.snapshot, head))) continue;

    if (EARLIER.has(gate)) {
      const onLine = records.filter((r) => onBranchLine(a.project, r.snapshot, head.revision, fork));
      if (onLine.length === 0) {
        const since = fork === undefined ? "" : ` since it left ${fork.branch} at ${fork.base.slice(0, 12)}`;
        stale(gate, `every record is for a revision that is not an ancestor of ${short(head)}${since}`);
        continue;
      }
      const counted = onLine[onLine.length - 1]!;
      if (a.forkBound === true && fork !== undefined) {
        const forkTime = git(a.project, ["show", "-s", "--format=%ct", fork.base]);
        const recorded = Date.parse(counted.recorded_at);
        if (forkTime.code === 0 && Number.isFinite(recorded) && Math.floor(recorded / 1000) <= Number(forkTime.text)) {
          notes.push(
            `note: ${gate} for run ${a.run} was recorded before this branch last took ${fork.branch} (${fork.base.slice(0, 12)}); if this branch was reused for a new task, open a new run`,
          );
        }
      }
      if (gate === "build-checks") continue;
      // review-full on an earlier head stands once a delta review covers the fix on this one.
      if (readRecords(a.dir, a.run, "review-delta").some((r) => same(r.snapshot, head))) continue;
      stale(
        gate,
        `the full review is for ${short(onLine[onLine.length - 1]!.snapshot)} and no review-delta covers ${short(head)}`,
      );
      continue;
    }
    const latest = records[records.length - 1]!;
    stale(gate, `the latest record is for ${short(latest.snapshot)}, the head is ${short(head)}`);
  }
  const currentVerify = readRecords(a.dir, a.run, "verify").filter((record) => same(record.snapshot, head));
  if (
    currentVerify.some((record) => record.schema_version === 1) &&
    !currentVerify.some((record) => record.schema_version === 2)
  ) {
    notes.push("note: v1 marker, no evidence references: history, not proof");
  }

  const strengthened = a.evidence === true || readRunRecord(a.dir, a.run) !== undefined;
  if (!strengthened) return { ok: refusals.length === 0, head, refusals, notes: refusals.length === 0 ? notes : [] };

  const judged = evaluateEvidence(a, head);
  const phaseReasons: DecisionReason[] = refusals.map((detail) => ({ code: "phase", detail }));
  for (const gate of PRE_SHIP_GATES) {
    if (!a.gates.includes(gate)) {
      const detail = `ship decision did not check required gate ${gate}`;
      phaseReasons.push({ code: "phase", detail });
      refusals.push(`refused: ${detail}`);
    }
  }
  const outcome = phaseReasons.length > 0 ? "refused" : judged.outcome;
  const reasons = [...phaseReasons, ...judged.reasons];
  const phase = a.gates.flatMap((gate) =>
    readRecords(a.dir, a.run, gate).map((record) => recordPath(a.dir, a.run, record)),
  );
  const decision: DecisionRecord = {
    run_id: a.run,
    transition: "ship",
    head,
    outcome,
    reasons,
    inputs: { phase, evidence: judged.refs },
    trust: "worker-attested",
    decided_at: (a.now ?? (() => new Date()))().toISOString(),
  };
  const decisionPath = writeDecision(a, decision);
  for (const reason of judged.reasons) refusals.push(`refused: evidence ${reason.code}: ${reason.detail}`);
  return {
    ok: outcome === "allowed",
    head,
    refusals,
    notes: outcome === "allowed" ? notes : [],
    decision,
    decisionPath,
  };
}

// ── the command ──────────────────────────────────────────────────────────────

// ── bypass ───────────────────────────────────────────────────────────────────

/**
 * A bypass grant (docs/decisions/0008-bypass-start-grant.md): a supervisor-held file that stands in for
 * the typed command of the lifecycle's human-started phases for one task, so a worker starts them
 * without a human typing each one. It starts phases and nothing else. Every approval inside a phase
 * still stops with needs-decision for the supervisor, and merge and deploy are never on it.
 *
 * The grant is only as strong as where it lives. `grant` refuses to write it inside the repository's
 * worktree or git directory and refuses to run from a checkout of that repository, and `check` refuses
 * a file that is not the one `grant` registered, by real path and sha256, in a ledger under the
 * account's home directory. A same-user process that runs `grant` from elsewhere still passes; that
 * boundary is the host's write isolation, not this file's.
 */
export const BYPASS_PHASES = [
  "super-align",
  "super-bound",
  "super-review:full",
  "super-review:readiness",
  "super-ship",
] as const;
export type BypassPhase = (typeof BYPASS_PHASES)[number];
const isBypassPhase = (p: string): p is BypassPhase => BYPASS_PHASES.some((phase) => phase === p);

/** The gates a bypassed phase leaves, and the phase each one needs the grant to cover. */
const BYPASS_GATE_PHASE: Partial<Record<Gate, BypassPhase>> = {
  "review-full": "super-review:full",
  "review-readiness": "super-review:readiness",
  "ship-preflight": "super-ship",
};

/** No grant may outlive a week, whatever `--hours` asks for. */
const BYPASS_MAX_HOURS = 168;

export interface BypassGrant {
  schema: "bypass-grant";
  schema_version: 1;
  grant_id: string;
  task_id: string;
  /** The real path of the git common directory of the repository the grant is for. */
  repo: string;
  authorized_by: string;
  reason: string;
  covers: BypassPhase[];
  /** Start only: who answers every approval inside a bypassed phase. */
  approvals: "supervisor";
  created_at: string;
  expires_at: string;
}

export interface BypassAttribution {
  mode: "bypass";
  grant_id: string;
  grant: string;
  grant_sha256: string;
  authorized_by: string;
  task_id: string;
}

interface BypassLedgerRecord {
  grant_id: string;
  grant_path: string;
  grant_sha256: string;
}

/** Resolved from the account's home directory, never from `HOME` or another variable a worker could set. */
export function defaultBypassLedger(): string {
  return join(userInfo().homedir, ".agent-kit", "bypass");
}

/** The real path, or for a file not written yet its real parent's, so `/var` and `/private/var` compare equal. */
const realOr = (path: string): string => {
  const at = resolve(path);
  if (existsSync(at)) return realpathSync(at);
  return dirname(at) === at ? at : join(realOr(dirname(at)), basename(at));
};
const within = (path: string, dir: string): boolean => {
  const rel = relative(dir, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

/** The repository's identity and the places a worker in it can write: its git directory and every worktree. */
function repoOf(project: string): { common: string; writable: string[] } | undefined {
  const common = git(project, ["rev-parse", "--git-common-dir"]);
  const trees = git(project, ["worktree", "list", "--porcelain"]);
  if (common.code !== 0 || trees.code !== 0 || common.text === "") return undefined;
  const real = realOr(isAbsolute(common.text) ? common.text : join(project, common.text));
  const worktrees = trees.text
    .split("\n")
    .flatMap((line) => (line.startsWith("worktree ") ? [realOr(line.slice(9))] : []));
  return { common: real, writable: [real, ...worktrees] };
}

/** A gate record is worker-written, so its attribution is a claim; the use record and the grant are what a reviewer checks. */
const bypassWellFormed = (authority: GateRecord["authority"]): boolean =>
  authority === undefined || authority?.mode === "bypass";

const refuse = (reason: string) => ({ ok: false as const, reason });

export interface BypassGrantArgs {
  task: string;
  project: string;
  by: string;
  reason: string;
  out: string;
  hours: number;
  /** Where `grant` is run from; a checkout of the granted repository is refused. */
  cwd: string;
  ledger: string;
  now?: () => Date;
}

export function grantBypass(
  a: BypassGrantArgs,
): { ok: true; grant: BypassGrant; path: string } | { ok: false; reason: string } {
  const no = refuse;
  if (a.task.trim() === "" || a.by.trim() === "" || a.reason.trim() === "")
    return no("--task, --by and --reason each need a non-empty value");
  if (!Number.isInteger(a.hours) || a.hours < 1 || a.hours > BYPASS_MAX_HOURS)
    return no(`--hours must be a whole number from 1 to ${BYPASS_MAX_HOURS}`);
  const repo = repoOf(a.project);
  if (repo === undefined) return no(`${a.project} is not a git checkout`);
  if (repoOf(a.cwd)?.common === repo.common)
    return no(
      `run it from outside the repository it grants: ${a.cwd} is a checkout of ${repo.common}, where a worker grants itself`,
    );
  const out = realOr(a.out);
  for (const dir of repo.writable)
    if (within(out, dir)) return no(`${a.out} is inside ${dir}, which a worker in that repository can write`);

  const now = (a.now ?? (() => new Date()))();
  const created = now.toISOString();
  const grant: BypassGrant = {
    schema: "bypass-grant",
    schema_version: 1,
    grant_id: `bypass-${safeRunId(a.task)}-${sha256(`${a.task}\n${repo.common}\n${created}`).slice(7, 19)}`.slice(
      0,
      128,
    ),
    task_id: a.task,
    repo: repo.common,
    authorized_by: a.by,
    reason: a.reason,
    covers: [...BYPASS_PHASES],
    approvals: "supervisor",
    created_at: created,
    expires_at: new Date(now.getTime() + a.hours * 3_600_000).toISOString(),
  };
  const text = `${JSON.stringify(grant, null, 2)}\n`;
  atomicBytes(out, new TextEncoder().encode(text));
  const ledgered: BypassLedgerRecord = {
    grant_id: grant.grant_id,
    grant_path: realpathSync(out),
    grant_sha256: sha256(text),
  };
  atomicJson(join(a.ledger, `${grant.grant_id}.json`), ledgered);
  return { ok: true, grant, path: realpathSync(out) };
}

export interface BypassCheckArgs {
  grant: string;
  /** The phase to start, or undefined to check only that the grant still holds. */
  phase?: string;
  project: string;
  ledger: string;
  now?: () => Date;
}

export function checkBypass(
  a: BypassCheckArgs,
): { ok: true; attribution: BypassAttribution } | { ok: false; reason: string } {
  const no = refuse;
  if (a.phase !== undefined && !isBypassPhase(a.phase))
    return no(
      `${a.phase} is not a phase a bypass grant starts; it starts only ${BYPASS_PHASES.join(", ")}. Approvals, merge and deploy stop with needs-decision for the supervisor`,
    );
  const path = resolve(a.grant);
  if (!existsSync(path)) return no(`bypass grant ${path} does not exist`);
  const g = readObject(path);
  if (g === undefined || g.schema !== "bypass-grant") return no(`bypass grant ${path} is not a bypass-grant record`);
  const id = String(g.grant_id);
  const entry = readObject(join(a.ledger, `${safeRunId(id)}.json`));
  if (entry === undefined) return no(`bypass grant ${id} was never registered in ${a.ledger}`);
  const at = realpathSync(path);
  const hash = sha256(readFileSync(path));
  if (entry.grant_path !== at)
    return no(`bypass grant ${path} is not the ${String(entry.grant_path)} that was registered`);
  if (entry.grant_sha256 !== hash)
    return no(`bypass grant ${path} hashes to ${hash}, not the ${String(entry.grant_sha256)} that was registered`);
  // From here the file is byte-for-byte the one `grantBypass` wrote and registered.
  const repo = repoOf(a.project);
  if (repo === undefined) return no(`${a.project} is not a git checkout`);
  if (g.repo !== repo.common) return no(`bypass grant ${id} is for ${String(g.repo)}, not ${repo.common}`);
  for (const dir of repo.writable)
    if (within(at, dir)) return no(`bypass grant ${path} is inside ${dir}, which the worker can write`);
  const expires = String(g.expires_at);
  if (!(Date.parse(expires) > (a.now ?? (() => new Date()))().getTime()))
    return no(`bypass grant ${id} expired at ${expires}`);
  if (a.phase !== undefined && !(Array.isArray(g.covers) && g.covers.includes(a.phase)))
    return no(`bypass grant ${id} does not cover ${a.phase}`);
  return {
    ok: true,
    attribution: {
      mode: "bypass",
      grant_id: id,
      grant: at,
      grant_sha256: hash,
      authorized_by: String(g.authorized_by),
      task_id: String(g.task_id),
    },
  };
}

/** The brief section a supervisor pastes into the task's brief: the one place the worker learns of the grant. */
export function bypassBrief(grant: BypassGrant, path: string): string {
  return [
    "## agent-kit bypass",
    "",
    `Bypass grant: \`${path}\`, authorized by ${grant.authorized_by} for task ${grant.task_id} until ${grant.expires_at}.`,
    "It stands in for the typed command of super-align, super-bound, super-review full and readiness, and",
    `super-ship. Before starting one, run \`ak lifecycle bypass check --grant ${path} --phase <phase>\` (or`,
    "`node <bundle>/bin/ak-gate.mjs bypass check …`); exit 0 is the start, anything else is a stop.",
    "It starts phases only. Every approval inside a phase stops with needs-decision for the supervisor;",
    "never approve your own design, spec, tickets or publish. Merge and deploy are never covered.",
    "Pass `--bypass <path>` when you record review-full, review-readiness or ship-preflight.",
  ].join("\n");
}

export interface Io {
  out: (line: string) => void;
  err: (line: string) => void;
}

export const LIFECYCLE_USAGE = [
  "ak lifecycle — the gate records each lifecycle phase leaves, and the check super-ship runs first",
  "",
  "  ak lifecycle open --ticket <file> [--dir <dir>] [--project <dir>]",
  "  ak lifecycle record --gate <gate> [--receipt <file> ...] [--class <class> --author-kind <kind> --host <id>] [--run <id>] [--dir <dir>] [--project <dir>]",
  "  ak lifecycle check [--evidence] [--gates <g,g>] [--run <id>] [--dir <dir>] [--project <dir>] [--json]",
  "  ak lifecycle bypass grant --task <id> --by <who> --reason <why> --out <file> --project <dir> [--hours <n>]",
  "  ak lifecycle bypass check --grant <file> [--phase <phase>] [--run <id>] [--dir <dir>] [--project <dir>]",
  "",
  `  gates: ${GATES.join(", ")}`,
  `  check defaults to the gates before ship: ${PRE_SHIP_GATES.join(", ")}`,
  "  --project defaults to the working directory, --run to its branch's opened run (else the branch), and --dir to",
  "  <git common dir>/agent-kit/evidence. Under Firstmate pass the binding's run id and evidence store.",
  `  bypass phases: ${BYPASS_PHASES.join(", ")}. A supervisor runs grant from outside the repository; the worker`,
  "  runs check before each phase and passes --bypass <file> to record. Start only: approvals still stop.",
  "  A receipt's captured output is read from its artifacts entry with that digest, relative to the receipt, else the project.",
  "",
  "Exit 0 when the record was written or every gate is current, 1 when refused, 2 on bad usage.",
];

const FLAGS: Record<string, readonly string[]> = {
  open: ["ticket", "dir", "project"],
  record: ["gate", "receipt", "class", "author-kind", "host", "bypass", "run", "dir", "project"],
  check: ["evidence", "gates", "run", "dir", "project", "json"],
  "bypass grant": ["task", "by", "reason", "out", "hours", "project"],
  "bypass check": ["grant", "phase", "run", "dir", "project"],
};

export function main(
  argv: readonly string[],
  io: Io,
  cwd: string = process.cwd(),
  bypassLedger: string = defaultBypassLedger(),
): number {
  const sub = argv[0] === "bypass" && argv[1] !== undefined ? `bypass ${argv[1]}` : argv[0];
  if (sub === undefined || !(sub in FLAGS)) {
    if (sub !== undefined) io.err(`ak lifecycle: unknown subcommand ${sub}`);
    for (const line of LIFECYCLE_USAGE) io.err(line);
    return 2;
  }
  const allowed = new Set(FLAGS[sub]);
  const flags = new Map<string, string | true>();
  const receipts: string[] = [];
  for (let i = sub.split(" ").length; i < argv.length; i += 1) {
    const token = argv[i]!;
    const [name, inline] = token.startsWith("--")
      ? (token.slice(2).split("=", 2) as [string, string | undefined])
      : ["", undefined];
    if (!allowed.has(name)) {
      io.err(`ak lifecycle ${sub}: unexpected ${token}`);
      return 2;
    }
    if (name === "json" || name === "evidence") {
      flags.set(name, true);
      continue;
    }
    const value = inline ?? argv[i + 1];
    if (value === undefined || (inline === undefined && value.startsWith("--"))) {
      io.err(`ak lifecycle ${sub}: --${name} needs a value`);
      return 2;
    }
    if (inline === undefined) i += 1;
    if (name === "receipt") receipts.push(value);
    else flags.set(name, value);
  }
  const str = (n: string) => {
    const v = flags.get(n);
    return typeof v === "string" ? v : undefined;
  };

  const project = resolve(cwd, str("project") ?? ".");
  let dir: string;
  try {
    dir =
      str("dir") !== undefined ? resolve(cwd, str("dir")!) : sub === "bypass grant" ? "" : defaultEvidenceDir(project);
  } catch (e) {
    io.err(`ak lifecycle ${sub}: ${(e as Error).message}`);
    return 1;
  }

  if (sub === "bypass grant") {
    const [task, by, reason, out] = ["task", "by", "reason", "out"].map(str);
    if (task === undefined || by === undefined || reason === undefined || out === undefined || !flags.has("project")) {
      io.err("ak lifecycle bypass grant: --task, --by, --reason, --out and --project are required");
      return 2;
    }
    const granted = grantBypass({
      task,
      project,
      by,
      reason,
      out: resolve(cwd, out),
      hours: Number(str("hours") ?? "24"),
      cwd,
      ledger: bypassLedger,
    });
    if (!granted.ok) {
      io.err(`ak lifecycle bypass grant: ${granted.reason}`);
      return 1;
    }
    io.out(bypassBrief(granted.grant, granted.path));
    return 0;
  }

  if (sub === "open") {
    const ticket = str("ticket");
    if (ticket === undefined) {
      io.err("ak lifecycle open: --ticket needs a value");
      return 2;
    }
    const opened = openRun({ dir, project, ticket: resolve(cwd, ticket) });
    if (!opened.ok) {
      io.err(`ak lifecycle open: ${opened.reason}`);
      return 1;
    }
    io.out(`opened run ${opened.run.run_id}`);
    return 0;
  }

  const explicitRun = str("run");
  let run = explicitRun;
  let forkBound = false;
  if (run === undefined) {
    const branch = git(project, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
    if (branch.code !== 0 || branch.text === "") {
      io.err(
        `ak lifecycle ${sub}: ${project} is on a detached head, so there is no branch to name the run; pass --run <id>`,
      );
      return 2;
    }
    const pointer = pointerRun(dir, branch.text);
    if (pointer.error !== undefined) {
      io.err(`ak lifecycle ${sub}: ${pointer.error}`);
      return 1;
    }
    run = pointer.run ?? safeRunId(branch.text);
    forkBound = pointer.run === undefined;
  }
  if (run === "") {
    io.err(`ak lifecycle ${sub}: --run needs a value`);
    return 2;
  }

  if (sub === "bypass check") {
    const grantPath = str("grant");
    if (grantPath === undefined) {
      io.err("ak lifecycle bypass check: --grant is required");
      return 2;
    }
    const phase = str("phase");
    const checked = checkBypass({ grant: resolve(cwd, grantPath), phase, project, ledger: bypassLedger });
    if (!checked.ok) {
      io.err(`ak lifecycle bypass check: refused: ${checked.reason}`);
      io.err("hint: stop and report needs-decision; the phase needs its typed command");
      return 1;
    }
    const used = { ...checked.attribution, phase: phase ?? null, run_id: run, checked_at: new Date().toISOString() };
    if (phase !== undefined) atomicJson(join(dir, safeRunId(run), "bypass", `${phase.replace(":", "-")}.json`), used);
    io.out(JSON.stringify(used, null, 2));
    return 0;
  }

  if (sub === "record") {
    const gate = str("gate");
    if (gate === undefined || !isGate(gate)) {
      io.err(`ak lifecycle record: --gate must be one of ${GATES.join(", ")}`);
      return 2;
    }
    const bypassPath = str("bypass");
    let bypass: BypassAttribution | undefined;
    if (bypassPath !== undefined) {
      const checked = checkBypass({
        grant: resolve(cwd, bypassPath),
        phase: BYPASS_GATE_PHASE[gate],
        project,
        ledger: bypassLedger,
      });
      if (!checked.ok) {
        io.err(`ak lifecycle record: refused: ${checked.reason}`);
        return 1;
      }
      bypass = checked.attribution;
    }
    if (receipts.length > 0 && gate !== "verify") {
      io.err("ak lifecycle record: --receipt is only valid with --gate verify");
      return 2;
    }
    const classFlag = str("class");
    const authorKindFlag = str("author-kind");
    const host = str("host");
    const identityMembers = [classFlag, authorKindFlag, host].filter((value) => value !== undefined).length;
    if (identityMembers !== 0 && identityMembers !== 3) {
      io.err("ak lifecycle record: --class, --author-kind, and --host must be supplied together");
      return 2;
    }
    const delegationClass = DELEGATION_CLASSES.find((known) => known === classFlag);
    if (classFlag !== undefined && delegationClass === undefined) {
      io.err(`ak lifecycle record: --class must be one of ${DELEGATION_CLASSES.join(", ")}`);
      return 2;
    }
    const authorKind = AUTHOR_KINDS.find((known) => known === authorKindFlag);
    if (authorKindFlag !== undefined && authorKind === undefined) {
      io.err(`ak lifecycle record: --author-kind must be one of ${AUTHOR_KINDS.join(", ")}`);
      return 2;
    }
    if (host !== undefined && !adapterIds().includes(host)) {
      io.err(`ak lifecycle record: --host must be one of ${adapterIds().join(", ")}`);
      return 2;
    }
    const opened = readRunRecord(dir, run);
    if (opened?.closed_at !== undefined) {
      const live = gate === "ship-preflight" ? takeSnapshot(project) : undefined;
      const closedHere =
        live !== undefined &&
        typeof live !== "string" &&
        readRecords(dir, run, "ship-preflight").some((r) => same(r.snapshot, live));
      if (!closedHere) {
        io.err("ak lifecycle record: run closed; open a new run");
        return 1;
      }
    }
    const implementer = authorKind !== undefined && host !== undefined ? { author_kind: authorKind, host } : undefined;
    const r = recordGate({
      dir,
      run,
      gate,
      project,
      receipts: receipts.map((path) => resolve(cwd, path)),
      delegationClass,
      implementer,
      bypass,
    });
    if (!r.ok) {
      io.err(`ak lifecycle record: ${r.reason}`);
      return 1;
    }
    if (gate === "ship-preflight") closeRun(dir, run, r.record.recorded_at);
    for (const line of r.skipped) io.err(`note: ${line}`);
    io.out(`recorded ${gate} for run ${run} at ${short(r.record.snapshot)}: ${r.path}`);
    return 0;
  }

  const names = (str("gates") ?? PRE_SHIP_GATES.join(",")).split(",").filter((g) => g !== "");
  const unknown = names.filter((g) => !isGate(g));
  if (names.length === 0 || unknown.length > 0) {
    io.err(
      `ak lifecycle check: --gates takes ${GATES.join(", ")}${unknown.length > 0 ? `, not ${unknown.join(", ")}` : ""}`,
    );
    return 2;
  }
  const result = checkGates({
    dir,
    run,
    gates: names as Gate[],
    project,
    forkBound,
    evidence: flags.get("evidence") === true,
  });
  if (result.ok) for (const note of result.notes) io.err(note);
  if (flags.get("json") === true)
    io.out(JSON.stringify(result.decision ?? { run, dir, gates: names, ...result }, null, 2));
  else if (result.ok) io.out(`ok: run ${run} has current evidence for ${names.join(", ")} at ${short(result.head!)}`);
  else for (const r of result.refusals) io.err(r);
  return result.ok ? 0 : 1;
}

/** Run as a script: `node bin/ak-gate.mjs <subcommand> …` from a bundle, or `bun src/lifecycle/gate.ts …`. */
function invokedDirectly(): boolean {
  const script = process.argv[1];
  if (script === undefined) return false;
  try {
    return pathToFileURL(realpathSync(script)).href === pathToFileURL(realpathSync(new URL(import.meta.url))).href;
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  process.exitCode = main(process.argv.slice(2), { out: (l) => console.log(l), err: (l) => console.error(l) });
}
