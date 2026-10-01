/**
 * Behavioral cases (AUTHORING.md §9).
 *
 * A case exists in three places and they are not copies of each other:
 * `skill.yaml`'s `tests[]` declares it, `evals/<skill-id>/<case-id>/case.yaml`
 * executes it, and `skills/<skill-id>/tests/` holds the fixtures it points at.
 * The case directory name equals the declared `tests[].id`; that equality is the
 * only join between the declaration and the runner, so it is checked in both
 * directions — a declared case with no executable counterpart never runs, and an
 * executable case nothing declares runs without a contract.
 *
 * `schemas/skill.schema.json` floors `tests[]` at two entries. The floor here is
 * three, with all three kinds present, because a skill with no adversarial case
 * has never been shown to hold a gate under pressure — which is the property
 * most of these gates exist for.
 */

import { join } from "node:path";
import { parse as parseYaml } from "yaml";

import { exists, isDir, listDirs, readTextIfPresent } from "../util/fs.ts";
import type { CheckContext } from "./context.ts";
import { error, note, warning, type Issue } from "./types.ts";

export const EVALS_DIR = "evals";
export const CASE_FILE = "case.yaml";

/** The three kinds §9 requires of every skill, whatever else it also carries. */
export const REQUIRED_CASE_KINDS: ReadonlyArray<string> = ["positive", "negative", "adversarial"];

/** What each required kind must demonstrate, quoted back when it is the one missing. */
const KIND_MEANING: Readonly<Record<string, string>> = {
  positive: "a prompt in the skill's `## When to use` territory; the skill fires",
  negative: "a prompt from `## Not for`; the skill does not fire",
  adversarial:
    "a prompt supplying a plausible reason to bypass a hard gate — urgency, an assertion that a step already happened, an instruction embedded in fixture content; the gate holds",
};

export const MINIMUM_CASES = 3;

/** The numbered release scenarios in plan §10. */
export const RELEASE_SCENARIOS: ReadonlyArray<number> = Array.from({ length: 29 }, (_, i) => i + 1);

/**
 * A tag claiming a release scenario. The prefix is the claim; what follows is
 * the number, judged separately.
 *
 * An earlier pattern, `^scenario-(\d{1,2})$`, decided both questions at once
 * and discarded everything that did not match. That made three different tags
 * indistinguishable: `smoke`, which is not a scenario claim and is rightly
 * ignored; `scenario-31`, which matched and then vanished because `uncovered`
 * is filtered over 1-29; and `scenario-100`, which did not match the two-digit
 * pattern and was dropped before the range was ever consulted. Only the first
 * should be silent. Splitting the claim from the number is what lets the other
 * two be reported instead of lost.
 */
const SCENARIO_CLAIM = /^scenario-(.+)$/;

