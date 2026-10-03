/**
 * Cross-host runner for committed eval cases. It uses the shared subject adapters, reviewer matrix,
 * grader semantics and receipt fragments; the CLI deliberately has no transcript/regrade mode.
 */
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { PACKAGE_ROOT } from "../../../src/learn/core/roles.ts";
import { run } from "../../../src/learn/core/proc.ts";
import { sha256Hex } from "../../../src/util/hash.ts";
import { evaluate, type Transcript } from "../../../src/validation/grader-eval.ts";
import { compileSchemas } from "../../../src/validation/schemas.ts";
import { effectiveMaxTurns, loadMatrix, MATRIX_FILE, type Matrix, type Subject } from "./matrix.ts";
import { buildPanel, grade, hostJudge, renderTranscript, type Judge, type Panel } from "./panel.ts";
import { matrixPrices, usageReceipt } from "./pricing.ts";
import { cleanEnv, evalInstrument } from "./session.ts";
import { adapterFor, BUNDLE_FOR, runSubject } from "./subjects/index.ts";
import { codexThreadStart } from "./subjects/codex.ts";
import type { HostKind, SessionRequest, SessionResult, TokenUsage, ToolEvent } from "./subjects/types.ts";
import { invalidSession } from "./trigger-eval.ts";

type Focus = "trace" | "last_message" | "files" | "mock_calls" | { source: "file"; path: string };
type ToolReference = string | { tool: string; input_match?: string };
type CommonGrader = { name: string; weight?: number; arm?: "with-only" | "both" };
export type CaseGrader = Readonly<
  CommonGrader &
    (
      | { type: "llm"; criteria: string; focus?: Focus }
      | { type: "tool_used"; tool: string; input_match?: string; min?: number; max?: number }
      | { type: "tool_order"; before: ToolReference; after: ToolReference }
      | { type: "file_exists"; path: string; exists?: boolean }
      | { type: "regex"; pattern: string; target?: Focus; flags?: string; match?: string }
      | { type: "baseline"; baseline_file: string; criteria: string }
    )
>;

interface CaseExecutionFile {
  prompt: string;
  max_turns: number;
  timeout_seconds?: number;
  allowed_tools: string[];
  append_system_prompt?: string;
  env?: Record<string, string>;
}

interface CaseFile {
  schema_version: "1.1";
  name: string;
  tags: string[];
  execution: CaseExecutionFile;
  context?: { scaffold_script?: string };
  graders: CaseGrader[];
}

export interface EvalCase {
  file: string;
  name: string;
  execution: CaseExecutionFile;
  context?: { scaffold_script?: string };
  graders: CaseGrader[];
  sha256: string;
}

export interface GraderResult {
  name: string;
  type: string;
  scored: boolean;
  weight: number;
  verdict: "pass" | "fail" | "needs-human" | "unavailable";
  definition: CaseGrader;
  votes?: Record<string, string>;
  reasons?: Record<string, string>;
  usage?: Record<string, TokenUsage>;
  cost_usd?: Record<string, number>;
  reason?: string;
}

export interface CaseSessionResult {
  case: string;
  case_file: string;
  subject: string;
  host: string;
  validity: "valid" | "invalid";
  invalid_reason: string | null;
  result: "pass" | "fail" | "ungraded" | null;
  score: number | null;
  graders: GraderResult[];
  subject_cost_usd: number | null;
  grader_cost_usd: number;
  cost_usd: number | null;
  command: string[];
  files_created: string[];
  artifacts: Record<string, { sha256: string; text?: string; base64?: string }>;
  served_model: string | null;
  request_ids: string[];
  session_id: string | null;
  session: SessionResult;
}

export interface EvaluateOptions {
  cwd: string;
  filesCreated: string[];
  panel: Panel;
  queue: string;
  judge?: Judge;
  maxTurns?: number | null;
  command?: string[];
}

const CASE_SCHEMA_ID = "https://agent-kit.local/schemas/case.schema.json";
const schemas = compileSchemas(PACKAGE_ROOT);
const validateCase = schemas.ajv.compile<CaseFile>({ $ref: CASE_SCHEMA_ID });

