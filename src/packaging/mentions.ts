import { posix } from "node:path";

import { relativeLinkBetween } from "../util/links.ts";

/**
 * Catalog trees whose files a skill names by their path from the repository
 * root, as inline code: `roles/implementer/ROLE.md`, `schemas/ticket.schema.json`,
 * `policies/limits.yaml`. A relative link is how a body asks the packager for a
 * file (`extractRelativeLinks`); a root path is how the same body names the
 * seat, protocol or schema its workflow depends on. The packager used to treat
 * the second as prose, so an installed skill named seats and schemas its bundle
 * did not carry and stopped `unavailable` on the first one it tried to load.
 *
 * Every tree here is a catalog section or a shared asset tree that installs.
 * `docs/`, `src/`, `tests/` and the root files are left out on purpose: a body
 * naming `docs/plans/` or `AGENTS.md` means the user's project, not this one.
 */
export const MENTION_TREES = [
  "adapters/",
  "packs/",
  "policies/",
  "protocols/",
  "references/",
  "roles/",
  "schemas/",
  "templates/",
] as const;

/**
 * A whole inline code span holding a root path, with an optional anchor. The anchor is limited to
 * the characters a heading slug or JSON pointer uses, because it is written into a link target as is:
 * a `)`, `[` or `<` there would close the link and start another.
 */