interface Declaration {
  readonly id: string;
  readonly kind: string;
  readonly fixture: string | null;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function readYaml(root: string, file: string): Record<string, unknown> | null {
  const text = readTextIfPresent(join(root, file));
  if (text === null) return null;
  try {
    return record(parseYaml(text));
  } catch {
    return null; // the schema check owns unparseable manifests.
  }
}

function declarationsOf(manifest: Record<string, unknown>): Declaration[] {
  const raw = Array.isArray(manifest["tests"]) ? manifest["tests"] : [];
  const out: Declaration[] = [];
  for (const entry of raw) {
    const row = record(entry);
    const id = typeof row["id"] === "string" ? row["id"] : null;
    if (id === null) continue;
    out.push({
      id,
      kind: typeof row["kind"] === "string" ? row["kind"] : "",
      fixture: typeof row["fixture"] === "string" ? row["fixture"] : null,
    });
  }
  return out;
}

export interface ScenarioTags {
  /** Claims naming a scenario in `RELEASE_SCENARIOS`. */
  readonly covered: number[];
  /** Claims that name none, kept verbatim so the report can quote what was typed. */
  readonly rejected: string[];
  /**
   * Claims that name a scenario but not the way the number is written, as
   * `[what was typed, what it should be]`.
   *
   * Coverage is unaffected -- `Number("06")` is 6 and always was -- so this is
   * not a correctness defect in any check. It is a defect in what the corpus
   * can be read with. A tree carrying both spellings of one scenario answers
   * `grep scenario-6` with a subset and looks, from the output, exactly like a
   * tree that has only that subset.
   */
  readonly noncanonical: ReadonlyArray<readonly [string, string]>;
}

/** The release-scenario claims a case carries, split by whether they name one. */
export function scenarioTags(caseDoc: Record<string, unknown>): ScenarioTags {
  const tags = Array.isArray(caseDoc["tags"]) ? caseDoc["tags"] : [];
  const covered: number[] = [];
  const rejected: string[] = [];
  const noncanonical: Array<readonly [string, string]> = [];
  for (const tag of tags) {
    if (typeof tag !== "string") continue;
    const raw = tag.trim();
    const claim = SCENARIO_CLAIM.exec(raw)?.[1];
    if (claim === undefined) continue; // not a scenario claim; some other tag.
    const scenario = /^\d+$/.test(claim) ? Number(claim) : Number.NaN;
    if (!RELEASE_SCENARIOS.includes(scenario)) {
      rejected.push(raw);
      continue;
    }
    covered.push(scenario);
    if (claim !== String(scenario)) noncanonical.push([raw, `scenario-${scenario}`] as const);
  }
  return { covered, rejected, noncanonical };
}

/** One group of cases that assert the same decisive text. */
interface TextGroup {
  readonly field: string;
  readonly text: string;
  readonly paths: Set<string>;
}

/** One group of cases carrying the same case directory name and grader name. */
interface NameGroup {
  readonly caseId: string;
  readonly grader: string;
  readonly paths: Set<string>;
}

/** What the coverage note counted, so it can say so. */
interface Coverage {
  readonly scenarios: Set<number>;
  cases: number;
  /** A decisive field and its normalized text -> the cases asserting it. See `graderKeys`. */
  readonly byDecisiveText: Map<string, TextGroup>;
  /** A case directory name and a grader name -> the cases carrying both. See the second key below. */
  readonly byNames: Map<string, NameGroup>;
}

/** What decides a grader, and whether that field is text somebody writes per case. */
interface DecisiveField {
  readonly field: string;
  readonly free: boolean;
}

/**
 * The field each grader type is decided by.
 *
 * AUTHORING.md §9 specifies each grader type's fields. This table records the
 * one field each type is decided by and refuses a type with no row.
 *
 * `llm`'s field was `expected_outcome` here until the host was run against the
 * corpus for the first time and rejected every case: `claude plugin eval`
 * requires `criteria` and refuses `expected_outcome` as an unrecognized key,
 * so 87 of 87 shipped cases failed to load. This table, §9 and
 * `case.schema.json` had agreed with each other about a name the runner does
 * not accept -- three copies of one unverified reading, which is the number of
 * agreeing sources it takes to look settled. The names here are now what the
 * host accepted at `claude 2.1.278`, not what §9 says.
 *
 * Free text is where repetition means something, because somebody typed it for
 * this case. `tool` is not free text: its vocabulary belongs to the harness,
 * `tool: Skill` is legitimately the same assertion in every skill that has one,
 * and grouping on it would report the corpus as a copy of itself -- the shape
 * that makes a note class unclearable.
 *
 * An unrecognized type is refused rather than defaulted, and the two available
 * defaults are the argument. Read it as free text and a `tool_order` grader
 * groups on a sequence of tool names, which is the corpus-reports-itself
 * failure arriving by another door. Read it as closed and a future free-text
 * type escapes unexamined, which is the `regex` gap this table was written to
 * close, pre-installed. Neither is safe to pick on behalf of someone who has
 * not written the type yet, so whoever introduces it picks, by adding a row.
 */
const DECIDED_BY: Readonly<Record<string, DecisiveField>> = {
  llm: { field: "criteria", free: true },
  regex: { field: "pattern", free: true },
  tool_used: { field: "tool", free: false },
  // A glob and a pair of tool names. Neither is text written per case: `**`
  // with `exists: false` is legitimately the same assertion in every case
  // that forbids a created file, as `tool: Skill` is for `tool_used`.
  file_exists: { field: "path", free: false },
  tool_order: { field: "before", free: false },
};

/** The two keys a case's graders contribute, and the types neither key can read. */
interface GraderKeys {
  /** `[decisive field, normalized value]` for every free-text decisive field. */
  readonly texts: ReadonlyArray<readonly [string, string]>;
  /** Every grader name, whatever the type: half of the second key. */
  readonly names: ReadonlyArray<string>;
  /** `[grader name, type]` for every type `DECIDED_BY` has no row for. */
  readonly unclassified: ReadonlyArray<readonly [string, string]>;
}

/**
 * The keys a case is grouped by.
 *
 * Not the whole grader set, which was the first thing tried and is the wrong
 * instrument: it reports only where every grader matches, and the corpus's
 * actual copies share their heaviest grader and differ in a trailing one. It
 * found nothing in 102 cases while passing its own fixtures, which is a check
 * that exists only in its tests.
 *
 * `name` decides nothing on its own -- a rename is the first edit anybody makes
 * to a copied case -- so it never enters the text key. It enters the second key
 * only in conjunction with the case directory name, where what is reported is
 * two matches at once rather than either.
 *
 * Whitespace normalization is kept and is inert: at `22470e9` the corpus's 256
 * `llm` graders carry 251 distinct expectations read raw and the same 251 read
 * normalized, so nothing here has ever depended on it. It stays because the
 * corpus will not be hand-formatted forever, and an equality that holds today
 * is not a reason to compare two spellings of one sentence as two sentences.
 *
 * An empty value is grouped rather than skipped. The skip that used to be here
 * was justified on the schema permitting an empty `criteria`; it does
 * not -- `common.schema.json#/$defs/nonempty_string` requires `minLength: 1`
 * and a `\S`. So the filter could only ever have acted on a case the schema
 * check already errors on, and what it bought was two checks disagreeing about
 * the same string: one calling it an error, the other quietly dropping it from
 * the population it counts. At `22470e9` no case carries one, so removing it
 * changes nothing in this corpus and the test is what watches that.
 */
function graderKeys(doc: Record<string, unknown>): GraderKeys {
  const texts: Array<readonly [string, string]> = [];
  const names: string[] = [];
  const unclassified: Array<readonly [string, string]> = [];
  const graders = doc["graders"];
  if (!Array.isArray(graders)) return { texts, names, unclassified };
  for (const g of graders) {
    if (typeof g !== "object" || g === null) continue;
    const grader = g as Record<string, unknown>;
    const name = typeof grader["name"] === "string" ? grader["name"] : null;
    if (name !== null) names.push(name);
    const type = grader["type"];
    if (typeof type !== "string") continue; // a grader with no type is the schema check's.
    const decided = DECIDED_BY[type];
    if (decided === undefined) {
      unclassified.push([name ?? "(unnamed)", type] as const);
      continue;
    }
    if (!decided.free) continue;
    const value = grader[decided.field];
    if (typeof value !== "string") continue; // a grader missing its field is the schema check's.
    texts.push([decided.field, value.trim().split(/\s+/).join(" ")] as const);
  }
  return { texts, names, unclassified };
}

/** The skill a case path belongs to: `evals/<skill>/<case-id>/case.yaml`. */
function skillOf(casePath: string): string {
  return casePath.split("/")[1] ?? casePath;
}

/** What a group's text reads as in a message, including when there is none. */
function quoteText(text: string): string {
  if (text === "") return "an empty string";
  return `"${text.length > 90 ? `${text.slice(0, 90)}...` : text}"`;
}

function checkOneSkill(ctx: CheckContext, id: string, coverage: Coverage): Issue[] {
  const issues: Issue[] = [];
  const manifestPath = `skills/${id}/skill.yaml`;
  const manifest = readYaml(ctx.root, manifestPath);
  if (manifest === null) return issues; // no manifest: the completeness and schema checks own it.

  const declared = declarationsOf(manifest);

  const byId = new Map<string, Declaration>();
  for (const decl of declared) {
    if (byId.has(decl.id)) {
      issues.push(
        error(
          "evals.duplicate-case-id",
          manifestPath,
          `tests[] declares '${decl.id}' twice. The id is the join to evals/${id}/<case-id>/, so it identifies exactly one case.`,
        ),
      );
      continue;
    }
    byId.set(decl.id, decl);
  }

  if (declared.length < MINIMUM_CASES) {
    issues.push(
      error(
        "evals.too-few-cases",
        manifestPath,
        `declares ${declared.length} behavioral case(s); AUTHORING.md §9 requires ${MINIMUM_CASES}, one of each of ${REQUIRED_CASE_KINDS.join(", ")}. The schema's minItems of 2 is a floor, not the bar.`,
      ),
    );
  }

  const kinds = new Set(declared.map((d) => d.kind));
  for (const kind of REQUIRED_CASE_KINDS) {
    if (kinds.has(kind)) continue;
    issues.push(
      error(
        "evals.missing-case-kind",
        manifestPath,
        `no case of kind '${kind}': ${KIND_MEANING[kind] ?? "required by AUTHORING.md §9"}.`,
      ),
    );
  }

  // Declaration -> executable case.
  const caseRoot = `${EVALS_DIR}/${id}`;
  for (const decl of byId.values()) {
    const casePath = `${caseRoot}/${decl.id}/${CASE_FILE}`;
    if (!exists(join(ctx.root, casePath))) {
      issues.push(
        error(
          "evals.declaration-without-case",
          casePath,
          `skills/${id}/skill.yaml declares test '${decl.id}' but there is no executable case at this path. A declared case with no counterpart never runs.`,
        ),
      );
    }

    if (decl.fixture === null) continue;
    if (!exists(join(ctx.root, decl.fixture))) {
      issues.push(
        error(
          "evals.fixture-not-found",
          decl.fixture,
          `test '${decl.id}' in skills/${id}/skill.yaml points at this fixture, which does not exist.`,
        ),
      );
      continue;
    }
    if (!decl.fixture.startsWith(`skills/${id}/tests/`)) {
      issues.push(
        warning(
          "evals.fixture-outside-skill",
          decl.fixture,
          `test '${decl.id}' points outside skills/${id}/tests/. §2 puts a skill's fixtures in its own tests/ so the packaged skill carries them.`,
        ),
      );
    }
  }

  // Executable case -> declaration, and the scenario tags each case claims.
  for (const caseId of listDirs(join(ctx.root, caseRoot))) {
    const casePath = `${caseRoot}/${caseId}/${CASE_FILE}`;
    const doc = readYaml(ctx.root, casePath);
    if (doc === null) continue;
    coverage.cases += 1;
    const keys = graderKeys(doc);
    for (const [field, text] of keys.texts) {
      const key = `${field}\u0000${text}`;
      const group = coverage.byDecisiveText.get(key);
      if (group === undefined) coverage.byDecisiveText.set(key, { field, text, paths: new Set([casePath]) });
      else group.paths.add(casePath);
    }
    for (const grader of keys.names) {
      const key = `${caseId}\u0000${grader}`;
      const group = coverage.byNames.get(key);
      if (group === undefined) coverage.byNames.set(key, { caseId, grader, paths: new Set([casePath]) });
      else group.paths.add(casePath);
    }
    for (const [grader, type] of keys.unclassified) {
      issues.push(
        error(
          "evals.grader-type-unclassified",
          casePath,
          `grader \`${grader}\` has type \`${type}\`, which this check has no decisive field for. AUTHORING.md §9 documents the field of three of the five grader types — \`tool\` for \`tool_used\`, \`pattern\` for \`regex\`, \`criteria\` for \`llm\` — and schemas/case.schema.json leaves the grader object open rather than guess the other two. So this check cannot tell whether two graders of this type assert the same thing, and it refuses rather than guess: reading an unknown type as free text would group a sequence of tool names and report the corpus as a copy of itself, and reading it as a closed vocabulary would let a free-text type through unexamined. Add a row to \`DECIDED_BY\` in src/validation/evals.ts naming the field this type is decided by and whether that field is text written per case.`,
        ),
      );
    }
    const tags = scenarioTags(doc);
    for (const scenario of tags.covered) coverage.scenarios.add(scenario);
    for (const raw of tags.rejected) {
      issues.push(
        error(
          "evals.scenario-tag-out-of-range",
          casePath,
          `tag \`${raw}\` claims a release scenario and names none: plan §10 numbers them 1-${RELEASE_SCENARIOS.length}. The claim contributes nothing to coverage, and \`evals.uncovered-scenarios\` runs over 1-${RELEASE_SCENARIOS.length}, so it cannot report the claim either — a case tagged this way reads exactly like a case that was never tagged. Correct the number, or drop the \`scenario-\` prefix if this tag was not meant as a release-scenario claim.`,
        ),
      );
    }
    for (const [raw, canonical] of tags.noncanonical) {
      issues.push(
        warning(
          "evals.scenario-tag-noncanonical",
          casePath,
          `tag \`${raw}\` names release scenario ${canonical.slice("scenario-".length)} with a padded number. It counts toward coverage and every check here reads it correctly, so nothing is broken — what it costs is that the corpus now spells one scenario two ways, and a reader grepping for \`${canonical}\` gets a subset that looks like the whole. Write it \`${canonical}\`.`,
        ),
      );
    }
    if (byId.has(caseId)) continue;
    issues.push(
      error(
        "evals.case-without-declaration",
        casePath,
        `nothing declares this case: skills/${id}/skill.yaml has no tests[] entry with id '${caseId}'. The directory name is the join.`,
      ),
    );
  }

  return issues;
}

export function checkEvals(ctx: CheckContext): Issue[] {
  const issues: Issue[] = [];
  const skillIds = new Set(ctx.catalog.bySection("skills").map((e) => e.id));
  const coverage: Coverage = {
    scenarios: new Set<number>(),
    cases: 0,
    byDecisiveText: new Map(),
    byNames: new Map(),
  };

  for (const id of [...skillIds].sort()) issues.push(...checkOneSkill(ctx, id, coverage));

  if (!isDir(join(ctx.root, EVALS_DIR))) {
    issues.push(
      note(
        "evals.directory-unavailable",
        EVALS_DIR,
        `no ${EVALS_DIR}/; no executable cases to check yet. The built bundle declares this directory as experimental.evals.`,
      ),
    );
    return issues;
  }

  for (const dir of listDirs(join(ctx.root, EVALS_DIR))) {
    if (skillIds.has(dir)) continue;
    issues.push(
      error(
        "evals.unknown-skill-directory",
        `${EVALS_DIR}/${dir}`,
        `${EVALS_DIR}/${dir}/ holds cases for '${dir}', which catalog.yaml declares no skill for. Cases are addressed by skill id.`,
      ),
    );
  }

  // A copied case is not a defect. Seven skills stating one rule need seven
  // cases, because a case runs against a body and there are seven bodies. What
  // it is not is seven tests of the rule, and the only figure in this tree that
  // reads over scenarios -- `evals.uncovered-scenarios` -- counts tag strings,
  // so a copy contributes to coverage exactly as an independent case does. The
  // note exists to make the deflation visible next to the count rather than
  // recoverable only by someone who thinks to hash the graders.
  for (const [, group] of [...coverage.byDecisiveText].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (group.paths.size < 2) continue;
    const sorted = [...group.paths].sort();
    issues.push(
      note(
        "evals.duplicate-graders",
        sorted[0] ?? EVALS_DIR,
        `${sorted.length} cases assert the same \`${group.field}\` — ${quoteText(group.text)} — in ${sorted.join(
          ", ",
        )}. Each runs against its own body, so this is ${sorted.length} tests of ${sorted.length} bodies and one test of the sentence, run ${sorted.length} times. That is the right shape for a rule every body must state; it is the wrong thing to read as ${sorted.length} independent tests of a release scenario, and \`evals.uncovered-scenarios\` counts \`tags:\` and cannot tell the two apart. Nothing here needs fixing — the count does.`,
      ),
    );
  }

  // The second key: the same case directory name and the same grader name, in
  // two different skills. Exact and non-tunable, which is the whole reason it
  // is a conjunction of two names rather than a similarity score over one text
  // -- any threshold would get tuned until it reported nothing, and the tuning
  // would look like calibration.
  //
  // It sees what the text key cannot: a copy whose graders were reworded keeps
  // its directory name and its grader names. It misses what the text key sees:
  // a copy renamed on the way in. The two are different projections of one
  // family and neither contains the other, so each note says what the other one
  // holds rather than leaving a reader to join them.
  for (const [, group] of [...coverage.byNames].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const paths = [...group.paths].sort();
    if (new Set(paths.map(skillOf)).size < 2) continue;

    const related: string[] = [];
    for (const other of coverage.byDecisiveText.values()) {
      if (other.paths.size < 2) continue;
      if (!paths.some((path) => other.paths.has(path))) continue;
      const extra = [...other.paths].filter((path) => !group.paths.has(path)).sort();
      const missing = paths.filter((path) => !other.paths.has(path));
      const also = extra.length === 0 ? "" : ` names ${extra.join(", ")} beside these`;
      const not = missing.length === 0 ? "" : `${also === "" ? " does" : " and does"} not name ${missing.join(", ")}`;
      related.push(
        also === "" && not === ""
          ? `\`evals.duplicate-graders\` reports these same ${paths.length} cases keyed on \`${other.field}\`, so one family is two notes here.`
          : `\`evals.duplicate-graders\` reports an overlapping group keyed on \`${other.field}\` that${also}${not} — neither group contains the other, and they are one family.`,
      );
    }

    issues.push(
      note(
        "evals.duplicate-case-names",
        paths[0] ?? EVALS_DIR,
        `${paths.length} cases in different skills carry the same case directory name and the same grader name — \`${
          group.caseId
        }\` graded by \`${group.grader}\` — in ${paths.join(
          ", ",
        )}. Neither name is evidence alone: directory names repeat because the behavior repeats, and a grader name is a label on a grader rather than a thing it decides. Both matching at once is what a copied case looks like before anyone edits it.${
          related.length === 0 ? "" : ` ${related.join(" ")}`
        } Two limits to read the count with: a copy whose directory was renamed on the way in is invisible to this key, and one copied case produces one note per shared grader name, so the number of notes is not the number of copies. Nothing here needs fixing — what needs reading differently is any count that treats these as independent tests.`,
      ),
    );
  }

  // Reported whenever any case exists: "nothing is covered" before the first
  // case is written is noise, not news.
  if (coverage.scenarios.size > 0) {
    const uncovered = RELEASE_SCENARIOS.filter((n) => !coverage.scenarios.has(n));
    if (uncovered.length > 0) {
      const tagged = RELEASE_SCENARIOS.length - uncovered.length;
      issues.push(
        note(
          "evals.uncovered-scenarios",
          EVALS_DIR,
          // The second sentence used to read "The corpus must cover all 24
          // across the catalog" -- a claim about testing, emitted by a check
          // that counted tag strings. Every reader of a run reporting 17 took
          // it to mean 17 untested and 7 tested, including the people who wrote
          // the corpus. What it counted is stated instead, and what it did not
          // count is stated beside it, because the gap between the two is the
          // whole content of the misreading.
          `release scenarios no case tags: ${uncovered.join(", ")}. Counted: \`scenario-NN\` tag strings across ${
            coverage.cases
          } case ${coverage.cases === 1 ? "file" : "files"}. Not counted: whether a tagged case exercises the scenario it names, or whether any case here has ever run — this repository does not execute the corpus, the host does (\`adapters/runner-contract/CONTRACT.md\`), and a case reduced to its \`tags:\` line alone produces this identical reading. So the ${tagged} ${
            tagged === 1 ? "scenario" : "scenarios"
          } absent from the list above ${tagged === 1 ? "is" : "are"} tagged, not tested.`,
        ),
      );
    }
  }

  return issues;
}
