import { describe, expect, test } from "bun:test";

import { loadCatalog } from "../src/catalog/load.ts";
import { RESTATEMENT_THRESHOLD, checkRestatements } from "../src/validation/restatement.ts";
import { LABELLED, RULINGS_AT_REVISION } from "./fixtures/restatement-cases.ts";
import { makeTree } from "./helpers/tree.ts";

/**
 * The labelled corpus, scored against the rulings as they stood when it was
 * labelled.
 *
 * Both halves are frozen on purpose. A fixture that read the live
 * `policies/resolved-conflicts.yaml` would re-score itself every time someone
 * edited a ruling, and a fixture that pointed at `AUTHORING.md:607` would stop
 * meaning anything the moment a line was inserted above it -- which happened to
 * six of these cases within a day of their being labelled, and happened to the
 * first harness that measured them. So the case carries its own text and the
 * corpus carries its own rulings, and the only way either changes is a diff to
 * this file.
 *
 * `policies` owns the classifications; this file owns their storage. A new
 * label, or a change to one, is a judgment about AUTHORING 6 and goes to that
 * seat rather than being decided here.
 */
const CATALOG_HEAD = `schema_version: 1
package:
  id: ak
  name: agent-kit
  version: 0.1.0
  namespace: "/ak:"
  default_profile: core
`;

function policyYaml(): string {
  const lines = [
    "schema_version: 1",
    "policy: resolved-conflicts",
    `rows: ${RULINGS_AT_REVISION.length}`,
    "",
    "conflicts:",
  ];
  for (const [index, row] of RULINGS_AT_REVISION.entries()) {
    lines.push(`  - id: ${row.id}`, "    tension: captured with the corpus", "    ruling: >-");
    // Folded scalar: one physical line, so no wrapping can alter the text.
    lines.push(`      ${row.text.replace(/\n/g, " ")}`);
    lines.push(`    scenario: ${index + 1}`, "    coverage: direct");
  }
  return lines.join("\n");
}

/**
 * The longest run of characters a case shares verbatim with its ruling.
 *
 * Whitespace is flattened first: a verbatim quotation in a wrapped markdown
 * paragraph is broken by newlines that a reader never sees, and comparing
 * against the raw text would score the wrapping rather than the quotation.
 */
function longestSharedRun(caseText: string, rulingText: string): number {
  const a = caseText.replace(/\s+/g, " ").trim();
  const b = rulingText.replace(/\s+/g, " ").trim();
  let best = 0;
  const row = Array.from({ length: b.length + 1 }, () => 0);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = 0;
    for (let j = 1; j <= b.length; j++) {
      const above = row[j] ?? 0;
      if (a[i - 1] === b[j - 1]) {
        const run = diagonal + 1;
        row[j] = run;
        if (run > best) best = run;
      } else {
        row[j] = 0;
      }
      diagonal = above;
    }
  }
  return best;
}

/** Format decides citation scope, so a YAML case has to stay YAML. */
function pathFor(item: (typeof LABELLED)[number]): string {
  return item.format === "yaml" ? `policies/${item.id}.yaml` : `protocols/${item.id}/PROTOCOL.md`;
}

interface Measured {
  /** The cosine this case's own ruling was given in this case's block. */
  readonly score: number;
  /** Whether that ruling leads some window in the block, rather than trailing one. */
  readonly leads: boolean;
}

/**
 * A case whose captured text names its own ruling somewhere, so there is
 * something for `uncited` to remove and a `scoreIfUncited` to measure.
 *
 * Textual on purpose: whether the id appears is a fact about the fixture that
 * no change to the check can alter.
 */
function namesOwnRuling(item: (typeof LABELLED)[number]): boolean {
  return item.text.includes(item.ruling);
}

/**
 * A case the check is required to stay silent on *because* of its citation.
 *
 * This used to be `namesOwnRuling`, and the two were the same thing only while
 * YAML citation scope was the whole file: any id anywhere in the document
 * cleared every claim in it. Under ancestor scope a citation reaches the
 * mapping it is attached to and what nests beneath it, so a case can name its
 * ruling and still be scored, which is exactly what happened to
 * `invocation-lesson-publish-ship-clause` -- its citation sits on a sibling
 * operation and is now inert.
 *
 * So suppression is measured rather than spelled: the citation has to make a
 * difference. Both numbers are stored in the fixture and neither is read from
 * the check at test time, so this does not ask the instrument whether it is
 * working.
 */
function suppressed(item: (typeof LABELLED)[number]): boolean {
  return namesOwnRuling(item) && (item.scoreIfUncited ?? 0) > item.score;
}

