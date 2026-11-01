/**
 * `ak learn doctor loop` — the scheduled improvement loop.
 *
 * One pass: read what became of the earlier pull requests, run the doctor (collector, scorer,
 * report), take the proposals its failed sessions support, ask for each as a holistic rewrite, and
 * with `--publish` open one reviewable pull request per rewrite. Transcripts stay on the machine:
 * the rewrite step is given none, and everything that leaves is checked against them first
 * (`rewrite.ts`). The judge is the doctor's signed-in seat. No skill file is written in place
 * (`publish.ts`), and a human merging or closing the pull request is the decision, which the next
 * pass records for the doctor to read (ruling `learning-drafts-not-publishes`).
 */
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { flag, type LearnArgs, type LearnCommand, type LearnContext } from "../core/context.ts";
import type { Ledger } from "../core/ledger.ts";
import { mainRepoRoot } from "../core/paths.ts";
import { nowIso, readJson, writeGated, writeJson } from "../core/store.ts";
import { DOCTOR_LOOP_LABEL, installUnit } from "../setup/schedule.ts";
import { defaultDeps, type SetupDeps } from "../setup/wire.ts";
import { skillsLedger } from "../skills/learn.ts";
import { userHome } from "../sources/worker-sessions.ts";
import type { collectOptions as collectOptionsFn, outputRefusal as outputRefusalFn, RunRecord } from "./cli.ts";
import { type CollectOptions, discoverSkills } from "./collect.ts";
import {
  branchOnOrigin,
  buildCommit,
  GATE_REMOTE,
  type PublishTarget,
  pullRequestState,
  pushBranch,
  resolveTarget,
  trackedFile,
} from "./publish.ts";
import { addedText, leakRefusal, requestRewrite, type SessionCorpus, sessionCorpus } from "./rewrite.ts";
import { decide, normalRule, type Suggestion, unifiedDiff } from "./suggest.ts";

export const REWRITES_FILE = "doctor/rewrites.json";
export const DEFAULT_MAX_PRS = 3;
const SKILL_REF = /^[a-z0-9][a-z0-9_-]*$/;

const LOOP_FLAGS =
  "--out DIR --repo P [--publish] [--base B] [--max-prs N] [--host claude,codex,grok] [--days N] [--max-sessions N] [--per-skill N] [--no-skill N] [--global-skills] [--claude-home P] [--codex-home P] [--grok-home P] [--skills-dir P]";
export const LOOP_USAGE = `ak learn doctor loop ${LOOP_FLAGS} [--report FILE] [--title T]`;
export const SCHEDULE_USAGE = `ak learn doctor schedule --out DIR --repo P [--publish] [--base B] [--max-prs N] [--load]`;

/** One pushed rewrite, in the skills ledger: the loop's memory of its pull requests. */
export interface RewriteEntry {
  proposal: string;
  run: string;
  skill: string;
  branch: string;
  commit: string;
  base: string;
  status: "open" | "merged" | "closed";
  pr: string | null;
  at: string;
}

export interface LoopDeps {
  runDoctor: LearnCommand;
  runFile: string;
  collectOptions: typeof collectOptionsFn;
  outputRefusal: typeof outputRefusalFn;
}

function loadRewrites(ledger: Ledger): RewriteEntry[] {
  return readJson<RewriteEntry[]>(ledger.path(REWRITES_FILE), []);
}

/** A change to the record under the ledger's lock, committed. False when another job holds the lock. */
function updateRewrites(ledger: Ledger, message: string, change: (entries: RewriteEntry[]) => void): boolean {
  const release = ledger.tryLock();
  if (release === null) return false;
  try {
    const entries = loadRewrites(ledger);
    change(entries);
    mkdirSync(dirname(ledger.path(REWRITES_FILE)), { recursive: true });
    writeJson(ledger.path(REWRITES_FILE), entries, ledger.dir);
    ledger.commit(message);
    return true;
  } finally {
    release();
  }
}

/**
 * What became of the open pull requests. A merge records the proposal accepted and a close records
 * it rejected, so the doctor does not propose that rule again. A failed read changes nothing.
 */
