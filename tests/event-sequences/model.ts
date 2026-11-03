/**
 * Reference model of review/runner policy. This is the spec the implementation
 * is checked against, not a transcription of src/.
 */
import {
  AUTHOR_ROLE,
  FIX_CYCLE_CAP,
  IMPLEMENTER,
  LANE_ROLES,
  type Event,
  type Finding,
  type FindingId,
  type Lane,
  type LaneRole,
  type Model,
  type Observation,
  type SeatJudgment,
} from "./types.ts";

const HASH_A = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(64)}`;

function lane(role: LaneRole): Lane {
  return {
    role,
    required: true,
    state: "pending",
    reason: null,
    verdict: null,
    filledBy: null,
    independentOfAuthor: true,
    rawOutputPresent: false,
    conflictingEvidence: false,
  };
}

function finding(id: FindingId): Finding {
  return {
    id,
    status: "open",
    author: AUTHOR_ROLE,
    patchApplied: false,
    line: 10,
    closer: null,
    independentReceipt: false,
    synthesisSoftened: false,
  };
}

export function initialModel(): Model {
  return {
    lanes: LANE_ROLES.map(lane),
    verdict: "changes-requested",
    mode: "full",
    fixUsed: 0,
    extensions: [],
    findings: [finding("finding-a"), finding("finding-b")],
    snapshotHash: HASH_A,
    approvalHash: HASH_A,
    currentHash: HASH_A,
    cancelled: false,
    publishedAfterCancel: false,
    published: false,
    capReached: false,
    needsInput: false,
    judgments: [],
    lastSeatRejected: null,
    decideAttempted: false,
    isolationClaim: null,
    attemptedLaneRewrite: false,
    authorFilledRole: null,
    budget: [],
    budgetFloor: [],
  };
}

function laneOf(model: Model, role: LaneRole): Lane {
  const found = model.lanes.find((item) => item.role === role);
  if (found === undefined) throw new Error(`model has no lane ${role}`);
  return found;
}

function findingOf(model: Model, id: FindingId): Finding {
  const found = model.findings.find((item) => item.id === id);
  if (found === undefined) throw new Error(`model has no finding ${id}`);
  return found;
}

function timeoutReason(reason: string | null): boolean {
  return reason !== null && /timeout|timed out/i.test(reason);
}

function humanExtensions(model: Model): number {
  return model.extensions.filter((ext) => ext.authorizedBy === "human" && ext.authorizedAt !== null).length;
}

function budgetUsed(model: Model, key: string): number {
  return model.budget.find((entry) => entry.key === key)?.used ?? 0;
}

function setBudget(model: Model, key: string, used: number): void {
  const existing = model.budget.find((entry) => entry.key === key);
  if (existing === undefined) model.budget.push({ key, used });
  else if (used > existing.used) existing.used = used;
}

function snapshotFloor(model: Model): void {
  for (const entry of model.budget) {
    const floor = model.budgetFloor.find((item) => item.key === entry.key);
    if (floor === undefined) model.budgetFloor.push({ key: entry.key, used: entry.used });
    else if (entry.used < floor.used) {
      // Resume/restart/rename must not lower the floor; a drop is recorded as the floor staying high.
    } else floor.used = entry.used;
  }
}

function lineageOverlap(a: SeatJudgment, b: SeatJudgment): boolean {
  return a.actor === b.actor || a.lineage.includes(b.actor) || b.lineage.includes(a.actor);
}

function sameJudgment(a: SeatJudgment, b: SeatJudgment): boolean {
  if (a.seat !== b.seat || a.actor !== b.actor) return false;
  if (a.lineage.length !== b.lineage.length) return false;
  return a.lineage.every((id, i) => b.lineage[i] === id);
}

function seatsAreIndependent(judgments: readonly SeatJudgment[]): boolean | null {
  if (judgments.length < 2) return null;
  const [first, second] = judgments;
  if (first === undefined || second === undefined) return null;
  return modelSeatsIndependent(first, second);
}

/**
 * Independence as the charter states it: distinct seats and actors, neither
 * lineage names the other, and the implementer is excluded.
 */
export function modelSeatsIndependent(a: SeatJudgment, b: SeatJudgment): boolean {
  if (a.seat === b.seat) return false;
  if (a.actor === IMPLEMENTER || b.actor === IMPLEMENTER) return false;
  if (a.lineage.includes(IMPLEMENTER) || b.lineage.includes(IMPLEMENTER)) return false;
  return !lineageOverlap(a, b);
}

export function applyEvent(model: Model, event: Event): void {
  switch (event.kind) {
    case "cover-lane": {
      const target = laneOf(model, event.role);
      target.state = "covered";
      target.reason = null;
      target.verdict = "approve";
      target.filledBy = event.filledBy;
      target.independentOfAuthor = event.filledBy !== IMPLEMENTER;
      target.rawOutputPresent = true;
      target.conflictingEvidence = event.role.includes("security");
      return;
    }
    case "unavailable-lane": {
      const target = laneOf(model, event.role);
      target.state = "unavailable";
      target.reason = event.reason;
      target.verdict = "no-opinion";
      target.rawOutputPresent = false;
      return;
    }
    case "skip-lane": {
      const target = laneOf(model, event.role);
      target.state = "skipped";
      target.reason = event.withReason ? "stack does not apply" : null;
      target.verdict = "no-opinion";
      target.rawOutputPresent = false;
      return;
    }
    case "set-verdict":
      model.verdict = event.verdict;
      return;
    case "charge-fix-cycle": {
      if (model.cancelled || model.capReached || model.needsInput) return;
      const key = `fix_cycles:${event.findingId}`;
      const used = budgetUsed(model, key);
      if (used + 1 > FIX_CYCLE_CAP) {
        model.capReached = true;
        return;
      }
      setBudget(model, key, used + 1);
      model.fixUsed += 1;
      return;
    }
    case "record-extension":
      model.extensions.push({
        authorizedBy: event.authorizedBy,
        authorizedAt: event.withTimestamp ? "2026-01-01T00:00:00Z" : null,
      });
      model.mode = "delta";
      if (model.fixUsed <= FIX_CYCLE_CAP) model.fixUsed = FIX_CYCLE_CAP + 1;
      return;
    case "force-full-mode":
      model.mode = "full";
      return;
    case "apply-patch": {
      const target = findingOf(model, event.findingId);
      target.patchApplied = true;
      if (target.status !== "resolved") target.status = "awaiting-verification";
      return;
    }
    case "resolve-finding": {
      const target = findingOf(model, event.findingId);
      target.status = "resolved";
      target.closer = event.closer;
      target.independentReceipt = event.independent && event.closer === "verifier";
      return;
    }
    case "change-bytes":
      model.currentHash = HASH_B;
      return;
    case "resume":
    case "restart":
    case "rename-run":
      snapshotFloor(model);
      return;
    case "move-line":
      findingOf(model, event.findingId).line += 7;
      return;
    case "cancel":
      model.cancelled = true;
      return;
    case "publish":
      if (model.cancelled) {
        if (!model.published) model.publishedAfterCancel = true;
        return;
      }
      if (!model.needsInput && !model.capReached) model.published = true;
      return;
    case "complete-seat": {
      const candidate: SeatJudgment = { seat: event.seat, actor: event.actor, lineage: event.lineage };
      const prior = model.judgments.find((j) => j.seat === event.seat);
      // Identical resubmission is idempotent even after cancel/cap, matching Runner.judge.
      if (prior !== undefined) {
        model.lastSeatRejected = !sameJudgment(prior, candidate);
        return;
      }
      if (model.cancelled || model.capReached || model.needsInput) {
        model.lastSeatRejected = true;
        return;
      }
      if (
        !event.lineage.includes(event.actor) ||
        event.actor === IMPLEMENTER ||
        event.lineage.includes(IMPLEMENTER) ||
        model.judgments.some((j) => !modelSeatsIndependent(j, candidate))
      ) {
        model.lastSeatRejected = true;
        return;
      }
      model.lastSeatRejected = false;
      model.judgments.push(candidate);
      return;
    }
    case "decide":
      model.decideAttempted = true;
      if (model.cancelled || model.capReached) return;
      if (seatsAreIndependent(model.judgments) !== true) model.needsInput = true;
      return;
    case "synthesize": {
      // Synthesis may only worsen a grade. It does not rewrite lane execution state.
      if (event.mutateLaneState) model.attemptedLaneRewrite = true;
      if (event.soften) {
        const first = model.findings[0];
        if (first !== undefined) first.synthesisSoftened = true;
      }
      return;
    }
    case "claim-isolation":
      model.isolationClaim = event.isolation;
      return;
    case "fill-seat-with-author": {
      const target = laneOf(model, event.role);
      target.filledBy = "builder";
      target.independentOfAuthor = false;
      model.authorFilledRole = event.role;
      return;
    }
  }
}

export function observe(model: Model): Observation {
  const required = model.lanes.filter((item) => item.required);
  const uncovered = required.filter((item) => item.state !== "covered");
  const unavailableRequired = required.filter((item) => item.state === "unavailable");
  const timeoutLane = required.find((item) => timeoutReason(item.reason));
  const human = humanExtensions(model);
  const thirdLegal =
    model.fixUsed <= FIX_CYCLE_CAP + human && (model.fixUsed <= FIX_CYCLE_CAP || (human > 0 && model.mode === "delta"));
  const approvalLegal =
    model.verdict !== "approved" ||
    (uncovered.length === 0 &&
      unavailableRequired.length === 0 &&
      thirdLegal &&
      model.approvalHash === model.currentHash &&
      model.authorFilledRole === null);
  const resolved = model.findings.filter((item) => item.status === "resolved");
  const closureLegal = resolved.every((item) => item.independentReceipt && item.closer === "verifier");
  let countersDecreased = false;
  for (const floor of model.budgetFloor) {
    if (budgetUsed(model, floor.key) < floor.used) countersDecreased = true;
  }
  return {
    approvalLegal,
    timeoutTreatedAsCoverage: timeoutLane !== undefined && timeoutLane.state === "covered",
    thirdCycleLegal: thirdLegal,
    appliedImpliesResolved: model.findings.some(
      (item) => item.patchApplied && item.status === "resolved" && !item.independentReceipt,
    ),
    closureLegal,
    approvalCurrent: model.approvalHash === model.currentHash,
    countersDecreased,
    publishAfterCancel: model.publishedAfterCancel,
    seatsIndependent: seatsAreIndependent(model.judgments),
    isolationFromAuthorFlag:
      model.isolationClaim === "self-attested" ||
      (model.isolationClaim === "host-unattested" && model.authorFilledRole !== null),
    synthesisErasedConflict: model.findings.some((item) => item.synthesisSoftened),
    synthesisChangedLaneState:
      model.attemptedLaneRewrite && timeoutLane !== undefined && timeoutLane.state !== "unavailable",
    skipWithoutReason: model.lanes.some((item) => item.state === "skipped" && item.reason === null),
  };
}

export function isTimeoutReason(reason: string): boolean {
  return /timeout|timed out/i.test(reason);
}

export { HASH_A, HASH_B };
