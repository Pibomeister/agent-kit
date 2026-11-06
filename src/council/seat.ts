/**
 * One council seat's launch, through its ordered substitute chain. Each
 * launcher receives the same payload on stdin and nothing else, so a seat is
 * blind to every other seat's answer. The chain moves on only when a launcher
 * fails to start, exits non-zero, or returns an answer that is not valid for
 * the card; the first valid answer ends it.
 */

import { isCouncilAnswer, type CouncilAnswer, type CouncilLauncher, type CouncilSeat } from "./config.ts";

export interface ChildOutput {
  exitCode: number;
  stdout: Buffer;
  stderr: Buffer;
}

export type Spawn = (launcher: CouncilLauncher, stdin: string) => Promise<ChildOutput>;

export interface Attempt {
  actor: string;
  model_requested: string;
  error?: string;
}

export type SeatResult =
  | { ok: true; launcher: CouncilLauncher; answer: CouncilAnswer; attempts: Attempt[] }
  | { ok: false; attempts: Attempt[] };

/** What the record says about a requested model the roster did not name. */
export const UNSPECIFIED = "unspecified";
/** What the record says about a served model the launcher did not report. */
export const UNVERIFIED = "unverified";

function reason(cause: unknown): string {
  return (cause instanceof Error ? cause.message : String(cause)).slice(0, 500);
}

/** Signals a detached child's whole process group. A group already gone is not an error. */
export function killGroup(pid: number, signal: NodeJS.Signals = "SIGKILL"): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // The group is already gone; a descendant that left it may still hold the pipes.
  }
}

/**
 * A piped child's output, or a timeout error once `timeoutMs` passes. The child
 * must be spawned `detached`, so it leaves the terminal's foreground group: its
 * pid stays in `live` until it settles, and whoever owns `live` must kill those
 * groups when it is interrupted or shuts down. The timeout kills the group and
 * stops waiting, because a descendant can hold the pipes open past any kill.
 */
export async function collectDetached(
  child: {
    pid: number;
    stdout: ReadableStream<Uint8Array>;
    stderr: ReadableStream<Uint8Array>;
    exited: Promise<number>;
  },
  live: Set<number>,
  timeoutMs: number | undefined,
  what: string,
): Promise<ChildOutput> {
  live.add(child.pid);
  const output = Promise.all([
    new Response(child.stdout).arrayBuffer(),
    new Response(child.stderr).arrayBuffer(),
    child.exited,
  ]).then(([stdout, stderr, exitCode]) => ({ exitCode, stdout: Buffer.from(stdout), stderr: Buffer.from(stderr) }));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const pending = [output];
  if (timeoutMs !== undefined)
    pending.push(
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          killGroup(child.pid);
          reject(new Error(`${what} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    );
  try {
    return await Promise.race(pending);
  } finally {
    clearTimeout(timer);
    live.delete(child.pid);
  }
}

export async function launchSeat(
  seat: CouncilSeat,
  payload: string,
  options: readonly string[],
  spawn: Spawn,
): Promise<SeatResult> {
  const attempts: Attempt[] = [];
  for (const launcher of seat.chain) {
    const attempt: Attempt = { actor: launcher.actor, model_requested: launcher.requested ?? UNSPECIFIED };
    attempts.push(attempt);
    try {
      const child = await spawn(launcher, payload);
      if (child.exitCode !== 0)
        throw new Error(`launcher exited ${child.exitCode}: ${child.stderr.toString().trim().slice(0, 300)}`);
      const value: unknown = JSON.parse(child.stdout.toString());
      if (!isCouncilAnswer(value)) throw new Error("launcher returned an invalid answer");
      if (!options.includes(value.choice)) throw new Error(`launcher chose ${value.choice}, which is not an option`);
      return { ok: true, launcher, answer: value, attempts };
    } catch (cause) {
      attempt.error = reason(cause);
    }
  }
  return { ok: false, attempts };
}

/** The failures of an exhausted chain, one per attempt. */
export function chainFailures(seat: string, attempts: readonly Attempt[]): string[] {
  return attempts.map((attempt) => `seat ${seat} ${attempt.actor}: ${attempt.error ?? "no answer"}`);
}
