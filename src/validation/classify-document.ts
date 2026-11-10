/**
 * Document-kind oracle for doc-review (FR-01 / AT-20).
 *
 * A page that only states a product contract is requirements. Any
 * implementation-planning heading makes it a plan. Classification reads the
 * document body, never the filename, never a readiness label, and never YAML
 * frontmatter (those are labels, not content). Heading-like lines inside
 * fenced code are not headings.
 */

import { readFileSync } from "node:fs";
import { basename } from "node:path";

import { sha256Hex } from "../util/hash.ts";
import { fenceAfter, type FenceState } from "./headings.ts";

export type DocumentKind = "requirements" | "plan";

const HEADING = /^#{1,6}\s+(.*?)\s*#*\s*$/;

/** Section titles that are implementation planning, compared case-insensitively. */
const IMPLEMENTATION_HEADINGS = new Set([
  "implementation",
  "approach",
  "rollout",
  "tickets",
  "work items",
  "file changes",
  "technical design",
]);

function stripFrontmatter(text: string): string {
  if (!text.startsWith("---\n")) return text;
  const end = text.indexOf("\n---\n", 4);
  if (end === -1) return text;
  return text.slice(end + 5);
}

function headingTitle(line: string): string | null {
  return HEADING.exec(line)?.[1] ?? null;
}

/** ATX headings in the body, skipping YAML frontmatter and fenced regions. */
export function documentHeadings(markdown: string): readonly string[] {
  const titles: string[] = [];
  let fence: FenceState | null = null;
  for (const raw of stripFrontmatter(markdown).split("\n")) {
    const line = raw ?? "";
    const next = fenceAfter(line, fence);
    const skip = fence !== null || next !== null;
    fence = next;
    if (skip) continue;
    const title = headingTitle(line);
    if (title !== null) titles.push(title);
  }
  return titles;
}

/** Content identity a review binds to. Changed bytes produce a different digest. */
export function documentIdentity(content: string): string {
  return `sha256:${sha256Hex(content)}`;
}

/**
 * Classify a document from its body. `filename` is accepted so a caller that
 * has a path cannot claim the oracle never saw it; the oracle still ignores it.
 */
export function classifyDocumentKind(content: string, filename = ""): DocumentKind {
  void basename(filename);
  for (const title of documentHeadings(content)) {
    if (IMPLEMENTATION_HEADINGS.has(title.toLowerCase())) return "plan";
  }
  return "requirements";
}

/** Read a file and classify its bytes. The path's basename is not a signal. */
export function classifyDocumentFile(path: string): DocumentKind {
  return classifyDocumentKind(readFileSync(path, "utf8"), basename(path));
}
