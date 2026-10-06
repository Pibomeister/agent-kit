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
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
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
import { adapterFor, BUNDLE_FOR, runSubject, withoutParentSession } from "./subjects/index.ts";
import { runCodexAppServer } from "./subjects/codex.ts";
import { grokToolList } from "./subjects/grok.ts";
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
  split?: true;
  reasons?: Record<string, string>;
  usage?: Record<string, TokenUsage>;
  cost_usd?: Record<string, number>;
  reason?: string;
}

type Artifacts = Record<string, { sha256: string; text?: string; base64?: string }>;

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
  artifacts: Artifacts;
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
  if (!existsSync(file)) return null;
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
  const artifacts: Artifacts = {};
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

function strictMajority(votes: Readonly<Record<string, string>>): "PASS" | "FAIL" | null {
  const cast = Object.values(votes);
  if (cast.length === 0 || cast.some((vote) => vote !== "PASS" && vote !== "FAIL")) return null;
  const passes = cast.filter((vote) => vote === "PASS").length;
  const fails = cast.length - passes;
  if (passes > cast.length / 2) return "PASS";
  if (fails > cast.length / 2) return "FAIL";
  return null;
}

/** Names the host identity a session failed to report: served model, session or thread id, request id. */
function identityProblem(session: SessionResult): string | null {
  if (session.servedModel === undefined) return "host did not report served model";
  if (session.sessionId === undefined) return "host did not report session id";
  if (adapterFor(session.host).requestIds && (session.requestIds ?? []).length === 0)
    return "host did not report request id";
  return null;
}

/** Apply the loaded case's grader objects to one valid subject session. */
export async function evaluateCaseSession(
  evalCase: EvalCase,
  session: SessionResult,
  options: EvaluateOptions,
): Promise<CaseSessionResult> {
  const cap = options.maxTurns === null ? undefined : (options.maxTurns ?? evalCase.execution.max_turns);
  const invalid = invalidSession(session, cap) ?? identityProblem(session);
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
  let undecided = evalCase.graders.some(
    (definition) =>
      definition.type === "llm" &&
      definition.arm !== "with-only" &&
      focusSurface(definition, session, options.cwd, options.filesCreated) === null,
  );
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
          reason: `no surface for focus ${JSON.stringify(definition.focus)}`,
        });
        continue;
      }
      if (undecided) {
        graders.push({ ...common, verdict: "unavailable", reason: "not judged: the row is already ungraded" });
        continue;
      }
      const judged = await grade(options.panel, surface, definition.criteria, {
        item: `${evalCase.name}:${session.subject}:${name}`,
        queue: options.queue,
        judge: options.judge,
      });
      const majority = common.scored && judged.verdict === "needs-human" ? strictMajority(judged.votes) : null;
      const graderResult: GraderResult = {
        ...common,
        verdict:
          judged.verdict === "PASS" || majority === "PASS"
            ? "pass"
            : judged.verdict === "FAIL" || majority === "FAIL"
              ? "fail"
              : judged.verdict === "needs-human"
                ? "needs-human"
                : "unavailable",
        votes: judged.votes,
        reasons: judged.reasons,
        usage: judged.usage,
        cost_usd: judged.cost_usd,
      };
      if (majority !== null) {
        graderResult.split = true;
        graderResult.reason = `strict reviewer majority: ${Object.values(judged.votes).filter((vote) => vote === majority).length} ${majority}, ${Object.keys(judged.votes).length} total`;
      } else if (judged.reason !== undefined) graderResult.reason = judged.reason;
      graders.push(graderResult);
      undecided = common.scored && graderResult.verdict !== "pass" && graderResult.verdict !== "fail";
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
  const result = !complete ? "ungraded" : hasFailure ? "fail" : "pass";
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

/**
 * What would leave a selected session ungraded whatever the subject does: a reviewer panel that
 * cannot be seated, a grader type with no local evaluator, or a judged grader that reads mock calls.
 */
