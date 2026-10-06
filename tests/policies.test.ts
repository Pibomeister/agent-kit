import { describe, expect, test } from "bun:test";

import { checkPolicies } from "../src/validation/policies.ts";
import { loadCatalog } from "../src/catalog/load.ts";
import { makeTree } from "./helpers/tree.ts";

const CATALOG = `schema_version: 1
package:
  id: ak
  name: agent-kit
  version: 0.1.0
  namespace: "/ak:"
  default_profile: core
skills:
  - id: super-align
    invocation: U
    status: contract
  - id: autopilot
    invocation: U
    status: contract
  - id: diagnose
    invocation: M
    status: contract
policies:
  - id: invocation
    status: authored
`;

const POLICY = `schema_version: 1
policy: invocation
entrypoints:
  user_invoked:
    count: 2
    authority: explicit
    skills: [super-align, autopilot]
  model_invoked:
    count: 1
    authority: model
    skills: [diagnose]
operations:
  - id: align.run
    exposed_by: super-align
    authority: delegated-grant
    grant:
      covers: align-answer
    callable_by: [autopilot]
    on_unvalidatable_grant: stop-for-explicit-invocation
`;

function ctxFor(policy: string, catalog: string = CATALOG) {
  const root = makeTree({ "catalog.yaml": catalog, "policies/invocation.yaml": policy });
  const loaded = loadCatalog(root);
  if (loaded.catalog === null) throw new Error("fixture has no catalog");
  return { root, catalog: loaded.catalog };
}

function rulesOf(issues: Array<{ rule: string }>): string[] {
  return issues.map((i) => i.rule);
}

