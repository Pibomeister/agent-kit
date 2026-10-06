import { describe, expect, test } from "bun:test";

import { checkCompleteness } from "../src/validation/completeness.ts";
import { loadCatalog } from "../src/catalog/load.ts";
import { makeTree } from "./helpers/tree.ts";

function catalogYaml(body: string): string {
  return `schema_version: 1\npackage:\n  id: ak\n  name: agent-kit\n  version: 0.1.0\n  namespace: "/ak:"\n  default_profile: core\n${body}`;
}

function run(files: Record<string, string>) {
  const root = makeTree(files);
  const { catalog } = loadCatalog(root);
  if (catalog === null) throw new Error("fixture has no catalog");
  return { root, issues: checkCompleteness({ root, catalog }) };
}

const SKILL_BODY = "---\nname: alpha\ndescription: Does a thing when asked.\n---\n\n# Alpha\n";

describe("catalog completeness", () => {
  test("a contract entry with no directory is reported as not-yet-authored, not an error", () => {
    const { issues } = run({
      "catalog.yaml": catalogYaml("skills:\n  - id: alpha\n    status: contract\n    invocation: U\n"),
    });
    expect(issues.some((i) => i.severity === "error")).toBe(false);
    const pending = issues.find((i) => i.rule === "catalog.entry-not-authored");
    expect(pending?.severity).toBe("note");
    expect(pending?.message).toContain("alpha");
  });

  test("an authored entry with no directory is an error", () => {
    const { issues } = run({
      "catalog.yaml": catalogYaml("skills:\n  - id: alpha\n    status: authored\n    invocation: U\n"),
    });
    const issue = issues.find((i) => i.rule === "catalog.entry-without-directory");
    expect(issue?.severity).toBe("error");
    expect(issue?.file).toBe("skills/alpha");
  });

  test("an undeclared directory is an error in every directory-backed section", () => {
    const { issues } = run({
      "catalog.yaml": catalogYaml("skills: []\npacks: []\nprotocols: []\nroles: []\nreferences: []\n"),
      "skills/ghost/SKILL.md": SKILL_BODY,
      "packs/pack-ghost/PACK.md": "# Ghost\n",
      "protocols/ghost/PROTOCOL.md": "# Ghost\n",
      "roles/ghost/ROLE.md": "# Ghost\n",
      "references/ghost/REFERENCE.md": "# Ghost\n",
    });
    const undeclared = issues.filter((i) => i.rule === "catalog.directory-without-entry");
    expect(undeclared.map((i) => i.file).sort()).toEqual([
      "packs/pack-ghost",
      "protocols/ghost",
      "references/ghost",
      "roles/ghost",
      "skills/ghost",
    ]);
    expect(undeclared.every((i) => i.severity === "error")).toBe(true);
  });

  test("an authored skill directory without SKILL.md is an error", () => {
    const { issues } = run({
      "catalog.yaml": catalogYaml("skills:\n  - id: alpha\n    status: authored\n"),
      "skills/alpha/skill.yaml": "id: alpha\n",
    });
    const issue = issues.find((i) => i.rule === "catalog.entry-missing-body");
    expect(issue?.severity).toBe("error");
    expect(issue?.message).toContain("SKILL.md");
  });

  test("a nested role id resolves to a nested directory and its group dir is not undeclared", () => {
    const { issues } = run({
      "catalog.yaml": catalogYaml("roles:\n  - id: code-review/security\n    status: authored\n"),
      "roles/code-review/security/ROLE.md": "# Security\n",
    });
    expect(issues.filter((i) => i.severity === "error")).toEqual([]);
  });

  test("an empty group directory is a batch that has not run yet, reported as a note", () => {
    const { issues } = run({
      "catalog.yaml": catalogYaml("roles:\n  - id: code-review/security\n    status: contract\n"),
      "roles/code-review/.keep": "",
    });
    expect(issues.some((i) => i.severity === "error")).toBe(false);
    const issue = issues.find((i) => i.rule === "catalog.container-without-entries");
    expect(issue?.severity).toBe("note");
    expect(issue?.file).toBe("roles/code-review");
  });

  test("a directory that is neither an entry nor a prefix of one stays an error", () => {
    const { issues } = run({
      "catalog.yaml": catalogYaml("roles:\n  - id: code-review/security\n    status: contract\n"),
      "roles/stray/.keep": "",
    });
    const issue = issues.find((i) => i.rule === "catalog.directory-without-entry");
    expect(issue?.severity).toBe("error");
    expect(issue?.file).toBe("roles/stray");
  });

  test("a nested directory whose id is not declared is an error", () => {
    const { issues } = run({
      "catalog.yaml": catalogYaml("roles:\n  - id: code-review/security\n    status: authored\n"),
      "roles/code-review/security/ROLE.md": "# Security\n",
      "roles/code-review/intruder/ROLE.md": "# Intruder\n",
    });
    const issue = issues.find((i) => i.rule === "catalog.directory-without-entry");
    expect(issue?.file).toBe("roles/code-review/intruder");
  });

  test("a body present while status is still contract is a warning, not an error", () => {
    const { issues } = run({
      "catalog.yaml": catalogYaml("skills:\n  - id: alpha\n    status: contract\n"),
      "skills/alpha/SKILL.md": SKILL_BODY,
    });
    expect(issues.some((i) => i.severity === "error")).toBe(false);
    expect(issues.some((i) => i.rule === "catalog.status-behind-body" && i.severity === "warning")).toBe(true);
  });

  test("file-backed sections report an authored entry whose file is missing", () => {
    const { issues } = run({
      "catalog.yaml": catalogYaml(
        "schemas:\n  - id: ticket\n    status: authored\npolicies:\n  - id: review\n    status: authored\n",
      ),
    });
    expect(
      issues
        .filter((i) => i.rule === "catalog.entry-without-file")
        .map((i) => i.file)
        .sort(),
    ).toEqual(["policies/review.yaml", "schemas/ticket.schema.json"]);
  });

  test("an undeclared schema or policy file is an error", () => {
    const { issues } = run({
      "catalog.yaml": catalogYaml("schemas: []\npolicies: []\nprofiles: []\nadapters: []\n"),
      "schemas/rogue.schema.json": "{}",
      "policies/rogue.yaml": "a: 1\n",
      "profiles/rogue.yaml": "a: 1\n",
      "adapters/rogue/CONTRACT.md": "# Rogue\n",
    });
    expect(
      issues
        .filter((i) => i.rule === "catalog.file-without-entry")
        .map((i) => i.file)
        .sort(),
    ).toEqual(["adapters/rogue", "policies/rogue.yaml", "profiles/rogue.yaml", "schemas/rogue.schema.json"]);
  });

  test("a fully coherent tree produces no errors", () => {
    const { issues } = run({
      "catalog.yaml": catalogYaml(
        "skills:\n  - id: alpha\n    status: authored\npacks: []\nprotocols: []\nroles: []\nreferences: []\nschemas: []\npolicies: []\nprofiles: []\nadapters: []\n",
      ),
      "skills/alpha/SKILL.md": SKILL_BODY,
    });
    expect(issues.filter((i) => i.severity === "error")).toEqual([]);
  });
});

