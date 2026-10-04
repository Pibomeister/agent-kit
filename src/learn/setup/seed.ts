/**
 * `ak learn setup seed --repo P` — bring one repository under the runtime.
 *
 * Registers the root, initializes the review, memory and skills ledgers, and
 * runs the review ingest as a dry path so the first report shows what the
 * sources can see. No judge is called: the judge is replaced by one that
 * refuses, so a seed that tried to judge would fail loudly rather than spend.
 */
import { resolve } from "node:path";
import type { LearnContext } from "../core/context.ts";
import { mainRepoRoot } from "../core/paths.ts";
import { ensureMemoryLedger, memoryDir } from "../memory/ledger.ts";
import { registerRoot } from "../memory/registry.ts";
import { deferredNote, ingest, type IngestOptions } from "../review/ingest.ts";
import { reviewLedger } from "../review/ledger.ts";
import { skillsLedger } from "../skills/learn.ts";

export interface SeedOptions {
  since?: string;
  /** Leave GitHub out of the dry ingest (no `gh` calls). */
  skipGithub?: boolean;
}

export function seed(ctx: LearnContext, repo: string, options: SeedOptions = {}): number {
  const start = resolve(ctx.cwd, repo);
  const root = mainRepoRoot(start);
  if (root === null) {
    ctx.io.err(`ak learn setup seed: ${start} is not inside a git repository`);
    return 1;
  }
  registerRoot(ctx.config, root);
  ctx.io.out(`registered ${root}`);
  const review = reviewLedger(ctx.config, root);
  const memory = ensureMemoryLedger(memoryDir(ctx.config, root));
  const skills = skillsLedger(ctx, root);
  for (const [name, ledger] of [
    ["review", review],
    ["memory", memory],
    ["skills", skills],
  ] as const)
    ctx.io.out(`${name} ledger: ${ledger.dir}`);

  const dry: LearnContext = {
    ...ctx,
    config: { ...ctx.config, dryRun: true },
    judge: () => {
      throw new Error("seed never calls the judge");
    },
  };
  const ingestOptions: IngestOptions = { skipGithub: options.skipGithub === true };
  if (options.since !== undefined) ingestOptions.since = options.since;
  const result = ingest(dry, review, root, ingestOptions);
  const bySource = new Map<string, number>();
  for (const event of result.events) bySource.set(event.source, (bySource.get(event.source) ?? 0) + 1);
  const detail = [...bySource.entries()].map(([source, n]) => `${source}=${n}`).join(", ");
  ctx.io.out(
    `dry ingest: ${result.events.length} events visible${detail === "" ? "" : ` (${detail})`}${deferredNote(result)}; nothing written`,
  );
  ctx.io.out(
    `next: \`ak learn review run --repo ${root}\` for the first review pass, \`ak learn memory run --repo ${root}\` for the first memory pass`,
  );
  return 0;
}