function reconcile(ctx: LearnContext, repo: string, ledger: Ledger): string[] {
  const failures: string[] = [];
  for (const entry of loadRewrites(ledger).filter((item) => item.status === "open")) {
    const seen = pullRequestState(repo, ctx.env, entry.branch);
    if (seen === "unknown") {
      failures.push(`${entry.branch}: the pull request could not be read`);
      continue;
    }
    if (seen === "none") {
      ctx.io.out(`waiting: ${entry.branch} has no pull request yet; its ${GATE_REMOTE} pipeline opens it`);
      continue;
    }
    const status = seen.state === "MERGED" ? "merged" : seen.state === "CLOSED" ? "closed" : "open";
    if (status === entry.status && seen.url === entry.pr) continue;
    // The decision is recorded first: a busy ledger leaves the entry open, so the next pass records it.
    const decision =
      status === "merged"
        ? decide(ledger, entry.proposal, "accepted", `pull request merged: ${seen.url}`)
        : status === "closed"
          ? decide(ledger, entry.proposal, "rejected", `pull request closed unmerged: ${seen.url}`)
          : "ok";
    const saved =
      decision !== "locked" &&
      updateRewrites(ledger, `doctor: ${entry.proposal} ${status}`, (entries) => {
        const row = entries.find((item) => item.branch === entry.branch);
        if (row === undefined) return;
        row.status = status;
        row.pr = seen.url;
      });
    if (!saved) failures.push(`${entry.branch}: the skills ledger is locked; the next pass records this`);
  }
  return failures;
}

/** The arguments the doctor run takes: the collector's and the report's, with the proposals recorded. */
function doctorArgs(args: LearnArgs): LearnArgs {
  const flags = new Map(args.flags);
  for (const name of ["publish", "base", "max-prs"]) flags.delete(name);
  flags.set("record", true);
  return { positional: [], flags };
}

/** `path`'s place in `repo`, through any symlink; null when it lands outside. */
function repoPath(repo: string, path: string): string | null {
  try {
    const inside = relative(realpathSync(repo), realpathSync(path));
    return inside === "" || inside.startsWith("..") || isAbsolute(inside) ? null : inside;
  } catch {
    return null;
  }
}

/** The word runs this run's sessions hold: the transcripts on disk and what the judges said of them. Null when one is missing. */
function sessionTexts(out: string, record: RunRecord): string[] | null {
  const texts: string[] = [];
  for (const session of record.collection.sampled) {
    const path = join(out, "transcripts", `${session.key}.md`);
    if (!existsSync(path)) return null;
    texts.push(readFileSync(path, "utf8"));
  }
  for (const score of record.scores)
    for (const result of Object.values(score.results)) if (result !== undefined) texts.push(result.reason);
  for (const suggestion of record.advice.suggestions)
    for (const evidence of suggestion.evidence) texts.push(evidence.moment);
  return texts;
}

/** The sessions behind a proposal: cited, failed and using the skill. These alone justify a rewrite. */
function isolatedFailures(record: RunRecord, suggestion: Suggestion): string[] {
  const failed = new Set(record.aggregate.failed);
  const used = new Set(
    record.scores.filter((score) => score.skills_used.includes(suggestion.skill)).map((score) => score.key),
  );
  return [...new Set(suggestion.evidence.map((item) => item.session))].filter(
    (key) => failed.has(key) && used.has(key),
  );
}

/** An indented block: markdown renders it literally, so judged text cannot mention a person or close a fence. */
function literal(source: string): string {
  return `    ${source.replaceAll(/\s+/g, " ").trim()}`;
}

function pullRequestBody(record: RunRecord, suggestion: Suggestion, path: string, failures: number): string {
  const rubrics = [...new Set(suggestion.evidence.map((item) => item.scorer))].toSorted().join(", ");
  return [
    `This rewrites \`${path}\` as a whole, so that one rule is part of how the skill works. The skill doctor's scheduled loop opened it. A person decides it.`,
    "",
    "## The rule",
    "",
    literal(suggestion.rule),
    "",
    "## The change",
    "",
    literal(suggestion.change),
    "",
    "## Why",
    "",
    `Doctor run \`${suggestion.id.replace(/-\d+$/, "")}\` scored ${record.aggregate.sessions_scored} sessions and ${record.aggregate.failed.length} failed. ${failures} of the failed sessions used this skill and support the rule, on these rubrics: ${rubrics}.`,
    "",
    "Session transcripts stay on the machine that ran the doctor, so no session text appears here.",
    "",
    "## How to decide",
    "",
    "Merge it to accept the rule. Close it to reject the rule. The next loop records either decision, and the doctor does not propose a rejected rule again.",
    "",
  ].join("\n");
}

interface PassInput {
  ctx: LearnContext;
  repo: string;
  out: string;
  record: RunRecord;
  target: PublishTarget;
  ledger: Ledger;
  skills: ReadonlyMap<string, string>;
  texts: readonly string[];
}

type Outcome = "published" | "prepared" | "skipped" | "failed";

