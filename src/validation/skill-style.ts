/**
 * A skill-authoring style linter, informed by current Anthropic/OpenAI
 * guidance on writing agent skills rather than by AUTHORING.md.
 *
 * Every finding here is `warning` or `note`, never `error`, and none of them
 * sets `blocking`. That is deliberate and not an oversight: AUTHORING.md is
 * this repository's own contract and the rest of `src/validation/*` enforces
 * it at `error` severity, but the guidance this module reads against is
 * external, evolving and sometimes in tension with AUTHORING.md's own
 * requirements (§3 mandates a `## When to use` / `## Not for` pair in the
 * body, which is exactly the "selection text belongs in the description"
 * pattern this file flags). A linter that can fail `ak validate` over
 * external advice this repository has already knowingly overridden would be
 * wrong more often than it is right. So it only ever surfaces information —
 * `ak validate` prints it, counts it, and ships regardless.
 *
 * Each threshold below is a named constant with a one-line reason, per the
 * request that produced this file: a number with no reason invites a reader
 * to trust it, and a number with a reason invites a reader to argue with the
 * reason instead, which is the more useful disagreement to have.
 */

import { join } from "node:path";

import { entryBodyPath, entryDir } from "../catalog/layout.ts";
import { readTextIfPresent, walkFiles } from "../util/fs.ts";
import { extractRelativeLinks, resolveFromFile } from "../util/links.ts";
import { parseFrontmatter } from "../util/frontmatter.ts";
import { splitSections } from "./bodies.ts";
import type { CheckContext } from "./context.ts";
import { note, warning, type Issue } from "./types.ts";

/** Every rule id this module emits starts with this, so the CLI can filter on it without a second list to keep in sync. */
export const SKILL_STYLE_RULE_PREFIX = "skill-style.";

export function isSkillStyleIssue(issue: Issue): boolean {
  return issue.rule.startsWith(SKILL_STYLE_RULE_PREFIX);
}

/** chars/4 is the usual rough estimate for English prose; good enough for a warning, not for a bill. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function lineCount(text: string): number {
  const lines = text.split("\n");
  return lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
}

function lineContaining(text: string, needle: string): number | undefined {
  for (const [index, line] of text.split("\n").entries()) if (line.includes(needle)) return index + 1;
  return undefined;
}

// ---------------------------------------------------------------------------
// 1. Body length
// ---------------------------------------------------------------------------

/** Past this many lines a body can no longer be skimmed in one pass; move detail behind references/. */
export const BODY_LINE_WARN = 500;
/** Past this many estimated tokens, loading the skill materially taxes the context budget every time it is selected. */
export const BODY_TOKEN_WARN = 5000;
/** An earlier, softer signal than BODY_TOKEN_WARN, so an author can trim before the harder line is crossed. */
export const BODY_TOKEN_SOFT_WARN = 3500;

function checkBodyLength(file: string, body: string): Issue[] {
  const lines = lineCount(body);
  const tokens = estimateTokens(body);
  if (lines > BODY_LINE_WARN || tokens > BODY_TOKEN_WARN) {
    return [
      warning(
        "skill-style.body-too-long",
        file,
        `the body is ${lines} lines (~${tokens} estimated tokens), over the ${BODY_LINE_WARN}-line / ~${BODY_TOKEN_WARN}-token style guideline. Consider moving detail behind references/.`,
      ),
    ];
  }
  if (tokens > BODY_TOKEN_SOFT_WARN) {
    return [
      note(
        "skill-style.body-approaching-limit",
        file,
        `the body is ~${tokens} estimated tokens, over the ${BODY_TOKEN_SOFT_WARN}-token soft-warn line though still under the ${BODY_TOKEN_WARN}-token guideline.`,
      ),
    ];
  }
  return [];
}

// ---------------------------------------------------------------------------
// 2. Frontmatter description
// ---------------------------------------------------------------------------

/** Past this many characters the description stops being skimmable at selection time, which is the only time it is read. */
export const DESCRIPTION_CHAR_WARN = 1024;

/** A loose "use when"-shaped trigger clause; description prose varies too much for a tighter pattern to be fair. */
const TRIGGER_PATTERN = /\buse\s+(?:this\s+|it\s+)?when\b|\btriggers?\s+on\b|\buse\s+for\b/i;

