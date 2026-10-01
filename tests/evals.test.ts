import { describe, expect, test } from "bun:test";

import { loadCatalog } from "../src/catalog/load.ts";
import { EVALS_DIR, REQUIRED_CASE_KINDS, RELEASE_SCENARIOS, checkEvals } from "../src/validation/evals.ts";
import { makeTree } from "./helpers/tree.ts";

const CATALOG = `schema_version: 1
package:
  id: ak
  name: agent-kit
  version: 0.1.0
  namespace: "/ak:"
  default_profile: core
skills:
  - id: alpha
    status: authored
    invocation: U
`;

const CASE = (name: string, tags = "[scenario-01]") =>
  `schema_version: "1.1"\nname: ${name}\ntags: ${tags}\nexecution:\n  prompt: "do the thing"\ngraders:\n  - name: fired\n    type: tool_used\n    tool: Skill\n`;

/** A declaration block for skill.yaml's tests[]. */
function declare(cases: ReadonlyArray<{ id: string; kind: string; fixture?: string }>): string {
  return `id: alpha\ntests:\n${cases
    .map(
      (c) =>
        `  - id: ${c.id}\n    kind: ${c.kind}\n    given: a prompt\n    expect: an outcome\n${c.fixture === undefined ? "" : `    fixture: ${c.fixture}\n`}`,
    )
    .join("")}`;
}

const THREE = [
  { id: "fires-on-trigger", kind: "positive" },
  { id: "ignores-near-miss", kind: "negative" },
  { id: "holds-under-pressure", kind: "adversarial" },
];

function ctxFor(files: Record<string, string>) {
  const root = makeTree({ "catalog.yaml": CATALOG, "skills/alpha/SKILL.md": "# Alpha\n", ...files });
  const { catalog } = loadCatalog(root);
  if (catalog === null) throw new Error("fixture has no catalog");
  return { root, catalog };
}

function complete(extra: Record<string, string> = {}, cases = THREE) {
  const files: Record<string, string> = { "skills/alpha/skill.yaml": declare(cases) };
  for (const c of cases) files[`${EVALS_DIR}/alpha/${c.id}/case.yaml`] = CASE(c.id);
  return ctxFor({ ...files, ...extra });
}

const errors = (issues: ReturnType<typeof checkEvals>) => issues.filter((i) => i.severity === "error");

describe("the three-way split (AUTHORING 9)", () => {
  test("three declared cases, three executable cases, all kinds present passes", () => {
    expect(errors(checkEvals(complete()))).toEqual([]);
  });

  test("a declared case with no executable counterpart is an error naming the expected path", () => {
    const files: Record<string, string> = { "skills/alpha/skill.yaml": declare(THREE) };
    for (const c of THREE.slice(0, 2)) files[`${EVALS_DIR}/alpha/${c.id}/case.yaml`] = CASE(c.id);
    const issue = errors(checkEvals(ctxFor(files))).find((i) => i.rule === "evals.declaration-without-case");
    expect(issue?.file).toBe(`${EVALS_DIR}/alpha/holds-under-pressure/case.yaml`);
    expect(issue?.message).toContain("holds-under-pressure");
  });

  test("an executable case nothing declares is an error naming the skill manifest", () => {
    const issue = errors(
      checkEvals(complete({ [`${EVALS_DIR}/alpha/orphan-case/case.yaml`]: CASE("orphan-case") })),
    ).find((i) => i.rule === "evals.case-without-declaration");
    expect(issue?.file).toBe(`${EVALS_DIR}/alpha/orphan-case/case.yaml`);
    expect(issue?.message).toContain("skills/alpha/skill.yaml");
  });

  test("the case directory name is the join: a renamed directory breaks both directions", () => {
    const files: Record<string, string> = { "skills/alpha/skill.yaml": declare(THREE) };
    for (const c of THREE.slice(0, 2)) files[`${EVALS_DIR}/alpha/${c.id}/case.yaml`] = CASE(c.id);
    files[`${EVALS_DIR}/alpha/holds-under-presure/case.yaml`] = CASE("holds-under-pressure");
    const rules = errors(checkEvals(ctxFor(files))).map((i) => i.rule);
    expect(rules).toContain("evals.declaration-without-case");
    expect(rules).toContain("evals.case-without-declaration");
  });

  test("a case directory with no case.yaml in it is an error", () => {
    const ctx = complete({ [`${EVALS_DIR}/alpha/fires-on-trigger/README.md`]: "notes\n" });
    // A directory alongside the case file changes nothing; a directory *instead of*
    // the case file is still no executable case.
    const withoutCaseFile = ctxFor({
      "skills/alpha/skill.yaml": declare(THREE),
      [`${EVALS_DIR}/alpha/fires-on-trigger/notes.md`]: "x\n",
      [`${EVALS_DIR}/alpha/ignores-near-miss/case.yaml`]: CASE("ignores-near-miss"),
      [`${EVALS_DIR}/alpha/holds-under-pressure/case.yaml`]: CASE("holds-under-pressure"),
    });
    expect(errors(checkEvals(ctx)).filter((i) => i.rule === "evals.declaration-without-case")).toEqual([]);
    const issue = errors(checkEvals(withoutCaseFile)).find((i) => i.rule === "evals.declaration-without-case");
    expect(issue?.message).toContain("fires-on-trigger");
  });

  test("an evals directory for a skill the catalog does not declare is an error", () => {
    const issue = errors(checkEvals(complete({ [`${EVALS_DIR}/ghost/a-case/case.yaml`]: CASE("a-case") }))).find(
      (i) => i.rule === "evals.unknown-skill-directory",
    );
    expect(issue?.message).toContain("ghost");
  });
});

