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
  const options = [...ADVERSARIAL_VERDICTS];

  test("garbage, empty, and exit-0-without-verdict output all refuse", async () => {
    for (const [name, stdout] of [
      ["garbage", "{{{ not json and not a verdict"],
      ["empty", ""],
      ["exit 0 without a verdict field", "Looks fine. Ship it."],
    ] as const) {
      const result = await launchSeat(seat, "payload", options, spawnWith(stdout));
      expect(result.ok, name).toBe(false);
      expect(result.attempts, name).toHaveLength(1);
    }
  });

  test("a valid JSON approve and a valid JSON reject pass through", async () => {
    const approve = await launchSeat(
      seat,
      "payload",
      options,
      spawnWith(JSON.stringify({ choice: "WORTHY", rationale: "evidence holds" })),
    );
    expect(approve).toMatchObject({ ok: true, answer: { choice: "WORTHY", rationale: "evidence holds" } });
    const reject = await launchSeat(
      seat,
      "payload",
      options,
      spawnWith(JSON.stringify({ choice: "REJECT", rationale: "the constructed failure stands" })),
    );
    expect(reject).toMatchObject({
      ok: true,
      answer: { choice: "REJECT", rationale: "the constructed failure stands" },
    });
  });

  test("a valid final VERDICT field passes through failClosedAdversarialVerdict", async () => {
    const worthy = await launchSeat(seat, "payload", options, spawnWith("Careful review.\nVERDICT: WORTHY\n"));
    expect(worthy).toMatchObject({ ok: true, answer: { choice: "WORTHY" } });
    const reject = await launchSeat(
      seat,
      "payload",
      options,
      spawnWith("This looks WORTHY at first glance.\nThe constructed failure still stands.\nVERDICT: REJECT\n"),
    );
    expect(reject).toMatchObject({ ok: true, answer: { choice: "REJECT" } });
    expect(failClosedAdversarialVerdict("This looks WORTHY at first glance.\nVERDICT: REJECT")).toBe("REJECT");
  });

  test("a malformed JSON object is still not a transcript fallback", async () => {
    const result = await launchSeat(seat, "payload", options, spawnWith(JSON.stringify({ choice: "WORTHY" })));
    expect(result.ok).toBe(false);
  });
});
