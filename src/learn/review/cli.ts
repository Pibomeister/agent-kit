/**
 * `ak learn review <verb>`: the review loop from the command line.
 *
 * Every writing verb holds the ledger lock for its whole run, so `run` is
 * ingest → maintain → propose under one lock. A second concurrent run exits
 * quietly with status 0.
 */
import { basename } from "node:path";
import type { LearnArea, LearnArgs, LearnContext } from "../core/context.ts";
import { flag } from "../core/context.ts";
import { Ledger } from "../core/ledger.ts";
import { mainRepoRoot } from "../core/paths.ts";
import { readText } from "../core/store.ts";
import { ingest, type IngestOptions } from "./ingest.ts";
import { reviewLedger, reviewLedgerDir } from "./ledger.ts";
import { maintain } from "./maintain.ts";
import { pendingPromotions, promoteById, propose, retire, rollback } from "./propose.ts";

/** `--repo PATH` is the project root, as in every other area; without it the root of `--cwd`. */
function rootFor(args: LearnArgs, ctx: LearnContext): string | null {
  const root = mainRepoRoot(flag(args, "repo") ?? flag(args, "cwd") ?? ctx.cwd);
  if (root === null) ctx.io.err("ak learn review: not inside a git repository");
  return root;
}

/** Resolve the root, open the ledger and hold its lock around `body`. */
function locked(args: LearnArgs, ctx: LearnContext, body: (ledger: Ledger, root: string) => number): number {
  const root = rootFor(args, ctx);
  if (root === null) return 1;
  // A dry run writes nothing, so it neither creates the ledger nor takes its lock.
  const ledger = ctx.config.dryRun ? new Ledger(reviewLedgerDir(ctx.config, root)) : reviewLedger(ctx.config, root);
  const release = ctx.config.dryRun ? () => {} : ledger.tryLock();
  if (release === null) {
    ctx.io.err("ak learn review: another run holds the ledger lock");
    return 0;
  }
  try {
    return body(ledger, root);
  } catch (error) {
    ctx.io.err(`ak learn review: ${(error as Error).message}`);
    return 1;
  } finally {
    release();
  }
}

/** `--pr 12` or `--pr 12,15`. Non-numbers are refused rather than dropped. */
export function prNumbers(value: string | undefined): number[] {
  if (value === undefined) return [];
  return value.split(",").map((item) => {
    const n = Number.parseInt(item.trim(), 10);
    if (!Number.isInteger(n) || n <= 0 || String(n) !== item.trim())
      throw new Error(`--pr wants PR numbers, got ${item}`);
    return n;
  });
}

/**
 * Ingest options from the flags. `--gh-repo` names the GitHub repository; without it the source infers it from the git remote.
 * `--cwd` is the session's working directory, so a linked worktree's branch picks the PR, not the main checkout's.
 */
export function ingestOptions(args: LearnArgs, ctx: LearnContext): IngestOptions {
  return {
    cwd: flag(args, "cwd") ?? flag(args, "repo") ?? ctx.cwd,
    prs: prNumbers(flag(args, "pr")),
    since: flag(args, "since"),
    repo: flag(args, "gh-repo"),
    source: flag(args, "source") ?? "claude",
    skipGithub: args.flags.has("no-github"),
    skipMem: args.flags.has("no-mem"),
  };
}

function doIngest(args: LearnArgs, ctx: LearnContext, ledger: Ledger, root: string): void {
  const result = ingest(ctx, ledger, root, ingestOptions(args, ctx));
  if (ctx.config.dryRun) {
    for (const event of result.events) {
      const where = `${event.path ?? ""}:${event.line ?? ""}`;
      ctx.io.out(
        `${event.source.padEnd(14)} ${event.kind.padEnd(10)} pr=${event.pr} sev=${event.severity} by=${event.author} ${where}`,
      );
      ctx.io.out(`    ${JSON.stringify(event.text.slice(0, 140))}`);
    }
    ctx.io.out(`${result.events.length} events (dry run; ledger ${ledger.dir})`);
  } else {
    ctx.io.out(`ingest: +${result.fresh} new events -> ${ledger.dir}`);
  }
}

