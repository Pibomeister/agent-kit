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
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

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
    return { repo: remote.code === 0 && remote.text !== "" ? remote.text : project, revision: head.text, diff_hash: `sha256:${digest}` };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// ── gates and records ────────────────────────────────────────────────────────

/** The gates a phase records, in lifecycle order. */
export const GATES = ["build-checks", "verify", "review-full", "review-delta", "review-readiness", "ship-preflight"] as const;
export type Gate = (typeof GATES)[number];

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
  schema_version: 1;
  run_id: string;
  gate: Gate;
  snapshot: Snapshot;
  recorded_at: string;
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

/** A standalone run is named after its branch. A detached head has no name, and must be given one. */
export function defaultRunId(project: string): string | undefined {
  const branch = git(project, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (branch.code !== 0 || branch.text === "") return undefined;
  return safeRunId(branch.text);
}

export const safeRunId = (id: string): string => id.replace(/[^A-Za-z0-9._:-]/g, "-").slice(0, 128);

const atomicJson = (path: string, value: unknown): void => {
  mkdirSync(dirname(path), { recursive: true });
  const staging = `${path}.partial-${process.pid}`;
  writeFileSync(staging, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(staging, path);
};

const runRecordPath = (dir: string, run: string): string => join(dir, "runs", safeRunId(run), "run.json");
const branchPointerPath = (dir: string, branch: string): string => join(dir, "branches", `${safeRunId(branch)}.json`);

function readObject(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
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
  now?: () => Date;
  random?: () => string;
}

export function openRun(a: OpenArgs): { ok: true; run: RunRecord } | { ok: false; reason: string } {
  const branch = git(a.project, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (branch.code !== 0 || branch.text === "") return { ok: false, reason: `${a.project} is on a detached head` };
  const head = git(a.project, ["rev-parse", "HEAD"]);
  if (head.code !== 0 || head.text === "") return { ok: false, reason: `${a.project} has no committed revision` };

  let contents: string;
  let ticket: unknown;
  try {
    contents = readFileSync(a.ticket, "utf8");
    ticket = JSON.parse(contents);
  } catch (e) {
    return { ok: false, reason: `cannot read ticket ${a.ticket}: ${(e as Error).message}` };
  }
  const id = (ticket as { id?: unknown } | null)?.id;
  if (typeof id !== "string" || id.trim() === "") return { ok: false, reason: `ticket ${a.ticket} has no id` };

  const openedAt = (a.now ?? (() => new Date()))().toISOString();
  const ticketHash = `sha256:${createHash("sha256").update(contents).digest("hex")}`;
  const nonce = (a.random ?? (() => randomBytes(16).toString("hex")))();
  const suffix = createHash("sha256").update(JSON.stringify([id, ticketHash, head.text, openedAt, nonce])).digest("hex").slice(0, 12);
  const branchId = safeRunId(branch.text).slice(0, 128 - suffix.length - 1);
  const runId = `${branchId}-${suffix}`;
  const run: RunRecord = {
    run_id: runId,
    ticket: { id, hash: ticketHash },
    opened_at: openedAt,
    branch: branch.text,
    base: head.text,
  };
  atomicJson(runRecordPath(a.dir, runId), run);
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
  if (run === undefined || run.branch !== branch) return { error: `branch run pointer ${path} does not name an opened run for ${branch}` };
  return { run: pointer.run_id };
}

export interface RecordArgs {
  dir: string;
  run: string;
  gate: Gate;
  project: string;
  now?: () => Date;
}

export function recordGate(a: RecordArgs): { ok: true; path: string; record: GateRecord } | { ok: false; reason: string } {
  const snapshot = takeSnapshot(a.project);
  if (typeof snapshot === "string") return { ok: false, reason: snapshot };
  const record: GateRecord = {
    schema: "lifecycle-gate",
    schema_version: 1,
    run_id: a.run,
    gate: a.gate,
    snapshot,
    recorded_at: (a.now ?? (() => new Date()))().toISOString(),
  };
  // One file per gate and snapshot: re-recording the same state is idempotent, and a fix cycle adds a
  // record rather than replacing the one before it.
  const name = `${snapshot.revision}-${snapshot.diff_hash.replace(/^sha256:/, "").slice(0, 16)}.json`;
  const path = join(a.dir, safeRunId(a.run), a.gate, name);
  atomicJson(path, record);
  return { ok: true, path, record };
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
      g.run_id === run &&
      g.gate === gate &&
      typeof g.recorded_at === "string" &&
      typeof g.snapshot?.revision === "string" &&
      typeof g.snapshot?.diff_hash === "string"
    ) {
      out.push(g as GateRecord);
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
   * branch, which a reused branch would otherwise share with an old run; an explicit run id is unique.
   */
  forkBound?: boolean;
}

export interface CheckResult {
  ok: boolean;
  head?: Snapshot;
  refusals: string[];
  notes: string[];
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
  for (const branch of ["refs/remotes/origin/HEAD", "main", "master"]) {
    const ref = git(project, ["rev-parse", "--verify", "--quiet", `${branch}^{commit}`]);
    if (ref.code !== 0) continue;
    const name = branch === "main" || branch === "master" ? branch : git(project, ["symbolic-ref", "--quiet", "--short", branch]).text.replace(/^origin\//, "");
    if (current !== "" && current === name) return undefined;
    const base = git(project, ["merge-base", head, ref.text]);
    return base.code === 0 ? { branch, base: base.text } : undefined;
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
  const fork = a.forkBound === true && a.gates.some((g) => EARLIER.has(g)) ? forkPoint(a.project, head.revision) : undefined;

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
            `note: ${gate} for run ${a.run} was recorded before this branch last took ${fork.branch.replace(/^refs\/remotes\/origin\//, "")} (${fork.base.slice(0, 12)}); if this branch was reused for a new task, open a new run (known limit, gate.ts:5-8)`,
          );
        }
      }
      if (gate === "build-checks") continue;
      // review-full on an earlier head stands once a delta review covers the fix on this one.
      if (readRecords(a.dir, a.run, "review-delta").some((r) => same(r.snapshot, head))) continue;
      stale(gate, `the full review is for ${short(onLine[onLine.length - 1]!.snapshot)} and no review-delta covers ${short(head)}`);
      continue;
    }
    const latest = records[records.length - 1]!;
    stale(gate, `the latest record is for ${short(latest.snapshot)}, the head is ${short(head)}`);
  }
  return { ok: refusals.length === 0, head, refusals, notes: refusals.length === 0 ? notes : [] };
}

