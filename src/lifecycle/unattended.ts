/**
 * The unattended lifecycle policy (docs/decisions/0014-unattended-lifecycle-policy.md and its amendment of
 * 2026-11-11): selection, and the declared run supervisor ship rests on.
 *
 * A runner opts in through `AK_LIFECYCLE_POLICY=unattended` or `ak.lifecycle.json` on the default branch.
 * Phases then start with no typed command or grant, and the trust boundary is a supervisor that declares, in
 * a file outside the checkout, how it meets six obligations. This module holds the policy resolution, the
 * disclosure sentence and the shape rules of the two supervisor files: the declaration the run is stamped
 * with and the attestation final ship takes. It reads no forge and spawns nothing but local git. The gate
 * (`gate.ts`) holds containment, readability, head ancestry and the ship sequence.
 *
 * Bundled into `bin/ak-gate.mjs` with `gate.ts`, so it imports only `node:` built-ins.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

export const POLICY_ENV = "AK_LIFECYCLE_POLICY";
export const SUPERVISOR_ENV = "AK_LIFECYCLE_SUPERVISOR";
export const DECLARATION_ENV = "AK_LIFECYCLE_SUPERVISOR_DECLARATION";
export const CONFIG_FILE = "ak.lifecycle.json";
export const UNATTENDED = "unattended";
/** The version of the supervisor contract both files name (adapters/supervisor/CONTRACT.md). */
export const CONTRACT = "agent-kit/supervisor-contract@1";
export const OBLIGATIONS = [
  "launch-and-watch",
  "validation-gate",
  "independent-review",
  "seat-separation",
  "head-bound-evidence",
  "disclosure",
] as const;
export type Obligation = (typeof OBLIGATIONS)[number];
export const HUMAN_STARTED_PHASES = ["super-align", "super-bound", "super-ship"] as const;
export const MODEL_STARTED_PHASES = ["super-scout", "super-build", "super-verify", "super-review"] as const;

const hasControlChar = (text: string): boolean => {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
};

/** The sentence a pull request carries when the supervisor stands in place of a human. */
export function unattendedDisclosure(supervisor: string): string {
  return `Unattended lifecycle policy (supervisor: ${supervisor}, in place of a human): no human approved the align or bound artifacts, phase evidence is worker-attested and kept in the runner's evidence store, the supervisor attests its validation gate and independent review at the head, which agent-kit checks but cannot authenticate, and agent-kit does not merge: whoever the human authorized merges.`;
}

export interface Policy {
  name: typeof UNATTENDED;
  /** `environment`, or `default-branch:<revision>` the configuration was read at. */
  source: string;
  /** `AK_LIFECYCLE_SUPERVISOR`, when set: the supervisor recorded in place of a human. */
  supervisor?: string;
}

/** A parsed JSON value. */
export type Json = null | boolean | number | string | Json[] | JsonObject;
export interface JsonObject {
  [key: string]: Json;
}

const kind = (v: Json | undefined) => Object.prototype.toString.call(v);
const isText = (v: Json | undefined): v is string => kind(v) === "[object String]";
const isObject = (v: Json | undefined): v is JsonObject => kind(v) === "[object Object]";
/** JSON.parse yields only JSON values; this names that for the type system, one level deep. */
const JSON_KINDS = new Set(["Null", "Boolean", "Number", "String", "Array", "Object"].map((k) => `[object ${k}]`));
const isJson = (value: unknown): value is Json => JSON_KINDS.has(Object.prototype.toString.call(value));
const field = (v: Json | undefined, key: string): Json | undefined => (isObject(v) ? v[key] : undefined);
export const parseJson = (source: string): Json | undefined => {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    return undefined;
  }
  return isJson(value) ? value : undefined;
};

/** `sha256:` and 64 lower-case hex digits over the bytes. */
export const sha256Digest = (bytes: Uint8Array | string): string =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

const exec = (cmd: string, args: readonly string[], cwd?: string) => {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status ?? 1, out: r.stdout ?? "" };
};

/**
 * The active policy: the environment first, else the default-branch configuration at the local
 * `refs/remotes/origin/HEAD`, never the working tree or the task branch. Undefined is the legacy policy.
 * Only the configuration's `policy` key is read; any other key is ignored. `gitOptions` go before each git
 * subcommand: final ship passes its guard there, and a read that fails under it is the legacy policy.
 */
export function resolvePolicy(
  project: string,
  env: NodeJS.ProcessEnv = process.env,
  gitOptions: readonly string[] = [],
): { ok: true; policy?: Policy } | { ok: false; reason: string } {
  const rawSupervisor = env[SUPERVISOR_ENV]?.trim();
  const supervisor = rawSupervisor !== undefined && rawSupervisor !== "" ? rawSupervisor : undefined;
  if (supervisor !== undefined && hasControlChar(supervisor))
    return { ok: false, reason: `${SUPERVISOR_ENV} must not contain control characters` };
  const stamp = (source: string): Policy =>
    supervisor === undefined ? { name: UNATTENDED, source } : { name: UNATTENDED, source, supervisor };
  const value = env[POLICY_ENV];
  if (value !== undefined && value !== "") {
    if (value !== UNATTENDED)
      return { ok: false, reason: `${POLICY_ENV} accepts only '${UNATTENDED}', not '${value}'` };
    return { ok: true, policy: stamp("environment") };
  }
  const rev = exec(
    "git",
    [...gitOptions, "rev-parse", "--verify", "--quiet", "refs/remotes/origin/HEAD^{commit}"],
    project,
  );
  const revision = rev.out.trim();
  if (rev.code !== 0 || revision === "") return { ok: true };
  const file = exec("git", [...gitOptions, "show", `${revision}:${CONFIG_FILE}`], project);
  if (file.code !== 0 || field(parseJson(file.out), "policy") !== UNATTENDED) return { ok: true };
  return { ok: true, policy: stamp(`default-branch:${revision}`) };
}