/** The same text with every line naming its ruling removed. Identity elsewhere. */
function uncited(item: (typeof LABELLED)[number]): string {
  return item.text
    .split("\n")
    .filter((line) => !line.includes(item.ruling))
    .join("\n");
}

/** The checker's coverage note from each scan, read by the corpus test below. */
const coverage: string[] = [];

/** Every case in its own body, so one case cannot cite or shadow another. */
function scanAll(body: (item: (typeof LABELLED)[number]) => string = (item) => item.text): Map<string, Measured> {
  const files: Record<string, string> = {
    "catalog.yaml": CATALOG_HEAD,
    "policies/resolved-conflicts.yaml": policyYaml(),
  };
  for (const item of LABELLED) files[pathFor(item)] = `${body(item)}\n`;
  const root = makeTree(files);
  const { catalog } = loadCatalog(root);
  if (catalog === null) throw new Error("fixture has no catalog");

  const all = checkRestatements({ root, catalog }, 0.02);
  coverage.push(all.find((i) => i.rule === "rulings.restatement-scan-coverage")?.message ?? "");
  const issues = all.filter((i) => i.rule === "rulings.uncited-restatement");

  // The score of a case is the best window in the block its anchor sits in --
  // the same unit the capture used. Taking the best in the whole file would
  // score a neighbouring paragraph for a case captured whole, which is what a
  // YAML case has to be.
  const scored = new Map<string, Measured>();
  for (const item of LABELLED) {
    const path = pathFor(item);
    const lines = `${body(item)}\n`.split("\n");
    const at = lines.findIndex((line) => line.includes(item.anchor));
    if (at < 0) throw new Error(`anchor missing from captured text: ${item.id}`);
    let lo = at;
    let hi = at;
    while (lo > 0 && (lines[lo - 1] ?? "").trim() !== "") lo--;
    while (hi < lines.length - 1 && (lines[hi + 1] ?? "").trim() !== "") hi++;
    // And it is the score this case's *ruling* was given, not the block's
    // leader. A block can be led by an unrelated window naming a different
    // ruling -- `review-delta-novelty-evidence` is led by a `two-fix-cycles`
    // window at 0.34 while the clause the case is about scores 0.30 -- and
    // storing the leader would put a number in the fixture that describes a
    // sentence the case is not about.
    const wanted = new RegExp(`\`${item.ruling}\` \\((\\d\\.\\d+)\\)`);
    const inBlock = issues.filter((i) => i.file === path && (i.line ?? 0) >= lo + 1 && (i.line ?? 0) <= hi + 1);
    const best = inBlock.map((i) => Number(wanted.exec(i.message)?.[1] ?? 0));
    // Leading matters separately from scoring. The check prints ranked
    // candidates precisely because the leader is often the wrong sibling, so a
    // ruling that only ever trails is one this text does not restate.
    const leads = inBlock.some((i) => /`([a-z-]+)` \(\d\.\d+\)/.exec(i.message)?.[1] === item.ruling);
    scored.set(item.id, { score: Math.max(0, ...best), leads });
  }
  return scored;
}

const scores = scanAll();
/** Whether the checker, as it scores today, reports a case. */
const reported = (c: (typeof LABELLED)[number]) => (scores.get(c.id)?.score ?? 0) >= RESTATEMENT_THRESHOLD;
/** The same cases with their own citation removed. Only suppressed cases differ. */
const uncitedScores = scanAll(uncited);

