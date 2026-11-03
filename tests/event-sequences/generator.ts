import { array, boolean, constant, constantFrom, oneof, subarray, tuple, type Arbitrary } from "fast-check";

import {
  ACTORS,
  FINDING_IDS,
  LANE_ROLES,
  SEATS,
  UNAVAILABLE_REASONS,
  VERDICTS,
  type ActorId,
  type Event,
} from "./types.ts";

const role = constantFrom(...LANE_ROLES);
const findingId = constantFrom(...FINDING_IDS);
const seat = constantFrom(...SEATS);
const actor = constantFrom(...ACTORS);
const reason = constantFrom(...UNAVAILABLE_REASONS);
const verdict = constantFrom(...VERDICTS);
const closer = constantFrom("implementer", "verifier");
const authorizer = constantFrom("human", "runner", "orchestrator");
const isolation = constantFrom("runner-attested", "host-unattested", "self-attested");

const lineage: Arbitrary<ActorId[]> = subarray([...ACTORS], { minLength: 0, maxLength: 3 });

const completeSeat: Arbitrary<Event> = tuple(seat, actor, lineage).map(([seatId, actorId, ancestors]): Event => ({
  kind: "complete-seat",
  seat: seatId,
  actor: actorId,
  lineage: [actorId, ...ancestors.filter((item) => item !== actorId)],
}));

/** Weighted mix: keep timeout, charge, resume and closure events common so 1,000 short sequences still hit them. */
export const eventArb: Arbitrary<Event> = oneof(
  {
    weight: 4,
    arbitrary: tuple(role, reason).map(([laneRole, unavailable]): Event => ({
      kind: "unavailable-lane",
      role: laneRole,
      reason: unavailable,
    })),
  },
  {
    weight: 3,
    arbitrary: tuple(role, actor).map(([laneRole, filledBy]): Event => ({
      kind: "cover-lane",
      role: laneRole,
      filledBy,
    })),
  },
  { weight: 3, arbitrary: findingId.map((id): Event => ({ kind: "charge-fix-cycle", findingId: id })) },
  { weight: 3, arbitrary: constant<Event>({ kind: "resume" }) },
  { weight: 2, arbitrary: constant<Event>({ kind: "restart" }) },
  { weight: 2, arbitrary: verdict.map((value): Event => ({ kind: "set-verdict", verdict: value })) },
  {
    weight: 2,
    arbitrary: tuple(authorizer, boolean()).map(([authorizedBy, withTimestamp]): Event => ({
      kind: "record-extension",
      authorizedBy,
      withTimestamp,
    })),
  },
  { weight: 2, arbitrary: findingId.map((id): Event => ({ kind: "apply-patch", findingId: id })) },
  {
    weight: 2,
    arbitrary: tuple(findingId, closer, boolean()).map(([id, who, independent]): Event => ({
      kind: "resolve-finding",
      findingId: id,
      closer: who,
      independent,
    })),
  },
  { weight: 2, arbitrary: completeSeat },
  { weight: 2, arbitrary: constant<Event>({ kind: "cancel" }) },
  { weight: 2, arbitrary: constant<Event>({ kind: "publish" }) },
  { weight: 2, arbitrary: constant<Event>({ kind: "change-bytes" }) },
  {
    weight: 1,
    arbitrary: tuple(role, boolean()).map(([laneRole, withReason]): Event => ({
      kind: "skip-lane",
      role: laneRole,
      withReason,
    })),
  },
  { weight: 1, arbitrary: constant<Event>({ kind: "force-full-mode" }) },
  { weight: 1, arbitrary: constant<Event>({ kind: "rename-run" }) },
  { weight: 1, arbitrary: findingId.map((id): Event => ({ kind: "move-line", findingId: id })) },
  { weight: 1, arbitrary: constant<Event>({ kind: "decide" }) },
  {
    weight: 1,
    arbitrary: tuple(boolean(), boolean()).map(([soften, mutateLaneState]): Event => ({
      kind: "synthesize",
      soften,
      mutateLaneState,
    })),
  },
  { weight: 1, arbitrary: isolation.map((value): Event => ({ kind: "claim-isolation", isolation: value })) },
  { weight: 1, arbitrary: role.map((laneRole): Event => ({ kind: "fill-seat-with-author", role: laneRole })) },
);