export const reviewArea: LearnArea = {
  summary: "review findings -> pattern ledger -> guardrails, with the repeat rate per run",
  verbs: {
    run: {
      usage:
        "review run [--pr N[,N]] [--repo PATH] [--cwd PATH] [--gh-repo owner/name] [--since YYYY-MM-DD] [--source codex]   ingest, maintain, propose",
      run: (args, ctx) =>
        locked(args, ctx, (ledger, root) => {
          // Maintain runs even with nothing fresh: a batch the judge failed on earlier is still waiting.
          doIngest(args, ctx, ledger, root);
          ctx.io.out(`maintain: ${maintain(ctx, ledger, basename(root))}`);
          ctx.io.out(`propose: ${propose(ctx, ledger, root)}`);
          return 0;
        }),
    },
    ingest: {
      usage:
        "review ingest [--pr N[,N]] [--repo PATH] [--cwd PATH] [--gh-repo owner/name] [--since YYYY-MM-DD] [--no-github] [--no-mem]",
      run: (args, ctx) =>
        locked(args, ctx, (ledger, root) => {
          doIngest(args, ctx, ledger, root);
          return 0;
        }),
    },
    maintain: {
      usage: "review maintain               classify unprocessed events into pattern pages",
      run: (args, ctx) =>
        locked(args, ctx, (ledger, root) => {
          ctx.io.out(`maintain: ${maintain(ctx, ledger, basename(root))}`);
          return 0;
        }),
    },
    propose: {
      usage: "review propose                promote active patterns at the threshold to guardrails",
      run: (args, ctx) =>
        locked(args, ctx, (ledger, root) => {
          ctx.io.out(`propose: ${propose(ctx, ledger, root)}`);
          return 0;
        }),
    },
    report: {
      usage: "review report                 index, guardrails and the last runs",
      run: (args, ctx) => {
        const root = rootFor(args, ctx);
        if (root === null) return 1;
        const ledger = reviewLedger(ctx.config, root);
        ctx.io.out(readText(ledger.path("index.md")).trimEnd());
        const guard = readText(ledger.path("guardrails.md")).trim();
        ctx.io.out("");
        ctx.io.out("## Guardrails");
        ctx.io.out("");
        ctx.io.out(guard === "" ? "(none)" : guard);
        ctx.io.out("");
        ctx.io.out(`ledger: ${ledger.dir}`);
        return 0;
      },
    },
    retire: {
      usage: "review retire --id rp-NNN     remove the guardrail bullet, keep the page",
      run: (args, ctx) => {
        const id = flag(args, "id") ?? args.positional[0];
        if (id === undefined) {
          ctx.io.err("ak learn review retire: --id rp-NNN is required");
          return 2;
        }
        return locked(args, ctx, (ledger) => {
          const message = ctx.config.dryRun ? `dry run: would retire ${id}` : retire(ledger, id);
          ctx.io.out(message);
          return message.startsWith("unknown") ? 1 : 0;
        });
      },
    },
    rollback: {
      usage: "review rollback [--to SHA]    revert the ledger's last commit, or every commit after SHA",
      run: (args, ctx) =>
        locked(args, ctx, (ledger) => {
          if (ctx.config.dryRun) {
            ctx.io.out(
              `dry run: would revert ${flag(args, "to") === undefined ? "HEAD" : `every commit after ${flag(args, "to")}`}`,
            );
            return 0;
          }
          const message = rollback(ledger, flag(args, "to"));
          ctx.io.out(message);
          return message.startsWith("reverted") || message === "nothing to roll back" ? 0 : 1;
        }),
    },
    promote: {
      usage: "review promote [--id rp-NNN]  list pending team promotions, or promote one pattern by hand",
      run: (args, ctx) => {
        const id = flag(args, "id");
        if (id === undefined) {
          const root = rootFor(args, ctx);
          if (root === null) return 1;
          ctx.io.out(pendingPromotions(reviewLedger(ctx.config, root)).trimEnd());
          return 0;
        }
        return locked(args, ctx, (ledger, root) => {
          const message = promoteById(ctx, ledger, root, id);
          ctx.io.out(message);
          return message.startsWith("promoted") || message.startsWith("dry run") ? 0 : 1;
        });
      },
    },
  },
};
