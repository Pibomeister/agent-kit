/**
 * The council rule, as pure functions: the two primary seats and the blind
 * veto seat must all approve before an approval stands. There is no majority
 * and no reconcile round. The veto only refuses: it never breaks a tie and
 * never approves alone, so every outcome other than unanimous approval or a
 * unanimous non-approving pair is one escalation to the owner.
 *
 * Settled by the rule-1 council on 2026-10-30 (D4 A, D5 A). See
 * `docs/decisions/0015-council-blind-veto.md`.
 */

import { sharesLineage, type Lineaged } from "../runner/lineage.ts";

/** The veto seat's answer to one frozen packet, kept apart from the pair's two judgments. */
export interface AnsweredVeto extends Lineaged {
  status: "answered";
  seat: string;
  dispatch: string;
  choice: string;
  rationale: string;
  model_requested?: string;
  model_served?: string;
}

/** No seat in the veto's substitute chain returned a valid answer, or the payload could not leave the host. */
export interface UnavailableVeto {
  status: "unavailable";
  seat: string;
  failures: string[];
}

export type VetoRecord = AnsweredVeto | UnavailableVeto;

/**
 * Why an approving pair's approval may not stand, or null when the veto
 * lets it stand. The veto must be answered, independent of both primary
 * seats and every excluded actor, and must itself choose the approving option.
 */
export function vetoRefusal(
  approve: string,
  veto: VetoRecord | undefined,
  pair: readonly Lineaged[],
  excluded: readonly string[],
): string | null {
  if (veto === undefined) return "The charter requires a blind veto seat judgment and none was recorded";
  if (veto.status === "unavailable")
    return `Blind veto seat ${veto.seat} was unavailable: ${veto.failures.join("; ")}`.slice(0, 2000);
  if (
    pair.some((judgment) => sharesLineage(judgment, veto)) ||
    excluded.some((actor) => veto.actor === actor || veto.lineage.includes(actor)) ||
    !veto.lineage.includes(veto.actor)
  )
    return `Blind veto seat ${veto.seat} is not independent of the supervisor pair`;
  if (veto.choice !== approve) return `Blind veto seat ${veto.seat} did not approve; it chose ${veto.choice}`;
  return null;
}

export type CouncilOutcome = "approve" | "decline" | "escalate";

export interface CouncilResult {
  outcome: CouncilOutcome;
  /** The option the council settled on, or null when it escalates. */
  choice: string | null;
  causes: string[];
}

/**
 * The outcome of one council question. `pair` holds each primary seat's
 * choice, null for a seat that could not answer. `veto` is the veto's choice,
 * null when it could not answer, and undefined when it was not asked, which
 * is right only when the pair did not agree on approval.
 */
export function councilOutcome(
  approve: string,
  pair: readonly (string | null)[],
  veto: string | null | undefined,
): CouncilResult {
  const [first, second] = pair;
  if (pair.length !== 2 || first === undefined || second === undefined)
    return { outcome: "escalate", choice: null, causes: ["the council needs exactly two primary seats"] };
  if (first === null || second === null)
    return { outcome: "escalate", choice: null, causes: ["a primary seat was unavailable"] };
  if (first !== second) return { outcome: "escalate", choice: null, causes: ["the primary seats disagreed"] };
  if (first !== approve) return { outcome: "decline", choice: first, causes: [] };
  if (veto === undefined) return { outcome: "escalate", choice: null, causes: ["the blind veto seat was not asked"] };
  if (veto === null) return { outcome: "escalate", choice: null, causes: ["the blind veto seat was unavailable"] };
  if (veto !== approve)
    return { outcome: "escalate", choice: null, causes: [`the blind veto seat did not approve; it chose ${veto}`] };
  return { outcome: "approve", choice: approve, causes: [] };
}