/** Load one case and retain the exact parsed grader definitions for the receipt. */
export function loadCase(file: string): EvalCase {
  const path = isAbsolute(file) ? file : resolve(PACKAGE_ROOT, file);
  const text = readFileSync(path, "utf8");
  const document: unknown = parseYaml(text, { uniqueKeys: true });
  if (!validateCase(document)) {
    const why = (validateCase.errors ?? []).map((error) => `${error.instancePath} ${error.message}`).join("; ");
    throw new Error(`${file}: ${why}`);
  }
  const parsed: EvalCase = {
    file: relative(PACKAGE_ROOT, path),
    name: document.name,
    execution: { ...document.execution, allowed_tools: [...document.execution.allowed_tools] },
    graders: document.graders,
    sha256: sha256Hex(text),
  };
  if (document.context !== undefined) parsed.context = document.context;
  return parsed;
}

function safeFile(cwd: string, path: string): string | null {
  const file = resolve(cwd, path);
  const fromCwd = relative(cwd, file);
  if (fromCwd.startsWith("..") || isAbsolute(fromCwd)) return null;
  if (!existsSync(file)) return "";
  const realRoot = realpathSync(cwd);
  const realFile = realpathSync(file);
  const realRelative = relative(realRoot, realFile);
  if (realRelative.startsWith("..") || isAbsolute(realRelative) || !statSync(realFile).isFile()) return null;
  return readFileSync(realFile, "utf8");
}

function focusSurface(
  grader: Extract<CaseGrader, { type: "llm" }>,
  session: SessionResult,
  cwd: string,
  filesCreated: string[],
): string | null {
  const focus = grader.focus;
  if (focus === undefined || focus === "last_message") return session.reply;
  if (focus === "trace") return renderTranscript(session);
  if (focus === "files") return filesCreated.join("\n");
  if (focus === "mock_calls") return null;
  return safeFile(cwd, focus.path);
}

function deterministicTranscript(session: SessionResult, filesCreated: string[]): Transcript {
  return {
    toolCalls: session.events
      .filter((event): event is ToolEvent => event.kind === "tool")
      .map(({ name, input }) => ({ name, input })),
    lastMessage: session.reply,
    filesCreated,
  };
}

function snapshotArtifacts(cwd: string, filesCreated: readonly string[]) {
  const artifacts: Record<string, { sha256: string; text?: string; base64?: string }> = {};
  const realRoot = realpathSync(cwd);
  for (const path of filesCreated) {
    const file = resolve(cwd, path);
    if (!existsSync(file)) continue;
    const realFile = realpathSync(file);
    const fromCwd = relative(realRoot, realFile);
    if (fromCwd.startsWith("..") || isAbsolute(fromCwd) || !statSync(realFile).isFile()) continue;
    const content = readFileSync(realFile);
    const sha256 = createHash("sha256").update(content).digest("hex");
    artifacts[path] = content.includes(0)
      ? { sha256, base64: content.toString("base64") }
      : { sha256, text: content.toString("utf8") };
  }
  return artifacts;
}

function judgeCost(result: GraderResult): number {
  return Object.values(result.cost_usd ?? {}).reduce((sum, cost) => sum + cost, 0);
}

