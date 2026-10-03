/**
 * Protocol, role and domain-pack body shapes (AUTHORING.md §12).
 *
 * §1-§11 describe a `SKILL.md`. Two further body shapes exist, and they are not
 * skills: a protocol is shared phase logic a skill delegates to, a role is a
 * prompt the runner fills a seat with. Neither is an entrypoint, so neither
 * carries host frontmatter and neither has an execution contract of its own —
 * the catalog entry plus the prose is the contract, which is why a
 * `protocol.yaml` or `role.yaml` on disk is an error rather than an extra.
 *
 * A domain pack (§12.6) is a third shape checked here. It is attached to a
 * running phase and never invoked, so it carries no host frontmatter either --
 * but unlike the other two it does have a manifest, `pack.yaml`, which is
 * required rather than forbidden.
 *
 * The section lists are the enforceable half of §12. A missing heading is a
 * missing decision; a forbidden heading means the writer described the wrong
 * thing, so every rejection names what to write instead.
 */

import { join } from "node:path";

import { entryDir, preferredBodyFile, type DirectorySection } from "../catalog/layout.ts";
import { exists, isDir, readTextIfPresent } from "../util/fs.ts";
import { parseFrontmatter } from "../util/frontmatter.ts";
import type { CheckContext } from "./context.ts";
import { error, note, unavailable, type Issue } from "./types.ts";

/** §3's ten headings, in §3's order. The set the other two are described against. */
export const SKILL_SECTIONS: ReadonlyArray<string> = [
  "## When to use",
  "## Not for",
  "## Authority",
  "## Inputs",
  "## Workflow",
  "## Hard gates",
  "## Outputs",
  "## Side effects",
  "## Stop conditions",
  "## Limits",
];

/** §3's ten headings with `## Authority` replaced by `## Invoked by` (§12.1). */
export const PROTOCOL_SECTIONS: ReadonlyArray<string> = [
  "## When to use",
  "## Not for",
  "## Invoked by",
  "## Inputs",
  "## Workflow",
  "## Hard gates",
  "## Outputs",
  "## Side effects",
  "## Stop conditions",
  "## Limits",
];

/** §12.2's role-specific set, in order. `## Rationalizations this seat makes` comes last. */
export const ROLE_SECTIONS: ReadonlyArray<string> = [
  "## What this seat judges",
  "## Not this seat",
  "## What it must be given",
  "## Evidence it must cite",
  "## Never",
  "## What it returns",
  "## When it has nothing to say",
  "## Rationalizations this seat makes",
];

/**
 * §12.6's set, in order. Each of the first six states one member
 * `schemas/pack.schema.json` requires of every pack; the table comes last.
 */
export const PACK_SECTIONS: ReadonlyArray<string> = [
  "## What this pack adds",
  "## Attaches when",
  "## Does not attach when",
  "## Constraints",
  "## Reviewer guidance",
  "## Project facts",
  "## Rationalizations this pack counters",
];

/**
 * Empty, and deliberately so: §3 and §7 forbid a skill body no heading by name.
 *
 * §3 fixes the ten and says extra `##` sections may follow `## Limits`, which
 * the insertion law already enforces -- a heading the contract does not have is
 * either trailing and allowed or inserted and reported, and neither outcome
 * needs a named entry. §7's prohibitions are all on content and behavior
 * (routing terms, placeholders, a second lifecycle entrypoint, repo-local
 * project docs), not on what a section may be called.
 *
 * The other two maps are populated because §12.1 and §12.2 each *reject a named
 * heading with a reason* -- `## Authority` from a protocol, six from a role.
 * §3 has no such sentence. An entry here invented for symmetry would be this
 * file legislating, which is the §10 failure the seating exists to close.
 */
export const SKILL_FORBIDDEN: Readonly<Record<string, string>> = {};

/** Each rejection carries §12's reason, because the heading is a symptom of the wrong model. */
export const PROTOCOL_FORBIDDEN: Readonly<Record<string, string>> = {
  "## Authority":
    "A protocol holds no authority of its own and never widens the authority it was called with. Write `## Invoked by` instead, naming the skills and phase operations that may call it (ruling `entrypoint-phase-operation-split`).",
};

export const ROLE_FORBIDDEN: Readonly<Record<string, string>> = {
  "## Authority":
    "The runner seats a role; a role never self-authorizes, and whether a seat is filled at all is decided by declared risk (ruling `panel-composition-by-declared-risk`).",
  "## Workflow": "A prompt is not a procedure. Procedure belongs to the protocol that convenes the panel.",
  "## Hard gates":
    "A gate stops a workflow and a seat has no workflow to stop. You are describing the protocol that seats this role, not the seat.",
  "## Inputs":
    "A seat states what it must be *given*, which is a contract on its caller; a protocol lists the inputs it consumes. Write `## What it must be given` instead — the difference is who is bound.",
  "## Side effects":
    "A role has none — it judges and returns. Declaring one means work that belongs in a skill or a protocol has been put in a seat.",
  "## Limits": "Folded into `## Never`.",
};

/** §12.6 rejects three headings by name, each because it describes something a pack is not. */
export const PACK_FORBIDDEN: Readonly<Record<string, string>> = {
  "## When to use":
    "A pack has no trigger of its own; it is selected by its activation rules. Write `## Attaches when`, keyed to the `activation.rules` ids in pack.yaml.",
  "## Authority":
    "A pack holds no authority and attaching it authorizes nothing. An authorization its work needs is a constraint of kind `authorization-required` under `## Constraints`.",
  "## Workflow":
    "A pack never starts a phase and has no procedure of its own (policies/invocation.yaml, statement packs-never-start-a-phase). Procedure belongs to the phase it attaches to.",
};

export const ROLE_FORBIDDEN_SECTIONS: ReadonlyArray<string> = Object.keys(ROLE_FORBIDDEN);

/** §3.1's three columns, spelled exactly. */
export const ANTI_RATIONALIZATION_HEADER = "| The thought | Why it is wrong | Do this instead |";
const ANTI_RATIONALIZATION_COLUMNS = ["The thought", "Why it is wrong", "Do this instead"];