describe("policies/invocation.yaml", () => {
  test("a consistent policy produces no issues", () => {
    expect(rulesOf(checkPolicies(ctxFor(POLICY)))).toEqual([]);
  });

  test("an absent policy file is a reported note, never a crash", () => {
    const root = makeTree({ "catalog.yaml": CATALOG });
    const { catalog } = loadCatalog(root);
    const issues = checkPolicies({ root, catalog: catalog! });
    expect(issues.every((i) => i.severity !== "error")).toBe(true);
    expect(rulesOf(issues)).toContain("policy.invocation-unavailable");
  });

  test("an invocation that disagrees with the catalog is an error", () => {
    const policy = POLICY.replace("skills: [super-align, autopilot]", "skills: [super-align, diagnose]");
    expect(rulesOf(checkPolicies(ctxFor(policy)))).toContain("policy.invocation-disagrees-with-catalog");
  });

  test("a declared count that disagrees with the listed skills is an error", () => {
    const policy = POLICY.replace("count: 2", "count: 5");
    expect(rulesOf(checkPolicies(ctxFor(policy)))).toContain("policy.entrypoint-count-mismatch");
  });

  test("an operation exposed by an undeclared skill is an error", () => {
    const policy = POLICY.replace("exposed_by: super-align", "exposed_by: ghost-skill");
    expect(rulesOf(checkPolicies(ctxFor(policy)))).toContain("policy.operation-exposed-by-unknown-skill");
  });

  test("an operation callable by an undeclared skill is an error", () => {
    const policy = POLICY.replace("callable_by: [autopilot]", "callable_by: [ghost-skill]");
    expect(rulesOf(checkPolicies(ctxFor(policy)))).toContain("policy.operation-callable-by-unknown-skill");
  });

  test("an authority outside the common vocabulary is an error", () => {
    const policy = POLICY.replace("authority: delegated-grant", "authority: whenever");
    expect(rulesOf(checkPolicies(ctxFor(policy)))).toContain("policy.unknown-authority");
  });

  test("an operation id outside the operation_id pattern is an error", () => {
    const policy = POLICY.replace("id: align.run", "id: AlignRun");
    expect(rulesOf(checkPolicies(ctxFor(policy)))).toContain("policy.malformed-operation-id");
  });

  test("a duplicate operation id is an error", () => {
    const policy = `${POLICY}  - id: align.run
    exposed_by: super-align
    authority: delegated-grant
    grant:
      covers: align-answer
    callable_by: [autopilot]
    on_unvalidatable_grant: stop-for-explicit-invocation
`;
    expect(rulesOf(checkPolicies(ctxFor(policy)))).toContain("policy.duplicate-operation-id");
  });

  test("a grant covering something outside the common vocabulary is an error", () => {
    const policy = POLICY.replace("covers: align-answer", "covers: do-anything");
    expect(rulesOf(checkPolicies(ctxFor(policy)))).toContain("policy.unknown-grant-cover");
  });

  test("a grant-bearing operation that does not stop on an unvalidatable grant is an error", () => {
    const policy = POLICY.replace(
      "on_unvalidatable_grant: stop-for-explicit-invocation",
      "on_unvalidatable_grant: proceed",
    );
    expect(rulesOf(checkPolicies(ctxFor(policy)))).toContain("policy.side-door-on-unvalidatable-grant");
  });

  test.each(["delegated-grant", "explicit-or-delegated", "active-review-run"])(
    "the rule applies to authority %s, which is reached through a grant",
    (authority) => {
      const policy = POLICY.replace(
        "authority: delegated-grant\n    grant:",
        `authority: ${authority}\n    grant:`,
      ).replace("on_unvalidatable_grant: stop-for-explicit-invocation", "on_unvalidatable_grant: not-applicable");
      expect(rulesOf(checkPolicies(ctxFor(policy)))).toContain("policy.side-door-on-unvalidatable-grant");
    },
  );

  test("a model-authority operation has no grant to validate, so not-applicable is correct", () => {
    const policy = `${POLICY}  - id: lesson.capture
    exposed_by: diagnose
    authority: model
    side_effects: [kb-draft, artifact-write]
    on_unvalidatable_grant: not-applicable
`;
    expect(rulesOf(checkPolicies(ctxFor(policy)))).not.toContain("policy.side-door-on-unvalidatable-grant");
  });

  test("a model-authority operation with a remote side effect is the side door the rule was reaching for", () => {
    const policy = `${POLICY}  - id: lesson.publish
    exposed_by: diagnose
    authority: model
    side_effects: [kb-publish, artifact-write]
    on_unvalidatable_grant: not-applicable
`;
    const issue = checkPolicies(ctxFor(policy)).find(
      (i) => i.rule === "policy.remote-side-effect-under-model-authority",
    );
    expect(issue?.severity).toBe("error");
    expect(issue?.message).toContain("kb-publish");
  });

  test("a gated operation may declare a remote side effect", () => {
    const policy = `${POLICY}  - id: lesson.publish
    exposed_by: diagnose
    authority: explicit-or-delegated
    grant:
      covers: lesson-publication
    side_effects: [kb-publish, artifact-write]
    on_unvalidatable_grant: stop-for-explicit-invocation
`;
    expect(rulesOf(checkPolicies(ctxFor(policy)))).not.toContain("policy.remote-side-effect-under-model-authority");
  });

  test("a model-authority operation writing only a local draft passes", () => {
    const policy = `${POLICY}  - id: lesson.capture
    exposed_by: diagnose
    authority: model
    side_effects: [kb-draft, artifact-write, scratch-write]
    on_unvalidatable_grant: not-applicable
`;
    expect(rulesOf(checkPolicies(ctxFor(policy)))).not.toContain("policy.remote-side-effect-under-model-authority");
  });

  test("a skill listed in the policy but absent from the catalog is an error", () => {
    const policy = POLICY.replace("skills: [diagnose]", "skills: [diagnose, ghost-skill]");
    expect(rulesOf(checkPolicies(ctxFor(policy)))).toContain("policy.skill-not-in-catalog");
  });

  test("a catalog skill the policy never classifies is an error", () => {
    const policy = POLICY.replace("skills: [diagnose]", "skills: []").replace("count: 1", "count: 0");
    expect(rulesOf(checkPolicies(ctxFor(policy)))).toContain("policy.skill-not-classified");
  });

  // `per_entrypoint` is nested under `entrypoints:` in the authored policy, and
  // every case below puts it there. It used to be appended at column 0 in this
  // file, which is why the four checks that read it passed their tests for
  // weeks while never once running against `policies/invocation.yaml`.
  // One defect per row on POLICY, each through its own path, asserted by its exact message.
  test.each([
    [
      "an entrypoint group's authority",
      POLICY.replace("    authority: explicit\n", "    authority: whenever\n"),
      "entrypoints.user_invoked.authority is whenever, which is not a value of common#/$defs/authority",
    ],
    [
      "an operation with no authority",
      POLICY.replace("    authority: delegated-grant\n", ""),
      "align.run declares no authority",
    ],
    [
      "an also_requires grant",
      POLICY.replace(
        "    callable_by: [autopilot]\n",
        "    also_requires:\n      - covers: do-anything\n    callable_by: [autopilot]\n",
      ),
      "align.run requires a grant covering do-anything, which is not a checkpoint_category, grantable_action or sensitive_action in common",
    ],
    [
      "a count below the listed skills",
      POLICY.replace("count: 2", "count: 1"),
      "entrypoints.user_invoked.count is 1 but 2 skill(s) are listed",
    ],
    [
      "a user-invoked skill listed as model-invoked",
      POLICY.replace("skills: [super-align, autopilot]", "skills: [super-align]")
        .replace("count: 2", "count: 1")
        .replace("skills: [diagnose]", "skills: [diagnose, autopilot]")
        .replace("    count: 1\n    authority: model", "    count: 2\n    authority: model"),
      "autopilot is listed under entrypoints.model_invoked but catalog.yaml declares invocation U",
    ],
    [
      "a per_entrypoint skill the catalog does not declare",
      POLICY.replace(
        "operations:",
        "  per_entrypoint:\n    ghost-skill:\n      run:\n        invocation: U\noperations:",
      ),
      "per_entrypoint names ghost-skill, which catalog.yaml does not declare",
    ],
  ])("%s outside the vocabulary or the catalog is refused by name", (_path, policy, message) => {
    const issues = checkPolicies(ctxFor(policy));
    expect(issues.filter((i) => i.severity === "error").map((i) => i.message)).toEqual([message]);
  });

  const REVIEW_SKILL = `  - id: super-review
    invocation: U
    status: contract
    entrypoints:
      full:
        authority: explicit-or-delegated
        invocation: U
      readiness:
        authority: explicit-or-delegated
        invocation: U
policies:`;

  function policyWithPerEntrypoint(block: string): string {
    return POLICY.replace("skills: [super-align, autopilot]", "skills: [super-align, autopilot, super-review]")
      .replace("count: 2", "count: 3")
      .replace("operations:", `${block}operations:`);
  }

  test("a per-entrypoint invocation that disagrees with the catalog is an error", () => {
    const catalog = CATALOG.replace("policies:", REVIEW_SKILL);
    const policy = policyWithPerEntrypoint(`  per_entrypoint:
    super-review:
      full:
        invocation: M
        authority: explicit-or-delegated
      readiness:
        invocation: U
        authority: explicit-or-delegated
`);
    expect(rulesOf(checkPolicies(ctxFor(policy, catalog)))).toContain("policy.entrypoint-disagrees-with-catalog");
  });

  test("a per-entrypoint authority that disagrees with the catalog is an error", () => {
    const catalog = CATALOG.replace("policies:", REVIEW_SKILL);
    const policy = policyWithPerEntrypoint(`  per_entrypoint:
    super-review:
      full:
        invocation: U
        authority: explicit
      readiness:
        invocation: U
        authority: explicit-or-delegated
`);
    const messages = checkPolicies(ctxFor(policy, catalog))
      .filter((i) => i.rule === "policy.entrypoint-disagrees-with-catalog")
      .map((i) => i.message);
    expect(messages.some((m) => m.includes("authority") && m.includes("explicit-or-delegated"))).toBe(true);
  });

  test("an entrypoint the catalog declares and the policy omits is an error", () => {
    // The file heads this block "Must agree entry-for-entry with catalog.yaml",
    // and agreement entry-for-entry fails in both directions. Only the
    // policy-has-extra direction was ever checked.
    const catalog = CATALOG.replace("policies:", REVIEW_SKILL);
    const policy = policyWithPerEntrypoint(`  per_entrypoint:
    super-review:
      full:
        invocation: U
        authority: explicit-or-delegated
`);
    const messages = checkPolicies(ctxFor(policy, catalog))
      .filter((i) => i.rule === "policy.entrypoint-disagrees-with-catalog")
      .map((i) => i.message);
    expect(messages.some((m) => m.includes("readiness"))).toBe(true);
  });

  test("a per_entrypoint block at the top level is reported rather than ignored", () => {
    // The shape that hid the bug. Someone writing this block expects it to be
    // validated, so the one outcome that must not happen is silence.
    const catalog = CATALOG.replace("policies:", REVIEW_SKILL);
    const policy = `${POLICY.replace("skills: [super-align, autopilot]", "skills: [super-align, autopilot, super-review]").replace("count: 2", "count: 3")}per_entrypoint:
  super-review:
    full:
      invocation: M
      authority: explicit-or-delegated
`;
    const issues = checkPolicies(ctxFor(policy, catalog));
    expect(rulesOf(issues)).toContain("policy.per-entrypoint-misplaced");
    expect(issues.find((i) => i.rule === "policy.per-entrypoint-misplaced")?.message).toContain(
      "entrypoints.per_entrypoint",
    );
  });

  test("the authored policy's per-entrypoint block agrees with the catalog", () => {
    // The regression guard that would have caught the dead path: a correct
    // nested block produces no disagreement, so the checks are live and silent
    // rather than dead and silent -- which the suite could not tell apart.
    const catalog = CATALOG.replace("policies:", REVIEW_SKILL);
    const policy = policyWithPerEntrypoint(`  per_entrypoint:
    super-review:
      full:
        invocation: U
        authority: explicit-or-delegated
      readiness:
        invocation: U
        authority: explicit-or-delegated
`);
    const rules = rulesOf(checkPolicies(ctxFor(policy, catalog)));
    expect(rules).not.toContain("policy.entrypoint-disagrees-with-catalog");
    expect(rules).not.toContain("policy.per-entrypoint-misplaced");
  });
});

describe("a policy file that will not parse", () => {
  const MALFORMED = "policy: [unclosed\n";

  test("is the only thing reported: nothing downstream is judged against a policy nobody read", () => {
    const issues = checkPolicies(ctxFor(MALFORMED));
    expect(rulesOf(issues)).toEqual(["policy.unparseable"]);
    expect(issues[0]?.file).toBe("policies/invocation.yaml");
  });

  test("the error carries the parser's own reason", () => {
    // `line N, column N` can only have come from the parser, so requiring it
    // rules out a message that dropped the cause and kept the template. It does
    // not rule out a mis-narrowed cause: `yaml` throws only Error subclasses for
    // a string input, so every way of reading `.message` off it agrees here.
    const message = checkPolicies(ctxFor(MALFORMED))[0]?.message ?? "";
    expect(message).toMatch(/line \d+, column \d+/);
    expect(message).not.toContain("undefined");
  });
});
