import { describe, expect, test } from "bun:test";

import { launchSeat, type Spawn } from "../src/council/seat.ts";
import {
  ADVERSARIAL_VERDICTS,
  failClosedAdversarialVerdict,
  parseAdversarialVerdict,
  parseFinalVerdict,
} from "../src/verdict.ts";

describe("parseFinalVerdict", () => {
  test("early positive prose followed by a final REJECT field is a rejection", () => {
    const transcript = [
      "This change looks WORTHY of merging; the tests are green and the diff is tidy.",
      "On a second pass the migration drops a column that a live reader still needs.",
      "VERDICT: REJECT",
    ].join("\n");
    expect(parseAdversarialVerdict(transcript)).toEqual({ ok: true, verdict: "REJECT" });
    expect(failClosedAdversarialVerdict(transcript)).toBe("REJECT");
  });

  test("a valid final WORTHY field is the only route to WORTHY", () => {
    expect(failClosedAdversarialVerdict("Careful review, no blocking findings.\nVERDICT: WORTHY")).toBe("WORTHY");
    expect(parseFinalVerdict("VERDICT: yes", ["yes", "no"])).toEqual({ ok: true, verdict: "yes" });
    expect(ADVERSARIAL_VERDICTS).toEqual(["WORTHY", "REJECT"]);
  });

  test("missing, ambiguous and invalid fields all fail closed", () => {
    const cases: Array<[string, string]> = [
      ["WORTHY in prose only, no field at all", "This is WORTHY, ship it."],
      ["an empty transcript", "  \n"],
      ["two verdict fields", "VERDICT: WORTHY\nVERDICT: REJECT"],
      ["a verdict field that is not final", "VERDICT: WORTHY\nTrailing summary: WORTHY"],
      ["a malformed field with extra words", "VERDICT: WORTHY because it looks fine"],
      ["a field with no value", "VERDICT:"],
      ["a lowercase value outside the exact enum", "VERDICT: worthy"],
      ["an unknown value", "VERDICT: MAYBE"],
      ["an indented field is not the structured field", "  VERDICT: WORTHY"],
    ];
    for (const [name, text] of cases) {
      const parsed = parseAdversarialVerdict(text);
      expect(parsed.ok, name).toBe(false);
      expect(parsed.verdict, name).toBeNull();
      expect(failClosedAdversarialVerdict(text), name).toBe("REJECT");
    }
  });

  test("an empty allowed enum admits nothing", () => {
    expect(parseFinalVerdict("VERDICT: WORTHY", []).ok).toBe(false);
  });
});

const spawnWith =
  (stdout: string): Spawn =>
  async () => ({ exitCode: 0, stdout: Buffer.from(stdout), stderr: Buffer.alloc(0) });

describe("council seat verdict consumption", () => {
  const seat = { seat: "adversarial", chain: [{ actor: "a", lineage: ["a"], command: ["unused"] }] };

  test("a transcript mentioning WORTHY early and ending in a REJECT field answers REJECT", async () => {
    const result = await launchSeat(
      seat,
      "payload",
      [...ADVERSARIAL_VERDICTS],
      spawnWith("This looks WORTHY at first glance.\nThe constructed failure still stands.\nVERDICT: REJECT\n"),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.answer.choice).toBe("REJECT");
      expect(result.answer.rationale).toContain("looks WORTHY at first glance");
    }
  });

  test("a transcript with no final verdict field is no answer, never an inferred approval", async () => {
    const result = await launchSeat(
      seat,
      "payload",
      [...ADVERSARIAL_VERDICTS],
      spawnWith("Definitely WORTHY, merge it."),
    );
    expect(result.ok).toBe(false);
    expect(result.attempts[0]?.error).toContain("no structured final verdict field");
  });

  test("a transcript with two verdict fields is ambiguous and no answer", async () => {
    const result = await launchSeat(
      seat,
      "payload",
      [...ADVERSARIAL_VERDICTS],
      spawnWith("VERDICT: WORTHY\nVERDICT: REJECT"),
    );
    expect(result.ok).toBe(false);
    expect(result.attempts[0]?.error).toContain("exactly one");
  });
});
