import { describe, expect, test } from "bun:test";

import {
  checkCatalogRules,
  checkPackManifests,
  checkProfileCapabilities,
  checkSkillManifests,
} from "../src/validation/configrules.ts";
import { loadCatalog } from "../src/catalog/load.ts";
import { makeTree } from "./helpers/tree.ts";

const HEAD = `schema_version: 1
package:
  id: ak
  name: agent-kit
  version: 0.1.0
  namespace: "/ak:"
  default_profile: core
`;

function ctxFor(files: Record<string, string>) {
  const root = makeTree(files);
  const { catalog } = loadCatalog(root);
  if (catalog === null) throw new Error("fixture has no catalog");
  return { root, catalog };
}

function rulesOf(issues: Array<{ rule: string }>): string[] {
  return issues.map((i) => i.rule);
}

describe("catalog rules", () => {
  const clean = `${HEAD}skills:
  - id: super-review
    invocation: U
    status: contract
  - id: diagnose
    invocation: M
    status: contract
references:
  - id: review-lanes
    status: contract
    loaded_by: [super-review]
profiles:
  - id: core
    status: contract
    default: true
  - id: autonomy
    status: contract
`;

  test("a consistent catalog produces no catalog rule issues", () => {
    expect(rulesOf(checkCatalogRules(ctxFor({ "catalog.yaml": clean })))).toEqual([]);
  });

  test("a cross-section collision is a warning naming both sections, not a gate", () => {
    const catalog = `${HEAD}skills:
  - id: triage
    invocation: U
    status: contract
protocols:
  - id: triage
    status: contract
profiles:
  - id: core
    status: contract
    default: true
`;
    // No reference form in the package resolves a bare id across sections:
    // profiles group by kind, resolved-conflicts `binds` groups by kind, schemas
    // $ref by filename, and the packager emits per-section directories. The
    // signal is worth keeping visible, but it is not a false gate.
    const issue = checkCatalogRules(ctxFor({ "catalog.yaml": catalog })).find(
      (i) => i.rule === "catalog.ids-unique-across-all-sections-and-every-entry-has-a-directory",
    );
    expect(issue?.severity).toBe("warning");
    expect(issue?.message).toContain("skills");
    expect(issue?.message).toContain("protocols");
  });

  test("a collision inside one section stays an error: it is the section that resolves an id", () => {
    const catalog = `${HEAD}skills:
  - id: triage
    invocation: U
    status: contract
  - id: triage
    invocation: M
    status: contract
profiles:
  - id: core
    status: contract
    default: true
`;
    const root = makeTree({ "catalog.yaml": catalog });
    const issue = loadCatalog(root).issues.find((i) => i.rule === "catalog.duplicate-id");
    expect(issue?.severity).toBe("error");
  });

  test("catalog.reference-loaded-by-names-a-declared-skill catches an undeclared loader", () => {
    const catalog = clean.replace("loaded_by: [super-review]", "loaded_by: [ghost-skill]");
    expect(rulesOf(checkCatalogRules(ctxFor({ "catalog.yaml": catalog })))).toContain(
      "catalog.reference-loaded-by-names-a-declared-skill",
    );
  });

  test("catalog.exactly-one-default-profile-matching-package-default-profile catches a second default", () => {
    const catalog = clean.replace(
      "  - id: autonomy\n    status: contract\n",
      "  - id: autonomy\n    status: contract\n    default: true\n",
    );
    expect(rulesOf(checkCatalogRules(ctxFor({ "catalog.yaml": catalog })))).toContain(
      "catalog.exactly-one-default-profile-matching-package-default-profile",
    );
  });

  test("a second default declared in a catalog.d/ fragment is reported against the fragment", () => {
    // The default is package.default_profile's to name, and a fragment carries
    // no package block, so a fragment's `default: true` is the fragment's defect.
    const fragment = "schema_version: 1\nprofiles:\n  - id: downstream\n    status: contract\n    default: true\n";
    const issue = checkCatalogRules(ctxFor({ "catalog.yaml": clean, "catalog.d/downstream.yaml": fragment })).find(
      (i) => i.rule === "catalog.exactly-one-default-profile-matching-package-default-profile",
    );
    expect(issue?.severity).toBe("error");
    expect(issue?.file).toBe("catalog.d/downstream.yaml");
    expect(issue?.message).toContain("core, downstream in catalog.d/downstream.yaml");
  });

  test("a fragment's reference with an undeclared loader is reported against the fragment", () => {
    const fragment =
      "schema_version: 1\nreferences:\n  - id: downstream-notes\n    status: contract\n    loaded_by: [ghost-skill]\n";
    const issue = checkCatalogRules(ctxFor({ "catalog.yaml": clean, "catalog.d/downstream.yaml": fragment })).find(
      (i) => i.rule === "catalog.reference-loaded-by-names-a-declared-skill",
    );
    expect(issue?.file).toBe("catalog.d/downstream.yaml");
  });

  test("catalog.exactly-one-default-profile-matching-package-default-profile catches a mismatched package default", () => {
    const catalog = clean.replace("default_profile: core", "default_profile: autonomy");
    expect(rulesOf(checkCatalogRules(ctxFor({ "catalog.yaml": catalog })))).toContain(
      "catalog.exactly-one-default-profile-matching-package-default-profile",
    );
  });
});

