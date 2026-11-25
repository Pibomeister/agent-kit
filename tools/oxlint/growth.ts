/**
 * The half of "the baseline only shrinks" that `--update` cannot enforce: a hand-edited
 * `tools/oxlint/baseline.json`, or one written with `--allow-growth`, passes the ratchet because the
 * ratchet only compares the tree against whatever baseline it finds. This compares that baseline with
 * the one at the merge base of <base-ref> and fails when any file and rule recorded more.
 *
 * Growth passes in the two cases `--allow-growth` exists for, and only those. A renamed file may carry
 * its old path's counts to the new path. "Renamed" is what `git diff -M` pairs between the merge base
 * and the tree, which takes at least 50% similar content; a file rewritten past that in the same branch
 * reads as new, so land the move on main before the rewrite. A staged rename is also paired from the
 * index when the worktree diff lists a delete and an add instead: that is what git reports when it
 * cannot read the new file, and the worktree file is accepted only while it still matches the index.
 * A change to `.oxlintrc.json` means a rule is being adopted, so growth passes and the baseline diff
 * is what the reviewer reads.
 *
 *   bun tools/oxlint/growth.ts [--root <dir>] <base-ref>
 */
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { BASELINE, type Counts, parseBaseline, readBaseline } from "./ratchet.ts";

const CONFIG = ".oxlintrc.json";
const GIT_ATTEMPTS = 3;
const GIT_RETRY_MS = 50;

export interface Growth {
  file: string;
  rule: string;
  allowed: number;
  actual: number;
}

/** Pairs recording more than the base allows. `renamed` maps each new path to the path it was moved from. */
export function growth(base: Counts, now: Counts, renamed: ReadonlyMap<string, string>): Growth[] {
  const grown: Growth[] = [];
  for (const [file, rules] of now) {
    const from = renamed.get(file);
    for (const [rule, actual] of rules) {
      const kept = base.get(file)?.get(rule) ?? 0;
      const moved = from === undefined ? 0 : (base.get(from)?.get(rule) ?? 0);
      if (actual > kept + moved) grown.push({ file, rule, allowed: kept + moved, actual });
    }
  }
  return grown;
}

interface GitRun {
  status: number | null;
  stdout: string;
}

function blank(text: string): boolean {
  return text.trim() === "";
}

/** Reads whose successful run always prints a path or a hash. An empty success is a lost spawn. */
function readMustPrint(args: readonly string[]): boolean {
  if (args.includes("--quiet")) return false;
  if (args.includes("rev-parse") || args.includes("hash-object")) return true;
  if (args.includes("merge-base")) return !args.includes("--is-ancestor");
  if (args.includes("show")) return !args.includes("--format=");
  return false;
}

function git(root: string, args: readonly string[]): GitRun {
  let last: GitRun = { status: null, stdout: "" };
  for (let attempt = 1; attempt <= GIT_ATTEMPTS; attempt++) {
    const run = spawnSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 1 << 26 });
    const stdout = run.stdout ?? "";
    last = { status: run.status, stdout };
    const lost =
      run.error !== undefined ||
      run.status === null ||
      (run.status === 0 && blank(stdout) && blank(run.stderr ?? "") && readMustPrint(args));
    if (!lost || attempt === GIT_ATTEMPTS) {
      if (run.error !== undefined) throw new Error(`git ${args.join(" ")} could not start: ${run.error.message}`);
      return last;
    }
    Bun.sleepSync(GIT_RETRY_MS);
  }
  return last;
}

/** Rename pairs in one `-z --name-status` record, as new path -> old path. Copies are not renames. */
function renamePairs(nameStatus: string): Map<string, string> {
  const fields = nameStatus.split("\0");
  const renamed = new Map<string, string>();
  let at = 0;
  while (at < fields.length) {
    const status = fields[at] ?? "";
    if (status.startsWith("R") || status.startsWith("C")) {
      const from = fields[at + 1] ?? "";
      const to = fields[at + 2] ?? "";
      if (status.startsWith("R") && to !== "") renamed.set(to, from);
      at += 3;
    } else if (status === "") {
      at += 1;
    } else {
      at += 2;
    }
  }
  return renamed;
}

function objectId(root: string, spec: string): string | undefined {
  const args = spec.startsWith(":") ? ["rev-parse", spec] : ["hash-object", "--", spec];
  for (let attempt = 1; attempt <= GIT_ATTEMPTS; attempt++) {
    const run = git(root, args);
    if (run.status === 0) {
      const hash = run.stdout.trim();
      return hash === "" ? undefined : hash;
    }
    // A fatal read of a file that is in the index is retried; a missing path is not a rename.
    if (run.status === null || run.status < 128 || attempt === GIT_ATTEMPTS) return undefined;
    Bun.sleepSync(GIT_RETRY_MS);
  }
  return undefined;
}

