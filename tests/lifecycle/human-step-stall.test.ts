import { describe, expect, test } from "bun:test";

import { main } from "../../src/lifecycle/gate.ts";
import {
  assessHumanStep,
  checkBlockedOnHumanStep,
  checkEscalation,
  checkInteractiveAuthPrompt,
  HUMAN_STEP_KINDS,
  HUMAN_STEP_STALL_THRESHOLD_MS,
  isHumanStepKind,
} from "../../src/lifecycle/human-step-stall.ts";

const START = 1_700_000_000_000;
const MINUTE = 60_000;

describe("human-step stall threshold", () => {
  test("the threshold is a named constant of 10 minutes", () => {
    expect(HUMAN_STEP_STALL_THRESHOLD_MS).toBe(10 * MINUTE);
  });

  test("every step kind is a recognised human-only step", () => {
    expect(HUMAN_STEP_KINDS).toEqual(["sign-in", "auth-prompt", "verification-code", "otp", "approval", "captcha"]);
    for (const kind of HUMAN_STEP_KINDS) expect(isHumanStepKind(kind)).toBe(true);
    expect(isHumanStepKind("compiling")).toBe(false);
    expect(isHumanStepKind("normal-work")).toBe(false);
  });

  test("under 10 minutes the required action is none, for every kind", () => {
    for (const kind of HUMAN_STEP_KINDS) {
      const result = assessHumanStep({ kind, startedAt: START, now: START + 9 * MINUTE, overnight: false });
      expect(result.action, kind).toBe("none");
      expect(result.stall, kind).toBe(false);
      expect(result.channel, kind).toBe("none");
    }
  });

  test("just under the exact 10-minute boundary still requires no escalation", () => {
    const result = assessHumanStep({
      kind: "otp",
      startedAt: START,
      now: START + HUMAN_STEP_STALL_THRESHOLD_MS - 1,
      overnight: false,
    });
    expect(result.elapsedMs).toBe(HUMAN_STEP_STALL_THRESHOLD_MS - 1);
    expect(result.action).toBe("none");
    expect(result.stall).toBe(false);
  });

  test("at exactly 10 minutes during the day it escalates through the human-needed or page channel, for every kind", () => {
    for (const kind of HUMAN_STEP_KINDS) {
      const result = assessHumanStep({
        kind,
        startedAt: START,
        now: START + HUMAN_STEP_STALL_THRESHOLD_MS,
        overnight: false,
      });
      expect(result.elapsedMs, kind).toBe(HUMAN_STEP_STALL_THRESHOLD_MS);
      expect(result.action, kind).toBe("escalate");
      expect(result.channel, kind).toBe("human-needed-or-page");
      expect(result.stall, kind).toBe(true);
      expect(result.classification, kind).toBe("human-step-stall");
    }
  });

  test("over 10 minutes during the day it keeps escalating and is not normal work", () => {
    const result = assessHumanStep({ kind: "captcha", startedAt: START, now: START + 45 * MINUTE, overnight: false });
    expect(result.action).toBe("escalate");
    expect(result.classification).toBe("human-step-stall");
    expect(result.classification).not.toBe("normal-work");
  });

  test("at and over 10 minutes overnight it routes to the morning handoff, never a page, for every kind", () => {
    for (const kind of HUMAN_STEP_KINDS) {
      const result = assessHumanStep({
        kind,
        startedAt: START,
        now: START + HUMAN_STEP_STALL_THRESHOLD_MS,
        overnight: true,
      });
      expect(result.action, kind).toBe("morning-handoff");
      expect(result.channel, kind).toBe("morning-handoff");
      expect(result.channel, kind).not.toBe("page");
      expect(result.stall, kind).toBe(true);
    }
  });

  test("overnight under 10 minutes also requires no action", () => {
    const result = assessHumanStep({ kind: "approval", startedAt: START, now: START + 5 * MINUTE, overnight: true });
    expect(result.action).toBe("none");
    expect(result.channel).toBe("none");
  });
});

