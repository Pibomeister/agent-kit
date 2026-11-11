/**
 * AUTHORING.md §10's two file-state rules, as `ak validate` now performs them.
 *
 * The cases below are seeded from `research/probes/defect-entries.py` at
 * `f5cec72` (sha256 95ca402e...), which is the only enforcement either rule has
 * had. They are reproduced rather than imported: a gate whose cases came from
 * the probe's own source could not disagree with it, and the point of moving
 * this into `src/` is that a second implementation either agrees or says why.
 *
 * The prose-only citation leads, because it is the case a checker gets wrong by
 * being generous. §10: "An entry that names no section the check can resolve
 * fails this rule rather than falling outside it: a checker that widens to the
 * whole file when it cannot find the scope restores the loose behaviour exactly
 * where the entry gave it least to work with."
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { loadCatalog } from "../src/catalog/load.ts";
import { checkContractDefects, contractSections, DEFECTS_FILE, OPEN_HEADING } from "../src/validation/defects.ts";
import { makeTree } from "./helpers/tree.ts";

const CATALOG = `schema_version: 1
package:
  id: ak
  name: agent-kit
  version: 0.1.0
  namespace: "/ak:"
  default_profile: core
`;

/**
 * A contract to file entries against.
 *
 * Small and written here, so a quotation that resolves does so against text
 * this file states rather than against whatever AUTHORING.md happens to say
 * today. The real contract is exercised separately, at the bottom.
 */
const CONTRACT = [
  "# Authoring",
  "",
  "## 5. Provenance law",
  "",
  "Every adapted file needs a provenance row of the form `donor@commit:path`,",
  "and that path must exist at the pin.",
  "",
  "### 5.1 The row",
  "",
  "A row keyed `target:` is skipped by the parser and contributes nothing.",
  "",
  "## 12. Bodies",
  "",
  "A protocol is shared phase logic a skill delegates to, and is not an entrypoint.",
  "",
].join("\n");

/** A sentence that is genuinely in §5, and a sentence that is genuinely in §12. */
const IN_SECTION_5 =
  "Every adapted file needs a provenance row of the form `donor@commit:path`, and that path must exist at the pin.";
const IN_SECTION_12 = "A protocol is shared phase logic a skill delegates to, and is not an entrypoint.";

function entry(title: string, lead: string, quote: string | null): string {
  const quoted = quote === null ? "No blockquote here." : `> ${quote}`;
  return [`### ${title}`, "", lead, "", quoted, "", "Trailing prose.", ""].join("\n");
}

function defects(body: string, heading = OPEN_HEADING): string {
  return ["# Contract defects", "", "Preamble prose that is not an entry.", "", heading, "", body].join("\n");
}

function ctxFor(files: Record<string, string>) {
  const root = makeTree({ "catalog.yaml": CATALOG, "AUTHORING.md": CONTRACT, ...files });
  const { catalog } = loadCatalog(root);
  if (catalog === null) throw new Error("fixture has no catalog");
  return { root, catalog };
}

/** The issues one entry produces, by rule. */
function rulesFor(body: string, contract = CONTRACT): string[] {
  const ctx = ctxFor({ "AUTHORING.md": contract, [DEFECTS_FILE]: defects(body) });
  return checkContractDefects(ctx)
    .filter((i) => i.severity === "error")
    .map((i) => i.rule);
}