/** Apply the loaded case's grader objects to one valid subject session. */
export async function evaluateCaseSession(
  evalCase: EvalCase,
  session: SessionResult,
  options: EvaluateOptions,
): Promise<CaseSessionResult> {
  const cap = options.maxTurns === null ? undefined : (options.maxTurns ?? evalCase.execution.max_turns);
  const invalid =
    invalidSession(session, cap) ?? (session.servedModel === undefined ? "host did not report served model" : null);
  const base = {
    case: evalCase.name,
    case_file: evalCase.file,
    subject: session.subject,
    host: session.host,
    subject_cost_usd: session.costUsd ?? null,
    command: options.command ?? [],
    files_created: [...options.filesCreated],
    artifacts: snapshotArtifacts(options.cwd, options.filesCreated),
    served_model: session.servedModel ?? null,
    request_ids: [...(session.requestIds ?? [])],
    session_id: session.sessionId ?? null,
    session,
  };
  if (invalid !== null)
    return {
      ...base,
      validity: "invalid",
      invalid_reason: invalid,
      result: null,
      score: null,
      graders: [],
      grader_cost_usd: 0,
      cost_usd: session.costUsd ?? null,
    };

  const transcript = deterministicTranscript(session, options.filesCreated);
  const graders: GraderResult[] = [];
  for (const definition of evalCase.graders) {
    const name = definition.name;
    const type = definition.type;
    const common = {
      name,
      type,
      scored: definition.arm !== "with-only",
      weight: definition.weight ?? 1,
      definition,
    };
    if (type === "llm") {
      const surface = focusSurface(definition, session, options.cwd, options.filesCreated);
      if (surface === null) {
        graders.push({
          ...common,
          verdict: "unavailable",
          reason: `unsupported focus ${JSON.stringify(definition.focus)}`,
        });
        continue;
      }
      const judged = await grade(options.panel, surface, definition.criteria, {
        item: `${evalCase.name}:${session.subject}:${name}`,
        queue: options.queue,
        judge: options.judge,
      });
      const graderResult: GraderResult = {
        ...common,
        verdict:
          judged.verdict === "PASS"
            ? "pass"
            : judged.verdict === "FAIL"
              ? "fail"
              : judged.verdict === "needs-human"
                ? "needs-human"
                : "unavailable",
        votes: judged.votes,
        reasons: judged.reasons,
        usage: judged.usage,
        cost_usd: judged.cost_usd,
      };
      if (judged.reason !== undefined) graderResult.reason = judged.reason;
      graders.push(graderResult);
      continue;
    }
    const verdict = evaluate(definition, transcript);
    graders.push(
      verdict === null
        ? { ...common, verdict: "unavailable", reason: `grader type ${type} is not locally executable` }
        : { ...common, verdict: verdict ? "pass" : "fail" },
    );
  }

  const scored = graders.filter((grader) => grader.scored);
  const passedWeight = scored
    .filter((grader) => grader.verdict === "pass")
    .reduce((sum, grader) => sum + grader.weight, 0);
  const totalWeight = scored.reduce((sum, grader) => sum + grader.weight, 0);
  const hasFailure = scored.some((grader) => grader.verdict === "fail");
  const complete =
    scored.length > 0 && scored.every((grader) => grader.verdict === "pass" || grader.verdict === "fail");
  const result = hasFailure
    ? "fail"
    : complete && scored.every((grader) => grader.verdict === "pass")
      ? "pass"
      : "ungraded";
  const graderCost = graders.reduce((sum, grader) => sum + judgeCost(grader), 0);
  const costs = [session.costUsd, graderCost > 0 ? graderCost : undefined].filter(
    (cost): cost is number => cost !== undefined,
  );
  return {
    ...base,
    validity: "valid",
    invalid_reason: null,
    result,
    score: totalWeight === 0 ? null : passedWeight / totalWeight,
    graders,
    grader_cost_usd: graderCost,
    cost_usd: costs.length === 0 ? null : costs.reduce((sum, cost) => sum + cost, 0),
  };
}

export function summariseCaseSessions(rows: readonly CaseSessionResult[]) {
  const results = rows.filter((row) => row.validity === "valid");
  const invalid_sessions = rows.flatMap((row) =>
    row.validity === "invalid"
      ? [{ subject: row.subject, host: row.host, case: row.case, reason: row.invalid_reason }]
      : [],
  );
  const count = (expectedResult: CaseSessionResult["result"]) =>
    results.filter((row) => row.result === expectedResult).length;
  const costs = rows.flatMap((row) => (row.cost_usd === null ? [] : [row.cost_usd]));
  return {
    sessions: [...rows],
    results,
    invalid_sessions,
    summary: {
      passed: count("pass"),
      failed: count("fail"),
      ungraded: count("ungraded"),
      invalid: invalid_sessions.length,
    },
    cost_usd: costs.length === 0 ? null : costs.reduce((sum, cost) => sum + cost, 0),
  };
}

function requestFor(evalCase: EvalCase, subject: Subject, cwd: string, bundleDir: string): SessionRequest {
  const adapter = adapterFor(subject.host);
  const cap = effectiveMaxTurns(subject, evalCase.execution.max_turns);
  const request: SessionRequest = {
    prompt: evalCase.execution.prompt,
    cwd,
    env: { ...cleanEnv(adapter.env), ...evalCase.execution.env },
    timeoutMs: Math.max(evalCase.execution.timeout_seconds ?? 0, 600, evalCase.execution.max_turns * 60) * 1000,
    allowedTools: evalCase.execution.allowed_tools,
    bundleDir,
  };
  if (cap !== undefined) request.maxTurns = cap;
  if (evalCase.execution.append_system_prompt !== undefined)
    request.appendSystemPrompt = evalCase.execution.append_system_prompt;
  return request;
}

