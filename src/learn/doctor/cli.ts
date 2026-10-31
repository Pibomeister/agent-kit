/**
 * `ak learn doctor` — score recent local sessions against four rubrics, propose
 * gated skill edits from the failed ones, and render one HTML report.
 *
 * Transcripts never leave the machine through this command: they are read from
 * the hosts' own stores, condensed into a directory the caller names, which may
 * not be a tracked part of any repository, and handed only to the configured
 * judge command. The judge runs without metered credentials in its environment
 * (`core/judge.ts` `subscriptionEnv`), so it answers on the host's signed-in
 * seat or not at all. Nothing here edits a skill file (ruling
 * `learning-drafts-not-publishes`); `--record` writes the scores' labels and the
 * proposals to the repository's skills ledger, and `accept` / `reject` record a
 * human's decision there for the next run to read.
 */
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { flag, type LearnArea, type LearnArgs, type LearnContext } from "../core/context.ts";
import { Ledger } from "../core/ledger.ts";
import { loopDir, mainRepoRoot } from "../core/paths.ts";
import { run as runProcess } from "../core/proc.ts";
import { readJson, writeGated, writeJson } from "../core/store.ts";
import { skillsLedger } from "../skills/learn.ts";
import { ClaudeMemSource } from "../sources/claude-mem.ts";
import { userHome } from "../sources/worker-sessions.ts";
import {
  collect,
  type Collection,
  type CollectOptions,
  DEFAULT_DAYS,
  DEFAULT_MAX_SESSIONS,
  DEFAULT_NO_SKILL,
  DEFAULT_PER_SKILL,
  defaultHomes,
  DOCTOR_HOSTS,
  type DoctorHost,
  renderTranscript,
} from "./collect.ts";
import { renderReport, repoArgument } from "./render.ts";
import { aggregate, scoreSessions, type Aggregate, type SessionScore } from "./score.ts";
import { advise, decide, loadImpact, recordRun, type Advice } from "./suggest.ts";

const RUN_FILE = "run.json";
const DEFAULT_TITLE = "Skill health report";

const COLLECT_FLAGS =
  "--out DIR [--repo P[:P…] | --all] [--host claude,codex,grok] [--days N] [--max-sessions N] [--per-skill N] [--no-skill N] [--global-skills] [--subagents] [--claude-home P] [--codex-home P] [--grok-home P] [--skills-dir P]";

/** The directory holding `path`'s nearest `.git` (a file in a linked worktree), or null. */
function enclosingWorkTree(path: string): string | null {
  let dir = resolve(path);
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Why `path` may not hold doctor output, or null when it may: a path inside a work tree
 * must be one git ignores, so a transcript or report can never be staged by accident.
 */
export function outputRefusal(path: string): string | null {
  const tree = enclosingWorkTree(path);
  if (tree === null) return null;
  const ignored = runProcess(["git", "-C", tree, "check-ignore", "-q", "--", resolve(path)], { timeoutMs: 10_000 });
  return ignored.code === 0 ? null : `${path} is inside the work tree ${tree} and git does not ignore it`;
}

/** The message that says what is wrong with an option. */
interface Refused {
  ok: false;
  error: string;
}

/** A parsed option, or why it was refused. */
type Parsed<T> = { ok: true; value: T } | Refused;

function intFlag(args: LearnArgs, name: string, fallback: number): Parsed<number> {
  const raw = flag(args, name);
  if (raw === undefined) return { ok: true, value: fallback };
  const value = Number(raw);
  return Number.isInteger(value) && value > 0
    ? { ok: true, value }
    : { ok: false, error: `--${name} takes a positive whole number, not ${raw}` };
}

function fail(error: string): Refused {
  return { ok: false, error };
}

function isHost(name: string): name is DoctorHost {
  return DOCTOR_HOSTS.some((host) => host === name);
}

/** A path's main repository root, so every linked worktree of one repository names the same project; a plain directory stands as named. */
function repoOf(path: string): string | null {
  return mainRepoRoot(path) ?? (existsSync(path) ? path : null);
}

function paths(value: string | undefined): string[] {
  return (value ?? "")
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "")
    .map((entry) => resolve(entry));
}