describe("skill manifest rules", () => {
  const catalog = `${HEAD}skills:
  - id: super-review
    invocation: U
    status: contract
  - id: super-ship
    invocation: U
    status: contract
  - id: diagnose
    invocation: M
    status: contract
`;

  test("a consistent skill manifest produces no skill rule issues", () => {
    const ctx = ctxFor({
      "catalog.yaml": catalog,
      "skills/super-review/skill.yaml":
        "id: super-review\ninvocation: U\nchild_skills: [diagnose]\nlimits:\n  fix_cycles: 2\nbudget:\n  provided_by: runner\n  enforces: [fix_cycles]\n",
    });
    expect(rulesOf(checkSkillManifests(ctx))).toEqual([]);
  });

  test("skill.user-invoked-never-starts-user-invoked catches a U child", () => {
    const ctx = ctxFor({
      "catalog.yaml": catalog,
      "skills/super-review/skill.yaml": "id: super-review\ninvocation: U\nchild_skills: [super-ship]\n",
    });
    expect(rulesOf(checkSkillManifests(ctx))).toContain("skill.user-invoked-never-starts-user-invoked");
  });

  test("skill.user-invoked-never-starts-user-invoked reads the child's own invocation, not the parent's claim", () => {
    const ctx = ctxFor({
      "catalog.yaml": catalog,
      "skills/super-review/skill.yaml": "id: super-review\ninvocation: U\nchild_skills: [diagnose]\n",
      "skills/diagnose/skill.yaml": "id: diagnose\ninvocation: U\n",
    });
    expect(rulesOf(checkSkillManifests(ctx))).toContain("skill.user-invoked-never-starts-user-invoked");
  });

  test("capability.artifact-write-missing catches a schema-bound output without the capability", () => {
    const ctx = ctxFor({
      "catalog.yaml": catalog,
      "skills/diagnose/skill.yaml":
        "id: diagnose\ninvocation: M\nrequires: [repository-read]\noutputs:\n  - id: report\n  - id: repro-ticket\n    schema: ticket\n",
    });
    const issues = checkSkillManifests(ctx).filter((i) => i.rule === "capability.artifact-write-missing");
    expect(issues.map((i) => [i.severity, i.file])).toEqual([["error", "skills/diagnose/skill.yaml"]]);
    expect(issues[0]?.message).toContain("repro-ticket: ticket");
  });

  test("capability.artifact-write-missing passes a schema-bound output that requires the capability", () => {
    const ctx = ctxFor({
      "catalog.yaml": catalog,
      "skills/diagnose/skill.yaml":
        "id: diagnose\ninvocation: M\nrequires: [repository-read, artifact-write]\noutputs:\n  - id: repro-ticket\n    schema: ticket\n",
    });
    expect(rulesOf(checkSkillManifests(ctx))).toEqual([]);
  });

  test("capability.artifact-write-missing leaves a skill with no schema-bound output alone in both directions", () => {
    // The reverse direction is not enforced: a skill may write an envelope
    // artifact that no schema_id names yet.
    const ctx = ctxFor({
      "catalog.yaml": catalog,
      "skills/diagnose/skill.yaml": "id: diagnose\ninvocation: M\nrequires: [artifact-write]\noutputs:\n  - id: note\n",
      "skills/super-ship/skill.yaml":
        "id: super-ship\ninvocation: U\nrequires: [repository-read]\noutputs:\n  - id: note\n",
    });
    expect(rulesOf(checkSkillManifests(ctx))).toEqual([]);
  });

  test("skill.budget-enforces-only-declared-limits catches an undeclared limit", () => {
    const ctx = ctxFor({
      "catalog.yaml": catalog,
      "skills/super-review/skill.yaml":
        "id: super-review\ninvocation: U\nlimits:\n  fix_cycles: 2\nbudget:\n  provided_by: runner\n  enforces: [fix_cycles, wall_clock]\n",
    });
    expect(rulesOf(checkSkillManifests(ctx))).toContain("skill.budget-enforces-only-declared-limits");
  });

  test("skill.budget-enforces-only-declared-limits catches a budget this package computes itself", () => {
    const ctx = ctxFor({
      "catalog.yaml": catalog,
      "skills/super-review/skill.yaml":
        "id: super-review\ninvocation: U\nbudget:\n  provided_by: skill\n  enforces: []\n",
    });
    expect(rulesOf(checkSkillManifests(ctx))).toContain("skill.budget-enforces-only-declared-limits");
  });
});

