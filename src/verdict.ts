/**
 * The shared strict verdict parser (issue #195).
 *
 * A verdict is read from exactly one structured final verdict field, and
 * from nowhere else. The field is a line of the exact shape
 *
 *   VERDICT: <value>
 *
 * standing as the final non-empty line of the transcript. Surrounding
 * prose is never scanned for a verdict word: a transcript that mentions
 * WORTHY early and ends `VERDICT: REJECT` is a rejection. A missing,
 * duplicated, malformed or non-final field, and a value outside the
 * caller's exact enum, all fail closed. Callers that must produce a
 * verdict either way use the fail-closed helper, which maps every
 * failure to the rejecting value rather than inferring permission
 * from prose.
 */

/** The adversarial verdict enum: the only values a merge gate may act on. */
export const ADVERSARIAL_VERDICTS = ["WORTHY", "REJECT"] as const;
export type AdversarialVerdict = (typeof ADVERSARIAL_VERDICTS)[number];

export type FinalVerdict<V extends string = string> =
  | { ok: true; verdict: V }
  | { ok: false; verdict: null; reason: string };

const FIELD_PREFIX = "VERDICT:";
const FIELD_LINE = /^VERDICT:[ \t]+(\S+)[ \t]*$/;

function fail<V extends string>(reason: string): FinalVerdict<V> {
  return { ok: false, verdict: null, reason };
}

/**
 * Parses the one structured final verdict field of `text` against the
 * caller's exact, case-sensitive `allowed` enum. Returns the verdict
 * only when exactly one well-formed field stands as the final
 * non-empty line and its value is in the enum; otherwise fails closed
 * with a named reason. An empty enum admits nothing.
 */
export function parseFinalVerdict<V extends string>(text: string, allowed: readonly V[]): FinalVerdict<V> {
  if (allowed.length === 0) return fail("no verdict values are allowed, so no verdict can stand");
  const lines = text.split(/\r\n|\r|\n/);
  let last = lines.length - 1;
  while (last >= 0 && (lines[last] ?? "").trim() === "") last -= 1;
  if (last < 0) return fail("the transcript is empty; there is no final verdict field");
  const candidates: number[] = [];
  for (const [index, line] of lines.entries()) if (line.startsWith(FIELD_PREFIX)) candidates.push(index);
  if (candidates.length === 0) return fail("there is no structured final verdict field (VERDICT: <value>)");
  if (candidates.length > 1)
    return fail(`there are ${candidates.length} verdict fields; exactly one final verdict field is required`);
  const at = candidates[0] ?? -1;
  if (at !== last) return fail("the verdict field is not the final line; text after it makes the verdict ambiguous");
  const matched = FIELD_LINE.exec(lines[at] ?? "");
  if (matched === null)
    return fail("the verdict field is malformed; it must be exactly VERDICT: <value> with one value and nothing else");
  const value = matched[1] ?? "";
  const verdict = allowed.find((candidate) => candidate === value);
  if (verdict === undefined)
    return fail(`the verdict value ${JSON.stringify(value)} is not one of the allowed verdicts`);
  return { ok: true, verdict };
}

/** Parses an adversarial transcript: WORTHY only from a valid final field. */
export function parseAdversarialVerdict(text: string): FinalVerdict<AdversarialVerdict> {
  return parseFinalVerdict(text, ADVERSARIAL_VERDICTS);
}

/**
 * The fail-closed adversarial verdict: WORTHY when the final field
 * strictly says so, REJECT in every other case. This is the only
 * verdict a merge gate may consume from a transcript.
 */
export function failClosedAdversarialVerdict(text: string): AdversarialVerdict {
  const parsed = parseAdversarialVerdict(text);
  return parsed.ok ? parsed.verdict : "REJECT";
}

function parsesAsJsonObjectOrArray(text: string): boolean {
  try {
    const value: unknown = JSON.parse(text);
    return value instanceof Object;
  } catch {
    return false;
  }
}

/** True when some suffix of `line` that starts at `{` or `[` is a JSON object or array. */
function lineHasJsonObjectOrArraySuffix(line: string): boolean {
  for (let i = 0; i < line.length; i++) {
    if (line[i] !== "{" && line[i] !== "[") continue;
    if (parsesAsJsonObjectOrArray(line.slice(i))) return true;
  }
  return false;
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * The text before the final non-empty line when that line starts with
 * `VERDICT:`. Empty when the transcript is only that line. Undefined
 * when there is no such final line.
 */
function remainderAfterFinalVerdictLine(text: string): string | undefined {
  const lines = text.split(/\r\n|\r|\n/);
  let last = lines.length - 1;
  while (last >= 0 && (lines[last] ?? "").trim() === "") last -= 1;
  if (last < 0) return undefined;
  if (!(lines[last] ?? "").startsWith(FIELD_PREFIX)) return undefined;
  return lines.slice(0, last).join("\n");
}

/**
 * True when stdout mixes JSON-looking text with a final VERDICT line.
 * A JSON object or array is never a transcript. After a BOM and leading
 * whitespace are stripped, a leading `{`, `[`, or triple backtick is
 * mixed, except a remainder that is only `{` or `[`. Any suffix that
 * starts at `{` or `[` on a remainder line, fence lines included, and
 * parses as a JSON object or array is mixed. A remainder line that
 * starts with `{` or `[` and holds more than that character is mixed
 * even when it does not parse (truncated JSON). A JSON scalar is not.
 */
function mixedJsonAndTranscript(text: string): boolean {
  const remainder = remainderAfterFinalVerdictLine(text);
  if (remainder === undefined) return false;
  const head = stripBom(text).trimStart();
  const remainderTrim = stripBom(remainder).trim();
  if (head.startsWith("```")) return true;
  if ((head.startsWith("{") || head.startsWith("[")) && remainderTrim !== "{" && remainderTrim !== "[") return true;
  if (parsesAsJsonObjectOrArray(remainderTrim)) return true;
  for (const line of remainder.split(/\r\n|\r|\n/)) {
    const trimmed = line.trim();
    if ((trimmed.startsWith("{") || trimmed.startsWith("[")) && trimmed.length > 1) return true;
    if (lineHasJsonObjectOrArraySuffix(line)) return true;
  }
  return false;
}

/**
 * A non-JSON transcript's adversarial choice, or null when stdout has
 * no well-formed final VERDICT field whose value is in `options`. Mixed
 * JSON-plus-VERDICT stdout returns null first. Otherwise the choice is
 * `failClosedAdversarialVerdict`: WORTHY only from a valid field.
 * Callers that already parsed JSON must not use this as a fallback for
 * a malformed object.
 */
export function adversarialChoiceFromTranscript(text: string, options: readonly string[]): AdversarialVerdict | null {
  if (mixedJsonAndTranscript(text)) return null;
  const verdict = failClosedAdversarialVerdict(text);
  if (!parseAdversarialVerdict(text).ok || !options.includes(verdict)) return null;
  return verdict;
}
