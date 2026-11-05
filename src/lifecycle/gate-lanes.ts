/**
 * Gate lanes: one lock per lane (worktree + branch), never one lock for every lane.
 *
 * Issue #194: a single global gate lock serialized seven lanes, committed work sat
 * unpublished for 80+ minutes, and reviews then targeted stale heads. This module is
 * the per-lane replacement lanes run through `ak lifecycle lanes …` (bundled as
 * `bin/ak-gate.mjs`, so it uses only `node:` built-ins):
 *
 * - Mutual exclusion holds *within* one lane: two gate runs for the same worktree
 *   and branch cannot overlap. Different lanes hold different locks and run at once.
 * - An optional bounded pool (`--pool <n>` / `AK_GATE_LANES_POOL`) caps how many
 *   lanes hold a gate at once; `0`/absent means no cap beyond the per-lane lock.
 *   The pool check and the lane claim are serialized by a short-lived claim mutex
 *   that is held only for the claim itself, never for the gate run.
 * - Queue visibility: a waiter registers itself before waiting, so `status` names
 *   every holder and waiter with lane, branch, worktree, pid and how long each has
 *   held or waited. No record is hidden state: all of it is files under the store.
 * - Stale recovery follows `src/learn/core/ledger.ts`: a lock carries its holder's
 *   pid; a lock whose pid is dead on this host is taken over by renaming it aside,
 *   never by deleting a path another process may have just claimed.
 * - `unpublished` reports the oldest commit on the current branch that no remote
 *   holds yet and alerts when its age exceeds a configurable limit
 *   (`--max-age-minutes <n>` / `AK_GATE_UNPUBLISHED_MAX_AGE_MINUTES`, default 30).
 *   It only reports: publication means entering the configured pipeline promptly,
 *   never bypassing it with a direct push from here.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";

export interface LaneIdentity {
  lane: string;
  branch: string;
  worktree: string;
}

export interface LaneHolder extends LaneIdentity {
  pid: number;
  host: string;
  acquired_at: string;
  label?: string;
}

export interface LaneWaiter extends LaneIdentity {
  pid: number;
  host: string;
  enqueued_at: string;
  label?: string;
}

export interface LaneStatus {
  holders: Array<LaneHolder & { held_ms: number }>;
  waiters: Array<LaneWaiter & { waiting_ms: number }>;
}

export interface AcquireOptions {
  pool?: number;
  timeoutMs?: number;
  pollMs?: number;
  label?: string;
  now?: () => number;
  pid?: number;
  host?: string;
  sleep?: (ms: number) => void;
  onWait?: (reason: string, waitedMs: number) => void;
}

export type AcquireResult =
  | { ok: true; holder: LaneHolder; waited_ms: number; release: () => void }
  | { ok: false; reason: string; holder?: LaneHolder; waited_ms: number };

const DEFAULT_POLL_MS = 250;
const UNPARSEABLE_GRACE_MS = 30_000;

/** The default unpublished-age limit in minutes, when neither flag nor env sets one. */
export const DEFAULT_UNPUBLISHED_MAX_AGE_MINUTES = 30;

function sha(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** A filesystem-safe lane key: readable branch slug plus a hash of worktree and branch. */
export function laneKey(identity: LaneIdentity): string {
  const slug = identity.branch
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `${slug === "" ? "lane" : slug}-${sha(`${identity.worktree}\n${identity.branch}\n${identity.lane}`).slice(0, 16)}`;
}

function isNonArrayObject(value: unknown): value is object {
  return !Array.isArray(value) && Object(value) === value;
}

/** A JSON string is the only parsed value equal to its own `String(...)` form. */
function isString(value: unknown): value is string {
  return value === String(value);
}

function isPid(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) > 0;
}

function errorCode(cause: unknown): string | undefined {
  if (isNonArrayObject(cause) && "code" in cause && isString(cause.code)) return cause.code;
  return undefined;
}

function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === "EPERM";
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isHolder(value: unknown): value is LaneHolder {
  if (!isNonArrayObject(value)) return false;
  if (
    !("lane" in value) ||
    !isString(value.lane) ||
    !("branch" in value) ||
    !isString(value.branch) ||
    !("worktree" in value) ||
    !isString(value.worktree) ||
    !("pid" in value) ||
    !isPid(value.pid) ||
    !("host" in value) ||
    !isString(value.host) ||
    !("acquired_at" in value) ||
    !isString(value.acquired_at)
  )
    return false;
  return !("label" in value) || isString(value.label);
}