describe("pack manifest rules", () => {
  const catalog = `${HEAD}packs:
  - id: pack-secure
    status: contract
`;
  const goodRule =
    'id: pack-secure\nactivation:\n  rules:\n    - id: auth-surface\n      artifact_kinds: [source-file]\n      semantics: [authentication]\n      paths: ["src/auth/**"]\n  examples:\n    - artifact: src/auth/session.ts\n      attaches: true\n      why: authentication boundary\n    - artifact: src/util/pad.ts\n      attaches: false\n      why: no security semantics\n  classifier_optional: true\n';

  test("a consistent pack manifest produces no pack rule issues", () => {
    expect(
      rulesOf(checkPackManifests(ctxFor({ "catalog.yaml": catalog, "packs/pack-secure/pack.yaml": goodRule }))),
    ).toEqual([]);
  });

  test("pack.activation-requires-artifact-and-semantics catches a path-only rule", () => {
    const manifest =
      'id: pack-secure\nactivation:\n  rules:\n    - id: by-extension\n      artifact_kinds: []\n      semantics: []\n      paths: ["**/*.ts"]\n  examples:\n    - artifact: a\n      attaches: true\n      why: x\n    - artifact: b\n      attaches: false\n      why: y\n';
    expect(
      rulesOf(checkPackManifests(ctxFor({ "catalog.yaml": catalog, "packs/pack-secure/pack.yaml": manifest }))),
    ).toContain("pack.activation-requires-artifact-and-semantics");
  });

  test("pack.activation-requires-artifact-and-semantics requires a negative example", () => {
    const manifest = goodRule.replace("attaches: false", "attaches: true");
    expect(
      rulesOf(checkPackManifests(ctxFor({ "catalog.yaml": catalog, "packs/pack-secure/pack.yaml": manifest }))),
    ).toContain("pack.activation-requires-artifact-and-semantics");
  });

  test("pack.attachment-records-rationale-and-matched-rule catches a record with no matched rule", () => {
    const record = JSON.stringify({
      schema: "review",
      packs_attached: [
        {
          pack: "pack-secure",
          matched_rules: [],
          rationale: "felt right",
          evidence: [{ ref: "e" }],
          attached_at: "2026-09-19T00:00:00Z",
        },
      ],
    });
    const ctx = ctxFor({ "catalog.yaml": catalog, "templates/review.json": record });
    expect(rulesOf(checkPackManifests(ctx))).toContain("pack.attachment-records-rationale-and-matched-rule");
  });

  test("pack.attachment-records-rationale-and-matched-rule catches an attachment carrying a grant", () => {
    const record = JSON.stringify({
      schema: "review",
      packs_attached: [
        {
          pack: "pack-secure",
          matched_rules: ["auth-surface"],
          rationale: "authentication boundary",
          evidence: [{ ref: "e" }],
          attached_at: "2026-09-19T00:00:00Z",
          grant: { charter_hash: "x", covers: "ship" },
        },
      ],
    });
    const ctx = ctxFor({ "catalog.yaml": catalog, "templates/review.json": record });
    expect(rulesOf(checkPackManifests(ctx))).toContain("pack.attachment-records-rationale-and-matched-rule");
  });
});