describe("the floor is three cases with all three kinds", () => {
  test("two cases is a failure even though the schema floors tests[] at two", () => {
    const ctx = complete({}, THREE.slice(0, 2));
    const issue = errors(checkEvals(ctx)).find((i) => i.rule === "evals.too-few-cases");
    expect(issue?.file).toBe("skills/alpha/skill.yaml");
    expect(issue?.message).toContain("3");
  });

  test("three cases missing the adversarial kind fails naming that kind", () => {
    const ctx = complete({}, [
      { id: "fires-on-trigger", kind: "positive" },
      { id: "ignores-near-miss", kind: "negative" },
      { id: "also-fires", kind: "positive" },
    ]);
    const issue = errors(checkEvals(ctx)).find((i) => i.rule === "evals.missing-case-kind");
    expect(issue?.message).toContain("adversarial");
    expect(issue?.message).not.toContain("positive");
  });

  test("each required kind is named when it is the one missing", () => {
    for (const missing of REQUIRED_CASE_KINDS) {
      const kinds = REQUIRED_CASE_KINDS.filter((k) => k !== missing);
      const cases = [
        ...kinds.map((k, i) => ({ id: `case-${i}`, kind: k })),
        { id: "case-filler", kind: kinds[0] as string },
      ];
      const issue = errors(checkEvals(complete({}, cases))).find((i) => i.rule === "evals.missing-case-kind");
      expect(issue?.message).toContain(missing);
    }
  });

  test("a skill declaring no tests at all is a failure, not an exemption", () => {
    const ctx = ctxFor({ "skills/alpha/skill.yaml": "id: alpha\n" });
    expect(errors(checkEvals(ctx)).some((i) => i.rule === "evals.too-few-cases")).toBe(true);
  });

  test("two declarations sharing an id is an error: the id is the join", () => {
    const ctx = complete({}, [
      { id: "same-id", kind: "positive" },
      { id: "same-id", kind: "negative" },
      { id: "third", kind: "adversarial" },
    ]);
    expect(errors(checkEvals(ctx)).some((i) => i.rule === "evals.duplicate-case-id")).toBe(true);
  });
});

