/**
 * One council seat's launch, through its ordered substitute chain. Each
 * launcher receives the same payload on stdin and nothing else, so a seat is
 * blind to every other seat's answer. The chain moves on only when a launcher
 * fails to start, exits non-zero, or returns an answer that is not valid for
 * the card; the first valid answer ends it.
 */

import { isCouncilAnswer, type CouncilAnswer, type CouncilLauncher, type CouncilSeat } from "./config.ts";

export type Spawn = (
  launcher: CouncilLauncher,
  stdin: string,
) => Promise<{ exitCode: number; stdout: Buffer; stderr: Buffer }>;

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
