/**
 * The committed case runner against stored transcript shapes. No host CLI runs here: each adapter
 * parses one fixture, while judge replies are deterministic test doubles.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
import type { HostKind, SessionEvent, SessionResult } from "./evals/subjects/types.ts";

const FIXTURES = join(import.meta.dir, "evals", "fixtures", "case-runner");
const CASE_FILE = join(FIXTURES, "case.yaml");
const GRADER_REFERENCES = join(FIXTURES, "grader-references.json");
const work: string[] = [];

interface SessionFacts {
  raw_output_sha256: string | null;
  exit_code: number;
  timed_out: boolean;
}

interface StoredReport {
  receipt: {
    cases: Array<{ sha256: string }>;
    cost_usd: number | null;
    raw: { path: string; sha256: string };
    aborted: null | {
      subject: string;
      reason: string;
      files_created: string[];
      artifacts: Record<string, { sha256: string }>;
      served_model: string | null;
      session: SessionFacts | null;
    };
  };
  sessions: Array<{
    validity: "valid" | "invalid";
    command: string[];
    files_created: string[];
    artifacts: Record<string, { sha256: string }>;
    graders: Array<{ definition: CaseGrader }>;
    served_model: string | null;
    request_ids: string[];
    session_id: string | null;
    session: SessionFacts;
  }>;
}

interface RawReport {
  sessions: Array<{
    subject: string;
    session: SessionResult;
    artifacts: Record<string, { sha256: string; text?: string }>;
  }>;
  aborted: null | { session: SessionResult | null; artifacts: Record<string, { sha256: string; text?: string }> };
}

interface DryPlan {
  mode: "dry-run";
  subject: string;
  case: string;
  max_turns: number | null;
  timeout_ms: number;
  command: string[];
}

interface PreflightOutput {
  host: HostKind;
  ok: boolean;
  checks: Array<{ name: string; ok: boolean; detail: string }>;
}

const ajv = new Ajv2020({ strict: false });
const sessionFacts = {
  type: "object",
  required: ["raw_output_sha256", "exit_code", "timed_out"],
  additionalProperties: false,
  properties: {
    raw_output_sha256: { type: ["string", "null"] },
    exit_code: { type: "number" },
    timed_out: { type: "boolean" },
    duration_ms: { type: "number" },
    turns: { type: ["number", "null"] },
    stop_reason: { type: ["string", "null"] },
    usage: { type: ["object", "null"] },
  },
};
const artifactHashes = {
  type: "object",
  additionalProperties: {
    type: "object",
    required: ["sha256"],
    additionalProperties: false,
    properties: { sha256: { type: "string" } },
  },
};
const isStoredReport = ajv.compile<StoredReport>({
  type: "object",
  required: ["receipt", "sessions"],
  additionalProperties: false,
  properties: {
    receipt: {
      type: "object",
      required: ["cases", "cost_usd", "raw", "aborted"],
      properties: {
        cases: { type: "array", items: { type: "object", required: ["sha256"] } },
        cost_usd: { type: ["number", "null"] },
        raw: {
          type: "object",
          required: ["path", "sha256"],
          properties: { path: { type: "string" }, sha256: { type: "string" } },
        },
        aborted: {
          type: ["object", "null"],
          required: ["subject", "reason", "files_created", "artifacts", "served_model", "session"],
          properties: {
            subject: { type: "string" },
            reason: { type: "string" },
            files_created: { type: "array", items: { type: "string" } },
            artifacts: artifactHashes,
            served_model: { type: ["string", "null"] },
            session: { anyOf: [{ type: "null" }, sessionFacts] },
          },
        },
      },
    },
    sessions: {
      type: "array",
      items: {
        type: "object",
        required: [
          "validity",
          "command",
          "files_created",
          "artifacts",
          "graders",
          "served_model",
          "request_ids",
          "session_id",
          "session",
        ],
        properties: {
          validity: { enum: ["valid", "invalid"] },
          command: { type: "array", items: { type: "string" } },
          files_created: { type: "array", items: { type: "string" } },
          artifacts: artifactHashes,
          graders: { type: "array", items: { type: "object", required: ["definition"] } },
          served_model: { type: ["string", "null"] },
          request_ids: { type: "array", items: { type: "string" } },
          session_id: { type: ["string", "null"] },
          session: sessionFacts,
        },
      },
    },
  },
});
const isRawReport = ajv.compile<RawReport>({
  type: "object",
  required: ["sessions", "aborted"],
  properties: {
    sessions: {
      type: "array",
      items: {
        type: "object",
        required: ["subject", "session", "artifacts"],
        properties: { subject: { type: "string" }, session: { type: "object" }, artifacts: { type: "object" } },
      },
    },
    aborted: {
      type: ["object", "null"],
      required: ["session", "artifacts"],
      properties: { session: { type: ["object", "null"] }, artifacts: { type: "object" } },
    },
  },
});

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function storedReport(file: string): StoredReport {
  const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (!isStoredReport(parsed))
    throw new Error(`case runner wrote an invalid receipt: ${ajv.errorsText(isStoredReport.errors)}`);
  return parsed;
}

function rawReport(file: string): RawReport {
  const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (!isRawReport(parsed)) throw new Error("case runner wrote an invalid raw receipt");
  return parsed;
}

const isDryPlan = ajv.compile<DryPlan>({
  type: "object",
  required: ["mode", "subject", "case", "max_turns", "timeout_ms", "command"],
  properties: {
    mode: { const: "dry-run" },
    subject: { type: "string" },
    case: { type: "string" },
    max_turns: { type: ["number", "null"] },
    timeout_ms: { type: "number" },
    command: { type: "array", items: { type: "string" } },
  },
});
const isPreflightOutput = ajv.compile<PreflightOutput>({
  type: "object",
  required: ["host", "ok", "checks"],
  properties: {
    host: { enum: ["claude", "codex", "grok"] },
    ok: { type: "boolean" },
    checks: {
      type: "array",
      items: {
        type: "object",
        required: ["name", "ok", "detail"],
        properties: { name: { type: "string" }, ok: { type: "boolean" }, detail: { type: "string" } },
      },
    },
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

const CODEX_HANDSHAKE = readFileSync(join(FIXTURES, "codex-handshake.jsonl"), "utf8");

/** The codex stream is the handshake captured from the installed host followed by a stored turn. */
function fixtureText(fixture: string): string {
  const text = readFileSync(join(FIXTURES, fixture), "utf8");
  return fixture === "codex-turn.jsonl" ? `${CODEX_HANDSHAKE}${text}` : text;
}

