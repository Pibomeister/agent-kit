/**
 * What the next review of a pull request covers (ADR-0018): the full-re-review
 * triggers and the outcome `ak review scope` prints.
 *
 * Nothing in this file reads a file, a clock or the environment, and nothing
 * here runs git. `delta.ts` reads the facts from a repository and the command
 * in `cli.ts` reads the rest from its inputs. The same facts and the same
 * policy give the same triggers and the same outcome.
 *
 * - `readPatch` turns a zero-context diff into a patch id, a count of changed
 *   lines and those lines with their positions in a reference base. A mode-only
 *   pair, a gitlink and a hunkless new or deleted file each count as one
 *   changed line. The id is for rewritten-commit matching. Empty is blob
 *   identity plus no novel own commit in `delta.ts`.
 * - `scopeTriggers` says which triggers fire, which could not be evaluated and
 *   why.
 * - `scopeOutcome` turns the triggers and the ledger's scope into one of
 *   `full`, `carry`, `closure`, `new-scope` and `hold`.
 */

import { createHash } from "node:crypto";

import { SCOPE_TRIGGERS, type ConvergencePolicy, type ScopeTrigger } from "./types.ts";

interface LineRange {
  start: number;
  end: number;
}

export interface Patch {
  /** The digest of changed lines and their positions in the reference base. */
  id: string;
  /** Changed lines: one per added or removed line and one per binary file. */
  lines: number;
  /** Each occurrence of a changed line, keyed by its file and text, with its reference range. */
  counts: Map<string, LineRange[]>;
}

const MODE = /^(old mode|new mode|new file mode|deleted file mode) /;
const GITLINK_MODE = / 160000$/;
const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const STRUCTURAL: LineRange = { start: 0, end: 0 };

function readHunk(line: string) {
  const match = HUNK.exec(line);
  if (match === null) return null;
  const removed = Number(match[2] ?? 1);
  const added = Number(match[4] ?? 1);
  return {
    old: Number(match[1]) - (removed === 0 ? 0 : 1),
    now: Number(match[3]) - (added === 0 ? 0 : 1),
    removed,
    added,
  };
}

/**
 * Read a diff made with no context lines, no rename detection and full blob ids.
 *
 * Positions refer to the original side of each hunk. `baseDiff` maps the
 * reference base to that side, so shifts introduced by the base do not move
 * the edit. Moving an edit to another line changes the id. A binary file
 * counts as one changed line, identified by the blob it becomes. An
 * old-mode/new-mode pair counts as one changed line. A hunkless new or deleted
 * file counts as one changed line, matching that pair. A gitlink (mode 160000)
 * counts as one SHA line, not the Subproject commit hunk.
 */
export function readPatch(diff: string, baseDiff = ""): Patch {
  const hash = createHash("sha256");
  const counts = new Map<string, LineRange[]>();
  let lines = 0;
  let file = "";
  let blob = "";
  let location = "";
  let range: LineRange = STRUCTURAL;
  let removedPosition = 0;
  let inHunk = false;
  let gitlink = false;
  let oldMode = false;
  let newMode = false;
  let created = false;
  let deleted = false;
  let counted = false;
  const shifts = new Map<string, NonNullable<ReturnType<typeof readHunk>>[]>();
  for (const line of baseDiff.split("\n")) {
    if (line.startsWith("diff --git ")) file = line;
    else {
      const hunk = readHunk(line);
      if (hunk !== null) shifts.set(file, [...(shifts.get(file) ?? []), hunk]);
    }
  }
  file = "";
  const locate = (position: number): string => {
    let offset = 0;
    for (const shift of shifts.get(file) ?? []) {
      if (position < shift.now) break;
      if (position < shift.now + shift.added)
        return position === shift.now ? String(shift.old) : `${shift.old}:${position - shift.now}`;
      offset = shift.old + shift.removed - shift.now - shift.added;
    }
    return String(position + offset);
  };
  const point = (position: number): number => Number(locate(position).split(":")[0]);
  const changed = (text: string, at: LineRange, where: string): void => {
    hash.update(`${where}\n${text}\n`);
    lines += 1;
    counted = true;
    const key = `${file}\n${text}`;
    const entries = counts.get(key) ?? [];
    entries.push(at);
    counts.set(key, entries);
  };
  const structural = (text: string): void => {
    changed(text, STRUCTURAL, "");
  };
  const flushMode = (): void => {
    if (oldMode && newMode) structural("mode");
    oldMode = false;
    newMode = false;
  };
  const flushFile = (): void => {
    if ((created || deleted) && !counted) structural("file");
    created = false;
    deleted = false;
    counted = false;
  };
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      flushMode();
      flushFile();
      file = line;
      blob = "";
      location = "";
      range = STRUCTURAL;
      removedPosition = 0;
      inHunk = false;
      gitlink = false;
      hash.update(`${line}\n`);
    } else if (line.startsWith("@@")) {
      // A changed line starts with `+`, `-` or `\`, so this is a hunk header wherever it stands.
      const hunk = readHunk(line);
      if (hunk === null) throw new Error("invalid patch hunk");
      location = locate(hunk.old);
      range = { start: point(hunk.old), end: point(hunk.old + hunk.removed) };
      removedPosition = hunk.old;
      inHunk = true;
    } else if (inHunk) {
      if (gitlink) continue;
      if (line.startsWith("-")) {
        const position = point(removedPosition);
        removedPosition += 1;
        changed(line, { start: position, end: position }, location);
      } else if (line.startsWith("+")) changed(line, range, location);
      // `\ No newline at end of file` is part of what changed.
      else if (line.startsWith("\\")) hash.update(`${line}\n`);
    } else if (line.startsWith("index ")) {
      blob = line.slice("index ".length).split("..")[1]?.split(" ")[0] ?? "";
      if (GITLINK_MODE.test(line)) gitlink = true;
      if (gitlink) structural(`gitlink ${blob}`);
    } else if (line.startsWith("Binary files ") || line === "GIT binary patch") {
      structural(`binary ${blob}`);
    } else if (line === "new file mode 160000" || line === "deleted file mode 160000") {
      hash.update(`${line}\n`);
      gitlink = true;
    } else if (line.startsWith("old mode ")) {
      hash.update(`${line}\n`);
      oldMode = true;
    } else if (line.startsWith("new mode ")) {
      hash.update(`${line}\n`);
      newMode = true;
    } else if (MODE.test(line)) {
      hash.update(`${line}\n`);
      if (line.startsWith("new file mode ")) created = true;
      else if (line.startsWith("deleted file mode ")) deleted = true;
    }
  }
  flushMode();
  flushFile();
  return { id: `sha256:${hash.digest("hex")}`, lines, counts };
}