describe("catalog completeness across catalog.d fragments", () => {
  const PROFILE_FRAGMENT =
    "schema_version: 1\nprofiles:\n  - id: downstream\n    batch: 1\n    status: authored\n    summary: A downstream install set.\n";

  test("a profile a fragment declares is complete once its file exists, with catalog.yaml unchanged", () => {
    // The case the directory exists for: a downstream install adds a profile
    // without a line of catalog.yaml changing.
    const { issues } = run({
      "catalog.yaml": catalogYaml("profiles: []\n"),
      "catalog.d/downstream.yaml": PROFILE_FRAGMENT,
      "profiles/downstream.yaml": "schema_version: 1\nprofile: downstream\n",
    });
    expect(issues).toEqual([]);
  });

  test("a fragment's authored entry with no file names the fragment, not catalog.yaml", () => {
    const { issues } = run({
      "catalog.yaml": catalogYaml("profiles: []\n"),
      "catalog.d/downstream.yaml": PROFILE_FRAGMENT,
    });
    const issue = issues.find((i) => i.rule === "catalog.entry-without-file");
    expect(issue?.severity).toBe("error");
    expect(issue?.message).toStartWith("catalog.d/downstream.yaml declares profiles/downstream as authored");
  });

  test("an undeclared file says a fragment could have declared it", () => {
    const { issues } = run({
      "catalog.yaml": catalogYaml("profiles: []\n"),
      "profiles/downstream.yaml": "schema_version: 1\n",
    });
    const issue = issues.find((i) => i.rule === "catalog.file-without-entry");
    expect(issue?.message).toContain("no catalog.d/ fragment does");
  });
});