function filesUnder(root: string): Set<string> {
  const files = new Set<string>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() || entry.isSymbolicLink()) files.add(relative(root, path));
    }
  };
  walk(root);
  return files;
}

interface PreparedCase {
  cwd: string;
  before: Set<string>;
}

function prepareCase(evalCase: EvalCase): PreparedCase {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "ak-case-")));
  const scaffold = evalCase.context?.scaffold_script;
  if (scaffold !== undefined) {
    const script = resolve(PACKAGE_ROOT, dirname(evalCase.file), scaffold);
    const result = run(["bash", script], { cwd, timeoutMs: 120_000 });
    if (result.code !== 0) {
      rmSync(cwd, { recursive: true, force: true });
      throw new Error(`${evalCase.file}: scaffold exited ${result.code}: ${result.stderr.trim()}`);
    }
  }
  return { cwd, before: filesUnder(cwd) };
}

function revision(): string {
  const result = run(["git", "rev-parse", "HEAD"], { cwd: PACKAGE_ROOT });
  return result.code === 0 ? result.stdout.trim() : "unknown";
}

interface PlanRow {
  mode: "dry-run";
  subject: string;
  host: string;
  case: string;
  case_file: string;
  cwd: "fresh scaffold";
  max_turns: number | null;
  timeout_ms: number;
  allowed_tools: string[];
  command: string[];
}

function planRow(evalCase: EvalCase, subject: Subject, bundleRoot: string): PlanRow {
  const adapter = adapterFor(subject.host);
  const bundleDir = join(bundleRoot, BUNDLE_FOR[subject.host]);
  const request = requestFor(evalCase, subject, "<fresh-scaffold>", bundleDir);
  return {
    mode: "dry-run",
    subject: subject.id,
    host: subject.host,
    case: evalCase.name,
    case_file: evalCase.file,
    cwd: "fresh scaffold",
    max_turns: request.maxTurns ?? null,
    timeout_ms: request.timeoutMs,
    allowed_tools: [...evalCase.execution.allowed_tools],
    command: adapter.command(request, subject.model),
  };
}

type StartSubject = typeof runSubject;
export interface MainDependencies {
  matrix?: Matrix;
  bundleRoot?: string;
  out?: (line: string) => void;
  err?: (line: string) => void;
  startSubject?: StartSubject;
  judge?: Judge;
  binaryProbe?: (host: HostKind) => boolean;
  loginProbe?: (host: HostKind) => boolean;
}

function flagValues(argv: readonly string[], flag: string): string[] {
  const found: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    if (argv.at(index) !== flag) continue;
    const next = argv.at(index + 1);
    if (next !== undefined) found.push(next);
  }
  return found;
}

function lastFlagValue(argv: readonly string[], flag: string): string | undefined {
  return flagValues(argv, flag).at(-1);
}

function argumentProblems(argv: readonly string[]): string[] {
  const valueFlags = new Set(["--subject", "--host", "--case", "--json"]);
  const switches = new Set(["--dry-run", "--execute", "--preflight"]);
  const problems: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const token = argv.at(index);
    if (token === undefined) break;
    if (switches.has(token)) continue;
    if (!valueFlags.has(token)) {
      problems.push(`unknown argument ${token}`);
      continue;
    }
    const next = argv.at(index + 1);
    if (next === undefined || next.startsWith("--")) problems.push(`${token} needs a value`);
    else index++;
  }
  const modes = ["--dry-run", "--execute", "--preflight"].filter((mode) => argv.includes(mode));
  if (modes.length !== 1) problems.push("choose exactly one of --dry-run, --execute or --preflight");
  if (!argv.includes("--preflight") && flagValues(argv, "--subject").length === 0)
    problems.push("at least one --subject is required");
  if (argv.includes("--preflight") && flagValues(argv, "--host").length === 0)
    problems.push("at least one --host is required");
  if (flagValues(argv, "--case").length === 0) problems.push("at least one --case is required");
  if (argv.includes("--execute") && lastFlagValue(argv, "--json") === undefined)
    problems.push("--execute requires --json");
  return problems;
}

interface PreflightCheck {
  name: string;
  ok: boolean;
  detail: string;
}

