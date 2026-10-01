/**
 * Ruling citations (AUTHORING.md §6).
 *
 * `policies/resolved-conflicts.yaml` is the only authority for ruling ids. A
 * body that cites an id the policy does not define reads as settled and is not,
 * which is the exact failure the rulings exist to prevent, so a dangling id is
 * an error rather than a broken link.
 *
 * Each row's `binds` block is the inverse: it names the entries the row already
 * decided are governed by it, so an authored body named there that cites nothing
 * is a gap the row itself identified. Only authored bodies are owed a citation —
 * an entry with no file yet is reported by the completeness check, not here.
 *
 * A row without `overrides` is complete. Absence means the sources were
 * reconciled rather than one being overruled, and nothing here treats it as
 * missing data.
 *
 * `universal` is the third direction. A row that governs a whole kind says so
 * once instead of hiding the completeness of a 29-item list, and this file makes
 * the claim binding: the enumeration under `binds` must be exactly that section.
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

import {
  ALL_SECTIONS,
  DIRECTORY_SECTIONS,
  entryBodyPath,
  entryDir,
  entryFilePath,
  isDirectorySection,
  type Section,
} from "../catalog/layout.ts";
import { readTextIfPresent, walkFiles } from "../util/fs.ts";
import { citedRulings } from "./bodies.ts";
import type { CheckContext } from "./context.ts";
import { error, note, unavailable, warning, type Issue } from "./types.ts";

/**
 * The check that reads a body's citations against the resolved-conflicts policy.
 *
 * Named because it is the one check here whose subject survives an unreadable
 * policy file: the bodies are all still in the tree. The row checks below it
 * (`binds`, `universal`, doctrine reachability) take the rows themselves as
 * their subject, and with no rows there is nothing they failed to examine.
 */
const CITATIONS_CHECK = "ruling citations";

export const RULINGS_FILE = "policies/resolved-conflicts.yaml";

/** The vocabulary source for `discharged_in`. Read, never restated -- see `skillSections`. */
const COMMON_SCHEMA = "schemas/common.schema.json";

/** The check that reads each row's `discharged_in` against that vocabulary. */
const DISCHARGE_CHECK = "discharged_in vocabulary";

/** The numbered release scenarios in plan §10. */
export const RELEASE_SCENARIO_COUNT = 29;

/** Markdown trees whose bodies carry §6's inline citations. */
const MARKDOWN_ROOTS = ["skills", "packs", "protocols", "roles", "references", "adapters", "templates", "docs"];
const MARKDOWN_FILES = ["AGENTS.md", "AUTHORING.md", "README.md"];

/** YAML trees whose files carry §6's `ruling:` / `rulings:` keys. */
const YAML_ROOTS = ["policies", "profiles", "skills", "packs"];

const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export interface RulingRow {
  readonly id: string;
  /** catalog kind -> entry ids this row governs. */
  readonly binds: Readonly<Record<string, ReadonlyArray<string>>>;
  /**
   * The kinds this row governs *entirely*. `binds` still enumerates them; this
   * says the enumeration is the whole section rather than a selection from it.
   */
  readonly universal: ReadonlyArray<string>;
  /** The `ruling:` prose itself. The restatement scan measures bodies against it. */
  readonly text: string;
  readonly scenario: number | null;
  /**
   * The SKILL.md sections in which a bound skill may legitimately discharge this
   * row, or empty when the row declared none or declared them unusably.
   *
   * A set rather than one section: a row binds several skills, and one obligation
   * lands in a different section in each -- a refusal condition for one skill is a
   * scope exclusion for another. It is independently derived from the row's prose,
   * so a disagreement with where the bodies actually cite the row is a finding and
   * not a tautology.
   */
  readonly dischargedIn: ReadonlyArray<string>;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/**
 * Every ruling id cited by a YAML document: `ruling: <id>`, `rulings: [<id>]`,
 * and `provenance.resolved_conflicts[]`, wherever they appear in the tree.
 *
 * Parsed rather than matched by regex, so a `ruling:` key whose value is a
 * mapping — an artifact recording a decision, not citing one — is not mistaken
 * for a citation.
 */
export function citedRulingsInYaml(text: string): string[] {
  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch {
    return [];
  }
  const out: string[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (node === null || typeof node !== "object") return;
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === "ruling" && typeof value === "string" && KEBAB.test(value.trim())) out.push(value.trim());
      if (key === "rulings" || key === "resolved_conflicts") {
        for (const item of Array.isArray(value) ? value : []) {
          if (typeof item === "string" && KEBAB.test(item.trim())) out.push(item.trim());
        }
      }
      visit(value);
    }
  };
  visit(parsed);
  return out;
}

