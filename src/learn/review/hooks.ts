/**
 * The review loop's host hooks.
 *
 * Stop: gate, debounce ten minutes per project, then detach `ak learn review
 * run` followed by `ak learn skills run` so the session never waits on a
 * judge call. Prompt: a submitted prompt that reads as a correction of the
 * agent is appended to the raw layer as a `correction` event.
 *
 * Correction detection is ported from claude-reflect's `detect_patterns`
 * (`scripts/lib/reflect_utils.py`), pattern tables and thresholds unchanged.
 */
import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, statSync, utimesSync } from "node:fs";
import { join } from "node:path";
import type { LearnArgs, LearnContext } from "../core/context.ts";
import { flag } from "../core/context.ts";
import { mainRepoRoot } from "../core/paths.ts";
import { recordWorktree } from "../memory/registry.ts";
import { AK_ENTRY } from "../core/roles.ts";
import { nowIso } from "../core/store.ts";
import { appendCapped, carrierOf } from "../core/trace.ts";
import type { HookPayload } from "../hooks.ts";
import { appendEvents } from "./events.ts";
import { correctionEvent, memProject } from "./ingest.ts";
import { reviewLedger, reviewLedgerDir } from "./ledger.ts";

/** The session's working directory: the payload's when it names one, else the process's. */
export function payloadCwd(payload: HookPayload, fallback: string): string {
  return typeof payload.cwd === "string" && payload.cwd !== "" ? payload.cwd : fallback;
}

export const DEBOUNCE_MS = 10 * 60 * 1000;
export const LAST_RUN_FILE = "raw/.last_run";
export const PIPELINE_LOG = "raw/.pipeline.log";

/** Starts a detached background process. Injectable so tests never spawn. */
export type Spawner = (argv: readonly string[], options: { cwd: string; env?: NodeJS.ProcessEnv }) => void;

export const detachSpawner: Spawner = (argv, options) => {
  const [bin, ...rest] = argv;
  if (bin === undefined) return;
  const child = spawn(bin, rest, { cwd: options.cwd, detached: true, stdio: "ignore", env: options.env });
  child.unref();
};

/**
 * The detached pipeline's environment: this hook's own, with the hook span as
 * its trace parent and a marker that the runs it starts were started by a
 * hook. The ambient TRACESTATE and BAGGAGE belong to the replaced carrier.
 */
