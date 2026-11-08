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