describe("an open entry's quotation must resolve in the section it cites", () => {
  test("a citation in prose alone fails, rather than widening the search to the file", () => {
    // The case the rule exists for. The quotation is real and is in §5, so a
    // file-wide search passes it and reports nothing.
    const prose = entry("prose-only citation", "The provenance section requires:", IN_SECTION_5);
    expect(rulesFor(prose)).toEqual(["defects.entry-citation-unresolvable"]);
  });

  test("the same entry with the section cited by number passes, which is what makes that a finding", () => {
    // Paired with the test above: the failure is about the citation and not
    // about the quotation, and this is the assertion that establishes it.
    expect(rulesFor(entry("cites the section", "§5 requires:", IN_SECTION_5))).toEqual([]);
  });

  test("a citation carrying a gloss resolves on the number and ignores the rest", () => {
    // §10: "a citation may carry a gloss its heading does not, so resolve on the
    // section number and ignore the rest of the reference. An implementation
    // that compares the whole rendered citation manufactures the unresolvable
    // case it then has to fail."
    expect(rulesFor(entry("glossed", "§5 (Provenance law) requires:", IN_SECTION_5))).toEqual([]);
  });

  test("a citation to a section that does not exist fails", () => {
    expect(rulesFor(entry("missing section", "§99 requires:", IN_SECTION_5))).toEqual([
      "defects.entry-citation-unresolvable",
    ]);
  });

  test("a quotation that appears nowhere in the cited section fails", () => {
    expect(rulesFor(entry("never resolved", "§5 requires:", "a purple elephant"))).toEqual([
      "defects.entry-quotation-dangling",
    ]);
  });

  test("a quotation that has migrated out of the cited section fails, though the file still holds it", () => {
    // §10: "A quotation that has migrated out of the section the entry names is
    // still somewhere in this file, so a file-wide search passes it -- while the
    // entry now points at a section that does not contain what it quotes, which
    // is the defect rather than an escape from it."
    expect(CONTRACT).toContain(IN_SECTION_12);
    expect(rulesFor(entry("migrated", "§5 requires:", IN_SECTION_12))).toEqual(["defects.entry-quotation-dangling"]);
  });

  test("an entry that quotes nothing fails, and is not skipped for having nothing to compare", () => {
    // §10: "Every entry quotes the instruction it is filed against." Counting
    // quotations alone would let this entry contribute nothing and vanish
    // behind the entries that do.
    expect(rulesFor(entry("unquoted", "Filed against §5.", null))).toEqual(["defects.entry-unquoted"]);
  });

  test("a section named on the line closing the blockquote does not re-scope it", () => {
    // A real defect in the probe this is seeded from: the running section was
    // updated from the closing line before the quotation was flushed, so a
    // mention on that line silently re-scoped the match.
    //
    // The line must be *adjacent* to the blockquote for this to bite. With a
    // blank line between them the flush happens on the blank line and the defect
    // is invisible, which is how the first version of this test passed while
    // holding nothing -- confirmed by mutation: inverting the flush ordering in
    // `quotations` left the blank-line version green.
    //
    // So: §5 is cited before, the quotation is a §12 sentence, and §12 is named
    // on the closing line. Scoped correctly to §5 the quotation is missing and
    // the entry fails; re-scoped to §12 it resolves and the entry passes, which
    // is the generous direction this rule exists to refuse.
    const adjacent = [
      "### closing line names another section",
      "",
      "§5 requires:",
      "",
      `> ${IN_SECTION_12}`,
      "Compare §12.",
      "",
    ].join("\n");
    expect(rulesFor(adjacent)).toEqual(["defects.entry-quotation-dangling"]);

    // The converse, so the assertion above is about the scoping and not about
    // the quotation: the same shape whose quotation really is in §5 passes.
    const benign = [
      "### closing line names another section",
      "",
      "§5 requires:",
      "",
      `> ${IN_SECTION_5}`,
      "Compare §12.",
      "",
    ].join("\n");
    expect(rulesFor(benign)).toEqual([]);
  });

  test("a ## heading ends the entry above it, so later prose is not its body", () => {
    // Entries are delimited by `###`, but a `##` closes one too. Without that,
    // the quotations under a later `##` -- which belong to no entry -- are
    // appended to the last open entry and reported against it.
    const file = [
      defects(entry("open one", "§5 requires:", IN_SECTION_5)),
      "## How to file one",
      "",
      "An example of the shape, quoting a sentence this contract does not have:",
      "",
      "> a purple elephant",
      "",
    ].join("\n");
    const ctx = ctxFor({ [DEFECTS_FILE]: file });
    expect(checkContractDefects(ctx).filter((i) => i.severity === "error")).toEqual([]);

    // And the census agrees it saw one entry with one quotation, so the clean
    // result above is the example being outside the entry rather than the entry
    // being skipped along with it.
    const census = checkContractDefects(ctx).find((i) => i.rule === "defects.entry-population");
    expect(census?.message).toContain("1 open entry");
    expect(census?.message).toContain("1 quotation");
  });

  test("a quotation ahead of any citation is unresolvable, not inherited from a later entry", () => {
    const ahead = [
      ["### quotes before citing", "", `> ${IN_SECTION_5}`, "", "Filed against §5, said afterwards.", ""].join("\n"),
      entry("cites the section", "§5 requires:", IN_SECTION_5),
    ].join("\n");
    expect(rulesFor(ahead)).toEqual(["defects.entry-citation-unresolvable"]);
  });

  test("rewrapping the quoted paragraph is not a change: whitespace is collapsed", () => {
    // §10 states this bar in as many words, and it is the reason the comparison
    // is on the text rather than on the bytes.
    const rewrapped = [
      "> Every adapted file needs a provenance row",
      "> of the form `donor@commit:path`, and that path",
      "> must exist at the pin.",
    ].join("\n");
    const wrapped = ["### rewrapped", "", "§5 requires:", "", rewrapped, "", "Trailing prose.", ""].join("\n");
    expect(rulesFor(wrapped)).toEqual([]);
  });

  test("an elision joins fragments that must each resolve, and in order", () => {
    const ordered = entry(
      "elided",
      "§5 requires:",
      "Every adapted file needs a provenance row [...] must exist at the pin.",
    );
    expect(rulesFor(ordered)).toEqual([]);

    // The same two fragments the other way round did not appear in that order,
    // so an elision that admits them would let an entry quote a sentence the
    // contract never wrote.
    const reversed = entry(
      "elided backwards",
      "§5 requires:",
      "must exist at the pin. [...] Every adapted file needs a provenance row",
    );
    expect(rulesFor(reversed)).toEqual(["defects.entry-quotation-dangling"]);
  });

  test("a subsection is addressable in its own right", () => {
    expect(rulesFor(entry("subsection", "§5.1 requires:", "A row keyed `target:` is skipped by the parser"))).toEqual(
      [],
    );
  });

  test("every failing entry names its own title and the section it cites", () => {
    const ctx = ctxFor({
      [DEFECTS_FILE]: defects(entry("the parser skips target rows", "§5 requires:", "a purple elephant")),
    });
    const issue = checkContractDefects(ctx).find((i) => i.rule === "defects.entry-quotation-dangling");
    expect(issue?.file).toBe(DEFECTS_FILE);
    expect(issue?.message).toContain("the parser skips target rows");
    expect(issue?.message).toContain("§5");
    expect(issue?.message).toContain("purple elephant");
  });
});

