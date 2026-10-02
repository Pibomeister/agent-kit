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
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
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
import type { SessionRequest, SessionResult, TokenUsage, ToolEvent } from "./subjects/types.ts";
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
  return existsSync(file) ? readFileSync(file, "utf8") : "";
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
  const invalid = invalidSession(session, cap);
  const base = {
    case: evalCase.name,
    case_file: evalCase.file,
    subject: session.subject,
    host: session.host,
    subject_cost_usd: session.costUsd ?? null,
    command: options.command ?? [],
    files_created: [...options.filesCreated],
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
  const request: SessionRequest = {
    prompt: evalCase.execution.prompt,
    cwd,
    env: { ...cleanEnv(adapter.env), ...evalCase.execution.env },
    timeoutMs: (evalCase.execution.timeout_seconds ?? 600) * 1000,
    allowedTools: evalCase.execution.allowed_tools,
    bundleDir,
  };
  const cap = effectiveMaxTurns(subject, evalCase.execution.max_turns);
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
  out?: (line: string) => void;
  err?: (line: string) => void;
  startSubject?: StartSubject;
  judge?: Judge;
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
  const valueFlags = new Set(["--subject", "--case", "--matrix", "--json", "--queue", "--bundle"]);
  const switches = new Set(["--dry-run", "--execute"]);
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
  if (argv.includes("--dry-run") && argv.includes("--execute"))
    problems.push("choose --dry-run or --execute, not both");
  if (!argv.includes("--dry-run") && !argv.includes("--execute")) problems.push("pass --dry-run or --execute");
  if (flagValues(argv, "--subject").length === 0) problems.push("at least one --subject is required");
  if (flagValues(argv, "--case").length === 0) problems.push("at least one --case is required");
  if (argv.includes("--execute") && lastFlagValue(argv, "--json") === undefined)
    problems.push("--execute requires --json");
  return problems;
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
    const matrix = dependencies.matrix ?? loadMatrix(lastFlagValue(argv, "--matrix") ?? MATRIX_FILE);
    const wanted = new Set(flagValues(argv, "--subject"));
    const subjects = matrix.subjects.filter((subject) => wanted.has(subject.id));
    const absent = [...wanted].filter((id) => !subjects.some((subject) => subject.id === id));
    if (absent.length > 0) throw new Error(`matrix has no subject(s): ${absent.join(", ")}`);
    const cases = flagValues(argv, "--case").map(loadCase);
    const bundleRoot = resolve(PACKAGE_ROOT, lastFlagValue(argv, "--bundle") ?? "dist");
    if (argv.includes("--dry-run")) {
      for (const subject of subjects)
        for (const evalCase of cases) out(JSON.stringify(planRow(evalCase, subject, bundleRoot)));
      return 0;
    }

    const priced = matrixPrices(matrix.priceTable);
    const outputFile = lastFlagValue(argv, "--json");
    if (outputFile === undefined) throw new Error("--execute requires --json");
    const queue = lastFlagValue(argv, "--queue") ?? `${outputFile}.queue.jsonl`;
    const start = dependencies.startSubject ?? runSubject;
    const bundles = subjects.map((subject) => join(bundleRoot, BUNDLE_FOR[subject.host]));
    const missing = [...new Set(bundles.filter((bundleDir) => !existsSync(bundleDir)))];
    if (missing.length > 0) throw new Error(`${missing.join(", ")} missing; run bun run ak build --profile all`);
    const rows: CaseSessionResult[] = [];
    const started: SessionResult[] = [];
    let aborted: { subject: string; case: string; reason: string; subject_cost_usd: number | null } | null = null;
    sessions: for (const subject of subjects) {
      const adapter = adapterFor(subject.host);
      const bundleDir = join(bundleRoot, BUNDLE_FOR[subject.host]);
      const panel = buildPanel(matrix, subject);
      for (const evalCase of cases) {
        let prepared: PreparedCase | undefined;
        let session: SessionResult | undefined;
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
              judge: dependencies.judge ?? hostJudge(priced.prices),
              maxTurns: request.maxTurns ?? null,
              command: adapter.command(request, subject.model),
            }),
          );
        } catch (error) {
          aborted = {
            subject: subject.id,
            case: evalCase.name,
            reason: error instanceof Error ? error.message : String(error),
            subject_cost_usd: session?.costUsd ?? null,
          };
        } finally {
          if (prepared !== undefined) rmSync(prepared.cwd, { recursive: true, force: true });
        }
        if (aborted !== null) break sessions;
      }
    }

    const report = summariseCaseSessions(rows);
    const json = resolve(PACKAGE_ROOT, outputFile);
    mkdirSync(dirname(json), { recursive: true });
    const receipt = {
      ...evalInstrument(PACKAGE_ROOT, revision()),
      argv: ["bun", "tests/learn/evals/case-runner.ts", ...argv],
      price_table: priced.price_table,
      cases: cases.map(({ name, file, sha256 }) => ({ name, file, sha256 })),
      subjects: subjects.map(({ id, host }) => ({ id, host })),
      ...usageReceipt(started),
      cost_usd: aborted?.subject_cost_usd == null ? report.cost_usd : (report.cost_usd ?? 0) + aborted.subject_cost_usd,
      summary: report.summary,
      aborted,
    };
    writeFileSync(json, `${JSON.stringify({ receipt, ...report }, null, 2)}\n`);
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