/** One proposal through the isolation, rewrite and leak gates, then published when the target has a remote. */
function passProposal(input: PassInput, suggestion: Suggestion, openSkills: Set<string>): Outcome {
  const { ctx, repo, out, record, target, ledger } = input;
  const skip = (gate: string): Outcome => {
    ctx.io.out(`skipped ${suggestion.id} (${suggestion.skill}): ${gate}`);
    return "skipped";
  };
  if (suggestion.kind !== "edit") return skip("a new skill is not a rewrite; it stays in the report");
  if (!SKILL_REF.test(suggestion.skill)) return skip("the skill's name cannot name a branch");
  const failures = isolatedFailures(record, suggestion);
  if (failures.length === 0) return skip("no cited failed session used this skill");
  if (openSkills.has(suggestion.skill)) return skip("this skill already has an open rewrite");
  const onDisk = input.skills.get(suggestion.skill);
  const path = onDisk === undefined ? null : repoPath(repo, onDisk);
  if (path === null) return skip("the skill file is not in this repository");
  const file = trackedFile(repo, ctx.env, target.baseSha, path);
  if (file === null) return skip(`${path} is not a tracked file on ${target.base}`);
  const hash = createHash("sha256").update(normalRule(suggestion.rule)).digest("hex").slice(0, 10);
  const branch = `ak-learn/skill-rewrite/${suggestion.skill}-${hash}`;
  if (loadRewrites(ledger).some((entry) => entry.branch === branch))
    return skip("this rule already had a pull request");
  if (target.publish && branchOnOrigin(repo, ctx.env, branch)) return skip(`${branch} is already on origin`);

  const corpus: SessionCorpus = sessionCorpus(input.texts, file.text, resolve(userHome(ctx.env)));
  for (const field of [suggestion.rule, suggestion.change]) {
    const refusal = leakRefusal(field, corpus);
    if (refusal !== null) return skip(`its rule or change may not leave the machine: ${refusal}`);
  }
  const rewritten = requestRewrite(
    ctx,
    { skill: suggestion.skill, rule: suggestion.rule, change: suggestion.change, current: file.text },
    corpus,
    repo,
  );
  if ("gate" in rewritten) return skip(rewritten.gate);

  const local = join(out, "rewrites", suggestion.id);
  mkdirSync(local, { recursive: true, mode: 0o700 });
  writeGated(out, join(local, "SKILL.md"), rewritten.proposed);
  chmodSync(join(local, "SKILL.md"), 0o600);
  writeGated(out, join(local, "rewrite.diff"), unifiedDiff(file.text, rewritten.proposed, path));
  chmodSync(join(local, "rewrite.diff"), 0o600);
  ctx.io.out(
    `rewrite ${suggestion.id} (${suggestion.skill}): ${addedText(file.text, rewritten.proposed).split("\n").length} line(s) rewritten → ${local}`,
  );
  if (!target.publish) return "prepared";

  const title = `Rewrite the ${suggestion.skill} skill (${suggestion.id})`;
  const body = pullRequestBody(record, suggestion, path, failures.length);
  const commit = buildCommit(target, ctx.env, {
    path,
    mode: file.mode,
    proposed: rewritten.proposed,
    message: `${title}\n\n${body}`,
  });
  if (commit === null) {
    ctx.io.err(`ak learn doctor loop: ${suggestion.id}: git could not build the commit`);
    return "failed";
  }
  const entry: RewriteEntry = {
    proposal: suggestion.id,
    run: suggestion.id.replace(/-\d+$/, ""),
    skill: suggestion.skill,
    branch,
    commit,
    base: target.base,
    status: "open",
    pr: null,
    at: nowIso(),
  };
  // Recorded before the push, so a crash after it cannot open the same rule twice.
  if (!updateRewrites(ledger, `doctor: rewrite ${suggestion.id}`, (entries) => entries.push(entry)))
    return skip("the skills ledger is locked");
  const refused = pushBranch(target, ctx.env, branch, commit);
  if (refused !== null) {
    updateRewrites(ledger, `doctor: rewrite ${suggestion.id} not pushed`, (entries) => {
      entries.splice(
        entries.findIndex((item) => item.branch === branch),
        1,
      );
    });
    ctx.io.err(`ak learn doctor loop: ${suggestion.id}: ${refused}`);
    return "failed";
  }
  openSkills.add(suggestion.skill);
  ctx.io.out(`pushed ${branch} through ${GATE_REMOTE}; its pipeline opens the pull request`);
  return "published";
}

function repoRoot(args: LearnArgs, ctx: LearnContext): string | null {
  const named = flag(args, "repo");
  return named === undefined ? null : mainRepoRoot(resolve(ctx.cwd, named));
}

function maxPrs(args: LearnArgs): number | null {
  const raw = flag(args, "max-prs");
  if (raw === undefined) return DEFAULT_MAX_PRS;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : null;
}

function skillPaths(options: CollectOptions, ctx: LearnContext): Map<string, string> {
  return new Map(discoverSkills(options, ctx.env).map((skill) => [skill.name, skill.path]));
}

