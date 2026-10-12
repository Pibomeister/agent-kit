import { describe, expect, test } from "bun:test";

import { loadCatalog } from "../src/catalog/load.ts";
import type { Section } from "../src/catalog/layout.ts";
import { RULINGS_FILE, checkRulings, citedRulingsInYaml, loadRulings } from "../src/validation/rulings.ts";
import { citedRulings } from "../src/validation/bodies.ts";
import { hasBlockingSkips } from "../src/validation/types.ts";
import { makeTree } from "./helpers/tree.ts";

const CATALOG_HEAD = `schema_version: 1
package:
  id: ak
  name: agent-kit
  version: 0.1.0
  namespace: "/ak:"
  default_profile: core
`;

const SKILL_BODY = (text: string) => `---\nname: alpha\ndescription: d\n---\n\n# Alpha\n\n${text}\n`;

function rulings(rows: string): string {
  return `schema_version: 1\npolicy: resolved-conflicts\nrows: ${rows.split("- id:").length - 1}\n\nconflicts:\n${rows}`;
}

const ROW = (id: string, binds = "", scenario = 3, discharged = "[workflow]") =>
  `  - id: ${id}\n    tension: they disagreed\n    ruling: >-\n      this is what the repository does\n    discharged_in: ${discharged}\n${binds}    scenario: ${scenario}\n    coverage: direct\n`;

/** The vocabulary source. Only the one `$defs` entry the discharge check reads. */
const COMMON = (values: string[]) => JSON.stringify({ $defs: { skill_section: { enum: values } } }, null, 2);

/** The ten SKILL.md sections, as schemas/common.schema.json declares them. */
const SECTIONS = [
  "when-to-use",
  "not-for",
  "authority",
  "inputs",
  "workflow",
  "hard-gates",
  "outputs",
  "side-effects",
  "stop-conditions",
  "limits",
];

function ctxFor(files: Record<string, string>) {
  const root = makeTree({ "catalog.yaml": CATALOG_HEAD, ...files });
  const { catalog } = loadCatalog(root);
  if (catalog === null) throw new Error("fixture has no catalog");
  return { root, catalog };
}

const errors = (issues: ReturnType<typeof checkRulings>) => issues.filter((i) => i.severity === "error");

describe("citation extraction", () => {
  test("the markdown form is the word ruling plus a backticked bare id", () => {
    expect(citedRulings("closes a finding (ruling `closure-requires-independent-verification`).")).toEqual([
      "closure-requires-independent-verification",
    ]);
  });

  test("a backticked id with no preceding `ruling` word is not a citation", () => {
    expect(citedRulings("see `closure-requires-independent-verification` somewhere")).toEqual([]);
  });

  test("the yaml forms are ruling: <id> and rulings: [<id>, <id>]", () => {
    expect(citedRulingsInYaml("ruling: one-thing\n").sort()).toEqual(["one-thing"]);
    expect(citedRulingsInYaml("rulings: [one-thing, two-thing]\n").sort()).toEqual(["one-thing", "two-thing"]);
    expect(citedRulingsInYaml("provenance:\n  resolved_conflicts: [one-thing]\n")).toEqual(["one-thing"]);
  });

  test("a ruling: key whose value is a mapping is not a citation", () => {
    expect(citedRulingsInYaml("ruling:\n  outcome: decided\n")).toEqual([]);
  });
});