export function readinessProblems(
  matrix: Pick<Matrix, "reviewers" | "panels">,
  subjects: readonly Subject[],
  evalCases: readonly EvalCase[],
): string[] {
  const panels = subjects.flatMap((subject) => {
    const panel = buildPanel(matrix, subject);
    return panel.status === "unavailable" ? [`${subject.id}: reviewer panel unavailable, ${panel.reason}`] : [];
  });
  const graders = evalCases.flatMap((evalCase) =>
    evalCase.graders.flatMap((grader) => {
      if (grader.type === "llm")
        return grader.focus === "mock_calls"
          ? [`${evalCase.name} ${grader.name}: llm grader reads mock calls only`]
          : [];
      return evaluate(grader, { toolCalls: [], lastMessage: "", filesCreated: [] }) === null
        ? [`${evalCase.name} ${grader.name}: grader type ${grader.type} is not locally executable`]
        : [];
    }),
  );
  return [...panels, ...graders];
}

/** One list of every started session, valid or not, with the counts read from each row's own validity. */
export function summariseCaseSessions(rows: readonly CaseSessionResult[]) {
  const count = (expectedResult: CaseSessionResult["result"]) =>
    rows.filter((row) => row.validity === "valid" && row.result === expectedResult).length;
  const costs = rows.flatMap((row) => (row.cost_usd === null ? [] : [row.cost_usd]));
  return {
    sessions: [...rows],
    summary: {
      passed: count("pass"),
      failed: count("fail"),
      ungraded: count("ungraded"),
      invalid: rows.filter((row) => row.validity === "invalid").length,
    },
    cost_usd: costs.length === 0 ? null : costs.reduce((sum, cost) => sum + cost, 0),
  };
}

function artifactHashes(artifacts: Artifacts): Record<string, { sha256: string }> {
  return Object.fromEntries(Object.entries(artifacts).map(([path, { sha256 }]) => [path, { sha256 }]));
}

function sessionFacts(session: SessionResult) {
  return {
    raw_output_sha256: session.rawOutput === undefined ? null : sha256Hex(session.rawOutput),
    exit_code: session.exitCode,
    timed_out: session.timedOut,
    duration_ms: session.durationMs,
    turns: session.turns ?? null,
    stop_reason: session.stopReason ?? null,
    usage: session.usage ?? null,
  };
}

/** An invalid-session reason without the host call it may quote after its colon. */
function reasonClass(reason: string | null): string | null {
  return reason === null ? null : (reason.split(":").at(0) ?? reason);
}

/**
 * The committable form of a row: verdicts, identity and hashes. The host stream, artifact contents,
 * launch argv, judge reasons and the quoted part of an invalid reason stay in the raw receipt.
 */
function committedRow(row: CaseSessionResult) {
  const { session, artifacts, command, graders, invalid_reason: invalidReason, ...facts } = row;
  return {
    ...facts,
    invalid_reason: reasonClass(invalidReason),
    command: { program: command.at(0) ?? null, sha256: sha256Hex(JSON.stringify(command)) },
    graders: graders.map(({ reasons: _reasons, ...verdict }) => verdict),
    artifacts: artifactHashes(artifacts),
    session: sessionFacts(session),
  };
}

/**
 * The wall clock is the case's `timeout_seconds` raised to a floor of 600 seconds and of 60 seconds
 * per declared turn. `timeout_seconds` is therefore a minimum: it can lengthen the run past the
 * floor and can never shorten it below the floor.
 */
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

export type StartSubject = typeof runSubject;
export interface MainDependencies {
  matrix?: Matrix;
  bundleRoot?: string;
  out?: (line: string) => void;
  err?: (line: string) => void;
  startSubject?: StartSubject;
  judge?: Judge;
  binaryProbe?: (host: HostKind) => boolean;
  loginProbe?: (host: HostKind) => boolean;
  cliProbe?: (argv: readonly string[]) => string;
  grokToolsProbe?: () => Promise<string[]>;
  codexHandshakeProbe?: (request: SessionRequest) => Promise<string>;
  /** Where the raw receipt and the human-label queue go. Defaults to the ignored `.work/case-runner`. */
  rawDir?: string;
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
  const valueFlags = new Set(["--subject", "--case", "--json", "--max-spend-usd", "--estimates"]);
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
  if (flagValues(argv, "--subject").length === 0) problems.push("at least one --subject is required");
  if (flagValues(argv, "--case").length === 0) problems.push("at least one --case is required");
  if (argv.includes("--execute") && lastFlagValue(argv, "--json") === undefined)
    problems.push("--execute requires --json");
  if (argv.includes("--execute") && lastFlagValue(argv, "--estimates") === undefined)
    problems.push("--execute requires --estimates");
  const cap = lastFlagValue(argv, "--max-spend-usd");
  if (argv.includes("--execute") && (cap === undefined || !/^\d+(\.\d+)?$/.test(cap)))
    problems.push("--execute requires --max-spend-usd with a non-negative amount");
  return problems;
}

