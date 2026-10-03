/**
 * Recurrence replay for the review loop. Manual, not part of `bun test`: it
 * calls the configured judge command (`AK_LEARN_JUDGE`) once per batch.
 *
 *     bun tests/learn/evals/review-recurrence-replay.ts
 *
 * Two maintain runs on a scratch ledger: PRs 101 and 102 first, then 103, 104
 * and 105, where PR 105 raises classes the first run already holds. The second
 * run's repeat count must be above zero, or the repeat-rate metric is not
 * measuring recurrence. Events go straight into the raw layer, so neither
 * GitHub nor claude-mem is read.
 */
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { loadConfig } from "../../../src/learn/core/config.ts";
import type { LearnContext } from "../../../src/learn/core/context.ts";
import { commandJudge } from "../../../src/learn/core/judge.ts";
import { appendEvents } from "../../../src/learn/review/events.ts";
import { reviewLedger } from "../../../src/learn/review/ledger.ts";
import { maintain } from "../../../src/learn/review/maintain.ts";
import { runRows } from "../../../src/learn/review/patterns.ts";
import { GOLD, goldEvents, RECURRING } from "./review-fixtures.ts";

/** Replay both runs against `ctx.judge` and return the second run's repeat count, or -1 without a second run row. */
export function replay(ctx: LearnContext, root: string, print: (line: string) => void = console.log): number {
  const ledger = reviewLedger(ctx.config, root);
  const gold = goldEvents(GOLD);
  const batches = [
    gold.filter((event) => event.pr === 101 || event.pr === 102),
    [...gold.filter((event) => event.pr === 103 || event.pr === 104), ...goldEvents(RECURRING, "r")],
  ];
  for (const batch of batches) {
    appendEvents(ledger, batch);
    ledger.commit(`ingest: +${batch.length} events`);
    print(`maintain: ${maintain(ctx, ledger, basename(root))}`);
  }
  const rows = runRows(ledger);
  for (const row of rows) print(row);
  const second = rows[1]?.split("|");
  return second === undefined ? -1 : Number.parseInt((second[4] ?? "").trim(), 10);
}

if (import.meta.main) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "ak-review-replay-")));
  const env = { ...process.env, CLAUDE_CONFIG_DIR: join(base, "config") };
  const config = loadConfig(env);
  const ctx: LearnContext = {
    cwd: base,
    io: { out: (line) => console.log(line), err: (line) => console.error(line) },
    config,
    judge: commandJudge(config),
    env,
  };
  const repeats = replay(ctx, join(base, "shop"));
  console.log(repeats > 0 ? "PASS: second run recorded repeats" : "FAIL: second run recorded 0 repeats");
  process.exit(repeats > 0 ? 0 : 1);
}
