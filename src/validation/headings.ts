/**
 * Finding identity for a document section heading (AT-15 / FR-07).
 *
 * Span resolution and duplicate counting match the trimmed heading title
 * exactly. Normalization is only the identity key of a uniquely resolved
 * heading. Two sections that share a heading title cannot be that section:
 * `findIndex` / last-wins silently merge them into one identity. This
 * resolver refuses that merge. A unique heading still resolves; a missing
 * heading is missing; a repeated heading is an error that names every
 * occurrence. Heading-like lines inside fenced code (backticks or tildes)
 * are not headings.
 */

const HEADING = /^#{1,6}\s+(.*?)\s*#*\s*$/;
const FENCE_OPEN = /^\s*(`{3,}|~{3,})/;

export type HeadingResolution =
  | { ok: true; heading: string; line: number; body: string; identity: string }
  | { ok: false; heading: string; reason: "missing" | "ambiguous"; lines: number[]; error: string };

/** Lowercase, strip punctuation, collapse whitespace — the identity key, not the lookup. */
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

function fenceMarker(line: string): "`" | "~" | null {
  const ch = FENCE_OPEN.exec(line)?.[1]?.[0];
  return ch === "`" || ch === "~" ? ch : null;
}

function nextFence(line: string, fence: "`" | "~" | null): "`" | "~" | null {
  const marker = fenceMarker(line);
  if (marker === null) return fence;
  if (fence === null) return marker;
  return fence === marker ? null : fence;
}

/** 1-based lines whose trimmed heading title equals `heading` exactly. */
export function headingOccurrences(markdown: string, heading: string): number[] {
  const wanted = heading.trim();
  const lines: number[] = [];
  let fence: "`" | "~" | null = null;
  for (const [i, raw] of markdown.split("\n").entries()) {
    const line = raw ?? "";
    const marker = fenceMarker(line);
    if (marker !== null) {
      fence = nextFence(line, fence);
      continue;
    }
    if (fence !== null) continue;
    const title = headingTitle(line);
    if (title !== null && title.trim() === wanted) lines.push(i + 1);
  }
  return lines;
}

function sectionBody(markdown: string, at: number): string {
  const lines = markdown.split("\n");
  const start = at - 1;
  const level = headingLevel(lines[start] ?? "");
  let fence: "`" | "~" | null = null;
  const end = lines.findIndex((line, i) => {
    if (i <= start) return false;
    const marker = fenceMarker(line);
    if (marker !== null) {
      fence = nextFence(line, fence);
      return false;
    }
    if (fence !== null) return false;
    return headingTitle(line) !== null && headingLevel(line) <= level;
  });
  return lines.slice(start + 1, end === -1 ? undefined : end).join("\n");
}

/**
 * Resolve a finding's section heading against the document it cites.
 *
 * Unique heading: identity is the normalized heading, optionally joined with
 * a normalized finding title. Repeated heading: refused, never first-match
 * and never last-wins. Lookup is the exact trimmed title.
 */
export function resolveFindingSectionIdentity(markdown: string, heading: string, title?: string): HeadingResolution {
  const lines = headingOccurrences(markdown, heading);
  const [line, ...rest] = lines;
  if (line === undefined) {
    return {
      ok: false,
      heading,
      reason: "missing",
      lines,
      error: `document has no heading '${heading}'`,
    };
  }
  if (rest.length > 0) {
    return {
      ok: false,
      heading,
      reason: "ambiguous",
      lines,
      error: `heading '${heading}' appears ${lines.length} times (lines ${lines.join(", ")}); finding identity cannot resolve it uniquely`,
    };
  }
  const identity =
    title === undefined ? normalizeHeading(heading) : `${normalizeHeading(heading)}\0${normalizeHeading(title)}`;
  return { ok: true, heading, line, body: sectionBody(markdown, line), identity };
}