describe("fixtures the cases point at", () => {
  test("a fixture path that resolves passes", () => {
    const cases = [{ ...THREE[0]!, fixture: "skills/alpha/tests/patch.diff" }, THREE[1]!, THREE[2]!];
    const ctx = complete({ "skills/alpha/tests/patch.diff": "diff\n" }, cases);
    expect(errors(checkEvals(ctx))).toEqual([]);
  });

  test("a fixture path that resolves to nothing is an error naming the declaring case", () => {
    const cases = [{ ...THREE[0]!, fixture: "skills/alpha/tests/absent.diff" }, THREE[1]!, THREE[2]!];
    const issue = errors(checkEvals(complete({}, cases))).find((i) => i.rule === "evals.fixture-not-found");
    expect(issue?.file).toBe("skills/alpha/tests/absent.diff");
    expect(issue?.message).toContain("fires-on-trigger");
  });

  test("a fixture outside the skill's own tests/ is a warning, not a silent pass", () => {
    const cases = [{ ...THREE[0]!, fixture: "shared/patch.diff" }, THREE[1]!, THREE[2]!];
    const ctx = complete({ "shared/patch.diff": "diff\n" }, cases);
    const issue = checkEvals(ctx).find((i) => i.rule === "evals.fixture-outside-skill");
    expect(issue?.severity).toBe("warning");
    expect(issue?.message).toContain("skills/alpha/tests/");
  });
});

describe("release scenario coverage", () => {
  test("uncovered scenario numbers are reported", () => {
    const note = checkEvals(complete()).find((i) => i.rule === "evals.uncovered-scenarios");
    expect(note?.severity).toBe("note");
    // Asserted against the list rather than the whole message. The earlier form
    // searched the message for a bare `1` to show scenario 1 was absent, which
    // read the prose as well as the list and so could not survive the message
    // saying anything else numeric. Parsing out the list is what the test meant
    // and is stronger besides: the set is compared exactly, so a scenario
    // wrongly listed fails as loudly as one wrongly missing.
    const listed = /^release scenarios no case tags: ([^.]+)\./.exec(note?.message ?? "")?.[1];
    expect(listed).toBe(RELEASE_SCENARIOS.filter((n) => n !== 1).join(", "));
  });

  test("a case tagging every scenario leaves none uncovered", () => {
    const tags = `[${RELEASE_SCENARIOS.map((n) => `scenario-${String(n).padStart(2, "0")}`).join(", ")}]`;
    const files: Record<string, string> = { "skills/alpha/skill.yaml": declare(THREE) };
    for (const c of THREE) files[`${EVALS_DIR}/alpha/${c.id}/case.yaml`] = CASE(c.id, tags);
    const issues = checkEvals(ctxFor(files));
    expect(issues.filter((i) => i.rule === "evals.uncovered-scenarios")).toEqual([]);
  });

  test("the note says what it counted, and does not claim the tagged scenarios were tested", () => {
    // The message read "The corpus must cover all 24 across the catalog", which
    // is a claim about testing made by a check that counted tag strings. Every
    // reader of a run reporting 17 took it to mean 17 untested and 7 tested. A
    // case reduced to `tags: [scenario-18]` produces the identical reading.
    const note = checkEvals(complete()).find((i) => i.rule === "evals.uncovered-scenarios");
    expect(note?.message).toMatch(/tag/);
    expect(note?.message).toMatch(/not|nothing|no case was/i);
    expect(note?.message).not.toContain("must cover");
  });
});