type Estimates = Record<string, Record<string, number>>;

const validateEstimates = schemas.ajv.compile<Estimates>({
  type: "object",
  additionalProperties: {
    type: "object",
    additionalProperties: { type: "number", minimum: 0 },
  },
});

/** Reads the per-subject, per-case spend estimates and refuses a selection it does not cover. */
function loadEstimates(file: string, subjects: readonly Subject[], cases: readonly EvalCase[]): Estimates {
  const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (!validateEstimates(parsed)) throw new Error(`${file} is not a subject to case to USD estimate map`);
  const absent = subjects.flatMap((subject) =>
    cases.flatMap((evalCase) =>
      parsed[subject.id]?.[evalCase.name] === undefined ? [`${subject.id} ${evalCase.name}`] : [],
    ),
  );
  if (absent.length > 0) throw new Error(`${file} has no estimate for: ${absent.join(", ")}`);
  return parsed;
}

type SkipReason = "spend-cap" | "invalid-row" | "ungraded-row" | "aborted" | "subject-failed";

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
  if (host === "kimi") {
    const result = run(["kimi", "provider", "list"], { cwd: PACKAGE_ROOT, timeoutMs: 10_000 });
    return result.code === 0 && /type=kimi\b.*\bsource=oauth\b/.test(`${result.stdout}\n${result.stderr}`);
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

export interface PreflightProbes {
  binary?: (host: HostKind) => boolean;
  login?: (host: HostKind) => boolean;
  /** Run a host argv that starts no session (`--help`, or one flag with its value withheld) and return what it printed. */
  cli?: (argv: readonly string[]) => string;
  /** The tool ids the installed Grok CLI advertises for a new session. */
  grokTools?: () => Promise<string[]>;
  /** The Codex app-server stream for `initialize` plus this request's `thread/start`, with no turn. */
  codexHandshake?: (request: SessionRequest) => Promise<string>;
}

function defaultCliProbe(argv: readonly string[]): string {
  const result = run(argv, { cwd: PACKAGE_ROOT, timeoutMs: 10_000 });
  return `${result.stdout}\n${result.stderr}`;
}

async function inPrivateHome<T>(
  host: HostKind,
  request: SessionRequest,
  use: (options: { cwd: string; env: Record<string, string>; timeoutMs: number }) => Promise<T>,
): Promise<T> {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), `ak-preflight-${host}-`)));
  const cwd = join(scratch, "cwd");
  mkdirSync(cwd);
  const isolation = adapterFor(host).isolate?.(scratch, request);
  try {
    return await use({ cwd, env: { ...withoutParentSession(request.env), ...isolation?.env }, timeoutMs: 60_000 });
  } finally {
    isolation?.release();
    rmSync(scratch, { recursive: true, force: true });
  }
}

function preflightRequest(host: HostKind): SessionRequest {
  return { prompt: "", cwd: PACKAGE_ROOT, env: cleanEnv(adapterFor(host).env), timeoutMs: 60_000 };
}

function defaultGrokTools(): Promise<string[]> {
  return inPrivateHome("grok", preflightRequest("grok"), grokToolList);
}

function defaultCodexHandshake(request: SessionRequest): Promise<string> {
  const bare: SessionRequest = { ...preflightRequest("codex"), prompt: request.prompt };
  if (request.allowedTools !== undefined) bare.allowedTools = request.allowedTools;
  if (request.appendSystemPrompt !== undefined) bare.appendSystemPrompt = request.appendSystemPrompt;
  return inPrivateHome("codex", bare, async (options) => {
    const result = await runCodexAppServer({ ...bare, cwd: options.cwd }, undefined, {
      ...options,
      handshakeOnly: true,
    });
    return result.stdout;
  });
}

