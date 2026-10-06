import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { compileSchemas, checkSchemas } from "../src/validation/schemas.ts";
import { loadCatalog } from "../src/catalog/load.ts";
import { makeTree } from "./helpers/tree.ts";

const COMMON = JSON.stringify({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://agent-kit.local/schemas/common.schema.json",
  $defs: {
    nonempty_string: { type: "string", minLength: 1 },
    timestamp: { type: "string", format: "date-time" },
    envelope: {
      type: "object",
      required: ["schema", "created_at"],
      properties: { schema: { type: "string" }, created_at: { $ref: "#/$defs/timestamp" } },
    },
  },
});

const TICKET = JSON.stringify({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://agent-kit.local/schemas/ticket.schema.json",
  type: "object",
  allOf: [{ $ref: "common.schema.json#/$defs/envelope" }],
  properties: { schema: { const: "ticket" }, goal: { $ref: "common.schema.json#/$defs/nonempty_string" } },
  required: ["goal"],
});

const CATALOG_SCHEMA = JSON.stringify({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://agent-kit.local/schemas/catalog.schema.json",
  type: "object",
  required: ["schema_version", "package"],
  properties: { schema_version: { const: 1 }, package: { type: "object", required: ["id"] } },
});

const CATALOG_YAML = `schema_version: 1
package:
  id: ak
  name: agent-kit
  version: 0.1.0
  namespace: "/ak:"
  default_profile: core
schemas:
  - id: common
    status: authored
  - id: ticket
    status: authored
  - id: catalog
    status: authored
`;

function ctxFor(files: Record<string, string>) {
  const root = makeTree(files);
  const { catalog } = loadCatalog(root);
  if (catalog === null) throw new Error("fixture has no catalog");
  return { root, catalog };
}