/**
 * Worktree pairs, plus a staged pair the worktree diff missed whose file still matches the index.
 * `matchesIndex` is that byte check. A rewrite of the staged file does not match, so it stays a new path.
 */
export function withStagedRenames(
  worktreeDiff: string,
  cachedDiff: string,
  matchesIndex: (to: string) => boolean,
): Map<string, string> {
  const renamed = renamePairs(worktreeDiff);
  for (const [to, from] of renamePairs(cachedDiff)) {
    if (!renamed.has(to) && matchesIndex(to)) renamed.set(to, from);
  }
  return renamed;
}

/**
 * Renames between the merge base and the tree, as new path -> old path.
 * The worktree diff is the pairing. A staged rename the worktree diff missed still counts when
 * the file on disk is the blob in the index: a failed read of that file is reported as a delete
 * plus an add, and the index is where `git mv` recorded the pair.
 */
function renamesSince(root: string, mergeBase: string): Map<string, string> {
  const worktree = git(root, ["diff", "-M", "--name-status", "-z", mergeBase]);
  if (worktree.status !== 0) throw new Error(`git diff against ${mergeBase} failed`);
  const cached = git(root, ["diff", "--cached", "-M", "--name-status", "-z", mergeBase]);
  if (cached.status !== 0) throw new Error(`git diff --cached against ${mergeBase} failed`);
  return withStagedRenames(worktree.stdout, cached.stdout, (to) => {
    const staged = objectId(root, `:${to}`);
    const onDisk = objectId(root, to);
    return staged !== undefined && staged === onDisk;
  });
}

export function main(argv: readonly string[]): number {
  const args = [...argv];
  const rootAt = args.indexOf("--root");
  const rootArg = rootAt >= 0 ? args.splice(rootAt, 2)[1] : ".";
  const [ref] = args;
  if (rootArg === undefined || ref === undefined || args.length !== 1) {
    console.error("usage: growth.ts [--root <dir>] <base-ref>");
    return 2;
  }

  const top = git(resolve(rootArg), ["rev-parse", "--show-toplevel"]);
  if (top.status !== 0) {
    console.error(`lint:growth: ${resolve(rootArg)} is not inside a git repository.`);
    return 2;
  }
  const root = top.stdout.trim();
  const found = git(root, ["merge-base", ref, "HEAD"]);
  const mergeBase = found.stdout.trim();
  if (found.status !== 0 || mergeBase === "") {
    console.error(`lint:growth: no merge base between ${ref} and HEAD; fetch ${ref} with full history.`);
    return 2;
  }
  const short = mergeBase.slice(0, 8);
  const recordedAtBase = git(root, ["cat-file", "-e", `${mergeBase}:${BASELINE}`]).status === 0;
  let base: Counts = new Map();
  if (recordedAtBase) {
    const shown = git(root, ["show", `${mergeBase}:${BASELINE}`]);
    if (shown.status !== 0) throw new Error(`git show ${short}:${BASELINE} failed`);
    base = parseBaseline(shown.stdout, `${BASELINE} at ${short}`);
  } else {
    console.log(`lint:growth: ${short} has no ${BASELINE}; every recorded count is growth.`);
  }
  const grown = growth(base, readBaseline(root), renamesSince(root, mergeBase));
  if (grown.length === 0) {
    console.log(`lint:growth: the baseline records nothing beyond ${short}.`);
    return 0;
  }

  for (const g of grown) console.log(`${g.file}: ${g.rule} ${g.allowed} -> ${g.actual} since ${short}`);
  const configDiff = git(root, ["diff", "--quiet", mergeBase, "--", CONFIG]).status;
  if (configDiff !== 0 && configDiff !== 1) throw new Error(`git diff ${short} -- ${CONFIG} failed`);
  const adopting = configDiff === 1;
  if (adopting) {
    console.log(`lint:growth: ${CONFIG} changed since ${short}, so a rule is being adopted; the growth above passes.`);
    return 0;
  }
  console.log(
    `lint:growth: the baseline grew since ${short} beyond what renamed files carry, and ${CONFIG} is unchanged. Fix the violations; the baseline only shrinks. A moved file counts as renamed once it is staged or committed and git pairs it with its old path.`,
  );
  return 1;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