const FLAG = /^--?[A-Za-z][A-Za-z-]*$/;
const VALUE_WITHHELD = /argument missing|a value is required/i;

function preflightCommands(host: HostKind, evalCases: readonly EvalCase[], bundle: string) {
  const subject: Subject = { id: `preflight-${host}`, host, model: "preflight-binding" };
  return evalCases.map((evalCase) => {
    const request = requestFor(evalCase, subject, "<preflight-scaffold>", bundle);
    return { evalCase, request, command: adapterFor(host).command(request, subject.model) };
  });
}

/**
 * Every flag the adapter would pass for these cases, checked against the installed CLI. A flag is
 * accepted when the CLI's own help lists it. A flag the help omits is accepted only when it takes a
 * value and the CLI, given the flag alone, answers that the value is missing: that reply comes from
 * the argument parser before any session starts, and an unknown flag gets a different one.
 */
function flagCheck(
  host: HostKind,
  evalCases: readonly EvalCase[],
  bundle: string,
  cli: (argv: readonly string[]) => string,
): PreflightCheck {
  const flags = new Map<string, boolean>();
  let program: string[] = [host];
  for (const { command } of preflightCommands(host, evalCases, bundle)) {
    const first = command.findIndex((token) => FLAG.test(token));
    program = command.slice(0, first < 0 ? command.length : first);
    command.forEach((token, index) => {
      if (!FLAG.test(token)) return;
      const next = command.at(index + 1);
      flags.set(token, next !== undefined && !FLAG.test(next));
    });
  }
  const help = cli([...program, "--help"]);
  const unlisted = [...flags].filter(([flag]) => !new RegExp(`(^|[\\s,])${flag}(?=[\\s,=<[]|$)`, "m").test(help));
  const parsed = unlisted.filter(([flag, takesValue]) => {
    if (!takesValue) return false;
    const reply = cli([...program, flag]);
    return reply.includes(flag) && VALUE_WITHHELD.test(reply);
  });
  const rejected = unlisted.flatMap((entry) => (parsed.includes(entry) ? [] : [entry[0]]));
  const source = `\`${program.join(" ")} --help\``;
  return {
    name: "cli-flags",
    ok: rejected.length === 0,
    detail:
      rejected.length > 0
        ? `${source} does not list ${rejected.join(", ")}`
        : `${flags.size - parsed.length} flag(s) listed by ${source}${
            parsed.length === 0
              ? ""
              : `; ${parsed.map(([flag]) => flag).join(", ")} absent from help, accepted by the argument parser`
          }`,
  };
}

function restricted(command: readonly string[]): string[] {
  return (lastFlagValue(command, "--tools") ?? "").split(",").filter((id) => id !== "");
}

/**
 * Every tool id a case's `--tools` set carries must be one the installed CLI advertises, every
 * granted tool must contribute an id, and a case that loads a skill must keep `read_file`, which is
 * how the CLI loads one.
 */
async function grokToolCheck(
  evalCases: readonly EvalCase[],
  bundle: string,
  grokTools: () => Promise<string[]>,
): Promise<PreflightCheck> {
  const advertised = new Set(await grokTools());
  const failures: string[] = [];
  if (advertised.size === 0) failures.push("the CLI advertised no tool list");
  for (const { evalCase, request, command } of advertised.size === 0
    ? []
    : preflightCommands("grok", evalCases, bundle)) {
    const ids = restricted(command);
    const unknown = ids.filter((id) => !advertised.has(id));
    if (unknown.length > 0) failures.push(`${evalCase.name}: the CLI has no tool ${unknown.join(", ")}`);
    const unmapped = evalCase.execution.allowed_tools.filter(
      (tool) => restricted(adapterFor("grok").command({ ...request, allowedTools: [tool] }, undefined)).length === 0,
    );
    if (unmapped.length > 0) failures.push(`${evalCase.name}: grant ${unmapped.join(", ")} restricts to no tool`);
    if (/\/ak:[a-z0-9-]+/.test(evalCase.execution.prompt) && !ids.includes("read_file"))
      failures.push(`${evalCase.name}: loads a skill without read_file`);
  }
  return {
    name: "tool-names",
    ok: failures.length === 0,
    detail:
      failures.length === 0
        ? `every --tools id is among the ${advertised.size} the CLI advertises`
        : failures.join("; "),
  };
}