interface PreflightRow {
  mode: "preflight";
  host: HostKind;
  ok: boolean;
  checks: PreflightCheck[];
}

const IDENTITY_FIXTURE: Record<HostKind, string> = {
  claude: join(PACKAGE_ROOT, "tests/learn/evals/fixtures/transcripts/claude-skill.jsonl"),
  codex: join(PACKAGE_ROOT, "tests/learn/evals/fixtures/case-runner/codex-app-server.jsonl"),
  grok: join(PACKAGE_ROOT, "tests/learn/evals/fixtures/transcripts/grok-skill.jsonl"),
};

function defaultBinaryProbe(host: HostKind): boolean {
  const result = run([host, "--version"], { cwd: PACKAGE_ROOT, timeoutMs: 10_000 });
  return result.code === 0;
}

function jsonObject(file: string): boolean {
  if (!existsSync(file)) return false;
  try {
    const normalized = JSON.stringify(JSON.parse(readFileSync(file, "utf8")));
    return normalized !== "{}" && normalized !== "[]" && normalized !== "null";
  } catch {
    return false;
  }
}

function defaultLoginProbe(host: HostKind): boolean {
  if (host === "claude") {
    const result = run(["claude", "auth", "status", "--json"], { cwd: PACKAGE_ROOT, timeoutMs: 10_000 });
    if (result.code !== 0) return false;
    try {
      JSON.parse(result.stdout);
      return /"loggedIn"\s*:\s*true/.test(result.stdout);
    } catch {
      return false;
    }
  }
  if (host === "codex") {
    const result = run(["codex", "login", "status"], { cwd: PACKAGE_ROOT, timeoutMs: 10_000 });
    return result.code === 0 && /logged in/i.test(`${result.stdout}\n${result.stderr}`);
  }
  const home = process.env.GROK_HOME ?? join(process.env.HOME ?? homedir(), ".grok");
  return jsonObject(join(home, "auth.json"));
}

function skillIds(evalCases: readonly EvalCase[]): string[] {
  return [
    ...new Set(
      evalCases.flatMap((evalCase) => {
        const id = /\/ak:([a-z0-9-]+)/.exec(evalCase.execution.prompt)?.[1];
        return id === undefined ? [] : [id];
      }),
    ),
  ];
}

function permissionCheck(host: HostKind, evalCases: readonly EvalCase[], bundleRoot: string): PreflightCheck {
  const failures: string[] = [];
  for (const evalCase of evalCases) {
    const subject: Subject = { id: `preflight-${host}`, host, model: undefined };
    const request = requestFor(evalCase, subject, "<preflight-scaffold>", join(bundleRoot, BUNDLE_FOR[host]));
    const command = adapterFor(host).command(request, undefined);
    if (host === "grok") {
      if (!command.includes("--always-approve"))
        failures.push(`${evalCase.name}: compound calls are not auto-approved`);
      if (!command.includes("--tools")) failures.push(`${evalCase.name}: granted tools are not restricted`);
    }
    if (host === "claude") {
      if (!command.includes("--tools")) failures.push(`${evalCase.name}: granted tools are not restricted`);
      if (!command.includes("--allowedTools")) failures.push(`${evalCase.name}: case tools are not pre-approved`);
    }
    if (host === "codex") {
      const start = codexThreadStart(request, undefined);
      const mutates = evalCase.execution.allowed_tools.some((tool) => ["Bash", "Edit", "Write"].includes(tool));
      if (mutates && start.sandbox !== "workspace-write")
        failures.push(`${evalCase.name}: workspace writes are blocked`);
    }
  }
  return {
    name: "tool-permissions",
    ok: failures.length === 0,
    detail: failures.length === 0 ? "case grants cover required commands" : failures.join("; "),
  };
}

