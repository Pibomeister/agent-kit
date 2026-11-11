/**
 * Reference oracle for GAP-01 (FR-01 / AT-20).
 *
 * Status: partial. Deterministic reference only, product behavior unverified.
 * This module is not wired into doc-review, docrules, or any product path.
 *
 * It only pins the fixtures under tests/fixtures/doc-review/classify/. It does
 * not define document classification. A page in that set with an
 * implementation-planning heading is `plan`; the others are `requirements`.
 * Filename, readiness labels and YAML frontmatter are not signals.
 */

import { readFileSync } from "node:fs";

import { sha256Hex } from "../util/hash.ts";
import { fenceAfter, headingTitle, type FenceState } from "./headings.ts";

export type DocumentKind = "requirements" | "plan";

/** Section titles that the fixtures treat as implementation planning. */
const IMPLEMENTATION_HEADINGS = new Set([
  "implementation",
  "approach",
  "rollout",
  "tickets",
  "work items",
  "file changes",
  "technical design",
]);

function normalizeNewlines(text: string): string {
  return text.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

function stripFrontmatter(text: string): string {
  const body = normalizeNewlines(text);
  if (!body.startsWith("---\n")) return body;
  const end = body.indexOf("\n---\n", 4);
  if (end === -1) return body;
  return body.slice(end + 5);
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

/** Classify fixture bytes. Not a product classifier. */
export function classifyDocumentKind(content: string): DocumentKind {
  for (const title of documentHeadings(content)) {
    if (IMPLEMENTATION_HEADINGS.has(title.toLowerCase())) return "plan";
  }
  return "requirements";
}

/** Read a file and classify its bytes. The path's basename is not a signal. */
export function classifyDocumentFile(path: string): DocumentKind {
  return classifyDocumentKind(readFileSync(path, "utf8"));
}