describe("the retirement rule's file shape: nothing is marked resolved and left in place", () => {
  test("a preamble and a single ## Open section is the clean shape", () => {
    expect(rulesFor(entry("cites the section", "§5 requires:", IN_SECTION_5))).toEqual([]);
  });

  test("an entry outside ## Open is an error, whatever the section is called", () => {
    // The structural half, which needs no list of words: a second section
    // carrying entries is a second entry list, and §10 permits exactly one.
    const file = [
      defects(entry("open one", "§5 requires:", IN_SECTION_5)),
      "",
      "## Settled",
      "",
      entry("settled one", "§5 requires:", IN_SECTION_5),
    ].join("\n");
    const ctx = ctxFor({ [DEFECTS_FILE]: file });
    const issues = checkContractDefects(ctx).filter((i) => i.rule === "defects.entry-outside-open");
    expect(issues).toHaveLength(1);
    expect(issues[0]?.severity).toBe("error");
    expect(issues[0]?.message).toContain("settled one");
  });

  test("an empty heading for retired entries is an error too", () => {
    // §10: "a heading for retired entries is an invitation to do the thing this
    // rule forbids, and an empty one reads as a claim that nothing has ever
    // been found." An empty section carries no entry, so the structural rule
    // above cannot see it.
    const file = [defects(entry("open one", "§5 requires:", IN_SECTION_5)), "", "## Resolved", ""].join("\n");
    const ctx = ctxFor({ [DEFECTS_FILE]: file });
    const issues = checkContractDefects(ctx).filter((i) => i.rule === "defects.retired-section");
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain("## Resolved");
  });

  test("a section that is neither ## Open nor a retirement heading is left alone", () => {
    // The limit of the word list, stated as a test. This gate rejects a second
    // entry list and a retirement heading; it does not police the file's prose.
    const file = [
      defects(entry("open one", "§5 requires:", IN_SECTION_5)),
      "",
      "## How to file one",
      "",
      "Prose, and no entries.",
      "",
    ].join("\n");
    const ctx = ctxFor({ [DEFECTS_FILE]: file });
    expect(checkContractDefects(ctx).filter((i) => i.severity === "error")).toEqual([]);
  });

  test("an entry above ## Open is outside it, not inside it by being first", () => {
    const file = ["# Contract defects", "", entry("floating", "§5 requires:", IN_SECTION_5), "", OPEN_HEADING, ""].join(
      "\n",
    );
    const ctx = ctxFor({ [DEFECTS_FILE]: file });
    expect(checkContractDefects(ctx).filter((i) => i.rule === "defects.entry-outside-open")).toHaveLength(1);
  });
});