export function preflightHosts(
  hosts: readonly HostKind[],
  evalCases: readonly EvalCase[],
  bundleRoot: string,
  probes: { binary?: (host: HostKind) => boolean; login?: (host: HostKind) => boolean } = {},
): PreflightRow[] {
  const binary = probes.binary ?? defaultBinaryProbe;
  const login = probes.login ?? defaultLoginProbe;
  return hosts.map((host) => {
    const bundle = join(bundleRoot, BUNDLE_FOR[host]);
    const skills = skillIds(evalCases);
    const missingSkills = skills.filter((id) => !existsSync(join(bundle, "skills", id, "SKILL.md")));
    const missingFixtures = evalCases.flatMap((evalCase) => {
      const scaffold = evalCase.context?.scaffold_script;
      if (scaffold === undefined) return [];
      const file = resolve(PACKAGE_ROOT, dirname(evalCase.file), scaffold);
      return existsSync(file) ? [] : [evalCase.name];
    });
    const parsedIdentity = adapterFor(host).parse(readFileSync(IDENTITY_FIXTURE[host], "utf8"));
    const identityOk =
      parsedIdentity.servedModel !== undefined &&
      (host === "codex" ? parsedIdentity.sessionId !== undefined : (parsedIdentity.requestIds?.length ?? 0) > 0);
    const shortTimeouts = evalCases.filter((evalCase) => {
      const subject: Subject = { id: `preflight-${host}`, host, model: undefined };
      const request = requestFor(evalCase, subject, "<preflight-scaffold>", bundle);
      return request.timeoutMs < Math.max(600_000, evalCase.execution.max_turns * 60_000);
    });
    const checks: PreflightCheck[] = [
      { name: "binary", ok: binary(host), detail: "host CLI resolves locally" },
      { name: "login", ok: login(host), detail: "credential source is present and valid" },
      {
        name: "bundle-skills",
        ok: existsSync(bundle) && missingSkills.length === 0,
        detail:
          missingSkills.length === 0
            ? `${skills.length} referenced skill(s) resolve`
            : `missing ${missingSkills.join(", ")}`,
      },
      {
        name: "case-fixtures",
        ok: missingFixtures.length === 0,
        detail:
          missingFixtures.length === 0
            ? `${evalCases.length} scaffold(s) resolve`
            : `missing ${missingFixtures.join(", ")}`,
      },
      permissionCheck(host, evalCases, bundleRoot),
      {
        name: "served-identity-fixture",
        ok: identityOk,
        detail: identityOk
          ? "served model and host correlation id parse"
          : "served model or host correlation id is absent",
      },
      {
        name: "timeouts",
        ok: shortTimeouts.length === 0,
        detail:
          shortTimeouts.length === 0
            ? "effective timeouts cover case turn budgets"
            : `short ${shortTimeouts.map(({ name }) => name).join(", ")}`,
      },
    ];
    return { mode: "preflight", host, ok: checks.every(({ ok }) => ok), checks };
  });
}

const HOST_KIND = new Map<string, HostKind>([
  ["claude", "claude"],
  ["codex", "codex"],
  ["grok", "grok"],
]);

