/**
 * Events and observations for the review/runner reference model.
 *
 * Plan §7 of the Elephant Goldfish test plan: generated sequences against a small
 * state model, with failing seeds kept for replay.
 */

export const LANE_ROLES = ["code-review/correctness", "code-review/security"] as const;
export type LaneRole = (typeof LANE_ROLES)[number];

export const UNAVAILABLE_REASONS = ["timeout", "timed out", "quota exhausted", "no seat"] as const;
export type UnavailableReason = (typeof UNAVAILABLE_REASONS)[number];

export const VERDICTS = ["approved", "changes-requested", "blocked"] as const;
export type ReviewVerdict = (typeof VERDICTS)[number];

export const SEATS = ["seat-a", "seat-b"] as const;
export type SeatId = (typeof SEATS)[number];

export const ACTORS = ["supervisor-1", "supervisor-2", "supervisor-3", "implementer-1"] as const;
export type ActorId = (typeof ACTORS)[number];

export const FINDING_IDS = ["finding-a", "finding-b"] as const;
export type FindingId = (typeof FINDING_IDS)[number];

export const IMPLEMENTER = "implementer-1";
export const AUTHOR_ROLE = "implementer";
export const FIX_CYCLE_CAP = 2;

export type LaneState = "pending" | "covered" | "skipped" | "unavailable";

export type Event =
  | { kind: "cover-lane"; role: LaneRole; filledBy: ActorId }
  | { kind: "unavailable-lane"; role: LaneRole; reason: UnavailableReason }
  | { kind: "skip-lane"; role: LaneRole; withReason: boolean }
  | { kind: "set-verdict"; verdict: ReviewVerdict }
  | { kind: "charge-fix-cycle"; findingId: FindingId }
  | { kind: "record-extension"; authorizedBy: "human" | "runner" | "orchestrator"; withTimestamp: boolean }
  | { kind: "force-full-mode" }
  | { kind: "apply-patch"; findingId: FindingId }
  | { kind: "resolve-finding"; findingId: FindingId; closer: "implementer" | "verifier"; independent: boolean }
  | { kind: "change-bytes" }
  | { kind: "resume" }
  | { kind: "restart" }
  | { kind: "rename-run" }
  | { kind: "move-line"; findingId: FindingId }
  | { kind: "cancel" }
  | { kind: "publish" }
  | { kind: "complete-seat"; seat: SeatId; actor: ActorId; lineage: ActorId[] }
  | { kind: "decide" }
  | { kind: "synthesize"; soften: boolean; mutateLaneState: boolean }
  | { kind: "claim-isolation"; isolation: "runner-attested" | "host-unattested" | "self-attested" }
  | { kind: "fill-seat-with-author"; role: LaneRole };

export interface Lane {
  role: LaneRole;
  required: boolean;
  state: LaneState;
  reason: string | null;
  verdict: "approve" | "request-changes" | "block" | "no-opinion" | null;
  filledBy: string | null;
  independentOfAuthor: boolean;
  rawOutputPresent: boolean;
  conflictingEvidence: boolean;
}

export interface Finding {
  id: FindingId;
  status: "open" | "awaiting-verification" | "resolved";
  author: string;
  patchApplied: boolean;
  line: number;
  closer: string | null;
  independentReceipt: boolean;
  synthesisSoftened: boolean;
}

export interface SeatJudgment {
  seat: SeatId;
  actor: ActorId;
  lineage: ActorId[];
}

export interface Extension {
  authorizedBy: string;
  authorizedAt: string | null;
}

export interface Model {
  lanes: Lane[];
  verdict: ReviewVerdict;
  mode: "full" | "delta";
  fixUsed: number;
  extensions: Extension[];
  findings: Finding[];
  snapshotHash: string;
  approvalHash: string | null;
  currentHash: string;
  cancelled: boolean;
  publishedAfterCancel: boolean;
  published: boolean;
  capReached: boolean;
  needsInput: boolean;
  judgments: SeatJudgment[];
  lastSeatRejected: boolean | null;
  decideAttempted: boolean;
  isolationClaim: "runner-attested" | "host-unattested" | "self-attested" | null;
  attemptedLaneRewrite: boolean;
  authorFilledRole: LaneRole | null;
  budget: BudgetEntry[];
  budgetFloor: BudgetEntry[];
}

export interface BudgetEntry {
  key: string;
  used: number;
}

export interface Observation {
  approvalLegal: boolean;
  timeoutTreatedAsCoverage: boolean;
  thirdCycleLegal: boolean;
  appliedImpliesResolved: boolean;
  closureLegal: boolean;
  approvalCurrent: boolean;
  countersDecreased: boolean;
  publishAfterCancel: boolean;
  seatsIndependent: boolean | null;
  isolationFromAuthorFlag: boolean;
  synthesisErasedConflict: boolean;
  synthesisChangedLaneState: boolean;
  skipWithoutReason: boolean;
}