const ROOT_PATH = /^([a-z][a-z0-9-]*\/[A-Za-z0-9._/-]*[A-Za-z0-9_-])(#[A-Za-z0-9._~/$-]*)?$/;

const CODE_SPAN = /(?<!`)(`+)(?!`)([^\n]*?)(?<!`)\1(?!`)/g;

const LINK_TEXT = /\[((?:`[^`\n]*`|[^[\]`\n])*)\]\(/g;
const FENCE = /^\s*(```|~~~)/;

export interface MentionTarget {
  /** The source file the span names. */
  source: string;
  /** A fragment carried onto the link, e.g. a JSON pointer into a schema. */
  anchor?: string;
}

/**
 * What a code span in the body at `from` names: a root path under a mention tree, read first from the
 * body's own directory, a role by its catalog id, or, where the prose cites it as ``protocol `<id>` ``
 * or ``the `<id>` protocol``, a protocol by its catalog id.
 */
export type MentionResolver = (span: string, protocolCited: boolean, from: string) => MentionTarget | null;

export interface MentionSources {
  /** Whether `path` is a file in the source tree. */
  isFile(path: string): boolean;
  /** The body a catalog entry's directory holds, e.g. `roles/plan-review/planner` → its ROLE.md. */
  bodyOf(dir: string): string | null;
  /** The ROLE.md of an authored role, by catalog id. */
  roleBody(id: string): string | null;
  /** The PROTOCOL.md of an authored protocol, by catalog id. */
  protocolBody(id: string): string | null;
}

/** A span shaped as a root path under a mention tree, whatever its segments are. */
function treePath(span: string): { path: string; anchor?: string } | null {
  const m = ROOT_PATH.exec(span);
  if (m?.[1] === undefined) return null;
  if (!MENTION_TREES.some((tree) => m[1]?.startsWith(tree))) return null;
  return m[2] === undefined ? { path: m[1] } : { path: m[1], anchor: m[2].slice(1) };
}

/** A `.`, `..` or empty segment, which would let a mention leave its tree, or the repository. */
function hasTraversal(path: string): boolean {
  return path.split("/").some((segment) => segment === "" || segment === "." || segment === "..");
}

/**
 * The candidate root path inside a code span, before anything checks that it exists. A path with a
 * `.`, `..` or empty segment is never one: `roles/../../x` names no catalog file, and following it
 * would copy a file from outside the repository into the bundle.
 */
export function rootPathOf(span: string): { path: string; anchor?: string } | null {
  const root = treePath(span);
  return root === null || hasTraversal(root.path) ? null : root;
}

/** A span shaped as a mention-tree path that `rootPathOf` refuses for its segments. */
export function escapesTree(span: string): boolean {
  const root = treePath(span);
  return root !== null && hasTraversal(root.path);
}

export function mentionResolver(sources: MentionSources): MentionResolver {
  return (span, protocolCited, from) => {
    const root = rootPathOf(span);
    if (root !== null) {
      const local = posix.join(posix.dirname(from), root.path);
      const source = sources.isFile(local) ? local : sources.isFile(root.path) ? root.path : sources.bodyOf(root.path);
      if (source === null) return null;
      return root.anchor === undefined ? { source } : { source, anchor: root.anchor };
    }
    if (treePath(span) !== null) return null;
    const body = protocolCited ? sources.protocolBody(span) : sources.roleBody(span);
    return body === null ? null : { source: body };
  };
}

export interface CodeSpan {
  span: string;
  /** 1-based line. */
  line: number;
  /** Inside the text of a markdown link, e.g. [`roles/x/ROLE.md` §2](../roles/x/ROLE.md). */
  linked: boolean;
  /** Written as ``protocol `<id>` `` or ``the `<id>` protocol``, so the span is a protocol's catalog id. */
  protocolCited: boolean;
}

/**
 * Each line of `text` with whether it is prose: not inside leading frontmatter,
 * not a fence line and not inside a fenced block. Frontmatter is YAML the host
 * reads, and a fenced block shows text verbatim, so neither gets a link.
 */
function proseLines(text: string): Array<{ line: string; prose: boolean }> {
  const lines = text.split("\n");
  let frontmatter = lines[0] === "---";
  let fenced = false;
  return lines.map((line, i) => {
    if (frontmatter) {
      if (i > 0 && line === "---") frontmatter = false;
      return { line, prose: false };
    }
    if (FENCE.test(line)) {
      fenced = !fenced;
      return { line, prose: false };
    }
    return { line, prose: !fenced };
  });
}

/** Inline code spans in prose, in document order. */
export function codeSpans(text: string): CodeSpan[] {
  const out: CodeSpan[] = [];
  proseLines(text).forEach(({ line, prose }, i) => {
    if (!prose) return;
    for (const m of line.matchAll(CODE_SPAN)) {
      if (m[1] !== "`" || m[2] === undefined) continue;
      const start = m.index ?? 0;
      const end = start + m[0].length;
      out.push({
        span: m[2],
        line: i + 1,
        linked: isLinkText(line, start, end),
        protocolCited: isProtocolCited(line, start, end),
      });
    }
  });
  return out;
}

/**
 * Whether the span at `start`..`end` sits inside a link's text. Code span contents are blanked
 * first, so a `[` or `](` written inside one span cannot pair with another and pass the prose
 * between them off as link text.
 */
function isLinkText(line: string, start: number, end: number): boolean {
  const masked = maskCodeSpans(line);
  for (const m of masked.matchAll(LINK_TEXT)) {
    const open = (m.index ?? 0) + 1;
    if (start >= open && end <= open + (m[1] ?? "").length) return true;
  }
  return false;
}

/**
 * `line` with every code span's contents blanked, keeping its backticks and length. A span opens on
 * a backtick run and closes on the next run of the same length, as CommonMark reads it, so a
 * ``` ``[`` ``` span is masked as well as a single-backtick one.
 */
function maskCodeSpans(line: string): string {
  return line.replace(
    CODE_SPAN,
    (_whole: string, ticks: string, span: string) => `${ticks}${"_".repeat(span.length)}${ticks}`,
  );
}

function isProtocolCited(line: string, start: number, end: number): boolean {
  return /(?:^|[^A-Za-z-])protocol $/.test(line.slice(0, start)) || /^ protocol(?![A-Za-z-])/.test(line.slice(end));
}

export interface LinkedText {
  text: string;
  /** Source paths the bundle must copy for the links to resolve. */
  dependencies: string[];
}

/**
 * Turn each code span that names a bundleable file into a link to where the
 * bundle carries it, keeping the span as the link text so the body reads as
 * it was written. Returns the rewritten text and the source paths to copy.
 *
 * `publishedFor` maps a source path to its path in the bundle, or null when the
 * bundle never installs it; such a span is left as written.
 */
export function linkMentions(
  sourcePath: string,
  publishedPath: string,
  text: string,
  resolve: MentionResolver,
  publishedFor: (source: string) => string | null,
): LinkedText {
  const dependencies: string[] = [];
  const lines = proseLines(text).map(({ line, prose }) => {
    if (!prose) return line;
    return line.replace(CODE_SPAN, (whole: string, ticks: string, span: string, offset: number) => {
      if (ticks !== "`") return whole;
      const end = offset + whole.length;
      if (isLinkText(line, offset, end)) return whole;
      const target = resolve(span, isProtocolCited(line, offset, end), sourcePath);
      if (target === null) return whole;
      const published = publishedFor(target.source);
      if (published === null) return whole;
      dependencies.push(target.source);
      const href = relativeLinkBetween(publishedPath, published);
      return `[${whole}](${href}${target.anchor === undefined ? "" : `#${target.anchor}`})`;
    });
  });
  return { text: lines.join("\n"), dependencies };
}

/**
 * Schema files a JSON Schema reaches through a relative `$ref`, beside it or below it. A `$ref` that
 * climbs out of the schema's directory is not followed, so a schema cannot pull an arbitrary file
 * into the bundle.
 */
export function schemaRefs(source: string, text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/"\$ref"\s*:\s*"([^"#]+)/g)) {
    const ref = m[1];
    if (ref === undefined || /^[a-z]+:/i.test(ref) || ref.startsWith("/") || hasTraversal(ref)) continue;
    out.add(posix.join(posix.dirname(source), ref));
  }
  return [...out];
}