function checkDescription(file: string, front: ReturnType<typeof parseFrontmatter>): Issue[] {
  if (!front.present) return []; // frontmatter.missing already owns this.
  const description = front.data["description"];
  if (typeof description !== "string" || description.length === 0) return []; // frontmatter.missing-required-key already owns this.

  const issues: Issue[] = [];
  const line = front.keyLines["description"];
  if (description.length > DESCRIPTION_CHAR_WARN) {
    issues.push(
      warning(
        "skill-style.description-too-long",
        file,
        `the description is ${description.length} characters, over the ${DESCRIPTION_CHAR_WARN}-character style guideline. A long description costs selection-time budget on every turn, not just the turns that pick it.`,
        line,
      ),
    );
  }
  if (!TRIGGER_PATTERN.test(description)) {
    issues.push(
      note(
        "skill-style.description-missing-trigger",
        file,
        `the description carries no clear "use when"-style trigger clause. The body is read only after the description selects the skill, so the condition that should select it belongs here.`,
        line,
      ),
    );
  }
  return issues;
}

// ---------------------------------------------------------------------------
// 3. Enforcement density
// ---------------------------------------------------------------------------

/** never/must/forbidden/always plus ALL-CAPS words, per 1000 estimated tokens, above which the body reads as a list of absolutes rather than guidance. */
export const ENFORCEMENT_DENSITY_WARN = 15;

const ENFORCEMENT_WORDS = /\b(?:never|must|forbidden|always)\b/gi;
/** Two-or-more-letter all-caps tokens; an approximation that also catches acronyms, which is an acceptable cost in a warnings-only heuristic. */
const ALL_CAPS_WORD = /\b[A-Z]{2,}\b/g;

function checkEnforcementDensity(file: string, body: string): Issue[] {
  const tokens = estimateTokens(body);
  if (tokens === 0) return [];
  const enforcementCount = body.match(ENFORCEMENT_WORDS)?.length ?? 0;
  const capsCount = body.match(ALL_CAPS_WORD)?.length ?? 0;
  const density = ((enforcementCount + capsCount) / tokens) * 1000;
  if (density <= ENFORCEMENT_DENSITY_WARN) return [];
  return [
    warning(
      "skill-style.enforcement-density-high",
      file,
      `${enforcementCount + capsCount} directive words (never/must/forbidden/always/ALL-CAPS) across ~${tokens} estimated tokens is a density of ${density.toFixed(1)} per 1000 tokens, over the ${ENFORCEMENT_DENSITY_WARN} guideline. A body this dense with absolutes tends to crowd out judgment.`,
    ),
  ];
}

// ---------------------------------------------------------------------------
// 4. Rationalization tables
// ---------------------------------------------------------------------------

/** A markdown table row whose first cell opens with a quoted thought, e.g. `| "The ticket is obviously..." |`. */
const RATIONALIZATION_ROW = /^\|\s*"/;

function checkRationalizationTable(file: string, body: string, offset: number): Issue[] {
  const lines = body.split("\n");
  const rows = lines.filter((line) => RATIONALIZATION_ROW.test(line.trim()));
  if (rows.length === 0) return [];
  const firstLine = lines.findIndex((line) => RATIONALIZATION_ROW.test(line.trim()));
  return [
    note(
      "skill-style.rationalization-table",
      file,
      `${rows.length} rationalization-table row${rows.length === 1 ? "" : "s"} (a table row whose first cell opens with a quoted thought). These tables are a known verbosity pattern worth a second look, even where a row count of one is unavoidable.`,
      firstLine === -1 ? undefined : firstLine + 1 + offset,
    ),
  ];
}

// ---------------------------------------------------------------------------
// 5. "When to use" / "Not for" sections in the body
// ---------------------------------------------------------------------------

/** A section shorter than this reads as a pointer, not as duplicated selection text; only longer ones are worth a note. */
export const SELECTION_SECTION_LINE_REPORT_MIN = 3;
const SELECTION_HEADINGS = ["## When to use", "## Not for"];

function checkSelectionTextInBody(file: string, body: string, offset: number): Issue[] {
  const issues: Issue[] = [];
  for (const section of splitSections(body)) {
    if (!SELECTION_HEADINGS.includes(section.heading)) continue;
    const lines = lineCount(section.text.replace(/^\n+/, "").replace(/\n+$/, ""));
    if (lines < SELECTION_SECTION_LINE_REPORT_MIN) continue;
    issues.push(
      note(
        "skill-style.selection-text-in-body",
        file,
        `${section.heading} runs ${lines} lines in the body. The body is read only after the description has already triggered the skill, so text that decides *whether* to use it belongs in the description, not here.`,
        section.line + offset,
      ),
    );
  }
  return issues;
}