/** Changed lines that `patch` holds and `other` does not, each counted as often as it occurs. */
export function linesNotIn(patch: Patch, other: Patch): number {
  let total = 0;
  for (const [key, entries] of patch.counts) {
    const available = (other.counts.get(key) ?? []).toSorted((left, right) => left.end - right.end);
    for (const at of entries.toSorted((left, right) => left.end - right.end)) {
      const index = available.findIndex((held) => at.start <= held.end && held.start <= at.end);
      if (index < 0) total += 1;
      else available.splice(index, 1);
    }
  }
  return total;
}

/** The pull request at the new head against the pull request at the last reviewed head. */
export interface DeltaFacts {
  /**
   * The pull request at the new head has the same path, mode and blob as it
   * had at the last reviewed head, every new non-merge commit is empty or
   * matches a reviewed own-commit patch or the reviewed pull request, and
   * inspectMerges.novel_merge is false. A two-parent merge whose recorded tree
   * is not the isolated merge-tree of its parents is not empty. The
   * changed-line patch id of the whole pull request is not this test.
   */
  empty: boolean;
  /** Changed lines of the pull request at the last reviewed head. */
  pr_lines: number;
  /** Changed lines of the patch at the new head that the patch at the last reviewed head does not hold. */
  added_lines: number;
  /** Changed lines of the patch at the last reviewed head that the patch at the new head no longer holds. */
  removed_lines: number;
  /**
   * Changed lines that a rewrite changed: zero when every own commit of the
   * last reviewed head has a commit of the new head with its patch. Otherwise
   * the pull request at the last reviewed head is compared with the pull
   * request at the cut, the last own commit of the new head that is reviewed
   * work. Each later unpaired prefix is also compared as an aggregate patch.
   * The count is the smallest of these comparisons, each the larger of the
   * lines either patch holds and the other does not. Scope growth reads the
   * full delta, including new commits.
   */
  rewritten_lines: number;
  /** Paths in which a merge that is new at the head had a conflict. Each is a path the pull request's commits changed. */
  conflict_paths: readonly string[];
  /**
   * Paths whose tree entry changed as a gitlink (mode 160000) or as a same-blob
   * add and delete. Either fires `path-identity`.
   */
  path_identity: readonly string[];
  /**
   * Paths `git diff --name-only previous..head` names, unioned with novel
   * merge and novel non-merge paths when empty is false. Novel-merge paths
   * are merge versus its isolated merge-tree; novel non-merge paths are
   * commit versus parent. A closure round reads this list. An edit that moved
   * still names its path.
   */
  changed_paths: readonly string[];
}

/** One value at the last reviewed round and now. Null where the caller did not supply it. */
export interface Compared {
  before: string | null;
  now: string | null;
}

/** What `scopeTriggers` reads. A null is an input the caller did not supply. */
export interface ScopeFacts {
  delta: DeltaFacts;
  /** The merge-stage class now ranks above the class of the last reviewed round. */
  class_rose: boolean | null;
  /** `review_surface_changed` of the merge-stage record at the new head. */
  surface_changed: boolean | null;
  /** The digest of the intent file. */
  intent: Compared;
  /** The digest of the ticket's acceptance criteria. */
  criteria: Compared;
}

