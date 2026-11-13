/**
 * Stall-class definition for a held human-only step, and the contract its tests check.
 * This PR delivers that definition and its contract tests only. It is a dependency for the
 * supervisor wiring. The stall rule is not yet enforced by any supervisor.
 *
 * A captain or crewmate that hits a human-only step (sign-in, an auth prompt, a verification
 * code, an OTP, an approval or a captcha) escalates within about 10 minutes, through its
 * human-needed or page channel during the day and into the morning handoff overnight, never
 * a page overnight. `approval` is an interactive approval challenge the worker hits, such as
 * a device or consent prompt. It is never pull-request review or merge approval, which stays
 * the owner gate. Unrelated work keeps moving, a PR or deploy is never blocked on the step,
 * and an interactive auth prompt is never held open.
 *
 * Self-contained and importing only `node:` built-ins, so it can later be bundled with `gate.ts`.
 */

/** How long a human-only step may sit before it is a stall that must escalate. */
export const HUMAN_STEP_STALL_THRESHOLD_MS = 10 * 60 * 1000;

export const HUMAN_STEP_KINDS = ["sign-in", "auth-prompt", "verification-code", "otp", "approval", "captcha"] as const;
export type HumanStepKind = (typeof HUMAN_STEP_KINDS)[number];

export function isHumanStepKind(value: unknown): value is HumanStepKind {
  return HUMAN_STEP_KINDS.some((kind) => kind === value);
}

const epochMs = (value: number, name: string): number => {
  if (!Number.isFinite(value)) throw new TypeError(`${name} must be a finite epoch millisecond time`);
  return value;
};

export interface HumanStepInput {
  kind: HumanStepKind;
  /** When the human-only step started, as epoch milliseconds. */
  startedAt: number;
  /** The current time, as epoch milliseconds. */
  now: number;
  /** Whether `now` falls in the declared overnight window. */
  overnight: boolean;
}

export type HumanStepAction = "none" | "escalate" | "morning-handoff";
export type HumanStepChannel = "none" | "human-needed-or-page" | "morning-handoff";
export type HumanStepClassification = "human-step-pending" | "human-step-stall";

/**
 * Channel a caller records for an escalation it claims.
 * Daytime, `page` or `human-needed` satisfies. Overnight, only `morning-handoff` does; a `page` is a violation.
 */
export type EscalationChannel = "page" | "human-needed" | "morning-handoff";

export interface HumanStepAssessment {
  kind: HumanStepKind;
  elapsedMs: number;
  thresholdMs: typeof HUMAN_STEP_STALL_THRESHOLD_MS;
  overnight: boolean;
  /** True at or over the threshold: the step is stalled, distinct from normal work. */
  stall: boolean;
  classification: HumanStepClassification;
  action: HumanStepAction;
  channel: HumanStepChannel;
}

const requiredChannel = (overnight: boolean): Exclude<HumanStepChannel, "none"> =>
  overnight ? "morning-handoff" : "human-needed-or-page";

const recordedChannelSatisfies = (overnight: boolean, channel: EscalationChannel | undefined): boolean => {
  if (overnight) return channel === "morning-handoff";
  return channel === "page" || channel === "human-needed";
};

/** Classify a held human-only step and state the required action. */
export function assessHumanStep(input: HumanStepInput): HumanStepAssessment {
  if (!isHumanStepKind(input.kind)) throw new TypeError(`unknown human-only step kind: ${String(input.kind)}`);
  const startedMs = epochMs(input.startedAt, "startedAt");
  const nowMs = epochMs(input.now, "now");
  if (nowMs < startedMs) throw new RangeError("now must not be before startedAt");
  const elapsedMs = nowMs - startedMs;
  const stall = elapsedMs >= HUMAN_STEP_STALL_THRESHOLD_MS;
  const channel = stall ? requiredChannel(input.overnight) : "none";
  return {
    kind: input.kind,
    elapsedMs,
    thresholdMs: HUMAN_STEP_STALL_THRESHOLD_MS,
    overnight: input.overnight,
    stall,
    classification: stall ? "human-step-stall" : "human-step-pending",
    action: stall ? (input.overnight ? "morning-handoff" : "escalate") : "none",
    channel,
  };
}

/**
 * A violation when a human-only step sits at or over the threshold without an escalation on the
 * channel the window allows. Overnight only `morning-handoff` counts, and a page is a violation.
 * During the day `page` or `human-needed` counts.
 */
export function checkEscalation(input: HumanStepInput & { escalated: boolean; channel?: EscalationChannel }): string[] {
  const result = assessHumanStep(input);
  if (!result.stall) return [];
  if (input.escalated && recordedChannelSatisfies(input.overnight, input.channel)) return [];
  const recorded = input.escalated ? (input.channel ?? "none") : "none";
  return [
    `human-only step '${input.kind}' has waited ${result.elapsedMs}ms, at or over the ${HUMAN_STEP_STALL_THRESHOLD_MS}ms threshold, without a satisfying escalation: recorded channel '${recorded}', required action is '${result.action}' through '${result.channel}'`,
  ];
}

export type ShipTarget = "pull-request" | "deploy";

/**
 * A violation when a PR or deploy is recorded as blocked on a human-only step.
 * A pull request waiting on its merge or review gate is not that step: record it as
 * `merge` or `review`. `approval` is only the interactive device or consent challenge.
 */
export function checkBlockedOnHumanStep(input: { target: ShipTarget; blockedOn?: string | null }): string[] {
  if (!isHumanStepKind(input.blockedOn)) return [];
  return [
    `${input.target} must not be blocked on a human-only step ('${input.blockedOn}'): escalate the step and keep the ${input.target} moving`,
  ];
}

const INTERACTIVE_AUTH_PROMPT_KINDS: readonly HumanStepKind[] = ["sign-in", "auth-prompt"];

/** A violation when an interactive auth prompt is held open. The text names the channel `overnight` requires. */
export function checkInteractiveAuthPrompt(input: {
  kind: HumanStepKind;
  promptHeldOpen: boolean;
  overnight: boolean;
}): string[] {
  if (!input.promptHeldOpen || !INTERACTIVE_AUTH_PROMPT_KINDS.includes(input.kind)) return [];
  const channel = requiredChannel(input.overnight);
  return [
    `an interactive auth prompt ('${input.kind}') must not be held open: close it and escalate through '${channel}'`,
  ];
}
