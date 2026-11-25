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
 *   lines and the changed lines themselves. A mode-only pair and a gitlink each
 *   count as one changed line. The id is for rewritten-commit matching. Empty
 *   is blob identity in `delta.ts`.
 * - `scopeTriggers` says which triggers fire, which could not be evaluated and
 *   why.
 * - `scopeOutcome` turns the triggers and the ledger's scope into one of
 *   `full`, `carry`, `closure`, `new-scope` and `hold`.
 */

import { createHash } from "node:crypto";

import { SCOPE_TRIGGERS, type ConvergencePolicy, type ScopeTrigger } from "./types.ts";

export interface Patch {
  /** The digest of the changed lines in order. It holds no line number and no context line. */
  id: string;
  /** Changed lines: one per added or removed line and one per binary file. */
  lines: number;
  /** How many times each changed line occurs, keyed by its file. */
  counts: Map<string, number>;
}

const MODE = /^(old mode|new mode|new file mode|deleted file mode) /;
const GITLINK_MODE = / 160000$/;

/**
 * Read a diff made with no context lines, no rename detection and full blob ids.
 *
 * The id keeps whitespace, so an indentation change is a change. It drops hunk
 * headers, so a patch that only moved keeps its id. A binary file counts as
 * one changed line, identified by the blob it becomes. An old-mode/new-mode
 * pair counts as one changed line. A gitlink (mode 160000) counts as one SHA
 * line, not the Subproject commit hunk.
 */
export function readPatch(diff: string): Patch {
  const hash = createHash("sha256");
  const counts = new Map<string, number>();
  let lines = 0;
  let file = "";
  let blob = "";
  let inHunk = false;
  let gitlink = false;
  let oldMode = false;
  let newMode = false;
  const changed = (text: string): void => {
    hash.update(`${text}\n`);
    lines += 1;
    const key = `${file}\n${text}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  };
  const flushMode = (): void => {
    if (oldMode && newMode) changed("mode");
    oldMode = false;
    newMode = false;
  };
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      flushMode();
      file = line;
      blob = "";
      inHunk = false;
      gitlink = false;
      hash.update(`${line}\n`);
    } else if (line.startsWith("@@")) {
      // A changed line starts with `+`, `-` or `\`, so this is a hunk header wherever it stands.
      inHunk = true;
    } else if (inHunk) {
      if (gitlink) continue;
      if (line.startsWith("+") || line.startsWith("-")) changed(line);
      // `\ No newline at end of file` is part of what changed.
      else if (line.startsWith("\\")) hash.update(`${line}\n`);
    } else if (line.startsWith("index ")) {
      blob = line.slice("index ".length).split("..")[1]?.split(" ")[0] ?? "";
      if (GITLINK_MODE.test(line)) gitlink = true;
      if (gitlink) changed(`gitlink ${blob}`);
    } else if (line.startsWith("Binary files ") || line === "GIT binary patch") {
      changed(`binary ${blob}`);
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
    }
  }
  flushMode();
  return { id: `sha256:${hash.digest("hex")}`, lines, counts };
}

/** Changed lines that `patch` holds and `other` does not, each counted as often as it occurs. */
export function linesNotIn(patch: Patch, other: Patch): number {
  let total = 0;
  for (const [key, count] of patch.counts) total += Math.max(0, count - (other.counts.get(key) ?? 0));
  return total;
}

/** The pull request at the new head against the pull request at the last reviewed head. */
export interface DeltaFacts {
  /**
   * The pull request at the new head has the same path, mode and blob as it
   * had at the last reviewed head. The changed-line patch id is not this test.
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
   * work, and the count is the larger of the lines either holds and the other
   * does not. Own commits after the cut are new commits, which scope growth reads.
   */
  rewritten_lines: number;
  /** Paths in which a merge that is new at the head had a conflict. Each is a path the pull request's commits changed. */
  conflict_paths: readonly string[];
  /**
   * Paths whose tree entry changed as a gitlink (mode 160000) or as a same-blob
   * add and delete. Either fires `path-identity`.
   */
  path_identity: readonly string[];
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
 * - `carry`: the patch is unchanged. No seat is called.
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