describe("escalation invariant", () => {
  test("an escalated flag with no channel does not count, day or overnight", () => {
    for (const overnight of [false, true]) {
      expect(
        checkEscalation({
          kind: "otp",
          startedAt: START,
          now: START + 11 * MINUTE,
          overnight,
          escalated: true,
        }).length,
        String(overnight),
      ).toBeGreaterThan(0);
    }
  });

  test("fails if a human-only step sits over 10 minutes without escalation", () => {
    for (const kind of HUMAN_STEP_KINDS) {
      const violations = checkEscalation({
        kind,
        startedAt: START,
        now: START + 11 * MINUTE,
        overnight: false,
        escalated: false,
      });
      expect(violations.length, kind).toBeGreaterThan(0);
    }
  });

  test("a daytime page or human-needed escalation satisfies the stall", () => {
    for (const channel of ["page", "human-needed"] as const) {
      expect(
        checkEscalation({
          kind: "otp",
          startedAt: START,
          now: START + 11 * MINUTE,
          overnight: false,
          escalated: true,
          channel,
        }),
        channel,
      ).toEqual([]);
    }
  });

  test("an overnight page is a violation and the morning handoff is not", () => {
    const page = checkEscalation({
      kind: "otp",
      startedAt: START,
      now: START + 11 * MINUTE,
      overnight: true,
      escalated: true,
      channel: "page",
    });
    expect(page.length).toBeGreaterThan(0);
    expect(page.join("\n")).toContain("morning-handoff");
    expect(page.join("\n")).toContain("page");

    expect(
      checkEscalation({
        kind: "otp",
        startedAt: START,
        now: START + 11 * MINUTE,
        overnight: true,
        escalated: true,
        channel: "morning-handoff",
      }),
    ).toEqual([]);
  });

  test("an overnight page below the threshold is a violation, for every kind", () => {
    for (const kind of HUMAN_STEP_KINDS) {
      for (const elapsed of [0, MINUTE, HUMAN_STEP_STALL_THRESHOLD_MS - 1]) {
        const page = checkEscalation({
          kind,
          startedAt: START,
          now: START + elapsed,
          overnight: true,
          escalated: true,
          channel: "page",
        });
        expect(page.length, `${kind} ${elapsed}`).toBeGreaterThan(0);
        expect(page.join("\n"), `${kind} ${elapsed}`).toContain("page");
        expect(page.join("\n"), `${kind} ${elapsed}`).toContain("morning-handoff");
      }
    }
  });

  test("below the threshold, an un-escalated step, a daytime page and an overnight handoff stay valid", () => {
    const pending = { kind: "otp", startedAt: START, now: START + MINUTE } as const;
    expect(checkEscalation({ ...pending, overnight: true, escalated: false })).toEqual([]);
    expect(checkEscalation({ ...pending, overnight: false, escalated: false })).toEqual([]);
    expect(checkEscalation({ ...pending, overnight: false, escalated: true, channel: "page" })).toEqual([]);
    expect(checkEscalation({ ...pending, overnight: true, escalated: true, channel: "morning-handoff" })).toEqual([]);
  });

  test("a morning handoff during the day, or a human-needed channel overnight, is not escalation", () => {
    expect(
      checkEscalation({
        kind: "otp",
        startedAt: START,
        now: START + 11 * MINUTE,
        overnight: false,
        escalated: true,
        channel: "morning-handoff",
      }).length,
    ).toBeGreaterThan(0);
    expect(
      checkEscalation({
        kind: "otp",
        startedAt: START,
        now: START + 11 * MINUTE,
        overnight: true,
        escalated: true,
        channel: "human-needed",
      }).length,
    ).toBeGreaterThan(0);
  });

  test("passes under the threshold without escalation", () => {
    expect(
      checkEscalation({ kind: "otp", startedAt: START, now: START + 9 * MINUTE, overnight: false, escalated: false }),
    ).toEqual([]);
  });

  test("fails at exactly 10 minutes without escalation", () => {
    expect(
      checkEscalation({
        kind: "sign-in",
        startedAt: START,
        now: START + HUMAN_STEP_STALL_THRESHOLD_MS,
        overnight: false,
        escalated: false,
      }).length,
    ).toBeGreaterThan(0);
  });
});

