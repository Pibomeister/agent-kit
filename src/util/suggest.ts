/**
 * What to say when a caller names a selector -- an id, a profile, a verb, a
 * run -- that nothing answers to.
 *
 * An unknown selector that comes back as an empty result reads exactly like
 * "there is nothing for it", which is the false negative every other check in
 * this package refuses. So each command that resolves a selector against a
 * known set refuses an unknown one, and names what the caller probably meant.
 *
 * `src/lifecycle/gate.ts` carries a copy of these two functions, because it
 * ships into bundles importing only `node:` built-ins; `tests/suggest.test.ts`
 * holds the two to the same answers.
 */

/** A set this small is listed whole when nothing in it is close. */
const LIST_WHOLE = 6;

/** Optimal string alignment distance: insertions, deletions, substitutions and adjacent swaps. */
function distance(a: string, b: string): number {
  // Three rolling rows: the one before last (for swaps), the last, and this one.
  let twoBack: number[] = [];
  let last = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let best = Math.min((last[j] ?? 0) + 1, (row[j - 1] ?? 0) + 1, (last[j - 1] ?? 0) + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        best = Math.min(best, (twoBack[j - 2] ?? 0) + 1);
      row.push(best);
    }
    twoBack = last;
    last = row;
  }
  return last[b.length] ?? 0;
}

/** Every candidate with its distance from `input`, nearest first, ties in code-point order. */
function ranked(input: string, candidates: readonly string[]): Array<{ candidate: string; d: number }> {
  const needle = input.toLowerCase();
  return [...new Set(candidates)]
    .map((candidate) => ({ candidate, d: distance(needle, candidate.toLowerCase()) }))
    .toSorted((x, y) => x.d - y.d || (x.candidate < y.candidate ? -1 : x.candidate > y.candidate ? 1 : 0));
}

/**
 * The candidates close enough to `input` to be what was meant, nearest first:
 * within a third of its length in edits (at least one), or containing it, or
 * contained in it, ignoring case. Substring matches need three characters, so
 * a one-letter typo does not match everything with that letter in it.
 */
export function closest(input: string, candidates: readonly string[], limit = 3): string[] {
  const needle = input.toLowerCase();
  if (needle.length === 0) return [];
  const allowed = Math.max(1, Math.round(needle.length / 3));
  return ranked(input, candidates)
    .filter(({ candidate, d }) => {
      const hay = candidate.toLowerCase();
      return d <= allowed || (needle.length >= 3 && hay.length >= 3 && (hay.includes(needle) || needle.includes(hay)));
    })
    .slice(0, limit)
    .map((row) => row.candidate);
}

function orList(items: readonly string[]): string {
  return items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} or ${items.at(-1) ?? ""}`;
}

/**
 * One line naming the unknown selector and the valid ones nearest to it.
 *
 * Close matches come back as "did you mean"; with none, a small set is listed
 * whole in the caller's order, and a large one by its three nearest members
 * and its size, so the line stays short whatever the set.
 */
export function unknownSelector(kind: string, input: string, candidates: readonly string[]): string {
  const head = `unknown ${kind} '${input}'`;
  const near = closest(input, candidates);
  if (near.length > 0) return `${head}; did you mean ${orList(near)}?`;
  const known = [...new Set(candidates)];
  if (known.length === 0) return `${head}; there are none to choose from`;
  if (known.length <= LIST_WHOLE) return `${head}; valid: ${known.join(", ")}`;
  const nearest = ranked(input, known)
    .slice(0, 3)
    .map((row) => row.candidate);
  return `${head}; nearest of ${known.length}: ${nearest.join(", ")}`;
}