// ── the two supervisor files ─────────────────────────────────────────────────

/** A non-empty string on one line. The schemas carry the same pattern. */
const SINGLE_LINE = /^[^\r\n\u2028\u2029]*\S[^\r\n\u2028\u2029]*$/;
/** One provider segment, a slash, a remainder; no whitespace and no upper-case letter. The attestation schema carries the same pattern. */
const IDENTITY = new RegExp("^[^\\s/\\p{Lu}\\p{Lt}]+/[^\\s\\p{Lu}\\p{Lt}]+$", "u");
const HEAD = /^[0-9a-f]{40}$/;

const singleLine = (v: Json | undefined): v is string => isText(v) && SINGLE_LINE.test(v);
const shown = (v: Json | undefined): string => JSON.stringify(v) ?? "undefined";

/** Lower-case, no surrounding whitespace, one provider segment, a slash and a remainder with no whitespace. */
export function isCanonicalIdentity(id: string): boolean {
  return IDENTITY.test(id);
}

export interface Declaration {
  contract: string;
  supervisor: string;
  obligations: Record<Obligation, string>;
}

const unknownKeys = (where: string, value: JsonObject, allowed: readonly string[]): string[] =>
  Object.keys(value)
    .filter((key) => !allowed.includes(key))
    .map((key) => `${where} has unknown key ${JSON.stringify(key)}`);

/** The shape of a declaration and its name equality; an empty list means valid. Each message names the failed key. */
export function declarationFailures(value: Json | undefined, supervisor: string): string[] {
  if (!isObject(value)) return ["declaration must be a JSON object"];
  const failures = unknownKeys("declaration", value, ["contract", "supervisor", "obligations"]);
  if (value.contract !== CONTRACT)
    failures.push(`contract must be ${JSON.stringify(CONTRACT)}, not ${shown(value.contract)}`);
  const named = value.supervisor;
  if (!isText(named) || named === "" || named !== named.trim() || hasControlChar(named))
    failures.push("supervisor must be a non-empty string with no control character and no surrounding whitespace");
  else if (named !== supervisor)
    failures.push(
      `supervisor ${JSON.stringify(named)} differs from the supervisor named by ${SUPERVISOR_ENV} (${JSON.stringify(supervisor)})`,
    );
  const obligations = value.obligations;
  if (!isObject(obligations)) failures.push("obligations must be a JSON object");
  else {
    failures.push(...unknownKeys("obligations", obligations, OBLIGATIONS));
    for (const key of OBLIGATIONS) {
      if (!(key in obligations)) failures.push(`obligations.${key} is missing`);
      else if (!singleLine(obligations[key]))
        failures.push(`obligations.${key} must be a non-empty single-line string`);
    }
  }
  return failures;
}

export interface Attestation {
  contract: string;
  supervisor: string;
  head: string;
  pull_request?: string;
  validation: { result: "pass"; ref: string };
  review: { result: "approve"; reviewer: string; authors: string[]; ref: string };
}

const identityFailure = (where: string, id: Json | undefined): string[] =>
  isText(id) && isCanonicalIdentity(id)
    ? []
    : [`${where} ${shown(id)} is not a canonical provider/model identity (lower-case, no whitespace, provider/model)`];

/**
 * One walk over an attestation: the shape and the supervisor equality, with keys closed at every level, and the typed
 * attestation built from the same values. Each value is copied only once it passes its check.
 */