// ---------------------------------------------------------------------------
// 6. Links/paths outside the skill's own directory, and reference chain depth
// ---------------------------------------------------------------------------

function checkOutsideLinks(id: string, file: string, body: string): Issue[] {
  const dir = entryDir("skills", id);
  const prefix = `${dir}/`;
  let outside = 0;
  for (const link of extractRelativeLinks(body)) {
    const resolved = resolveFromFile(file, link.target);
    if (resolved === null) continue; // links.escapes-tree already owns this.
    if (!resolved.startsWith(prefix)) outside += 1;
  }
  if (outside === 0) return [];
  return [
    note(
      "skill-style.link-outside-skill-dir",
      file,
      `${outside} link${outside === 1 ? "" : "s"} to a path outside ${dir}/ (e.g. schemas/, protocols/, adapters/, policies/). A skill that is expected to travel on its own carries its dependencies under its own directory; references/ inside ${dir}/ is fine.`,
    ),
  ];
}

/** Past this many lines, a reference file needs a map to be skimmed under progressive-disclosure (partial) loading. */
export const REFERENCE_FILE_LINE_WARN = 100;
const TOC_HEADING = /^#{1,6}\s*(table of contents|contents|toc)\s*$/i;

function checkReferenceFiles(ctx: CheckContext, id: string): Issue[] {
  const dir = entryDir("skills", id);
  const issues: Issue[] = [];

  for (const refFile of walkFiles(ctx.root, `${dir}/references`)) {
    if (!refFile.endsWith(".md")) continue;
    const text = readTextIfPresent(join(ctx.root, refFile));
    if (text === null) continue;

    const lines = lineCount(text);
    const hasToc = text.split("\n").some((line) => TOC_HEADING.test(line.trim()));
    if (lines > REFERENCE_FILE_LINE_WARN && !hasToc) {
      issues.push(
        warning(
          "skill-style.reference-missing-toc",
          refFile,
          `${lines} lines with no table-of-contents heading, over the ${REFERENCE_FILE_LINE_WARN}-line guideline for a file loaded on demand and often read partially.`,
        ),
      );
    }

    for (const link of extractRelativeLinks(text)) {
      const resolved = resolveFromFile(refFile, link.target);
      if (resolved === null || resolved === refFile) continue;
      if (!resolved.includes("/references/")) continue;
      issues.push(
        warning(
          "skill-style.reference-chain-depth",
          refFile,
          `links to ${resolved}, itself a reference file. A reference a skill loads should be one level of indirection, not a chain of them.`,
          link.line,
        ),
      );
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// 8. Legacy phrases
// ---------------------------------------------------------------------------

/** Phrasing current skill-authoring guidance has moved away from; each is reported where it appears, verbatim casing aside. */
export const LEGACY_PHRASES: ReadonlyArray<string> = [
  "show your reasoning",
  "think step by step",
  "before every edit",
  "hold all findings",
  "if in doubt, use",
];

function checkLegacyPhrases(file: string, body: string, offset: number): Issue[] {
  const issues: Issue[] = [];
  const lower = body.toLowerCase();
  for (const phrase of LEGACY_PHRASES) {
    if (!lower.includes(phrase)) continue;
    issues.push(
      warning(
        "skill-style.legacy-phrase",
        file,
        `carries the phrase "${phrase}", which current skill-authoring guidance treats as a legacy prompting pattern.`,
        lineContaining(lower, phrase)! + offset,
      ),
    );
  }
  return issues;
}

// ---------------------------------------------------------------------------

function checkOneSkill(ctx: CheckContext, id: string): Issue[] {
  const file = entryBodyPath("skills", id);
  const text = readTextIfPresent(join(ctx.root, file));
  if (text === null) return []; // completeness owns "this body does not exist".

  const front = parseFrontmatter(text);
  const body = front.present ? front.body : text;
  // Body line numbers are relative to the body; report them against the file.
  const offset = front.bodyStartLine - 1;

  return [
    ...checkBodyLength(file, body),
    ...checkDescription(file, front),
    ...checkEnforcementDensity(file, body),
    ...checkRationalizationTable(file, body, offset),
    ...checkSelectionTextInBody(file, body, offset),
    ...checkOutsideLinks(id, file, body),
    ...checkLegacyPhrases(file, body, offset),
    ...checkReferenceFiles(ctx, id),
  ];
}

export function checkSkillStyle(ctx: CheckContext): Issue[] {
  const issues: Issue[] = [];
  for (const entry of ctx.catalog.bySection("skills")) {
    issues.push(...checkOneSkill(ctx, entry.id));
  }
  return issues;
}
