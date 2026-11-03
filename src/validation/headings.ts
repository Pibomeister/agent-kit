/**
 * Finding identity for a document section heading (AT-15 / FR-07).
 *
 * Doc-review fingerprints a finding as the normalized section plus the
 * normalized title. Two sections that share a heading title cannot be that
 * section: `findIndex` / last-wins silently merge them into one identity.
 * This resolver refuses that merge. A unique heading still resolves; a
 * missing heading is missing; a repeated heading is an error that names
 * every occurrence.
 */

const HEADING = /^#{1,6}\s+(.*?)\s*#*\s*$/;

export type HeadingResolution =
  | { ok: true; heading: string; line: number; body: string; identity: string }
  | { ok: false; heading: string; reason: "missing" | "ambiguous"; lines: number[]; error: string };

/** Lowercase, strip punctuation, collapse whitespace — the donor's section key. */
export function normalizeHeading(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function headingTitle(line: string): string | null {
  return HEADING.exec(line)?.[1] ?? null;
}

function headingLevel(line: string): number {
  return /^#+/.exec(line)?.[0].length ?? 0;
}

/** 1-based lines whose heading title equals `heading`. */
export function headingOccurrences(markdown: string, heading: string): number[] {
  const wanted = normalizeHeading(heading);
  const lines: number[] = [];
  for (const [i, raw] of markdown.split("\n").entries()) {
    const title = headingTitle(raw ?? "");
    if (title !== null && normalizeHeading(title) === wanted) lines.push(i + 1);
  }
  return lines;
}

function sectionBody(markdown: string, at: number): string {
  const lines = markdown.split("\n");
  const start = at - 1;
  const level = headingLevel(lines[start] ?? "");
  const end = lines.findIndex((line, i) => i > start && headingTitle(line) !== null && headingLevel(line) <= level);
  return lines.slice(start + 1, end === -1 ? undefined : end).join("\n");
}

/**
 * Resolve a finding's section heading against the document it cites.
 *
 * Unique heading: identity is the normalized heading, optionally joined with
 * a normalized finding title. Repeated heading: refused, never first-match
 * and never last-wins.
 */
export function resolveFindingSectionIdentity(markdown: string, heading: string, title?: string): HeadingResolution {
  const lines = headingOccurrences(markdown, heading);
  if (lines.length === 0) {
    return {
      ok: false,
      heading,
      reason: "missing",
      lines,
      error: `document has no heading '${heading}'`,
    };
  }
  if (lines.length > 1) {
    return {
      ok: false,
      heading,
      reason: "ambiguous",
      lines,
      error: `heading '${heading}' appears ${lines.length} times (lines ${lines.join(", ")}); finding identity cannot resolve it uniquely`,
    };
  }
  const line = lines[0];
  if (line === undefined) {
    return {
      ok: false,
      heading,
      reason: "missing",
      lines: [],
      error: `document has no heading '${heading}'`,
    };
  }
  const identity =
    title === undefined ? normalizeHeading(heading) : `${normalizeHeading(heading)}\0${normalizeHeading(title)}`;
  return { ok: true, heading, line, body: sectionBody(markdown, line), identity };
}
