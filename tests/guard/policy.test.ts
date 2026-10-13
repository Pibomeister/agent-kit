import { join } from "node:path";
import type { ValidateFunction } from "ajv";
import { describe, expect, test } from "bun:test";

import { loadGuardPolicy, parseGuardPolicy, policyRuleIds } from "../../src/guard/policy.ts";
import { compileSchemas } from "../../src/validation/schemas.ts";

const ROOT = join(import.meta.dir, "..", "..");
const FIXTURE = join(ROOT, "tests", "fixtures", "guard", "policy.yaml");

function compileValidator(): ValidateFunction {
  const validate = compileSchemas(ROOT).validatorFor("guard-policy");
  if (validate === undefined) throw new Error("schemas/guard-policy.schema.json did not compile");
  return validate;
}

const VALIDATE = compileValidator();

function validator(): ValidateFunction {
  return VALIDATE;
}

const MINIMAL = `version: 1.0.0
protected_paths: []
destructive_commands: []
secret_paths: []
path_tiers: []
governed_paths: []
`;

function rules(result: { issues: ReadonlyArray<{ rule: string }> }): string[] {
  return result.issues.map((i) => i.rule);
}

describe("guard policy loader", () => {
  test("the hand-written example policy loads with no issues", () => {
    const result = loadGuardPolicy(FIXTURE, ROOT);
    expect(result.issues).toEqual([]);
    expect(result.policy?.version).toBe("0.1.0");
  });

  test("the example declares every protected category the plan names", () => {
    const policy = loadGuardPolicy(FIXTURE, ROOT).policy;
    const categories = new Set<string>(policy?.protected_paths.map((p) => p.category));
    for (const category of [
      "tests",
      "ci-config",
      "lint-config",
      "architecture-config",
      "baselines",
      "codeowners",
      "hook-config",
      "registry",
    ]) {
      expect(categories.has(category)).toBe(true);
    }
  });

  test("JSON is accepted as well as YAML, so a generated policy round-trips", () => {
    const policy = loadGuardPolicy(FIXTURE, ROOT).policy;
    const again = parseGuardPolicy(JSON.stringify(policy), validator(), "policy.json");
    expect(again.issues).toEqual([]);
    expect(again.policy).toEqual(policy);
  });

  test("a missing file is an issue, not an empty policy", () => {
    const result = loadGuardPolicy(join(ROOT, "tests", "fixtures", "guard", "absent.yaml"), ROOT);
    expect(result.policy).toBeNull();
    expect(rules(result)).toEqual(["guard.policy-missing"]);
  });

  test("text that is not YAML is refused", () => {
    expect(rules(parseGuardPolicy("version: [", validator(), "p.yaml"))).toEqual(["guard.policy-unparseable"]);
  });

  test("a duplicate YAML key is refused rather than last-wins", () => {
    expect(rules(parseGuardPolicy(`${MINIMAL}version: 2.0.0\n`, validator(), "p.yaml"))).toEqual([
      "guard.policy-unparseable",
    ]);
  });

  const INVALID: ReadonlyArray<[string, string]> = [
    ["an unknown top-level key", `${MINIMAL}extra: true\n`],
    ["a missing section", MINIMAL.replace("governed_paths: []\n", "")],
    [
      "a rule id under the evaluator's reserved prefix",
      MINIMAL.replace("secret_paths: []", "secret_paths:\n  - { id: guard.mine, globs: ['.env'], reason: no }"),
    ],
    [
      "a single-word rule id",
      MINIMAL.replace("secret_paths: []", "secret_paths:\n  - { id: dotenv, globs: ['.env'], reason: no }"),
    ],
    [
      "an absolute glob",
      MINIMAL.replace("secret_paths: []", "secret_paths:\n  - { id: secret.etc, globs: ['/etc/shadow'], reason: no }"),
    ],
    [
      "an unknown protected category",
      MINIMAL.replace(
        "protected_paths: []",
        "protected_paths:\n  - { id: protected.docs, category: docs, globs: ['docs/**'], reason: no }",
      ),
    ],
    [
      "a tier outside never and ask-first",
      MINIMAL.replace(
        "path_tiers: []",
        "path_tiers:\n  - { id: tier.open, tier: open, globs: ['src/**'], reason: no }",
      ),
    ],
    [
      "a destructive pattern whose program has a directory",
      MINIMAL.replace(
        "destructive_commands: []",
        "destructive_commands:\n  - { id: d.rm, program: /bin/rm, reason: no }",
      ),
    ],
    [
      "an option group that is not an option",
      MINIMAL.replace(
        "destructive_commands: []",
        "destructive_commands:\n  - { id: d.rm, program: rm, all_of: [[recursive]], reason: no }",
      ),
    ],
    [
      "a governed path with no article",
      MINIMAL.replace("governed_paths: []", "governed_paths:\n  - { id: governed.x, globs: ['src/**'], articles: [] }"),
    ],
    [
      "a two-line reason",
      MINIMAL.replace("secret_paths: []", 'secret_paths:\n  - { id: secret.env, globs: [".env"], reason: "a\\nb" }'),
    ],
  ];

  for (const [what, text] of INVALID) {
    test(`refuses ${what}`, () => {
      const result = parseGuardPolicy(text, validator(), "p.yaml");
      expect(result.policy).toBeNull();
      expect(rules(result)).toEqual(["guard.policy-invalid"]);
    });
  }

  test("a rule id used in two sections is refused, which the schema cannot see", () => {
    const text = MINIMAL.replace(
      "secret_paths: []",
      "secret_paths:\n  - { id: rule.same, globs: ['.env'], reason: no }",
    ).replace("path_tiers: []", "path_tiers:\n  - { id: rule.same, tier: never, globs: ['vendor/**'], reason: no }");
    const result = parseGuardPolicy(text, validator(), "p.yaml");
    expect(result.policy).toBeNull();
    expect(rules(result)).toEqual(["guard.policy-duplicate-rule-id"]);
  });

  test("a glob with unbalanced braces is refused", () => {
    const text = MINIMAL.replace(
      "secret_paths: []",
      "secret_paths:\n  - { id: secret.env, globs: ['{a,b'], reason: no }",
    );
    expect(rules(parseGuardPolicy(text, validator(), "p.yaml"))).toEqual(["guard.policy-bad-glob"]);
  });

  test("every section the loader's type carries is one the schema requires", () => {
    const policy = loadGuardPolicy(FIXTURE, ROOT).policy;
    if (policy === null) throw new Error("the example policy did not load");
    const sections = Object.keys(policy);
    expect(sections.length).toBe(6);
    for (const section of sections) {
      const without = Object.fromEntries(Object.entries(policy).filter(([key]) => key !== section));
      expect(validator()(without)).toBe(false);
    }
    const ids = policyRuleIds(policy);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
