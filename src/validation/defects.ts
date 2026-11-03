/**
 * AUTHORING.md §10's contract-defects rules, as checks rather than as prose.
 *
 * §10 specifies three mechanical behaviours and, at the time this was written,
 * stated in three separate paragraphs that `ak validate` performed none of
 * them. Two are file-state rules over `CONTRACT-DEFECTS.md` and are performed
 * here. The third -- the recorded-revision gate -- is not: it reads a review
 * record's covered files and a notice recorded against a newer revision, and
 * `schemas/review.schema.json` declares neither, so there is nothing in this
 * tree for it to read. That is a missing field, not a missing check, and it is
 * reported rather than approximated.
 *
 * The retirement rule. An entry is retired by deleting it, so the file has one
 * entry list and no second one under any name. §10: "a resolved entry reads
 * exactly like an open one to anything scanning this file", which is why the
 * detector here is on the file's shape and not on an entry's wording.
 *
 * The entry-quotation rule. An open entry's quoted instruction must still
 * resolve in the section it cites, whitespace collapsed, scoped to that section
 * rather than to the file, failing closed when the citation cannot be resolved,
 * and resolving on the section number so a gloss cannot manufacture the
 * unresolvable case. Each of those four clauses is a case §10 argues for
 * explicitly, and three of them are ways a generous implementation passes an
 * entry it should fail.
 *
 * `research/probes/defect-entries.py` is the same comparison as a probe, and
 * keeps the differential backtest over `f04a4d0` that needs git history. This
 * module is an independent implementation of the rule, not a port of that file:
 * agreement between two of them is worth something, and a translation would
 * not be.
 */

import { join } from "node:path";

import { readTextIfPresent } from "../util/fs.ts";
import type { CheckContext } from "./context.ts";
import { fenceAfter, type FenceState } from "./headings.ts";
import { error, note, skipped, unavailable, type Issue } from "./types.ts";

/** §10: the file lives at the repository root, and that placement is the mechanism. */
export const DEFECTS_FILE = "CONTRACT-DEFECTS.md";

/** The one section entries live under. §10: the file has no resolved section. */
export const OPEN_HEADING = "## Open";

const CONTRACT_FILE = "AUTHORING.md";

/** The name under which the quotation comparison reports itself unable to run. */
const QUOTATION_CHECK = "defect entry quotations";

