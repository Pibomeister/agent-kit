import { applyEvent, initialModel, isTimeoutReason, modelSeatsIndependent, observe } from "./model.ts";
import { applyImpl, inspectImpl, liveBudget, timeoutStillBlocks, type ImplView, type World } from "./impl.ts";
import type { BudgetEntry, Event, Lane, SeatJudgment } from "./types.ts";

const APPROVAL_BLOCKS = [
  "review.unavailable-required-lane-blocks-approval",
  "review.third-fix-cycle-stops",
  "review.seat-filled-by-someone-other-than-the-author",
  "review.security-seat-not-filled-by-implementer-or-spec-approver",
  "schemas.document-invalid",
  "approval.stale",
] as const;

function used(entries: readonly BudgetEntry[], key: string): number {
  return entries.find((entry) => entry.key === key)?.used ?? 0;
}

function budgetDropped(floor: readonly BudgetEntry[], live: readonly BudgetEntry[]): string | null {
  for (const entry of floor) {
    if (used(live, entry.key) < entry.used) {
      return `budget ${entry.key} fell from ${entry.used} to ${used(live, entry.key)} across resume/restart/rename`;
    }
  }
  for (const entry of live) {
    if (entry.used < 0) return `budget ${entry.key} is negative`;
  }
  return null;
}

function mergeFloor(floor: readonly BudgetEntry[], live: readonly BudgetEntry[]): BudgetEntry[] {
  const keys = new Set([...floor.map((entry) => entry.key), ...live.map((entry) => entry.key)]);
  const out: BudgetEntry[] = [];
  for (const key of keys) {
    const previous = used(floor, key);
    const current = used(live, key);
    out.push({ key, used: previous > current ? previous : current });
  }
  return out;
}

function asJudgment(event: Event): SeatJudgment | null {
  if (event.kind !== "complete-seat") return null;
  return { seat: event.seat, actor: event.actor, lineage: event.lineage };
}

/** First two generated seats that the charter would treat as an independent pair. */
function independentSeatPair(events: readonly Event[]): [Event, Event] | null {
  let first: Event | null = null;
  for (const event of events) {
    if (event.kind !== "complete-seat") continue;
    if (first === null) {
      first = event;
      continue;
    }
    const left = asJudgment(first);
    const right = asJudgment(event);
    if (left === null || right === null) return null;
    if (modelSeatsIndependent(left, right)) return [first, event];
    return null;
  }
  return null;
}

function seatPairError(world: World, first: Event, second: Event): string | null {
  world.restore();
  world.lastSeatError = null;
  applyImpl(world, first);
  if (world.lastSeatError !== null) return world.lastSeatError;
  applyImpl(world, second);
  return world.lastSeatError;
}

function approvalBlocks(rules: readonly string[]): string[] {
  return APPROVAL_BLOCKS.filter((rule) => rules.includes(rule));
}

function timeoutCoveredInDoc(modelLanes: readonly Lane[], view: ImplView): boolean {
  for (const lane of modelLanes) {
    const timeout = (lane.reason !== null && isTimeoutReason(lane.reason)) || lane.timeoutCoverAttempted;
    if (!timeout) continue;
    const submitted = view.lanes.find((item) => item.role === lane.role);
    if (submitted?.state === "covered") return true;
  }
  return false;
}

/**
 * Apply `events` to the reference model and the real runner/validators.
 * Returns human-readable property failures; empty means the sequence holds.
 */
