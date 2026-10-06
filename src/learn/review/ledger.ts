/**
 * The review loop's ledger: `<configDir>/projects/<folder>/agent-kit/review/`.
 *
 * | Layer | Files |
 * |---|---|
 * | Raw (append-only) | `raw/review-events.jsonl` |
 * | Wiki | `patterns/rp-NNN.md`, `index.md`, `log.md`, `skill-impact.md` |
 * | Policy | `guardrails.md` (loaded at session start), `pending-team-promotions.md` (proposed only) |
 *
 * Run markers, the pipeline log and the lock are ignored by the ledger's git,
 * so a rollback never resurrects a debounce mark or a stale lock.
 */
import type { LearnConfig } from "../core/config.ts";
import { Ledger } from "../core/ledger.ts";
import { loopDir } from "../core/paths.ts";

export const EVENTS_FILE = "raw/review-events.jsonl";

export const RUNS_HEADER = "| date | prs | findings | repeats | new | repeat rate |\n|---|---|---|---|---|---|\n";
export const PATTERNS_HEADER = "| id | count | last seen | status | problem → fix |\n|---|---|---|---|---|\n";

export const REVIEW_SEED: Readonly<Record<string, string>> = {
  [EVENTS_FILE]: "",
  "index.md": `# Review patterns\n\n## Runs\n\n${RUNS_HEADER}\n## Patterns\n\n${PATTERNS_HEADER}`,
  "guardrails.md": "",
  "pending-team-promotions.md":
    "# Pending team promotions\n\nProposals for tracked repo files. Apply by hand, then mark `applied:` with the commit.\n",
  "skill-impact.md":
    "# Skill impact\n\n| date | action | pattern | repeat rate before | note |\n|---|---|---|---|---|\n",
  "log.md": "# Maintainer log\n",
  ".gitignore": "raw/.last_run\nraw/.pipeline.log\nraw/.pipeline.1.log\n.lock*\n",
};

/** The review ledger's directory for a project root. Creates nothing. */
export function reviewLedgerDir(config: LearnConfig, root: string): string {
  return loopDir(config, root, "review");
}

/** The review ledger for a project root, created and seeded when missing. Safe on every run. */
export function reviewLedger(config: LearnConfig, root: string): Ledger {
  return new Ledger(reviewLedgerDir(config, root)).ensure(REVIEW_SEED, "init review ledger");
}