/**
 * The closed set of SKILL.MD sections, from
 * `schemas/common.schema.json#/$defs/skill_section`.
 *
 * Read out of the schema rather than spelled again here. A second copy would be
 * the one that decided: the enum could gain a value and this file would keep
 * rejecting it, with nothing to say the two had parted. `DOCUMENT_FILE` in
 * provenance.ts is the same shape for the same reason.
 *
 * `null` means the vocabulary could not be read at all, which is reported once
 * as an unavailable check rather than as nineteen passing rows.
 */
function skillSections(root: string): Set<string> | null {
  const text = readTextIfPresent(join(root, COMMON_SCHEMA));
  if (text === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const def = record(record(record(parsed)["$defs"])["skill_section"]);
  const values = Array.isArray(def["enum"]) ? def["enum"] : [];
  const out = new Set(values.filter((v): v is string => typeof v === "string"));
  return out.size === 0 ? null : out;
}

export function loadRulings(root: string): { rows: RulingRow[]; issues: Issue[]; present: boolean } {
  const text = readTextIfPresent(join(root, RULINGS_FILE));
  if (text === null) {
    return {
      rows: [],
      issues: [
        note(
          "rulings.policy-unavailable",
          RULINGS_FILE,
          "the resolved-conflicts policy is not present; no ruling id can be resolved, so no citation is checked",
        ),
      ],
      present: false,
    };
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch (cause) {
    return {
      rows: [],
      issues: [
        error(
          "rulings.unparseable",
          RULINGS_FILE,
          `could not be parsed: ${cause instanceof Error ? cause.message : String(cause)}`,
        ),
        // `present: false`, so the citation check does not run at all.
        //
        // It used to return `present: true` with no rows, which let
        // `checkCitations` run against an empty ruling set: one unreadable file
        // convicted every body that cited anything of citing a ruling that does
        // not exist. The bodies were correct and the authority to judge them was
        // what had gone missing, so every one of those was a false attribution.
        //
        // `unavailable()` and not `skipped()` for the same reason: the subject
        // is present -- the bodies are all in the tree -- and what is absent is
        // the contract they are measured against. That blocks. It is added
        // beside the error and not in place of it; the file is a real defect,
        // and the check that could not run because of it is a separate fact.
        unavailable(
          "rulings.citations-unavailable",
          RULINGS_FILE,
          CITATIONS_CHECK,
          `${RULINGS_FILE} could not be parsed, so no ruling id resolves and no citation in any body was checked against one. Every body is still in the tree; what is missing is the authority to judge their citations. Fix the parse error above and the citations are checked on the next run.`,
        ),
      ],
      present: false,
    };
  }

  const doc = record(parsed);
  const issues: Issue[] = [];
  const rows: RulingRow[] = [];
  const seen = new Set<string>();

  const conflicts = Array.isArray(doc["conflicts"]) ? doc["conflicts"] : [];

  // The rows are all here; what may be missing is the vocabulary they are measured
  // against. That blocks rather than skips, and it is said once instead of per row.
  const sections = skillSections(root);
  if (sections === null && conflicts.length > 0) {
    issues.push(
      unavailable(
        "rulings.discharge-vocabulary-unavailable",
        COMMON_SCHEMA,
        DISCHARGE_CHECK,
        `${COMMON_SCHEMA} declares no readable $defs/skill_section enum, so no row's discharged_in was checked against one. The ${conflicts.length} rows are still in ${RULINGS_FILE}; what is missing is the vocabulary that says which values are legal.`,
      ),
    );
  }

  for (const [i, entry] of conflicts.entries()) {
    const row = record(entry);
    const id = typeof row["id"] === "string" ? row["id"] : null;
    if (id === null || !KEBAB.test(id)) {
      issues.push(
        error(
          "rulings.malformed-id",
          RULINGS_FILE,
          `conflicts[${i}] has id ${id ?? "(missing)"}, which is not a kebab-case id`,
        ),
      );
      continue;
    }
    if (seen.has(id)) {
      issues.push(
        error(
          "rulings.duplicate-id",
          RULINGS_FILE,
          `ruling id ${id} is declared more than once; the ids are what every body cites and must be unique`,
        ),
      );
      continue;
    }
    seen.add(id);

    const binds: Record<string, string[]> = {};
    for (const [kind, value] of Object.entries(record(row["binds"]))) {
      binds[kind] = (Array.isArray(value) ? value : []).filter((v): v is string => typeof v === "string");
    }

    // A kind listed here claims to cover a whole section, so the shape matters as
    // much as the contents: `universal: roles` would read as a claim and enumerate
    // one letter per kind, which is how a wildcard spelled as a bare string binds
    // nothing while looking bound. Refuse the shape rather than coercing it.
    const universalValue = row["universal"];
    let universal: string[] = [];
    if (universalValue !== undefined) {
      if (!Array.isArray(universalValue) || universalValue.some((k) => typeof k !== "string")) {
        issues.push(
          error(
            "rulings.malformed-universal",
            RULINGS_FILE,
            `${id} declares universal: ${JSON.stringify(universalValue)}, which is not a list of catalog kinds. Write universal: [roles]; a bare string reads as a claim and checks nothing.`,
          ),
        );
      } else {
        universal = universalValue.filter((k): k is string => typeof k === "string");
      }
    }

    const scenario = typeof row["scenario"] === "number" ? row["scenario"] : null;
    if (scenario !== null && (!Number.isInteger(scenario) || scenario < 1 || scenario > RELEASE_SCENARIO_COUNT)) {
      issues.push(
        error(
          "rulings.unknown-scenario",
          RULINGS_FILE,
          `${id} names scenario ${scenario}, which is not one of the ${RELEASE_SCENARIO_COUNT} numbered release scenarios in plan §10`,
        ),
      );
    }

    const rulingText = typeof row["ruling"] === "string" ? row["ruling"] : "";

    // `discharged_in` names the SKILL.md sections in which a bound skill may
    // legitimately discharge this row. Required, and a missing value is an error
    // rather than a default, because the field is only worth having as a statement
    // derived independently of where the bodies cite the row. A value supplied on a
    // row's behalf -- by a default here, or by reading the tree -- would agree with
    // the tree by construction and could never disagree with it, which is the one
    // thing it is for.
    //
    // The shape is refused rather than coerced, for the reason `universal` gives
    // just above: `discharged_in: workflow` is a legal-looking scalar that would
    // silently become a one-member set, and the member it names is then the only
    // one any check could ever require. A near-miss shape that reads as a narrower
    // claim than the author made is worth an error of its own.
    //
    // The vocabulary is read from the schema, so adding a section there is the only
    // edit needed to admit one.
    const dischargedValue = row["discharged_in"];
    let dischargedIn: string[] = [];
    if (sections !== null) {
      if (dischargedValue === undefined || dischargedValue === null) {
        issues.push(
          error(
            "rulings.missing-discharged-in",
            RULINGS_FILE,
            `${id} declares no discharged_in. Every row names the SKILL.md sections a bound skill may discharge it in, as a list of one or more of ${[...sections].join(", ")} (${COMMON_SCHEMA}#/$defs/skill_section). Derive them from this row's own tension and ruling text, not from where the bodies cite it.`,
          ),
        );
      } else if (!Array.isArray(dischargedValue)) {
        issues.push(
          error(
            "rulings.malformed-discharged-in",
            RULINGS_FILE,
            `${id} declares discharged_in: ${JSON.stringify(dischargedValue)}, which is not a list. Write discharged_in: [workflow, outputs]; a bare string reads as a narrower claim than the author made, since one section then becomes the only one any check could require.`,
          ),
        );
      } else {
        const named = dischargedValue
          .filter((v): v is string => typeof v === "string")
          .map((v) => v.trim())
          .filter((v) => v.length > 0);
        if (named.length === 0) {
          issues.push(
            error(
              "rulings.missing-discharged-in",
              RULINGS_FILE,
              `${id} declares an empty discharged_in. A row discharges somewhere, and an empty list is a row every bound skill satisfies by citing it anywhere at all.`,
            ),
          );
        }
        const unknown = named.filter((v) => !sections.has(v));
        if (unknown.length > 0) {
          issues.push(
            error(
              "rulings.unknown-discharged-in",
              RULINGS_FILE,
              `${id} declares discharged_in ${unknown.join(", ")}, which ${unknown.length === 1 ? "is not a" : "are not"} SKILL.md section${unknown.length === 1 ? "" : "s"}. The vocabulary is ${[...sections].join(", ")} (${COMMON_SCHEMA}#/$defs/skill_section).`,
            ),
          );
        }
        // Duplicates are not an error -- they name the same section twice and the
        // set is what the check reads -- but they are dropped so a count of the
        // declaration measures how much it actually admits.
        dischargedIn = [...new Set(named.filter((v) => sections.has(v)))];
      }
    } else if (Array.isArray(dischargedValue)) {
      dischargedIn = [
        ...new Set(
          dischargedValue
            .filter((v): v is string => typeof v === "string")
            .map((v) => v.trim())
            .filter((v) => v.length > 0),
        ),
      ];
    }

    rows.push({ id, binds, universal, text: rulingText, scenario, dischargedIn });
  }

  const declared = doc["rows"];
  if (typeof declared === "number" && declared !== conflicts.length) {
    issues.push(
      error(
        "rulings.row-count-mismatch",
        RULINGS_FILE,
        `rows: ${declared} but ${conflicts.length} conflict row(s) are declared. The count is read by other agents; keep it equal or drop it.`,
      ),
    );
  }

  return { rows, issues, present: true };
}

function isSection(kind: string): kind is Section {
  return (ALL_SECTIONS as ReadonlyArray<string>).includes(kind);
}

/** The file that is the body of a catalog entry, by the kind a `binds` group names. */
function bodyPathFor(kind: Section, id: string): string {
  return isDirectorySection(kind) ? entryBodyPath(kind, id) : entryFilePath(kind, id);
}

function lineOf(text: string, needle: string): number | undefined {
  const lines = text.split("\n");
  for (const [i, line] of lines.entries()) if (line.includes(needle)) return i + 1;
  return undefined;
}

/**
 * §6's plural `rulings: [...]` is a YAML shape. A markdown body takes the
 * singular word and one bare id.
 *
 * This is refused rather than parsed, and the distinction is the whole point.
 * `citedRulings` looks for ``ruling `<id>` `` and "rulings `" does not match it,
 * so a plural citation in markdown does not read as a malformed citation -- it
 * reads as **no citation at all**. The body cites two rulings to a human and
 * zero to every tool, the forward check then reports the file as uncited, and
 * the author looks at a file that visibly cites the ruling and concludes the
 * checker is broken. Widening `citedRulings` to accept the plural would fix the
 * blindness by making an illegal shape legal; refusing it fixes the blindness
 * and keeps §6.
 *
 * Fenced blocks and frontmatter are skipped: both are YAML, where the plural is
 * the correct form, and AUTHORING.md §6 has to be able to print the YAML shape
 * in prose without flagging itself.
 */
function pluralCitations(text: string): { line: number; ids: string[]; text: string }[] {
  const out: { line: number; ids: string[]; text: string }[] = [];
  const lines = text.split("\n");
  let fenced = false;
  let frontmatter = lines[0]?.trim() === "---";

  for (const [i, raw] of lines.entries()) {
    const line = raw ?? "";
    if (frontmatter) {
      if (i > 0 && line.trim() === "---") frontmatter = false;
      continue;
    }
    if (/^\s*(?:```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;

    // Capture the whole run of ids after the plural word, not just the first:
    // the repair a writer needs is one singular clause per id they wrote.
    const runs = [...line.matchAll(/\brulings\s+((?:`[a-z0-9][a-z0-9-]*`(?:\s*(?:,|and|&)\s*)?)+)/g)];
    const cited = runs.flatMap((m) => [...(m[1] ?? "").matchAll(/`([a-z0-9][a-z0-9-]*)`/g)].map((one) => one[1] ?? ""));
    const key = /^\s*rulings:/.test(line);
    if (cited.length === 0 && !key) continue;
    out.push({ line: i + 1, ids: cited, text: line.trim() });
  }

  return out;
}

function checkCitations(ctx: CheckContext, known: ReadonlySet<string>): Issue[] {
  const issues: Issue[] = [];
  const { root } = ctx;

  const markdown = new Set<string>();
  for (const dir of MARKDOWN_ROOTS)
    for (const file of walkFiles(root, dir)) if (file.endsWith(".md")) markdown.add(file);
  for (const file of MARKDOWN_FILES) if (readTextIfPresent(join(root, file)) !== null) markdown.add(file);

  for (const file of [...markdown].sort()) {
    const text = readTextIfPresent(join(root, file));
    if (text === null) continue;

    for (const hit of pluralCitations(text)) {
      const singular =
        hit.ids.length > 0
          ? `Write one per clause: ${hit.ids.map((id) => `ruling \`${id}\``).join(", then ")}.`
          : "Write the singular `ruling` plus one bare id per clause.";
      issues.push(
        error(
          "rulings.plural-citation-in-markdown",
          file,
          `uses §6's plural \`rulings\` form in a markdown body: "${hit.text.slice(0, 90)}". The plural is the YAML shape; a markdown body takes the singular word and one bare id. Every tool built on §6 reads this as zero citations rather than as a malformed one. ${singular}`,
          hit.line,
        ),
      );
    }

    const reported = new Set<string>();
    for (const id of citedRulings(text)) {
      if (known.has(id) || reported.has(id)) continue;
      reported.add(id);
      issues.push(
        error(
          "rulings.unknown-citation",
          file,
          `cites ruling \`${id}\`, which ${RULINGS_FILE} does not define. Read the id out of the policy rather than reconstructing it from the tension it settles.`,
          lineOf(text, id),
        ),
      );
    }
  }

  const yamlFiles = new Set<string>();
  for (const dir of YAML_ROOTS) for (const file of walkFiles(root, dir)) if (/\.ya?ml$/.test(file)) yamlFiles.add(file);
  yamlFiles.delete(RULINGS_FILE); // the policy defines the ids; it does not cite them.

  for (const file of [...yamlFiles].sort()) {
    const text = readTextIfPresent(join(root, file));
    if (text === null) continue;
    const reported = new Set<string>();
    for (const id of citedRulingsInYaml(text)) {
      if (known.has(id) || reported.has(id)) continue;
      reported.add(id);
      issues.push(
        error(
          "rulings.unknown-citation",
          file,
          `cites ruling ${id}, which ${RULINGS_FILE} does not define.`,
          lineOf(text, id),
        ),
      );
    }
  }

  return issues;
}

/**
 * The `binds` key for a §12.3 doctrine file, which has no catalog entry and so
 * has no kind/id pair to be named by.
 *
 * `binds` is otherwise keyed by catalog section, and that is the whole reason
 * the gap existed: a loose file is not addressable, so no row could name it and
 * every `binds`-derived count excluded it without saying so. Giving it a kind
 * whose ids are repo-relative paths makes the binding writable; the reachability
 * report below is what makes the unwritten ones visible.
 */
const DOCTRINE_KIND = "doctrine";

/**
 * Markdown that belongs to no catalog entry.
 *
 * The property is structural -- no entry claims the path -- not a list of known
 * files. Material *inside* an entry's directory is reachable through that entry
 * and is not loose; only a file that no entry's directory contains is.
 *
 * That includes the repository root. A root file has no catalog entry for the
 * same reason a §12.3 doctrine file has none, and the root is where the gap
 * bites hardest rather than least: `AUTHORING.md` governs every body in the
 * package and no ruling could name it. Scoping the property to the section
 * trees would have been a convention the tool holds nowhere else -- the
 * denylist and placeholder scans already run repo-wide.
 */
function looseDoctrineFiles(ctx: CheckContext): string[] {
  const found: string[] = [];
  for (const section of DIRECTORY_SECTIONS) {
    const claimed = ctx.catalog.bySection(section).map((entry) => `${entryDir(section, entry.id)}/`);
    for (const file of walkFiles(ctx.root, section)) {
      if (!file.endsWith(".md")) continue;
      if (claimed.some((dir) => file.startsWith(dir))) continue;
      found.push(file);
    }
  }
  for (const file of rootMarkdown(ctx.root)) found.push(file);
  return found.sort();
}

/** Markdown at the repository root, which no section tree contains. */
function rootMarkdown(root: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
  return entries.sort();
}

/**
 * Reachability as a reported number rather than an implicit one.
 *
 * AUTHORING.md §12.3 makes §6 the writer's obligation alone for these files. It
 * can stay that way -- what cannot stay is the tool knowing the file exists,
 * excluding it from every binding check, and printing a clean count. A warning
 * here says which files no row reaches, so the exclusion is something a reader
 * can see from inside `ak validate` instead of deducing from the contract.
 */
function checkDoctrineReachability(ctx: CheckContext, rows: ReadonlyArray<RulingRow>): Issue[] {
  const bound = new Set(rows.flatMap((row) => row.binds[DOCTRINE_KIND] ?? []));
  return looseDoctrineFiles(ctx)
    .filter((file) => !bound.has(file))
    .map((file) =>
      warning(
        "rulings.doctrine-unreachable",
        file,
        `This file has no catalog.yaml entry, so no ruling's binds block names it and no binds-derived check reaches it (AUTHORING.md §12.3). Bind it with \`doctrine: [${file}]\` if a ruling governs it; leaving it unbound is allowed, but it is then excluded from every citation count rather than passing them.`,
      ),
    );
}

function checkBinds(ctx: CheckContext, rows: ReadonlyArray<RulingRow>): Issue[] {
  const issues: Issue[] = [];
  const { root, catalog } = ctx;

  for (const row of rows) {
    for (const [kind, ids] of Object.entries(row.binds)) {
      if (kind === DOCTRINE_KIND) {
        issues.push(...checkDoctrineBinding(ctx, row, ids));
        continue;
      }
      if (!isSection(kind)) {
        issues.push(
          error(
            "rulings.unknown-binds-kind",
            RULINGS_FILE,
            `${row.id} binds a kind '${kind}', which is not a catalog section`,
          ),
        );
        continue;
      }
      const declared = new Set(catalog.bySection(kind).map((e) => e.id));
      for (const id of ids) {
        if (!declared.has(id)) {
          issues.push(
            error(
              "rulings.binds-unknown-entry",
              RULINGS_FILE,
              `${row.id} binds ${kind}/${id}, which catalog.yaml does not declare. A binding to nothing cannot be checked in either direction.`,
            ),
          );
          continue;
        }
        const file = bodyPathFor(kind, id);
        const text = readTextIfPresent(join(root, file));
        if (text === null) continue; // not authored yet; completeness owns that.
        if (text.includes(row.id)) continue;

        // A JSON Schema has no §6 citation shape — the table gives one to markdown
        // bodies and one to YAML files, and neither fits a schema document — so the
        // binding is reported as a warning there and as an error everywhere the
        // shape exists.
        const report = kind === "schemas" ? warning : error;
        issues.push(
          report(
            "rulings.binding-not-cited",
            file,
            `ruling \`${row.id}\` binds ${kind}/${id} but this file cites it nowhere. The row already decided this entry touches the conflict (AUTHORING.md §6).`,
          ),
        );
      }
    }
  }

  return issues;
}

/**
 * A doctrine binding names a path, so what it can name is checked: the path has
 * to be a file that is actually loose. Allowing it to name an entry's own body
 * would make `doctrine:` a second spelling for a binding the kind/id form
 * already covers, and the two would drift.
 */
function checkDoctrineBinding(ctx: CheckContext, row: RulingRow, paths: ReadonlyArray<string>): Issue[] {
  const issues: Issue[] = [];
  const loose = new Set(looseDoctrineFiles(ctx));

  for (const path of paths) {
    if (!loose.has(path)) {
      issues.push(
        error(
          "rulings.binds-unknown-doctrine-file",
          RULINGS_FILE,
          `${row.id} binds doctrine/${path}, which is not a loose doctrine file. The doctrine kind names markdown that no catalog.yaml entry claims; an entry's own files are bound by kind and id.`,
        ),
      );
      continue;
    }
    const text = readTextIfPresent(join(ctx.root, path));
    if (text === null) continue;
    if (text.includes(row.id)) continue;
    issues.push(
      error(
        "rulings.binding-not-cited",
        path,
        `ruling \`${row.id}\` binds this file but it cites the ruling nowhere. The row already decided this file touches the conflict (AUTHORING.md §6).`,
      ),
    );
  }

  return issues;
}

function sectionIds(ctx: CheckContext, kind: Section): Set<string> {
  return new Set(ctx.catalog.bySection(kind).map((e) => e.id));
}

/**
 * `universal` is the claim; `binds` is the machine's copy of it. The pair is only
 * worth more than the enumeration it replaced if something checks that they agree,
 * so a kind declared universal must bind exactly that section in catalog.yaml.
 *
 * This is strictly stronger than spelling the claim as a wildcard: a wildcard
 * would cover a role added later by construction and could never catch a list
 * someone quietly trimmed. Set equality catches both, and it catches them at the
 * moment the section changes rather than whenever a reader next compares by eye.
 */
function checkUniversal(ctx: CheckContext, rows: ReadonlyArray<RulingRow>): Issue[] {
  const issues: Issue[] = [];

  for (const row of rows) {
    for (const kind of row.universal) {
      if (!isSection(kind)) {
        issues.push(
          error(
            "rulings.unknown-universal-kind",
            RULINGS_FILE,
            `${row.id} declares universal: [${kind}], which is not a catalog section. A claim over a kind that does not exist cannot be kept or broken.`,
          ),
        );
        continue;
      }

      const declared = sectionIds(ctx, kind);
      const bound = new Set(row.binds[kind] ?? []);
      const missing = [...declared].filter((id) => !bound.has(id)).sort();
      const extra = [...bound].filter((id) => !declared.has(id)).sort();
      if (missing.length === 0 && extra.length === 0) continue;

      const parts: string[] = [];
      if (missing.length > 0) parts.push(`missing ${missing.length}: ${missing.join(", ")}`);
      if (extra.length > 0) parts.push(`extra ${extra.length}: ${extra.join(", ")}`);
      issues.push(
        error(
          "rulings.universal-binds-mismatch",
          RULINGS_FILE,
          `${row.id} declares universal: [${kind}], so binds.${kind} must be every ${kind} entry in catalog.yaml (${declared.size} of them). It is not: ${parts.join("; ")}. Either bind the entry or drop the universal claim.`,
        ),
      );
    }
  }

  return issues;
}

export function checkRulings(ctx: CheckContext): Issue[] {
  const { rows, issues, present } = loadRulings(ctx.root);
  if (!present) return issues;

  const known = new Set(rows.map((r) => r.id));
  return [
    ...issues,
    ...checkCitations(ctx, known),
    ...checkBinds(ctx, rows),
    ...checkUniversal(ctx, rows),
    ...checkDoctrineReachability(ctx, rows),
  ];
}