export interface Unevaluated {
  trigger: ScopeTrigger;
  /** The input whose absence left the trigger, or one half of it, unevaluated. */
  needs: string;
}

export interface Triggers {
  /** The triggers that fire, in the order of `SCOPE_TRIGGERS`. */
  fired: ScopeTrigger[];
  /** One sentence per fired trigger, in the same order. */
  reasons: string[];
  /** A trigger listed here did not fire for lack of an input. It is not shown to be clear. */
  unevaluated: Unevaluated[];
}

function changedDigest(value: Compared): boolean | null {
  return value.before === null || value.now === null ? null : value.before !== value.now;
}

/**
 * The full-re-review triggers that fire for these facts.
 *
 * A fix commit, a reached cap and a rebase that leaves the patch unchanged fire
 * nothing: no rule below reads the round count, and a rewritten commit counts
 * only while the patch of the pull request has changed.
 */
export function scopeTriggers(facts: ScopeFacts, policy: ConvergencePolicy): Triggers {
  const { delta } = facts;
  const limits = policy.triggers;
  const reason = new Map<ScopeTrigger, string>();
  const unevaluated: Unevaluated[] = [];

  if (delta.conflict_paths.length > 0)
    reason.set("large-rebase", `a merge resolved a conflict in ${delta.conflict_paths.join(", ")}`);
  else if (!delta.empty && delta.rewritten_lines * 100 > limits.rebase_rewritten_percent * delta.pr_lines)
    reason.set(
      "large-rebase",
      `rewritten commits changed ${delta.rewritten_lines} lines against the ${delta.pr_lines} changed lines of the pull request, more than ${limits.rebase_rewritten_percent}%`,
    );

  if (delta.path_identity.length > 0)
    reason.set("path-identity", `a gitlink or same-blob add and delete changed ${delta.path_identity.join(", ")}`);

  if (facts.class_rose === null)
    unevaluated.push({ trigger: "risk-tier-rise", needs: "a merge-stage record at this round and the last" });
  else if (facts.class_rose) reason.set("risk-tier-rise", "the merge-stage class is above the last round's");

  if (facts.surface_changed === null)
    unevaluated.push({
      trigger: "surface-changed",
      needs: "a merge-stage record computed with the last round's record",
    });
  else if (facts.surface_changed) reason.set("surface-changed", "review_surface_changed is true");

  const intent = changedDigest(facts.intent);
  if (delta.added_lines * 100 > limits.growth_percent * delta.pr_lines)
    reason.set(
      "scope-growth",
      `the delta adds ${delta.added_lines} changed lines to ${delta.pr_lines}, more than ${limits.growth_percent}%`,
    );
  else if (delta.added_lines > limits.growth_lines)
    reason.set("scope-growth", `the delta adds ${delta.added_lines} changed lines, more than ${limits.growth_lines}`);
  else if (intent === true) reason.set("scope-growth", "the intent file changed");
  else if (intent === null)
    unevaluated.push({ trigger: "scope-growth", needs: "the intent file at this round and the last" });

  const criteria = changedDigest(facts.criteria);
  if (criteria === null)
    unevaluated.push({ trigger: "requirement-change", needs: "the acceptance criteria at this round and the last" });
  else if (criteria) reason.set("requirement-change", "the acceptance criteria changed");

  const fired = SCOPE_TRIGGERS.filter((trigger) => reason.has(trigger));
  return { fired, reasons: fired.map((trigger) => reason.get(trigger) ?? ""), unevaluated };
}

export const SCOPE_OUTCOMES = ["full", "carry", "closure", "new-scope", "hold"] as const;
export type ScopeOutcome = (typeof SCOPE_OUTCOMES)[number];

/** The part of the ledger state the outcome reads. */
export interface ScopePosition {
  scope: number;
  /** Whether a round of the current scope has closed, so a reviewed head exists. */
  reviewed: boolean;
}

/**
 * What the next review covers.
 *
 * - `hold`: a trigger fired and the pull request has no scope left, or it is
 *   already past its last one. The lane's captain splits or replans.
 * - `full`: no round of the current scope has closed. Round 1 reviews the whole change.
 * - `new-scope`: a trigger fired and one scope is left.
 * - `carry`: the patch is unchanged and no novel own commit appeared. No seat is called.
 * - `closure`: a closure round reviews the delta.
 *
 * `triggers` is null before round 1 of a scope, where there is no reviewed head to compare with.
 */
export function scopeOutcome(
  position: ScopePosition,
  triggers: Triggers | null,
  delta: DeltaFacts | null,
  policy: ConvergencePolicy,
): ScopeOutcome {
  if (position.scope > policy.max_scopes) return "hold";
  if (!position.reviewed || triggers === null || delta === null) return "full";
  if (triggers.fired.length > 0) return position.scope < policy.max_scopes ? "new-scope" : "hold";
  return delta.empty ? "carry" : "closure";
}