describe("schema compilation", () => {
  test("compiles every schema and resolves cross-file $defs refs", () => {
    const root = makeTree({ "schemas/common.schema.json": COMMON, "schemas/ticket.schema.json": TICKET });
    const set = compileSchemas(root);
    expect(set.issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(set.validatorFor("ticket")).toBeDefined();
    const validate = set.validatorFor("ticket")!;
    expect(validate({ schema: "ticket", created_at: "2026-09-19T10:00:00Z", goal: "ship" })).toBe(true);
    expect(validate({ schema: "ticket", created_at: "2026-09-19T10:00:00Z" })).toBe(false);
  });

  test("date-time and date formats are enforced via ajv-formats", () => {
    const root = makeTree({ "schemas/common.schema.json": COMMON, "schemas/ticket.schema.json": TICKET });
    const validate = compileSchemas(root).validatorFor("ticket")!;
    expect(validate({ schema: "ticket", created_at: "not-a-timestamp", goal: "ship" })).toBe(false);
  });

  test("an unparseable schema is an error naming the file, not a crash", () => {
    const set = compileSchemas(makeTree({ "schemas/broken.schema.json": "{ not json" }));
    const issue = set.issues.find((i) => i.rule === "schemas.unparseable");
    expect(issue?.severity).toBe("error");
    expect(issue?.file).toBe("schemas/broken.schema.json");
  });

  test("a duplicate JSON key in a schema is reported with its line", () => {
    const dup =
      '{\n  "$id": "https://agent-kit.local/schemas/dup.schema.json",\n  "type": "object",\n  "type": "string"\n}\n';
    const set = compileSchemas(makeTree({ "schemas/dup.schema.json": dup }));
    const issue = set.issues.find((i) => i.rule === "schemas.duplicate-json-key");
    expect(issue?.severity).toBe("error");
    expect(issue?.line).toBe(4);
  });

  test("a missing schemas directory yields no validators and no crash", () => {
    const set = compileSchemas(makeTree({}));
    expect(set.issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(set.validatorFor("ticket")).toBeUndefined();
  });

  test("a schema without $id compiles with no uncompilable error", () => {
    const plain = JSON.stringify({ type: "object" });
    const set = compileSchemas(makeTree({ "schemas/plain.schema.json": plain }));
    expect(set.issues.filter((i) => i.rule === "schemas.uncompilable")).toEqual([]);
    expect(set.validatorFor("plain")?.({})).toBe(true);
  });

  test("an unresolvable $ref is reported against the referencing schema", () => {
    const bad = JSON.stringify({
      $id: "https://agent-kit.local/schemas/bad.schema.json",
      $ref: "missing.schema.json#/$defs/nope",
    });
    const set = compileSchemas(makeTree({ "schemas/bad.schema.json": bad }));
    expect(set.issues.some((i) => i.rule === "schemas.uncompilable" && i.file === "schemas/bad.schema.json")).toBe(
      true,
    );
  });
});

describe("document validation against schemas", () => {
  test("validates catalog.yaml against catalog.schema.json", () => {
    const ctx = ctxFor({
      "catalog.yaml": CATALOG_YAML.replace("schema_version: 1", "schema_version: 2"),
      "schemas/catalog.schema.json": CATALOG_SCHEMA,
      "schemas/common.schema.json": COMMON,
      "schemas/ticket.schema.json": TICKET,
    });
    const issues = checkSchemas(ctx);
    const issue = issues.find((i) => i.rule === "schemas.document-invalid" && i.file === "catalog.yaml");
    expect(issue?.severity).toBe("error");
    expect(issue?.message).toContain("schema_version");
  });

  test("validates each skill.yaml against skill.schema.json", () => {
    const skillSchema = JSON.stringify({
      $id: "https://agent-kit.local/schemas/skill.schema.json",
      type: "object",
      required: ["id", "version"],
      properties: { id: { type: "string" }, version: { type: "string" } },
    });
    const ctx = ctxFor({
      "catalog.yaml": `${CATALOG_YAML}  - id: skill\n    status: authored\nskills:\n  - id: alpha\n    status: authored\n`,
      "schemas/common.schema.json": COMMON,
      "schemas/ticket.schema.json": TICKET,
      "schemas/catalog.schema.json": CATALOG_SCHEMA,
      "schemas/skill.schema.json": skillSchema,
      "skills/alpha/SKILL.md": "---\nname: alpha\ndescription: d\n---\nbody\n",
      "skills/alpha/skill.yaml": "id: alpha\n",
    });
    const issues = checkSchemas(ctx);
    expect(issues.some((i) => i.rule === "schemas.document-invalid" && i.file === "skills/alpha/skill.yaml")).toBe(
      true,
    );
  });

  test("validates a templates artifact against the schema its envelope names", () => {
    const ctx = ctxFor({
      "catalog.yaml": CATALOG_YAML,
      "schemas/common.schema.json": COMMON,
      "schemas/ticket.schema.json": TICKET,
      "schemas/catalog.schema.json": CATALOG_SCHEMA,
      "templates/example-ticket.json": JSON.stringify({ schema: "ticket", created_at: "2026-09-19T10:00:00Z" }),
    });
    const issues = checkSchemas(ctx);
    const issue = issues.find((i) => i.file === "templates/example-ticket.json");
    expect(issue?.rule).toBe("schemas.document-invalid");
    expect(issue?.message).toContain("goal");
  });

  test("a valid templates artifact produces no issue", () => {
    const ctx = ctxFor({
      "catalog.yaml": CATALOG_YAML,
      "schemas/common.schema.json": COMMON,
      "schemas/ticket.schema.json": TICKET,
      "schemas/catalog.schema.json": CATALOG_SCHEMA,
      "templates/example-ticket.json": JSON.stringify({
        schema: "ticket",
        created_at: "2026-09-19T10:00:00Z",
        goal: "ship",
      }),
    });
    expect(checkSchemas(ctx).filter((i) => i.file === "templates/example-ticket.json")).toEqual([]);
  });

  test("a templates artifact naming an unknown schema is an error", () => {
    const ctx = ctxFor({
      "catalog.yaml": CATALOG_YAML,
      "schemas/common.schema.json": COMMON,
      "schemas/ticket.schema.json": TICKET,
      "schemas/catalog.schema.json": CATALOG_SCHEMA,
      "templates/example.json": JSON.stringify({ schema: "nonesuch", created_at: "2026-09-19T10:00:00Z" }),
    });
    expect(checkSchemas(ctx).some((i) => i.rule === "schemas.unknown-schema-id")).toBe(true);
  });

  test("a missing schema file is reported once as unavailable, not as a document failure", () => {
    const ctx = ctxFor({ "catalog.yaml": CATALOG_YAML });
    const issues = checkSchemas(ctx);
    expect(issues.some((i) => i.rule === "schemas.validator-unavailable")).toBe(true);
    expect(issues.some((i) => i.rule === "schemas.document-invalid")).toBe(false);
  });
});

/**
 * Executable eval cases.
 *
 * These read the shipped `case.schema.json` rather than a synthetic stand-in.
 * The two refusals below are this schema's entire reason for existing -- before
 * it, an empty file and a one-line `tags:` file were both valid cases that
 * satisfied `evals.declaration-without-case` and counted toward the three-case
 * floor -- so asserting them against a schema written here would assert nothing
 * about the file that ships.
 */
const SCHEMAS_DIR = join(import.meta.dir, "..", "schemas");
const shipped = (name: string) => readFileSync(join(SCHEMAS_DIR, name), "utf8");

/** A catalog that declares one skill, because cases are reached through skills. */
const EVALS_CATALOG = `schema_version: 1
package:
  id: ak
  name: agent-kit
  version: 0.1.0
  namespace: "/ak:"
  default_profile: core
skills:
  - id: demo
    status: authored
schemas:
  - id: common
    status: authored
  - id: case
    status: authored
  - id: catalog
    status: authored
`;

const WELL_FORMED_CASE = `schema_version: "1.1"
name: demo-fires-on-its-own-territory
tags: [positive]
execution:
  prompt: Review the change on the branch and report what blocks it.
  max_turns: 8
  allowed_tools: [Read, Grep, Skill]
graders:
  - name: skill-fired
    type: tool_used
    tool: Skill
    weight: 1
`;

function evalsTree(cases: Record<string, string>) {
  return ctxFor({
    "catalog.yaml": EVALS_CATALOG,
    "schemas/common.schema.json": shipped("common.schema.json"),
    "schemas/case.schema.json": shipped("case.schema.json"),
    "schemas/catalog.schema.json": CATALOG_SCHEMA,
    ...cases,
  });
}

function caseIssues(ctx: ReturnType<typeof ctxFor>, file: string) {
  return checkSchemas(ctx).filter((i) => i.file === file);
}

describe("executable eval cases are reached through the catalog's skills", () => {
  const FILE = "evals/demo/fires-on-territory/case.yaml";

  // The positive control. Without it the two refusals below are satisfied by a
  // schema that refuses everything, including the corpus.
  test("a well-formed case produces no issue", () => {
    expect(caseIssues(evalsTree({ [FILE]: WELL_FORMED_CASE }), FILE)).toEqual([]);
  });

  test("an empty case.yaml is refused", () => {
    const issues = caseIssues(evalsTree({ [FILE]: "" }), FILE);
    expect(issues.map((i) => i.rule)).toEqual(["schemas.document-invalid"]);
    expect(issues[0]?.message).toContain("must be object");
  });

  test("a case reduced to its tags line is refused, naming every key it lacks", () => {
    const issues = caseIssues(evalsTree({ [FILE]: "tags: [scenario-18]\n" }), FILE);
    expect(issues.map((i) => i.rule)).toEqual(["schemas.document-invalid"]);
    for (const key of ["schema_version", "name", "execution", "graders"]) {
      expect(issues[0]?.message).toContain(key);
    }
  });

  // The join is the directory name, and `evals.case-without-declaration` already
  // owns a case no skill claims. Reaching cases by walking `evals/` instead of by
  // walking the catalog would report that case twice, under two rules, one of
  // which would be talking about a file it has no standing to judge.
  //
  // Both halves in one test, on byte-identical content, because "no issue here"
  // is also what a tree with no wiring at all reports. Only the contrast
  // separates a case correctly left to another rule from a case nothing reaches.
  test("the same empty case is refused under a declared skill and ignored under one no skill declares", () => {
    const declared = "evals/demo/fires-on-territory/case.yaml";
    const stray = "evals/nosuchskill/whatever/case.yaml";
    const ctx = evalsTree({ [declared]: "", [stray]: "" });
    expect(caseIssues(ctx, declared).map((i) => i.rule)).toEqual(["schemas.document-invalid"]);
    expect(caseIssues(ctx, stray)).toEqual([]);
  });
});

/**
 * The resolved-conflicts policy.
 *
 * Reads the shipped `rulings.schema.json`, for the reason the eval cases above
 * read theirs. What makes this file worth a schema is not the constraints it
 * restates but the two defects nothing else in the tree could see: `binds`
 * written as a list binds nothing while reading as bound, and a misspelled field
 * name is dropped in silence. `src/validation/rulings.ts` coerces both to empty
 * and carries on, so before this schema each was a green run.
 */
const WELL_FORMED_RULINGS = `schema_version: 1
policy: resolved-conflicts
rows: 1
conflicts:
  - id: supervisor-never-implements
    tension: The plan gives the supervisor seat approval authority; the donor lets it commit.
    ruling: The seat that approves a change never writes it.
    discharged_in: [authority, hard-gates]
    binds:
      skills: [super-review]
    universal: [roles]
    scenario: 3
    coverage: direct
    note: workflow was considered and rejected; the obligation is about who may act, not ordering.
    source:
      plan: Seats and authority
`;

/** A tree holding the policy and the schemas needed to compile it. */
function rulingsTree(policy: string) {
  return ctxFor({
    "catalog.yaml": EVALS_CATALOG,
    "schemas/common.schema.json": shipped("common.schema.json"),
    "schemas/rulings.schema.json": shipped("rulings.schema.json"),
    "schemas/catalog.schema.json": CATALOG_SCHEMA,
    "policies/resolved-conflicts.yaml": policy,
  });
}

/** The issues reported against the policy file itself. */
const rulingsIssues = (policy: string) =>
  checkSchemas(rulingsTree(policy)).filter((i) => i.file === "policies/resolved-conflicts.yaml");

/** `WELL_FORMED_RULINGS` with one line swapped, so each case differs in one field. */
const withRow = (from: string, to: string) => {
  if (!WELL_FORMED_RULINGS.includes(from)) throw new Error(`fixture no longer contains: ${from}`);
  return WELL_FORMED_RULINGS.replace(from, to);
};

describe("the resolved-conflicts policy has a declared shape", () => {
  // The positive control. Without it every refusal below is satisfied by a
  // schema that refuses the shipped policy too.
  test("the well-formed policy produces no issue", () => {
    expect(rulingsIssues(WELL_FORMED_RULINGS)).toEqual([]);
  });

  test("binds written as a list is refused", () => {
    const issues = rulingsIssues(withRow("    binds:\n      skills: [super-review]\n", "    binds: [super-review]\n"));
    expect(issues.map((i) => i.rule)).toEqual(["schemas.document-invalid"]);
    expect(issues[0]?.message).toContain("/conflicts/0/binds");
    expect(issues[0]?.message).toContain("must be object");
  });

  test("a misspelled field name is refused rather than dropped", () => {
    const issues = rulingsIssues(withRow("    coverage: direct\n", "    covrage: direct\n"));
    expect(issues.map((i) => i.rule)).toEqual(["schemas.document-invalid"]);
    expect(issues[0]?.message).toContain("covrage");
  });

  test("a row claiming to govern whole sections and naming none is refused", () => {
    const issues = rulingsIssues(withRow("    universal: [roles]\n", "    universal: []\n"));
    expect(issues.map((i) => i.rule)).toEqual(["schemas.document-invalid"]);
    expect(issues[0]?.message).toContain("/conflicts/0/universal");
  });

  test("a discharged_in member that is not a section name is refused", () => {
    const issues = rulingsIssues(
      withRow("    discharged_in: [authority, hard-gates]\n", "    discharged_in: [authority, 3]\n"),
    );
    expect(issues.map((i) => i.rule)).toEqual(["schemas.document-invalid"]);
    expect(issues[0]?.message).toContain("/conflicts/0/discharged_in/1");
  });

  /**
   * The deferrals that remain, asserted as deferrals.
   *
   * `rulings.malformed-id` reports a bad id with a message this file could not
   * write, and `rulings.missing-discharged-in` does the same for an absent one:
   * they name the vocabulary, the file it was read from, and why the value must
   * be derived from the row's own text. Restating either here was measured at
   * two errors per defect. Neither can be dropped in favour of this file, since
   * `rulings.ts` needs both for its own `RulingRow`.
   *
   * Asserted rather than left to a comment, because the failure this guards
   * against is someone tightening the schema for symmetry and reintroducing the
   * double report with nothing in the suite to say it had been decided.
   *
   * `discharged_in`'s shape is no longer among them -- it is constrained above
   * by ruling, and that cost is real and measured: an empty list, a bare string
   * and an out-of-vocabulary member each report twice now, once from ajv and
   * once from the check that can explain it. Presence is the one class where the
   * second report was avoidable, which is the whole reason `discharged_in` is
   * still absent from `required`.
   */
  test("a non-kebab id is left to rulings.ts", () => {
    const loosened = withRow("  - id: supervisor-never-implements\n", "  - id: Supervisor_Never_Implements\n");
    expect(rulingsIssues(loosened)).toEqual([]);
  });

  test("an absent discharged_in is left to rulings.ts, though its shape is not", () => {
    expect(rulingsIssues(withRow("    discharged_in: [authority, hard-gates]\n", ""))).toEqual([]);
  });

  test("a bare-string discharged_in is refused here as well as there", () => {
    const issues = rulingsIssues(
      withRow("    discharged_in: [authority, hard-gates]\n", "    discharged_in: authority\n"),
    );
    expect(issues.map((i) => i.rule)).toEqual(["schemas.document-invalid"]);
    expect(issues[0]?.message).toContain("must be array");
  });
});

/**
 * The host's own keys.
 *
 * `case.yaml` has two owners. `name` and `tags` are this package's -- the host
 * reads both, but only as opaque strings to filter on -- so internal agreement
 * really is the authority for them. `scaffold_script`, `runs` and
 * `timeout_seconds` are the host's, and no amount of agreement between §9, the
 * schema and `src/` is evidence about them.
 *
 * These assert the three are admitted, because the failure they guard against
 * has already happened once and was invisible while it did. A schema that
 * refuses a key the host accepts produces no error anywhere -- it produces a
 * corpus in which nobody writes that key, and one author who tries, sees their
 * own file named in a validation error, and concludes they were wrong. The
 * closure control is what keeps the fix from being "open the object".
 */
describe("a case may carry the keys the host reads", () => {
  const FILE = "evals/demo/fires-on-territory/case.yaml";
  const withKeys = (extra: string) => evalsTree({ [FILE]: WELL_FORMED_CASE + extra });

  test("scaffold_script is admitted under context, which is where the host reads it", () => {
    expect(caseIssues(withKeys("context:\n  scaffold_script: |\n    git init -q .\n"), FILE)).toEqual([]);
  });

  // 9b12366 declared `scaffold_script` at the case root. The key was real and
  // correctly attributed; only the address was wrong, and the host's root object
  // is not strict, so such a case validates here, ships, and has its scaffold
  // silently ignored. Refusing the old address is the only thing that makes that
  // regression visible -- a key at the wrong address leaves an artifact that
  // looks correct and does nothing, which is worse than the refusal it replaced.
  test("scaffold_script at the case root is refused, because the host would ignore it there", () => {
    const issues = caseIssues(withKeys("scaffold_script: |\n  git init -q .\n"), FILE);
    expect(issues.map((i) => i.rule)).toEqual(["schemas.document-invalid"]);
    expect(issues[0]?.message).toContain("scaffold_script");
  });

  test("the other context keys the host reads are admitted", () => {
    expect(caseIssues(withKeys("context:\n  history_file: prior.jsonl\n  add_dirs: [fixtures]\n"), FILE)).toEqual([]);
  });

  test("expected_outcome is admitted at the case root", () => {
    expect(caseIssues(withKeys("expected_outcome: the skill declines and says why\n"), FILE)).toEqual([]);
  });

  test("the execution keys the host reads are admitted", () => {
    const doc = WELL_FORMED_CASE.replace(
      "  max_turns: 8\n",
      '  max_turns: 8\n  artifact_publish: false\n  append_system_prompt: be terse\n  env:\n    CI: "1"\n',
    );
    expect(caseIssues(evalsTree({ [FILE]: doc }), FILE)).toEqual([]);
  });

  test("runs is admitted at the case root", () => {
    expect(caseIssues(withKeys("runs: 3\n"), FILE)).toEqual([]);
  });

  test("timeout_seconds is admitted beside max_turns", () => {
    const doc = WELL_FORMED_CASE.replace("  max_turns: 8\n", "  max_turns: 8\n  timeout_seconds: 600\n");
    expect(caseIssues(evalsTree({ [FILE]: doc }), FILE)).toEqual([]);
  });

  test("the grader fields the host reads are admitted", () => {
    const doc = WELL_FORMED_CASE.replace(
      "    weight: 1\n",
      "    weight: 1\n    arm: both\n    min: 0\n    max: 0\n    input_match: super-ship\n",
    );
    expect(caseIssues(evalsTree({ [FILE]: doc }), FILE)).toEqual([]);
  });

  test("an llm grader may aim its focus at the created-file list", () => {
    const doc = WELL_FORMED_CASE.replace(
      "  - name: skill-fired\n    type: tool_used\n    tool: Skill\n    weight: 1\n",
      "  - name: wrote-the-record\n    type: llm\n    criteria: the review record is written\n    focus: files\n",
    );
    expect(caseIssues(evalsTree({ [FILE]: doc }), FILE)).toEqual([]);
  });
});

// Three of the host's six grader types sat in the enum with nothing behind
// them: a case naming one validated here and failed to load at the runner,
// because the host's grader objects are strict. A stated gap is better than a
// silent one and is still a gap. Each type needs both arms -- the accepted case
// alone is satisfied by a schema that checks nothing.
describe("a grader type in the enum carries the fields the host requires", () => {
  const FILE = "evals/demo/fires-on-territory/case.yaml";
  const grader = (body: string) =>
    evalsTree({
      [FILE]: WELL_FORMED_CASE.replace(
        "  - name: skill-fired\n    type: tool_used\n    tool: Skill\n    weight: 1\n",
        body,
      ),
    });
  const refused = (body: string, missing: string) => {
    const issues = caseIssues(grader(body), FILE);
    expect(issues.map((i) => i.rule)).toEqual(["schemas.document-invalid"]);
    expect(issues[0]?.message).toContain(missing);
  };

  test("baseline without baseline_file is refused", () => {
    refused("  - name: b\n    type: baseline\n    criteria: matches the recorded run\n", "baseline_file");
  });

  test("baseline with both fields is admitted", () => {
    expect(
      caseIssues(
        grader("  - name: b\n    type: baseline\n    baseline_file: prior.json\n    criteria: matches\n"),
        FILE,
      ),
    ).toEqual([]);
  });

  test("file_exists without path is refused", () => {
    refused("  - name: f\n    type: file_exists\n    exists: false\n", "path");
  });

  test("file_exists with a path is admitted", () => {
    expect(
      caseIssues(grader("  - name: f\n    type: file_exists\n    path: out/*.md\n    exists: false\n"), FILE),
    ).toEqual([]);
  });

  test("tool_order without after is refused", () => {
    refused("  - name: o\n    type: tool_order\n    before: Read\n", "after");
  });

  test("tool_order with both is admitted", () => {
    expect(caseIssues(grader("  - name: o\n    type: tool_order\n    before: Read\n    after: Edit\n"), FILE)).toEqual(
      [],
    );
  });
});

describe("a case may carry the keys the host reads, continued", () => {
  const FILE = "evals/demo/fires-on-territory/case.yaml";
  const withKeys = (extra: string) => evalsTree({ [FILE]: WELL_FORMED_CASE + extra });

  // The control. Without it the tests above are satisfied by a schema that
  // stopped closing the object at all, which is the fix nobody wanted.
  test("a key neither owner reads is still refused", () => {
    const issues = caseIssues(withKeys("nonsense_key: 1\n"), FILE);
    expect(issues.map((i) => i.rule)).toEqual(["schemas.document-invalid"]);
    expect(issues[0]?.message).toContain("nonsense_key");
  });
});

/**
 * A `catalog.d/` fragment validates against `catalog.schema.json#/$defs/fragment`,
 * not against the whole catalog's shape: it carries only the sections it adds to,
 * and never the `package:` block catalog.yaml alone owns
 * (docs/decisions/0010-catalog-fragments.md).
 *
 * Built on the shipped schemas and the shipped catalog.yaml, because the
 * property under test is that the fragment shape a downstream fork writes is
 * the one this repository ships -- a schema written for the test would only
 * agree with itself.
 */
describe("catalog.d fragments validate against the fragment shape", () => {
  const FRAGMENT = "catalog.d/downstream.yaml";
  const PROFILE = `schema_version: 1
profiles:
  - id: downstream
    batch: 1
    status: authored
    summary: A downstream install set.
`;

  const fragmentTree = (fragment: string) =>
    ctxFor({
      "catalog.yaml": readFileSync(join(SCHEMAS_DIR, "..", "catalog.yaml"), "utf8"),
      "schemas/common.schema.json": shipped("common.schema.json"),
      "schemas/catalog.schema.json": shipped("catalog.schema.json"),
      [FRAGMENT]: fragment,
    });

  test("a fragment declaring a profile validates, and so does the catalog.yaml beside it", () => {
    // The positive control, and the shape a downstream install writes first.
    expect(checkSchemas(fragmentTree(PROFILE))).toEqual([]);
  });

  test("a package block in a fragment is refused", () => {
    const issues = checkSchemas(fragmentTree(`${PROFILE}package:\n  id: other\n`)).filter((i) => i.file === FRAGMENT);
    expect(issues.map((i) => i.rule)).toEqual(["schemas.document-invalid"]);
    expect(issues[0]?.message).toContain("#/$defs/fragment");
    expect(issues[0]?.message).toContain("package");
  });

  test("a fragment entry has the same required fields as a catalog.yaml entry", () => {
    const issues = checkSchemas(fragmentTree(PROFILE.replace("    summary: A downstream install set.\n", ""))).filter(
      (i) => i.file === FRAGMENT,
    );
    expect(issues.map((i) => i.rule)).toEqual(["schemas.document-invalid"]);
    expect(issues[0]?.message).toContain("/profiles/0");
    expect(issues[0]?.message).toContain("summary");
  });

  test("a fragment with no schema_version is refused", () => {
    const issues = checkSchemas(fragmentTree(PROFILE.replace("schema_version: 1\n", ""))).filter(
      (i) => i.file === FRAGMENT,
    );
    expect(issues.map((i) => i.rule)).toEqual(["schemas.document-invalid"]);
    expect(issues[0]?.message).toContain("schema_version");
  });

  test("a fragment the loader could not read is not reported a second time here", () => {
    expect(checkSchemas(fragmentTree("profiles: [unclosed\n")).filter((i) => i.file === FRAGMENT)).toEqual([]);
  });

  test("a catalog schema with no fragment definition reports the fragment unchecked, not the catalog", () => {
    const ctx = ctxFor({
      "catalog.yaml": CATALOG_YAML,
      "schemas/common.schema.json": COMMON,
      "schemas/catalog.schema.json": CATALOG_SCHEMA,
      [FRAGMENT]: PROFILE,
    });
    const skipped = checkSchemas(ctx).filter((i) => i.rule === "schemas.validator-unavailable");
    expect(skipped.length).toBe(1);
    expect(skipped[0]?.message).toContain("catalog#/$defs/fragment");
  });
});