describe("PR and deploy invariant", () => {
  test("fails if a PR is recorded as blocked on a human-only step, for every kind", () => {
    for (const kind of HUMAN_STEP_KINDS) {
      expect(checkBlockedOnHumanStep({ target: "pull-request", blockedOn: kind }).length, kind).toBeGreaterThan(0);
    }
  });

  test("fails if a deploy is recorded as blocked on a human-only step, for every kind", () => {
    for (const kind of HUMAN_STEP_KINDS) {
      expect(checkBlockedOnHumanStep({ target: "deploy", blockedOn: kind }).length, kind).toBeGreaterThan(0);
    }
  });

  test("passes when a PR or deploy is not blocked, or is blocked on something else", () => {
    expect(checkBlockedOnHumanStep({ target: "pull-request", blockedOn: null })).toEqual([]);
    expect(checkBlockedOnHumanStep({ target: "pull-request" })).toEqual([]);
    expect(checkBlockedOnHumanStep({ target: "deploy", blockedOn: "ci" })).toEqual([]);
    expect(checkBlockedOnHumanStep({ target: "deploy", blockedOn: "normal-work" })).toEqual([]);
  });

  test("a PR waiting on its merge or review gate is not a human-step stall", () => {
    expect(checkBlockedOnHumanStep({ target: "pull-request", blockedOn: "merge" })).toEqual([]);
    expect(checkBlockedOnHumanStep({ target: "pull-request", blockedOn: "review" })).toEqual([]);
  });
});

describe("interactive auth prompt invariant", () => {
  test("fails if an interactive auth prompt is left held open and names the daytime channel", () => {
    for (const kind of ["sign-in", "auth-prompt"] as const) {
      const violations = checkInteractiveAuthPrompt({ kind, promptHeldOpen: true, overnight: false });
      expect(violations.length, kind).toBeGreaterThan(0);
      expect(violations.join("\n"), kind).toContain("human-needed-or-page");
    }
  });

  test("a held-open prompt overnight reports the morning handoff", () => {
    for (const kind of ["sign-in", "auth-prompt"] as const) {
      const violations = checkInteractiveAuthPrompt({ kind, promptHeldOpen: true, overnight: true });
      expect(violations.length, kind).toBeGreaterThan(0);
      expect(violations.join("\n"), kind).toContain("morning-handoff");
      expect(violations.join("\n"), kind).not.toContain("human-needed-or-page");
    }
  });

  test("passes when no interactive auth prompt is held open", () => {
    expect(checkInteractiveAuthPrompt({ kind: "sign-in", promptHeldOpen: false, overnight: false })).toEqual([]);
    expect(checkInteractiveAuthPrompt({ kind: "auth-prompt", promptHeldOpen: false, overnight: true })).toEqual([]);
  });
});

/** The Nov 12 rule: 10 minutes, then escalate. The supervisor must apply that, not only the helper. */
const TEN_MINUTES_MS = 10 * 60 * 1000;

