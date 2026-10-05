/**
 * `ak learn skills` — the roster and the skill-learn candidate queue.
 */
import { resolve } from "node:path";
import { flag, type LearnArea, type LearnArgs, type LearnContext } from "../core/context.ts";
import { mainRepoRoot } from "../core/paths.ts";
import { span, triggerOf } from "../core/trace.ts";
import { discover, loadRegistry, promoteCandidate, rejectCandidate, runSkillLearn, skillsLedger } from "./learn.ts";
import { rosterSection } from "./roster.ts";

/** `--repo`, else the working directory, resolved to its main repository root. */
export function repoRoot(args: LearnArgs, ctx: LearnContext): string | null {
  const repo = flag(args, "repo");
  const start = repo === undefined ? ctx.cwd : resolve(ctx.cwd, repo);
  return mainRepoRoot(start) ?? (repo === undefined ? null : start);
}

/** `--since 14` (days) or `--since 2026-09-01` (a date); fourteen days when absent. */
export function sinceDays(value: string | undefined, now = Date.now()): number | null {
  if (value === undefined) return 14;
  if (/^\d+d?$/.test(value)) return Number.parseInt(value, 10);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, (now - at) / 86_400_000) : null;
}

function needRoot(args: LearnArgs, ctx: LearnContext): string | null {
  const root = repoRoot(args, ctx);
  if (root === null) ctx.io.err("ak learn skills: not inside a git repository; pass --repo");
  return root;
}

function needId(args: LearnArgs, ctx: LearnContext): string | null {
  const id = flag(args, "id") ?? args.positional[0];
  if (id === undefined) ctx.io.err("ak learn skills: --id is required");
  return id ?? null;
}

export const skillsArea: LearnArea = {
  summary: "skill roster and skill-learn candidates (drafts only; promotion is a human act)",
  verbs: {
    roster: {
      usage: "skills roster [--repo P]                     print the roster block the session-start hook appends",
      run: (args, ctx) => {
        const text = rosterSection(ctx, repoRoot(args, ctx));
        if (text !== "") ctx.io.out(text.trimEnd());
        return 0;
      },
    },
    discover: {
      usage: "skills discover [--repo P] [--since D] [--force]  propose candidates from recurring un-served requests",
      run: (args, ctx) => {
        const root = needRoot(args, ctx);
        if (root === null) return 2;
        const days = sinceDays(flag(args, "since"));
        if (days === null) {
          ctx.io.err("ak learn skills discover: --since takes a day count or a date");
          return 2;
        }
        const summary = span(ctx, "skills.discover", triggerOf(ctx, "cli"), (inner) => {
          inner.span?.project(root);
          return discover(inner, root, { days, force: args.flags.has("force") });
        });
        ctx.io.out(summary === "" ? "another discovery holds the skills ledger; skipped" : summary);
        return 0;
      },
    },
    run: {
      usage:
        "skills run [--repo P]                        discovery at most once a day, then refresh candidate use counts",
      run: (args, ctx) => {
        const root = needRoot(args, ctx);
        if (root === null) return 2;
        const summary = runSkillLearn(ctx, root);
        if (summary !== "") ctx.io.out(summary);
        return 0;
      },
    },
    list: {
      usage: "skills list [--repo P]                       candidates with status, uses and evidence",
      run: (args, ctx) => {
        const root = needRoot(args, ctx);
        if (root === null) return 2;
        const registry = loadRegistry(skillsLedger(ctx, root));
        const rows = Object.entries(registry.candidates).sort((a, b) => a[0].localeCompare(b[0]));
        for (const [id, info] of rows) {
          ctx.io.out(
            `${id}  ${info.status.padEnd(9)} ${info.name.padEnd(32)} scope=${info.scope} uses=${info.uses} evidence=${info.evidence} ${info.confidence}`,
          );
        }
        ctx.io.out(
          `${rows.length} candidates, ${registry.rejected.length} rejected names, ${Object.keys(registry.seen_sessions).length} sessions seen`,
        );
        return 0;
      },
    },
    promote: {
      usage: "skills promote --id sk-NNN [--repo P]        print the draft as a writing-skills input; installs nothing",
      run: (args, ctx) => {
        const root = needRoot(args, ctx);
        const id = needId(args, ctx);
        if (root === null || id === null) return 2;
        const text = promoteCandidate(ctx, root, id);
        if (text === null) {
          ctx.io.err(`ak learn skills promote: no candidate ${id}`);
          return 1;
        }
        ctx.io.out(text);
        return 0;
      },
    },
    reject: {
      usage: "skills reject --id sk-NNN [--repo P]         delete the draft and never propose its name again",
      run: (args, ctx) => {
        const root = needRoot(args, ctx);
        const id = needId(args, ctx);
        if (root === null || id === null) return 2;
        if (!rejectCandidate(ctx, root, id)) {
          ctx.io.err(`ak learn skills reject: no candidate ${id}`);
          return 1;
        }
        ctx.io.out(`rejected ${id}`);
        return 0;
      },
    },
  },
};