function session(host: HostKind, fixture: string, overrides: Partial<SessionResult> = {}): SessionResult {
  const rawOutput = fixtureText(fixture);
  const parsed = adapterFor(host).parse(rawOutput);
  return {
    subject: `subject-${host}`,
    host,
    ...parsed,
    rawOutput,
    exitCode: 0,
    timedOut: false,
    durationMs: 10,
    ...overrides,
  };
}

function subject(host: HostKind): Subject {
  return { id: `subject-${host}`, host, model: "subject-binding" };
}

interface GraderReference {
  file: string;
  surfaces: { file: string[]; reply: string[]; trace: string[] };
  good: { reply: string; tools: string[] };
  bad: { reply: string; tools: string[] };
}

const isGraderReferences = ajv.compile<Record<string, GraderReference>>({
  type: "object",
  additionalProperties: {
    type: "object",
    required: ["file", "surfaces", "good", "bad"],
    properties: {
      file: { type: "string" },
      surfaces: {
        type: "object",
        required: ["file", "reply", "trace"],
        properties: {
          file: { $ref: "#/$defs/names" },
          reply: { $ref: "#/$defs/names" },
          trace: { $ref: "#/$defs/names" },
        },
      },
      good: { $ref: "#/$defs/arm" },
      bad: { $ref: "#/$defs/arm" },
    },
  },
  $defs: {
    names: { type: "array", items: { type: "string" } },
    arm: {
      type: "object",
      required: ["reply", "tools"],
      properties: {
        reply: { type: "string" },
        tools: { $ref: "#/$defs/names" },
      },
    },
  },
});
const parsedReferences: unknown = JSON.parse(readFileSync(GRADER_REFERENCES, "utf8"));
if (!isGraderReferences(parsedReferences)) throw new Error("grader references do not match their fixture schema");
const references = parsedReferences;