describe("the check says what it examined, because zero failures is not a pass", () => {
  test("the note counts entries and quotations", () => {
    const two = [entry("one", "§5 requires:", IN_SECTION_5), entry("two", "§12 requires:", IN_SECTION_12)].join("\n");
    const ctx = ctxFor({ [DEFECTS_FILE]: defects(two) });
    const census = checkContractDefects(ctx).find((i) => i.rule === "defects.entry-population");
    expect(census?.severity).toBe("note");
    expect(census?.message).toContain("2 open entries");
    expect(census?.message).toContain("2 quotations");
  });

  test("an empty Open section is reported as examining nothing, not as a clean pass", () => {
    const ctx = ctxFor({ [DEFECTS_FILE]: defects("") });
    const census = checkContractDefects(ctx).find((i) => i.rule === "defects.entry-population");
    expect(census?.message).toContain("0 open entries");
    // The word that stops a reader taking silence here for evidence.
    expect(census?.message).toContain("vacuous");
  });
});

describe("the contract and the file are both authorities, and an absent one is said", () => {
  test("no AUTHORING.md is a skip naming the check, not a tree that passed", () => {
    const root = makeTree({
      "catalog.yaml": CATALOG,
      [DEFECTS_FILE]: defects(entry("one", "§5 requires:", IN_SECTION_5)),
    });
    const { catalog } = loadCatalog(root);
    if (catalog === null) throw new Error("fixture has no catalog");
    const issues = checkContractDefects({ root, catalog });
    const skips = issues.filter((i) => i.rule === "defects.contract-unreadable");
    expect(skips).toHaveLength(1);
    expect(skips[0]?.skipped).toBe("defect entry quotations");
    // And no verdict is reported off a contract that was never read.
    expect(issues.filter((i) => i.rule.startsWith("defects.entry-quotation"))).toEqual([]);
  });

  test("no CONTRACT-DEFECTS.md reports nothing: §10 says to create it when there is something to file", () => {
    const ctx = ctxFor({});
    expect(checkContractDefects(ctx)).toEqual([]);
  });

  test("a contract with no numbered sections is a skip, not an entry that cites nothing", () => {
    const ctx = ctxFor({
      "AUTHORING.md": "# Authoring\n\nProse with no numbered headings at all.\n",
      [DEFECTS_FILE]: defects(entry("one", "§5 requires:", IN_SECTION_5)),
    });
    const issues = checkContractDefects(ctx);
    expect(issues.filter((i) => i.rule === "defects.contract-unreadable")).toHaveLength(1);
    expect(issues.filter((i) => i.severity === "error")).toEqual([]);
  });
});

describe("the section index is built from the contract's own headings", () => {
  test("a subsection's text is inside its parent's, so a parent citation resolves it", () => {
    const index = contractSections(CONTRACT);
    expect(index.duplicates).toEqual([]);
    expect([...index.sections.keys()].sort()).toEqual(["12", "5", "5.1"]);
    expect(index.sections.get("5")).toContain("A row keyed `target:` is skipped");
    expect(index.sections.get("5.1")).toContain("A row keyed `target:` is skipped");
    expect(index.sections.get("12")).not.toContain("A row keyed `target:` is skipped");
    // And the other direction, which is the same rule read downwards: a section
    // stops at the next heading at its own level or above, so §5.1 does not
    // reach past its parent into §12.
    expect(index.sections.get("5.1")).not.toContain("A protocol is shared phase logic");
  });

  test("a repeated section number refuses rather than last-wins merging a quotation fingerprint", () => {
    // AT-15 through the defects path, not only the heading helper. The
    // quotation is the entry's fingerprint. It is unique to the *second* §5,
    // so a last-wins Map.set would resolve it and report nothing.
    const duplicated = [
      "# Authoring",
      "",
      "## 5. Provenance law",
      "",
      IN_SECTION_5,
      "",
      "## 5. Bodies",
      "",
      IN_SECTION_12,
      "",
    ].join("\n");
    const ctx = ctxFor({
      "AUTHORING.md": duplicated,
      [DEFECTS_FILE]: defects(entry("last-wins bait", "§5 requires:", IN_SECTION_12)),
    });
    expect(contractSections(duplicated).duplicates).toEqual([{ number: "5", lines: [3, 7] }]);
    const issues = checkContractDefects(ctx);
    const errors = issues.filter((i) => i.severity === "error");
    expect(errors.map((i) => i.rule).toSorted()).toEqual([
      "defects.duplicate-section-number",
      "defects.entry-citation-unresolvable",
    ]);
    expect(errors.find((i) => i.rule === "defects.duplicate-section-number")?.file).toBe("AUTHORING.md");
    expect(errors.find((i) => i.rule === "defects.duplicate-section-number")?.message).toMatch(/§5 appears 2 times/);
    expect(issues.filter((i) => i.rule === "defects.entry-quotation-dangling")).toEqual([]);
  });

  test("a duplicate number and an unrelated bad quotation are both reported", () => {
    const mixed = [
      "# Authoring",
      "",
      "## 5. Provenance law",
      "",
      IN_SECTION_5,
      "",
      "## 5. Duplicate",
      "",
      "other",
      "",
      "## 12. Bodies",
      "",
      IN_SECTION_12,
      "",
    ].join("\n");
    const ctx = ctxFor({
      "AUTHORING.md": mixed,
      [DEFECTS_FILE]: defects(
        [entry("dup", "§5 requires:", IN_SECTION_5), entry("bad", "§12 requires:", "not in the contract")].join("\n"),
      ),
    });
    const rules = checkContractDefects(ctx)
      .filter((i) => i.severity === "error")
      .map((i) => i.rule)
      .toSorted();
    expect(rules).toEqual([
      "defects.duplicate-section-number",
      "defects.entry-citation-unresolvable",
      "defects.entry-quotation-dangling",
    ]);
  });

  test("a numbered heading inside a fenced sample is not a contract section", () => {
    const fenced = [
      "# Authoring",
      "",
      "## 5. Provenance law",
      "",
      IN_SECTION_5,
      "",
      "````",
      "```ts",
      "## 5. Bodies",
      IN_SECTION_12,
      "```",
      "````",
      "",
      "## 12. Bodies",
      "",
      IN_SECTION_12,
      "",
    ].join("\n");
    const index = contractSections(fenced);
    expect(index.duplicates).toEqual([]);
    expect([...index.sections.keys()].toSorted()).toEqual(["12", "5"]);
    expect(rulesFor(entry("cites five", "§5 requires:", IN_SECTION_5), fenced)).toEqual([]);
  });
});