function pipelineEnv(ctx: LearnContext): NodeJS.ProcessEnv {
  const { TRACESTATE: _state, BAGGAGE: _baggage, ...env } = ctx.env;
  env.AK_LEARN_TRIGGER = "hook";
  if (ctx.span !== undefined) env.TRACEPARENT = carrierOf(ctx.span);
  return env;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * `sh -c` running the review pipeline then the debounced skill-learn entry for `root`, both appending to the
 * pipeline log. `cwd` is the session's working directory, where the current branch's PR is resolved.
 * The script text is fixed: root, source, log and cwd reach it only as the positional parameters `$1` to
 * `$4`, always double-quoted, so no path can be read as shell syntax. `ak` replaces the CLI in tests.
 */
export function pipelineCommand(
  root: string,
  cwd: string,
  source: string,
  logFile: string,
  ak: readonly string[] = [process.execPath, AK_ENTRY],
): string[] {
  const cli = ak.map(shellQuote).join(" ");
  const review = `${cli} 'learn' 'review' 'run' '--repo' "$1" '--cwd' "$4" '--source' "$2" >> "$3" 2>&1`;
  const skills = `${cli} 'learn' 'skills' 'run' '--repo' "$1" >> "$3" 2>&1`;
  const stamp = `printf '== %s %s %s\\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$2" "$1" >> "$3"`;
  return ["sh", "-c", `${stamp}; ${review}; ${skills}`, "sh", root, source, logFile, cwd];
}

function touch(path: string): void {
  if (!existsSync(path)) closeSync(openSync(path, "w"));
  const now = new Date();
  utimesSync(path, now, now);
}

/** Stop hook. Skips plugin-cache sessions, nested stops, non-git directories and runs inside the debounce window. */
export function stopHook(
  ctx: LearnContext,
  payload: HookPayload,
  args: LearnArgs,
  spawner: Spawner = detachSpawner,
): void {
  const cwd = payloadCwd(payload, ctx.cwd);
  ctx.span?.status("skipped");
  if (cwd.includes("/plugins/cache/") || payload.stop_hook_active === true) return;
  const root = mainRepoRoot(cwd);
  if (root === null) {
    ctx.span?.status("skipped", "not-a-repo");
    return;
  }
  ctx.span?.project(root);
  recordWorktree(ctx.config, cwd, root);
  const mark = join(reviewLedgerDir(ctx.config, root), LAST_RUN_FILE);
  if (existsSync(mark) && Date.now() - statSync(mark).mtimeMs < DEBOUNCE_MS) {
    ctx.span?.status("skipped", "debounced");
    return;
  }
  if (ctx.config.dryRun) {
    ctx.span?.status("dry-run");
    ctx.io.err(`ak learn hook stop: dry run, would detach the review pipeline for ${root}`);
    return;
  }
  const ledger = reviewLedger(ctx.config, root);
  touch(mark);
  const source = flag(args, "source") === "codex" ? "codex" : "claude";
  const log = ledger.path(PIPELINE_LOG);
  // The detached shell appends to the log, so the cap is applied here, before it starts.
  appendCapped(log, "", ctx.config.traceMaxBytes);
  spawner(pipelineCommand(root, cwd, source, log), { cwd: root, env: pipelineEnv(ctx) });
  ctx.span?.status("ok");
  ctx.span?.attr("spawned", true);
}

export type DetectionType = "explicit" | "guardrail" | "positive" | "auto";

export interface Detection {
  type: DetectionType | null;
  /** Matched pattern names, space-separated. */
  patterns: string;
  confidence: number;
  sentiment: "correction" | "positive";
  decayDays: number;
}

const EXPLICIT: ReadonlyArray<readonly [string, string, number, number]> = [["remember:", "remember:", 0.9, 120]];

const POSITIVE: ReadonlyArray<readonly [string, string, number, number]> = [
  ["perfect!|exactly right|that's exactly", "perfect", 0.7, 90],
  ["that's what I wanted|great approach", "great-approach", 0.7, 90],
  ["keep doing this|love it|excellent|nailed it", "keep-doing", 0.7, 90],
];

const CORRECTION: ReadonlyArray<readonly [string, string, boolean]> = [
  ["^no[,.!:;\\u2014\\u2013-]+\\s*\\S", "no,", true],
  ["^no\\s+\\S", "no-bare", true],
  ["^don't\\b|^do not\\b", "don't", true],
  ["^stop\\b|^never\\b", "stop/never", true],
  ["that's (wrong|incorrect)|that is (wrong|incorrect)", "that's-wrong", true],
  ["^actually[,. ]", "actually", false],
  ["^I meant\\b|^I said\\b", "I-meant/said", true],
  ["^I told you\\b|^I already told\\b", "I-told-you", true],
  ["use .{1,30} not\\b", "use-X-not-Y", true],
];

const GUARDRAIL: ReadonlyArray<readonly [string, string, number, number]> = [
  ["don't (?:add|include|create) .{1,40} unless", "dont-unless-asked", 0.9, 120],
  ["only (?:change|modify|edit|touch) what I (?:asked|requested|said)", "only-what-asked", 0.9, 120],
  ["stop (?:refactoring|changing|modifying|editing) (?:unrelated|other|surrounding)", "stop-unrelated", 0.9, 120],
  ["don't (?:over-engineer|add extra|be too|make unnecessary)", "dont-over-engineer", 0.85, 90],
  ["don't (?:refactor|reorganize|restructure) (?:unless|without)", "dont-refactor-unless", 0.85, 90],
  ["leave .{1,30} (?:alone|unchanged|as is)", "leave-alone", 0.85, 90],
  [
    "don't (?:add|include) (?:comments|docstrings|type hints|annotations) (?:unless|to code)",
    "dont-add-annotations",
    0.85,
    90,
  ],
  ["(?:minimal|minimum|only necessary) changes", "minimal-changes", 0.8, 90],
];

const FALSE_POSITIVE = [
  "[?\\uff1f]$",
  "[\\u55ce\\u5417\\u5462\\u304b\\uae4c]$",
  "^(please|can you|could you|would you|help me)\\b",
  "(help|fix|check|review|figure out|set up)\\s+(this|that|it|the)\\b",
  "(error|failed|could not|cannot|can't|unable to)\\s+\\w+",
  "(is|was|are|were)\\s+(not|broken|failing)",
  "^I (need|want|would like)\\b",
  "^(ok|okay|alright)[,.]?\\s+(so|now|let)",
];

const NON_CORRECTION = [
  "^no\\s+problem",
  "^no\\s+worries",
  "^no\\s+need\\b",
  "^no\\s+way\\b",
  "^don't\\s+worry",
  "^don't\\s+mind",
  "^don't\\s+bother",
  "^never\\s+mind",
  "^no\\s+idea\\b",
  "^no\\s+(?:it|that|this|we|i|you|they)\\s+(?:works?|worked|looks?|seems?|sounds?|reads?)\\b",
  "^no\\s+(?:it|that|this)\\s+(?:'s|is|was)\\s+(?:fine|good|ok|okay|right|correct)\\b",
  "^no\\s+(?:i|we)\\s+(?:think|guess|believe|reckon)\\b",
  "^no\\s+(?:you|we|i)\\s+(?:can|could|should)\\s+go\\s+ahead\\b",
  "^no\\s+(?:i|we)(?:'m|'re| am| are)?\\s+(?:all\\s+)?(?:good|done|set|fine)\\b",
  "^no\\s+[\\w-]+\\s+(?:appeared|happened|occurred|showed|showed\\s+up|returned|existed|came|come|changed|matched|was|were|has|have|had)\\b",
  "^no\\s+(?:rush|hurry|pressure|problem|stress)\\b",
  "^stop\\s+worrying",
];

const CJK_CORRECTION: ReadonlyArray<readonly [string, string, boolean]> = [
  ["^いや[、,.\\s]|^いや違", "iya", true],
  ["^違う[、，,.\\s！!。]|^ちがう[、,.\\s]", "chigau", true],
  ["そうじゃなく[てけ]|そっちじゃなく[てけ]", "souja-nakute", true],
  ["間違[いえっ]て", "machigatte", true],
  ["じゃなくて.{0,30}にして", "janakute-nishite", true],
  ["^やめて[。！!]?\\s*$", "yamete", true],
  ["^そうじゃない", "souja-nai", true],
  ["って言った[のよでじゃ]", "tte-itta", true],
  ["^不是[，,. ]", "bushi", true],
  ["^错了|^錯了", "cuole", true],
  ["不要.{0,20}要", "buyao-yao", true],
  ["^아니[,. ]", "ani", true],
  ["틀렸", "teullyeoss", true],
];

const FORWARD_PIVOT = [
  "\\b(now|next)[, ]+let'?s\\b",
  "\\b(now|next)[, ]+(we|i)\\s+(need to|should|have to|must|will)\\b",
  "\\blet'?s (add|do|build|move|update|change|fix|implement)\\b",
  "\\bgo ahead and\\s+\\w+",
];

const SLASH_COMMAND = /^\/[A-Za-z][\w.-]*(?::[\w.-]+)?(?:\s|$)/;
const CJK = /[　-鿿豈-﫿가-힯]/;
const MAX_WEAK_PATTERN_LENGTH = 150;
const MIN_SHORT_CORRECTION_LENGTH = 80;
const MIN_POSITIVE_CONTEXT_LENGTH = 25;
/** Longer prompts are almost always pasted content, not a correction; `remember:` is exempt. */
export const MAX_CAPTURE_PROMPT_LENGTH = 500;

/** `re.search` with the donor's flags. The donor's `$` also matches before one final newline; callers pass trimmed text. */
function search(source: string, text: string, ignoreCase = true): boolean {
  return new RegExp(source, ignoreCase ? "i" : "").test(text);
}

const NONE = (sentiment: "correction" | "positive" = "correction"): Detection => ({
  type: null,
  patterns: "",
  confidence: 0,
  sentiment,
  decayDays: 90,
});

/** Classify a user message. A port of claude-reflect's `detect_patterns`, same tables and same order of checks. */
export function detectPatterns(text: string): Detection {
  if (SLASH_COMMAND.test(text.trimStart())) return NONE();
  const stripped = text.trim();
  if (stripped.length <= (CJK.test(stripped) ? 2 : 4)) return NONE();

  for (const [pattern, name, confidence, decay] of EXPLICIT) {
    if (search(pattern, text))
      return { type: "explicit", patterns: name, confidence, sentiment: "correction", decayDays: decay };
  }
  for (const [pattern, name, confidence, decay] of GUARDRAIL) {
    if (search(pattern, text))
      return { type: "guardrail", patterns: name, confidence, sentiment: "correction", decayDays: decay };
  }
  if (FALSE_POSITIVE.some((pattern) => search(pattern, text))) return NONE();
  if (NON_CORRECTION.some((pattern) => search(pattern, text))) return NONE();

  const positive = POSITIVE.values()
    .filter(([pattern]) => search(pattern, text))
    .map(([, name]) => name)
    .toArray();
  if (positive.length > 0) {
    if (stripped.length < MIN_POSITIVE_CONTEXT_LENGTH) return NONE("positive");
    if (FORWARD_PIVOT.some((pattern) => search(pattern, text))) return NONE();
    return { type: "positive", patterns: positive.join(" "), confidence: 0.7, sentiment: "positive", decayDays: 90 };
  }

  const length = text.length;
  const cjk = CJK_CORRECTION.filter(([pattern]) => search(pattern, stripped, false));
  if (cjk.length > 0) {
    const strong = cjk.some(([, , isStrong]) => isStrong);
    let confidence = strong ? 0.75 : 0.6;
    if (length < MIN_SHORT_CORRECTION_LENGTH) confidence = Math.min(0.9, confidence + 0.1);
    else if (length > 300) confidence = Math.max(0.5, confidence - 0.15);
    return {
      type: "auto",
      patterns: cjk.map(([, name]) => name).join(" "),
      confidence,
      sentiment: "correction",
      decayDays: strong ? 90 : 60,
    };
  }

  const matched = CORRECTION.filter(
    ([pattern, , strong]) => search(pattern, text) && (strong || length <= MAX_WEAK_PATTERN_LENGTH),
  );
  if (matched.length === 0) return NONE();
  const names = matched.map(([, name]) => name);
  const strong = matched.some(([, , isStrong]) => isStrong);
  let confidence: number;
  let decayDays: number;
  if (names.includes("I-told-you") || matched.length >= 3) [confidence, decayDays] = [0.85, 120];
  else if (matched.length >= 2) [confidence, decayDays] = [0.75, 90];
  else if (strong) [confidence, decayDays] = [0.7, 60];
  else [confidence, decayDays] = [0.55, 45];
  if (length < MIN_SHORT_CORRECTION_LENGTH) confidence = Math.min(0.9, confidence + 0.1);
  else if (length > 300) confidence = Math.max(0.5, confidence - 0.15);
  else if (length > 150) confidence = Math.max(0.55, confidence - 0.1);
  return { type: "auto", patterns: names.join(" "), confidence, sentiment: "correction", decayDays };
}

/**
 * Prompt hook. Detection runs first, so a prompt that is not a correction costs no git call and no
 * write. Under a repo scope the hook entry resolves the root before this runs, one git call a prompt.
 */
export function promptHook(ctx: LearnContext, payload: HookPayload, args: LearnArgs): void {
  const raw =
    typeof payload.prompt === "string"
      ? payload.prompt
      : typeof payload.user_prompt === "string"
        ? payload.user_prompt
        : "";
  const prompt = raw.trim();
  ctx.span?.status("nothing");
  ctx.span?.attr("captured", false);
  if (prompt === "" || prompt.startsWith("<")) return;
  if (prompt.length > MAX_CAPTURE_PROMPT_LENGTH && !/remember:/i.test(prompt)) return;
  const detection = detectPatterns(prompt);
  ctx.span?.attr("detection", detection.type ?? "none");
  if (detection.type === null || detection.sentiment !== "correction") return;
  const cwd = payloadCwd(payload, ctx.cwd);
  if (cwd.includes("/plugins/cache/")) return;
  const root = mainRepoRoot(cwd);
  if (root === null) return;
  ctx.span?.project(root);
  if (ctx.config.dryRun) {
    ctx.span?.status("dry-run");
    return;
  }
  recordWorktree(ctx.config, cwd, root);
  const ledger = reviewLedger(ctx.config, root);
  const platform = flag(args, "source") === "codex" ? "codex" : "claude";
  appendEvents(ledger, [
    correctionEvent(prompt, nowIso(), memProject(ctx, root), platform, {
      patterns: detection.patterns,
      confidence: detection.confidence,
    }),
  ]);
  ctx.span?.status("ok");
  ctx.span?.attr("captured", true);
}