describe("a scenario tag outside the release range", () => {
  const tagged = (tags: string) => {
    const files: Record<string, string> = { "skills/alpha/skill.yaml": declare(THREE) };
    for (const c of THREE) files[`${EVALS_DIR}/alpha/${c.id}/case.yaml`] = CASE(c.id, tags);
    return checkEvals(ctxFor(files));
  };
  const rejected = (tags: string) => tagged(tags).filter((i) => i.rule === "evals.scenario-tag-out-of-range");

  test("scenario-31 is an error naming the case file and the tag", () => {
    // `scenario-31` typed for `scenario-13` parses, contributes nothing to
    // `covered`, and is filtered back out of `uncovered` because that list runs
    // over 1-29. The writer loses the scenario they meant and the run says
    // nothing, which is indistinguishable from never having tagged the case.
    const issue = rejected("[scenario-31]")[0];
    expect(issue?.severity).toBe("error");
    expect(issue?.file).toBe(`${EVALS_DIR}/alpha/fires-on-trigger/case.yaml`);
    expect(issue?.message).toContain("scenario-31");
    expect(issue?.message).toContain("29");
  });

  test("scenario-29 is accepted: the boundary is the only input that separates the two checks", () => {
    // The control, and the reason there are two assertions. An off-by-one range
    // test and a correct one agree on every out-of-range input; they differ on
    // 29 alone, so the first test above passes under both.
    expect(rejected("[scenario-29]")).toEqual([]);
    expect(rejected("[scenario-01]")).toEqual([]);
  });

  test("scenario-0 is rejected at the low end too", () => {
    expect(rejected("[scenario-0]")).toHaveLength(3);
    expect(rejected("[scenario-00]")).toHaveLength(3);
  });

  test("a tag that is not a scenario claim at all is left alone", () => {
    // The population this rule owns is tags claiming a release scenario. A tag
    // naming something else is not a malformed scenario tag, and reporting one
    // would make the rule fire on every corpus that tags anything.
    expect(rejected("[smoke, slow]")).toEqual([]);
  });

  test("a scenario claim the old pattern silently dropped is reported, not ignored", () => {
    // `^scenario-(\d{1,2})$` did not match these, so they never reached the
    // range test and were discarded with the same silence. The prefix is the
    // claim; what follows it is either a scenario in range or a mistake.
    expect(rejected("[scenario-100]")).toHaveLength(3);
    expect(rejected("[scenario-1a]")).toHaveLength(3);
  });

  test("an out-of-range tag contributes nothing to coverage while its neighbour does", () => {
    // Paired in one case so the two readings come from the same run: 2 leaves
    // the uncovered list and 31 never enters it. Without the valid tag beside
    // it, `covered` is empty, the note is suppressed by its own guard, and the
    // assertion would pass on a build that counted 31 as coverage.
    const issues = tagged("[scenario-02, scenario-31]");
    expect(issues.some((i) => i.rule === "evals.scenario-tag-out-of-range")).toBe(true);
    const uncovered = issues.find((i) => i.rule === "evals.uncovered-scenarios");
    expect(uncovered?.message).toContain("1, 3, 4");
    expect(uncovered?.message).not.toMatch(/\b31\b/);
  });
});

describe("absent trees", () => {
  test("no evals directory and no authored skills reports a note, not a crash", () => {
    const ctx = ctxFor({});
    const issues = checkEvals(ctx);
    expect(issues.every((i) => i.severity !== "error" || i.rule === "evals.too-few-cases")).toBe(true);
    expect(issues.some((i) => i.rule === "evals.directory-unavailable")).toBe(true);
  });

  test("a skill with no skill.yaml is not judged here", () => {
    const ctx = ctxFor({ [`${EVALS_DIR}/README.md`]: "cases live here\n" });
    expect(errors(checkEvals(ctx)).filter((i) => i.file === "skills/alpha/skill.yaml")).toEqual([]);
  });
});

describe("one scenario written two ways", () => {
  const tagged = (tags: string) => {
    const files: Record<string, string> = { "skills/alpha/skill.yaml": declare(THREE) };
    for (const c of THREE) files[`${EVALS_DIR}/alpha/${c.id}/case.yaml`] = CASE(c.id, tags);
    return checkEvals(ctxFor(files));
  };
  const spelling = (tags: string) => tagged(tags).filter((i) => i.rule === "evals.scenario-tag-noncanonical");

  // `scenarioTags` reads `Number("06")` as 6, so a padded tag has always counted
  // toward coverage and nothing here changes that. What it costs is readers:
  // three scenarios in this tree are tagged both ways across different files, and
  // every ad-hoc `grep scenario-6` over the corpus -- including mine, which is
  // what produced a false gap report and sent two lanes after it -- silently
  // excludes one spelling while looking exactly like a search that found
  // everything. The validator was right and was not consulted.
  test("a padded tag is reported, naming both spellings", () => {
    const issue = spelling("[scenario-06]")[0];
    expect(issue?.severity).toBe("warning");
    expect(issue?.message).toContain("scenario-06");
    expect(issue?.message).toContain("scenario-6");
  });

  test("the canonical spelling is not reported", () => {
    expect(spelling("[scenario-6]")).toEqual([]);
  });

  test("a two-digit scenario is canonical as written", () => {
    // The boundary that separates "strip leading zeros" from "tags must be one
    // character": 24 has no padded form and must not be reported.
    expect(spelling("[scenario-24]")).toEqual([]);
  });

  test("padding still counts toward coverage, because this rule is about spelling", () => {
    // The control against fixing the spelling by dropping the tag. If a future
    // change made a padded tag non-covering, this is the assertion that fails.
    const uncovered = tagged("[scenario-06]").find((i) => i.rule === "evals.uncovered-scenarios");
    expect(uncovered?.message).not.toMatch(/\b6\b/);
  });

  test("a tag that is not a scenario claim is left alone", () => {
    expect(spelling("[smoke, slow]")).toEqual([]);
  });
});