/** A numbered `##` or `###` heading in the contract: the section's own number. */
const CONTRACT_HEADING = /^(#{2,3})\s+(\d+(?:\.\d+)*)[.\s]/;

/**
 * A section reference inside an entry.
 *
 * §10: "resolve on the section number and ignore the rest of the reference. An
 * implementation that compares the whole rendered citation manufactures the
 * unresolvable case it then has to fail." So this captures the number and
 * nothing else, and `§5 (Provenance law)` resolves exactly as `§5` does.
 */
const SECTION_REFERENCE = /§(\d+(?:\.\d+)*)/g;

/**
 * Words that make a heading a place to put retired entries.
 *
 * A belt over the structural brace below, not the main mechanism: a second
 * section *carrying entries* is caught whatever it is called, and needs no list
 * of words. This list exists for the case §10 names separately -- an empty
 * heading, which carries no entry to catch and "reads as a claim that nothing
 * has ever been found".
 */
const RETIREMENT_WORDS = ["resolved", "retired", "closed", "settled", "fixed", "archived", "historical", "done"];

/** Whitespace collapsed, so that rewrapping a paragraph is not a change. */
function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export interface ContractSectionIndex {
  readonly sections: Map<string, string>;
  readonly duplicates: ReadonlyArray<{ readonly number: string; readonly lines: readonly number[] }>;
}

/**
 * Every numbered section of the contract, mapped to its own text.
 *
 * One rule at every depth: a section runs to the next heading at its own level
 * or above. So a subsection's text is inside its parent's, and a citation to the
 * parent resolves a quotation taken from the child -- which is the behaviour
 * §10 needs, since an entry may cite either.
 *
 * A repeated section number is refused (AT-15), never last-wins merged. The
 * duplicated numbers are named and omitted from the map, and quotation checks
 * still run against every other entry. Numbered headings inside fenced code
 * are not sections.
 *
 * Stated that way on purpose. An earlier version carried a second clause capping
 * a `###` at the very next heading whatever its level. It could never fire,
 * because `CONTRACT_HEADING` indexes only `##` and `###` and the next heading is
 * therefore always at a level the rule above already stops on -- and on the day
 * a deeper level was indexed it would have fired and been wrong, truncating a
 * section at its own child.
 */
export function contractSections(text: string): ContractSectionIndex {
  const lines = text.split("\n");
  const marks: Array<{ line: number; level: number; number: string }> = [];
  let fence: FenceState | null = null;
  for (const [index, line] of lines.entries()) {
    const next = fenceAfter(line, fence);
    const skip = fence !== null || next !== null;
    fence = next;
    if (skip) continue;
    const match = CONTRACT_HEADING.exec(line);
    if (match === null) continue;
    marks.push({ line: index, level: (match[1] ?? "").length, number: match[2] ?? "" });
  }

  const occurrences = new Map<string, number[]>();
  for (const mark of marks) {
    const at = occurrences.get(mark.number) ?? [];
    at.push(mark.line + 1);
    occurrences.set(mark.number, at);
  }
  const duplicates: Array<{ number: string; lines: number[] }> = [];
  for (const [number, at] of occurrences) {
    if (at.length > 1) duplicates.push({ number, lines: at });
  }
  const duplicated = new Set(duplicates.map((entry) => entry.number));

  const sections = new Map<string, string>();
  for (const [index, mark] of marks.entries()) {
    if (duplicated.has(mark.number)) continue;
    let end = lines.length;
    for (const later of marks.slice(index + 1)) {
      if (later.level <= mark.level) {
        end = later.line;
        break;
      }
    }
    sections.set(mark.number, lines.slice(mark.line, end).join("\n"));
  }
  return { sections, duplicates };
}

interface Entry {
  readonly title: string;
  readonly line: number;
  readonly section: string | null;
  readonly body: ReadonlyArray<string>;
}

/** A blockquote, paired with the section cited before it began. */
interface Quotation {
  readonly section: string | null;
  readonly text: string;
}

/** The `###` entries of the defects file, each tagged with the `##` it sits under. */
function entries(text: string): Entry[] {
  const out: Entry[] = [];
  let section: string | null = null;
  let current: { title: string; line: number; section: string | null; body: string[] } | null = null;
  for (const [index, line] of text.split("\n").entries()) {
    if (/^##\s/.test(line)) {
      if (current !== null) out.push({ ...current, body: current.body });
      current = null;
      section = line.trim();
      continue;
    }
    if (/^###\s/.test(line)) {
      if (current !== null) out.push({ ...current, body: current.body });
      current = { title: line.slice(4).trim(), line: index + 1, section, body: [] };
      continue;
    }
    if (current !== null) current.body.push(line);
  }
  if (current !== null) out.push({ ...current, body: current.body });
  return out;
}

/**
 * Each blockquote in an entry, paired with the most recent section cited before
 * it began.
 *
 * The pending quotation is flushed *before* the closing line is scanned for
 * references. A section named on the line after a blockquote is not that
 * quotation's section, and updating the running section first would silently
 * re-scope the match to whatever the entry happened to mention last -- which
 * was a real defect in the probe this rule was first written as.
 */
function quotations(body: ReadonlyArray<string>): Quotation[] {
  const out: Quotation[] = [];
  let section: string | null = null;
  let pending: string[] | null = null;
  for (const line of body) {
    if (line.startsWith(">")) {
      (pending ??= []).push(line.replace(/^>\s?/, "").trimEnd());
      continue;
    }
    if (pending !== null) {
      out.push({ section, text: pending.join(" ") });
      pending = null;
    }
    for (const match of line.matchAll(SECTION_REFERENCE)) section = match[1] ?? section;
  }
  if (pending !== null) out.push({ section, text: pending.join(" ") });
  return out;
}

/**
 * Whether every fragment of a quotation appears in the section, in order.
 *
 * `[...]` marks an elision, so the fragments either side of it are separate
 * searches resumed from where the previous one ended. Searching each fragment
 * independently would accept a quotation whose halves the contract states in
 * the other order, which is a sentence the contract never wrote.
 */
function resolvesIn(sectionText: string, quote: string): string | null {
  const haystack = collapse(sectionText);
  let from = 0;
  for (const raw of quote.split("[...]")) {
    const fragment = collapse(raw);
    if (fragment.length === 0) continue;
    const at = haystack.indexOf(fragment, from);
    if (at < 0) return fragment;
    from = at + fragment.length;
  }
  return null;
}

function isRetirementHeading(heading: string): boolean {
  const words = heading.toLowerCase().match(/[a-z]+/g) ?? [];
  return words.some((word) => RETIREMENT_WORDS.includes(word));
}

/** §10's two file-state rules over `CONTRACT-DEFECTS.md`. */
export function checkContractDefects(ctx: CheckContext): Issue[] {
  const defects = readTextIfPresent(join(ctx.root, DEFECTS_FILE));
  // §10 says to create the file when there is something to file, so its absence
  // is the state where nothing has been reported, not a check that could not run.
  if (defects === null) return [];

  const issues: Issue[] = [];
  const found = entries(defects);

  for (const heading of defects
    .split("\n")
    .filter((line) => /^##\s/.test(line))
    .map((line) => line.trim())) {
    if (heading === OPEN_HEADING || !isRetirementHeading(heading)) continue;
    issues.push(
      error(
        "defects.retired-section",
        DEFECTS_FILE,
        `\`${heading}\` is a section for entries that have been ruled on. §10 forbids it: an entry is retired by deleting it in the commit that resolves it, so a heading for retired entries is an invitation to mark one resolved and leave it in place, and an empty one reads as a claim that nothing has ever been found. \`git log -- ${DEFECTS_FILE}\` is where retired entries live.`,
      ),
    );
  }

  for (const entry of found) {
    if (entry.section === OPEN_HEADING) continue;
    issues.push(
      error(
        "defects.entry-outside-open",
        DEFECTS_FILE,
        `the entry "${entry.title}" sits under ${entry.section === null ? "no section" : `\`${entry.section}\``} rather than under \`${OPEN_HEADING}\`. §10 gives this file one entry list: a second one is a resolved section under another name, and an entry outside the list the blocking clause reads is an entry nothing blocks on.`,
        entry.line,
      ),
    );
  }

  const open = found.filter((entry) => entry.section === OPEN_HEADING);
  const contract = readTextIfPresent(join(ctx.root, CONTRACT_FILE));
  const indexed = contract === null ? null : contractSections(contract);

  for (const entry of open) {
    // §10: "Every entry quotes the instruction it is filed against." Counting
    // only quotations would let an entry that carries none contribute nothing
    // and vanish behind the entries that do.
    if (quotations(entry.body).length === 0) {
      issues.push(
        error(
          "defects.entry-unquoted",
          DEFECTS_FILE,
          `the entry "${entry.title}" quotes no instruction, so there is nothing for §10's rule to resolve. An entry records the instruction followed, quoted, and a quotation is the fingerprint that later reveals the entry owes retirement.`,
          entry.line,
        ),
      );
    }
  }

  if (indexed !== null) {
    for (const duplicate of indexed.duplicates) {
      issues.push(
        error(
          "defects.duplicate-section-number",
          CONTRACT_FILE,
          `§${duplicate.number} appears ${duplicate.lines.length} times (lines ${duplicate.lines.join(", ")}); section identity cannot resolve it uniquely. A last-wins map would silently merge them.`,
          duplicate.lines[0],
        ),
      );
    }
  }
  const sections = indexed?.sections ?? null;

  if (sections === null || (sections.size === 0 && (indexed?.duplicates.length ?? 0) === 0)) {
    // Which kind of skip this is depends on whether anything went unexamined.
    // With no open entry the subject is absent and there was nothing to resolve,
    // so the run still passes. With open entries sitting in the tree, they are
    // present and unjudged and only the authority is missing, which is the
    // blocking case -- the same distinction §12.2's anchors turned out to need.
    const reason = `${
      contract === null
        ? `${CONTRACT_FILE} is not in this tree`
        : `${CONTRACT_FILE} has no numbered sections this can index`
    }, so the quotations in ${open.length} open ${
      open.length === 1 ? "entry" : "entries"
    } were not resolved against it. §10 scopes the comparison to the cited section, and a section index that could not be built is the case that rule says to fail closed on rather than widen.`;
    issues.push(
      open.length === 0
        ? skipped(
            "defects.contract-unreadable",
            DEFECTS_FILE,
            QUOTATION_CHECK,
            `${reason} No entry is open, so nothing in this tree went unexamined and the run still passes.`,
          )
        : unavailable("defects.contract-unreadable", DEFECTS_FILE, QUOTATION_CHECK, reason),
    );
    return issues;
  }

  let compared = 0;
  for (const entry of open) {
    for (const quote of quotations(entry.body)) {
      compared += 1;
      // Fail closed. §10: "a checker that widens to the whole file when it
      // cannot find the scope restores the loose behaviour exactly where the
      // entry gave it least to work with."
      if (quote.section === null) {
        issues.push(
          error(
            "defects.entry-citation-unresolvable",
            DEFECTS_FILE,
            `the entry "${entry.title}" quotes ${JSON.stringify(collapse(quote.text).slice(0, 70))} without citing a section by number, so the comparison has no scope. §10 fails such an entry rather than searching the whole of ${CONTRACT_FILE}: a quotation that has migrated out of the section an entry names is still somewhere in the file, and a file-wide search passes exactly the defect this rule exists to find.`,
            entry.line,
          ),
        );
        continue;
      }
      const sectionText = sections.get(quote.section);
      if (sectionText === undefined) {
        issues.push(
          error(
            "defects.entry-citation-unresolvable",
            DEFECTS_FILE,
            `the entry "${entry.title}" cites §${quote.section}, which ${CONTRACT_FILE} does not contain. Either the section was renumbered, in which case the entry and the contract disagree and that needs a ruling, or the citation was never right. Repointing it at the new number is not among the options: it destroys the evidence that anything moved.`,
            entry.line,
          ),
        );
        continue;
      }
      const missing = resolvesIn(sectionText, quote.text);
      if (missing === null) continue;
      issues.push(
        error(
          "defects.entry-quotation-dangling",
          DEFECTS_FILE,
          `the entry "${entry.title}" quotes ${JSON.stringify(missing.slice(0, 90))}, which no longer resolves in §${quote.section}. §10: either the defect was fixed and the entry owes retirement, or the section moved for another reason and the entry now misdescribes the contract. Both need a ruling and neither is the writer's, and repointing the quotation at the new text is not among the options.`,
          entry.line,
        ),
      );
    }
  }

  issues.push(
    note(
      "defects.entry-population",
      DEFECTS_FILE,
      `§10's entry-quotation rule was resolved against ${CONTRACT_FILE} over ${open.length} open ${
        open.length === 1 ? "entry" : "entries"
      } carrying ${compared} ${compared === 1 ? "quotation" : "quotations"}.${
        open.length === 0
          ? ` That run is vacuous: with no open entry there is nothing to resolve, so zero failures is the absence of anything to hold rather than evidence the rule holds. The rule is also blind to a defect resolved from outside this contract, which leaves no fingerprint here for any state check to find.`
          : ` The rule is blind to a defect resolved from outside this contract -- the quotation still resolves and nothing in ${CONTRACT_FILE} moved -- so a clean run here is not a reason to leave an entry alone.`
      }`,
    ),
  );

  return issues;
}