describe("the policy file is the authority for ids", () => {
  test("an absent policy file is a note; nothing resolves and nothing is flagged", () => {
    const ctx = ctxFor({ "skills/alpha/SKILL.md": SKILL_BODY("cites ruling `whatever-it-is`.") });
    const issues = checkRulings(ctx);
    expect(errors(issues)).toEqual([]);
    expect(issues.find((i) => i.rule === "rulings.policy-unavailable")?.severity).toBe("note");
  });

  test("a citation to an id the policy does not define is an error naming the id and the file", () => {
    const ctx = ctxFor({
      [RULINGS_FILE]: rulings(ROW("real-ruling")),
      "skills/alpha/SKILL.md": SKILL_BODY("this is settled (ruling `invented-ruling`)."),
    });
    const issue = errors(checkRulings(ctx)).find((i) => i.rule === "rulings.unknown-citation");
    expect(issue?.file).toBe("skills/alpha/SKILL.md");
    expect(issue?.message).toContain("invented-ruling");
    expect(issue?.line).toBeGreaterThan(0);
  });

  test("a citation that resolves passes", () => {
    const ctx = ctxFor({
      [RULINGS_FILE]: rulings(ROW("real-ruling")),
      "skills/alpha/SKILL.md": SKILL_BODY("this is settled (ruling `real-ruling`)."),
    });
    expect(errors(checkRulings(ctx))).toEqual([]);
  });

  test("a dangling ruling: in a profile is an error too", () => {
    const ctx = ctxFor({
      [RULINGS_FILE]: rulings(ROW("real-ruling")),
      "profiles/core.yaml": "id: core\nruling: ghost-ruling\n",
    });
    const issue = errors(checkRulings(ctx)).find((i) => i.rule === "rulings.unknown-citation");
    expect(issue?.file).toBe("profiles/core.yaml");
    expect(issue?.message).toContain("ghost-ruling");
  });

  test("the declared row count must equal the number of conflicts", () => {
    const ctx = ctxFor({ [RULINGS_FILE]: `schema_version: 1\nrows: 18\n\nconflicts:\n${ROW("only-one")}` });
    const issue = errors(checkRulings(ctx)).find((i) => i.rule === "rulings.row-count-mismatch");
    expect(issue?.message).toContain("18");
    expect(issue?.message).toContain("1");
  });

  test("a policy file with no rows: key is not a count failure", () => {
    const ctx = ctxFor({ [RULINGS_FILE]: `schema_version: 1\n\nconflicts:\n${ROW("only-one")}` });
    expect(errors(checkRulings(ctx)).filter((i) => i.rule === "rulings.row-count-mismatch")).toEqual([]);
  });

  test("an id that is not kebab-case is an error naming its position", () => {
    const ctx = ctxFor({ [RULINGS_FILE]: rulings(ROW("good-row") + ROW("Not_Kebab")) });
    const issue = errors(checkRulings(ctx)).find((i) => i.rule === "rulings.malformed-id");
    expect(issue?.message).toBe("conflicts[1] has id Not_Kebab, which is not a kebab-case id");
  });

  test("a repeated id is an error: the ids are what every body cites", () => {
    const ctx = ctxFor({ [RULINGS_FILE]: rulings(ROW("same-id") + ROW("same-id")) });
    expect(errors(checkRulings(ctx)).some((i) => i.rule === "rulings.duplicate-id")).toBe(true);
  });

  test("a scenario outside the numbered release scenarios is an error", () => {
    const ctx = ctxFor({ [RULINGS_FILE]: rulings(ROW("a-row", "", 99)) });
    const issue = errors(checkRulings(ctx)).find((i) => i.rule === "rulings.unknown-scenario");
    expect(issue?.message).toContain("99");
  });

  test("the expanded release boundary accepts scenario 29 and rejects scenario 30", () => {
    const accepted = ctxFor({ [RULINGS_FILE]: rulings(ROW("accepted-row", "", 29)) });
    expect(errors(checkRulings(accepted)).filter((i) => i.rule === "rulings.unknown-scenario")).toEqual([]);

    const rejected = ctxFor({ [RULINGS_FILE]: rulings(ROW("rejected-row", "", 30)) });
    expect(errors(checkRulings(rejected)).some((i) => i.rule === "rulings.unknown-scenario")).toBe(true);
  });

  test("a row with no overrides block is complete, not incomplete", () => {
    const ctx = ctxFor({ [RULINGS_FILE]: rulings(ROW("reconciled-row")) });
    const { rows } = loadRulings(ctx.root);
    expect(rows.map((r) => r.id)).toEqual(["reconciled-row"]);
    // Nothing in checkRulings mentions overrides, so "no override complaint" alone could not fail.
    // The claim is that the row is complete: the checker passes it, and the same row with one defect does not.
    expect(errors(checkRulings(ctx))).toEqual([]);
    const defective = ctxFor({ [RULINGS_FILE]: rulings(ROW("reconciled-row", "", 99)) });
    expect(errors(checkRulings(defective)).map((i) => i.rule)).toEqual(["rulings.unknown-scenario"]);
  });
});

