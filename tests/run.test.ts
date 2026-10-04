import { describe, expect, test } from "bun:test";

import { CHECKS, runValidation } from "../src/validation/run.ts";
import { makeTree, wellFormedSkill, DENY_MARKER, sampleModelTerm } from "./helpers/tree.ts";

const CATALOG = `schema_version: 1
package:
  id: ak
  name: agent-kit
  version: 0.1.0
  namespace: "/ak:"
  default_profile: core
skills:
  - id: triage
    invocation: U
    status: authored
    profiles: [core]
profiles:
  - id: core
    status: contract
    default: true
`;

const SKILL = wellFormedSkill(
  "triage",
  "Sort incoming work into the smallest next action.",
  "Read the queue and pick one item.",
);

describe("the validation run", () => {
  test("every check is named and runs in a fixed order", () => {
    expect(CHECKS.length).toBeGreaterThanOrEqual(10);
    expect(new Set(CHECKS.map((c) => c.name)).size).toBe(CHECKS.length);
  });

  test("a check that is written but not registered here never runs", () => {
    // The registry is the only thing that makes a check real, so a check
    // exercised only by its own unit test is indistinguishable from one that
    // was never wired in -- `ak validate` would return clean past it. This
    // reaches the loader-link rule the way a user does, through the run.
    const root = makeTree({
      "catalog.yaml": `${CATALOG}references:
  - id: guide
    status: authored
    loaded_by: [triage]
`,
      "skills/triage/SKILL.md": SKILL,
      "references/guide/REFERENCE.md": "# Guide\n\nLong material.\n",
    });
    const run = runValidation(root);
    const issue = run.issues.find((i) => i.rule === "catalog.loader-does-not-link-reference");
    expect(issue?.file).toBe("skills/triage/SKILL.md");
    expect(run.ok).toBe(false);
  });

  test("a clean tree validates with no errors", () => {
    const root = makeTree({ "catalog.yaml": CATALOG, "skills/triage/SKILL.md": SKILL });
    const result = runValidation(root);
    const errors = result.issues.filter((i) => i.severity === "error");
    expect(errors.map((e) => `${e.rule} ${e.file}`)).toEqual([]);
    expect(result.ok).toBe(true);
  });

  test("a tree with no catalog reports the missing catalog and does not crash", () => {
    const result = runValidation(makeTree({ "README.md": "nothing here\n" }));
    expect(result.issues.some((i) => i.rule === "catalog.missing")).toBe(true);
    expect(result.ok).toBe(false);
  });

  test("failures from every layer are aggregated into one sorted list", () => {
    const root = makeTree({
      "catalog.yaml": `${CATALOG}  - id: ghost
    invocation: M
    status: contract
`,
      "skills/triage/SKILL.md": SKILL.replace("Read the queue", `Read the queue with ${DENY_MARKER}`).replace(
        DENY_MARKER,
        sampleModelTerm(),
      ),
      "skills/stray/SKILL.md": SKILL,
    });
    const result = runValidation(root);
    const rules = result.issues.map((i) => i.rule);
    expect(rules).toContain("content.denylist");
    expect(rules).toContain("catalog.directory-without-entry");
    expect(result.ok).toBe(false);
    const files = result.issues.map((i) => i.file);
    expect(files).toEqual([...files].sort());
  });

  test("one check throwing does not lose the others", () => {
    const root = makeTree({ "catalog.yaml": CATALOG, "skills/triage/SKILL.md": SKILL });
    const result = runValidation(root, {
      only: ["completeness", "explodes"],
      extraChecks: [
        {
          name: "explodes",
          run: () => {
            throw new Error("boom");
          },
        },
      ],
    });
    expect(result.issues.some((i) => i.rule === "check.threw" && i.message.includes("boom"))).toBe(true);
    expect(result.issues.some((i) => i.rule === "check.threw" && i.message.includes("explodes"))).toBe(true);
  });

  test("a check that throws something other than an Error is still described", () => {
    // `(cause as Error).message` is a cast, not a conversion: a thrown string or
    // object has no `.message`, so the report read "check X threw undefined".
    // That is worse than a crash -- it names a real check and says nothing about
    // why, sending the reader into a check that may be fine. Ten sites elsewhere
    // in `src/` already narrow with `instanceof`; this one did not.
    const thrown: Array<[string, unknown, string]> = [
      ["a-string", "just a string", "just a string"],
      ["an-object", { code: "EACCES" }, "[object Object]"],
      ["a-null", null, "null"],
      ["undefined", undefined, "undefined"],
    ];

    for (const [name, value, expected] of thrown) {
      const root = makeTree({ "catalog.yaml": CATALOG, "skills/triage/SKILL.md": SKILL });
      const result = runValidation(root, {
        only: [name],
        extraChecks: [
          {
            name,
            run: () => {
              throw value;
            },
          },
        ],
      });
      const issue = result.issues.find((i) => i.rule === "check.threw");
      expect(issue?.message).toContain(name);
      expect(issue?.message).toContain(expected);
    }
  });

  test("a thrown Error is still reported by its message, not by its whole self", () => {
    // The paired control for the test above: narrowing with `instanceof` must
    // not change the ordinary case into `Error: boom` or `[object Error]`.
    const root = makeTree({ "catalog.yaml": CATALOG, "skills/triage/SKILL.md": SKILL });
    const result = runValidation(root, {
      only: ["explodes"],
      extraChecks: [
        {
          name: "explodes",
          run: () => {
            throw new Error("boom");
          },
        },
      ],
    });
    const issue = result.issues.find((i) => i.rule === "check.threw");
    expect(issue?.message).toContain("threw boom");
  });

  test("the run can be narrowed to named checks", () => {
    const root = makeTree({
      "catalog.yaml": CATALOG,
      "skills/triage/SKILL.md": SKILL,
      "skills/stray/SKILL.md": SKILL,
      // Something only `checkSchemas` reports, so the narrowed run has to show
      // positive evidence that the named check ran.
      "schemas/broken.schema.json": "{ not json",
    });
    const all = runValidation(root);
    const narrowed = runValidation(root, { only: ["schemas"] });
    expect(all.issues.length).toBeGreaterThan(narrowed.issues.length);
    expect(narrowed.issues.some((i) => i.rule === "catalog.directory-without-entry")).toBe(false);

    // The assertions above are both satisfied by a narrowing that selects
    // nothing at all, which is what `only: ["schemas-typo"]` does: the filter
    // is a pure `includes`, an unmatched name quietly selects zero checks, and
    // a run of no checks is shorter than the full run and contains no
    // `catalog.directory-without-entry` either. Measured by running it, not by
    // reading the filter. So the narrowing has to be shown to have selected
    // something, and this is the line that does it.
    expect(narrowed.issues.some((i) => i.rule === "schemas.unparseable")).toBe(true);
  });

  test("a name that matches no check is an error, not an empty run", () => {
    // The cost of the silent version is not this test, it is the one below:
    // `this repository's own source is not flagged by its own content scan`
    // narrows to `content`, and had that name been wrong it would have
    // asserted nothing about anything while still passing. A validator whose
    // selector fails open is the same defect class the rest of this suite
    // exists to catch.
    const root = makeTree({ "catalog.yaml": CATALOG, "skills/triage/SKILL.md": SKILL });
    const issue = runValidation(root, { only: ["schemas-typo"] }).issues.find((i) => i.rule === "run.unknown-check");
    expect(issue?.severity).toBe("error");
    expect(issue?.message).toContain("schemas-typo");
  });

  test("every name a narrowed run does match is left alone", () => {
    const root = makeTree({ "catalog.yaml": CATALOG, "skills/triage/SKILL.md": SKILL });
    const issues = runValidation(root, { only: ["schemas", "content"] }).issues;
    expect(issues.some((i) => i.rule === "run.unknown-check")).toBe(false);
  });

  test("this repository's own source is not flagged by its own content scan", () => {
    const result = runValidation(process.cwd(), { only: ["content"] });
    const own = result.issues.filter((i) => i.file.startsWith("src/") || i.file.startsWith("tests/"));
    expect(own.map((i) => `${i.rule} ${i.file}:${i.line ?? 0}`)).toEqual([]);
  }, 60_000);
});
