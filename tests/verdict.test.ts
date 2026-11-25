import { describe, expect, test } from "bun:test";

import { isCouncilAnswer } from "../src/council/config.ts";
import { launchSeat, type Spawn } from "../src/council/seat.ts";
import { JSON_STDOUT_ROWS, MIXED_JSON_PLUS_VERDICT, WORTHY_WITH_JSON_SCALAR } from "./helpers/mixed-stdout.ts";
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

const spawnSequence = (outputs: string[]): Spawn => {
  let i = 0;
  return () => {
    const stdout = outputs[i] ?? "";
    i += 1;
    return Promise.resolve({ exitCode: 0, stdout: Buffer.from(stdout), stderr: Buffer.alloc(0) });
  };
};

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

  test("well-formed JSON missing rationale is a schema refusal, not a transcript", async () => {
    const result = await launchSeat(seat, "payload", options, spawnWith(JSON.stringify({ choice: "WORTHY" })));
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).toContain("invalid answer");
    expect(JSON.stringify(result)).not.toContain("structured final verdict field");
  });

  test("well-formed JSON missing rationale then a VERDICT line is unavailable", async () => {
    const result = await launchSeat(
      seat,
      "payload",
      options,
      spawnWith(`${JSON.stringify({ choice: "WORTHY" })}\nVERDICT: WORTHY\n`),
    );
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("structured final verdict field");
  });

  test("a yes/no card plus VERDICT: yes is unavailable", async () => {
    const result = await launchSeat(seat, "payload", ["yes", "no"], spawnWith("the change is ready\nVERDICT: yes\n"));
    expect(result.ok).toBe(false);
    expect(result.attempts).toHaveLength(1);
  });

  test("a yes/no card plus VERDICT: WORTHY is unavailable and the substitute runs", async () => {
    const chained = {
      seat: "adversarial",
      chain: [
        { actor: "first", lineage: ["first"], command: ["unused"] },
        { actor: "second", lineage: ["second"], command: ["unused"] },
      ],
    };
    const result = await launchSeat(
      chained,
      "payload",
      ["yes", "no"],
      spawnSequence(["review done\nVERDICT: WORTHY\n", JSON.stringify({ choice: "yes", rationale: "ok" })]),
    );
    expect(result.ok).toBe(true);
    expect(result).toMatchObject({
      answer: { choice: "yes", rationale: "ok" },
      attempts: [{ actor: "first" }, { actor: "second" }],
    });
    const exhausted = await launchSeat(seat, "payload", ["yes", "no"], spawnWith("review done\nVERDICT: WORTHY\n"));
    expect(exhausted.ok).toBe(false);
    expect(exhausted.attempts).toHaveLength(1);
  });

  test("a JSON array, a JSON primitive, and a JSON council answer followed by VERDICT are unavailable", async () => {
    for (const [name, stdout] of [
      ["JSON array", "[1,2]"],
      ["JSON primitive", "true"],
      [
        "JSON council answer followed by VERDICT",
        `${JSON.stringify({ choice: "REJECT", rationale: "x" })}\nVERDICT: WORTHY\n`,
      ],
    ] as const) {
      const result = await launchSeat(seat, "payload", options, spawnWith(stdout));
      expect(result.ok, name).toBe(false);
      expect(result.attempts, name).toHaveLength(1);
    }
  });

  test("mixed JSON-plus-VERDICT stdout is unavailable for each ADV-001 shape", async () => {
    for (const [name, stdout] of MIXED_JSON_PLUS_VERDICT) {
      const result = await launchSeat(seat, "payload", options, spawnWith(stdout));
      expect(result.ok, name).toBe(false);
      expect(result.attempts, name).toHaveLength(1);
      expect(JSON.stringify(result), name).not.toContain("structured final verdict field");
    }
  });

  test("a JSON scalar remainder still admits a final VERDICT: WORTHY", async () => {
    for (const [name, stdout] of WORTHY_WITH_JSON_SCALAR) {
      const result = await launchSeat(seat, "payload", options, spawnWith(stdout));
      expect(result.ok, name).toBe(true);
      expect(result).toMatchObject({ answer: { choice: "WORTHY" } });
    }
  });

  test("pure JSON stdout matches origin/main on every json row", async () => {
    for (const [name, stdout] of JSON_STDOUT_ROWS) {
      let mainOk = false;
      let mainChoice: string | undefined;
      try {
        const value: unknown = JSON.parse(stdout);
        if (isCouncilAnswer(value) && options.some((opt) => opt === value.choice)) {
          mainOk = true;
          mainChoice = value.choice;
        }
      } catch {
        mainOk = false;
      }
      const result = await launchSeat(seat, "payload", options, spawnWith(stdout));
      expect(result.ok, name).toBe(mainOk);
      if (mainOk) expect(result).toMatchObject({ answer: { choice: mainChoice } });
    }
  });
});