describe("discharged_in names where a ruling lands, and is a required list", () => {
  const load = (rows: string, common: string | null) => {
    const files: Record<string, string> = { "catalog.yaml": CATALOG_HEAD, [RULINGS_FILE]: rulings(rows) };
    if (common !== null) files["schemas/common.schema.json"] = common;
    return loadRulings(makeTree(files));
  };
  const ruleCount = (issues: ReturnType<typeof loadRulings>["issues"], rule: string) =>
    issues.filter((i) => i.rule === rule).length;

  test("a list of legal sections passes and reaches the loaded row", () => {
    const { rows, issues } = load(ROW("a-thing", "", 3, "[hard-gates, authority]"), COMMON(SECTIONS));
    expect(issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(rows[0]?.dischargedIn).toEqual(["hard-gates", "authority"]);
  });

  // A row binds several skills and one obligation can land in a different section
  // in each, so a single member is a legal declaration rather than a degenerate one.
  test("one member is legal; the list is a set of admissible sections, not a pair", () => {
    const { rows, issues } = load(ROW("a-thing", "", 3, "[not-for]"), COMMON(SECTIONS));
    expect(issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(rows[0]?.dischargedIn).toEqual(["not-for"]);
  });

  // The shape is refused, not coerced. A bare string would silently become a
  // one-member set, and that member would be the only section any check could
  // require -- a narrower claim than the author made, from a legal-looking value.
  test("a bare string is refused rather than read as a one-member list", () => {
    const { rows, issues } = load(ROW("a-thing", "", 3, "workflow"), COMMON(SECTIONS));
    expect(ruleCount(issues, "rulings.malformed-discharged-in")).toBe(1);
    expect(issues.find((i) => i.rule === "rulings.malformed-discharged-in")?.severity).toBe("error");
    expect(rows[0]?.dischargedIn).toEqual([]);
  });

  test("a member outside the vocabulary is an error naming it and the ten sections", () => {
    const { issues } = load(ROW("a-thing", "", 3, "[workflow, hardgates]"), COMMON(SECTIONS));
    const found = issues.filter((i) => i.rule === "rulings.unknown-discharged-in");
    expect(found).toHaveLength(1);
    expect(found[0]?.severity).toBe("error");
    expect(found[0]?.message).toContain("hardgates");
    expect(found[0]?.message).toContain("stop-conditions");
  });

  // The point of the field is that it is derived from the row's prose rather than
  // from where the bodies cite it. A default supplied here would agree with the
  // tree by construction and could never disagree with it, so an absent value has
  // to be a failure rather than a value this file picks.
  test("no value at all is an error, not a default", () => {
    const bare = `  - id: a-thing\n    tension: they disagreed\n    ruling: >-\n      this is what the repository does\n    scenario: 3\n    coverage: direct\n`;
    const { rows, issues } = load(bare, COMMON(SECTIONS));
    expect(ruleCount(issues, "rulings.missing-discharged-in")).toBe(1);
    expect(rows[0]?.dischargedIn).toEqual([]);
  });

  // An empty list is the shape that would quietly disable the check built on it:
  // every bound skill satisfies it by citing the ruling anywhere at all.
  test("an empty list is an error, because every skill would satisfy it", () => {
    const { issues } = load(ROW("a-thing", "", 3, "[]"), COMMON(SECTIONS));
    expect(ruleCount(issues, "rulings.missing-discharged-in")).toBe(1);
  });

  test("a repeated member is not an error but is not counted twice either", () => {
    const { rows, issues } = load(ROW("a-thing", "", 3, "[workflow, workflow]"), COMMON(SECTIONS));
    expect(issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(rows[0]?.dischargedIn).toEqual(["workflow"]);
  });

  // The vocabulary is read out of the schema, not spelled again in the validator.
  // A section added to the enum is admitted with no change here; if this test ever
  // needs the validator edited to pass, the two copies have parted.
  test("the vocabulary comes from the schema, so a section added there is admitted", () => {
    const withExtra = load(ROW("a-thing", "", 3, "[observability]"), COMMON([...SECTIONS, "observability"]));
    expect(withExtra.issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(withExtra.rows[0]?.dischargedIn).toEqual(["observability"]);

    const without = load(ROW("a-thing", "", 3, "[observability]"), COMMON(SECTIONS));
    expect(ruleCount(without.issues, "rulings.unknown-discharged-in")).toBe(1);
  });

  // The rows are all present; what is missing is the vocabulary they are measured
  // against. That blocks, and it is said once rather than passing every row.
  test("an unreadable vocabulary is a blocking unavailable, not a row-by-row pass", () => {
    const { issues } = load(ROW("a-thing") + ROW("b-thing"), null);
    expect(ruleCount(issues, "rulings.discharge-vocabulary-unavailable")).toBe(1);
    expect(hasBlockingSkips(issues)).toBe(true);
    expect(ruleCount(issues, "rulings.missing-discharged-in")).toBe(0);
  });

  test("an empty enum reads as no vocabulary rather than as a vocabulary of nothing", () => {
    const { issues } = load(ROW("a-thing"), COMMON([]));
    expect(ruleCount(issues, "rulings.discharge-vocabulary-unavailable")).toBe(1);
    expect(ruleCount(issues, "rulings.unknown-discharged-in")).toBe(0);
  });
});

describe("binds is the machine-checkable inverse", () => {
  const BINDS = "    binds:\n      skills: [alpha]\n";
  const DECLARES_ALPHA = `${CATALOG_HEAD}skills:\n  - id: alpha\n    status: authored\n`;

  test("an entry a ruling binds whose body cites nothing is an error naming both", () => {
    const ctx = ctxFor({
      "catalog.yaml": DECLARES_ALPHA,
      [RULINGS_FILE]: rulings(ROW("binding-ruling", BINDS)),
      "skills/alpha/SKILL.md": SKILL_BODY("no citation here."),
    });
    const issue = errors(checkRulings(ctx)).find((i) => i.rule === "rulings.binding-not-cited");
    expect(issue?.file).toBe("skills/alpha/SKILL.md");
    expect(issue?.message).toContain("binding-ruling");
  });

  test("the same entry citing the ruling passes", () => {
    const ctx = ctxFor({
      "catalog.yaml": DECLARES_ALPHA,
      [RULINGS_FILE]: rulings(ROW("binding-ruling", BINDS)),
      "skills/alpha/SKILL.md": SKILL_BODY("settled (ruling `binding-ruling`)."),
    });
    expect(errors(checkRulings(ctx))).toEqual([]);
  });

  test("citing another ruling that shares a prefix is not citing this one", () => {
    const ctx = ctxFor({
      "catalog.yaml": DECLARES_ALPHA,
      [RULINGS_FILE]: rulings(ROW("binding-ruling", BINDS)),
      "skills/alpha/SKILL.md": SKILL_BODY("settled (ruling `binding-rules`)."),
    });
    const issue = errors(checkRulings(ctx)).find((i) => i.rule === "rulings.binding-not-cited");
    expect(issue?.file).toBe("skills/alpha/SKILL.md");
  });

  test("a binds group naming a kind that is not a catalog section is an error", () => {
    const ctx = ctxFor({
      "catalog.yaml": DECLARES_ALPHA,
      [RULINGS_FILE]: rulings(ROW("binding-ruling", "    binds:\n      gadgets: [alpha]\n")),
    });
    const issue = errors(checkRulings(ctx)).find((i) => i.rule === "rulings.unknown-binds-kind");
    expect(issue?.message).toBe("binding-ruling binds a kind 'gadgets', which is not a catalog section");
  });

  test("an entry that is not authored yet is not owed a citation", () => {
    const ctx = ctxFor({ "catalog.yaml": DECLARES_ALPHA, [RULINGS_FILE]: rulings(ROW("binding-ruling", BINDS)) });
    expect(errors(checkRulings(ctx)).filter((i) => i.rule === "rulings.binding-not-cited")).toEqual([]);
  });

  test("a schema is bound by prose it has no place to carry, so it is a warning", () => {
    const ctx = ctxFor({
      "catalog.yaml": `${CATALOG_HEAD}schemas:\n  - id: finding\n    status: authored\n`,
      [RULINGS_FILE]: rulings(ROW("binding-ruling", "    binds:\n      schemas: [finding]\n")),
      "schemas/finding.schema.json": '{"$id":"finding.schema.json","type":"object"}',
    });
    const issue = checkRulings(ctx).find((i) => i.rule === "rulings.binding-not-cited");
    expect(issue?.severity).toBe("warning");
    expect(issue?.file).toBe("schemas/finding.schema.json");
  });

  test("a binds group naming an id the catalog does not declare is an error", () => {
    const ctx = ctxFor({ [RULINGS_FILE]: rulings(ROW("binding-ruling", "    binds:\n      skills: [ghost]\n")) });
    const issue = errors(checkRulings(ctx)).find((i) => i.rule === "rulings.binds-unknown-entry");
    expect(issue?.message).toContain("ghost");
  });
});

describe("the plural citation form is refused in markdown (AUTHORING 6)", () => {
  const DECLARES_ALPHA = `${CATALOG_HEAD}skills:\n  - id: alpha\n    status: authored\n`;

  test("a plural citation in a markdown body is an error naming the ids and the singular form", () => {
    const ctx = ctxFor({
      "catalog.yaml": DECLARES_ALPHA,
      [RULINGS_FILE]: rulings(ROW("first-ruling") + ROW("second-ruling")),
      "skills/alpha/SKILL.md": SKILL_BODY("This is settled (rulings `first-ruling`, `second-ruling`)."),
    });
    const issue = errors(checkRulings(ctx)).find((i) => i.rule === "rulings.plural-citation-in-markdown");
    expect(issue?.file).toBe("skills/alpha/SKILL.md");
    expect(issue?.message).toContain("first-ruling");
    // Both ids, not just the first: the repair is one singular clause per id written.
    expect(issue?.message).toContain("ruling `first-ruling`");
    expect(issue?.message).toContain("ruling `second-ruling`");
    expect(issue?.line).toBeGreaterThan(0);
  });

  test("the plural form reads as zero citations, which is why it cannot be left to the forward check", () => {
    // The singular parser sees nothing here, so without this rule a body citing
    // an id that does not exist would pass: the citation is invisible, not wrong.
    expect(citedRulings("settled (rulings `first-ruling`, `invented-ruling`).")).toEqual([]);
    const ctx = ctxFor({
      "catalog.yaml": DECLARES_ALPHA,
      [RULINGS_FILE]: rulings(ROW("first-ruling")),
      "skills/alpha/SKILL.md": SKILL_BODY("settled (rulings `first-ruling`, `invented-ruling`)."),
    });
    expect(errors(checkRulings(ctx)).some((i) => i.rule === "rulings.plural-citation-in-markdown")).toBe(true);
  });

  test("the singular form passes", () => {
    const ctx = ctxFor({
      "catalog.yaml": DECLARES_ALPHA,
      [RULINGS_FILE]: rulings(ROW("first-ruling")),
      "skills/alpha/SKILL.md": SKILL_BODY("This is settled (ruling `first-ruling`)."),
    });
    expect(errors(checkRulings(ctx)).filter((i) => i.rule === "rulings.plural-citation-in-markdown")).toEqual([]);
  });

  test("a plural rulings: key in a YAML file is the shape 6 permits and is not flagged", () => {
    const ctx = ctxFor({
      [RULINGS_FILE]: rulings(ROW("first-ruling") + ROW("second-ruling")),
      "profiles/core.yaml": "id: core\nrulings: [first-ruling, second-ruling]\n",
    });
    expect(errors(checkRulings(ctx))).toEqual([]);
  });

  test("a fenced yaml block inside a markdown body is showing YAML, not citing in markdown", () => {
    const fenced = ["Write it as:", "", "```yaml", "rulings: [first-ruling, second-ruling]", "```", ""].join("\n");
    const ctx = ctxFor({
      "catalog.yaml": DECLARES_ALPHA,
      [RULINGS_FILE]: rulings(ROW("first-ruling") + ROW("second-ruling")),
      "skills/alpha/SKILL.md": SKILL_BODY(fenced),
    });
    expect(errors(checkRulings(ctx)).filter((i) => i.rule === "rulings.plural-citation-in-markdown")).toEqual([]);
  });

  test("a rulings: key in a markdown body's own frontmatter is YAML too", () => {
    const ctx = ctxFor({
      "catalog.yaml": DECLARES_ALPHA,
      [RULINGS_FILE]: rulings(ROW("first-ruling")),
      "skills/alpha/SKILL.md": `---\nname: alpha\ndescription: d\nrulings: [first-ruling]\n---\n\n# Alpha\n\nProse.\n`,
    });
    expect(errors(checkRulings(ctx)).filter((i) => i.rule === "rulings.plural-citation-in-markdown")).toEqual([]);
  });

  test("AUTHORING 6's own table documents the YAML form inline and must not flag itself", () => {
    const row = "| A YAML file | The key `ruling: <bare-id>`, or `rulings: [<id>, <id>]` for several |";
    const ctx = ctxFor({
      "catalog.yaml": DECLARES_ALPHA,
      [RULINGS_FILE]: rulings(ROW("first-ruling")),
      "AUTHORING.md": `# Authoring\n\n| Where | Form |\n|---|---|\n${row}\n`,
    });
    expect(errors(checkRulings(ctx)).filter((i) => i.rule === "rulings.plural-citation-in-markdown")).toEqual([]);
  });
});

describe("a binds citation is satisfied by the id, not by its citation shape", () => {
  const DECLARES_ALPHA = `${CATALOG_HEAD}skills:\n  - id: alpha\n    status: authored\n`;
  const BINDS = "    binds:\n      skills: [alpha]\n";

  test("a body citing its bound ruling in the plural form is not reported as uncited", () => {
    // The forward check tests for the id, not for `ruling <id>`, so a citation
    // shape it cannot parse never points the author at the wrong defect.
    const ctx = ctxFor({
      "catalog.yaml": DECLARES_ALPHA,
      [RULINGS_FILE]: rulings(ROW("binding-ruling", BINDS)),
      "skills/alpha/SKILL.md": SKILL_BODY("settled (rulings `binding-ruling`, `other-thing`)."),
    });
    expect(errors(checkRulings(ctx)).filter((i) => i.rule === "rulings.binding-not-cited")).toEqual([]);
  });
});

describe("this repository's own rulings", () => {
  const REPO = new URL("..", import.meta.url).pathname;

  test("every id cited anywhere in this tree resolves, and rows matches the conflict count", () => {
    const { catalog } = loadCatalog(REPO);
    expect(catalog).not.toBeNull();
    if (catalog === null) return;
    const issues = checkRulings({ root: REPO, catalog });
    expect(issues.filter((i) => i.rule === "rulings.unknown-citation")).toEqual([]);
    expect(issues.filter((i) => i.rule === "rulings.row-count-mismatch")).toEqual([]);
    expect(issues.filter((i) => i.rule === "rulings.duplicate-id")).toEqual([]);
    expect(issues.filter((i) => i.rule === "rulings.unknown-scenario")).toEqual([]);
  });

  test("every universal claim in this tree set-equals the section it claims", () => {
    const { catalog } = loadCatalog(REPO);
    expect(catalog).not.toBeNull();
    if (catalog === null) return;
    const issues = checkRulings({ root: REPO, catalog });
    expect(issues.filter((i) => i.rule === "rulings.universal-binds-mismatch")).toEqual([]);
    expect(issues.filter((i) => i.rule === "rulings.malformed-universal")).toEqual([]);
    expect(issues.filter((i) => i.rule === "rulings.unknown-universal-kind")).toEqual([]);

    // The claim is only worth checking if something claims it: a tree where every
    // `universal` key had been dropped would pass the three assertions above.
    const { rows } = loadRulings(REPO);
    const universal = rows.filter((r) => r.universal.length > 0);
    expect(universal.length).toBeGreaterThan(0);
    for (const row of universal) {
      for (const kind of row.universal) {
        expect(row.binds[kind]?.length).toBe(catalog.bySection(kind as Section).length);
      }
    }
  });
});

describe("universal is a claim binds has to keep", () => {
  const DECLARES_THREE = `${CATALOG_HEAD}roles:\n  - id: alpha\n    status: authored\n  - id: beta\n    status: authored\n  - id: review/gamma\n    status: authored\n`;

  const block = (binds: string, universal: string) => `    binds:\n${binds}    universal: ${universal}\n`;

  test("a universal kind whose binds group set-equals that catalog section passes", () => {
    const ctx = ctxFor({
      "catalog.yaml": DECLARES_THREE,
      [RULINGS_FILE]: rulings(
        ROW("governs-every-seat", block("      roles: [alpha, beta, review/gamma]\n", "[roles]")),
      ),
    });
    expect(errors(checkRulings(ctx)).filter((i) => i.rule.startsWith("rulings.universal"))).toEqual([]);
  });

  test("a role the catalog declares and the universal group omits is an error naming it", () => {
    const ctx = ctxFor({
      "catalog.yaml": DECLARES_THREE,
      [RULINGS_FILE]: rulings(ROW("governs-every-seat", block("      roles: [alpha, beta]\n", "[roles]"))),
    });
    const issue = errors(checkRulings(ctx)).find((i) => i.rule === "rulings.universal-binds-mismatch");
    expect(issue?.file).toBe(RULINGS_FILE);
    expect(issue?.message).toContain("governs-every-seat");
    expect(issue?.message).toContain("review/gamma");
    expect(issue?.message).toContain("missing");
  });

  test("an id in the universal group that the section does not declare is named as extra", () => {
    const ctx = ctxFor({
      "catalog.yaml": DECLARES_THREE,
      [RULINGS_FILE]: rulings(
        ROW("governs-every-seat", block("      roles: [alpha, beta, review/gamma, ghost]\n", "[roles]")),
      ),
    });
    const issue = errors(checkRulings(ctx)).find((i) => i.rule === "rulings.universal-binds-mismatch");
    expect(issue?.message).toContain("extra");
    expect(issue?.message).toContain("ghost");
  });

  test("a universal kind with no binds group at all is the whole section missing, not a pass", () => {
    const ctx = ctxFor({
      "catalog.yaml": DECLARES_THREE,
      [RULINGS_FILE]: rulings(ROW("governs-every-seat", "    universal: [roles]\n")),
    });
    const issue = errors(checkRulings(ctx)).find((i) => i.rule === "rulings.universal-binds-mismatch");
    expect(issue?.message).toContain("alpha");
    expect(issue?.message).toContain("beta");
    expect(issue?.message).toContain("review/gamma");
  });

  test("a bare string binds nothing silently, so the wrong shape is an error rather than a skip", () => {
    const ctx = ctxFor({
      "catalog.yaml": DECLARES_THREE,
      [RULINGS_FILE]: rulings(ROW("governs-every-seat", block("      roles: [alpha, beta, review/gamma]\n", "roles"))),
    });
    const issue = errors(checkRulings(ctx)).find((i) => i.rule === "rulings.malformed-universal");
    expect(issue?.message).toContain("governs-every-seat");
    expect(errors(checkRulings(ctx)).filter((i) => i.rule === "rulings.universal-binds-mismatch")).toEqual([]);
  });

  test("a universal kind that is not a catalog section is an error", () => {
    const ctx = ctxFor({
      "catalog.yaml": DECLARES_THREE,
      [RULINGS_FILE]: rulings(
        ROW("governs-every-seat", block("      roles: [alpha, beta, review/gamma]\n", "[rolez]")),
      ),
    });
    const issue = errors(checkRulings(ctx)).find((i) => i.rule === "rulings.unknown-universal-kind");
    expect(issue?.message).toContain("rolez");
  });

  test("a row with no universal key is not checked for set equality", () => {
    const ctx = ctxFor({
      "catalog.yaml": DECLARES_THREE,
      [RULINGS_FILE]: rulings(ROW("governs-one-seat", "    binds:\n      roles: [alpha]\n")),
    });
    expect(errors(checkRulings(ctx)).filter((i) => i.rule.startsWith("rulings.universal"))).toEqual([]);
  });

  test("universal survives the load so another reader sees the claim, not just the census", () => {
    const root = makeTree({
      "catalog.yaml": DECLARES_THREE,
      [RULINGS_FILE]: rulings(
        ROW("governs-every-seat", block("      roles: [alpha, beta, review/gamma]\n", "[roles]")),
      ),
    });
    expect(loadRulings(root).rows[0]?.universal).toEqual(["roles"]);
  });
});

/**
 * AUTHORING.md §12.3 lets a doctrine file live loose in a section tree with no
 * `catalog.yaml` entry. That is a deliberate contract choice, and its cost is
 * structural: `binds` is keyed by catalog kind and id, so no ruling could name
 * such a file and no `binds`-derived check could reach it. The gap was not that
 * one file was missed -- it is that reachability was implicit, so a count of
 * bound files read clean over a space nothing had examined.
 */
describe("a file with no catalog entry is reachable from binds (AUTHORING 12.3)", () => {
  const DOCTRINE = "# Invocation authority\n\nWhat several protocols lean on.\n";

  test("a loose doctrine file no ruling binds is reported, not silently skipped", () => {
    const ctx = ctxFor({
      "policies/resolved-conflicts.yaml": rulings(ROW("one-thing")),
      "protocols/invocation-authority.md": DOCTRINE,
    });
    const issue = checkRulings(ctx).find((i) => i.rule === "rulings.doctrine-unreachable");
    expect(issue?.severity).toBe("warning");
    expect(issue?.file).toBe("protocols/invocation-authority.md");
  });

  test("the property is having no catalog entry, not being one known file", () => {
    const ctx = ctxFor({
      "policies/resolved-conflicts.yaml": rulings(ROW("one-thing")),
      "references/house-style.md": DOCTRINE,
    });
    const found = checkRulings(ctx)
      .filter((i) => i.rule === "rulings.doctrine-unreachable")
      .map((i) => i.file);
    expect(found).toEqual(["references/house-style.md"]);
  });

  test("material inside a declared entry's directory is already reachable through that entry", () => {
    const ctx = ctxFor({
      "catalog.yaml": `${CATALOG_HEAD}protocols:\n  - id: alpha\n    status: authored\n`,
      "policies/resolved-conflicts.yaml": rulings(ROW("one-thing")),
      "protocols/alpha/PROTOCOL.md": DOCTRINE,
      "protocols/alpha/references/long-material.md": DOCTRINE,
    });
    expect(checkRulings(ctx).filter((i) => i.rule === "rulings.doctrine-unreachable")).toEqual([]);
  });

  test("root markdown is loose too: the file governing every body is bound by no entry", () => {
    // AUTHORING.md sits outside every section tree, so it has no catalog entry
    // for the same structural reason a section-tree doctrine file has none. The
    // property is "no entry claims this path", and the repository root is where
    // that is most true, not least.
    const ctx = ctxFor({
      "policies/resolved-conflicts.yaml": rulings(ROW("one-thing")),
      "AUTHORING.md": DOCTRINE,
    });
    const found = checkRulings(ctx)
      .filter((i) => i.rule === "rulings.doctrine-unreachable")
      .map((i) => i.file);
    expect(found).toContain("AUTHORING.md");
  });

  test("a root file can be bound by path like any other loose file", () => {
    const ctx = ctxFor({
      "policies/resolved-conflicts.yaml": rulings(ROW("one-thing", "    binds:\n      doctrine: [AUTHORING.md]\n")),
      "AUTHORING.md": `${DOCTRINE}\nSee ruling \`one-thing\`.\n`,
    });
    const issues = checkRulings(ctx);
    expect(issues.filter((i) => i.rule === "rulings.doctrine-unreachable")).toEqual([]);
    expect(issues.filter((i) => i.rule === "rulings.binds-unknown-doctrine-file")).toEqual([]);
  });

  test("a binds group names a loose file by path, which is what closes the hole", () => {
    const ctx = ctxFor({
      "policies/resolved-conflicts.yaml": rulings(
        ROW("one-thing", "    binds:\n      doctrine: [protocols/invocation-authority.md]\n"),
      ),
      "protocols/invocation-authority.md": `${DOCTRINE}\nSee ruling \`one-thing\`.\n`,
    });
    const issues = checkRulings(ctx);
    expect(issues.filter((i) => i.rule === "rulings.doctrine-unreachable")).toEqual([]);
    expect(issues.filter((i) => i.rule === "rulings.unknown-binds-kind")).toEqual([]);
  });

  test("a bound loose file that cites nothing fails the same way a bound entry does", () => {
    const ctx = ctxFor({
      "policies/resolved-conflicts.yaml": rulings(
        ROW("one-thing", "    binds:\n      doctrine: [protocols/invocation-authority.md]\n"),
      ),
      "protocols/invocation-authority.md": DOCTRINE,
    });
    const issue = errors(checkRulings(ctx)).find((i) => i.rule === "rulings.binding-not-cited");
    expect(issue?.file).toBe("protocols/invocation-authority.md");
  });

  test("binding a path that is not a loose doctrine file is an error, so the kind cannot be a wildcard", () => {
    const ctx = ctxFor({
      "catalog.yaml": `${CATALOG_HEAD}protocols:\n  - id: alpha\n    status: authored\n`,
      "policies/resolved-conflicts.yaml": rulings(
        ROW("one-thing", "    binds:\n      doctrine: [protocols/alpha/PROTOCOL.md]\n"),
      ),
      "protocols/alpha/PROTOCOL.md": DOCTRINE,
    });
    const issue = errors(checkRulings(ctx)).find((i) => i.rule === "rulings.binds-unknown-doctrine-file");
    expect(issue?.message).toContain("protocols/alpha/PROTOCOL.md");
  });

  test("doctrine is not a catalog section, so universal: [doctrine] is still refused", () => {
    const ctx = ctxFor({
      "policies/resolved-conflicts.yaml": rulings(
        ROW(
          "one-thing",
          "    universal: [doctrine]\n    binds:\n      doctrine: [protocols/invocation-authority.md]\n",
        ),
      ),
      "protocols/invocation-authority.md": `${DOCTRINE}\nSee ruling \`one-thing\`.\n`,
    });
    expect(errors(checkRulings(ctx)).some((i) => i.rule === "rulings.unknown-universal-kind")).toBe(true);
  });
});

describe("a rulings file that will not parse", () => {
  const MALFORMED = "conflicts: [unclosed\n";

  /** A body whose citation is correct against a readable policy file. */
  const CITING = {
    "catalog.yaml": `${CATALOG_HEAD}skills:\n  - id: alpha\n    invocation: U\n    status: contract\n`,
    "skills/alpha/SKILL.md": SKILL_BODY("This closes a finding (ruling `one-thing`)."),
  };

  test("is an error on the policy file, and no ruling resolves", () => {
    const ctx = ctxFor({ "policies/resolved-conflicts.yaml": MALFORMED });
    const issues = errors(checkRulings(ctx));
    expect(issues.map((i) => i.rule)).toEqual(["rulings.unparseable"]);
    expect(issues[0]?.file).toBe(RULINGS_FILE);
  });

  /**
   * One unreadable authority used to convict every body that cited anything.
   * `loadRulings` returned `present: true` on the unparseable path, so the
   * `!present` guard did not fire, `checkCitations` ran against an empty ruling
   * set, and each correct citation came back as `rulings.unknown-citation`
   * against the body -- a defect in one file, reported as a defect in all the
   * others. The subject was present; the authority to judge it was not.
   */
  test("does not convict the bodies: a correct citation is not reported as unknown", () => {
    // The first half is a positive control and is load-bearing. Asserting only
    // that the malformed run omits `rulings.unknown-citation` would pass just as
    // well if the citation in this body were never extracted at all -- an empty
    // citation set cannot produce an unknown-citation issue either, so the two
    // give the same reading. Proving the same body against a readable policy
    // that does not define the id makes the absence in the second half mean
    // something: the check can see this citation, and chose not to grade it.
    const seen = checkRulings(ctxFor({ ...CITING, [RULINGS_FILE]: rulings(ROW("something-else")) }));
    expect(seen.map((i) => i.rule)).toContain("rulings.unknown-citation");

    const rules = checkRulings(ctxFor({ ...CITING, [RULINGS_FILE]: MALFORMED })).map((i) => i.rule);
    expect(rules).not.toContain("rulings.unknown-citation");
    expect(rules).toContain("rulings.unparseable");
  });

  test("reports the citation check as unavailable, which blocks", () => {
    const ctx = ctxFor({ ...CITING, "policies/resolved-conflicts.yaml": MALFORMED });
    const issues = checkRulings(ctx);
    const gap = issues.find((i) => i.rule === "rulings.citations-unavailable");
    expect(gap?.blocking).toBe(true);
    expect(gap?.skipped).toBe("ruling citations");
    expect(hasBlockingSkips(issues)).toBe(true);
  });

  test("the file is still an error, so nothing that blocked before stops blocking", () => {
    // The unavailable() is added beside the error(), not in place of it. A
    // malformed policy file is a real gradeable defect in the tree; the check
    // that could not run because of it is the separate fact.
    const ctx = ctxFor({ ...CITING, "policies/resolved-conflicts.yaml": MALFORMED });
    expect(errors(checkRulings(ctx)).map((i) => i.rule)).toEqual(["rulings.unparseable"]);
  });

  test("the error carries the parser's own reason", () => {
    // `line N, column N` can only have come from the parser, so requiring it
    // rules out a message that dropped the cause and kept the template. It does
    // not rule out a mis-narrowed cause: `yaml` throws only Error subclasses for
    // a string input, so every way of reading `.message` off it agrees here.
    const ctx = ctxFor({ "policies/resolved-conflicts.yaml": MALFORMED });
    const message = errors(checkRulings(ctx))[0]?.message ?? "";
    expect(message).toMatch(/line \d+, column \d+/);
    expect(message).not.toContain("undefined");
  });
});