// ── the command ──────────────────────────────────────────────────────────────

export interface Io {
  out: (line: string) => void;
  err: (line: string) => void;
}

export const LIFECYCLE_USAGE = [
  "ak lifecycle — the gate records each lifecycle phase leaves, and the check super-ship runs first",
  "",
  "  ak lifecycle open --ticket <file> [--dir <dir>] [--project <dir>]",
  "  ak lifecycle record --gate <gate> [--run <id>] [--dir <dir>] [--project <dir>]",
  "  ak lifecycle check [--gates <g,g>] [--run <id>] [--dir <dir>] [--project <dir>] [--json]",
  "",
  `  gates: ${GATES.join(", ")}`,
  `  check defaults to the gates before ship: ${PRE_SHIP_GATES.join(", ")}`,
  "  --project defaults to the working directory, --run to its branch's opened run (else the branch), and --dir to",
  "  <git common dir>/agent-kit/evidence. Under Firstmate pass the binding's run id and evidence store.",
  "",
  "Exit 0 when the record was written or every gate is current, 1 when refused, 2 on bad usage.",
];

const FLAGS: Record<string, readonly string[]> = {
  open: ["ticket", "dir", "project"],
  record: ["gate", "run", "dir", "project"],
  check: ["gates", "run", "dir", "project", "json"],
};

export function main(argv: readonly string[], io: Io, cwd: string = process.cwd()): number {
  const sub = argv[0];
  if (sub === undefined || !(sub in FLAGS)) {
    if (sub !== undefined) io.err(`ak lifecycle: unknown subcommand ${sub}`);
    for (const line of LIFECYCLE_USAGE) io.err(line);
    return 2;
  }
  const allowed = new Set(FLAGS[sub]);
  const flags = new Map<string, string | true>();
  for (let i = 1; i < argv.length; i += 1) {
    const token = argv[i]!;
    const [name, inline] = token.startsWith("--") ? (token.slice(2).split("=", 2) as [string, string | undefined]) : ["", undefined];
    if (!allowed.has(name)) {
      io.err(`ak lifecycle ${sub}: unexpected ${token}`);
      return 2;
    }
    if (name === "json") {
      flags.set(name, true);
      continue;
    }
    const value = inline ?? argv[i + 1];
    if (value === undefined || (inline === undefined && value.startsWith("--"))) {
      io.err(`ak lifecycle ${sub}: --${name} needs a value`);
      return 2;
    }
    if (inline === undefined) i += 1;
    flags.set(name, value);
  }
  const str = (n: string) => {
    const v = flags.get(n);
    return typeof v === "string" ? v : undefined;
  };

  const project = resolve(cwd, str("project") ?? ".");
  let dir: string;
  try {
    dir = str("dir") !== undefined ? resolve(cwd, str("dir")!) : defaultEvidenceDir(project);
  } catch (e) {
    io.err(`ak lifecycle ${sub}: ${(e as Error).message}`);
    return 1;
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
      io.err(`ak lifecycle ${sub}: ${project} is on a detached head, so there is no branch to name the run; pass --run <id>`);
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

  if (sub === "record") {
    const gate = str("gate");
    if (gate === undefined || !isGate(gate)) {
      io.err(`ak lifecycle record: --gate must be one of ${GATES.join(", ")}`);
      return 2;
    }
    const opened = readRunRecord(dir, run);
    if (opened?.closed_at !== undefined) {
      io.err("ak lifecycle record: run closed; open a new run");
      return 1;
    }
    const r = recordGate({ dir, run, gate, project });
    if (!r.ok) {
      io.err(`ak lifecycle record: ${r.reason}`);
      return 1;
    }
    if (gate === "ship-preflight") closeRun(dir, run, r.record.recorded_at);
    io.out(`recorded ${gate} for run ${run} at ${short(r.record.snapshot)}: ${r.path}`);
    return 0;
  }

  const names = (str("gates") ?? PRE_SHIP_GATES.join(",")).split(",").filter((g) => g !== "");
  const unknown = names.filter((g) => !isGate(g));
  if (names.length === 0 || unknown.length > 0) {
    io.err(`ak lifecycle check: --gates takes ${GATES.join(", ")}${unknown.length > 0 ? `, not ${unknown.join(", ")}` : ""}`);
    return 2;
  }
  const result = checkGates({ dir, run, gates: names as Gate[], project, forkBound });
  if (result.ok) for (const note of result.notes) io.err(note);
  if (flags.get("json") === true) io.out(JSON.stringify({ run, dir, gates: names, ...result }, null, 2));
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