describe("the labelled corpus, which is what any recall claim rests on", () => {
  for (const item of LABELLED.filter((c) => c.label === "defect" && c.reported)) {
    test(`${item.id} is still caught: ${item.why.slice(0, 60)}...`, () => {
      // A recall regression is the failure that matters here. A tuning change
      // that quietly drops one of these would otherwise look like a cleaner
      // report, which is the shape of every mistake made against this check.
      expect(scores.get(item.id)?.score ?? 0).toBeGreaterThanOrEqual(RESTATEMENT_THRESHOLD);
    });
  }

  for (const item of LABELLED.filter((c) => c.label === "defect" && !c.reported && !suppressed(c))) {
    test(`${item.id} is a known miss the threshold hides, pinned at ${item.score}: ${item.why.slice(0, 45)}...`, () => {
      // This pins a defect the instrument does not see. It is not an assertion
      // that the miss is acceptable -- it is what stops the miss from being
      // forgotten, because the coverage note's recall claim is only true while
      // this number is what it says.
      //
      // It fails when the check improves, and that failure is the point: the
      // recall claim in `checkRestatements` and this case's label have to move
      // in the same commit. Reclassify to `reported: true` and rewrite the note.
      expect(scores.get(item.id)?.score ?? 0).toBeLessThan(RESTATEMENT_THRESHOLD);

      // And it is not the shared-nothing-vocabulary blind spot. The check
      // scores these well above zero and ranks the right ruling first; the
      // threshold is what cuts them. A miss at zero and a miss at 0.50 are
      // different failures and only one of them is reachable by tuning.
      expect(scores.get(item.id)?.score ?? 0).toBeGreaterThan(0.25);
    });
  }

  for (const item of LABELLED.filter((c) => c.label === "defect" && !c.reported && suppressed(c))) {
    test(`${item.id} is a known miss a sibling citation hides, ${item.scoreIfUncited} without it: ${item.why.slice(0, 40)}...`, () => {
      // A different failure from the one above, and the distinction is the
      // reason this loop exists. The threshold misses are hidden by one number.
      // A case here is hidden before any number is compared: its own citation
      // covers the claim, so no window is emitted for it at all.
      //
      // This loop held two cases while YAML scope was the whole file. One of
      // them, `invocation-lesson-publish-ship-clause`, was suppressed by a
      // citation on a *sibling* operation, which ancestor scope no longer lets
      // reach; it is scored now and has moved to the threshold loop above.
      expect(scores.get(item.id)?.score ?? -1).toBe(0);

      // The number the citation is hiding. Without this the zero above is
      // indistinguishable from a case that shares no vocabulary with any
      // ruling, and the whole claim about scope would rest on a comment.
      const hidden = item.scoreIfUncited;
      if (hidden === undefined) throw new Error(`suppressed case carries no scoreIfUncited: ${item.id}`);
      expect(uncitedScores.get(item.id)?.score ?? -1).toBe(hidden);

      // And the part that stops this case being read as a tuning argument:
      // the hidden number is under the threshold too, so removing the
      // suppression alone would still not report it. Both the scope rule and
      // the threshold have to move, and a change to either one on its own is
      // not a fix for this case.
      expect(hidden).toBeLessThan(RESTATEMENT_THRESHOLD);
    });
  }

  test("a citation nested under a claim's sibling does not reach the claim", () => {
    // The asymmetry ancestor scope encodes: a citation covers the mapping it
    // is attached to and everything nested beneath it, never anything above
    // it. Either direction of that rule collapses if it is wrong -- a key that
    // attributed upward would let any leaf clear its parents, and file scope
    // would be back under another name.
    //
    // `review-synthesis-may-not` is the only capture in the set that can test
    // this on real text, because it carries both kinds of citation at once:
    // `rulings:` on the `synthesis` mapping, which does reach the `may_not`
    // sequence, and `ruling:` on the `low_confidence_security` sub-mapping
    // beside it, which names the same ruling and must not reach it.
    const item = LABELLED.find((c) => c.id === "review-synthesis-may-not");
    if (item === undefined) throw new Error("the capture this test is about is missing from the corpus");

    const withoutMappingKey = item.text
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("rulings:"))
      .join("\n");
    // The nested citation survives that cut. Without this the test could pass
    // by having removed both keys, which would measure nothing.
    expect(withoutMappingKey).toContain("    ruling: low-confidence-security-adjudicated");

    // Scored identically to the capture with no citation of this ruling at
    // all: the nested key contributes exactly nothing to the claim above it.
    const measured = scanAll((c) => (c.id === item.id ? withoutMappingKey : c.text));
    expect(measured.get(item.id)?.score ?? -1).toBe(item.scoreIfUncited ?? -1);
  });

  for (const item of LABELLED.filter((c) => c.label === "not-a-defect")) {
    test(`${item.id} stays rejected: ${item.why.slice(0, 55)}...`, () => {
      // The guard in the other direction. Every case found by reading the
      // report is above the line by construction, so a change that dragged
      // rejections up across it would leave no trace in a set built only from
      // what the check already emits.
      expect(scores.get(item.id)?.score ?? 0).toBeLessThan(RESTATEMENT_THRESHOLD);
    });
  }

  test("what the check does is recorded per case, not inferred from the score", () => {
    // `reported` and `score` are stored separately and a disagreement between
    // them is how a case silently changes which guard it gets. Until these two
    // axes were split, a defect scoring below the threshold was picked up by
    // the rejection guard and asserted to be correctly ignored.
    for (const item of LABELLED) {
      expect({ id: item.id, reported: item.reported }).toEqual({
        id: item.id,
        reported: (scores.get(item.id)?.score ?? 0) >= RESTATEMENT_THRESHOLD,
      });
    }
  });

  test("each case names a ruling the check ranks first somewhere in its block", () => {
    // A weak invariant, deliberately, and worth being precise about what it
    // does and does not do.
    //
    // What catches a swapped ruling id is the drift test, because `score` is
    // the score of the case's *own* ruling: storing an id the text does not
    // restate moves the number, and the number is pinned. That is how the two
    // mis-attributions in this file were found -- one filed under
    // `supervisor-agreement-is-not-authority` whose 0.49 belonged to
    // `delta-baseline-reset-not-third-loop`, one under
    // `missing-supervisor-never-implementer` at 0.20 whose claim scores 0.50.
    // Both had a plausible id, a plausible number and a `why` describing the
    // right phenomenon; nothing measured whether the id and the number
    // belonged to each other, because `score` was the block's leader.
    //
    // This test catches the weaker failure the drift test cannot: a ruling
    // that scores but never leads, which the check would never propose for
    // this text and which therefore cannot be what the case is about.
    const wrong = LABELLED.filter((item) => {
      // A case whose citation actually covers its claim is suppressed by
      // design, so no window can name it. That is the scope rule working and
      // it is what `product-prototype-rationale` exists to hold. A case that
      // merely mentions its ruling elsewhere is scored like any other and owes
      // the same leading-candidate guarantee.
      if (suppressed(item)) return false;
      return !(scores.get(item.id)?.leads ?? false);
    }).map((item) => ({ id: item.id, ruling: item.ruling }));
    expect(wrong).toEqual([]);
  });

  test("a suppressed case is suppressed by its own citation, not by a low score", () => {
    // The other half of that rule, and the claim is now measured rather than
    // asserted in a comment: each of these scores zero in its own file and
    // `scoreIfUncited` with the citation line removed, and only the citation
    // explains the difference -- so they are evidence about scope, not about
    // cosine. Without the second assertion a change that merely stopped
    // scoring these files would look identical to the citation being honoured.
    //
    // What this does not establish, because it was written here as though it
    // did: that the scope rule is load-bearing at the shipping threshold. The
    // hidden scores are under 0.55, so narrowing scope further would change no
    // case's report. These guard the mechanism at the capture threshold. The
    // behavioural question is open and needs a case that clears 0.55 uncited,
    // which the set does not yet contain.
    //
    // The set held two of these, dropped to one when narrowing YAML scope made
    // `invocation-lesson-publish-ship-clause`'s citation inert, and is back to
    // two with `review-synthesis-may-not`. The weakening was recorded here
    // rather than papered over, so the restoration is recorded the same way:
    // one case cannot tell a general rule from one file's shape, and these two
    // have different shapes -- a file-level `rulings:` key over a profile, and
    // a mapping-level one over a bare sequence with a nested citation beside it.
    //
    // The second is also the only case in the set where scope crosses the
    // shipping threshold: 0.64 uncited against `product-prototype-rationale`'s
    // 0.50, so deleting one line in `policies/review.yaml` changes what
    // `ak validate` reports, not merely what it scores.
    const suppressedCases = LABELLED.filter(suppressed);
    expect(suppressedCases.length).toBeGreaterThan(1);
    for (const item of suppressedCases) {
      expect({ id: item.id, score: scores.get(item.id)?.score ?? -1 }).toEqual({ id: item.id, score: 0 });
      const hidden = item.scoreIfUncited;
      if (hidden === undefined) throw new Error(`suppressed case carries no scoreIfUncited: ${item.id}`);
      expect({ id: item.id, uncited: uncitedScores.get(item.id)?.score ?? -1 }).toEqual({
        id: item.id,
        uncited: hidden,
      });
      expect(
        longestSharedRun(item.text, RULINGS_AT_REVISION.find((r) => r.id === item.ruling)?.text ?? ""),
      ).toBeGreaterThan(10);
    }
    // And the field belongs to exactly the cases that name their own ruling: a
    // `scoreIfUncited` on a case with nothing to uncite would be a number
    // describing no measurement. That set is wider than the suppressed one now,
    // and the difference is the point -- a case whose two numbers are equal is
    // one whose citation no longer reaches it, which is a measurement worth
    // keeping rather than a field to drop.
    expect(LABELLED.filter((c) => c.scoreIfUncited !== undefined).map((c) => c.id)).toEqual(
      LABELLED.filter(namesOwnRuling).map((c) => c.id),
    );
  });

  test("the set holds cases on both sides of the threshold, and on both axes", () => {
    // Measured by the checker, not read off the labels: a corpus of accepted cases only measures nothing
    // about the threshold, and labels alone hold whatever the checker stops doing.
    expect(LABELLED.some(reported)).toBe(true);
    expect(LABELLED.some((c) => !reported(c))).toBe(true);
    // And a corpus with no known miss in it cannot support a recall claim at
    // all -- it can only report the instrument's own output back to itself.
    expect(LABELLED.some((c) => c.label === "defect" && reported(c))).toBe(true);
    expect(LABELLED.some((c) => c.label === "defect" && !reported(c))).toBe(true);
    expect(LABELLED.some((c) => c.label === "not-a-defect" && !reported(c))).toBe(true);
  });

  test("cosine does not order these by how much they quote, so no threshold fixes the misses", () => {
    // The reason the two misses are not a tuning question, measured here rather
    // than asserted. `:419` quotes 80 characters of its ruling and scores 0.40;
    // `:607` quotes 79 and scores 0.55. `authoring-packaging-back-reference`
    // and `agents-numeric-heuristics` quote an identical 65 and land 0.28
    // apart, on opposite sides of the line. Cosine measures shared vocabulary
    // against a corpus; an exact run measures quotation, and the two disagree.
    //
    // What follows from it: a second signal reaches this class and a threshold
    // does not. An N-character run shared with an uncited ruling needs no
    // corpus, no threshold and no version to be a finding, which is the same
    // property that made the IDF worth pinning.
    const runs = new Map(
      LABELLED.map((c) => {
        const ruling = RULINGS_AT_REVISION.find((r) => r.id === c.ruling);
        if (ruling === undefined) throw new Error(`case cites a ruling outside the corpus: ${c.id}`);
        return [c.id, longestSharedRun(c.text, ruling.text)] as const;
      }),
    );

    // Sanity on the instrument doing the measuring, so a broken helper cannot
    // make the inversion disappear by returning zero for everything.
    expect(runs.get("authoring-second-lifecycle-entrypoint")).toBe(80);
    expect(runs.get("authoring-repeated-failure")).toBe(79);

    // Reported as the checker scores it now, so the inversion is a property of the check, not of the labels.
    const missedDefects = LABELLED.filter((c) => c.label === "defect" && !reported(c));
    const inversions = missedDefects.flatMap((missed) =>
      LABELLED.filter((c) => reported(c) && (runs.get(c.id) ?? 0) <= (runs.get(missed.id) ?? 0)).map((c) => ({
        missed: missed.id,
        reported: c.id,
      })),
    );
    expect(inversions.length).toBeGreaterThan(0);
  });

  test("every case scores what it scored when it was labelled", () => {
    // Tolerance, not equality: an edit to a ruling legitimately moves these,
    // and should show up as a re-measure rather than as a broken build. A
    // change to the scoring path moves them much further than this.
    const drifted = LABELLED.map((item) => ({
      id: item.id,
      was: item.score,
      now: scores.get(item.id)?.score ?? 0,
    })).filter((row) => Math.abs(row.now - row.was) > 0.05);
    expect(drifted).toEqual([]);
  });

  test("the corpus is the whole ruling list, since that is what the weights are over", () => {
    // Scoring a case against a subset would reproduce neither the weights nor
    // the numbers above, and the fixture would silently stop being a fixture.
    expect(RULINGS_AT_REVISION.length).toBe(19);
    expect(new Set(RULINGS_AT_REVISION.map((r) => r.id)).size).toBe(RULINGS_AT_REVISION.length);
    // And the checker scored every scan against all of them, not a subset.
    expect(coverage.length).toBeGreaterThan(0);
    for (const note of coverage) expect(note).toContain(`against ${RULINGS_AT_REVISION.length} ruling(s)`);
  });

  test("each case records why it carries its label, not just the label", () => {
    // Three agents classified the same case wrong in the same direction, and a
    // bare TP/FP column is what let that reading propagate. The reason travels with the checker's own
    // verdict on the case: a labelled defect the check reports, or a rejection it keeps below the line.
    for (const item of LABELLED) {
      expect(item.why.length).toBeGreaterThan(40);
      expect(item.origin).toMatch(/ at [0-9a-f]{7}$/);
      expect(scores.has(item.id)).toBe(true);
    }
    const caught = LABELLED.filter((c) => c.label === "defect" && c.reported);
    expect(caught.length).toBeGreaterThan(0);
    for (const item of caught) expect(scores.get(item.id)?.score ?? 0).toBeGreaterThanOrEqual(RESTATEMENT_THRESHOLD);
  });
});
