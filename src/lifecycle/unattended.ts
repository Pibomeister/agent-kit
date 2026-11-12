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

/** A fence line from its first non-blank character: the fence characters, then the info string. */
const FENCE = /^(`{3,}|~{3,})(.*)$/;
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
 * Whether a line that a paragraph could take starts a block instead, which ends the paragraph. `inside` is whether
 * the line continues every container the paragraph sits in; a lazy line is checked outside it, as in CommonMark.
 */
function startsBlock(line: string, from: Cursor, inside: boolean): boolean {
  const blank = skipBlank(line, from);
  const rest = line.slice(blank.at);
  if (BLANK.test(rest) || opens(line, from, inside) !== undefined || fenceOpener(line, from) !== undefined) return true;
  return blank.column - from.base <= 3 && (rest.startsWith("<!--") || THEMATIC.test(rest) || HEADING.test(rest));
}

/** What a line reads while it is scanned: a comment the current block opened, and one the page is still inside. */
interface CommentState {
  comment: boolean;
  raw: boolean;
}

/**
 * The text of one line outside any fence that a browser shows. `state.comment` is a comment that this block
 * opened, which ends at `-->`. `state.raw` is a comment that an earlier HTML block left open in the rendered page:
 * the page hides everything until a later HTML block line carries `-->`. Renderers differ on which inline text
 * reaches the page as raw HTML, so no paragraph ends it. Outside an HTML block, inline code spans stay whole, so a
 * comment opener inside one starts nothing.
 */
function visibleText(line: string, state: CommentState, html = false): string {
  if (state.raw && !html) return "";
  let out = "";
  let i = 0;
  while (i < line.length) {
    if (state.comment || (html && state.raw)) {
      const end = line.indexOf("-->", i);
      if (end < 0) return out;
      state.comment = false;
      state.raw = false;
      i = end + 3;
    } else if (line[i] === "`" && !html) {
      let run = 1;
      while (line[i + run] === "`") run += 1;
      let close = -1;
      for (let at = line.indexOf("`", i + run); at >= 0 && close < 0;) {
        let length = 1;
        while (line[at + length] === "`") length += 1;
        if (length === run) close = at;
        else at = line.indexOf("`", at + length);
      }
      const end = close < 0 ? i + run : close + run;
      out += line.slice(i, end);
      i = end;
    } else if (line.startsWith("<!-->", i) || line.startsWith("<!--->", i)) {
      i += line.startsWith("<!-->", i) ? 5 : 6;
    } else if (line.startsWith("<!--", i)) {
      state.comment = true;
      i += 4;
    } else {
      out += line[i];
      i += 1;
    }
  }
  return out;
}

/**
 * Whether the body carries the disclosure sentence for `supervisor`: an exact substring test with no whitespace
 * normalisation over the text a CommonMark renderer shows outside code blocks and HTML comments. The check follows
 * the block structure that decides where those start and end. Block quotes and list items are containers: a later
 * line continues a quote with its marker and a list item with a blank line or the item's indent, and a paragraph
 * also takes a lazy line. A fence opens and closes only 0 to 3 columns past its container's markers; a line four
 * columns past them is indented code, which hides as a fence does. A backtick fence line has no backtick in its info
 * string. A fence ends at its closer or at the first line that does not continue its container, and that line is
 * read as ordinary text. Inside a fence no marker is stripped, and a comment opener starts nothing. A comment opener
 * at the start of a block opens an HTML block that ends at the line holding `-->` or where its container ends. A
 * comment that such a block leaves open hides the rest of the page until a later HTML block line carries `-->`. A
 * paragraph is read whole, so an inline code span or comment may cross its lines, and a comment opener inside it
 * hides text to its closer or to the end of the paragraph. Renderers differ on whether `<!-->` or `<!--->` ends the
 * HTML block it opens, so the sentence must show under both readings. The check does not see text that renders
 * hidden by other means, such as raw HTML elements or link definitions.
 */
export function bodyCarriesDisclosure(body: string, supervisor: string): boolean {
  const sentence = unattendedDisclosure(supervisor);
  // Renderers differ on whether the `-->` inside `<!-->` or `<!--->` ends the HTML block it opens: read it both ways.
  return shownText(body, false).includes(sentence) && shownText(body, true).includes(sentence);
}

/**
 * The text that a renderer shows outside code blocks and comments, with line breaks between its lines and blocks.
 * With `emptyRunsOn`, an HTML block that opens with `<!-->` or `<!--->` and holds no other `-->` on that line runs on
 * past it.
 */
function shownText(body: string, emptyRunsOn: boolean): string {
  const shownLines: string[] = [];
  const state: CommentState = { comment: false, raw: false };
  const stack: Container[] = [];
  let fence: { char: string; length: number } | undefined;
  let htmlBlock = false;
  let paragraph = false;
  /** The lines of the open paragraph, read together because an inline code span or a comment may cross lines. */
  const lines: string[] = [];
  const endParagraph = () => {
    if (lines.length > 0) shownLines.push(visibleText(lines.join("\n"), state));
    lines.length = 0;
  };
  /** Reads one line of an HTML block and says whether the block goes on: it ends at the line that holds `-->`. */
  const htmlLine = (text: string, ends = text.includes("-->")): boolean => {
    shownLines.push(visibleText(text, state, true));
    if (!ends) return true;
    state.raw ||= state.comment;
    state.comment = false;
    return false;
  };
  for (const line of body.split("\n")) {
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
    if (htmlBlock && matched === stack.length) {
      htmlBlock = htmlLine(line.slice(cursor.at));
      continue;
    }
    if (fence === undefined && !htmlBlock && paragraph && !startsBlock(line, cursor, matched === stack.length)) {
      // A setext underline ends the paragraph as a heading; any other line continues it, lazily past a container.
      const lead = skipBlank(line, cursor);
      paragraph = matched < stack.length || lead.column - cursor.base > 3 || !SETEXT.test(line.slice(lead.at));
      lines.push(line.slice(cursor.at));
      if (!paragraph) endParagraph();
      continue;
    }
    const interrupts = paragraph && matched === stack.length;
    endParagraph();
    // An HTML block that its container ends leaves its comment open in the page; an inline one never closed is text.
    if (htmlBlock) state.raw ||= state.comment;
    fence = undefined;
    htmlBlock = false;
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
    if (rest.startsWith("<!--")) {
      htmlBlock = htmlLine(rest, (emptyRunsOn ? rest.slice(4) : rest).includes("-->"));
      continue;
    }
    paragraph = !HEADING.test(rest) && !THEMATIC.test(rest);
    if (paragraph) lines.push(rest);
    else shownLines.push(visibleText(rest, state));
  }
  endParagraph();
  return shownLines.join("\n");
}