export function runLoop(args: LearnArgs, ctx: LearnContext, deps: LoopDeps): number {
  const refuse = (why: string, code = 2): number => {
    ctx.io.err(`ak learn doctor loop: ${why}`);
    return code;
  };
  const repo = repoRoot(args, ctx);
  if (repo === null) return refuse("--repo must name one repository");
  const capacity = maxPrs(args);
  if (capacity === null) return refuse("--max-prs takes a positive whole number");
  const out = flag(args, "out");
  if (out === undefined) return refuse("--out DIR is required, outside any tracked part of a repository");
  const outRefusal = deps.outputRefusal(resolve(ctx.cwd, out));
  if (outRefusal !== null) return refuse(`refusing --out: ${outRefusal}`);
  const inner = doctorArgs({ ...args, flags: new Map([...args.flags, ["repo", repo]]) });
  if (ctx.config.dryRun) {
    const code = deps.runDoctor(inner, ctx);
    if (code === 0) ctx.io.out("dry run: no rewrite was requested and nothing was pushed");
    return code;
  }
  const options = deps.collectOptions(inner, ctx);
  if (!options.ok) return refuse(options.error);
  const target = resolveTarget(repo, ctx.env, {
    publish: args.flags.get("publish") === true,
    base: flag(args, "base"),
  });
  if ("refused" in target) return refuse(target.refused, 1);

  const ledger = skillsLedger(ctx, repo);
  const failures = reconcile(ctx, repo, ledger);
  for (const failure of failures) ctx.io.err(`ak learn doctor loop: ${failure}`);

  const code = deps.runDoctor(inner, ctx);
  if (code !== 0) return code;
  const resolvedOut = resolve(ctx.cwd, out);
  const record = readJson<RunRecord | null>(join(resolvedOut, deps.runFile), null);
  if (record === null) return refuse(`no run record in ${resolvedOut}`, 1);
  const texts = sessionTexts(resolvedOut, record);
  if (texts === null)
    return refuse("a sampled session's transcript is missing, so nothing can be checked against it", 1);

  const open = () => loadRewrites(ledger).filter((entry) => entry.status === "open");
  const openSkills = new Set(open().map((entry) => entry.skill));
  const tally: Record<Outcome, number> = { published: 0, prepared: 0, skipped: 0, failed: 0 };
  const input: PassInput = {
    ctx,
    repo,
    out: resolvedOut,
    record,
    target,
    ledger,
    skills: skillPaths(options.value, ctx),
    texts,
  };
  for (const suggestion of record.advice.suggestions) {
    if (open().length + tally.prepared >= capacity) {
      ctx.io.out(
        `skipped ${suggestion.id} (${suggestion.skill}): ${capacity} rewrite pull request(s) are already open`,
      );
      tally.skipped += 1;
      continue;
    }
    tally[passProposal(input, suggestion, openSkills)] += 1;
  }
  ctx.io.out(
    `loop: ${tally.published} published, ${tally.prepared} prepared, ${tally.skipped} skipped, ${tally.failed} failed`,
  );
  return tally.failed > 0 || failures.length > 0 ? 1 : 0;
}

/** `ak learn doctor schedule`: write the loop's scheduler unit. A unit without `--publish` opens nothing. */
export function scheduleLoop(
  args: LearnArgs,
  ctx: LearnContext,
  outputRefusal: typeof outputRefusalFn,
  depsFor: typeof defaultDeps = defaultDeps,
): number {
  const refuse = (why: string): number => {
    ctx.io.err(`ak learn doctor schedule: ${why}`);
    return 2;
  };
  const repo = repoRoot(args, ctx);
  if (repo === null) return refuse("--repo must name one repository");
  if (maxPrs(args) === null) return refuse("--max-prs takes a positive whole number");
  const out = flag(args, "out");
  if (out === undefined) return refuse("--out DIR is required, outside any tracked part of a repository");
  const outRefusal = outputRefusal(resolve(ctx.cwd, out));
  if (outRefusal !== null) return refuse(`refusing --out: ${outRefusal}`);
  const deps: SetupDeps = depsFor(ctx);
  const argv = [...deps.ak, "learn", "doctor", "loop", "--out", resolve(ctx.cwd, out), "--repo", repo];
  if (args.flags.get("publish") === true) argv.push("--publish");
  for (const name of ["base", "max-prs"]) {
    const value = flag(args, name);
    if (value !== undefined) argv.push(`--${name}`, value);
  }
  return installUnit(
    ctx,
    deps,
    {
      label: DOCTOR_LOOP_LABEL,
      argv,
      service: "agent-kit skill doctor: scheduled improvement loop",
      timer: "the agent-kit skill doctor loop",
    },
    "weekly",
    args.flags.get("load") === true,
  );
}