function isWaiter(value: unknown): value is LaneWaiter {
  if (!isNonArrayObject(value)) return false;
  if (
    !("lane" in value) ||
    !isString(value.lane) ||
    !("branch" in value) ||
    !isString(value.branch) ||
    !("worktree" in value) ||
    !isString(value.worktree) ||
    !("pid" in value) ||
    !isPid(value.pid) ||
    !("host" in value) ||
    !isString(value.host) ||
    !("enqueued_at" in value) ||
    !isString(value.enqueued_at)
  )
    return false;
  return !("label" in value) || isString(value.label);
}

function readHolder(path: string): { value: LaneHolder; mtimeMs: number } | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isHolder(parsed) ? { value: parsed, mtimeMs: statSync(path).mtimeMs } : null;
  } catch {
    return null;
  }
}

function listHolders(dir: string): LaneHolder[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .flatMap((name) => {
      const read = readHolder(join(dir, name));
      return read === null ? [] : [read.value];
    });
}

function listWaiters(dir: string): LaneWaiter[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .flatMap((name) => {
      try {
        const parsed: unknown = JSON.parse(readFileSync(join(dir, name), "utf8"));
        return isWaiter(parsed) ? [parsed] : [];
      } catch {
        return [];
      }
    });
}

/**
 * Claim `path` for `record` exclusively. Returns false when a live holder stands.
 * A dead holder's record is renamed aside and re-checked before removal, so two
 * processes that both judge it stale cannot delete each other's fresh claim.
 */