describe("evaluateCaseSession", () => {
  test.each([
    [
      "claude",
      "../transcripts/claude-skill.jsonl",
      "subject-model",
      ["req_011CfQStKt75bT8Ktk3Rd2MY", "req_011CfQStUbEDRW5Zwk25uYVF"],
    ],
    ["codex", "codex-handshake.jsonl", "subject-model", []],
    ["grok", "../transcripts/grok-skill.jsonl", "subject-model", ["e5211715-2051-437b-9c60-77a560681419"]],
  ] as const)("retains the %s host's served model and request ids", (host, fixture, servedModel, requestIds) => {
    const parsed = adapterFor(host).parse(readFileSync(join(FIXTURES, fixture), "utf8"));

    expect(parsed.servedModel).toBe(servedModel);
    expect(parsed.requestIds ?? []).toEqual([...requestIds]);
  });

  test.each([
    "evals/super-bound/delegated-refresh-token-rotation/case.yaml",
    "evals/super-bound/vague-checkout-speed-criterion/case.yaml",
    "evals/super-bound/refused-oversized-change-split/case.yaml",
    "evals/super-bound/approved-spec-produces-tickets/case.yaml",
  ])("%s reads each judged criterion from the surface its reference declares", async (caseFile) => {
    const evalCase = loadCase(caseFile);
    const reference = references[evalCase.name];
    if (reference === undefined) throw new Error(`${evalCase.name} has no grader reference`);
    const criteriaNames = new Map(
      evalCase.graders.flatMap((grader) => (grader.type === "llm" ? [[grader.criteria, grader.name] as const] : [])),
    );
    for (const arm of ["good", "bad"] as const) {
      const cwd = realpathSync(mkdtempSync(join(tmpdir(), `ak-grader-reference-${arm}-`)));
      work.push(cwd);
      const selected = reference[arm];
      const marker = (names: string[]) => JSON.stringify({ offline_grader_passes: arm === "good" ? names : [] });
      const tools = selected.tools;
      const reply = `${selected.reply}\n${marker(reference.surfaces.reply)}`;
      const artifact = join(cwd, reference.file);
      mkdirSync(dirname(artifact), { recursive: true });
      writeFileSync(artifact, `${marker(reference.surfaces.file)}\n`);
      const result = await evaluateCaseSession(
        evalCase,
        {
          subject: "subject-reference",
          host: "claude",
          events: [
            ...tools.map((command): SessionEvent => ({ kind: "tool", name: "Bash", raw: "Bash", input: { command } })),
            { kind: "message", text: marker(reference.surfaces.trace) },
          ],
          reply,
          rawOutput: reply,
          exitCode: 0,
          timedOut: false,
          servedModel: "reference-binding",
          durationMs: 1,
        },
        {
          cwd,
          filesCreated: [reference.file],
          panel: buildPanel(matrix, { id: "subject-reference", host: "claude", model: "reference-binding" }),
          queue: join(cwd, "queue.jsonl"),
          judge: async (_reviewer, prompt) => {
            const criteria = /<criteria>\n([\s\S]*?)\n<\/criteria>/.exec(prompt)?.[1];
            const name = criteria === undefined ? undefined : criteriaNames.get(criteria);
            const verdict = name !== undefined && prompt.includes(`"${name}"`) ? "PASS" : "FAIL";
            return { reply: JSON.stringify({ verdict, reason: "offline reference oracle" }) };
          },
        },
      );

      expect(result.graders.map(({ name, verdict }) => [name, verdict])).toEqual(
        evalCase.graders.map(({ name }) => [name, arm === "good" ? "pass" : "fail"]),
      );
      expect(result.result).toBe(arm === "good" ? "pass" : "fail");
    }
  });

  test.each([
    ["claude", "claude.jsonl"],
    ["codex", "codex-turn.jsonl"],
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

  test("a host-cancelled session is listed once as invalid without calling a grader", async () => {
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
    const report = summariseCaseSessions([row]);
    expect(Object.keys(report).toSorted()).toEqual(["cost_usd", "sessions", "summary"]);
    expect(report.sessions).toHaveLength(1);
    expect(report.sessions.at(0)).toMatchObject({ subject: "subject-grok", validity: "invalid" });
    expect(report.summary).toEqual({ passed: 0, failed: 0, ungraded: 0, invalid: 1 });
  });

  test("a session with no host-reported served model is invalid before grading", async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "ak-case-runner-no-model-")));
    work.push(cwd);
    const row = await evaluateCaseSession(
      loadCase(CASE_FILE),
      session("claude", "claude.jsonl", { model: undefined, servedModel: undefined }),
      {
        cwd,
        filesCreated: [],
        panel: buildPanel(matrix, subject("claude")),
        queue: join(cwd, "queue.jsonl"),
        judge: async () => {
          throw new Error("identity-less session reached a grader");
        },
      },
    );

    expect(row).toMatchObject({ validity: "invalid", invalid_reason: "host did not report served model" });
    expect(row.graders).toEqual([]);
  });
});