export function readAttestation(
  value: Json | undefined,
  supervisor: string,
): { ok: true; attestation: Attestation } | { ok: false; failures: string[] } {
  if (!isObject(value)) return { ok: false, failures: ["attestation must be a JSON object"] };
  const failures = unknownKeys("attestation", value, [
    "contract",
    "supervisor",
    "head",
    "pull_request",
    "validation",
    "review",
  ]);
  if (value.contract !== CONTRACT)
    failures.push(`contract must be ${JSON.stringify(CONTRACT)}, not ${shown(value.contract)}`);
  if (value.supervisor !== supervisor)
    failures.push(
      `supervisor ${shown(value.supervisor)} differs from the run's supervisor ${JSON.stringify(supervisor)}`,
    );
  let head = "";
  if (isText(value.head) && HEAD.test(value.head)) head = value.head;
  else failures.push("head must be 40 lower-case hex characters");
  let pullRequest: string | undefined;
  if ("pull_request" in value) {
    if (singleLine(value.pull_request)) pullRequest = value.pull_request;
    else failures.push("pull_request must be a non-empty single-line string");
  }
  let validationRef = "";
  const validation = value.validation;
  if (!isObject(validation)) failures.push("validation must be a JSON object");
  else {
    failures.push(...unknownKeys("validation", validation, ["result", "ref"]));
    if (validation.result !== "pass")
      failures.push(`validation.result must be "pass", not ${shown(validation.result)}`);
    if (singleLine(validation.ref)) validationRef = validation.ref;
    else failures.push("validation.ref must be a non-empty single-line string");
  }
  let reviewer = "";
  let reviewRef = "";
  const authors: string[] = [];
  const review = value.review;
  if (!isObject(review)) failures.push("review must be a JSON object");
  else {
    failures.push(...unknownKeys("review", review, ["result", "reviewer", "authors", "ref"]));
    if (review.result !== "approve") failures.push(`review.result must be "approve", not ${shown(review.result)}`);
    failures.push(...identityFailure("review.reviewer", review.reviewer));
    if (isText(review.reviewer)) reviewer = review.reviewer;
    if (!Array.isArray(review.authors) || review.authors.length === 0)
      failures.push("review.authors must be a non-empty list of identities");
    else
      review.authors.forEach((author, i) => {
        failures.push(...identityFailure(`review.authors[${i}]`, author));
        if (isText(author)) authors.push(author);
      });
    if (singleLine(review.ref)) reviewRef = review.ref;
    else failures.push("review.ref must be a non-empty single-line string");
  }
  if (failures.length > 0) return { ok: false, failures };
  const attestation: Attestation = {
    contract: CONTRACT,
    supervisor,
    head,
    validation: { result: "pass", ref: validationRef },
    review: { result: "approve", reviewer, authors, ref: reviewRef },
  };
  if (pullRequest !== undefined) attestation.pull_request = pullRequest;
  return { ok: true, attestation };
}

/** The shape of an attestation and its supervisor equality; keys are closed at every level. Empty means valid. */
export function attestationFailures(value: Json | undefined, supervisor: string): string[] {
  const read = readAttestation(value, supervisor);
  return read.ok ? [] : read.failures;
}

