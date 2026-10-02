/**
 * The eval matrix loader and the reviewer panel: a reviewer bound like its subject is refused and
 * its seat reported unavailable, never filled; too few independent reviewers makes the panel
 * unavailable; disagreement goes to the human-label queue; κ comes out of the labelled queue.
 * Judges are stubbed, so no host CLI runs here.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_MATRIX,
  effectiveMaxTurns,
  loadMatrix,
  type Matrix,
  parseMatrix,
  type Seat,
  turnCapReceipt,
} from "./evals/matrix.ts";
import { buildPanel, calibration, grade, type Judge, parseVote, readQueue } from "./evals/panel.ts";
import { loadPriceTable } from "./evals/pricing.ts";
import type { SessionResult } from "./evals/subjects/types.ts";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "ak-panel-test-")));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const seat = (id: string, host: Seat["host"], model: string): Seat => ({ id, host, model });
const rules = { "independent-of": "subject", "min-reviewers": 2 } as const;

describe("matrix", () => {
  test("the committed example parses and binds roles and hosts only", () => {
    const text = readFileSync(join(import.meta.dir, "evals", "eval-matrix.example.yaml"), "utf8");
    const m = parseMatrix(text);
    expect(m.subjects.map((s) => s.id)).toEqual(["subject-a", "subject-b", "subject-c"]);
    expect(m.subjects.map((s) => s.maxTurns)).toEqual([20, null, null]);
    expect(m.priceTable).toBe("research/evals/codex-token-prices-2026-10-02.json");
    if (m.priceTable === undefined) throw new Error("the example has no price table");
    const prices = loadPriceTable(join(import.meta.dir, "..", "..", m.priceTable));
    expect(prices.version).toBe(1);
    expect(prices.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Object.keys(prices.models).length).toBeGreaterThan(0);
    expect(m.reviewers.map((r) => r.host)).toEqual(["claude", "codex", "grok"]);
    expect(m.panels).toEqual(rules);
    // No line of the example starts with a `model:` key, the shape the catalog's routing scan looks for.
    expect(text.split("\n").some((line) => /^\s*-?\s*model\s*[:=]/.test(line))).toBe(false);
  });

  test("rejects an unknown host, a panel under two reviewers, a duplicate id and another independence rule", () => {
    const bad = (yaml: string) => () => parseMatrix(yaml);
    const ok =
      "reviewers: [{id: r-a, host: codex, model: x}, {id: r-b, host: grok, model: y}]\npanels: {independent-of: subject, min-reviewers: 2}\n";
    expect(bad(`subjects: [{id: s-a, host: other, model: m}]\n${ok}`)).toThrow(/host/);
    expect(
      bad(`subjects: [{id: s-a, host: claude, model: m}]\n${ok.replace("min-reviewers: 2", "min-reviewers: 1")}`),
    ).toThrow(/min-reviewers/);
    expect(bad(`subjects: [{id: r-a, host: claude, model: m}]\n${ok}`)).toThrow(/appears twice/);
    expect(bad(`subjects: [{id: s-a, host: claude, model: m}]\n${ok.replace("subject", "author")}`)).toThrow(
      /independent-of/,
    );
  });

  test("an absent matrix file falls back to one unbound claude subject and no reviewers", () => {
    const m = loadMatrix(join(scratch, "absent.yaml"));
    expect(m.subjects).toEqual([{ id: "subject-default", host: "claude", model: undefined }]);
    expect(m.reviewers).toEqual([]);
    m.subjects.push({ id: "subject-b", host: "codex", model: undefined });
    expect(DEFAULT_MATRIX.subjects).toHaveLength(1);
    expect(buildPanel(m, m.subjects[0]!).status).toBe("unavailable");
  });

  test("a subject may leave its binding to the host; a reviewer may not", () => {
    const tail =
      "reviewers: [{id: r-a, host: codex, model: x}, {id: r-b, host: grok, model: y}]\npanels: {independent-of: subject, min-reviewers: 2}\n";
    expect(parseMatrix(`subjects: [{id: s-a, host: claude}]\n${tail}`).subjects[0]!.model).toBeUndefined();
    expect(() => parseMatrix(`subjects: [{id: s-a, host: claude}]\n${tail.replace(", model: y", "")}`)).toThrow(
      /model/,
    );
  });

  test("a subject turn cap distinguishes an override, no cap, and the evaluator default", () => {
    const tail =
      "reviewers: [{id: r-a, host: codex, model: x}, {id: r-b, host: grok, model: y}]\npanels: {independent-of: subject, min-reviewers: 2}\n";
    const matrix = parseMatrix(
      "subjects:\n" +
        "  - {id: s-a, host: claude, max-turns: 12}\n" +
        "  - {id: s-b, host: grok, max-turns: null}\n" +
        "  - {id: s-c, host: claude}\n" +
        tail,
    );
    expect(matrix.subjects.map(({ id, maxTurns }) => [id, maxTurns])).toEqual([
      ["s-a", 12],
      ["s-b", null],
      ["s-c", undefined],
    ]);
  });

  test("the example leaves Grok uncapped because its cancellation stream cannot distinguish the cap from refusal", () => {
    const example = parseMatrix(readFileSync(join(import.meta.dir, "evals", "eval-matrix.example.yaml"), "utf8"));
    const subject = example.subjects.find(({ host }) => host === "grok");
    expect(subject?.maxTurns).toBeNull();
    expect(subject === undefined ? undefined : effectiveMaxTurns(subject)).toBeUndefined();
  });

  test("a numeric turn cap is refused for a host that cannot enforce one", () => {
    const yaml =
      "subjects: [{id: s-a, host: codex, max-turns: 4}]\n" +
      "reviewers: [{id: r-a, host: claude, model: x}, {id: r-b, host: grok, model: y}]\n" +
      "panels: {independent-of: subject, min-reviewers: 2}\n";
    expect(() => parseMatrix(yaml)).toThrow("subject 's-a' uses host 'codex', which cannot enforce max-turns");
  });

  test("the effective cap applies an override, explicit removal, documented default, and host capability", () => {
    expect(effectiveMaxTurns({ id: "s-a", host: "claude", model: undefined, maxTurns: 12 })).toBe(12);
    expect(effectiveMaxTurns({ id: "s-b", host: "grok", model: undefined, maxTurns: null })).toBeUndefined();
    expect(effectiveMaxTurns({ id: "s-c", host: "claude", model: undefined, maxTurns: 20 })).toBe(20);
    expect(effectiveMaxTurns({ id: "s-d", host: "codex", model: undefined, maxTurns: null })).toBeUndefined();
    const [unbound] = loadMatrix(join(scratch, "absent.yaml")).subjects;
    if (!unbound) throw new Error("the default matrix has no subject");
    expect(effectiveMaxTurns(unbound)).toBe(20);
    expect(effectiveMaxTurns(unbound, 15)).toBe(15);
  });

  test("the receipt records each subject's effective cap, including no cap", () => {
    expect(turnCapReceipt({ id: "s-a", host: "claude", model: undefined, maxTurns: 12 })).toEqual({ max_turns: 12 });
    expect(turnCapReceipt({ id: "s-b", host: "grok", model: undefined, maxTurns: null })).toEqual({
      max_turns: null,
    });
    expect(turnCapReceipt({ id: "s-c", host: "claude", model: undefined, maxTurns: 20 })).toEqual({ max_turns: 20 });
    expect(turnCapReceipt({ id: "s-d", host: "codex", model: undefined, maxTurns: null })).toEqual({ max_turns: null });
  });

  test("the optional price table must be a path under research/", () => {
    const tail =
      "reviewers: [{id: r-a, host: codex, model: x}, {id: r-b, host: grok, model: y}]\n" +
      "panels: {independent-of: subject, min-reviewers: 2}\n";
    const subjects = "subjects: [{id: s-a, host: claude}]\n";
    expect(parseMatrix(subjects + "price-table: research/evals/prices.json\n" + tail).priceTable).toBe(
      "research/evals/prices.json",
    );
    expect(parseMatrix(subjects + tail).priceTable).toBeUndefined();
    for (const path of [".work/prices.json", "provenance/prices.json", "research/../prices.json"])
      expect(() => parseMatrix(`${subjects}price-table: ${path}\n${tail}`)).toThrow(/price-table/);
  });
});

describe("buildPanel", () => {
  const subject = seat("subject-a", "claude", "bind-1");

  test("a reviewer bound like the subject is refused and its seat reported unavailable, not filled", () => {
    const reviewers = [
      seat("reviewer-a", "claude", "bind-1"),
      seat("reviewer-b", "codex", "bind-2"),
      seat("reviewer-c", "grok", "bind-3"),
    ];
    const panel = buildPanel({ reviewers, panels: rules }, subject);
    expect(panel.status).toBe("available");
    expect(panel.members.map((m) => m.id)).toEqual(["reviewer-b", "reviewer-c"]);
    expect(panel.seats.find((s) => s.reviewer.id === "reviewer-a")).toMatchObject({
      status: "unavailable",
      reason: "bound like subject subject-a",
    });
    expect(panel.members.some((m) => m.model === subject.model)).toBe(false);
  });

  test("fewer than two independent reviewers makes the panel unavailable; the refused seat is not backfilled", () => {
    const reviewers = [seat("reviewer-a", "claude", "bind-1"), seat("reviewer-b", "codex", "bind-2")];
    const panel = buildPanel({ reviewers, panels: rules }, subject);
    expect(panel.status).toBe("unavailable");
    expect(panel.reason).toMatch(/1 independent reviewer\(s\) for subject-a, 2 required/);
    expect(panel.members.map((m) => m.id)).toEqual(["reviewer-b"]);
    expect(panel.seats.map((s) => s.status)).toEqual(["unavailable", "seated"]);
  });

  test("a second reviewer bound like a seated one is a duplicate judgment, not an independent seat", () => {
    const reviewers = [seat("reviewer-a", "codex", "bind-2"), seat("reviewer-b", "grok", "bind-2")];
    const panel = buildPanel({ reviewers, panels: rules }, subject);
    expect(panel.status).toBe("unavailable");
    expect(panel.seats[1]).toMatchObject({ status: "unavailable", reason: "bound like reviewer-a, already seated" });
  });

  test("an unbound subject runs its host's default, so no reviewer on that host is independent of it", () => {
    const reviewers = [
      seat("reviewer-a", "claude", "bind-9"),
      seat("reviewer-b", "codex", "bind-2"),
      seat("reviewer-c", "grok", "bind-3"),
    ];
    const panel = buildPanel({ reviewers, panels: rules }, { id: "subject-a", host: "claude", model: undefined });
    expect(panel.members.map((m) => m.id)).toEqual(["reviewer-b", "reviewer-c"]);
    expect(panel.seats[0]).toMatchObject({
      status: "unavailable",
      reason: "subject subject-a runs the claude default binding",
    });
  });

  test("seating prefers hosts other than the subject's, then hosts not yet on the panel", () => {
    const reviewers = [
      seat("reviewer-a", "claude", "bind-4"),
      seat("reviewer-b", "codex", "bind-2"),
      seat("reviewer-c", "codex", "bind-5"),
      seat("reviewer-d", "grok", "bind-3"),
    ];
    const panel = buildPanel({ reviewers, panels: { ...rules, size: 2 } }, subject);
    expect(panel.members.map((m) => m.id)).toEqual(["reviewer-b", "reviewer-d"]);
    expect(panel.hosts).toEqual(["codex", "grok"]);
    expect(panel.seats.filter((s) => s.status === "unused").map((s) => s.reviewer.id)).toEqual([
      "reviewer-a",
      "reviewer-c",
    ]);
  });
});

describe("grade", () => {
  const subject = seat("subject-a", "claude", "bind-1");
  const matrix: Pick<Matrix, "reviewers" | "panels"> = {
    reviewers: [seat("reviewer-b", "codex", "bind-2"), seat("reviewer-c", "grok", "bind-3")],
    panels: rules,
  };
  const panel = buildPanel(matrix, subject);
  const transcript: SessionResult = {
    subject: "subject-a",
    host: "claude",
    events: [{ kind: "tool", name: "Skill", raw: "Skill", input: { skill: "greet" } }],
    reply: "ok",
    exitCode: 0,
    timedOut: false,
    durationMs: 1,
  };
  const judges =
    (votes: Record<string, string>): Judge =>
    async (reviewer, prompt) => {
      expect(prompt).toContain("[tool Skill]");
      expect(prompt).toContain("<criteria>");
      return { reply: votes[reviewer.id]! };
    };

  test("unanimity is the verdict and nothing is queued", async () => {
    const queue = join(scratch, "unanimous.jsonl");
    const g = await grade(panel, transcript, "Loads greet.", {
      item: "c1",
      queue,
      judge: judges({
        "reviewer-b": '{"verdict":"PASS","reason":"loaded"}',
        "reviewer-c": 'Sure. {"verdict": "pass", "reason": "yes"}',
      }),
    });
    expect(g.verdict).toBe("PASS");
    expect(readQueue(queue)).toEqual([]);
  });

  test("disagreement is needs-human and lands in the queue with every vote and an empty label", async () => {
    const queue = join(scratch, "q", "disagree.jsonl");
    const g = await grade(panel, transcript, "Loads greet.", {
      item: "c2",
      queue,
      judge: judges({ "reviewer-b": '{"verdict":"PASS"}', "reviewer-c": '{"verdict":"FAIL","reason":"no"}' }),
    });
    expect(g).toMatchObject({
      verdict: "needs-human",
      reason: "reviewers disagree",
      votes: { "reviewer-b": "PASS", "reviewer-c": "FAIL" },
    });
    const [row] = readQueue(queue);
    expect(row).toMatchObject({ item: "c2", subject: "subject-a", label: null, panel_verdict: "needs-human" });
    expect(row!.transcript).toContain("[final reply] ok");
  });

  test("an unreadable reply is never counted as a vote", async () => {
    const queue = join(scratch, "invalid.jsonl");
    const g = await grade(panel, transcript, "c", {
      item: "c3",
      queue,
      judge: judges({ "reviewer-b": '{"verdict":"PASS"}', "reviewer-c": "I think it passes" }),
    });
    expect(g.verdict).toBe("needs-human");
    expect(g.reason).toBe("a reviewer gave no readable verdict");
    expect(readQueue(queue)).toHaveLength(1);
  });

  test("each reviewer's reported usage and cost are kept beside its vote", async () => {
    const usage = {
      inputTokens: 100,
      cachedInputTokens: 40,
      cacheWriteInputTokens: 0,
      outputTokens: 10,
      reasoningOutputTokens: 2,
      totalTokens: 110,
    };
    const g = await grade(panel, transcript, "c", {
      item: "c-usage",
      queue: join(scratch, "usage.jsonl"),
      judge: async (reviewer) =>
        reviewer.id === "reviewer-b"
          ? { reply: '{"verdict":"PASS"}', usage, costUsd: 0.5 }
          : { reply: '{"verdict":"PASS"}' },
    });
    expect(g.verdict).toBe("PASS");
    expect(g.usage).toEqual({ "reviewer-b": usage });
    expect(g.cost_usd).toEqual({ "reviewer-b": 0.5 });
  });

  test("an unavailable panel grades nothing and calls no judge", async () => {
    const lone = buildPanel(
      { reviewers: [seat("reviewer-a", "claude", "bind-1"), seat("reviewer-b", "codex", "bind-2")], panels: rules },
      subject,
    );
    const g = await grade(lone, transcript, "c", {
      item: "c4",
      queue: join(scratch, "none.jsonl"),
      judge: async () => {
        throw new Error("called");
      },
    });
    expect(g.verdict).toBe("unavailable");
  });

  test("calibrateEvery also queues unanimous items", async () => {
    const queue = join(scratch, "calibrate.jsonl");
    await grade(panel, transcript, "c", {
      item: "c5",
      queue,
      calibrateEvery: 1,
      judge: judges({ "reviewer-b": '{"verdict":"FAIL"}', "reviewer-c": '{"verdict":"FAIL"}' }),
    });
    expect(readQueue(queue)[0]).toMatchObject({ panel_verdict: "FAIL", label: null });
  });

  test("parseVote takes the last verdict object and ignores the rest", () => {
    expect(parseVote('{"verdict":"FAIL"} then {"verdict":"PASS","reason":"r"}')).toEqual({ vote: "PASS", reason: "r" });
    expect(parseVote("{not json}").vote).toBe("invalid");
  });
});

describe("calibration", () => {
  test("κ per reviewer pair and per reviewer against the human, from labelled rows only", () => {
    const queue = join(scratch, "labelled.jsonl");
    const row = (item: string, b: string, c: string, label: string | null) =>
      JSON.stringify({
        item,
        subject: "subject-a",
        criteria: "",
        transcript: "",
        votes: { "reviewer-b": b, "reviewer-c": c },
        reasons: {},
        panel_verdict: "needs-human",
        label,
      });
    writeFileSync(
      queue,
      [
        row("i1", "PASS", "FAIL", "PASS"),
        row("i2", "FAIL", "PASS", "FAIL"),
        row("i3", "PASS", "PASS", "PASS"),
        row("i4", "FAIL", "FAIL", "FAIL"),
        row("i5", "PASS", "invalid", null),
      ].join("\n") + "\n",
    );
    const { labelled, kappa } = calibration(queue);
    expect(labelled).toBe(4);
    const k = (a: string, b: string) => kappa.find((r) => r.a === a && r.b === b)!;
    expect(k("human", "reviewer-b")).toMatchObject({ n: 4, kappa: 1 });
    expect(k("human", "reviewer-c")).toMatchObject({ n: 4, kappa: 0 });
    expect(k("reviewer-b", "reviewer-c")).toMatchObject({ n: 4, kappa: 0 });
  });
});
