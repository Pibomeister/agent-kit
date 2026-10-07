/**
 * Repeats and resemblances among what the learning runtime records.
 *
 * A repeat is the same content in the same scope: equal after case, Unicode
 * form, punctuation and spacing are normalized. It is counted on the record it
 * repeats, never written as a second record.
 *
 * A resemblance is advisory. A new lesson, pattern or guardrail draft whose
 * content shares enough terms with an existing one lists it as a candidate, so
 * a reviewer can amend or supersede. Candidates are reported in the result and
 * never stored as a relation, never merge anything, never block a write, and
 * an empty list never claims there is no conflict.
 *
 * Both compare the whole content (a lesson's statement, a pattern's problem,
 * root cause and fix), never a title alone: two records about one subject can
 * share no title word, and two unrelated ones can share one.
 */

/** Lowercase, NFKC, every run of non-letters and non-digits one space, trimmed. */
export function normalizeContent(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** The identity a repeat is matched on: normalized content plus scope. */
export function contentKey(text: string, scope: string): string {
  return `${normalizeContent(scope)}\u0000${normalizeContent(text)}`;
}

const STOPWORDS: ReadonlySet<string> = new Set(
  (
    "a an and are as at be been but by can do does for from has have if in into is it its not no of on or " +
    "over should so than that the their then there these this those to under use used uses using was were " +
    "when where which while with without instead before after only also always never must"
  ).split(" "),
);

/** The content terms of a text: normalized words of two or more characters, stopwords dropped, a plural `s` trimmed. */
export function terms(text: string): Set<string> {
  const out = new Set<string>();
  for (const word of normalizeContent(text).split(" ")) {
    if (word.length < 2 || STOPWORDS.has(word)) continue;
    out.add(word.length > 3 && word.endsWith("s") && !word.endsWith("ss") ? word.slice(0, -1) : word);
  }
  return out;
}

export interface Resemblance {
  /** Dice coefficient: twice the shared terms over both sets' sizes. */
  score: number;
  /** Terms in both sets. */
  shared: number;
}

/** How much two term sets overlap. */
export function resemblance(a: ReadonlySet<string>, b: ReadonlySet<string>): Resemblance {
  let shared = 0;
  for (const term of a) if (b.has(term)) shared += 1;
  const total = a.size + b.size;
  return { score: total === 0 ? 0 : (2 * shared) / total, shared };
}

/** Defaults: a candidate shares at least half its terms by Dice and at least two terms outright; at most three are listed. */
export const SIMILAR_AT = 0.5;
export const SIMILAR_MIN_SHARED = 2;
export const SIMILAR_MAX = 3;

export interface Candidate {
  id: string;
  /** The candidate's status when it was compared. */
  status: string;
  /** Dice coefficient over content terms, two decimals. */
  score: number;
}

export interface Comparable {
  id: string;
  status: string;
  text: string;
}

/** Existing records resembling `text`, most similar first, ties by id. */
export function similarTo(
  text: string,
  pool: Iterable<Comparable>,
  options: { at?: number; minShared?: number; max?: number } = {},
): Candidate[] {
  const own = terms(text);
  const at = options.at ?? SIMILAR_AT;
  const minShared = options.minShared ?? SIMILAR_MIN_SHARED;
  const found: Candidate[] = [];
  for (const other of pool) {
    const { score, shared } = resemblance(own, terms(other.text));
    if (score >= at && shared >= minShared)
      found.push({ id: other.id, status: other.status, score: Math.round(score * 100) / 100 });
  }
  found.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return found.slice(0, options.max ?? SIMILAR_MAX);
}

/** `ls-004 ~ ls-001 (0.82 confirmed), ls-002 (0.6 hypothesis)`: one record's candidates on one line. */
export function similarLine(id: string, candidates: readonly Candidate[]): string {
  return `${id} ~ ${candidates.map((c) => `${c.id} (${c.score} ${c.status})`).join(", ")}`;
}
