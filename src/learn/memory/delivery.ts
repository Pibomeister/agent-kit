/**
 * Once-per-session delivery of the session-start block, for a host whose
 * SessionStart hook output never reaches the model.
 *
 * Such a host carries the block on a hook that fires many times in a session
 * (every submitted prompt, every tool call), so the runtime keeps one mark per
 * session under `<runtimeDir>/delivered/<host>/`: the first carrier call
 * claims the mark and prints the block, every later one finds it and prints
 * nothing. The host's own session-start and post-compaction hooks clear the
 * mark, which is what makes a resumed or compacted session receive the block
 * again, as it does where SessionStart carries it directly.
 *
 * The session id is the host's and is never used as a path: the mark is named
 * by its digest.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LearnConfig } from "../core/config.ts";
import { nowMs } from "../core/store.ts";

/** Hosts that carry the block on a recurring hook. */
export const CARRIER_HOSTS = ["grok", "kimi"] as const;
export type CarrierHost = (typeof CARRIER_HOSTS)[number];

export function isCarrierHost(value: string | undefined): value is CarrierHost {
  return CARRIER_HOSTS.some((host) => host === value);
}

/** A mark older than this belongs to a session that is over; claiming sweeps them. */
export const MARK_MAX_AGE_MS = 30 * 86_400_000;

function marksDir(config: LearnConfig, host: CarrierHost): string {
  return join(config.runtimeDir, "delivered", host);
}

export function markPath(config: LearnConfig, host: CarrierHost, sessionId: string): string {
  return join(marksDir(config, host), createHash("sha256").update(sessionId).digest("hex").slice(0, 32));
}

export function delivered(config: LearnConfig, host: CarrierHost, sessionId: string): boolean {
  return existsSync(markPath(config, host, sessionId));
}

function sweep(dir: string, now: number): void {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    try {
      if (now - statSync(path).mtimeMs > MARK_MAX_AGE_MS) rmSync(path, { force: true });
    } catch {
      // A mark another process removed between the listing and the stat is already gone.
    }
  }
}

/**
 * Take the session's mark. True for exactly one caller: the create is
 * exclusive, so two tool calls finishing together cannot both deliver.
 */
export function claim(config: LearnConfig, host: CarrierHost, sessionId: string, now = nowMs()): boolean {
  const dir = marksDir(config, host);
  mkdirSync(dir, { recursive: true });
  try {
    writeFileSync(markPath(config, host, sessionId), "", { flag: "wx" });
  } catch {
    return false;
  }
  sweep(dir, now);
  return true;
}

/** Forget that the session received the block, so its next carrier call delivers again. */
export function rearm(config: LearnConfig, host: CarrierHost, sessionId: string): void {
  rmSync(markPath(config, host, sessionId), { force: true });
}
