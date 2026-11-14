/**
 * Finding identity for a document section heading (AT-15 / FR-07).
 *
 * Span resolution and duplicate counting match the heading title exactly, the
 * way the document wrote it. Normalization is only the identity key of a
 * uniquely resolved heading. Two sections that share a heading title cannot
 * be that section: `findIndex` / last-wins silently merge them into one
 * identity. This resolver refuses that merge. A unique heading still resolves;
 * a missing heading is missing; a repeated heading is an error that names
 * every occurrence. Heading-like lines inside fenced code are not headings.
 */

const HEADING = /^#{1,6}\s+(.*?)\s*#*\s*$/;
const FENCE_LINE = /^( {0,3})([`~]{3,})(.*)$/;

export type HeadingResolution =
  | { ok: true; heading: string; line: number; body: string; identity: string }
  | { ok: false; heading: string; reason: "missing" | "ambiguous"; lines: number[]; error: string };

/** CommonMark fence currently open: the marker character and its length. */
export type FenceState = { readonly char: "`" | "~"; readonly len: number };

/** Lowercase, strip punctuation, collapse whitespace — the identity key, not the lookup. */
export function normalizeHeading(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/** ATX heading title on this line, or null. Shared by the reference oracles. */
export function headingTitle(line: string): string | null {
  return HEADING.exec(line)?.[1] ?? null;
}

/**
 * Index of the first body line after a closed YAML frontmatter block, or 0
 * if there is none. A closing `---` at EOF counts. An opening `---` with no
 * closer is not frontmatter.
 */
export function skipFrontmatter(lines: readonly string[]): number {
  if ((lines[0] ?? "") !== "---") return 0;
  for (let i = 1; i < lines.length; i++) {
    if ((lines[i] ?? "") === "---") return i + 1;
  }
  return 0;
}

function headingLevel(line: string): number {
  return /^#+/.exec(line)?.[0].length ?? 0;
}

/**
 * A CommonMark fence line, or null. Opening and closing share the shape:
 * 0–3 spaces of indent, three or more backticks or tildes, then an info
 * string. A backtick fence whose info contains a backtick is not a fence.
 */
function parseFenceLine(line: string): { char: "`" | "~"; len: number; info: string } | null {
  const match = FENCE_LINE.exec(line);
  if (match === null) return null;
  const marker = match[2] ?? "";
  const char = marker[0];
  if (char !== "`" && char !== "~") return null;
  const rest = match[3] ?? "";
  if (char === "`" && rest.includes("`")) return null;
  return { char, len: marker.length, info: rest.trim() };
}

/**
 * Advance fence state for one line. A closer must use the same character, be
 * at least as long as the opener, and carry no info string.
 */
export function fenceAfter(line: string, fence: FenceState | null): FenceState | null {
  const parsed = parseFenceLine(line);
  if (fence === null) {
    return parsed === null ? null : { char: parsed.char, len: parsed.len };
  }
  if (parsed !== null && parsed.char === fence.char && parsed.len >= fence.len && parsed.info.length === 0) {
    return null;
  }
  return fence;
}

/** True when this line opens, continues, or closes a fenced region. */
export function inFence(line: string, fence: FenceState | null) {
  const next = fenceAfter(line, fence);
  return { skip: fence !== null || next !== null, next };
}

/** 1-based lines whose heading title equals `heading` exactly. */
export function headingOccurrences(markdown: string, heading: string): number[] {
  const lines: number[] = [];
  let fence: FenceState | null = null;
  for (const [i, raw] of markdown.split("\n").entries()) {
    const line = raw ?? "";
    const region = inFence(line, fence);
    fence = region.next;
    if (region.skip) continue;
    const title = headingTitle(line);
    if (title !== null && title === heading) lines.push(i + 1);
  }
  return lines;
}

function sectionBody(markdown: string, at: number): string {
  const lines = markdown.split("\n");
  const start = at - 1;
  const level = headingLevel(lines[start] ?? "");
  let fence: FenceState | null = null;
  const end = lines.findIndex((line, i) => {
    if (i <= start) return false;
    const region = inFence(line, fence);
    fence = region.next;
    if (region.skip) return false;
    return headingTitle(line) !== null && headingLevel(line) <= level;
  });
  return lines.slice(start + 1, end === -1 ? undefined : end).join("\n");
}

/**
 * Resolve a finding's section heading against the document it cites.
 *
 * Unique heading: identity is the normalized heading. Repeated heading:
 * refused, never first-match and never last-wins. Lookup is the exact title
 * the caller passed, compared to the document heading the ATX regex captured.
 */
export function resolveFindingSectionIdentity(markdown: string, heading: string): HeadingResolution {
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
  return { ok: true, heading, line, body: sectionBody(markdown, line), identity: normalizeHeading(heading) };
}