describe("host launch safety", () => {
  test("a granted Claude case restricts and explicitly allows the case tools", () => {
    const command = adapterFor("claude").command(
      {
        prompt: "fixture",
        cwd: "/fixture",
        env: {},
        timeoutMs: 60_000,
        allowedTools: ["Read", "Bash", "Write"],
      },
      "subject-binding",
    );

    expect(command.slice(command.indexOf("--tools"), command.indexOf("--tools") + 4)).toEqual([
      "--tools",
      "Read,Bash,Write",
      "--allowedTools",
      "Read,Bash,Write",
    ]);
  });

  test("a granted Grok case launches with --always-approve and a restricted tool set, not dontAsk", () => {
    const command = adapterFor("grok").command(
      {
        prompt: "fixture",
        cwd: "/fixture",
        env: {},
        timeoutMs: 60_000,
        allowedTools: ["Read", "Bash", "Write"],
      },
      "subject-binding",
    );

    expect(command).toContain("--always-approve");
    expect(command).not.toContain("dontAsk");
    expect(command).toContain("--tools");
    expect(command.at(command.indexOf("--tools") + 1)).toBe("read_file,run_terminal_command,write");
  });
});

describe("grok grant", () => {
  test("a case that grants Skill keeps the tool the host loads a skill with", () => {
    const command = adapterFor("grok").command(
      { prompt: "fixture", cwd: "/fixture", env: {}, timeoutMs: 60_000, allowedTools: ["Skill", "Glob"] },
      "subject-binding",
    );

    expect(command.at(command.indexOf("--tools") + 1)).toBe("read_file,list_dir");
  });
});

const HELP = new Map([
  [
    "claude",
    [
      "  -p, --print",
      "  --output-format <format>",
      "  --verbose",
      "  --model <model>",
      "  --settings <file-or-json>",
      "  --setting-sources <sources>",
      "  --strict-mcp-config",
      "  --no-session-persistence",
      "  --tools <tools...>",
      "  --allowedTools, --allowed-tools <tools...>",
      "  --plugin-dir <path>",
      "  --append-system-prompt <prompt>",
    ].join("\n"),
  ],
  ["codex", ["      --stdio", "      --disable <FEATURE>"].join("\n")],
  [
    "grok",
    [
      "  -p, --single <PROMPT>",
      "      --output-format <OUTPUT_FORMAT>",
      "      --allow <ALLOW>",
      "      --tools <TOOLS>",
      "      --always-approve",
      "  -m, --model <MODEL>",
      "      --max-turns <MAX_TURNS>",
      "      --rules <RULES>",
    ].join("\n"),
  ],
]);
const hostCli = (help: ReadonlyMap<string, string>) => (probe: readonly string[]) => {
  const flag = probe.at(-1) ?? "";
  if (flag === "--help") return help.get(probe.at(0) ?? "") ?? "";
  return flag === "--max-turns"
    ? "error: option '--max-turns <turns>' argument missing"
    : `error: unknown option '${flag}'`;
};
const GROK_TOOLS = ["run_terminal_command", "read_file", "search_replace", "list_dir", "grep", "write"];

function bundles(): string {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "ak-case-runner-preflight-")));
  work.push(cwd);
  for (const bundle of ["claude-code", "codex"]) {
    const skill = join(cwd, bundle, "skills", "super-bound", "SKILL.md");
    mkdirSync(dirname(skill), { recursive: true });
    writeFileSync(skill, "# Super bound\n");
  }
  return cwd;
}