export function failuresOf(events: readonly Event[], world: World): string[] {
  world.restore();
  world.lastSeatError = null;
  world.lastPublishError = null;
  world.lastChargeStatus = null;
  const model = initialModel();
  let floor: BudgetEntry[] = [];
  const failures: string[] = [];
  for (const event of events) {
    if (
      event.kind === "resume" ||
      event.kind === "restart" ||
      event.kind === "rename-run" ||
      event.kind === "move-line"
    ) {
      floor = mergeFloor(floor, liveBudget(world));
    }
    applyEvent(model, event);
    applyImpl(world, event);
    if (event.kind === "complete-seat") {
      const modelRejected = model.lastSeatRejected === true;
      const seatError = world.lastSeatError;
      if (modelRejected && seatError === null) failures.push("overlapping or excluded seats were accepted");
      if (!modelRejected && seatError !== null) {
        failures.push("independent seats were refused: ".concat(seatError));
      }
    }
    if (
      event.kind === "resume" ||
      event.kind === "restart" ||
      event.kind === "rename-run" ||
      event.kind === "move-line"
    ) {
      const dropped = budgetDropped(floor, liveBudget(world));
      if (dropped !== null) failures.push(dropped);
    }
  }
  const obs = observe(model);
  const view = inspectImpl(world, model);
  const rules = view.rules;
  const live = liveBudget(world);

  if (timeoutCoveredInDoc(model.lanes, view)) {
    failures.push("timeout treated as coverage in the submitted review document");
  }
  if (!timeoutStillBlocks(model, rules)) {
    failures.push(
      "approved a required timeout/unavailable lane; review.unavailable-required-lane-blocks-approval did not fire",
    );
  }

  if (model.verdict === "approved" && !obs.approvalLegal) {
    if (approvalBlocks(rules).length === 0) {
      failures.push("illegal approval raised no blocking review rule");
    }
  }
  if (model.verdict === "approved" && obs.approvalLegal) {
    const blocking = approvalBlocks(rules);
    if (blocking.length > 0) {
      failures.push(`legal approval raised blocking rule: ${blocking.join(", ")}`);
    }
  }

  if (!obs.thirdCycleLegal && model.verdict === "approved" && !rules.includes("review.third-fix-cycle-stops")) {
    failures.push("third fix cycle approved without a recorded human extension");
  }
  if (obs.appliedImpliesResolved) {
    const closed = rules.includes("finding.self-closed") || rules.includes("finding.closed-without-receipt");
    if (!closed) failures.push("applied/resolved without an independent closure receipt");
  }

  if (!obs.approvalCurrent && !rules.includes("approval.stale")) {
    failures.push("changed bytes kept a current approval (approval.stale silent)");
  }
  if (obs.approvalCurrent && rules.includes("approval.stale")) {
    failures.push("matching hashes fired approval.stale");
  }
  if (obs.publishAfterCancel && world.lastPublishError === null) {
    failures.push("cancelled run published a current result");
  }
  const pair = independentSeatPair(events);
  if (pair !== null) {
    const forward = seatPairError(world, pair[0], pair[1]);
    const reverse = seatPairError(world, pair[1], pair[0]);
    if (forward !== null) failures.push("independent seats were refused: ".concat(forward));
    if (reverse !== null) failures.push("independent seats were refused: ".concat(reverse));
    if ((forward === null) !== (reverse === null)) {
      failures.push("reordering independent seat completion changed coverage or authority");
    }
  }
  const authorLane = model.lanes.find((lane) => lane.filledBy === "builder" || !lane.independentOfAuthor);
  if (authorLane !== undefined) {
    const seatRule =
      rules.includes("review.seat-filled-by-someone-other-than-the-author") ||
      rules.includes("review.security-seat-not-filled-by-implementer-or-spec-approver");
    if (!seatRule) failures.push("author-controlled seating established a review seat");
  }
  if (obs.isolationFromAuthorFlag) {
    const encoded = view.lanes.length > 0 && view.lanes.every((item) => !item.seat.context_isolated);
    if (!encoded) failures.push("author-claimed isolation was not encoded as context_isolated false");
    if (!rules.includes("schemas.document-invalid")) {
      failures.push("author-claimed isolation did not fail the independent_of_author pin");
    }
    const isolationRule =
      rules.includes("review.seat-filled-by-someone-other-than-the-author") ||
      rules.includes("schemas.document-invalid");
    if (!isolationRule) failures.push("author-claimed isolation did not fire an isolation/authority rule");
  }
  if (view.findingsSoftened && !rules.includes("finding.synthesis-may-only-worsen-a-grade")) {
    failures.push("synthesis softened a grade without finding.synthesis-may-only-worsen-a-grade");
  }
  if (model.attemptedLaneRewrite) {
    const timeoutUnavailable = model.lanes.filter(
      (lane) => lane.state === "unavailable" && lane.reason !== null && isTimeoutReason(lane.reason),
    );
    if (timeoutUnavailable.length > 0 && model.verdict === "approved") {
      if (!rules.includes("review.unavailable-required-lane-blocks-approval")) {
        failures.push("a synthesis rewrite left timeout-unavailable as approval coverage");
      }
    }
  }

  for (const entry of model.budget) {
    if (used(live, entry.key) < entry.used) {
      failures.push(`impl budget ${entry.key}=${used(live, entry.key)} behind model ${entry.used}`);
    }
  }
  const dropped = budgetDropped(model.budgetFloor, live);
  if (dropped !== null) failures.push(dropped);

  const closedByAuthor = model.findings.some(
    (item) => item.status === "resolved" && (item.closer === "implementer" || item.closer === item.author),
  );
  if (closedByAuthor && !rules.includes("finding.self-closed")) {
    failures.push("author closed a finding; finding.self-closed silent");
  }

  return failures;
}

export function formatEvents(events: readonly Event[]): string {
  return events.map((event, i) => `${i}:${event.kind}`).join(", ");
}