const timeoutThenCover: Arbitrary<Event[]> = tuple(role, reason, actor).map(([laneRole, unavailable, filledBy]) => [
  { kind: "unavailable-lane" as const, role: laneRole, reason: unavailable },
  { kind: "cover-lane" as const, role: laneRole, filledBy },
]);

/** Bounded length: the plan raises run count, not sequence length. Eight keeps the 1,000-run suite under a minute. */
export const sequenceArb: Arbitrary<Event[]> = oneof(
  { weight: 3, arbitrary: array(eventArb, { minLength: 3, maxLength: 8 }) },
  {
    weight: 2,
    arbitrary: tuple(timeoutThenCover, array(eventArb, { minLength: 1, maxLength: 5 })).map(([pair, rest]) => [
      ...pair,
      ...rest,
    ]),
  },
);

export const NUM_RUNS = 1000;

/** Pinned default seed so CI is deterministic. Override with AK_EVENT_SEQ_SEED, or set AK_EVENT_SEQ_RANDOM=1. */
export const PINNED_SEED = 20261103;

/**
 * Named sequences that kill the plan §7 critical mutations. Always executed, not only when
 * the generator happens to draw them.
 */
export const CRITICAL: ReadonlyArray<{ name: string; events: Event[] }> = [
  {
    name: "timeout-unavailable-is-never-approval-coverage",
    events: [
      { kind: "unavailable-lane", role: "code-review/security", reason: "timeout" },
      { kind: "cover-lane", role: "code-review/correctness", filledBy: "supervisor-1" },
      { kind: "set-verdict", verdict: "approved" },
    ],
  },
  {
    name: "timeout-then-cover-same-lane-is-still-unavailable",
    events: [
      { kind: "unavailable-lane", role: "code-review/security", reason: "timeout" },
      { kind: "cover-lane", role: "code-review/security", filledBy: "supervisor-1" },
      { kind: "set-verdict", verdict: "approved" },
    ],
  },
  {
    name: "skipped-required-lane-blocks-approval",
    events: [
      { kind: "skip-lane", role: "code-review/security", withReason: true },
      { kind: "cover-lane", role: "code-review/correctness", filledBy: "supervisor-1" },
      { kind: "set-verdict", verdict: "approved" },
    ],
  },
  {
    name: "matching-hashes-do-not-fire-stale",
    events: [
      { kind: "cover-lane", role: "code-review/correctness", filledBy: "supervisor-1" },
      { kind: "cover-lane", role: "code-review/security", filledBy: "supervisor-2" },
      { kind: "set-verdict", verdict: "approved" },
    ],
  },
  {
    name: "timed-out-unavailable-is-never-approval-coverage",
    events: [
      { kind: "unavailable-lane", role: "code-review/correctness", reason: "timed out" },
      { kind: "cover-lane", role: "code-review/security", filledBy: "supervisor-2" },
      { kind: "set-verdict", verdict: "approved" },
    ],
  },
  {
    name: "resume-does-not-reset-fix-cycles",
    events: [
      { kind: "charge-fix-cycle", findingId: "finding-a" },
      { kind: "charge-fix-cycle", findingId: "finding-a" },
      { kind: "resume" },
      { kind: "restart" },
      { kind: "charge-fix-cycle", findingId: "finding-a" },
    ],
  },
  {
    name: "rename-does-not-mint-a-new-repair-budget",
    events: [
      { kind: "charge-fix-cycle", findingId: "finding-a" },
      { kind: "move-line", findingId: "finding-a" },
      { kind: "rename-run" },
      { kind: "charge-fix-cycle", findingId: "finding-a" },
      { kind: "charge-fix-cycle", findingId: "finding-a" },
    ],
  },
  {
    name: "third-fix-cycle-needs-a-human-extension",
    events: [
      { kind: "charge-fix-cycle", findingId: "finding-a" },
      { kind: "charge-fix-cycle", findingId: "finding-a" },
      { kind: "record-extension", authorizedBy: "runner", withTimestamp: true },
      { kind: "set-verdict", verdict: "approved" },
      { kind: "cover-lane", role: "code-review/correctness", filledBy: "supervisor-1" },
      { kind: "cover-lane", role: "code-review/security", filledBy: "supervisor-2" },
    ],
  },
  {
    name: "human-extension-third-cycle-is-a-delta",
    events: [
      { kind: "cover-lane", role: "code-review/correctness", filledBy: "supervisor-1" },
      { kind: "cover-lane", role: "code-review/security", filledBy: "supervisor-2" },
      { kind: "record-extension", authorizedBy: "human", withTimestamp: true },
      { kind: "set-verdict", verdict: "approved" },
    ],
  },
  {
    name: "applied-patch-is-not-resolved",
    events: [
      { kind: "apply-patch", findingId: "finding-a" },
      { kind: "resolve-finding", findingId: "finding-a", closer: "implementer", independent: false },
    ],
  },
  {
    name: "stale-bytes-do-not-keep-approval",
    events: [
      { kind: "cover-lane", role: "code-review/correctness", filledBy: "supervisor-1" },
      { kind: "cover-lane", role: "code-review/security", filledBy: "supervisor-2" },
      { kind: "set-verdict", verdict: "approved" },
      { kind: "change-bytes" },
    ],
  },
  {
    name: "overlapping-lineage-is-not-independent",
    events: [
      { kind: "complete-seat", seat: "seat-a", actor: "supervisor-1", lineage: ["supervisor-1"] },
      { kind: "complete-seat", seat: "seat-b", actor: "supervisor-2", lineage: ["supervisor-2", "supervisor-1"] },
      { kind: "decide" },
    ],
  },
  {
    name: "independent-seats-in-either-order",
    events: [
      { kind: "complete-seat", seat: "seat-b", actor: "supervisor-2", lineage: ["supervisor-2"] },
      { kind: "complete-seat", seat: "seat-a", actor: "supervisor-1", lineage: ["supervisor-1"] },
      { kind: "decide" },
    ],
  },
  {
    name: "identical-seat-resubmit-after-restart-is-idempotent",
    events: [
      { kind: "complete-seat", seat: "seat-b", actor: "supervisor-1", lineage: ["supervisor-1"] },
      { kind: "restart" },
      { kind: "complete-seat", seat: "seat-b", actor: "supervisor-1", lineage: ["supervisor-1"] },
      { kind: "cover-lane", role: "code-review/correctness", filledBy: "supervisor-1" },
    ],
  },
  {
    name: "author-cannot-close-and-cannot-sit-security",
    events: [
      { kind: "fill-seat-with-author", role: "code-review/security" },
      { kind: "set-verdict", verdict: "approved" },
      { kind: "resolve-finding", findingId: "finding-a", closer: "implementer", independent: true },
    ],
  },
  {
    name: "cancel-then-publish-is-refused",
    events: [{ kind: "cancel" }, { kind: "publish" }, { kind: "charge-fix-cycle", findingId: "finding-a" }],
  },
  {
    name: "synthesis-must-not-cover-a-timeout-lane",
    events: [
      { kind: "unavailable-lane", role: "code-review/security", reason: "timeout" },
      { kind: "synthesize", soften: true, mutateLaneState: true },
      { kind: "set-verdict", verdict: "approved" },
    ],
  },
  {
    name: "self-attested-isolation-is-not-authority",
    events: [
      { kind: "claim-isolation", isolation: "self-attested" },
      { kind: "fill-seat-with-author", role: "code-review/correctness" },
      { kind: "set-verdict", verdict: "approved" },
    ],
  },
  {
    name: "host-unattested-isolation-is-not-authority",
    events: [
      { kind: "claim-isolation", isolation: "host-unattested" },
      { kind: "cover-lane", role: "code-review/correctness", filledBy: "supervisor-1" },
      { kind: "cover-lane", role: "code-review/security", filledBy: "supervisor-2" },
      { kind: "set-verdict", verdict: "approved" },
    ],
  },
];