describe("preflight", () => {
  const caseFiles = [
    "evals/super-bound/delegated-refresh-token-rotation/case.yaml",
    "evals/super-bound/vague-checkout-speed-criterion/case.yaml",
    "evals/super-bound/refused-oversized-change-split/case.yaml",
    "evals/super-bound/approved-spec-produces-tickets/case.yaml",
  ];
  const argv = [
    "--preflight",
    "--host",
    "claude",
    "--host",
    "codex",
    "--host",
    "grok",
    ...caseFiles.flatMap((file) => ["--case", file]),
  ];

  async function preflight(overrides: Parameters<typeof caseRunnerMain>[1] = {}) {
    const lines: string[] = [];
    const errors: string[] = [];
    const code = await caseRunnerMain(argv, {
      bundleRoot: bundles(),
      out: (line) => lines.push(line),
      err: (line) => errors.push(line),
      binaryProbe: () => true,
      loginProbe: () => true,
      cliProbe: hostCli(HELP),
      grokToolsProbe: async () => GROK_TOOLS,
      codexHandshakeProbe: async () => CODEX_HANDSHAKE,
      ...overrides,
    });
    const rows = lines.map((line) => {
      const parsed: unknown = JSON.parse(line);
      if (!isPreflightOutput(parsed)) throw new Error("preflight emitted an invalid row");
      return parsed;
    });
    return { code, errors, rows };
  }

  test("probes all three hosts without starting a subject", async () => {
    let started = 0;
    const { code, rows } = await preflight({
      startSubject: async () => {
        started += 1;
        throw new Error("preflight started a subject");
      },
    });

    expect(code).toBe(0);
    expect(started).toBe(0);
    expect(rows.map(({ host, checks }) => [host, checks.map(({ name }) => name)])).toEqual([
      ["claude", ["binary", "login", "bundle-skills", "case-fixtures", "cli-flags"]],
      ["codex", ["binary", "login", "bundle-skills", "case-fixtures", "cli-flags", "thread-identity"]],
      ["grok", ["binary", "login", "bundle-skills", "case-fixtures", "cli-flags", "tool-names"]],
    ]);
    expect(rows.every(({ ok, checks }) => ok && checks.every((check) => check.ok))).toBe(true);
    expect(rows.at(0)?.checks.at(-1)?.detail).toContain(
      "--max-turns absent from help, accepted by the argument parser",
    );
  });

  test("fails loudly when a referenced bundle skill is absent", async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "ak-case-runner-preflight-red-")));
    work.push(cwd);
    const { code, errors } = await preflight({ bundleRoot: cwd });

    expect(code).toBe(2);
    expect(errors).toContain("case-runner preflight claude bundle-skills: missing super-bound");
    expect(errors).toContain("case-runner preflight codex bundle-skills: missing super-bound");
    expect(errors).toContain("case-runner preflight grok bundle-skills: missing super-bound");
  });

  test("fails when an installed CLI's help does not list a flag the adapter passes", async () => {
    const { code, errors } = await preflight({
      cliProbe: hostCli(new Map([...HELP, ["grok", (HELP.get("grok") ?? "").replace("--always-approve", "--yolo")]])),
    });

    expect(code).toBe(2);
    expect(errors).toEqual(["case-runner preflight grok cli-flags: `grok --help` does not list --always-approve"]);
  });

  test("fails when the argument parser rejects a flag the help omits", async () => {
    const { code, errors } = await preflight({
      cliProbe: (probe) => (probe.at(-1) === "--help" ? (HELP.get(probe.at(0) ?? "") ?? "") : "error: unknown option"),
    });

    expect(code).toBe(2);
    expect(errors).toEqual(["case-runner preflight claude cli-flags: `claude --help` does not list --max-turns"]);
  });

  test("fails when a restricted Grok tool id is not one the installed CLI advertises", async () => {
    const { code, errors } = await preflight({
      grokToolsProbe: async () => GROK_TOOLS.filter((id) => id !== "list_dir"),
    });

    expect(code).toBe(2);
    expect(errors).toHaveLength(1);
    expect(errors.at(0)).toStartWith("case-runner preflight grok tool-names: ");
    expect(errors.at(0)).toContain("the CLI has no tool list_dir");
  });

  test("fails when the Grok CLI advertises no tool list", async () => {
    const { code, errors } = await preflight({ grokToolsProbe: async () => [] });

    expect(code).toBe(2);
    expect(errors).toEqual(["case-runner preflight grok tool-names: the CLI advertised no tool list"]);
  });

  test("fails when the Codex handshake returns no served model", async () => {
    const { code, errors } = await preflight({
      codexHandshakeProbe: async () => CODEX_HANDSHAKE.replaceAll('"model":"subject-model",', ""),
    });

    expect(code).toBe(2);
    expect(errors.at(0)).toStartWith("case-runner preflight codex thread-identity: ");
    expect(errors.at(0)).toContain("thread/start returned no model or thread id");
  });
});