/** The collector's options from the command line, or the first thing wrong with it. */
export function collectOptions(args: LearnArgs, ctx: LearnContext): Parsed<CollectOptions> {
  const hostText = flag(args, "host");
  const names = hostText === undefined ? [...DOCTOR_HOSTS] : hostText.split(",").map((h) => h.trim());
  const unknown = names.filter((h) => !isHost(h));
  if (unknown.length > 0)
    return fail(`unknown host ${unknown.join(", ")}; the doctor reads ${DOCTOR_HOSTS.join(", ")}`);
  const days = intFlag(args, "days", DEFAULT_DAYS);
  if (!days.ok) return days;
  const maxSessions = intFlag(args, "max-sessions", DEFAULT_MAX_SESSIONS);
  if (!maxSessions.ok) return maxSessions;
  const perSkill = intFlag(args, "per-skill", DEFAULT_PER_SKILL);
  if (!perSkill.ok) return perSkill;
  const noSkill = intFlag(args, "no-skill", DEFAULT_NO_SKILL);
  if (!noSkill.ok) return noSkill;
  const all = args.flags.get("all") === true;
  const repoText = flag(args, "repo");
  if (all && repoText !== undefined) return fail("--all and --repo are exclusive");
  const named = repoText === undefined ? [ctx.cwd] : paths(repoText);
  const repos = all ? [] : named.map(repoOf);
  const missing = named.filter((_, index) => repos[index] === null);
  if (missing.length > 0)
    return fail(
      repoText === undefined
        ? "not in a repository: pass --repo P or --all"
        : `--repo names no directory: ${missing.join(", ")}`,
    );
  const homes = defaultHomes(ctx.env, ctx.config.configDir);
  const value: CollectOptions = {
    hosts: names.filter(isHost),
    repos: repos.filter((repo): repo is string => repo !== null),
    days: days.value,
    maxSessions: maxSessions.value,
    perSkill: perSkill.value,
    noSkill: noSkill.value,
    includeGlobalSkills: args.flags.get("global-skills") === true,
    includeSubagents: args.flags.get("subagents") === true,
    claudeHomes: flag(args, "claude-home") === undefined ? homes.claudeHomes : paths(flag(args, "claude-home")),
    codexHomes: flag(args, "codex-home") === undefined ? homes.codexHomes : paths(flag(args, "codex-home")),
    grokHomes: flag(args, "grok-home") === undefined ? homes.grokHomes : paths(flag(args, "grok-home")),
    skillDirs: paths(flag(args, "skills-dir")),
    now: Date.now(),
  };
  return { ok: true, value };
}

/** The inventory and one scrubbed transcript per sampled session, owner-readable only. */
function writeCollection(out: string, collection: Collection): void {
  const transcripts = join(out, "transcripts");
  mkdirSync(transcripts, { recursive: true, mode: 0o700 });
  chmodSync(out, 0o700);
  for (const session of collection.sampled) {
    const path = join(transcripts, `${session.key}.md`);
    writeFileSync(path, renderTranscript(session), { mode: 0o600 });
  }
  const inventory = {
    ...collection,
    sampled: collection.sampled.map(({ entries: _entries, ...meta }) => meta),
  };
  writeJson(join(out, "inventory.json"), inventory, out);
}

interface RunRecord {
  title: string;
  collection: Collection;
  scores: SessionScore[];
  aggregate: Aggregate;
  advice: Advice;
  /** The `--repo` argument (`repoArgument`) that reaches the ledger holding this run's proposals; null when they were not recorded. */
  decideRepo: string | null;
}

function outDir(args: LearnArgs, ctx: LearnContext): string | null {
  const out = flag(args, "out");
  if (out === undefined) {
    ctx.io.err("ak learn doctor: --out DIR is required, outside any tracked part of a repository");
    return null;
  }
  const refusal = outputRefusal(out);
  if (refusal !== null) {
    ctx.io.err(`ak learn doctor: refusing --out: ${refusal}`);
    return null;
  }
  return resolve(out);
}

function reportPath(args: LearnArgs, ctx: LearnContext, out: string): string | null {
  const report = resolve(flag(args, "report") ?? join(out, "report.html"));
  const refusal = outputRefusal(report);
  if (refusal !== null) {
    ctx.io.err(`ak learn doctor: refusing --report: ${refusal}`);
    return null;
  }
  return report;
}

function writeReport(out: string, report: string, record: RunRecord): void {
  mkdirSync(dirname(report), { recursive: true });
  writeGated(out, report, renderReport(record));
  chmodSync(report, 0o600);
}