describe("one case copied across skills", () => {
  // Seven cases tagged `scenario-20` were read as seven tests of that scenario.
  // Three of them carried a byte-identical grader set under a byte-identical
  // directory name. They are seven tests of seven bodies and one test of the
  // scenario, and nothing in the tree said so: `evals.uncovered-scenarios`
  // counts tag strings, and a copy carries its tag like any other case.
  const TWO_SKILLS = CATALOG.replace(
    "    invocation: U\n",
    "    invocation: U\n  - id: beta\n    status: authored\n    invocation: U\n",
  );

  /** The same case body under two skills, with `mutate` applied to beta's. */
  function pair(mutate: (yaml: string) => string) {
    // Each case id gets its own expectation, so the only copies in the fixture
    // are the alpha/beta pairs. Writing all three alike instead made every case
    // in a skill a copy of its siblings, and the check said so -- correctly,
    // and in a way that made the removal control below look broken.
    const body = (name: string) =>
      `schema_version: "1.1"\nname: ${name}\ntags: [scenario-1]\nexecution:\n  prompt: "resume after the interrupted publish"\ngraders:\n  - name: reads-back-before-writing\n    type: llm\n    criteria: The ${name} key is re-derived from the run id and the input artifact hash.\n`;
    const root = makeTree({
      "catalog.yaml": TWO_SKILLS,
      "skills/alpha/SKILL.md": "# Alpha\n",
      "skills/beta/SKILL.md": "# Beta\n",
      "skills/alpha/skill.yaml": declare(THREE),
      "skills/beta/skill.yaml": declare(THREE).replace("id: alpha", "id: beta"),
      ...Object.fromEntries(
        THREE.flatMap((c) => [
          [`${EVALS_DIR}/alpha/${c.id}/case.yaml`, body(c.id)],
          [`${EVALS_DIR}/beta/${c.id}/case.yaml`, mutate(body(c.id))],
        ]),
      ),
    });
    const { catalog } = loadCatalog(root);
    if (catalog === null) throw new Error("fixture has no catalog");
    return checkEvals({ root, catalog }).filter((i) => i.rule === "evals.duplicate-graders");
  }

  test("an identical grader set in two skills is reported, naming both", () => {
    const [first] = pair((y) => y);
    expect(first).toBeDefined();
    expect(first?.severity).toBe("note");
    expect(first?.message).toContain("evals/alpha/fires-on-trigger");
    expect(first?.message).toContain("evals/beta/fires-on-trigger");
  });

  test("the same pair with one grader's expectation changed is not reported", () => {
    // The removal control. Without it the check could be reporting the pair's
    // existence rather than its sameness, and would pass this suite either way.
    expect(pair((y) => y.replace("run id", "operation id"))).toHaveLength(0);
  });

  test("a tool_used grader shared by every skill is not a copy", () => {
    // `tool_used: Skill` is the same assertion wherever it appears and must not
    // group. Without this the check would report the whole corpus as copies of
    // itself, which is the failure mode that makes a warning class unclearable.
    const root = makeTree({
      "catalog.yaml": TWO_SKILLS,
      "skills/alpha/SKILL.md": "# Alpha\n",
      "skills/beta/SKILL.md": "# Beta\n",
      "skills/alpha/skill.yaml": declare(THREE),
      "skills/beta/skill.yaml": declare(THREE).replace("id: alpha", "id: beta"),
      ...Object.fromEntries(
        THREE.flatMap((c) => [
          [`${EVALS_DIR}/alpha/${c.id}/case.yaml`, CASE(c.id)],
          [`${EVALS_DIR}/beta/${c.id}/case.yaml`, CASE(c.id)],
        ]),
      ),
    });
    const { catalog } = loadCatalog(root);
    if (catalog === null) throw new Error("fixture has no catalog");
    expect(checkEvals({ root, catalog }).filter((i) => i.rule === "evals.duplicate-graders")).toHaveLength(0);
  });

  test("renaming the grader does not evade it", () => {
    // A copy is a copy. `name` is a label on the grader, not a thing it decides.
    const issues = pair((y) => y.replace("reads-back-before-writing", "derives-the-key"));
    expect(issues.length).toBeGreaterThan(0);
  });

  test("a case with no counterpart is not reported", () => {
    // The population control: one skill's corpus alone can contain no copy.
    const root = makeTree({
      "catalog.yaml": CATALOG,
      "skills/alpha/SKILL.md": "# Alpha\n",
      "skills/alpha/skill.yaml": declare(THREE),
      // Distinct expectations per case. Written with `CASE`'s single
      // `tool_used` grader instead, this control would pass because the check
      // ignores that grader type -- true, and true whether or not the check
      // works, so it would certify nothing.
      ...Object.fromEntries(
        THREE.map((c) => [
          `${EVALS_DIR}/alpha/${c.id}/case.yaml`,
          `schema_version: "1.1"\nname: ${c.id}\ntags: [scenario-1]\nexecution:\n  prompt: "p"\ngraders:\n  - name: g\n    type: llm\n    criteria: The run ${c.id} and stops.\n`,
        ]),
      ),
    });
    const { catalog } = loadCatalog(root);
    if (catalog === null) throw new Error("fixture has no catalog");
    expect(checkEvals({ root, catalog }).filter((i) => i.rule === "evals.duplicate-graders")).toHaveLength(0);
  });
});