/** A fence line from its first non-blank character: the fence characters, then the info string, which may hold a line separator. */
const FENCE = /^(`{3,}|~{3,})(.*)$/s;
/** A list marker, bullet or number, followed by a space, a tab or the end of the line. */
const ITEM = /^(?:[-*+]|(\d{1,9})[.)])(?=[ \t]|$)/;
/** A thematic break, which a line of three list markers is rather than a list item. */
const THEMATIC = /^([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const BLANK = /^[ \t]*$/;
/** An ATX heading, and the underline that makes the paragraph above it a setext heading. */
const HEADING = /^#{1,6}(?:[ \t]|$)/;
const SETEXT = /^=+[ \t]*$/;

/** A container that later lines continue: a block quote, or a list item whose content starts `width` columns in. */
type Container = { quote: true } | { quote: false; width: number };

/** A place in a line: its index, its column, and the column where the innermost matched container's content starts. */
interface Cursor {
  at: number;
  column: number;
  base: number;
}

/** The cursor past the spaces and tabs at `from`; a tab moves to the next multiple of four columns. */
function skipBlank(line: string, from: Cursor): Cursor {
  let { at, column } = from;
  for (; line[at] === " " || line[at] === "\t"; at += 1)
    column = line[at] === "\t" ? column + 4 - (column % 4) : column + 1;
  return { at, column, base: from.base };
}

/** The cursor past a block-quote marker at `from`, 0 to 3 columns in, and the one space after it. */
function quoteMarker(line: string, from: Cursor): Cursor | undefined {
  const blank = skipBlank(line, from);
  if (blank.column - from.base > 3 || line[blank.at] !== ">") return undefined;
  const at = blank.at + 1;
  const column = blank.column + 1;
  if (line[at] === " ") return { at: at + 1, column: column + 1, base: column + 1 };
  return { at, column, base: line[at] === "\t" ? column + 1 : column };
}

/** The cursor past `container` when the line continues it: a quote marker, or a blank line or the item's indent. */
function continues(line: string, from: Cursor, container: Container): Cursor | undefined {
  if (container.quote) return quoteMarker(line, from);
  const base = from.base + container.width;
  if (BLANK.test(line.slice(from.at))) return { ...from, base };
  if (skipBlank(line, from).column < base) return undefined;
  let { at, column } = from;
  for (; column < base; at += 1) column = line[at] === "\t" ? column + 4 - (column % 4) : column + 1;
  return { at, column, base };
}

/**
 * A container that starts at `from`, 0 to 3 columns in, and the cursor past its marker. Inside a paragraph a list
 * item starts only with content and, numbered, only at 1, as in CommonMark.
 */
function opens(line: string, from: Cursor, paragraph: boolean): { container: Container; cursor: Cursor } | undefined {
  const quote = quoteMarker(line, from);
  if (quote !== undefined) return { container: { quote: true }, cursor: quote };
  const blank = skipBlank(line, from);
  const rest = line.slice(blank.at);
  const marker = ITEM.exec(rest);
  if (blank.column - from.base > 3 || marker === null || THEMATIC.test(rest)) return undefined;
  const end = { at: blank.at + marker[0].length, column: blank.column + marker[0].length, base: from.base };
  const after = skipBlank(line, end);
  const empty = after.at === line.length;
  if (paragraph && (empty || (marker[1] !== undefined && Number(marker[1]) !== 1))) return undefined;
  if (!empty && after.column - end.column <= 4)
    return { container: { quote: false, width: after.column - from.base }, cursor: { ...after, base: after.column } };
  const cursor = line[end.at] === " " ? { at: end.at + 1, column: end.column + 1 } : end;
  return {
    container: { quote: false, width: end.column + 1 - from.base },
    cursor: { ...cursor, base: end.column + 1 },
  };
}

/** The fence that a line opens at `from`, 0 to 3 columns in; a backtick fence has no backtick in its info string. */
function fenceOpener(line: string, from: Cursor): { char: string; length: number } | undefined {
  const blank = skipBlank(line, from);
  const fence = FENCE.exec(line.slice(blank.at));
  const marks = fence?.[1] ?? "";
  if (blank.column - from.base > 3 || marks === "" || (marks[0] === "`" && (fence?.[2] ?? "").includes("`")))
    return undefined;
  return { char: marks[0] ?? "", length: marks.length };
}

/**
 * Whether a line that a paragraph could take starts a block instead, which ends the paragraph, or `SPLIT` where the
 * readings part on an HTML block start there. `inside` is whether the line continues every container the paragraph
 * sits in; a lazy line is checked outside it, as in CommonMark, so a type 7 HTML block may start there.
 */
function startsBlock(line: string, from: Cursor, inside: boolean): boolean | typeof SPLIT {
  const blank = skipBlank(line, from);
  const rest = line.slice(blank.at);
  if (BLANK.test(rest) || opens(line, from, inside) !== undefined || fenceOpener(line, from) !== undefined) return true;
  if (blank.column - from.base > 3) return false;
  const html = htmlStart(rest, inside);
  return html === SPLIT ? SPLIT : html !== undefined || THEMATIC.test(rest) || HEADING.test(rest);
}

/** The tag names of a type 6 HTML block in both readings; `PARTED_TAGS` holds the names the readings part on. */
const BLOCK_TAGS = new Set(
  "address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem nav noframes ol optgroup option p param section summary table tbody td tfoot th thead title tr track ul".split(
    " ",
  ),
);
/** `source` is a type 6 name only in 0.29, `search` only in 0.31, and `textarea` a type 1 name only in 0.31. */
const PARTED_TAGS = new Set(["source", "search", "textarea"]);
/** The type 1 names. Their block ends at a line that holds an end tag of any of them; 0.31 also ends it at `</textarea>`. */
const RAW_TAGS = new Set(["pre", "script", "style"]);
const RAW_END = /<\/(?:pre|script|style)>/i;
const TEXTAREA_END = /<\/textarea>/i;
const TAG_NAME = /^<\/?([A-Za-z\u212a][A-Za-z0-9-]*)/;
const CLOSE_TAG = /<\/[A-Za-z][A-Za-z0-9-]*[ \t]*>/y;

/**
 * An HTML block. A line that `end` matches ends it: `RAW_END` for type 1 and the end marker for types 2 to 5. With no
 * `end` it is type 6 or 7 and ends before a blank line. `marker` is the length of the marker that opens it, and only
 * a type 2 block, which opens with a comment, shows the text past that comment.
 */
interface HtmlBlock {
  end: RegExp | undefined;
  marker: number;
  comment: boolean;
}

/**
 * The HTML block that `rest` opens, read from the line's first non-blank character 0 to 3 columns in, by the seven
 * CommonMark start conditions. With `paragraph` a paragraph would take the line, which type 7 cannot interrupt.
 * `SPLIT` where the readings part on the start: a declaration whose letter is lower case, a `PARTED_TAGS` name, a
 * control character other than a tab on a line that starts with a tag name (0.29 reads a vertical tab or a form feed
 * as a space in a tag), a Kelvin sign on such a line or after `<!` (pandoc lower-cases it to `k`), and a lone tag
 * named `pre`, `script` or `style`, which the spec leaves to a paragraph and pandoc reads as a type 7 block.
 */
function htmlStart(rest: string, paragraph: boolean): HtmlBlock | typeof SPLIT | undefined {
  if (rest.startsWith("<!--")) return { end: /-->/, marker: 4, comment: true };
  if (rest.startsWith("<?")) return { end: /\?>/, marker: 2, comment: false };
  if (rest.startsWith("<![CDATA[")) return { end: /\]\]>/, marker: 9, comment: false };
  if (/^<![A-Z]/.test(rest)) return { end: />/, marker: 2, comment: false };
  if (/^<![a-z\u212a]/.test(rest)) return SPLIT;
  const name = TAG_NAME.exec(rest);
  if (name === null) return undefined;
  const tag = (name[1] ?? "").toLowerCase();
  const after = rest.slice(name[0].length);
  if (PARTED_TAGS.has(tag) || rest.includes("\u212a") || hasControlChar(rest.replaceAll("\t", ""))) return SPLIT;
  const closing = rest[1] === "/";
  if (!closing && RAW_TAGS.has(tag) && /^(?:[ \t>]|$)/.test(after))
    return { end: RAW_END, marker: name[0].length, comment: false };
  if (BLOCK_TAGS.has(tag) && /^(?:[ \t>]|\/>|$)/.test(after)) return { end: undefined, marker: 0, comment: false };
  if (paragraph) return undefined;
  const tagEnd = matchAt(closing ? CLOSE_TAG : OPEN_TAG, rest, 0);
  if (tagEnd === NONE || !BLANK.test(rest.slice(tagEnd))) return undefined;
  return RAW_TAGS.has(tag) ? SPLIT : { end: undefined, marker: 0, comment: false };
}

/** Whether `text` holds what ends `block`, or `SPLIT` at a `</textarea>` that only 0.31 ends a type 1 block at. */
function blockEnds(block: HtmlBlock, text: string): boolean | typeof SPLIT {
  if (block.end === undefined) return BLANK.test(text);
  if (block.end.test(text)) return true;
  return block.end === RAW_END && TEXTAREA_END.test(text) ? SPLIT : false;
}

/** What a line reads while it is scanned: a comment the current block opened, and one the page is still inside. */
interface CommentState {
  comment: boolean;
  raw: boolean;
}

/**
 * The text of one block outside any fence that a browser shows. `state.comment` is a comment that this block
 * opened, which ends at `-->`. `state.raw` is a comment that an earlier HTML block left open in the rendered page:
 * the page hides everything until a later HTML block line carries `-->`. Renderers differ on which inline text
 * reaches the page as raw HTML, so no paragraph ends it. An HTML block line is read by `hideComments`; a paragraph or
 * heading by `inlineText`.
 */
function visibleText(text: string, state: CommentState, html = false): string {
  if (html) return hideComments(text, state, "");
  return state.raw ? "" : inlineText(text, state);
}

/**
 * `text` with every comment hidden and `gap` in place of each: an opener hides to the next `-->`, or to the end with
 * `state.comment` left set, and `<!-->` and `<!--->` hide themselves. No backtick opens a code span. Every comment of
 * both CommonMark readings falls inside one that this hides, so with a line break for `gap` it shows no sentence that
 * a renderer hides in a comment.
 */
function hideComments(text: string, state: CommentState, gap: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    if (state.comment || state.raw) {
      const end = text.indexOf("-->", i);
      if (end < 0) return out;
      state.comment = false;
      state.raw = false;
      out += gap;
      i = end + 3;
    } else if (text.startsWith("<!-->", i) || text.startsWith("<!--->", i)) {
      out += gap;
      i += text.startsWith("<!-->", i) ? 5 : 6;
    } else if (text.startsWith("<!--", i)) {
      state.comment = true;
      i += 4;
    } else {
      out += text[i];
      i += 1;
    }
  }
  return out;
}

/** ASCII punctuation, which a backslash escapes. */
const PUNCTUATION = "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~";
/**
 * Spaces or tabs with at most one line ending, as a tag allows them; `SPACE` takes at least one. Each splits a run
 * of blanks one way only, so a tag that does not close fails in time linear in its length.
 */
const GAP = String.raw`[ \t]*(?:\n[ \t]*)?`;
const SPACE = String.raw`(?=[ \t\n])${GAP}`;
const ATTRIBUTE = String.raw`${SPACE}[A-Za-z_:][\w.:-]*(?:${GAP}=${GAP}(?:[^ \t\n"'=<>\x60]+|'[^']*'|"[^"]*"))?`;
const OPEN_TAG = new RegExp(String.raw`<[A-Za-z][A-Za-z0-9-]*(?:${ATTRIBUTE})*${GAP}\/?>`, "y");
const URI_AUTOLINK = /<[A-Za-z][A-Za-z0-9+.-]{1,31}:[^ \t\n<>]*>/y;
const EMAIL_AUTOLINK =
  /<[\w.!#$%&'*+/=?^`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*>/y;
/** A declaration both readings take; the 0.31 reading also takes a lower-case one or one with no space after it. */
const DECLARATION = /<![A-Z]+[ \t\n][^>]*>/y;
const LOOSE_DECLARATION = /<![A-Za-z][^>]*>/y;
/** No construct starts here. */
const NONE = -1;
/** The renderers part on the construct here, or the check does not model what it takes. */
const SPLIT = -2;
/** A comment opener with no `-->` after it: no renderer reads a comment, and the check hides the rest. */
const OPEN = -3;

/** The end of the match of sticky `pattern` at `at`, or `NONE`. */
function matchAt(pattern: RegExp, text: string, at: number): number {
  pattern.lastIndex = at;
  return pattern.test(text) ? pattern.lastIndex : NONE;
}

/** The end of the backtick run at `at`, or of the code span it opens when a later run of the same length closes it. */
function codeSpanEnd(text: string, at: number): number {
  let run = 1;
  while (text[at + run] === "`") run += 1;
  for (let next = text.indexOf("`", at + run); next >= 0;) {
    let length = 1;
    while (text[next + length] === "`") length += 1;
    if (length === run) return next + run;
    next = text.indexOf("`", next + length);
  }
  return at + run;
}

/**
 * The end of the comment or other raw HTML at `at`, `NONE` when `<` is text, `OPEN` or `SPLIT`. A closing tag holds
 * no backtick and no comment, so it is read as text. The two CommonMark readings in use, 0.29 in cmark-gfm and 0.31
 * in pandoc, part on a comment that holds `--` or ends in `-`, a processing instruction that ends in `?`, a CDATA
 * section that holds `]`, and a declaration that is lower case or has no space after its name. Only 0.31 reads
 * `<!-->` and `<!--->` as comments, but both readings go on after them alike.
 */
function rawHtmlEnd(text: string, at: number): number {
  if (text.startsWith("<!--", at)) {
    if (text.startsWith("<!-->", at) || text.startsWith("<!--->", at)) return at + (text[at + 4] === ">" ? 5 : 6);
    const close = text.indexOf("-->", at + 4);
    if (close < 0) return OPEN;
    const inner = text.slice(at + 4, close);
    return inner.includes("--") || inner.endsWith("-") ? SPLIT : close + 3;
  }
  if (text.startsWith("<?", at)) {
    const close = text.indexOf("?>", at + 2);
    if (close < 0) return NONE;
    return text[close - 1] === "?" && close > at + 2 ? SPLIT : close + 2;
  }
  if (text.startsWith("<![CDATA[", at)) {
    const close = text.indexOf("]]>", at + 9);
    if (close < 0) return NONE;
    return text.slice(at + 9, close).includes("]") ? SPLIT : close + 3;
  }
  if (text.startsWith("<!", at)) {
    const end = matchAt(DECLARATION, text, at);
    if (end !== NONE) return end;
    return matchAt(LOOSE_DECLARATION, text, at) === NONE ? NONE : SPLIT;
  }
  return matchAt(OPEN_TAG, text, at);
}

/** The index past spaces and tabs with at most one line ending, from `at`. */
function skipLinkSpace(text: string, at: number): number {
  let i = at;
  while (text[i] === " " || text[i] === "\t") i += 1;
  if (text[i] === "\n") i += 1;
  while (text[i] === " " || text[i] === "\t") i += 1;
  return i;
}

/** The end of the destination at `at`, `NONE` when it is not one, or `SPLIT` where cmark and the spec part. */
function destinationEnd(text: string, at: number): number {
  let i = at;
  if (text[i] === "<") {
    for (i += 1; i < text.length; i += 1) {
      const char = text[i];
      if (char === ">") return i + 1;
      if (char === "\n" || char === "<") return NONE;
      if (char === "\\" && text[i + 1] === "\n") return SPLIT;
      if (char === "\\" && PUNCTUATION.includes(text[i + 1] ?? " ")) i += 1;
    }
    return NONE;
  }
  let depth = 0;
  for (; i < text.length && text[i] !== " " && text[i] !== "\t" && text[i] !== "\n"; i += 1) {
    const char = text[i];
    if (char === "\\" && PUNCTUATION.includes(text[i + 1] ?? " ")) i += 1;
    else if (char === "(") depth += 1;
    else if (char === ")" && depth === 0) break;
    else if (char === ")") depth -= 1;
    if (depth > 32) return SPLIT;
  }
  return depth === 0 ? i : NONE;
}

/** The end of the title at `at`, or `NONE`: a `"`, `'` or parenthesised string whose closer is not escaped. */
function titleEnd(text: string, at: number): number {
  const open = text[at];
  const close = open === "(" ? ")" : open;
  if (open !== '"' && open !== "'" && open !== "(") return NONE;
  for (let i = at + 1; i < text.length; i += 1) {
    const char = text[i];
    if (char === close) return i + 1;
    if (char === "(" && close === ")") return NONE;
    if (char === "\\" && PUNCTUATION.includes(text[i + 1] ?? " ")) i += 1;
  }
  return NONE;
}

/**
 * The end of an inline link's `(destination "title")` at `at`, `NONE` when there is none, or `SPLIT`. A title right
 * after an angle-bracket destination, with no space between, is `SPLIT`: cmark-gfm and the spec form no link there,
 * and pandoc forms one.
 */
function linkTailEnd(text: string, at: number): number {
  if (text[at] !== "(") return NONE;
  const start = skipLinkSpace(text, at + 1);
  const destination = destinationEnd(text, start);
  if (destination < 0) return destination;
  let i = skipLinkSpace(text, destination);
  if (i === destination && `"'(`.includes(text[i] ?? " ")) return SPLIT;
  if (i > destination && text[i] !== ")") {
    const title = titleEnd(text, i);
    if (title === NONE) return NONE;
    i = skipLinkSpace(text, title);
  }
  return text[i] === ")" ? i + 1 : NONE;
}

/**
 * The text of a paragraph or heading that a browser shows, read left to right as CommonMark reads inline content: a
 * backslash escape, raw HTML, an autolink and an inline link's destination and title take their backticks before a
 * code span can open. A comment hides; a tag and a link's destination and title leave a line break, so no sentence
 * spans them; the rest is shown as written. From a construct that the readings part on or that this does not model,
 * the rest is read by `hideComments` with a line break for each comment. Those are a control character other than a
 * tab, a `$` (math in pandoc and on GitHub), a footnote `[^`, a bare `://` or `www.` (an extended autolink), a
 * reference link `][`, a bracket that a defined reference would turn into a link inside a link, and a link
 * definition at the start of a paragraph.
 */
function inlineText(text: string, state: CommentState): string {
  const controls = hasControlChar(text.replaceAll("\t", "").replaceAll("\n", ""));
  if (controls || (text.startsWith("[") && text.includes("]:"))) return hideComments(text, state, "\n");
  const openers: { image: boolean; active: boolean }[] = [];
  let out = "";
  let i = 0;
  const rest = () => out + hideComments(text.slice(i), state, "\n");
  while (i < text.length) {
    const char = text[i] ?? "";
    let end = i + 1;
    if (char === "\\" && PUNCTUATION.includes(text[i + 1] ?? " ")) end = i + 2;
    else if (char === "`") end = codeSpanEnd(text, i);
    else if (char === "$" || text.startsWith("://", i) || text.slice(i, i + 4).toLowerCase() === "www.") return rest();
    else if (char === "<") {
      const link = Math.max(matchAt(URI_AUTOLINK, text, i), matchAt(EMAIL_AUTOLINK, text, i));
      const html = link === NONE ? rawHtmlEnd(text, i) : NONE;
      if (html === SPLIT) return rest();
      if (html === OPEN) {
        state.comment = true;
        return out;
      }
      if (html !== NONE) {
        // A comment that both readings take hides; `<!-->`, `<!--->` and other raw HTML leave a line break.
        out += text.startsWith("<!--", i) && html > i + 6 ? "" : "\n";
        i = html;
        continue;
      }
      if (link !== NONE) end = link;
    } else if (char === "[" || text.startsWith("![", i)) {
      const image = char === "!";
      if (text[image ? i + 2 : i + 1] === "^") return rest();
      openers.push({ image, active: true });
      end = image ? i + 2 : i + 1;
    } else if (char === "]") {
      const opener = openers.pop();
      const tail = opener?.active === true ? linkTailEnd(text, i + 1) : NONE;
      if (tail === SPLIT) return rest();
      if (opener?.active === true && tail === NONE) {
        const nested = !opener.image && openers.some((o) => !o.image && o.active);
        if (text[i + 1] === "[" || nested) return rest();
      }
      if (opener !== undefined && tail !== NONE) {
        if (!opener.image) for (const o of openers) if (!o.image) o.active = false;
        out += "]\n";
        i = tail;
        continue;
      }
    }
    out += text.slice(i, end);
    i = end;
  }
  return out;
}

/**
 * Whether the body carries the disclosure sentence for `supervisor`: an exact substring test with no whitespace
 * normalisation over the text a CommonMark renderer shows outside code blocks, HTML comments and HTML blocks that
 * open with anything other than a comment. The check follows the block structure that decides where those start and
 * end. A leading byte order mark is dropped and a CRLF is one line ending. Block quotes and list items are
 * containers: a later line continues a quote with its marker and a list item with a blank line or the item's indent,
 * and a paragraph also takes a lazy line. A fence opens and closes only 0 to 3 columns past its container's markers;
 * a line four columns past them is indented code, which hides as a fence does. A backtick fence line has no backtick
 * in its info string. A fence ends at its closer or at the first line that does not continue its container, and that
 * line is read as ordinary text. Inside a fence no marker is stripped, and a comment opener starts nothing. A line 0
 * to 3 columns past the markers opens an HTML block by any of the seven CommonMark start conditions, save that a lone
 * tag (type 7) does not interrupt a paragraph. A block of types 1 to 5 ends at the line that holds its end marker, one
 * of type 6 or 7 before a blank line, and any block where its container ends. Its lines are read raw: no code span
 * forms, every comment opener hides, and only a block that opens with a comment shows text, past that comment. A
 * comment that an HTML block leaves open hides the rest of the page until a later HTML block line carries `-->`. A
 * paragraph is read whole and left to right, as CommonMark reads inline content, so a code span or a comment may
 * cross its lines. A backslash escape, raw HTML, an autolink and an inline link's destination and title take their
 * backticks before a code span opens; a comment opener inside a code span starts nothing, and one outside hides text
 * to its closer or to the end of the paragraph. Raw HTML and a link's destination and title count as not shown. From
 * a construct that the readings part on or that the check does not model, such as a `$`, an extended autolink or a
 * link definition, the rest of the paragraph is read with no code span and every comment opener hiding. The sentence
 * must show under both CommonMark readings in use, 0.29 in cmark-gfm and 0.31 in pandoc. The body is read twice:
 * once with `<!-->`, `<!--->` and `<?>` ending the HTML block they open at their own line, and once with it running
 * on. At an HTML block start or end that the readings part on, and at a lone carriage return, reading stops and
 * nothing from that line on counts. The check does not see text that renders hidden by other means, such as a tag or
 * an attribute in that fallback reading, the content of an element that a browser hides, an image description, and a
 * footnote or link definition that no reference uses, and it reads a table as paragraph text.
 */
export function bodyCarriesDisclosure(body: string, supervisor: string): boolean {
  const sentence = unattendedDisclosure(supervisor);
  // Renderers differ on whether the end marker inside `<!-->`, `<!--->` or `<?>` ends the block it opens: read both ways.
  return shownText(body, false).includes(sentence) && shownText(body, true).includes(sentence);
}

/**
 * The text that a renderer shows outside code blocks and comments, with line breaks between its lines and blocks.
 * With `emptyRunsOn`, an HTML block whose start line holds its end marker only inside the marker that opens it, as
 * `<!-->`, `<!--->` and `<?>` do, runs on past that line. A leading byte order mark is dropped and a CRLF is one line
 * ending. Where the readings part, at a lone carriage return or at an HTML block start or end that `htmlStart` or
 * `blockEnds` calls `SPLIT`, reading stops there and the open paragraph is dropped, so nothing from that line on
 * counts as shown.
 */
function shownText(body: string, emptyRunsOn: boolean): string {
  const shownLines: string[] = [];
  const state: CommentState = { comment: false, raw: false };
  const stack: Container[] = [];
  let fence: { char: string; length: number } | undefined;
  let html: HtmlBlock | undefined;
  let paragraph = false;
  /** The lines of the open paragraph, read together because an inline code span or a comment may cross lines. */
  const lines: string[] = [];
  const endParagraph = () => {
    if (lines.length > 0) shownLines.push(visibleText(lines.join("\n"), state));
    lines.length = 0;
  };
  /**
   * Reads one line of an HTML block raw and says whether the block goes on past it. Every line keeps the comment
   * state; only a block that opens with a comment shows text. A comment the block leaves open stays open in the page.
   */
  const htmlLine = (block: HtmlBlock, text: string, ends: boolean): boolean => {
    const lineShown = visibleText(text, state, true);
    if (block.comment) shownLines.push(lineShown);
    if (!ends) return true;
    state.raw ||= state.comment;
    state.comment = false;
    return false;
  };
  const bodyText = body.replace(/^\uFEFF/, "").replaceAll("\r\n", "\n");
  for (const line of bodyText.split("\n")) {
    if (line.includes("\r")) {
      // cmark-gfm ends a line at a lone carriage return and pandoc drops it.
      lines.length = 0;
      break;
    }
    let cursor: Cursor = { at: 0, column: 0, base: 0 };
    let matched = 0;
    for (const container of stack) {
      const next = continues(line, cursor, container);
      if (next === undefined) break;
      cursor = next;
      matched += 1;
    }
    if (fence !== undefined && matched === stack.length) {
      const closer = fenceOpener(line, cursor);
      const info = line.slice(skipBlank(line, cursor).at + (closer?.length ?? 0));
      if (closer?.char === fence.char && closer.length >= fence.length && BLANK.test(info)) fence = undefined;
      continue;
    }
    const text = line.slice(cursor.at);
    if (html !== undefined && matched === stack.length) {
      const ends = blockEnds(html, text);
      if (ends === SPLIT) break;
      if (!htmlLine(html, text, ends)) html = undefined;
      continue;
    }
    if (fence === undefined && html === undefined && paragraph) {
      const starts = startsBlock(line, cursor, matched === stack.length);
      if (starts === SPLIT) {
        lines.length = 0;
        break;
      }
      if (!starts) {
        // A setext underline ends the paragraph as a heading; any other line continues it, lazily past a container.
        const lead = skipBlank(line, cursor);
        paragraph = matched < stack.length || lead.column - cursor.base > 3 || !SETEXT.test(line.slice(lead.at));
        lines.push(text);
        if (!paragraph) endParagraph();
        continue;
      }
    }
    const interrupts = paragraph && matched === stack.length;
    endParagraph();
    // An HTML block that a blank line or its container ends leaves its comment open in the page; an inline one never
    // closed is text.
    if (html !== undefined) state.raw ||= state.comment;
    fence = undefined;
    html = undefined;
    paragraph = false;
    state.comment = false;
    stack.length = matched;
    for (let open = opens(line, cursor, interrupts); open !== undefined; open = opens(line, cursor, false)) {
      stack.push(open.container);
      cursor = open.cursor;
    }
    const blank = skipBlank(line, cursor);
    const rest = line.slice(blank.at);
    fence = fenceOpener(line, cursor);
    if (fence !== undefined || BLANK.test(rest)) continue;
    if (blank.column - cursor.base > 3) continue; // indented code
    const start = htmlStart(rest, false);
    if (start === SPLIT) break;
    if (start !== undefined) {
      const ends = blockEnds(start, emptyRunsOn ? rest.slice(start.marker) : rest);
      if (ends === SPLIT) break;
      if (htmlLine(start, rest, ends)) html = start;
      continue;
    }
    paragraph = !HEADING.test(rest) && !THEMATIC.test(rest);
    if (paragraph) lines.push(rest);
    else shownLines.push(visibleText(rest, state));
  }
  endParagraph();
  return shownLines.join("\n");
}
