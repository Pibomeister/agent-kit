/**
 * The human-step stall class: a held human-only step is not normal work.
 *
 * A captain or crewmate that hits a human-only step (sign-in, an auth prompt, a verification
 * code, an OTP, an approval or a captcha) escalates within about 10 minutes, through its
 * human-needed or page channel during the day and into the morning handoff overnight, never
 * a page overnight. Unrelated work keeps moving, a PR or deploy is never blocked on the
 * step, and an interactive auth prompt is never held open.
 *
 * This module only classifies and checks; no supervisor calls it yet. Wiring into the
 * supervisor contract (adapters/supervisor/CONTRACT.md, on the S6 branch) follows once S6 lands.
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

type TimeInput = number | Date;

const toMs = (value: TimeInput, name: string): number => {
  const ms = value instanceof Date ? value.getTime() : value;
  if (!Number.isFinite(ms)) throw new TypeError(`${name} must be a finite time`);
  return ms;
};

export interface HumanStepInput {
  kind: HumanStepKind;
  /** When the human-only step started: epoch milliseconds or a Date. */
  startedAt: TimeInput;
  /** The current time: epoch milliseconds or a Date. */
  now: TimeInput;
  /** Whether `now` falls in the declared overnight window. */
  overnight: boolean;
}

export type HumanStepAction = "none" | "escalate" | "morning-handoff";
export type HumanStepChannel = "none" | "human-needed-or-page" | "morning-handoff";
export type HumanStepClassification = "human-step-pending" | "human-step-stall";

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

/** Classify a held human-only step and state the required action. */
export function assessHumanStep(input: HumanStepInput): HumanStepAssessment {
  if (!isHumanStepKind(input.kind)) throw new TypeError(`unknown human-only step kind: ${String(input.kind)}`);
  const startedMs = toMs(input.startedAt, "startedAt");
  const nowMs = toMs(input.now, "now");
  if (nowMs < startedMs) throw new RangeError("now must not be before startedAt");
  const elapsedMs = nowMs - startedMs;
  const stall = elapsedMs >= HUMAN_STEP_STALL_THRESHOLD_MS;
  if (!stall)
    return {
      kind: input.kind,
      elapsedMs,
      thresholdMs: HUMAN_STEP_STALL_THRESHOLD_MS,
      overnight: input.overnight,
      stall: false,
      classification: "human-step-pending",
      action: "none",
      channel: "none",
    };
  return {
    kind: input.kind,
    elapsedMs,
    thresholdMs: HUMAN_STEP_STALL_THRESHOLD_MS,
    overnight: input.overnight,
    stall: true,
    classification: "human-step-stall",
    action: input.overnight ? "morning-handoff" : "escalate",
    channel: input.overnight ? "morning-handoff" : "human-needed-or-page",
  };
}

/** A violation when a human-only step sits at or over the threshold without escalation. */
export function checkEscalation(input: HumanStepInput & { escalated: boolean }): string[] {
  const result = assessHumanStep(input);
  if (!result.stall || input.escalated) return [];
  return [
    `human-only step '${input.kind}' has waited ${result.elapsedMs}ms, at or over the ${HUMAN_STEP_STALL_THRESHOLD_MS}ms threshold, without escalation: required action is '${result.action}' through '${result.channel}'`,
  ];
}

export type ShipTarget = "pull-request" | "deploy";

/** A violation when a PR or deploy is recorded as blocked on a human-only step. */
export function checkBlockedOnHumanStep(input: { target: ShipTarget; blockedOn?: string | null }): string[] {
  if (!isHumanStepKind(input.blockedOn)) return [];
  return [
    `${input.target} must not be blocked on a human-only step ('${input.blockedOn}'): escalate the step and keep the ${input.target} moving`,
  ];
}

const INTERACTIVE_AUTH_PROMPT_KINDS: readonly HumanStepKind[] = ["sign-in", "auth-prompt"];

/** A violation when an interactive auth prompt is held open, whatever the duration. */
export function checkInteractiveAuthPrompt(input: {
  kind: HumanStepKind;
  startedAt: TimeInput;
  now: TimeInput;
  promptHeldOpen: boolean;
}): string[] {
  if (!input.promptHeldOpen || !INTERACTIVE_AUTH_PROMPT_KINDS.includes(input.kind)) return [];
  assessHumanStep({ kind: input.kind, startedAt: input.startedAt, now: input.now, overnight: false });
  return [`an interactive auth prompt ('${input.kind}') must not be held open: close it and escalate the step instead`];
}
