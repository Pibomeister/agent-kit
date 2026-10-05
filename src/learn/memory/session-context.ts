/**
 * The one SessionStart block: review guardrails, working memory and up to
 * eight confirmed lessons, merged within ONE token cap (`memoryTokens`), then
 * the skill roster.
 *
 * Guardrails are placed first and are never trimmed for memory; memory and
 * lessons get what remains of the cap and lose bullets from their least
 * valuable section first. Muting a project (`ak learn memory mute`) stops the
 * memory and lessons immediately; guardrails and the roster belong to other
 * loops and stay.
 *
 * Session start is also where a repository registers itself, because it runs
 * in the user's own context: a linked worktree, whose `.git` is a file the
 * scheduled tick cannot follow, is resolved here with git.
 */
import { existsSync } from "node:fs";
import type { LearnContext } from "../core/context.ts";
import { Ledger } from "../core/ledger.ts";
import { mainRepoRoot, rootOf } from "../core/paths.ts";
import { readText, todayLocal, tokens } from "../core/store.ts";
import { guardrailsSection } from "../review/guardrails.ts";
import { rosterSection } from "../skills/roster.ts";
import { ageWords, loadLessons, memoryDir, readState, splitLines, str } from "./ledger.ts";
import { registerRoot } from "./registry.ts";

export const MAX_LESSONS = 8;

/** Least valuable first: bullets are dropped from the bottom of the first section that still has one. */
export const TRIM_ORDER = [
  "## Completed ✅ (last 7 days)",
  "## Lessons",
  "## Current state",
  "## Decisions",
  "## Unresolved",
  "## Environment gotchas",
  "## Preferences & corrections",
];

const TRUNCATED = "\n(truncated at the memory token cap)\n";
const MEMORY_HEADER = "Working memory for this repo (derived from past sessions; every bullet cites its evidence ids):";

type Section = [header: string | null, lines: string[]];

function sections(text: string): Section[] {
  const out: Section[] = [];
  let current: Section = [null, []];
  for (const line of splitLines(text)) {
    if (line.startsWith("## ")) {
      out.push(current);
      current = [line, []];
    } else {
      current[1].push(line);
    }
  }
  out.push(current);
  return out;
}

function render(secs: readonly Section[]): string {
  const parts: string[] = [];
  for (const [header, lines] of secs) {
    const block = [...(header === null ? [] : [header]), ...lines].join("\n").replace(/^\n+|\n+$/g, "");
    if (block !== "") parts.push(block);
  }
  return `${parts.join("\n\n")}\n`;
}

/**
 * Drop bullets from the bottom of the least valuable section until the block
 * fits `cap` tokens. Prose the bullet pass cannot shrink is hard-cut at the cap.
 */
export function trim(text: string, cap: number): string {
  const secs = sections(text);
  while (tokens(render(secs)) > cap) {
    let removed = false;
    for (const header of TRIM_ORDER) {
      const section = secs.find(([name]) => name === header);
      if (section === undefined) continue;
      const lines = section[1];
      let index = -1;
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        if (lines[i]!.startsWith("- ")) {
          index = i;
          break;
        }
      }
      if (index >= 0) {
        lines.splice(index, 1);
        removed = true;
        break;
      }
    }
    if (!removed) break;
  }
  return hardCut(render(secs), cap);
}

/** Hard-cut plain text at a token cap, on a line boundary. */
function hardCut(text: string, cap: number): string {
  if (tokens(text) <= cap) return text;
  const head = text.slice(0, Math.max(0, cap * 4 - TRUNCATED.length));
  const cut = head.lastIndexOf("\n");
  return (cut >= 0 ? head.slice(0, cut) : head) + TRUNCATED;
}

/** Confirmed lessons, most confident and most recent first, at most eight. */
export function lessonsBlock(ledger: Ledger): { text: string; confirmed: number; total: number } {
  const lessons = [...loadLessons(ledger).values()].map(({ meta }) => meta);
  const confirmed = lessons.filter((meta) => meta.status === "confirmed");
  confirmed.sort(
    (a, b) => Number(b.confidence ?? 0) - Number(a.confidence ?? 0) || str(b.last_seen).localeCompare(str(a.last_seen)),
  );
  if (confirmed.length === 0) return { text: "", confirmed: 0, total: lessons.length };
  const rows = confirmed.slice(0, MAX_LESSONS).map((meta) => `- ${str(meta.statement)} [${str(meta.id)}]`);
  return { text: `## Lessons\n${rows.join("\n")}\n`, confirmed: confirmed.length, total: lessons.length };
}

function nextNightly(lastNightly: string | undefined, now = new Date()): string {
  const today = todayLocal(now);
  if ((lastNightly ?? "") < today) return today;
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  return todayLocal(tomorrow);
}

/** The project root for a session: stat first, git for a linked worktree. */
export function sessionRoot(cwd: string): string | null {
  return rootOf(cwd) ?? mainRepoRoot(cwd);
}

export function sessionStartBlock(ctx: LearnContext): string {
  const root = sessionRoot(ctx.cwd);
  const roster = rosterSection(ctx, root);
  if (root === null) return roster;
  // The hook's span keys the root this block was built for, linked worktrees included.
  ctx.span?.project(root);
  registerRoot(ctx.config, root);

  const cap = ctx.config.memoryTokens;
  const guardrails = hardCut(guardrailsSection(ctx, root).trim(), cap);
  const parts: string[] = [];
  if (guardrails !== "") parts.push(guardrails);

  const ledger = new Ledger(memoryDir(ctx.config, root));
  const memoryPath = ledger.path("memory.md");
  if (existsSync(memoryPath)) {
    const state = readState(ledger);
    if (state.muted !== true) {
      const memory = readText(memoryPath).trim();
      const lessons = lessonsBlock(ledger);
      // The cap covers what the model reads: guardrails, the header and the memory itself.
      const remaining = Math.max(0, cap - (guardrails === "" ? 0 : tokens(guardrails) + 1) - tokens(MEMORY_HEADER) - 1);
      const merged =
        memory !== "" || lessons.text !== "" ? trim(`${`${memory}\n\n${lessons.text}`.trim()}\n`, remaining) : "";
      if (merged.trim() !== "") {
        parts.push(`${MEMORY_HEADER}\n${merged.trimEnd()}`);
      }
      const reflected = state.last_reflect ? `${ageWords(state.last_reflect)} ago` : "never";
      parts.push(
        `memory: reflected ${reflected} · ${lessons.total} lessons (${lessons.confirmed} confirmed) · ` +
          `next nightly ${nextNightly(state.last_nightly)} · \`ak learn memory show\``,
      );
    }
  }
  if (roster.trim() !== "") parts.push(roster.trim());
  return parts.length > 0 ? `${parts.join("\n\n")}\n` : "";
}