/** CLI coordinator. A paid subject can start only on the explicit `--execute` branch. */
export async function main(argv: string[], dependencies: MainDependencies = {}): Promise<number> {
  const out = dependencies.out ?? console.log;
  const err = dependencies.err ?? console.error;
  const problems = argumentProblems(argv);
  if (problems.length > 0) {
    for (const problem of problems) err(`case-runner: ${problem}`);
    return 2;
  }
  try {
    const matrix = dependencies.matrix ?? loadMatrix(MATRIX_FILE);
    const wanted = new Set(flagValues(argv, "--subject"));
    const subjects = matrix.subjects.filter((subject) => wanted.has(subject.id));
    const absent = [...wanted].filter((id) => !subjects.some((subject) => subject.id === id));
    if (absent.length > 0) throw new Error(`matrix has no subject(s): ${absent.join(", ")}`);
    const cases = flagValues(argv, "--case").map(loadCase);
    const bundleRoot = dependencies.bundleRoot ?? join(PACKAGE_ROOT, "dist");
    if (argv.includes("--preflight")) {
      const hostValues = flagValues(argv, "--host");
      const invalidHosts = hostValues.filter((host) => HOST_KIND.get(host) === undefined);
      if (invalidHosts.length > 0) throw new Error(`unknown host(s): ${invalidHosts.join(", ")}`);
      const hosts = hostValues.flatMap((host) => {
        const parsed = HOST_KIND.get(host);
        return parsed === undefined ? [] : [parsed];
      });
      const rows = preflightHosts(hosts, cases, bundleRoot, {
        binary: dependencies.binaryProbe,
        login: dependencies.loginProbe,
      });
      for (const row of rows) out(JSON.stringify(row));
      for (const row of rows)
        for (const check of row.checks)
          if (!check.ok) err(`case-runner preflight ${row.host} ${check.name}: ${check.detail}`);
      return rows.every(({ ok }) => ok) ? 0 : 2;
    }
    if (argv.includes("--dry-run")) {
      for (const subject of subjects)
        for (const evalCase of cases) out(JSON.stringify(planRow(evalCase, subject, bundleRoot)));
      return 0;
    }

    const priced = matrixPrices(matrix.priceTable);
    const outputFile = lastFlagValue(argv, "--json");
    if (outputFile === undefined) throw new Error("--execute requires --json");
    const json = resolve(PACKAGE_ROOT, outputFile);
    const queue = `${json}.queue.jsonl`;
    const start = dependencies.startSubject ?? runSubject;
    const bundles = subjects.map((subject) => join(bundleRoot, BUNDLE_FOR[subject.host]));
    const missing = [...new Set(bundles.filter((bundleDir) => !existsSync(bundleDir)))];
    if (missing.length > 0) throw new Error(`${missing.join(", ")} missing; run bun run ak build --profile all`);
    const rows: CaseSessionResult[] = [];
    const started: SessionResult[] = [];
    const judge = dependencies.judge ?? hostJudge(priced.prices);
    let aborted: { subject: string; case: string; reason: string; cost_usd: number | null } | null = null;
    sessions: for (const subject of subjects) {
      const adapter = adapterFor(subject.host);
      const bundleDir = join(bundleRoot, BUNDLE_FOR[subject.host]);
      const panel = buildPanel(matrix, subject);
      for (const evalCase of cases) {
        let prepared: PreparedCase | undefined;
        let session: SessionResult | undefined;
        let judgeSpend: number | undefined;
        try {
          prepared = prepareCase(evalCase);
          const request = requestFor(evalCase, subject, prepared.cwd, bundleDir);
          session = await start(adapter, subject.id, subject.model, request, priced.prices);
          started.push(session);
          const after = filesUnder(prepared.cwd);
          const before = prepared.before;
          const filesCreated = [...after].filter((file) => !before.has(file)).toSorted();
          rows.push(
            await evaluateCaseSession(evalCase, session, {
              cwd: prepared.cwd,
              filesCreated,
              panel,
              queue,
              judge: async (reviewer, prompt) => {
                const judged = await judge(reviewer, prompt);
                if (judged.costUsd !== undefined) judgeSpend = (judgeSpend ?? 0) + judged.costUsd;
                return judged;
              },
              maxTurns: request.maxTurns ?? null,
              command: adapter.command(request, subject.model),
            }),
          );
        } catch (error) {
          aborted = {
            subject: subject.id,
            case: evalCase.name,
            reason: error instanceof Error ? error.message : String(error),
            cost_usd:
              session?.costUsd === undefined && judgeSpend === undefined
                ? null
                : (session?.costUsd ?? 0) + (judgeSpend ?? 0),
          };
        } finally {
          if (prepared !== undefined) rmSync(prepared.cwd, { recursive: true, force: true });
        }
        if (aborted !== null) break sessions;
      }
    }

    const report = summariseCaseSessions(rows);
    const costUsd = aborted?.cost_usd == null ? report.cost_usd : (report.cost_usd ?? 0) + aborted.cost_usd;
    mkdirSync(dirname(json), { recursive: true });
    const receipt = {
      ...evalInstrument(PACKAGE_ROOT, revision()),
      argv: ["bun", "tests/learn/evals/case-runner.ts", ...argv],
      price_table: priced.price_table,
      cases: cases.map(({ name, file, sha256 }) => ({ name, file, sha256 })),
      subjects: subjects.map(({ id, host }) => ({ id, host })),
      ...usageReceipt(started),
      cost_usd: costUsd,
      summary: report.summary,
      aborted,
    };
    writeFileSync(json, `${JSON.stringify({ receipt, ...report, cost_usd: costUsd }, null, 2)}\n`);
    out(JSON.stringify({ receipt, results: report.results, invalid_sessions: report.invalid_sessions }));
    if (aborted !== null) {
      err(`case-runner: ${aborted.subject} ${aborted.case}: ${aborted.reason}`);
      return 2;
    }
    return report.summary.failed > 0 || report.summary.invalid > 0 || report.summary.ungraded > 0 ? 1 : 0;
  } catch (error) {
    err(`case-runner: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