/**
 * A `## Never` row §12.2 governs.
 *
 * `clauses` are the row's distinguishing wording, matched against the row with
 * whitespace collapsed and markdown emphasis stripped. Requiring the citation
 * and the clause in the *same* row is what keeps a section that merely mentions
 * both from passing.
 *
 * **This is a floor, not the contract.** The contract is §12.2's own text, read
 * at run time and compared byte-for-byte by `checkMandatedRows`; these clauses
 * are what still runs when §12.2 cannot be read at all. A row satisfying every
 * clause here can still fail that comparison, and should -- `sweep-reviewer`'s
 * case 4 carries both clauses and the citation and states the rule inverted.
 *
 * An earlier version of this comment claimed clause-matching existed to stop a
 * reflowed line break producing a false error. That is no longer true and was
 * the wrong reason besides: §12.2 sets rows 1-3 as blocks and says "byte-for-byte
 * governs a row reproduced as a block", so the wrap points are part of the row
 * and a reflowed row is an error. The sentence misled a reviewer into setting
 * their bar from this file instead of from the contract, and misled a second
 * reader before that, which is why it is recorded here rather than deleted.
 */
export interface GovernedNeverRow {
  /** The ruling the row must cite, or null where §12.2 states the rule itself. */
  readonly ruling: string | null;
  /** Every clause must appear in the row. */
  readonly clauses: ReadonlyArray<string>;
  /** Named in the failure message, so the writer is told which row is missing. */
  readonly description: string;
}

/**
 * The two rows mandatory in all twenty-nine seats.
 *
 * These were previously welded to the two conditional rows below, and each weld
 * carried a seat-specific half the cited ruling does not state. Writers
 * satisfied the verbatim check and absorbed the mismatch in appended per-seat
 * sentences — load-bearing prose that nothing could check. Splitting them turns
 * that prose into set equality.
 */
export const UNIVERSAL_NEVER_ROWS: ReadonlyArray<GovernedNeverRow> = [
  {
    ruling: "closure-requires-independent-verification",
    clauses: ["independent verification closes a finding"],
    description:
      "Only independent verification closes a finding: reading a patch is the author's confidence, not a receipt.",
  },
  {
    ruling: "required-lane-failure-is-unavailable",
    clauses: ["lane that could not run", "unavailable"],
    description: "A lane that could not run returns `unavailable` — a result, not an absence, and never backfilled.",
  },
];

/** Kept for the callers that only need the citations. */
export const MANDATORY_NEVER_RULINGS: ReadonlyArray<string> = UNIVERSAL_NEVER_ROWS.values()
  .map((row) => row.ruling)
  .filter((ruling): ruling is string => ruling !== null)
  .toArray();

/** What non-producing seats say: they judge, and judging is all they do. */
export const AUTHORSHIP_PLAIN_ROW: GovernedNeverRow = {
  ruling: null,
  clauses: ["never edits", "judges and returns"],
  description: 'the plain authorship row, "never edits: it judges and returns"',
};

/**
 * What the producing seats say instead: they name what they write, and then
 * rule out the outputs that would let them mark their own work.
 */
export const AUTHORSHIP_CONVERSE_ROW: GovernedNeverRow = {
  ruling: null,
  clauses: ["a finding, a receipt, a review record or a ticket", "never closes or approves what it produced"],
  description:
    "the converse authorship row, naming what this seat writes and ruling out a finding, a receipt, a review record or a ticket",
};

/**
 * The seats that produce an artifact rather than a judgment.
 *
 * A closed list from §12.2, held here rather than read off the bodies on
 * purpose: a check that learned which seats produce by reading the seats and
 * then verified the seats against what it learned could never fail.
 */
export const PRODUCING_SEATS: ReadonlyArray<string> = ["implementer", "plan-review/planner", "verifier"];

/**
 * Standards grounding, carried by the two seats that judge against a project
 * standard. §12.2 states it directly, so it cites no ruling and none is
 * required — `policies` is still ruling on whether a row should exist.
 */
export const STANDARDS_GROUNDING_ROW: GovernedNeverRow = {
  ruling: null,
  clauses: ["cites an actual project rule or returns empty", "never an invented preference"],
  description:
    'the standards-grounding row, "cites an actual project rule or returns empty; an absent standard is never an invented preference"',
};

/** The seat §12.2 names, because it carries no tier of its own to derive from. */
export const NAMED_STANDARDS_SEATS: ReadonlyArray<string> = ["reviewer-standards"];

/** Every other standards seat comes from the catalog, so a batch-2 seat picks the row up by declaring it. */
export const STANDARDS_GATE_TIER = "standards-gate";

/**
 * §12.2's counterpart table lives in AUTHORING.md, and this is the only copy of
 * its shape.
 *
 * The families are not derivable. `code-review/security` pairs with
 * `doc-review/security-lens` on a shared prefix, but `plan-review/critic` pairs
 * with `code-review/adversarial` on nothing a string comparison can see. So the
 * table is a declaration, and the checker reads it rather than keeping a second
 * copy — two hand-maintained statements of the same fact is the drift shape
 * `universal:` and `entrypoint-count-mismatch` exist to close.
 */
export const COUNTERPART_TABLE_HEADER = "| Seat | Counterpart at another layer |";

const AUTHORING_FILE = "AUTHORING.md";

/** A backticked catalog-id-shaped token: kebab segments, optionally panel-qualified. */
const BACKTICKED_ID = /`([a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)*)`/g;

/** The sidecar that must not exist, by section. */
const FORBIDDEN_SIDECAR: Readonly<Record<string, string>> = {
  protocols: "protocol.yaml",
  roles: "role.yaml",
};

/** The manifest a domain pack must have (§12.6); the inverse of a forbidden sidecar. */
export const PACK_MANIFEST = "pack.yaml";

/** Why a body of this section carries no frontmatter, for `body.frontmatter-forbidden`. */
const NO_FRONTMATTER: Readonly<Record<string, string>> = {
  protocols:
    "a protocol carries no frontmatter: it is not an entrypoint, and the packager emits none (policies/invocation.yaml, statement protocols-and-roles-are-not-entrypoints).",
  roles:
    "a role carries no frontmatter: it is not an entrypoint, and the packager emits none (policies/invocation.yaml, statement protocols-and-roles-are-not-entrypoints).",
  packs:
    "a domain pack carries no frontmatter: it is attached, never invoked, and the packager emits none (policies/invocation.yaml, statement packs-never-start-a-phase). What it declares belongs in pack.yaml.",
};

interface Section {
  readonly heading: string;
  readonly line: number;
  readonly text: string;
}

