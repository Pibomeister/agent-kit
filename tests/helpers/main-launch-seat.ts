/**
 * Copied from origin/main e6d4dfc6 src/council/seat.ts launchSeat.
 * JSON-only. No transcript fallback. Used to pin json/* parity.
 */

import { isCouncilAnswer, type CouncilSeat } from "../../src/council/config.ts";
import { UNSPECIFIED, type Attempt, type SeatResult, type Spawn } from "../../src/council/seat.ts";

function reason(cause: unknown): string {
  return (cause instanceof Error ? cause.message : String(cause)).slice(0, 500);
}

export async function mainLaunchSeat(
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