function claim(path: string, record: LaneHolder, host: string): boolean {
  const own = `${path}.${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    writeFileSync(own, JSON.stringify(record));
    try {
      linkSync(own, path);
      return true;
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    }
  } finally {
    rmSync(own, { force: true });
  }
  const seen = readHolder(path);
  if (seen === null) return false;
  const staleHolder =
    seen.value.host === host && !alive(seen.value.pid)
      ? seen.value
      : Number.isNaN(Date.parse(seen.value.acquired_at)) && Date.now() - seen.mtimeMs >= UNPARSEABLE_GRACE_MS
        ? seen.value
        : undefined;
  if (staleHolder === undefined) return false;
  const aside = `${path}.stale-${process.pid}-${Date.now()}`;
  try {
    renameSync(path, aside);
  } catch {
    return false;
  }
  const moved = readHolder(aside);
  if (moved === null || moved.value.pid !== staleHolder.pid || moved.value.acquired_at !== staleHolder.acquired_at) {
    try {
      linkSync(aside, path);
    } catch {
      // Someone holds the path again; theirs stands.
    }
    rmSync(aside, { force: true });
    return false;
  }
  rmSync(aside, { force: true });
  try {
    writeFileSync(own, JSON.stringify(record));
    linkSync(own, path);
    return true;
  } catch {
    return false;
  } finally {
    rmSync(own, { force: true });
  }
}

/** The short-lived mutex that makes the pool count and the lane claim one step. */
function claimMutex(dir: string, record: LaneHolder): (() => void) | null {
  const path = join(dir, "claim.lock.json");
  if (!claim(path, record, record.host)) return null;
  return () => rmSync(path, { force: true });
}

export function holdersDir(dir: string): string {
  return join(dir, "holders");
}

export function waitersDir(dir: string): string {
  return join(dir, "waiters");
}

/** Remove holder records whose pid is dead on this host, verified by rename-aside like `claim`. */
function pruneStaleHolders(dir: string, host: string): void {
  const holders = holdersDir(dir);
  if (!existsSync(holders)) return;
  for (const name of readdirSync(holders)) {
    if (!name.endsWith(".json")) continue;
    const path = join(holders, name);
    const seen = readHolder(path);
    if (seen === null || seen.value.host !== host || alive(seen.value.pid)) continue;
    const aside = `${path}.stale-${process.pid}-${Date.now()}`;
    try {
      renameSync(path, aside);
    } catch {
      continue;
    }
    const moved = readHolder(aside);
    if (moved !== null && moved.value.pid === seen.value.pid && moved.value.acquired_at === seen.value.acquired_at) {
      rmSync(aside, { force: true });
    } else {
      try {
        linkSync(aside, path);
      } catch {
        // Someone holds the path again; theirs stands.
      }
      rmSync(aside, { force: true });
    }
  }
}

export function readHolders(dir: string): LaneHolder[] {
  return listHolders(holdersDir(dir)).toSorted((a, b) => a.acquired_at.localeCompare(b.acquired_at));
}

export function readWaiters(dir: string): LaneWaiter[] {
  return listWaiters(waitersDir(dir)).toSorted((a, b) => a.enqueued_at.localeCompare(b.enqueued_at));
}

/** Who holds, who waits, and for how long, at `nowMs`. */
export function laneStatus(dir: string, nowMs: number, host: string = hostname()): LaneStatus {
  const live = (record: { pid: number; host: string }) => record.host !== host || alive(record.pid);
  return {
    holders: readHolders(dir)
      .filter(live)
      .map((holder) => ({
        ...holder,
        held_ms: Math.max(0, nowMs - Date.parse(holder.acquired_at)),
      })),
    waiters: readWaiters(dir)
      .filter(live)
      .map((waiter) => ({
        ...waiter,
        waiting_ms: Math.max(0, nowMs - Date.parse(waiter.enqueued_at)),
      })),
  };
}

/**
 * Take this lane's gate lock, waiting in the visible queue until `timeoutMs`.
 * Distinct lanes never block each other unless the bounded pool is full.
 */
export function acquireLane(dir: string, identity: LaneIdentity, options: AcquireOptions = {}): AcquireResult {
  const now = options.now ?? Date.now;
  const pid = options.pid ?? process.pid;
  const host = options.host ?? hostname();
  const sleep = options.sleep ?? sleepSync;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const timeoutMs = options.timeoutMs ?? 0;
  const started = now();
  mkdirSync(holdersDir(dir), { recursive: true });
  mkdirSync(waitersDir(dir), { recursive: true });
  const key = laneKey(identity);
  const holderPath = join(holdersDir(dir), `${key}.json`);
  const waiterPath = join(waitersDir(dir), `${key}-${pid}.json`);
  let registered = false;
  const registerWaiter = (at: number) => {
    if (registered) return;
    registered = true;
    const waiter: LaneWaiter = { ...identity, pid, host, enqueued_at: new Date(at).toISOString() };
    if (options.label !== undefined) waiter.label = options.label;
    try {
      writeFileSync(waiterPath, JSON.stringify(waiter), { flag: "wx" });
    } catch {
      // Already registered by this pid; the original enqueue time stands.
    }
  };
  try {
    for (;;) {
      const at = now();
      const record: LaneHolder = { ...identity, pid, host, acquired_at: new Date(at).toISOString() };
      if (options.label !== undefined) record.label = options.label;
      const unlock = claimMutex(dir, record);
      if (unlock !== null) {
        try {
          pruneStaleHolders(dir, host);
          const holders = readHolders(dir);
          const poolFull = options.pool !== undefined && options.pool > 0 && holders.length >= options.pool;
          const laneHolder = holders.find((holder) => laneKey(holder) === key);
          if (!poolFull && laneHolder === undefined && claim(holderPath, record, host)) {
            rmSync(waiterPath, { force: true });
            let released = false;
            return {
              ok: true,
              holder: record,
              waited_ms: at - started,
              release: () => {
                if (released) return;
                released = true;
                const current = readHolder(holderPath);
                if (current !== null && current.value.pid === pid && current.value.acquired_at === record.acquired_at)
                  rmSync(holderPath, { force: true });
              },
            };
          }
          const waited = at - started;
          const reason =
            laneHolder !== undefined
              ? `lane ${identity.lane} (${identity.branch}) is held by pid ${laneHolder.pid} on ${laneHolder.host} since ${laneHolder.acquired_at}`
              : poolFull
                ? `gate pool is full (${holders.length}/${options.pool ?? 0} lanes holding)`
                : `lane ${identity.lane} (${identity.branch}) has an unreadable holder record at ${holderPath}`;
          if (waited >= timeoutMs) {
            const failure: Extract<AcquireResult, { ok: false }> = { ok: false, reason, waited_ms: waited };
            if (laneHolder !== undefined) failure.holder = laneHolder;
            return failure;
          }
          registerWaiter(at);
          options.onWait?.(reason, waited);
        } finally {
          unlock();
        }
      } else if (now() - started >= Math.max(timeoutMs, 30_000)) {
        return { ok: false, reason: "gate claim stayed contended past the wait limit", waited_ms: now() - started };
      }
      sleep(pollMs);
    }
  } finally {
    if (registered) rmSync(waiterPath, { force: true });
  }
}

/** The outcome of a `releaseLane` attempt. */
export interface ReleaseResult {
  ok: boolean;
  reason: string;
}

/** Release a lane's lock only when its holder is this pid or already dead on this host. */
export function releaseLane(
  dir: string,
  identity: LaneIdentity,
  options: { pid?: number; host?: string } = {},
): ReleaseResult {
  const path = join(holdersDir(dir), `${laneKey(identity)}.json`);
  const current = readHolder(path);
  if (current === null) return { ok: false, reason: `lane ${identity.lane} (${identity.branch}) holds no gate lock` };
  const pid = options.pid ?? process.pid;
  const host = options.host ?? hostname();
  if (current.value.pid !== pid && current.value.host === host && alive(current.value.pid))
    return {
      ok: false,
      reason: `lane is held by live pid ${current.value.pid} on ${current.value.host}; not released`,
    };
  rmSync(path, { force: true });
  return { ok: true, reason: `released lane ${identity.lane} (${identity.branch})` };
}

export interface GitResult {
  code: number;
  text: string;
  stderr: string;
}

export type GitRunner = (project: string, args: readonly string[]) => GitResult;

export const runGit: GitRunner = (project, args) => {
  const result = spawnSync("git", ["-C", project, ...args], { encoding: "utf8" });
  return { code: result.status ?? 1, text: (result.stdout ?? "").trim(), stderr: (result.stderr ?? "").trim() };
};

/** This worktree's lane identity: its top level and current branch (or head sha when detached). */
export function laneIdentity(project: string, lane: string | undefined, git: GitRunner = runGit): LaneIdentity {
  const top = git(project, ["rev-parse", "--show-toplevel"]);
  if (top.code !== 0 || top.text === "") throw new Error(`${project} is not a git checkout: ${top.stderr}`);
  const branch = git(project, ["branch", "--show-current"]);
  const head = git(project, ["rev-parse", "--short", "HEAD"]);
  const branchName = branch.code === 0 && branch.text !== "" ? branch.text : `detached-${head.text}`;
  return { lane: lane ?? branchName, branch: branchName, worktree: top.text };
}

export interface UnpublishedResult {
  branch: string;
  unpublished: number;
  oldest_at?: string;
  age_minutes?: number;
  max_age_minutes: number;
  overdue: boolean;
}

/**
 * The oldest commit on this branch that no remote holds, and whether it is overdue.
 * A commit counts as published when a remote-tracking ref contains it; entering the
 * configured pipeline is the publication path this check guards, so it never pushes.
 */
export function checkUnpublished(
  project: string,
  maxAgeMinutes: number,
  options: { now?: () => number; git?: GitRunner } = {},
): UnpublishedResult {
  const git = options.git ?? runGit;
  const nowMs = (options.now ?? Date.now)();
  const branchResult = git(project, ["branch", "--show-current"]);
  const branch =
    branchResult.code === 0 && branchResult.text !== ""
      ? branchResult.text
      : git(project, ["rev-parse", "--short", "HEAD"]).text;
  const log = git(project, ["log", "--format=%ct", "HEAD", "--not", "--remotes"]);
  const stamps = log.code === 0 && log.text !== "" ? log.text.split("\n").map(Number).filter(Number.isFinite) : [];
  if (stamps.length === 0) return { branch, unpublished: 0, max_age_minutes: maxAgeMinutes, overdue: false };
  const oldestSeconds = Math.min(...stamps);
  const ageMinutes = Math.max(0, Math.floor((nowMs / 1000 - oldestSeconds) / 60));
  return {
    branch,
    unpublished: stamps.length,
    oldest_at: new Date(oldestSeconds * 1000).toISOString(),
    age_minutes: ageMinutes,
    max_age_minutes: maxAgeMinutes,
    overdue: ageMinutes > maxAgeMinutes,
  };
}

/** Pool size from flag, then `AK_GATE_LANES_POOL`; absent or invalid means no cap. */
export function resolvePool(
  flag: string | undefined,
  env: string | undefined = process.env.AK_GATE_LANES_POOL,
): number | undefined {
  const raw = flag ?? env;
  if (raw === undefined || raw === "") return undefined;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

/** Unpublished-age limit from flag, then `AK_GATE_UNPUBLISHED_MAX_AGE_MINUTES`, then the default. */
export function resolveMaxAgeMinutes(
  flag: string | undefined,
  env: string | undefined = process.env.AK_GATE_UNPUBLISHED_MAX_AGE_MINUTES,
): number {
  const raw = flag ?? env;
  if (raw === undefined || raw === "") return DEFAULT_UNPUBLISHED_MAX_AGE_MINUTES;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_UNPUBLISHED_MAX_AGE_MINUTES;
}

export function formatDuration(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return `${Math.floor(ms / 1000)}s`;
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

export function formatStatus(status: LaneStatus): string[] {
  const lines: string[] = [];
  if (status.holders.length === 0) lines.push("holders: none");
  for (const holder of status.holders)
    lines.push(
      `holder: lane=${holder.lane} branch=${holder.branch} worktree=${holder.worktree} pid=${holder.pid} host=${holder.host} held=${formatDuration(holder.held_ms)}${holder.label === undefined ? "" : ` label=${holder.label}`}`,
    );
  if (status.waiters.length === 0) lines.push("waiters: none");
  for (const waiter of status.waiters)
    lines.push(
      `waiter: lane=${waiter.lane} branch=${waiter.branch} worktree=${waiter.worktree} pid=${waiter.pid} host=${waiter.host} waiting=${formatDuration(waiter.waiting_ms)}${waiter.label === undefined ? "" : ` label=${waiter.label}`}`,
    );
  return lines;
}