describe("against the repository's own contract and defects file", () => {
  const repo = join(import.meta.dir, "..");

  function realCtx(defectsBody: string) {
    const root = makeTree({
      "catalog.yaml": readFileSync(join(repo, "catalog.yaml"), "utf8"),
      "AUTHORING.md": readFileSync(join(repo, "AUTHORING.md"), "utf8"),
      [DEFECTS_FILE]: defectsBody,
    });
    const { catalog } = loadCatalog(root);
    if (catalog === null) throw new Error("fixture has no catalog");
    return { root, catalog };
  }

  /** A sentence §10 genuinely contains, taken from the contract at run time. */
  function quotableFromSectionTen(): string {
    const index = contractSections(readFileSync(join(repo, "AUTHORING.md"), "utf8"));
    expect(index.duplicates).toEqual([]);
    const section = index.sections.get("10");
    if (section === undefined) throw new Error("AUTHORING.md has no §10");
    const line = section.split("\n").find((l) => l.trim().length > 60 && !l.startsWith("#") && !l.startsWith(">"));
    if (line === undefined) throw new Error("§10 has no quotable line");
    return line.trim();
  }

  test("the repository's own CONTRACT-DEFECTS.md passes", () => {
    const ctx = realCtx(readFileSync(join(repo, "CONTRACT-DEFECTS.md"), "utf8"));
    expect(checkContractDefects(ctx).filter((i) => i.severity === "error")).toEqual([]);
  });

  test("the repository contract has unique section numbers", () => {
    const index = contractSections(readFileSync(join(repo, "AUTHORING.md"), "utf8"));
    expect(index.duplicates).toEqual([]);
  });

  test("an entry against the real §10 resolves, and the same entry with one word changed does not", () => {
    // The paired control. The pass above depends on the current Open section
    // contents rather than proving the section empty; these two are the evidence.
    const real = quotableFromSectionTen();
    expect(
      checkContractDefects(realCtx(defects(entry("real", "§10 requires:", real)))).filter(
        (i) => i.severity === "error",
      ),
    ).toEqual([]);

    const altered = `${real} And one sentence the contract does not contain.`;
    const issues = checkContractDefects(realCtx(defects(entry("altered", "§10 requires:", altered)))).filter(
      (i) => i.severity === "error",
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]?.rule).toBe("defects.entry-quotation-dangling");
  });

  test("a real §10 sentence filed against §12 fails, because the scope is the cited section", () => {
    const real = quotableFromSectionTen();
    const issues = checkContractDefects(realCtx(defects(entry("misfiled", "§12 requires:", real)))).filter(
      (i) => i.severity === "error",
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]?.rule).toBe("defects.entry-quotation-dangling");
  });

  test("the check is live against the repository itself, not only against a copy", () => {
    const { catalog } = loadCatalog(repo);
    if (catalog === null) throw new Error("the repository has no readable catalog");
    const issues = checkContractDefects({ root: repo, catalog });
    expect(issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(issues.filter((i) => i.rule === "defects.contract-unreadable")).toEqual([]);
  });
});
