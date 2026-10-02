/**
 * The committed case runner against stored transcript shapes. No host CLI runs here: each adapter
 * parses one fixture, while judge replies are deterministic test doubles.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import {
  type CaseGrader,
  evaluateCaseSession,
  loadCase,
  main as caseRunnerMain,
  summariseCaseSessions,
} from "./evals/case-runner.ts";
import type { Matrix, Subject } from "./evals/matrix.ts";
import { buildPanel, type Judge } from "./evals/panel.ts";
import { adapterFor } from "./evals/subjects/index.ts";
import type { HostKind, SessionResult } from "./evals/subjects/types.ts";

const FIXTURES = join(import.meta.dir, "evals", "fixtures", "case-runner");
const CASE_FILE = join(FIXTURES, "case.yaml");
const work: string[] = [];

interface StoredReport {
  receipt: { cases: Array<{ sha256: string }> };
  results: Array<{ command: string[]; files_created: string[]; graders: Array<{ definition: CaseGrader }> }>;
}

interface DryPlan {
  mode: "dry-run";
  subject: string;
  case: string;
  command: string[];
}

const ajv = new Ajv2020({ strict: false });
const isStoredReport = ajv.compile<StoredReport>({
  type: "object",
  required: ["receipt", "results"],
  properties: {
    receipt: {
      type: "object",
      required: ["cases"],
      properties: { cases: { type: "array", items: { type: "object", required: ["sha256"] } } },
    },
    results: {
      type: "array",
      items: {
        type: "object",
        required: ["command", "files_created", "graders"],
        properties: {
          command: { type: "array", items: { type: "string" } },
          files_created: { type: "array", items: { type: "string" } },
          graders: { type: "array", items: { type: "object", required: ["definition"] } },
        },
      },
    },
  },
});
const isAbortedReport = ajv.compile<{
  receipt: { cost_usd: number | null; aborted: { subject: string; reason: string } };
  results: unknown[];
}>({
  type: "object",
  required: ["receipt", "results"],
  properties: {
    receipt: {
      type: "object",
      required: ["cost_usd", "aborted"],
      properties: {
        cost_usd: { type: ["number", "null"] },
        aborted: {
          type: "object",
          required: ["subject", "reason"],
          properties: { subject: { type: "string" }, reason: { type: "string" } },
        },
      },
    },
    results: { type: "array" },
  },
});
const isDryPlan = ajv.compile<DryPlan>({
  type: "object",
  required: ["mode", "subject", "case", "command"],
  properties: {
    mode: { const: "dry-run" },
    subject: { type: "string" },
    case: { type: "string" },
    command: { type: "array", items: { type: "string" } },
  },
});

afterEach(() => {
  for (const dir of work.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const matrix: Matrix = {
  subjects: [],
  reviewers: [
    { id: "reviewer-a", host: "claude", model: "review-binding-a" },
    { id: "reviewer-b", host: "codex", model: "review-binding-b" },
    { id: "reviewer-c", host: "grok", model: "review-binding-c" },
  ],
  panels: { "independent-of": "subject", "min-reviewers": 2, size: 2 },
};

function session(host: HostKind, fixture: string, overrides: Partial<SessionResult> = {}): SessionResult {
  const parsed = adapterFor(host).parse(readFileSync(join(FIXTURES, fixture), "utf8"));
  return {
    subject: `subject-${host}`,
    host,
    ...parsed,
    exitCode: 0,
    timedOut: false,
    durationMs: 10,
    ...overrides,
  };
}

function subject(host: HostKind): Subject {
  return { id: `subject-${host}`, host, model: "subject-binding" };
}

describe("evaluateCaseSession", () => {
  test.each([
    ["claude", "claude.jsonl"],
    ["codex", "codex.jsonl"],
    ["grok", "grok.jsonl"],
  ] as const)("applies tool, reply and file-focused graders to the %s transcript shape", async (host, fixture) => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), `ak-case-runner-${host}-`)));
    work.push(cwd);
    mkdirSync(join(cwd, "tickets"));
    writeFileSync(join(cwd, "tickets", "result.json"), '{"class":"red","owner":"Maya Chen"}\n');
    const prompts: string[] = [];
    const judge: Judge = async (_reviewer, prompt) => {
      prompts.push(prompt);
      return { reply: '{"verdict":"PASS","reason":"fixture satisfies the criterion"}' };
    };
    const result = await evaluateCaseSession(loadCase(CASE_FILE), session(host, fixture), {
      cwd,
      filesCreated: ["tickets/result.json"],
      panel: buildPanel(matrix, subject(host)),
      queue: join(cwd, "queue.jsonl"),
      judge,
    });

    expect(result).toMatchObject({ validity: "valid", result: "pass", score: 1 });
    expect(result.graders.map((grader) => [grader.name, grader.verdict])).toEqual([
      ["runs-the-scorer", "pass"],
      ["reports-the-result", "pass"],
      ["persists-the-result", "pass"],
    ]);
    expect(prompts.some((prompt) => prompt.includes("The delegation assessment was recorded."))).toBe(true);
    expect(prompts.some((prompt) => prompt.includes('"owner":"Maya Chen"'))).toBe(true);
  });

  test("a host-cancelled session is listed as invalid and excluded from results without calling a grader", async () => {
    const parsed = adapterFor("grok").parse(
      readFileSync(join(import.meta.dir, "evals", "fixtures", "transcripts", "grok-cancelled-read.jsonl"), "utf8"),
    );
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "ak-case-runner-invalid-")));
    work.push(cwd);
    const row = await evaluateCaseSession(
      loadCase(CASE_FILE),
      {
        subject: "subject-grok",
        host: "grok",
        events: parsed.events,
        reply: parsed.reply,
        stopReason: parsed.stopReason,
        exitCode: 1,
        timedOut: false,
        durationMs: 10,
      },
      {
        cwd,
        filesCreated: [],
        panel: buildPanel(matrix, subject("grok")),
        queue: join(cwd, "queue.jsonl"),
        judge: async () => {
          throw new Error("invalid session reached a grader");
        },
      },
    );

    expect(row).toMatchObject({ validity: "invalid", result: null });
    expect(row.invalid_reason).toMatch(/^host cancelled refused Bash call:/);
    expect(row.graders).toEqual([]);
    expect(summariseCaseSessions([row])).toMatchObject({
      results: [],
      invalid_sessions: [{ subject: "subject-grok" }],
    });
  });
});

describe("execute path", () => {
  test.each([
    ["claude", "claude.jsonl", "claude"],
    ["codex", "codex.jsonl", "codex"],
    ["grok", "grok.jsonl", "grok"],
  ] as const)("runs the %s transcript fixture through the receipt path", async (host, fixture, binary) => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), `ak-case-runner-main-${host}-`)));
    work.push(cwd);
    const bundle = join(cwd, "dist");
    mkdirSync(join(bundle, "claude-code"), { recursive: true });
    mkdirSync(join(bundle, "codex"), { recursive: true });
    const json = join(cwd, "result.json");
    const selected = subject(host);
    const start = session(host, fixture);
    const code = await caseRunnerMain(
      ["--execute", "--subject", selected.id, "--case", CASE_FILE, "--bundle", bundle, "--json", json],
      {
        matrix: { ...matrix, subjects: [selected] },
        out: () => {},
        startSubject: async (_adapter, id, _model, request) => {
          expect(id).toBe(selected.id);
          expect(request.allowedTools).toEqual(["Read", "Bash", "Write"]);
          mkdirSync(join(request.cwd, "tickets"));
          writeFileSync(join(request.cwd, "tickets", "result.json"), '{"class":"red","owner":"Maya Chen"}\n');
          return { ...start, subject: id };
        },
        judge: async () => ({ reply: '{"verdict":"PASS","reason":"fixture satisfies the criterion"}' }),
      },
    );
    const parsedReport: unknown = JSON.parse(readFileSync(json, "utf8"));
    if (!isStoredReport(parsedReport)) throw new Error("case runner wrote an invalid test receipt");
    const result = parsedReport.results.at(0);
    const receiptCase = parsedReport.receipt.cases.at(0);
    if (result === undefined || receiptCase === undefined) throw new Error("case runner wrote no test result");

    expect(code).toBe(0);
    expect(result.command.at(0)).toBe(binary);
    expect(result.files_created).toContain("tickets/result.json");
    expect(result.graders.map(({ definition }) => definition)).toEqual(loadCase(CASE_FILE).graders);
    expect(receiptCase.sha256).toBe(loadCase(CASE_FILE).sha256);
  });

  test("checks every subject's bundle before starting any session", async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "ak-case-runner-bundles-")));
    work.push(cwd);
    const bundle = join(cwd, "dist");
    mkdirSync(join(bundle, "claude-code"), { recursive: true });
    const json = join(cwd, "result.json");
    const errors: string[] = [];
    let started = 0;
    const code = await caseRunnerMain(
      [
        "--execute",
        "--subject",
        "subject-grok",
        "--subject",
        "subject-codex",
        "--case",
        CASE_FILE,
        "--bundle",
        bundle,
        "--json",
        json,
      ],
      {
        matrix: { ...matrix, subjects: [subject("grok"), subject("codex")] },
        out: () => {},
        err: (line) => errors.push(line),
        startSubject: async () => {
          started += 1;
          throw new Error("a session started before the bundle check");
        },
      },
    );

    expect(code).toBe(2);
    expect(started).toBe(0);
    expect(errors.join("\n")).toContain(join(bundle, "codex"));
  });

  test("writes the completed rows and the aborted session when a later session throws", async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "ak-case-runner-abort-")));
    work.push(cwd);
    const bundle = join(cwd, "dist");
    mkdirSync(join(bundle, "claude-code"), { recursive: true });
    mkdirSync(join(bundle, "codex"), { recursive: true });
    const json = join(cwd, "result.json");
    const errors: string[] = [];
    const code = await caseRunnerMain(
      [
        "--execute",
        "--subject",
        "subject-grok",
        "--subject",
        "subject-codex",
        "--case",
        CASE_FILE,
        "--bundle",
        bundle,
        "--json",
        json,
      ],
      {
        matrix: { ...matrix, subjects: [subject("grok"), subject("codex")] },
        out: () => {},
        err: (line) => errors.push(line),
        startSubject: async (_adapter, id, _model, request) => {
          if (id === "subject-codex") throw new Error("host exited before a transcript");
          mkdirSync(join(request.cwd, "tickets"));
          writeFileSync(join(request.cwd, "tickets", "result.json"), '{"class":"red","owner":"Maya Chen"}\n');
          return { ...session("grok", "grok.jsonl"), subject: id, costUsd: 0.25 };
        },
        judge: async () => ({ reply: '{"verdict":"PASS","reason":"fixture satisfies the criterion"}' }),
      },
    );
    const report: unknown = JSON.parse(readFileSync(json, "utf8"));
    if (!isAbortedReport(report)) throw new Error("case runner wrote an invalid aborted receipt");

    expect(code).toBe(2);
    expect(report.results).toHaveLength(1);
    expect(report.receipt.cost_usd).toBe(0.25);
    expect(report.receipt.aborted).toMatchObject({
      subject: "subject-codex",
      reason: "host exited before a transcript",
    });
    expect(errors.join("\n")).toContain("host exited before a transcript");
  });

  test("counts a paid session whose grading throws in the receipt spend", async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "ak-case-runner-judge-abort-")));
    work.push(cwd);
    const bundle = join(cwd, "dist");
    mkdirSync(join(bundle, "claude-code"), { recursive: true });
    mkdirSync(join(bundle, "codex"), { recursive: true });
    const json = join(cwd, "result.json");
    const errors: string[] = [];
    let codexStarted = false;
    const code = await caseRunnerMain(
      [
        "--execute",
        "--subject",
        "subject-grok",
        "--subject",
        "subject-codex",
        "--case",
        CASE_FILE,
        "--bundle",
        bundle,
        "--json",
        json,
      ],
      {
        matrix: { ...matrix, subjects: [subject("grok"), subject("codex")] },
        out: () => {},
        err: (line) => errors.push(line),
        startSubject: async (_adapter, id, _model, request) => {
          codexStarted = id === "subject-codex";
          mkdirSync(join(request.cwd, "tickets"));
          writeFileSync(join(request.cwd, "tickets", "result.json"), '{"class":"red","owner":"Maya Chen"}\n');
          return codexStarted
            ? { ...session("codex", "codex.jsonl"), subject: id, costUsd: 0.5 }
            : { ...session("grok", "grok.jsonl"), subject: id, costUsd: 0.25 };
        },
        judge: async () => {
          if (codexStarted) throw new Error("judge panel rejected");
          return { reply: '{"verdict":"PASS","reason":"fixture satisfies the criterion"}' };
        },
      },
    );
    const report: unknown = JSON.parse(readFileSync(json, "utf8"));
    if (!isAbortedReport(report)) throw new Error("case runner wrote an invalid aborted receipt");

    expect(code).toBe(2);
    expect(report.results).toHaveLength(1);
    expect(report.receipt.cost_usd).toBe(0.75);
    expect(report.receipt.aborted).toMatchObject({
      subject: "subject-codex",
      reason: "judge panel rejected",
    });
    expect(errors.join("\n")).toContain("judge panel rejected");
  });
});

describe("dry run", () => {
  test("prints the exact eight subject-case sessions and starts none", async () => {
    const cases = [
      "evals/super-bound/delegated-refresh-token-rotation/case.yaml",
      "evals/super-bound/vague-checkout-speed-criterion/case.yaml",
      "evals/super-bound/refused-oversized-change-split/case.yaml",
      "evals/super-bound/approved-spec-produces-tickets/case.yaml",
    ];
    const subjects: Subject[] = [
      { id: "subject-b", host: "codex", model: "subject-binding-b", maxTurns: null },
      { id: "subject-c", host: "grok", model: "subject-binding-c" },
    ];
    const lines: string[] = [];
    let started = 0;
    const code = await caseRunnerMain(
      ["--dry-run", ...subjects.flatMap(({ id }) => ["--subject", id]), ...cases.flatMap((file) => ["--case", file])],
      {
        matrix: { ...matrix, subjects },
        out: (line) => lines.push(line),
        startSubject: async () => {
          started += 1;
          throw new Error("dry run started a subject");
        },
      },
    );
    const plans = lines.map((line) => {
      const parsedPlan: unknown = JSON.parse(line);
      if (!isDryPlan(parsedPlan)) throw new Error("case runner printed an invalid dry-run row");
      return parsedPlan;
    });

    expect(code).toBe(0);
    expect(started).toBe(0);
    expect(plans.map(({ subject: id, case: name }) => `${id}:${name}`)).toEqual([
      "subject-b:super-bound-delegated-refresh-token-rotation",
      "subject-b:super-bound-vague-checkout-speed-criterion",
      "subject-b:super-bound-refused-oversized-change-split",
      "subject-b:approved-spec-produces-tickets",
      "subject-c:super-bound-delegated-refresh-token-rotation",
      "subject-c:super-bound-vague-checkout-speed-criterion",
      "subject-c:super-bound-refused-oversized-change-split",
      "subject-c:approved-spec-produces-tickets",
    ]);
    expect(plans.every((plan) => plan.mode === "dry-run" && Array.isArray(plan.command))).toBe(true);
    expect(plans.at(0)?.command.slice(0, 2)).toEqual(["codex", "exec"]);
    const finalCase = cases.at(-1);
    if (finalCase === undefined) throw new Error("the dry-run fixture has no final case");
    expect(plans.at(-1)?.command.slice(0, 3)).toEqual(["grok", "-p", loadCase(finalCase).execution.prompt]);
  });
});