describe("what decides a grader, and what a shared name decides", () => {
  const TWO = CATALOG.replace(
    "    invocation: U\n",
    "    invocation: U\n  - id: beta\n    status: authored\n    invocation: U\n",
  );

  /** A case file carrying exactly the graders given. */
  const caseWith = (name: string, graders: string) =>
    `schema_version: "1.1"\nname: ${name}\ntags: [scenario-1]\nexecution:\n  prompt: "p"\ngraders:\n${graders}`;

  /** Two skills with the same three case ids, each case written by `body`. */
  function twoSkills(body: (skill: string, caseId: string) => string) {
    const files: Record<string, string> = {
      "catalog.yaml": TWO,
      "skills/alpha/SKILL.md": "# Alpha\n",
      "skills/beta/SKILL.md": "# Beta\n",
      "skills/alpha/skill.yaml": declare(THREE),
      "skills/beta/skill.yaml": declare(THREE).replace("id: alpha", "id: beta"),
    };
    for (const skill of ["alpha", "beta"]) {
      for (const c of THREE) files[`${EVALS_DIR}/${skill}/${c.id}/case.yaml`] = body(skill, c.id);
    }
    const root = makeTree(files);
    const { catalog } = loadCatalog(root);
    if (catalog === null) throw new Error("fixture has no catalog");
    return checkEvals({ root, catalog });
  }

  const rule = (issues: ReturnType<typeof checkEvals>, name: string) => issues.filter((i) => i.rule === name);

  test("an empty expected outcome groups instead of vanishing", () => {
    // Decision 1's positive test. The filter this replaces was justified on the
    // schema permitting an empty expectation, which it does not; deleting it
    // without asserting the new behavior would swap an untested filter for an
    // untested absence, which is the same thing nobody is watching.
    const issues = rule(
      twoSkills(() => caseWith("c", `  - name: g\n    type: llm\n    criteria: ""\n`)),
      "evals.duplicate-graders",
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain("an empty string");
    expect(issues[0]?.message).toContain("evals/alpha/fires-on-trigger");
    expect(issues[0]?.message).toContain("evals/beta/fires-on-trigger");
  });

  test("a regex pattern shared across skills is reported, naming the field it keyed on", () => {
    // Decision 2. `regex.pattern` is free text authored per case, so repetition
    // there means what repetition in an expectation means. Excluded before, on
    // the reasoning that applied to `tool`.
    const issues = rule(
      twoSkills((_skill, caseId) => caseWith(caseId, `  - name: g\n    type: regex\n    pattern: needs-${caseId}\n`)),
      "evals.duplicate-graders",
    );
    expect(issues).toHaveLength(THREE.length);
    expect(issues[0]?.message).toContain("`pattern`");
  });

  test("the same pair with the patterns differentiated is not reported", () => {
    // The removal control: without it the check could be reporting that two
    // regex graders exist rather than that they say the same thing.
    expect(
      rule(
        twoSkills((skill, caseId) =>
          caseWith(caseId, `  - name: g\n    type: regex\n    pattern: needs-${skill}-${caseId}\n`),
        ),
        "evals.duplicate-graders",
      ),
    ).toHaveLength(0);
  });

  test("a tool named identically in every skill is still not a copy", () => {
    // `tool` is a closed vocabulary the harness owns. Grouping on it would
    // report the corpus as a copy of itself, which is what makes a note class
    // unclearable. Decision 2 widens the check; it must not widen to this.
    expect(
      rule(
        twoSkills((_skill, caseId) => caseWith(caseId, `  - name: g\n    type: tool_used\n    tool: Skill\n`)),
        "evals.duplicate-graders",
      ),
    ).toHaveLength(0);
  });

  test("a grader type the table has no row for is refused rather than guessed", () => {
    const issues = twoSkills((_skill, caseId) =>
      caseWith(caseId, `  - name: g\n    type: baseline\n    baseline_file: base.md\n    criteria: matches\n`),
    );
    const refusals = rule(issues, "evals.grader-type-unclassified");
    expect(refusals).toHaveLength(2 * THREE.length);
    expect(refusals[0]?.severity).toBe("error");
    expect(refusals[0]?.message).toContain("baseline");
    expect(refusals[0]?.message).toContain("DECIDED_BY");
    // And it does not quietly group them on a field nobody has said decides
    // anything: six identical unknown graders produce six refusals and no note.
    expect(rule(issues, "evals.duplicate-graders")).toHaveLength(0);
  });

  test("the same case directory name and grader name in two skills is reported", () => {
    // Decision 3. Exact and non-tunable: two names matching at once, not a
    // similarity score over one text, because any threshold gets tuned until it
    // reports nothing and the tuning looks like calibration.
    const issues = twoSkills((skill, caseId) =>
      caseWith(caseId, `  - name: reads-back\n    type: llm\n    criteria: The ${skill} run stops at ${caseId}.\n`),
    );
    const names = rule(issues, "evals.duplicate-case-names");
    expect(names).toHaveLength(THREE.length);
    expect(names[0]?.severity).toBe("note");
    expect(names[0]?.message).toContain("evals/alpha/fires-on-trigger");
    expect(names[0]?.message).toContain("evals/beta/fires-on-trigger");
    // The expectations differ, so the text key is silent and this note is the
    // only thing that sees the copy. That is the recall this key was added for.
    expect(rule(issues, "evals.duplicate-graders")).toHaveLength(0);
  });

  test("differing grader names under the same directory name are not reported", () => {
    // Removal control on half the conjunction. A directory name repeats because
    // the behavior repeats; on its own it is not evidence of anything.
    expect(
      rule(
        twoSkills((skill, caseId) =>
          caseWith(
            caseId,
            `  - name: reads-back-${skill}\n    type: llm\n    criteria: The ${skill} run stops at ${caseId}.\n`,
          ),
        ),
        "evals.duplicate-case-names",
      ),
    ).toHaveLength(0);
  });

  test("the same grader name under differing directory names is not reported", () => {
    // Removal control on the other half, and the miss stated in the note: a
    // copy renamed on the way in is invisible to this key.
    const files: Record<string, string> = {
      "catalog.yaml": TWO,
      "skills/alpha/SKILL.md": "# Alpha\n",
      "skills/beta/SKILL.md": "# Beta\n",
      "skills/alpha/skill.yaml": declare(THREE),
      "skills/beta/skill.yaml": declare(THREE.map((c) => ({ ...c, id: `${c.id}-b` }))).replace("id: alpha", "id: beta"),
    };
    for (const c of THREE) {
      const grader = `  - name: reads-back\n    type: llm\n    criteria: The run stops at ${c.id}.\n`;
      files[`${EVALS_DIR}/alpha/${c.id}/case.yaml`] = caseWith(c.id, grader);
      files[`${EVALS_DIR}/beta/${c.id}-b/case.yaml`] = caseWith(`${c.id}-b`, grader.replace("stops at", "halts at"));
    }
    const root = makeTree(files);
    const { catalog } = loadCatalog(root);
    if (catalog === null) throw new Error("fixture has no catalog");
    expect(rule(checkEvals({ root, catalog }), "evals.duplicate-case-names")).toHaveLength(0);
  });

  test("the name note says what the text note holds that it does not, and the reverse", () => {
    // The two keys are different projections of one family and neither contains
    // the other. Reported as two notes over two subsets with nothing joining
    // them, one family reads as two findings.
    const THREE_SKILLS = TWO.replace(
      "  - id: beta\n",
      "  - id: gamma\n    status: authored\n    invocation: U\n  - id: beta\n",
    );
    const GAMMA = THREE.map((c) => ({ ...c, id: `g-${c.id}` }));
    /** One sentence per case id, so each text group is exactly one pair. */
    const shared = (caseId: string) => `The ${caseId} record is read back before it is written.`;
    const files: Record<string, string> = {
      "catalog.yaml": THREE_SKILLS,
      "skills/alpha/SKILL.md": "# Alpha\n",
      "skills/beta/SKILL.md": "# Beta\n",
      "skills/gamma/SKILL.md": "# Gamma\n",
      "skills/alpha/skill.yaml": declare(THREE),
      "skills/beta/skill.yaml": declare(THREE).replace("id: alpha", "id: beta"),
      "skills/gamma/skill.yaml": declare(GAMMA).replace("id: alpha", "id: gamma"),
    };
    for (const c of THREE) {
      // alpha and beta share the directory name and the grader name; only beta
      // shares gamma's sentence.
      files[`${EVALS_DIR}/alpha/${c.id}/case.yaml`] = caseWith(
        c.id,
        `  - name: reads-back\n    type: llm\n    criteria: The alpha run stops at ${c.id}.\n`,
      );
      files[`${EVALS_DIR}/beta/${c.id}/case.yaml`] = caseWith(
        c.id,
        `  - name: reads-back\n    type: llm\n    criteria: ${shared(c.id)}\n`,
      );
    }
    for (const c of GAMMA) {
      files[`${EVALS_DIR}/gamma/${c.id}/case.yaml`] = caseWith(
        c.id,
        `  - name: reads-it\n    type: llm\n    criteria: ${shared(c.id.slice("g-".length))}\n`,
      );
    }
    const root = makeTree(files);
    const { catalog } = loadCatalog(root);
    if (catalog === null) throw new Error("fixture has no catalog");
    const issues = checkEvals({ root, catalog });
    const names = rule(issues, "evals.duplicate-case-names");
    expect(names).toHaveLength(THREE.length);
    const message = names[0]?.message ?? "";
    // The text key holds gamma, which this key cannot reach because gamma's
    // directory was renamed; this key holds alpha, which the text key cannot
    // reach because alpha's sentence was reworded. Two subsets of one family,
    // neither inside the other, and each note now names the difference.
    expect(message).toContain("names evals/gamma/g-fires-on-trigger/case.yaml beside these");
    expect(message).toContain("does not name evals/alpha/fires-on-trigger/case.yaml");
    expect(message).toContain("neither group contains the other");
    expect(rule(issues, "evals.duplicate-graders")).toHaveLength(THREE.length);
  });
});