describe("a manifest that will not parse", () => {
  const MALFORMED = "id: [unclosed\n";

  // `line N, column N` can only have come from the parser, so requiring it rules
  // out a message that dropped the cause and kept the template. It does not rule
  // out a mis-narrowed cause: `yaml` throws only Error subclasses for a string
  // input, so every way of reading `.message` off it agrees here.
  const carriesTheReason = (message: string | undefined) => {
    expect(message ?? "").toMatch(/line \d+, column \d+/);
    expect(message ?? "").not.toContain("undefined");
  };

  test("a skill manifest is reported under the skill's own rule, against the skill's file", () => {
    const catalog = `${HEAD}skills:
  - id: triage
    invocation: U
    status: contract
`;
    const issues = checkSkillManifests(ctxFor({ "catalog.yaml": catalog, "skills/triage/skill.yaml": MALFORMED }));
    expect(rulesOf(issues)).toEqual(["skill.user-invoked-never-starts-user-invoked"]);
    expect(issues[0]?.file).toBe("skills/triage/skill.yaml");
    carriesTheReason(issues[0]?.message);
  });

  test("a pack manifest is reported under the pack's own rule, against the pack's file", () => {
    const catalog = `${HEAD}packs:
  - id: pack-secure
    status: contract
`;
    const issues = checkPackManifests(ctxFor({ "catalog.yaml": catalog, "packs/pack-secure/pack.yaml": MALFORMED }));
    expect(rulesOf(issues)).toEqual(["pack.activation-requires-artifact-and-semantics"]);
    expect(issues[0]?.file).toBe("packs/pack-secure/pack.yaml");
    carriesTheReason(issues[0]?.message);
  });
});

describe("profile capabilities", () => {
  const catalog = `${HEAD}profiles:
  - id: core
    status: contract
    default: true
  - id: maintainer
    status: contract
`;
  const COMMON = JSON.stringify({
    $defs: { capability: { enum: ["repository-read", "repository-write", "artifact-write", "kb-write"] } },
  });
  const profile = (required: string, added: string) =>
    `id: maintainer\nincludes:\n  capabilities:\n    required: [${required}]\n    commonly_added: [${added}]\n    note: prose, not ids\n`;

  test("a side-effect id under commonly_added is an error against that profile", () => {
    const issues = checkProfileCapabilities(
      ctxFor({
        "catalog.yaml": catalog,
        "schemas/common.schema.json": COMMON,
        "profiles/core.yaml": profile("repository-read", "kb-write"),
        "profiles/maintainer.yaml": profile("repository-read, artifact-write", "kb-write, skill-source-write"),
      }),
    );
    expect(issues.map((i) => [i.rule, i.severity, i.file])).toEqual([
      ["profile.unknown-capability", "error", "profiles/maintainer.yaml"],
    ]);
    expect(issues[0]?.message).toContain("commonly_added lists skill-source-write");
  });

  test("an unknown id under required is an error too", () => {
    const issues = checkProfileCapabilities(
      ctxFor({
        "catalog.yaml": catalog,
        "schemas/common.schema.json": COMMON,
        "profiles/core.yaml": profile("repository-read, disk-write", "kb-write"),
      }),
    );
    expect(issues.map((i) => i.message)).toEqual([expect.stringContaining("required lists disk-write")]);
  });

  test("an unknown id under any other list is an error, whatever the list is called", () => {
    const issues = checkProfileCapabilities(
      ctxFor({
        "catalog.yaml": catalog,
        "schemas/common.schema.json": COMMON,
        "profiles/core.yaml": `${profile("repository-read", "kb-write")}    rarely_added: [skill-source-write]\n`,
      }),
    );
    expect(issues.map((i) => [i.rule, i.file])).toEqual([["profile.unknown-capability", "profiles/core.yaml"]]);
    expect(issues[0]?.message).toContain("rarely_added lists skill-source-write");
  });

  test("an unparseable profile is reported as unparseable, not as an unknown capability", () => {
    const issues = checkProfileCapabilities(
      ctxFor({
        "catalog.yaml": catalog,
        "schemas/common.schema.json": COMMON,
        "profiles/core.yaml": profile("repository-read", "kb-write"),
        "profiles/maintainer.yaml": "id: maintainer\nincludes: [unclosed\n",
      }),
    );
    expect(issues.map((i) => [i.rule, i.severity, i.file])).toEqual([
      ["profile.unparseable", "error", "profiles/maintainer.yaml"],
    ]);
  });

  test("profiles listing only capabilities pass", () => {
    const issues = checkProfileCapabilities(
      ctxFor({
        "catalog.yaml": catalog,
        "schemas/common.schema.json": COMMON,
        "profiles/core.yaml": profile("repository-read", "kb-write"),
        "profiles/maintainer.yaml": profile("repository-read, artifact-write", "repository-write"),
      }),
    );
    expect(issues).toEqual([]);
  });

  test("with no readable capability vocabulary the lists are unexamined, and that blocks", () => {
    const issues = checkProfileCapabilities(
      ctxFor({ "catalog.yaml": catalog, "profiles/core.yaml": profile("repository-read", "skill-source-write") }),
    );
    expect(issues.map((i) => [i.rule, i.blocking])).toEqual([["profile.capability-vocabulary-unavailable", true]]);
  });
});
