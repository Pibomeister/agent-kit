import { describe, expect, test } from "bun:test";

import { launchSeat, type Spawn } from "../src/council/seat.ts";
import {
  JSON_STDOUT_ROWS,
  MIXED_ENDING_REJECT,
  MIXED_JSON_PLUS_VERDICT,
  MIXED_RAW_STDOUT,
} from "./helpers/mixed-stdout.ts";
import { mainLaunchSeat } from "./helpers/main-launch-seat.ts";
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
  (stdout: string | Buffer): Spawn =>
  async () => ({
    exitCode: 0,
    stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout),
    stderr: Buffer.alloc(0),
  });

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
  const approve = "WORTHY";

  test("garbage, empty, and exit-0-without-verdict output all refuse", async () => {
    for (const [name, stdout] of [
      ["garbage", "{{{ not json and not a verdict"],
      ["empty", ""],
      ["exit 0 without a verdict field", "Looks fine. Ship it."],
    ] as const) {
      const result = await launchSeat(seat, "payload", options, spawnWith(stdout), approve);
      expect(result.ok, name).toBe(false);
      expect(result.attempts, name).toHaveLength(1);
    }
  });

  test("a valid JSON approve and a valid JSON reject pass through", async () => {
    const jsonApprove = await launchSeat(
      seat,
      "payload",
      options,
      spawnWith(JSON.stringify({ choice: "WORTHY", rationale: "evidence holds" })),
      approve,
    );
    expect(jsonApprove).toMatchObject({ ok: true, answer: { choice: "WORTHY", rationale: "evidence holds" } });
    const reject = await launchSeat(
      seat,
      "payload",
      options,
      spawnWith(JSON.stringify({ choice: "REJECT", rationale: "the constructed failure stands" })),
      approve,
    );
    expect(reject).toMatchObject({
      ok: true,
      answer: { choice: "REJECT", rationale: "the constructed failure stands" },
    });
  });

  test("a valid final VERDICT: WORTHY transcript never approves", async () => {
    const worthy = await launchSeat(seat, "payload", options, spawnWith("Careful review.\nVERDICT: WORTHY\n"), approve);
    expect(worthy.ok).toBe(false);
  });

  test("a valid final VERDICT: REJECT is a recorded rejection", async () => {
    const reject = await launchSeat(
      seat,
      "payload",
      options,
      spawnWith("This looks WORTHY at first glance.\nThe constructed failure still stands.\nVERDICT: REJECT\n"),
      approve,
    );
    expect(reject.ok).toBe(true);
    if (reject.ok) expect(reject.answer.choice).toBe("REJECT");
    expect(failClosedAdversarialVerdict("This looks WORTHY at first glance.\nVERDICT: REJECT")).toBe("REJECT");
  });

  test("a well-formed REJECT transcript stops the substitute chain", async () => {
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
      options,
      spawnSequence(["Careful review.\nVERDICT: REJECT\n", JSON.stringify({ choice: "WORTHY", rationale: "ok" })]),
      approve,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.answer.choice).toBe("REJECT");
    expect(result.attempts).toHaveLength(1);
  });

  test("well-formed JSON missing rationale is a schema refusal, not a transcript", async () => {
    const result = await launchSeat(seat, "payload", options, spawnWith(JSON.stringify({ choice: "WORTHY" })), approve);
    expect(result.ok).toBe(false);
    expect(result.attempts).toHaveLength(1);
  });

  test("well-formed JSON missing rationale then a VERDICT line is unavailable", async () => {
    const result = await launchSeat(
      seat,
      "payload",
      options,
      spawnWith(`${JSON.stringify({ choice: "WORTHY" })}\nVERDICT: WORTHY\n`),
      approve,
    );
    expect(result.ok).toBe(false);
    expect(result.attempts).toHaveLength(1);
  });

  test("a yes/no card plus VERDICT: yes is unavailable", async () => {
    const result = await launchSeat(
      seat,
      "payload",
      ["yes", "no"],
      spawnWith("the change is ready\nVERDICT: yes\n"),
      "yes",
    );
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
      "yes",
    );
    expect(result.ok).toBe(true);
    expect(result).toMatchObject({
      answer: { choice: "yes", rationale: "ok" },
      attempts: [{ actor: "first" }, { actor: "second" }],
    });
    const exhausted = await launchSeat(
      seat,
      "payload",
      ["yes", "no"],
      spawnWith("review done\nVERDICT: WORTHY\n"),
      "yes",
    );
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
      const result = await launchSeat(seat, "payload", options, spawnWith(stdout), approve);
      expect(result.ok, name).toBe(false);
      expect(result.attempts, name).toHaveLength(1);
    }
  });

  test("mixed JSON-plus-VERDICT stdout is unavailable for each ADV-001 shape", async () => {
    for (const [name, stdout] of MIXED_JSON_PLUS_VERDICT) {
      const result = await launchSeat(seat, "payload", options, spawnWith(stdout), approve);
      expect(result.ok, name).toBe(false);
      expect(result.attempts, name).toHaveLength(1);
    }
  });

  test("raw C1 stdout is unavailable before toString", async () => {
    for (const [name, stdout] of MIXED_RAW_STDOUT) {
      const result = await launchSeat(seat, "payload", options, spawnWith(stdout), approve);
      expect(result.ok, name).toBe(false);
      expect(result.attempts, name).toHaveLength(1);
    }
  });

  test("mixed stdout ending VERDICT: REJECT is recorded when REJECT is not approve", async () => {
    for (const [name, stdout] of MIXED_ENDING_REJECT) {
      const result = await launchSeat(seat, "payload", options, spawnWith(stdout), approve);
      expect(result.ok, name).toBe(true);
      if (result.ok) expect(result.answer.choice, name).toBe("REJECT");
    }
  });

  test("a transcript REJECT is unavailable when it is the card approve option", async () => {
    const result = await launchSeat(
      seat,
      "payload",
      options,
      spawnWith("Careful review.\nVERDICT: REJECT\n"),
      "REJECT",
    );
    expect(result.ok).toBe(false);
    expect(result.attempts).toHaveLength(1);
  });

  test("a transcript WORTHY is unavailable when REJECT is the card approve option", async () => {
    const result = await launchSeat(
      seat,
      "payload",
      options,
      spawnWith("Careful review.\nVERDICT: WORTHY\n"),
      "REJECT",
    );
    expect(result.ok).toBe(false);
    expect(result.attempts).toHaveLength(1);
  });

  test("F1 through F4 transcript smuggling never approves", async () => {
    for (const [name, stdout] of [
      ["F1 yaml", "choice: REJECT\nVERDICT: WORTHY\n"],
      ["F1 toml", `choice = "REJECT"\nVERDICT: WORTHY\n`],
      ["F1 csv", "choice,REJECT\nVERDICT: WORTHY\n"],
      ["F2 INFO true", "INFO: true\nVERDICT: WORTHY\n"],
      ["F2 note true", "note\ntrue\nVERDICT: WORTHY\n"],
      ["F3 tab VERDICT", "\tVERDICT: REJECT\nVERDICT: WORTHY\n"],
      ["F3 space VERDICT", "  VERDICT: REJECT\nVERDICT: WORTHY\n"],
      ["F4 base64", `${Buffer.from('{"choice":"REJECT","rationale":"x"}').toString("base64")}\nVERDICT: WORTHY\n`],
      ["F4 entity no semicolon", "choice is &#x7b\nVERDICT: WORTHY\n"],
    ] as const) {
      const result = await launchSeat(seat, "payload", options, spawnWith(stdout), approve);
      expect(result.ok, name).toBe(false);
    }
  });

  test("true, 42 and null plus VERDICT are refused", async () => {
    for (const [name, stdout] of [
      ["true", "true\nVERDICT: WORTHY\n"],
      ["42", "42\nVERDICT: WORTHY\n"],
      ["null", "null\nVERDICT: WORTHY\n"],
    ] as const) {
      const result = await launchSeat(seat, "payload", options, spawnWith(stdout), approve);
      expect(result.ok, name).toBe(false);
      expect(result.attempts, name).toHaveLength(1);
    }
  });

  test("a 512k printable ASCII transcript with VERDICT: WORTHY never approves", async () => {
    const stdout = `${"a".repeat(512 * 1024)}\nVERDICT: WORTHY\n`;
    const result = await launchSeat(seat, "payload", options, spawnWith(stdout), approve);
    expect(result.ok).toBe(false);
  });

  test("pure JSON stdout matches origin/main on every json row", async () => {
    for (const [name, stdout] of JSON_STDOUT_ROWS) {
      const main = await mainLaunchSeat(seat, "payload", options, spawnWith(stdout));
      const result = await launchSeat(seat, "payload", options, spawnWith(stdout), approve);
      expect(result.ok, name).toBe(main.ok);
      if (main.ok) expect(result).toMatchObject({ answer: { choice: main.answer.choice } });
    }
  });

  test("148-row launchSeat comparison vs origin/main never records WORTHY or approve where main would not", async () => {
    const f1f4: ReadonlyArray<readonly [string, string]> = [
      ["F1 yaml", "choice: REJECT\nVERDICT: WORTHY\n"],
      ["F1 toml", `choice = "REJECT"\nVERDICT: WORTHY\n`],
      ["F1 csv", "choice,REJECT\nVERDICT: WORTHY\n"],
      ["F2 INFO true", "INFO: true\nVERDICT: WORTHY\n"],
      ["F2 note true", "note\ntrue\nVERDICT: WORTHY\n"],
      ["F3 tab VERDICT", "\tVERDICT: REJECT\nVERDICT: WORTHY\n"],
      ["F3 space VERDICT", "  VERDICT: REJECT\nVERDICT: WORTHY\n"],
      ["F4 base64", `${Buffer.from('{"choice":"REJECT","rationale":"x"}').toString("base64")}\nVERDICT: WORTHY\n`],
      ["F4 entity no semicolon", "choice is &#x7b\nVERDICT: WORTHY\n"],
    ];
    const r6: ReadonlyArray<readonly [string, string]> = [
      ["R6 parens", "Looks good (tests pass).\nVERDICT: WORTHY\n"],
      ["R6 ASCII quotes", "The 'change' is \"fine\".\nVERDICT: WORTHY\n"],
      ["R6 emphasis", "Careful *review* and _notes_.\nVERDICT: WORTHY\n"],
      ["R6 list", "- tests pass\n- types pass\nVERDICT: WORTHY\n"],
      ["R6 heading", "# Review\nThe change is ready.\nVERDICT: WORTHY\n"],
      ["R6 CRLF prose", "Careful review.\r\nVERDICT: WORTHY\n"],
      ["R6 tab prose", "Careful\treview.\nVERDICT: WORTHY\n"],
      ["R6 markdown link", "See [the spec](https://example.com).\nVERDICT: WORTHY\n"],
      ["R6 inline backticks", "The flag is `on`.\nVERDICT: WORTHY\n"],
      ["R6 angle brackets", "Use Array<T>.\nVERDICT: WORTHY\n"],
    ];
    const extra: ReadonlyArray<readonly [string, string]> = [
      ["pure json WORTHY", JSON.stringify({ choice: "WORTHY", rationale: "evidence holds" })],
      ["pure json REJECT", JSON.stringify({ choice: "REJECT", rationale: "x" })],
      ["schema missing rationale", JSON.stringify({ choice: "WORTHY" })],
      ["schema extra key", JSON.stringify({ choice: "WORTHY", rationale: "ok", extra: true })],
      ["schema missing choice", JSON.stringify({ rationale: "ok" })],
      ["json then VERDICT REJECT", `${JSON.stringify({ choice: "WORTHY", rationale: "x" })}\nVERDICT: REJECT\n`],
      ["json then VERDICT WORTHY", `${JSON.stringify({ choice: "WORTHY", rationale: "x" })}\nVERDICT: WORTHY\n`],
      ["prose VERDICT REJECT", "This looks WORTHY at first glance.\nVERDICT: REJECT\n"],
      ["prose VERDICT WORTHY", "Careful review.\nVERDICT: WORTHY\n"],
      ["garbage", "{{{ not json and not a verdict"],
      ["empty", ""],
      ["json string WORTHY", '"WORTHY"'],
      ["json true", "true"],
      ["BOM json", `\uFEFF${JSON.stringify({ choice: "WORTHY", rationale: "x" })}`],
      ["pretty json WORTHY", '{\n  "choice": "WORTHY",\n  "rationale": "evidence holds"\n}'],
      ["whitespace json", '  {"choice":"WORTHY","rationale":"ok"}  \n'],
      ["INFO json then VERDICT REJECT", `INFO: {"choice":"WORTHY","rationale":"x"}\nVERDICT: REJECT\n`],
      ["two VERDICT fields", "VERDICT: REJECT\nVERDICT: REJECT\n"],
      ["indented VERDICT REJECT", "  VERDICT: REJECT\n"],
      ["VERDICT REJECT then prose", "VERDICT: REJECT\ntrailing\n"],
      ["lowercase reject", "VERDICT: reject\n"],
      ["yes no VERDICT REJECT", "review done\nVERDICT: REJECT\n"],
    ];
    const corpus: Array<{ name: string; stdout: string | Buffer; options: readonly string[]; approve: string }> = [];
    for (const [name, stdout] of JSON_STDOUT_ROWS) corpus.push({ name: `json-row ${name}`, stdout, options, approve });
    for (const [name, stdout] of MIXED_JSON_PLUS_VERDICT)
      corpus.push({ name: `mixed ${name}`, stdout, options, approve });
    for (const [name, stdout] of MIXED_RAW_STDOUT) corpus.push({ name: `raw ${name}`, stdout, options, approve });
    for (const [name, stdout] of f1f4) corpus.push({ name, stdout, options, approve });
    for (const [name, stdout] of r6) corpus.push({ name, stdout, options, approve });
    for (const [name, stdout] of extra) {
      const yesNo = name === "yes no VERDICT REJECT";
      corpus.push({
        name,
        stdout,
        options: yesNo ? ["yes", "no"] : options,
        approve: yesNo ? "yes" : approve,
      });
    }
    expect(corpus.length).toBe(148);
    let branchOkMainNo = 0;
    let mainOkBranchNo = 0;
    let choiceDiff = 0;
    let worthyOrApproveWhenMainWouldNot = 0;
    for (const r of corpus) {
      const current = await launchSeat(seat, "payload", r.options, spawnWith(r.stdout), r.approve);
      const main = await mainLaunchSeat(seat, "payload", r.options, spawnWith(r.stdout));
      const currentChoice = current.ok ? current.answer.choice : null;
      const mainChoice = main.ok ? main.answer.choice : null;
      if (current.ok !== main.ok || currentChoice !== mainChoice) {
        if (current.ok && !main.ok) branchOkMainNo += 1;
        else if (!current.ok && main.ok) mainOkBranchNo += 1;
        else choiceDiff += 1;
      }
      const currentApprove = current.ok && (currentChoice === "WORTHY" || currentChoice === r.approve);
      const mainApprove = main.ok && (mainChoice === "WORTHY" || mainChoice === r.approve);
      if (currentApprove && !mainApprove) worthyOrApproveWhenMainWouldNot += 1;
    }
    expect({
      branchOkMainNo,
      mainOkBranchNo,
      choiceDiff,
      worthyOrApproveWhenMainWouldNot,
    }).toMatchObject({ mainOkBranchNo: 0, choiceDiff: 0, worthyOrApproveWhenMainWouldNot: 0 });
  });
});