async function codexIdentityCheck(
  evalCases: readonly EvalCase[],
  bundle: string,
  handshake: (request: SessionRequest) => Promise<string>,
): Promise<PreflightCheck> {
  const failures: string[] = [];
  for (const { evalCase, request } of preflightCommands("codex", evalCases, bundle)) {
    const parsed = adapterFor("codex").parse(await handshake(request));
    if (parsed.servedModel === undefined || parsed.sessionId === undefined)
      failures.push(`${evalCase.name}: thread/start returned no model or thread id`);
  }
  return {
    name: "thread-identity",
    ok: failures.length === 0,
    detail:
      failures.length === 0
        ? `thread/start returned a model and thread id for ${evalCases.length} case request(s), no turn started`
        : failures.join("; "),
  };
}

/** A probe that throws, such as a CLI that cannot be spawned, is a failed check in its host's row. */
async function probed(name: string, check: () => PreflightCheck | Promise<PreflightCheck>): Promise<PreflightCheck> {
  try {
    return await check();
  } catch (error) {
    return { name, ok: false, detail: `probe failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export async function preflightHosts(
  matrix: Pick<Matrix, "reviewers" | "panels">,
  subjects: readonly Subject[],
  evalCases: readonly EvalCase[],
  bundleRoot: string,
  probes: PreflightProbes = {},
): Promise<PreflightRow[]> {
  const binary = probes.binary ?? defaultBinaryProbe;
  const login = probes.login ?? defaultLoginProbe;
  const cli = probes.cli ?? defaultCliProbe;
  const binaries = new Map<HostKind, boolean>();
  const logins = new Map<HostKind, boolean>();
  const hasBinary = (host: HostKind) => {
    if (!binaries.has(host)) binaries.set(host, binary(host));
    return binaries.get(host) ?? false;
  };
  const isLoggedIn = (host: HostKind) => {
    if (!logins.has(host)) logins.set(host, login(host));
    return logins.get(host) ?? false;
  };
  const rows: PreflightRow[] = [];
  for (const host of new Set(subjects.map((subject) => subject.host))) {
    const hostSubjects = subjects.filter((subject) => subject.host === host);
    const unready = readinessProblems(matrix, hostSubjects, evalCases);
    const reviewerHosts = [
      ...new Set(hostSubjects.flatMap((subject) => buildPanel(matrix, subject).members.map((member) => member.host))),
    ];
    const unavailableReviewers = reviewerHosts.filter(
      (reviewerHost) => !hasBinary(reviewerHost) || !isLoggedIn(reviewerHost),
    );
    const bundle = join(bundleRoot, BUNDLE_FOR[host]);
    const skills = skillIds(evalCases);
    const missingSkills = skills.filter((id) => !existsSync(join(bundle, "skills", id, "SKILL.md")));
    const missingFixtures = evalCases.flatMap((evalCase) => {
      const scaffold = evalCase.context?.scaffold_script;
      if (scaffold === undefined) return [];
      const file = resolve(PACKAGE_ROOT, dirname(evalCase.file), scaffold);
      return existsSync(file) ? [] : [evalCase.name];
    });
    const checks: PreflightCheck[] = [
      { name: "binary", ok: hasBinary(host), detail: "host CLI resolves locally" },
      { name: "login", ok: isLoggedIn(host), detail: "credential source is present and valid" },
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
      {
        name: "grader-readiness",
        ok: unready.length === 0,
        detail: unready.length === 0 ? "every panel seats and every grader runs locally" : unready.join("; "),
      },
      {
        name: "reviewer-hosts",
        ok: unavailableReviewers.length === 0,
        detail:
          unavailableReviewers.length === 0
            ? `${reviewerHosts.length} reviewer host(s) resolve and are logged in`
            : `unavailable ${unavailableReviewers.join(", ")}`,
      },
      await probed("cli-flags", () => flagCheck(host, evalCases, bundle, cli)),
    ];
    if (host === "grok")
      checks.push(
        await probed("tool-names", () => grokToolCheck(evalCases, bundle, probes.grokTools ?? defaultGrokTools)),
      );
    if (host === "codex")
      checks.push(
        await probed("thread-identity", () =>
          codexIdentityCheck(evalCases, bundle, probes.codexHandshake ?? defaultCodexHandshake),
        ),
      );
    rows.push({ mode: "preflight", host, ok: checks.every(({ ok }) => ok), checks });
  }
  return rows;
}

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
      const rows = await preflightHosts(matrix, subjects, cases, bundleRoot, {
        binary: dependencies.binaryProbe,
        login: dependencies.loginProbe,
        cli: dependencies.cliProbe,
        grokTools: dependencies.grokToolsProbe,
        codexHandshake: dependencies.codexHandshakeProbe,
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

    const unready = readinessProblems(matrix, subjects, cases);
    if (unready.length > 0) throw new Error(`no session started: ${unready.join("; ")}`);
    const priced = matrixPrices(matrix.priceTable);
    const outputFile = lastFlagValue(argv, "--json");
    if (outputFile === undefined) throw new Error("--execute requires --json");
    const maxSpendUsd = Number(lastFlagValue(argv, "--max-spend-usd"));
    const estimates = loadEstimates(resolve(PACKAGE_ROOT, lastFlagValue(argv, "--estimates") ?? ""), subjects, cases);
    const json = resolve(PACKAGE_ROOT, outputFile);
    const rawDir = dependencies.rawDir ?? join(PACKAGE_ROOT, ".work", "case-runner");
    const stem = basename(json).replace(/\.json$/, "");
    const raw = join(rawDir, `${stem}.raw.json`);
    const queue = join(rawDir, `${stem}.queue.jsonl`);
    const start = dependencies.startSubject ?? runSubject;
    const bundles = subjects.map((subject) => join(bundleRoot, BUNDLE_FOR[subject.host]));
    const missing = [...new Set(bundles.filter((bundleDir) => !existsSync(bundleDir)))];
    if (missing.length > 0) throw new Error(`${missing.join(", ")} missing; run bun run ak build --profile all`);
    const rows: CaseSessionResult[] = [];
    const started: SessionResult[] = [];
    const judge = dependencies.judge ?? hostJudge(priced.prices);
    let aborted: {
      subject: string;
      case: string;
      stage: "scaffold" | "subject" | "grading";
      reason: string;
      cost_usd: number | null;
      session: SessionResult | null;
      files_created: string[];
      artifacts: Artifacts;
    } | null = null;
    const skipped: Array<{ subject: string; case: string; reason: SkipReason }> = [];
    let chargedUsd = 0;
    let stop: Exclude<SkipReason, "subject-failed" | "ungraded-row"> | null = null;
    for (const subject of subjects) {
      const adapter = adapterFor(subject.host);
      const bundleDir = join(bundleRoot, BUNDLE_FOR[subject.host]);
      const panel = buildPanel(matrix, subject);
      let subjectStop: "ungraded-row" | "subject-failed" | null = null;
      for (const evalCase of cases) {
        const estimate = estimates[subject.id]?.[evalCase.name] ?? 0;
        if (stop === null && subjectStop === null && chargedUsd + estimate > maxSpendUsd) stop = "spend-cap";
        const skip = stop ?? subjectStop;
        if (skip !== null) {
          skipped.push({ subject: subject.id, case: evalCase.name, reason: skip });
          continue;
        }
        let prepared: PreparedCase | undefined;
        let session: SessionResult | undefined;
        let judgeSpend: number | undefined;
        let filesCreated: string[] = [];
        try {
          prepared = prepareCase(evalCase);
          const request = requestFor(evalCase, subject, prepared.cwd, bundleDir);
          session = await start(adapter, subject.id, subject.model, request, priced.prices);
          started.push(session);
          const after = filesUnder(prepared.cwd);
          const before = prepared.before;
          filesCreated = [...after].filter((file) => !before.has(file)).toSorted();
          const row = await evaluateCaseSession(evalCase, session, {
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
          });
          rows.push(row);
          chargedUsd += (row.subject_cost_usd ?? estimate) + row.grader_cost_usd;
          if (row.validity === "invalid") stop = "invalid-row";
          else if (row.result === "ungraded") subjectStop = "ungraded-row";
          else if (row.result === "fail") subjectStop = "subject-failed";
        } catch (error) {
          stop = "aborted";
          chargedUsd += (prepared === undefined ? 0 : (session?.costUsd ?? estimate)) + (judgeSpend ?? 0);
          aborted = {
            subject: subject.id,
            case: evalCase.name,
            stage: prepared === undefined ? "scaffold" : session === undefined ? "subject" : "grading",
            reason: error instanceof Error ? error.message : String(error),
            cost_usd:
              session?.costUsd === undefined && judgeSpend === undefined
                ? null
                : (session?.costUsd ?? 0) + (judgeSpend ?? 0),
            session: session ?? null,
            files_created: filesCreated,
            artifacts: prepared === undefined ? {} : snapshotArtifacts(prepared.cwd, filesCreated),
          };
        } finally {
          if (prepared !== undefined) rmSync(prepared.cwd, { recursive: true, force: true });
        }
      }
    }

    const report = summariseCaseSessions(rows);
    const costUsd = aborted?.cost_usd == null ? report.cost_usd : (report.cost_usd ?? 0) + aborted.cost_usd;
    const rawText = `${JSON.stringify(
      {
        receipt: relative(PACKAGE_ROOT, json),
        sessions: rows,
        aborted,
      },
      null,
      2,
    )}\n`;
    mkdirSync(rawDir, { recursive: true });
    writeFileSync(raw, rawText);
    const rawReference = { path: relative(PACKAGE_ROOT, raw), sha256: sha256Hex(rawText) };
    const receipt = {
      ...evalInstrument(PACKAGE_ROOT, revision()),
      argv: ["bun", "tests/learn/evals/case-runner.ts", ...argv],
      price_table: priced.price_table,
      cases: cases.map(({ name, file, sha256 }) => ({ name, file, sha256 })),
      subjects: subjects.map(({ id, host }) => ({ id, host })),
      ...usageReceipt(started),
      cost_usd: costUsd,
      summary: report.summary,
      max_spend_usd: maxSpendUsd,
      charged_usd: chargedUsd,
      skipped,
      raw: rawReference,
      aborted:
        aborted === null
          ? null
          : {
              subject: aborted.subject,
              case: aborted.case,
              stage: aborted.stage,
              cost_usd: aborted.cost_usd,
              files_created: aborted.files_created,
              artifacts: artifactHashes(aborted.artifacts),
              served_model: aborted.session?.servedModel ?? null,
              session_id: aborted.session?.sessionId ?? null,
              session: aborted.session === null ? null : sessionFacts(aborted.session),
            },
    };
    mkdirSync(dirname(json), { recursive: true });
    writeFileSync(json, `${JSON.stringify({ receipt, sessions: report.sessions.map(committedRow) }, null, 2)}\n`);
    out(
      JSON.stringify({
        receipt: relative(PACKAGE_ROOT, json),
        raw: rawReference.path,
        summary: report.summary,
        cost_usd: costUsd,
        sessions: rows.map((row) => ({
          subject: row.subject,
          case: row.case,
          validity: row.validity,
          result: row.result,
          invalid_reason: reasonClass(row.invalid_reason),
          served_model: row.served_model,
        })),
        charged_usd: chargedUsd,
        skipped,
        aborted: aborted === null ? null : { subject: aborted.subject, case: aborted.case, stage: aborted.stage },
      }),
    );
    if (aborted !== null) {
      err(`case-runner: ${aborted.subject} ${aborted.case}: ${aborted.reason}`);
      return 2;
    }
    return report.summary.failed > 0 || report.summary.invalid > 0 || report.summary.ungraded > 0 || skipped.length > 0
      ? 1
      : 0;
  } catch (error) {
    err(`case-runner: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