function supervisor(args: readonly string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = main(args, {
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

describe("lifecycle supervisor human-step", () => {
  const held = ["human-step", "--kind", "otp", "--started-at", "1700000000000", "--now", "1700000660000"] as const;

  test("a held OTP is a stall and names the daytime channel", () => {
    const result = supervisor(held);
    expect(result.code).toBe(1);
    expect(result.out).toContain("human-step-stall");
    expect(result.out).toContain("action=escalate");
    expect(result.out).toContain("channel=human-needed-or-page");
    expect(result.out).toContain("elapsed_ms=660000");
    expect(result.err).toContain("otp");
    expect(result.err).toContain("human-needed-or-page");
  });

  test("one millisecond under 10 minutes is still pending", () => {
    const result = supervisor([
      "human-step",
      "--kind",
      "otp",
      "--started-at",
      String(START),
      "--now",
      String(START + TEN_MINUTES_MS - 1),
    ]);
    expect(result.code).toBe(0);
    expect(result.out).toContain("human-step-pending");
    expect(result.out).toContain("action=none");
    expect(result.err).toBe("");
  });

  test("exactly 10 minutes without escalation is a stall for every kind", () => {
    for (const kind of HUMAN_STEP_KINDS) {
      const result = supervisor([
        "human-step",
        "--kind",
        kind,
        "--started-at",
        String(START),
        "--now",
        String(START + TEN_MINUTES_MS),
      ]);
      expect(result.code, kind).toBe(1);
      expect(result.out, kind).toContain("human-step-stall");
      expect(result.out, kind).toContain("channel=human-needed-or-page");
    }
  });

  test("overnight names the morning handoff, and a page does not count", () => {
    const page = supervisor([...held, "--overnight", "--escalated", "--channel", "page"]);
    expect(page.code).toBe(1);
    expect(page.out).toContain("channel=morning-handoff");
    expect(page.out).not.toContain("human-needed-or-page");
    expect(page.err).toContain("page");
    expect(page.err).toContain("morning-handoff");

    const handoff = supervisor([...held, "--overnight", "--escalated", "--channel", "morning-handoff"]);
    expect(handoff.code).toBe(0);
    expect(handoff.out).toContain("human-step-stall");
    expect(handoff.out).toContain("action=morning-handoff");
    expect(handoff.out).toContain("channel=morning-handoff");
    expect(handoff.err).toBe("");
  });

  test("an overnight page below the threshold exits 1, and an un-escalated pending step exits 0", () => {
    const pending = ["human-step", "--kind", "otp", "--started-at", String(START), "--now", String(START + 60_000)];
    const page = supervisor([...pending, "--overnight", "--escalated", "--channel", "page"]);
    expect(page.code).toBe(1);
    expect(page.out).toContain("human-step-pending");
    expect(page.err).toContain("page");
    expect(page.err).toContain("morning-handoff");

    const quiet = supervisor([...pending, "--overnight"]);
    expect(quiet.code).toBe(0);
    expect(quiet.out).toContain("human-step-pending");
    expect(quiet.out).toContain("action=none");
    expect(quiet.err).toBe("");
  });

  test("an escalated flag with no channel does not count, day or overnight", () => {
    for (const extra of [[], ["--overnight"]] as const) {
      const result = supervisor([...held, "--escalated", ...extra]);
      expect(result.code, extra.join() || "day").toBe(1);
    }
  });

  test("a daytime page or human-needed escalation satisfies the stall", () => {
    for (const channel of ["page", "human-needed"] as const) {
      const result = supervisor([...held, "--escalated", "--channel", channel]);
      expect(result.code, channel).toBe(0);
      expect(result.out, channel).toContain("human-step-stall");
      expect(result.err, channel).toBe("");
    }
  });

  test("a pull request or deploy blocked on the step fails, and merge or review does not", () => {
    const times = ["--kind", "otp", "--started-at", String(START), "--now", String(START + 60_000)] as const;
    for (const target of ["pull-request", "deploy"] as const) {
      for (const kind of HUMAN_STEP_KINDS) {
        const blocked = supervisor(["human-step", ...times, "--target", target, "--blocked-on", kind]);
        expect(blocked.code, `${target} ${kind}`).toBe(1);
        expect(blocked.err, `${target} ${kind}`).toContain(target);
        expect(blocked.err, `${target} ${kind}`).toContain(kind);
      }
    }
    for (const reason of ["merge", "review"]) {
      const waiting = supervisor(["human-step", ...times, "--target", "pull-request", "--blocked-on", reason]);
      expect(waiting.code, reason).toBe(0);
      expect(waiting.err, reason).toBe("");
    }
  });

  test("a held-open auth prompt fails and names the window's channel", () => {
    const times = ["--started-at", String(START), "--now", String(START + 60_000)] as const;
    const day = supervisor(["human-step", "--kind", "sign-in", ...times, "--prompt-held-open"]);
    expect(day.code).toBe(1);
    expect(day.err).toContain("sign-in");
    expect(day.err).toContain("human-needed-or-page");

    const night = supervisor(["human-step", "--kind", "auth-prompt", ...times, "--overnight", "--prompt-held-open"]);
    expect(night.code).toBe(1);
    expect(night.err).toContain("morning-handoff");
    expect(night.err).not.toContain("human-needed-or-page");

    const closed = supervisor(["human-step", "--kind", "sign-in", ...times]);
    expect(closed.code).toBe(0);
    expect(closed.err).toBe("");
  });
});