/** Split a markdown body into its `##` sections, in file order. */
export function splitSections(text: string): Section[] {
  const lines = text.split("\n");
  const out: Section[] = [];
  let current: { heading: string; line: number; body: string[] } | null = null;
  let fenced = false;
  for (const [i, raw] of lines.entries()) {
    const line = raw ?? "";
    if (/^\s*```/.test(line)) fenced = !fenced;
    if (!fenced && line.startsWith("## ")) {
      if (current !== null) out.push({ heading: current.heading, line: current.line, text: current.body.join("\n") });
      current = { heading: line.trimEnd(), line: i + 1, body: [] };
      continue;
    }
    current?.body.push(line);
  }
  if (current !== null) out.push({ heading: current.heading, line: current.line, text: current.body.join("\n") });
  return out;
}

function hasAntiRationalizationTable(text: string): boolean {
  for (const line of text.split("\n")) {
    if (!line.trim().startsWith("|")) continue;
    const cells = line
      .split("|")
      .map((c) => c.trim())
      .filter((c) => c.length > 0);
    if (
      cells.length === 3 &&
      cells.every((c, i) => c.toLowerCase() === (ANTI_RATIONALIZATION_COLUMNS[i] as string).toLowerCase())
    ) {
      return true;
    }
  }
  return false;
}

/** A markdown ruling citation: the word `ruling` followed by the bare id in backticks (§6). */
export function citedRulings(text: string): string[] {
  const out: string[] = [];
  const pattern = /\bruling\s+`([a-z0-9][a-z0-9-]*)`/g;
  for (const match of text.matchAll(pattern)) if (match[1] !== undefined) out.push(match[1]);
  return out;
}

/**
 * The rows of a `## Never` section, each with its wrapping undone.
 *
 * A row is a list item — `1.`, `-` or `*` — and everything indented under it.
 * Emphasis and backticks are stripped and whitespace collapsed so a clause
 * matches wherever the author happened to break the line.
 */
export function neverRows(text: string): string[] {
  return listItems(text)
    .map(normalizeRow)
    .filter((row) => row.length > 0);
}

/**
 * The list items of a section, each with its wrapping undone and its markup
 * intact.
 *
 * `neverRows` normalises away backticks, which is right for matching a clause
 * and wrong for `## Not this seat`, where whether a token was backticked is the
 * whole signal.
 */
export function listItems(text: string): string[] {
  const rows: string[] = [];
  let current: string[] | null = null;
  let fenced = false;
  for (const raw of text.split("\n")) {
    const line = raw ?? "";
    if (/^\s*```/.test(line)) fenced = !fenced;
    if (!fenced && /^\s*(?:\d+\.|[-*])\s+/.test(line)) {
      if (current !== null) rows.push(current.join(" "));
      current = [line.replace(/^\s*(?:\d+\.|[-*])\s+/, "")];
      continue;
    }
    if (current !== null) current.push(line);
  }
  if (current !== null) rows.push(current.join(" "));
  return rows
    .values()
    .map((row) => row.replace(/\s+/g, " ").trim())
    .filter((row) => row.length > 0)
    .toArray();
}

function normalizeRow(text: string): string {
  return text.replace(/[`*_]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
}

/** A row satisfies a governed row when it carries the citation, if any, and every clause. */
function rowMatches(row: string, governed: GovernedNeverRow): boolean {
  if (governed.ruling !== null && !row.includes(`ruling ${governed.ruling}`)) return false;
  return governed.clauses.every((clause) => row.includes(normalizeRow(clause)));
}

function carries(rows: ReadonlyArray<string>, governed: GovernedNeverRow): boolean {
  return rows.some((row) => rowMatches(row, governed));
}

/** A markdown list marker at the head of a line: `1.`, `-` or `*`. */
const LIST_MARKER = /^\s*(?:\d+\.|[-*])\s+/;

/**
 * §12.2's two anchors, and the bar each block carries.
 *
 * The row text itself is deliberately *not* here. `clauses` above is a floor —
 * it asks whether two substrings appear somewhere in a row, and `ed81a69`
 * narrowed row 2 in all twenty-nine bodies without moving that floor at all:
 * the sweep that restored the four dropped clauses changed no validate output,
 * before or after. The floor cannot be raised by writing the row out here
 * either, because a second copy of a mandated row is the drift shape the rest of
 * this file exists to close. So the contract is read from AUTHORING.md at run
 * time and the bodies are compared against it, which makes §12.2 the single
 * statement of what the row says.
 */
const MANDATORY_ANCHOR = "**Mandatory, verbatim in every role body:**";
const CONDITIONAL_ANCHOR = "**Conditional, required exactly where the condition holds:**";

/** The name under which this gate reports itself unable to run. */
const MANDATED_ROWS_CHECK = "mandated role rows";

/**
 * How closely a body must reproduce a mandated row.
 *
 * §12.2 states the distinction in as many words: "Byte-for-byte governs a row
 * reproduced as a block; a row quoted inside a sentence is punctuated to its
 * host." Rows 1-3 are set as blocks there, so their wording and their line
 * breaks are both governed. Row 4 is a quotation embedded in a sentence, so a
 * body that bolds its lead clause or ends it with a period where §12.2 uses a
 * semicolon is not in breach -- and a byte bar there would fail both seats that
 * carry the row today.
 */
type RowBar = "block" | "quoted";

interface MandatedRow {
  /** Which population carries it, used to pick the seats and to count them. */
  readonly scope: "universal" | "plain-authorship" | "standards";
  readonly label: string;
  /** Rows 1-2 are found by the ruling they cite; rows 3-4 by their opening clause. */
  readonly ruling: string | null;
  readonly locator: string;
  readonly expected: string;
  readonly bar: RowBar;
}

/** The list items of a section as blocks: raw lines, wrap points intact. */
function listBlocks(text: string): string[][] {
  const out: string[][] = [];
  let current: string[] | null = null;
  let fenced = false;
  for (const raw of text.split("\n")) {
    if (/^\s*```/.test(raw)) fenced = !fenced;
    if (!fenced && LIST_MARKER.test(raw)) {
      if (current !== null) out.push(current);
      current = [raw];
      continue;
    }
    if (current !== null && raw.trim() !== "") current.push(raw);
  }
  if (current !== null) out.push(current);
  return out;
}

/**
 * A list item in the form the two sides are compared in: the marker dropped,
 * continuation lines dedented, line breaks kept.
 *
 * The marker goes because a row's position in a seat's `## Never` list is the
 * seat's to choose -- §12.2 mandates the text, never the number. The
 * indentation goes for the same reason: it follows from the marker's width, so
 * a body that writes its rows as `-` bullets is not thereby in breach. What
 * survives is the wording and the wrap, which is what "carried as it stands"
 * leaves for a reader to get wrong. All three candidate bars were measured
 * against the tree first, and all three were 29/29 today; this is the one that
 * cannot fail a body over a digit or a bullet character.
 */
function blockForm(lines: ReadonlyArray<string>): string {
  const [first = "", ...rest] = lines;
  return [first.replace(LIST_MARKER, ""), ...rest.map((line) => line.trim())].join("\n");
}

/** Wording without its punctuation or markup: the bar a quoted row is held to. */
function looseForm(text: string): string {
  return text.replace(/[`*"]/g, "").replace(/;/g, ".").replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * The numbered items following an anchor line.
 *
 * The block ends at the first non-blank line flush with the margin that is not
 * itself a numbered item -- the next anchor, or the paragraph that closes the
 * list. Nothing here counts lines or offsets: a section that is edited above
 * moves, and a gate that remembered where §12.2 used to sit would read the
 * wrong text rather than say it could not find it.
 */
function itemsAfter(lines: ReadonlyArray<string>, anchor: string): string[][] {
  const start = lines.findIndex((line) => line.trim() === anchor);
  if (start === -1) return [];
  const out: string[][] = [];
  let current: string[] | null = null;
  for (const raw of lines.slice(start + 1)) {
    if (/^\d+\.\s/.test(raw)) {
      if (current !== null) out.push(current);
      current = [raw];
      continue;
    }
    if (raw.trim() === "") continue;
    if (!/^\s/.test(raw)) break;
    if (current !== null) current.push(raw);
  }
  if (current !== null) out.push(current);
  return out;
}

/** An item's text on one line, for pulling a span out of it. */
function flatten(lines: ReadonlyArray<string>): string {
  return lines.map((line) => line.trim()).join(" ");
}

/**
 * §12.2's mandated rows, read from AUTHORING.md.
 *
 * `null` means the contract could not be read: absent, or present with the
 * block no longer in the shape this reads. Either way the caller reports a
 * check that did not run rather than a tree that passed, because a gate whose
 * only authority has quietly gone is a gate that approves everything.
 */
function mandatedRows(root: string): MandatedRow[] | null {
  const text = readTextIfPresent(join(root, AUTHORING_FILE));
  if (text === null) return null;
  const lines = text.split("\n");

  const universal = itemsAfter(lines, MANDATORY_ANCHOR);
  const conditional = itemsAfter(lines, CONDITIONAL_ANCHOR);
  if (universal.length !== UNIVERSAL_NEVER_ROWS.length || conditional.length !== 2) return null;

  const rows: MandatedRow[] = [];

  // Rows 1-2, paired to their rulings by citation rather than by position, so
  // the order §12.2 sets them in is §12.2's business.
  for (const ruling of MANDATORY_NEVER_RULINGS) {
    const item = universal.find((candidate) => flatten(candidate).includes(ruling));
    if (item === undefined) return null;
    rows.push({
      scope: "universal",
      label: `the universal row citing \`${ruling}\``,
      ruling,
      locator: "",
      expected: blockForm(item),
      bar: "block",
    });
  }

  // Row 3: the bolded sentence that opens the item. The rest of the item is the
  // condition -- which seats carry it -- and is not part of the row.
  const plainBold = /^\*\*(.+?)\*\*/.exec(flatten(conditional[0] ?? []).replace(LIST_MARKER, ""));
  const plain = plainBold?.[1];
  if (plain === undefined) return null;
  rows.push({
    scope: "plain-authorship",
    label: "the plain authorship row",
    ruling: null,
    locator: looseForm(plain),
    expected: `**${plain}**`,
    bar: "block",
  });

  // Row 4: the quotation inside the item's sentence.
  const quoted = /\*"([^"]+)"\*/.exec(flatten(conditional[1] ?? []));
  const standards = quoted?.[1];
  if (standards === undefined) return null;
  rows.push({
    scope: "standards",
    label: "the standards-grounding row",
    ruling: null,
    // Its opening clause only: a body that dropped the second half must still
    // be found, or the gate would report it missing instead of wrong.
    locator: looseForm(standards.split(";")[0] ?? standards),
    expected: standards,
    bar: "quoted",
  });

  return rows;
}

/** The first line on which the contract and the body part company. */
function firstDifference(expected: string, actual: string): { want: string; got: string } {
  const want = expected.split("\n");
  const got = actual.split("\n");
  for (let i = 0; i < Math.max(want.length, got.length); i += 1) {
    if (want[i] === got[i]) continue;
    return { want: want[i] ?? "(the row ends here)", got: got[i] ?? "(the row ends here)" };
  }
  return { want: expected, got: actual };
}

/** How many seats each mandated row was compared against, counted where it happened. */
interface RowPopulation {
  bodies: number;
  universal: number;
  plain: number;
  converse: number;
  standards: number;
}

/**
 * The mandated rows a seat carries.
 *
 * The converse authorship row is absent from this list on purpose: §12.2
 * describes it in prose and never sets it as a row, so there is no contract
 * text to compare a body against. It keeps its clause floor, and the census
 * below says so rather than letting two seats look covered.
 */
function rowsBinding(rows: ReadonlyArray<MandatedRow>, id: string, standardsSeats: ReadonlySet<string>): MandatedRow[] {
  return rows.filter((row) => {
    if (row.scope === "universal") return true;
    if (row.scope === "plain-authorship") return !PRODUCING_SEATS.includes(id);
    return standardsSeats.has(id);
  });
}

/**
 * Compare a seat's `## Never` rows against §12.2's own text.
 *
 * Tolerance goes into *locating* the row and none into comparing it. A row is
 * found by the ruling it cites, or by the clause it opens with, so a body that
 * narrowed or padded one is still recognised as an attempt at it -- and is then
 * held to the contract exactly. A row that cannot be located at all is not
 * reported here: that is an absent row, and the presence checks above own it.
 */
function checkMandatedRows(
  file: string,
  id: string,
  text: string,
  line: number,
  rows: ReadonlyArray<MandatedRow>,
  standardsSeats: ReadonlySet<string>,
  population: RowPopulation,
): Issue[] {
  const issues: Issue[] = [];
  const blocks = listBlocks(text);

  if (PRODUCING_SEATS.includes(id)) population.converse += 1;

  // Counted once per seat per row kind, not once per comparison: the census
  // answers "which seats did this row reach", and the two universal rows reach
  // the same seats.
  const binding = rowsBinding(rows, id, standardsSeats);
  const scopes = new Set(binding.map((row) => row.scope));
  if (scopes.has("universal")) population.universal += 1;
  if (scopes.has("plain-authorship")) population.plain += 1;
  if (scopes.has("standards")) population.standards += 1;

  for (const row of binding) {
    const found =
      row.ruling !== null
        ? blocks.find((block) => flatten(block).includes(row.ruling as string))
        : blocks.find((block) => looseForm(blockForm(block)).includes(row.locator));
    if (found === undefined) continue;

    const actual = blockForm(found);
    const matches = row.bar === "block" ? actual === row.expected : looseForm(actual) === looseForm(row.expected);
    if (matches) continue;

    const diff =
      row.bar === "block"
        ? firstDifference(row.expected, actual)
        : { want: looseForm(row.expected), got: looseForm(actual) };
    issues.push(
      error(
        "role.never-row-not-verbatim",
        file,
        `${id} carries ${row.label}, but not as AUTHORING.md §12.2 sets it. ${
          row.bar === "block"
            ? "§12.2 governs a row reproduced as a block byte-for-byte, so the wording and the line breaks are both part of it."
            : "§12.2 punctuates this row to its host, so the markup and the punctuation are free and the wording is not."
        } §12.2: ${JSON.stringify(diff.want)}; ${id}: ${JSON.stringify(diff.got)}.`,
        line,
      ),
    );
  }

  return issues;
}

/** The census this gate owes: which seats each row was compared against. */
function rowPopulationNote(population: RowPopulation): Issue {
  return note(
    "role.mandated-row-population",
    AUTHORING_FILE,
    `§12.2's mandated rows were compared against the contract across ${population.bodies} role ${
      population.bodies === 1 ? "body" : "bodies"
    }: ${population.universal} for each universal row, ${population.plain} for the plain authorship row, ${
      population.converse
    } for the converse, ${population.standards} for standards grounding. A seat short of its population carried no ## Never row this could find and is reported above. The converse is the one row §12.2 describes in prose instead of setting, so those ${population.converse} are held to its clauses and to no verbatim form; everything else counted here was compared with §12.2's own text.`,
  );
}

function checkSections(
  file: string,
  sections: ReadonlyArray<Section>,
  required: ReadonlyArray<string>,
  forbidden: Readonly<Record<string, string>>,
  /** §3's insertion law, which §12.1 inherits for protocols and §12.2 does not impose on roles. */
  noInsertions: boolean,
): Issue[] {
  const issues: Issue[] = [];
  const present = new Map(sections.map((s) => [s.heading, s]));

  for (const heading of required) {
    if (present.has(heading)) continue;
    issues.push(error("body.missing-section", file, `missing required section ${heading}.`));
  }

  for (const [heading, reason] of Object.entries(forbidden)) {
    const found = present.get(heading);
    if (found === undefined) continue;
    issues.push(error("body.forbidden-section", file, `${heading} does not belong here. ${reason}`, found.line));
  }

  // §3: extra `##` sections may follow the last required heading; none may be
  // inserted between them. A protocol inherits that law with §3's ten headings.
  // A role does not: §12.2 fixes the required set and puts
  // `## Rationalizations this seat makes` last, and says nothing against a seat
  // adding a section of its own in between — the authored seats use one.
  const lastRequired = sections.map((s) => s.heading).reduce((last, h, i) => (required.includes(h) ? i : last), -1);
  for (const [i, section] of noInsertions ? sections.entries() : []) {
    if (i >= lastRequired || required.includes(section.heading) || section.heading in forbidden) continue;
    issues.push(
      error(
        "body.section-inserted",
        file,
        `${section.heading} is inserted between required sections. Extra sections may follow the last required heading, never interrupt them.`,
        section.line,
      ),
    );
  }

  // Order is checked over the required headings that are actually present, so a
  // missing heading is reported once as missing rather than again as misplaced.
  const expected = required.filter((h) => present.has(h));
  const actual = sections
    .values()
    .filter((s) => expected.includes(s.heading))
    .map((s) => s.heading)
    .toArray();
  for (const [i, heading] of actual.entries()) {
    if (expected[i] === heading) continue;
    const at = present.get(heading);
    issues.push(
      error(
        "body.sections-out-of-order",
        file,
        `${heading} appears out of order; the required order is ${expected.join(", ")}.`,
        at?.line,
      ),
    );
    break;
  }

  return issues;
}

function checkOneBody(
  ctx: CheckContext,
  section: DirectorySection,
  id: string,
  standardsSeats: ReadonlySet<string>,
  families: ReadonlyMap<string, ReadonlyArray<string>> | null,
  mandated: ReadonlyArray<MandatedRow> | null,
  population: RowPopulation,
): Issue[] {
  const dir = entryDir(section, id);
  if (!isDir(join(ctx.root, dir))) return [];

  const issues: Issue[] = [];

  const sidecar = FORBIDDEN_SIDECAR[section];
  if (sidecar !== undefined && exists(join(ctx.root, dir, sidecar))) {
    issues.push(
      error(
        "body.sidecar-forbidden",
        `${dir}/${sidecar}`,
        `a ${section === "protocols" ? "protocol" : "role"} has no execution contract of its own; the catalog entry plus the prose is the contract (AUTHORING.md §12). Delete ${sidecar}.`,
      ),
    );
  }

  if (section === "packs" && !exists(join(ctx.root, dir, PACK_MANIFEST))) {
    issues.push(
      error(
        "body.pack-manifest-missing",
        `${dir}/${PACK_MANIFEST}`,
        `a domain pack's activation rules, constraints, reviewer guidance and tests live in ${PACK_MANIFEST}, validated by schemas/pack.schema.json, and without it nothing about this pack is checked (AUTHORING.md §12.6). Write ${PACK_MANIFEST}; a manifest.yaml does not stand in for it.`,
      ),
    );
  }

  if (section === "roles" && id.split("/").length > 2) {
    issues.push(
      error(
        "body.role-nesting-too-deep",
        `${dir}/${preferredBodyFile(section)}`,
        `role id ${id} nests ${id.split("/").length - 1} levels; §12.2 allows at most one (a panel directory and its seats).`,
      ),
    );
  }

  const file = `${dir}/${preferredBodyFile(section)}`;
  const text = readTextIfPresent(join(ctx.root, file));
  if (text === null) return issues; // completeness owns "this body does not exist".

  const front = parseFrontmatter(text);
  // A skill is the one shape that must carry frontmatter: §4 gives a `SKILL.md`
  // the Agent Skills spec keys, and the host loader reads them. Its absence is
  // `frontmatter.missing`, owned by the frontmatter check; only the other
  // shapes are wrong for having it at all.
  const noFrontmatter = NO_FRONTMATTER[section];
  if (front.present && noFrontmatter !== undefined) {
    issues.push(error("body.frontmatter-forbidden", file, noFrontmatter, 1));
  }

  const sections = splitSections(front.present ? front.body : text);
  // §3's law and §12.1's inherit it: ten headings in order, extras only after the
  // last one, and §3.1's table under `## Hard gates`. The two differ by their
  // section list and by what each rejects by name, which is what §12.1 describes
  // itself as -- §3's set with one heading substituted.
  if (section === "skills" || section === "protocols") {
    const skill = section === "skills";
    issues.push(
      ...checkSections(
        file,
        sections,
        skill ? SKILL_SECTIONS : PROTOCOL_SECTIONS,
        skill ? SKILL_FORBIDDEN : PROTOCOL_FORBIDDEN,
        true,
      ),
    );
    const gates = sections.find((s) => s.heading === "## Hard gates");
    if (gates !== undefined && !hasAntiRationalizationTable(gates.text)) {
      issues.push(
        error(
          "body.missing-anti-rationalization-table",
          file,
          `## Hard gates carries no anti-rationalization table. §3.1 requires the three columns ${ANTI_RATIONALIZATION_HEADER} with no prose around them.`,
          gates.line,
        ),
      );
    }
    return issues;
  }

  // §12.6: seven headings in order, the insertion law as for a protocol, and
  // §3.1's table under the last one, as a role carries it.
  if (section === "packs") {
    issues.push(...checkSections(file, sections, PACK_SECTIONS, PACK_FORBIDDEN, true));
    const rationalizations = sections.find((s) => s.heading === "## Rationalizations this pack counters");
    if (rationalizations !== undefined && !hasAntiRationalizationTable(rationalizations.text)) {
      issues.push(
        error(
          "body.missing-anti-rationalization-table",
          file,
          `## Rationalizations this pack counters carries no table. §12.6 requires §3.1's three columns ${ANTI_RATIONALIZATION_HEADER} unchanged.`,
          rationalizations.line,
        ),
      );
    }
    return issues;
  }

  population.bodies += 1;
  issues.push(...checkSections(file, sections, ROLE_SECTIONS, ROLE_FORBIDDEN, false));
  const rationalizations = sections.find((s) => s.heading === "## Rationalizations this seat makes");
  if (rationalizations !== undefined && !hasAntiRationalizationTable(rationalizations.text)) {
    issues.push(
      error(
        "body.missing-anti-rationalization-table",
        file,
        `## Rationalizations this seat makes carries no table. §12.2 requires §3.1's three columns ${ANTI_RATIONALIZATION_HEADER} unchanged.`,
        rationalizations.line,
      ),
    );
  }

  const never = sections.find((s) => s.heading === "## Never");
  // A body with no `## Never` is already reported as a missing section; there is
  // nothing to say about its rows on top of that.
  if (never !== undefined) {
    issues.push(...checkNeverRows(file, id, never.text, never.line, standardsSeats));
    if (mandated !== null) {
      issues.push(...checkMandatedRows(file, id, never.text, never.line, mandated, standardsSeats, population));
    }
  }

  const notThisSeat = sections.find((s) => s.heading === "## Not this seat");
  if (notThisSeat !== undefined) {
    issues.push(...checkPanelMentions(ctx, file, id, notThisSeat.text, notThisSeat.line));
    if (families !== null) issues.push(...checkCounterparts(file, id, notThisSeat.text, notThisSeat.line, families));
  }

  return issues;
}

/**
 * The four governed `## Never` rows: two universal, two conditional on a closed
 * list of seats.
 *
 * Both conditionals are checked as **set equality** rather than presence. The
 * direction that matters is the second one: a seat that produces an artifact
 * while carrying the row saying it never edits is the defect the split exists
 * to catch, and a presence check would pass it.
 */
function checkNeverRows(
  file: string,
  id: string,
  text: string,
  line: number,
  standardsSeats: ReadonlySet<string>,
): Issue[] {
  const issues: Issue[] = [];
  const rows = neverRows(text);

  for (const governed of UNIVERSAL_NEVER_ROWS) {
    if (carries(rows, governed)) continue;
    issues.push(
      error(
        "role.missing-universal-never-row",
        file,
        `${id} does not carry the universal ## Never row citing ruling \`${String(governed.ruling)}\`: ${governed.description} §12.2 mandates both in every seat, and the row must carry the citation and the clause together.`,
        line,
      ),
    );
  }

  const produces = PRODUCING_SEATS.includes(id);
  const required = produces ? AUTHORSHIP_CONVERSE_ROW : AUTHORSHIP_PLAIN_ROW;
  const excluded = produces ? AUTHORSHIP_PLAIN_ROW : AUTHORSHIP_CONVERSE_ROW;
  const producingSeats = PRODUCING_SEATS.join(" and ");

  if (!carries(rows, required)) {
    issues.push(
      error(
        "role.authorship-row-mismatch",
        file,
        `${id} does not carry ${required.description}. ${produces ? `${producingSeats} produce an artifact, so they carry that form` : `Every seat but ${producingSeats} judges without producing, so it carries that form`} (§12.2).`,
        line,
      ),
    );
  }
  if (carries(rows, excluded)) {
    issues.push(
      error(
        "role.authorship-row-mismatch",
        file,
        `${id} carries ${excluded.description}, which belongs to ${produces ? "the seats that only judge" : `${producingSeats} alone`}. ${produces ? `${id} writes an artifact; a seat that produces must not also claim it never edits.` : `${id} produces nothing, so the plain form is the one it carries.`}`,
        line,
      ),
    );
  }

  const groundsInStandards = standardsSeats.has(id);
  const hasStandardsRow = carries(rows, STANDARDS_GROUNDING_ROW);
  if (groundsInStandards && !hasStandardsRow) {
    issues.push(
      error(
        "role.standards-row-mismatch",
        file,
        `${id} judges against a project standard but does not carry ${STANDARDS_GROUNDING_ROW.description}. §12.2 states this row directly, so it cites no ruling.`,
        line,
      ),
    );
  }
  if (!groundsInStandards && hasStandardsRow) {
    issues.push(
      error(
        "role.standards-row-mismatch",
        file,
        `${id} carries ${STANDARDS_GROUNDING_ROW.description}, which belongs to the seats that judge against a project standard: ${[...standardsSeats].sort().join(", ")}. This seat has its own grounding rule to write in its own terms.`,
        line,
      ),
    );
  }

  return issues;
}

/**
 * The seats that judge against a project standard.
 *
 * `reviewer-standards` is named by §12.2 because it carries no tier; every other
 * one is read from the catalog's `tier: standards-gate`, so a batch-2 seat that
 * acquires the tier picks the row up without this file changing. Neither source
 * is the corpus being checked.
 */
function standardsSeatIds(ctx: CheckContext): Set<string> {
  const seats = new Set<string>(NAMED_STANDARDS_SEATS);
  for (const entry of ctx.catalog.bySection("roles")) {
    if (entry.raw["tier"] === STANDARDS_GATE_TIER) seats.add(entry.id);
  }
  return seats;
}

/**
 * §12.2's counterpart families, read out of AUTHORING.md's table.
 *
 * Returns `null` for `families` when AUTHORING.md is absent — nothing to check
 * against, the same way an absent rulings policy resolves no citation. A table
 * that is present but unreadable is a different thing and is reported by the
 * caller: a check whose authority has silently vanished passes everything.
 */
export function counterpartFamilies(root: string): {
  families: Map<string, string[]> | null;
  tablePresent: boolean;
} {
  const text = readTextIfPresent(join(root, AUTHORING_FILE));
  if (text === null) return { families: null, tablePresent: false };

  const lines = text.split("\n");
  const start = lines.findIndex((line) => line.trim() === COUNTERPART_TABLE_HEADER);
  if (start === -1) return { families: null, tablePresent: true };

  const families = new Map<string, string[]>();
  for (const raw of lines.slice(start + 2)) {
    const line = raw.trim();
    if (!line.startsWith("|")) break;
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim());
    const seat = cells[0] === undefined ? [] : [...cells[0].matchAll(BACKTICKED_ID)].map((m) => m[1] ?? "");
    const counterparts = cells[1] === undefined ? [] : [...cells[1].matchAll(BACKTICKED_ID)].map((m) => m[1] ?? "");
    if (seat.length !== 1 || seat[0] === undefined || counterparts.length === 0) continue;
    families.set(seat[0], counterparts);
  }

  return { families: families.size === 0 ? null : families, tablePresent: true };
}

/** The panels in the catalog: the first segment of every qualified role id. */
function panelNames(ctx: CheckContext): Set<string> {
  const panels = new Set<string>();
  for (const entry of ctx.catalog.bySection("roles")) {
    const slash = entry.id.indexOf("/");
    if (slash > 0) panels.add(entry.id.slice(0, slash));
  }
  return panels;
}

function backtickedIds(bullet: string): string[] {
  return [...bullet.matchAll(BACKTICKED_ID)].map((m) => m[1] ?? "");
}

/**
 * The invention half (§12.2): a bullet that names another panel must name a seat
 * in it by catalog id.
 *
 * Scoped by the bullet's *semantics* rather than by token shape, and that is
 * what makes it sound. Role ids, protocol ids and ruling ids are all kebab-case
 * and mutually indistinguishable, so "does this backticked token resolve as a
 * role" would fail a correct protocol citation as readily as an invented seat.
 * A protocol citation never mentions another panel, so it is never examined.
 *
 * The seat's own panel is exempt: §12.2 permits naming a sibling without an id
 * when the id would be the seat's own.
 */
function checkPanelMentions(ctx: CheckContext, file: string, id: string, text: string, line: number): Issue[] {
  const roles = new Set(ctx.catalog.bySection("roles").map((entry) => entry.id));
  const slash = id.indexOf("/");
  const ownPanel = slash > 0 ? id.slice(0, slash) : null;
  const others = [...panelNames(ctx)].filter((panel) => panel !== ownPanel).sort();
  if (others.length === 0) return [];

  const issues: Issue[] = [];
  for (const bullet of listItems(text)) {
    const mentioned = others.filter((panel) => new RegExp(`(?<![A-Za-z0-9-])${panel}(?![A-Za-z0-9])`).test(bullet));
    if (mentioned.length === 0) continue;
    if (backtickedIds(bullet).some((token) => roles.has(token))) continue;
    issues.push(
      error(
        "role.panel-mention-without-seat-id",
        file,
        `${id} has a \`## Not this seat\` bullet naming the ${mentioned.join(" and ")} panel in prose with no seat id in it: "${bullet.slice(0, 110)}". Name the seat by its catalog.yaml id in backticks (§12.2). A description of a seat never has to resolve, which is how an invented counterpart gets written.`,
        line,
      ),
    );
  }
  return issues;
}

/**
 * The omission half (§12.2): every counterpart the table declares for this seat
 * is named in its `## Not this seat`.
 *
 * A writer holding one panel cannot see the other two, so this is the half no
 * reader of a single body can perform. Both defects this catches are invisible
 * in a body that is internally coherent.
 */
function checkCounterparts(
  file: string,
  id: string,
  text: string,
  line: number,
  families: ReadonlyMap<string, ReadonlyArray<string>>,
): Issue[] {
  const required = families.get(id);
  if (required === undefined) return [];

  const named = new Set(listItems(text).flatMap(backtickedIds));
  const missing = required.filter((counterpart) => !named.has(counterpart));
  if (missing.length === 0) return [];

  return [
    error(
      "role.counterpart-not-named",
      file,
      `${id} does not name ${missing.length === 1 ? "its counterpart" : "these counterparts"} ${missing.join(", ")} in \`## Not this seat\`. AUTHORING.md §12.2 declares the family; the entry is required and does not count against the three-or-four budget. Resolve it in catalog.yaml and say what separates the layers.`,
      line,
    ),
  ];
}

/** The table's own coherence: every seat it names exists, and a family reads both ways. */
function checkCounterpartTable(ctx: CheckContext, families: ReadonlyMap<string, ReadonlyArray<string>>): Issue[] {
  const roles = new Set(ctx.catalog.bySection("roles").map((entry) => entry.id));
  const issues: Issue[] = [];

  for (const [seat, counterparts] of [...families].sort(([a], [b]) => a.localeCompare(b))) {
    for (const named of [seat, ...counterparts]) {
      if (roles.has(named)) continue;
      issues.push(
        error(
          "role.counterpart-table-unknown-seat",
          AUTHORING_FILE,
          `§12.2's counterpart table names ${named}, which catalog.yaml does not declare as a role. A family naming a seat that does not exist imposes a requirement no body can satisfy, which is the invention the table exists to prevent.`,
        ),
      );
    }
    for (const counterpart of counterparts) {
      if ((families.get(counterpart) ?? []).includes(seat)) continue;
      issues.push(
        error(
          "role.counterpart-table-asymmetric",
          AUTHORING_FILE,
          `§12.2's table has ${seat} naming ${counterpart}, but not the reverse. A reader with the wrong file open arrives from either side, so ${counterpart} is not told to name ${seat}.`,
        ),
      );
    }
  }

  issues.push(...checkCensusProse(ctx, families.size, roles.size));

  // Symmetry is a property of the rows that are there. It says nothing about the
  // rows that are not, and the table is a hand-maintained census of a set the
  // catalog also holds -- the same shape as `universal:` beside `binds`, and as
  // `count:` beside an entrypoint list. Neither this check nor any other can
  // tell a family that was considered and rejected from one nobody looked for,
  // so the honest thing is to report the coverage rather than imply the census
  // is complete by staying silent.
  issues.push(
    note(
      "role.counterpart-census-coverage",
      AUTHORING_FILE,
      `§12.2's counterpart table declares ${familyCount(families)} ${familyCount(families) === 1 ? "family" : "families"} covering ${families.size} of ${roles.size} catalog roles. A family is a group of mutually-paired seats, so a three-seat family counts once. Symmetry and seat existence are checked; completeness is not checkable, so an undeclared family is invisible here and stays a handback obligation on the batch that authors the seats.`,
    ),
  );

  return issues;
}

/**
 * English cardinals, for the one sentence in §12.2 that states the census in
 * words. A closed list up to the size of the roles section is enough, and a
 * number it cannot read is left alone rather than guessed at.
 */
const CARDINALS: ReadonlyArray<string> = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
  "thirteen",
  "fourteen",
  "fifteen",
  "sixteen",
  "seventeen",
  "eighteen",
  "nineteen",
  "twenty",
  "twenty-one",
  "twenty-two",
  "twenty-three",
  "twenty-four",
  "twenty-five",
  "twenty-six",
  "twenty-seven",
  "twenty-eight",
  "twenty-nine",
  "thirty",
  "thirty-one",
  "thirty-two",
  "thirty-three",
  "thirty-four",
  "thirty-five",
  "thirty-six",
  "thirty-seven",
  "thirty-eight",
  "thirty-nine",
  "forty",
];

const CENSUS_SENTENCE = /\b([A-Za-z-]+) seats? of ([A-Za-z-]+) are named here\b/;

function cardinal(word: string): number | null {
  const index = CARDINALS.indexOf(word.toLowerCase());
  return index === -1 ? null : index;
}

/**
 * How many distinct families the table declares.
 *
 * A family is a connected component of the counterpart graph, not a pair. The
 * adversarial family is three seats that all name each other; counting pairs
 * calls it three families, and the error grows with family size in the
 * direction that makes coverage look better than it is. Components track what
 * the table actually declares: one group of mutually-paired seats, however many
 * seats are in it.
 */
function familyCount(families: ReadonlyMap<string, ReadonlyArray<string>>): number {
  const seen = new Set<string>();
  let count = 0;
  for (const seat of families.keys()) {
    if (seen.has(seat)) continue;
    count++;
    const stack = [seat];
    while (stack.length > 0) {
      const current = stack.pop();
      if (current === undefined || seen.has(current)) continue;
      seen.add(current);
      for (const neighbour of families.get(current) ?? []) if (!seen.has(neighbour)) stack.push(neighbour);
    }
  }
  return count;
}

/**
 * §12.2 states its own coverage in prose, and the sentence is load-bearing: it
 * is what tells a reader the table claims no completeness. So it stays, and the
 * number in it is checked instead of trusted.
 *
 * This is the third instance of one shape -- `universal:` beside `binds`,
 * `count:` beside an entrypoint list, and now a written-out count beside the
 * table it counts. Each one is a claim a reader believes and nothing verified,
 * and each goes stale on the next row added rather than at the moment someone
 * next compares by eye.
 */
function checkCensusProse(ctx: CheckContext, seats: number, roles: number): Issue[] {
  const text = readTextIfPresent(join(ctx.root, AUTHORING_FILE));
  if (text === null) return [];
  // Matched against whitespace-normalised text, because the sentence wraps.
  const match = CENSUS_SENTENCE.exec(text.replace(/\s+/g, " "));
  if (match === null) return [];

  const statedSeats = cardinal(match[1] ?? "");
  const statedRoles = cardinal(match[2] ?? "");
  if (statedSeats === null || statedRoles === null) return [];
  if (statedSeats === seats && statedRoles === roles) return [];

  return [
    error(
      "role.counterpart-census-count-stale",
      AUTHORING_FILE,
      `§12.2 says "${match[0]}", but the table names ${seats} seat(s) and catalog.yaml declares ${roles} role(s). The sentence is what tells a reader the table claims no completeness, so it is the number that is wrong, not the sentence.`,
      lineContaining(text, `${match[1]} seat`) ?? lineContaining(text, "are named here"),
    ),
  ];
}

function lineContaining(text: string, needle: string): number | undefined {
  for (const [index, line] of text.split("\n").entries()) if (line.includes(needle)) return index + 1;
  return undefined;
}

export function checkBodyShapes(ctx: CheckContext): Issue[] {
  const issues: Issue[] = [];
  const standardsSeats = standardsSeatIds(ctx);

  const { families, tablePresent } = counterpartFamilies(ctx.root);
  if (families === null && tablePresent) {
    issues.push(
      error(
        "role.counterpart-table-unreadable",
        AUTHORING_FILE,
        `§12.2's counterpart table could not be read: no rows under \`${COUNTERPART_TABLE_HEADER}\`. The table is this check's only authority, so losing it would let every seat pass with its twin unnamed.`,
      ),
    );
  }
  if (families !== null) issues.push(...checkCounterpartTable(ctx, families));

  const mandated = mandatedRows(ctx.root);
  const population: RowPopulation = { bodies: 0, universal: 0, plain: 0, converse: 0, standards: 0 };

  // Skills and packs join the loop, and `checkOneBody` returns before
  // `population.bodies` for both: that counter is §12.2's role-row census and a skill carries no
  // `## Never` row to compare, nor does a pack. Counting them would report seats this never read.
  for (const section of ["skills", "packs", "protocols", "roles"] as const) {
    for (const entry of ctx.catalog.bySection(section)) {
      issues.push(...checkOneBody(ctx, section, entry.id, standardsSeats, families, mandated, population));
    }
  }

  // Said only once there are role bodies to say it about. A tree with no seats
  // is not a tree this gate failed to read, and reporting a skip there would
  // put a standing "did not look" on every run that has nothing to look at.
  if (population.bodies > 0) {
    issues.push(
      mandated === null
        ? // `unavailable`, not `skipped`: the bodies are all present and it is the
          // contract that could not be read, so this run examined a subject it had
          // no authority for. Reported as a skip it did not reach the exit code,
          // and rewording an anchor turned a tree with a gutted row from exit 1
          // into exit 0 -- this gate failing the row it exists to enforce.
          unavailable(
            "role.mandated-rows-unavailable",
            AUTHORING_FILE,
            MANDATED_ROWS_CHECK,
            `§12.2's mandated rows could not be read from ${AUTHORING_FILE}, so ${population.bodies} role ${
              population.bodies === 1 ? "body was" : "bodies were"
            } not compared against them. The block is found by its anchors \`${MANDATORY_ANCHOR}\` and \`${CONDITIONAL_ANCHOR}\`, each followed by its numbered items. Every seat still ran the clause checks above, which is a floor and not the contract.`,
          )
        : rowPopulationNote(population),
    );
  }

  return issues;
}