function collectCommand(args: LearnArgs, ctx: LearnContext): number {
  const out = outDir(args, ctx);
  if (out === null) return 2;
  const parsed = collectOptions(args, ctx);
  if (!parsed.ok) {
    ctx.io.err(`ak learn doctor collect: ${parsed.error}`);
    return 2;
  }
  const options = parsed.value;
  const collection = collect(options, ctx.env);
  if (ctx.config.dryRun) {
    ctx.io.out(`dry run: ${collection.sampled.length} session(s) sampled; nothing was written`);
    return 0;
  }
  writeCollection(out, collection);
  ctx.io.out(
    `collected: ${collection.sessions_scanned} scanned, ${collection.sessions_matched} matched, ${collection.sampled.length} sampled, ${collection.skills.length} skills → ${out}`,
  );
  return 0;
}

/** The skills ledger of `--repo`, else of the working directory's repository; null outside any. */
function ledgerFor(ctx: LearnContext, repo: string | undefined): Ledger | null {
  const root = repoOf(repo === undefined ? ctx.cwd : resolve(ctx.cwd, repo));
  return root === null ? null : new Ledger(loopDir(ctx.config, root, "skills"));
}

function runCommand(args: LearnArgs, ctx: LearnContext): number {
  const out = outDir(args, ctx);
  if (out === null) return 2;
  const report = reportPath(args, ctx, out);
  if (report === null) return 2;
  const parsed = collectOptions(args, ctx);
  if (!parsed.ok) {
    ctx.io.err(`ak learn doctor run: ${parsed.error}`);
    return 2;
  }
  const options = parsed.value;
  const record = args.flags.get("record") === true;
  const ledgerRoot = options.repos[0];
  if (record && ledgerRoot === undefined) {
    ctx.io.err("ak learn doctor run: --record needs a repository; pass --repo P");
    return 2;
  }
  const collection = collect(options, ctx.env);
  if (ctx.config.dryRun) {
    ctx.io.out(
      `dry run: ${collection.sampled.length} of ${collection.sessions_matched} matched sessions would go to the judge; no judge call was made and nothing was written`,
    );
    return 0;
  }
  writeCollection(out, collection);
  ctx.io.out(`collected: ${collection.sampled.length} of ${collection.sessions_matched} matched sessions sampled`);
  const project = ledgerRoot ?? "all";
  const scores = scoreSessions(ctx, collection.sampled, collection.skills, project);
  const summary = aggregate(scores, collection.skills.length);
  ctx.io.out(
    `scored: ${summary.sessions_scored}, unavailable: ${summary.sessions_unavailable}, failed: ${summary.failed.length}`,
  );
  const ledger = ledgerRoot === undefined ? null : new Ledger(loopDir(ctx.config, ledgerRoot, "skills"));
  const impact = ledger === null ? [] : loadImpact(ledger.dir);
  const runId = new Date(options.now)
    .toISOString()
    .replaceAll(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
  const mem = ClaudeMemSource.open(ctx.config.memDb);
  let advice: Advice;
  try {
    advice =
      summary.sessions_scored === 0
        ? {
            status: "unavailable",
            why: "no session was scored",
            findings: [],
            suggestions: [],
            dropped: [],
            deferred: [],
          }
        : advise(ctx, {
            run: runId,
            project,
            sessions: collection.sampled,
            scores,
            aggregate: summary,
            skills: collection.skills,
            impact,
            mem,
          });
  } finally {
    mem?.close();
  }
  let decideRepo: string | null = null;
  if (record && ledgerRoot !== undefined) {
    const recorded = skillsLedger(ctx, ledgerRoot);
    const sha = recordRun(recorded, runId, scores, summary, advice);
    if (sha === null)
      ctx.io.err(`ak learn doctor run: run ${runId} was not recorded: ${recorded.dir} is locked or its commit failed`);
    else {
      decideRepo = repoArgument(ledgerRoot, resolve(userHome(ctx.env)));
      ctx.io.out(`recorded: run ${runId} in ${recorded.dir} at ${sha.slice(0, 12)}`);
    }
  }
  const runRecord: RunRecord = {
    title: flag(args, "title") ?? DEFAULT_TITLE,
    collection: { ...collection, sampled: collection.sampled.map((s) => ({ ...s, entries: [] })) },
    scores,
    aggregate: summary,
    advice,
    decideRepo,
  };
  writeJson(join(out, RUN_FILE), runRecord, out);
  for (const suggestion of advice.suggestions) {
    const path = join(out, "proposed", suggestion.id, "SKILL.md");
    mkdirSync(dirname(path), { recursive: true });
    writeGated(out, path, suggestion.proposed);
    chmodSync(path, 0o600);
  }
  writeReport(out, report, runRecord);
  const verdict =
    summary.scores === null ? "no grade" : `grade ${summary.grade} (${Math.round(summary.scores.overall * 100)}/100)`;
  const edits =
    advice.status === "unavailable"
      ? `suggestions unavailable: ${advice.why ?? "no reason given"}`
      : `${advice.suggestions.length} edit(s) passed the gates, ${advice.dropped.length} dropped`;
  ctx.io.out(`${verdict}; ${edits} → ${report}`);
  if (summary.sessions_scored === 0 && summary.sessions_unavailable > 0) {
    ctx.io.err("ak learn doctor run: every sampled session was unavailable; check the judge command");
    return 1;
  }
  return record && decideRepo === null ? 1 : 0;
}

function renderCommand(args: LearnArgs, ctx: LearnContext): number {
  const out = outDir(args, ctx);
  if (out === null) return 2;
  const report = reportPath(args, ctx, out);
  if (report === null) return 2;
  const path = join(out, RUN_FILE);
  if (!existsSync(path)) {
    ctx.io.err(`ak learn doctor render: no ${RUN_FILE} in ${out}; run \`ak learn doctor run\` first`);
    return 1;
  }
  const saved = readJson<RunRecord | null>(path, null);
  if (saved === null) {
    ctx.io.err(`ak learn doctor render: ${path} is not a run record`);
    return 1;
  }
  if (ctx.config.dryRun) {
    ctx.io.out("dry run: the report was not written");
    return 0;
  }
  writeReport(out, report, saved);
  ctx.io.out(report);
  return 0;
}

function decideCommand(status: "accepted" | "rejected") {
  return (args: LearnArgs, ctx: LearnContext): number => {
    const id = args.positional[0];
    const verb = status === "accepted" ? "accept" : "reject";
    if (id === undefined) {
      ctx.io.err(`ak learn doctor ${verb}: name the proposal id from the report`);
      return 2;
    }
    const ledger = ledgerFor(ctx, flag(args, "repo"));
    if (ledger === null || !existsSync(ledger.dir)) {
      ctx.io.err(`ak learn doctor ${verb}: no skills ledger for this repository; pass --repo P`);
      return 1;
    }
    if (ctx.config.dryRun) {
      ctx.io.out(`dry run: ${id} was not ${status}; the skills ledger was not written`);
      return 0;
    }
    const result = decide(ledger, id, status, flag(args, "reason"));
    if (result === "unknown") ctx.io.err(`ak learn doctor ${verb}: no proposal ${id}`);
    else if (result === "decided") ctx.io.err(`ak learn doctor ${verb}: ${id} was already decided`);
    else if (result === "locked") ctx.io.err(`ak learn doctor ${verb}: ${ledger.dir} is locked; try again`);
    else if (result === "uncommitted")
      ctx.io.err(`ak learn doctor ${verb}: ${id} is ${status} but not committed; it rides in the ledger's next commit`);
    else ctx.io.out(`${id}: ${status}`);
    return result === "ok" ? 0 : 1;
  };
}

function impactCommand(args: LearnArgs, ctx: LearnContext): number {
  const ledger = ledgerFor(ctx, flag(args, "repo"));
  const entries = ledger === null ? [] : loadImpact(ledger.dir);
  if (entries.length === 0) ctx.io.out("no proposals recorded");
  for (const entry of entries) ctx.io.out(`${entry.id}  ${entry.status.padEnd(8)}  ${entry.skill}  ${entry.rule}`);
  return 0;
}

export const doctorArea: LearnArea = {
  summary: "score recent sessions, propose gated skill edits, render a local report",
  verbs: {
    run: {
      usage: `ak learn doctor run ${COLLECT_FLAGS} [--report FILE] [--title T] [--record]`,
      run: runCommand,
    },
    collect: { usage: `ak learn doctor collect ${COLLECT_FLAGS}`, run: collectCommand },
    render: { usage: "ak learn doctor render --out DIR [--report FILE]", run: renderCommand },
    accept: {
      usage: "ak learn doctor accept <proposal-id> [--repo P] [--reason TEXT]",
      run: decideCommand("accepted"),
    },
    reject: {
      usage: "ak learn doctor reject <proposal-id> [--repo P] [--reason TEXT]",
      run: decideCommand("rejected"),
    },
    impact: { usage: "ak learn doctor impact [--repo P]", run: impactCommand },
  },
};