describe("execute path", () => {
  test.each([
    ["claude", "claude.jsonl", "claude"],
    ["codex", "codex-turn.jsonl", "codex"],
    ["grok", "grok.jsonl", "grok"],
  ] as const)("runs the %s transcript fixture through the receipt path", async (host, fixture, binary) => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), `ak-case-runner-main-${host}-`)));
    work.push(cwd);
    const bundle = join(cwd, "dist");
    mkdirSync(join(bundle, "claude-code"), { recursive: true });
    mkdirSync(join(bundle, "codex"), { recursive: true });
    const json = join(cwd, "result.json");
    const rawDir = join(cwd, "raw");
    const selected = subject(host);
    const start = session(host, fixture);
    const printed: string[] = [];
    const code = await caseRunnerMain(["--execute", "--subject", selected.id, "--case", CASE_FILE, "--json", json], {
      matrix: { ...matrix, subjects: [selected] },
      bundleRoot: bundle,
      rawDir,
      out: (line) => printed.push(line),
      startSubject: async (_adapter, id, _model, request) => {
        expect(id).toBe(selected.id);
        expect(request.allowedTools).toEqual(["Read", "Bash", "Write"]);
        mkdirSync(join(request.cwd, "tickets"));
        writeFileSync(join(request.cwd, "tickets", "result.json"), '{"class":"red","owner":"Maya Chen"}\n');
        return { ...start, subject: id };
      },
      judge: async () => ({ reply: '{"verdict":"PASS","reason":"fixture satisfies the criterion"}' }),
    });
    const committed = readFileSync(json, "utf8");
    const report = storedReport(json);
    const raw = rawReport(join(rawDir, "result.raw.json"));
    const result = report.sessions.at(0);
    const rawSession = raw.sessions.at(0);
    const receiptCase = report.receipt.cases.at(0);
    if (result === undefined || rawSession === undefined || receiptCase === undefined)
      throw new Error("case runner wrote no test result");
    const artifact = '{"class":"red","owner":"Maya Chen"}\n';

    expect(code).toBe(0);
    expect(report.sessions).toHaveLength(1);
    expect(result.validity).toBe("valid");
    expect(result.command.at(0)).toBe(binary);
    expect(result.files_created).toContain("tickets/result.json");
    expect(result.artifacts["tickets/result.json"]).toEqual({ sha256: sha256(artifact) });
    expect(result.served_model).toBe(start.servedModel ?? null);
    expect(result.served_model).not.toBeNull();
    expect(result.session.raw_output_sha256).toBe(sha256(start.rawOutput ?? ""));
    expect(committed).not.toContain("Maya Chen");
    expect(committed).not.toContain("The delegation assessment was recorded.");
    expect(report.receipt.raw.sha256).toBe(sha256(readFileSync(join(rawDir, "result.raw.json"), "utf8")));
    expect(rawSession.session.rawOutput).toBe(start.rawOutput);
    expect(rawSession.artifacts["tickets/result.json"]?.text).toBe(artifact);
    expect(result.graders.map(({ definition }) => definition)).toEqual(loadCase(CASE_FILE).graders);
    expect(receiptCase.sha256).toBe(loadCase(CASE_FILE).sha256);
    expect(printed).toHaveLength(1);
    expect(printed.at(0)).not.toContain("Maya Chen");
    expect(printed.at(0)).not.toContain("delegation assessment");
    expect(JSON.parse(printed.at(0) ?? "")).toMatchObject({
      summary: { passed: 1, failed: 0, ungraded: 0, invalid: 0 },
      sessions: [{ subject: selected.id, validity: "valid", result: "pass", served_model: result.served_model }],
      aborted: null,
    });
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
      ["--execute", "--subject", "subject-grok", "--subject", "subject-codex", "--case", CASE_FILE, "--json", json],
      {
        matrix: { ...matrix, subjects: [subject("grok"), subject("codex")] },
        bundleRoot: bundle,
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
      ["--execute", "--subject", "subject-grok", "--subject", "subject-codex", "--case", CASE_FILE, "--json", json],
      {
        matrix: { ...matrix, subjects: [subject("grok"), subject("codex")] },
        bundleRoot: bundle,
        rawDir: join(cwd, "raw"),
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
    const report = storedReport(json);

    expect(code).toBe(2);
    expect(report.sessions).toHaveLength(1);
    expect(report.receipt.cost_usd).toBe(0.25);
    expect(report.receipt.aborted).toMatchObject({
      subject: "subject-codex",
      reason: "host exited before a transcript",
      session: null,
    });
    expect(errors.join("\n")).toContain("host exited before a transcript");
  });

  test("keeps the raw stream and artifacts of a session whose grading throws in the raw receipt only", async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "ak-case-runner-judge-abort-")));
    work.push(cwd);
    const bundle = join(cwd, "dist");
    mkdirSync(join(bundle, "claude-code"), { recursive: true });
    mkdirSync(join(bundle, "codex"), { recursive: true });
    const json = join(cwd, "result.json");
    const errors: string[] = [];
    let codexStarted = false;
    let codexJudged = 0;
    const printed: string[] = [];
    const code = await caseRunnerMain(
      ["--execute", "--subject", "subject-grok", "--subject", "subject-codex", "--case", CASE_FILE, "--json", json],
      {
        matrix: { ...matrix, subjects: [subject("grok"), subject("codex")] },
        bundleRoot: bundle,
        rawDir: join(cwd, "raw"),
        out: (line) => printed.push(line),
        err: (line) => errors.push(line),
        startSubject: async (_adapter, id, _model, request) => {
          codexStarted = id === "subject-codex";
          mkdirSync(join(request.cwd, "tickets"));
          writeFileSync(join(request.cwd, "tickets", "result.json"), '{"class":"red","owner":"Maya Chen"}\n');
          return codexStarted
            ? { ...session("codex", "codex-turn.jsonl"), subject: id, costUsd: 0.5 }
            : { ...session("grok", "grok.jsonl"), subject: id, costUsd: 0.25 };
        },
        judge: async () => {
          if (codexStarted && codexJudged++ > 0) throw new Error("judge panel rejected");
          if (codexStarted) {
            await new Promise((settle) => setTimeout(settle, 20));
            return { reply: '{"verdict":"PASS","reason":"fixture satisfies the criterion"}', costUsd: 0.1 };
          }
          return { reply: '{"verdict":"PASS","reason":"fixture satisfies the criterion"}' };
        },
      },
    );
    const committed = readFileSync(json, "utf8");
    const report = storedReport(json);
    const raw = rawReport(join(cwd, "raw", "result.raw.json"));
    const artifact = '{"class":"red","owner":"Maya Chen"}\n';
    const codexStream = fixtureText("codex-turn.jsonl");

    expect(code).toBe(2);
    expect(report.sessions).toHaveLength(1);
    expect(report.receipt.cost_usd).toBeCloseTo(0.85);
    expect(report.receipt.aborted).toMatchObject({
      subject: "subject-codex",
      reason: "judge panel rejected",
      served_model: "subject-model",
      files_created: ["tickets/result.json"],
      artifacts: { "tickets/result.json": { sha256: sha256(artifact) } },
      session: { raw_output_sha256: sha256(codexStream) },
    });
    expect(committed).not.toContain("Maya Chen");
    expect(committed).not.toContain("The delegation assessment was recorded.");
    expect(raw.aborted?.session?.rawOutput).toBe(codexStream);
    expect(raw.aborted?.artifacts["tickets/result.json"]?.text).toBe(artifact);
    expect(printed.join("\n")).not.toContain("Maya Chen");
    expect(JSON.parse(printed.at(0) ?? "")).toMatchObject({
      aborted: { subject: "subject-codex", reason: "judge panel rejected" },
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
    expect(plans.every((plan) => plan.timeout_ms >= Math.max(600_000, (plan.max_turns ?? 10) * 60_000))).toBe(true);
    expect(plans.at(0)?.command.slice(0, 2)).toEqual(["codex", "app-server"]);
    const finalCase = cases.at(-1);
    if (finalCase === undefined) throw new Error("the dry-run fixture has no final case");
    expect(plans.at(-1)?.command.slice(0, 3)).toEqual(["grok", "-p", loadCase(finalCase).execution.prompt]);
    expect(plans.at(-1)?.command).toContain("--always-approve");
  });
});
