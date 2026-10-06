import { describe, expect, test } from "bun:test";

import { loadCatalog } from "../src/catalog/load.ts";
import {
  DIRECTORY_SECTIONS,
  MANDATORY_BODY_SECTIONS,
  entryDir,
  preferredBodyFile,
  entryFilePath,
} from "../src/catalog/layout.ts";
import { makeTree } from "./helpers/tree.ts";

const MINIMAL = `schema_version: 1
package:
  id: ak
  name: agent-kit
  version: 0.1.0-dev
  namespace: "/ak:"
  default_profile: core
skills:
  - id: alpha
    invocation: U
    profiles: [core]
    status: contract
    provenance_origin: donor
    summary: One.
  - id: beta
    invocation: M
    profiles: [core]
    status: authored
    provenance_origin: conversation
    summary: Two.
packs: []
protocols: []
roles: []
references: []
schemas: []
policies: []
profiles: []
adapters: []
`;

describe("catalog loading", () => {
  test("parses package metadata and entries with their section", () => {
    const { catalog, issues } = loadCatalog(makeTree({ "catalog.yaml": MINIMAL }));
    expect(issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(catalog?.package.id).toBe("ak");
    expect(catalog?.package.defaultProfile).toBe("core");
    expect(catalog?.bySection("skills").map((e) => e.id)).toEqual(["alpha", "beta"]);
    expect(catalog?.get("skills", "beta")?.status).toBe("authored");
    expect(catalog?.get("skills", "alpha")?.invocation).toBe("U");
    expect(catalog?.get("skills", "beta")?.provenanceOrigin).toBe("conversation");
  });

  test("reports a missing catalog.yaml as an error rather than throwing", () => {
    const { catalog, issues } = loadCatalog(makeTree({}));
    expect(catalog).toBeNull();
    expect(issues.some((i) => i.rule === "catalog.missing" && i.severity === "error")).toBe(true);
  });

  test("reports unparseable YAML as an error rather than throwing", () => {
    const { catalog, issues } = loadCatalog(makeTree({ "catalog.yaml": "skills: [unclosed\n" }));
    expect(catalog).toBeNull();
    expect(issues.some((i) => i.rule === "catalog.unparseable")).toBe(true);
  });

  test("reports a duplicate id within a section", () => {
    const dup = MINIMAL.replace("  - id: beta", "  - id: alpha");
    const { issues } = loadCatalog(makeTree({ "catalog.yaml": dup }));
    expect(issues.some((i) => i.rule === "catalog.duplicate-id" && i.message.includes("alpha"))).toBe(true);
  });

  test("reports an id declared in two addressable sections", () => {
    // AGENTS.md rests its whole reclassification argument on this holding:
    // `tdd` and `attach-pack` are protocols "not skills", `standards-review`
    // and `spec-review` became roles, and the invocation law's mapping table is
    // only true because "no id is both a skill and a protocol". Nothing checked
    // it. An id in two of these sections makes the table false and leaves the
    // U/M partition undecidable for that id -- a body citing it by name no
    // longer names one thing.
    // Both reclassification directions the table actually uses are covered, so
    // dropping either `protocols` or `roles` from the rule fails here rather
    // than passing on the half that remains.
    const both = MINIMAL.replace(
      "protocols: []",
      "protocols:\n  - id: alpha\n    status: contract\n    summary: Also a protocol.",
    ).replace("roles: []", "roles:\n  - id: beta\n    status: contract\n    summary: Also a role.");
    const { issues } = loadCatalog(makeTree({ "catalog.yaml": both }));
    const hits = issues.filter((i) => i.rule === "catalog.id-in-two-addressable-sections");
    expect(hits.length).toBe(2);
    expect(hits.every((i) => i.severity === "error")).toBe(true);
    const alpha = hits.find((i) => i.message.includes("alpha"));
    expect(alpha?.message).toContain("skills");
    expect(alpha?.message).toContain("protocols");
    const beta = hits.find((i) => i.message.includes("beta"));
    expect(beta?.message).toContain("skills");
    expect(beta?.message).toContain("roles");
  });

  test("does not report an id shared by two sections that address different things", () => {
    // The rule has to stay narrow, and this is the case that keeps it narrow:
    // the real catalog declares `review` as both a schema and a policy, which
    // is `schemas/review.schema.json` and `policies/review.yaml` -- different
    // kinds of artifact that no citation confuses. Only the three sections a
    // skill id can be reclassified between are addressable in this sense.
    const shared = MINIMAL.replace(
      "schemas: []",
      "schemas:\n  - id: review\n    status: contract\n    summary: A schema.",
    ).replace("policies: []", "policies:\n  - id: review\n    status: contract\n    summary: A policy.");
    const { issues } = loadCatalog(makeTree({ "catalog.yaml": shared }));
    expect(issues.filter((i) => i.rule === "catalog.id-in-two-addressable-sections")).toEqual([]);
  });

  test("keeps per-entrypoint invocation for skills that declare entrypoints", () => {
    const withEntrypoints = MINIMAL.replace(
      "    summary: One.",
      `    entrypoints:
      full:
        authority: explicit-or-delegated
        invocation: U
      delta:
        authority: active-review-run
        invocation: M
    summary: One.`,
    );
    const { catalog } = loadCatalog(makeTree({ "catalog.yaml": withEntrypoints }));
    const alpha = catalog?.get("skills", "alpha");
    expect(alpha?.entrypoints?.delta?.invocation).toBe("M");
    expect(alpha?.entrypoints?.full?.authority).toBe("explicit-or-delegated");
  });

  test("a section absent from catalog.yaml yields no entries and no crash", () => {
    const { catalog, issues } = loadCatalog(makeTree({ "catalog.yaml": "schema_version: 1\npackage:\n  id: ak\n" }));
    expect(issues.some((i) => i.severity === "error")).toBe(false);
    expect(catalog?.bySection("skills")).toEqual([]);
  });
});

/**
 * `catalog.d/<name>.yaml` adds entries to catalog.yaml without editing it
 * (docs/decisions/0010-catalog-fragments.md). Every case here is a property a
 * downstream fork relies on when it takes catalog.yaml from upstream unchanged
 * and declares its own entries beside it.
 */
describe("catalog.d fragments", () => {
  const PROFILE_FRAGMENT = `schema_version: 1
profiles:
  - id: downstream
    batch: 1
    status: authored
    summary: A downstream install set.
`;

  test("a fragment's entries join their section after catalog.yaml's, and say which file declared them", () => {
    const { catalog, issues } = loadCatalog(
      makeTree({
        "catalog.yaml": MINIMAL,
        "catalog.d/b.yaml":
          "schema_version: 1\nskills:\n  - id: delta\n    invocation: M\n    status: contract\n    summary: Four.\n",
        "catalog.d/a.yaml":
          "schema_version: 1\nskills:\n  - id: gamma\n    invocation: U\n    status: contract\n    summary: Three.\n",
      }),
    );
    expect(issues.filter((i) => i.severity === "error")).toEqual([]);
    // File-name order, not directory order and not the order the tree was written in.
    expect(catalog?.bySection("skills").map((e) => e.id)).toEqual(["alpha", "beta", "gamma", "delta"]);
    expect(catalog?.fragments).toEqual(["catalog.d/a.yaml", "catalog.d/b.yaml"]);
    expect(catalog?.get("skills", "alpha")?.file).toBe("catalog.yaml");
    expect(catalog?.get("skills", "gamma")?.file).toBe("catalog.d/a.yaml");
    expect(catalog?.get("skills", "gamma")?.invocation).toBe("U");
  });

  test("a fragment redeclaring an id catalog.yaml declares is refused, and catalog.yaml's entry stands", () => {
    // The override a last-writer-wins merge would allow is the defect: an
    // upstream entry would change meaning in a fork without a line of
    // catalog.yaml changing.
    const { catalog, issues } = loadCatalog(
      makeTree({
        "catalog.yaml": MINIMAL,
        "catalog.d/downstream.yaml":
          "schema_version: 1\nskills:\n  - id: alpha\n    invocation: M\n    status: authored\n    summary: Replaced.\n",
      }),
    );
    const dup = issues.filter((i) => i.rule === "catalog.duplicate-id");
    expect(dup.length).toBe(1);
    expect(dup[0]?.severity).toBe("error");
    expect(dup[0]?.file).toBe("catalog.d/downstream.yaml");
    expect(dup[0]?.message).toContain("catalog.yaml");
    expect(catalog?.get("skills", "alpha")?.invocation).toBe("U");
    expect(catalog?.get("skills", "alpha")?.summary).toBe("One.");
    expect(catalog?.get("skills", "alpha")?.file).toBe("catalog.yaml");
  });

  test("two fragments declaring one id are refused against the later file", () => {
    const { issues } = loadCatalog(
      makeTree({
        "catalog.yaml": MINIMAL,
        "catalog.d/a.yaml": PROFILE_FRAGMENT,
        "catalog.d/b.yaml": PROFILE_FRAGMENT,
      }),
    );
    const dup = issues.filter((i) => i.rule === "catalog.duplicate-id");
    expect(dup.map((i) => i.file)).toEqual(["catalog.d/b.yaml"]);
    expect(dup[0]?.message).toContain("catalog.d/a.yaml");
  });

  test("a duplicate inside one fragment reads as a duplicate, not as a collision between files", () => {
    const twice = `${PROFILE_FRAGMENT}  - id: downstream\n    batch: 1\n    status: authored\n    summary: Again.\n`;
    const { issues } = loadCatalog(makeTree({ "catalog.yaml": MINIMAL, "catalog.d/a.yaml": twice }));
    const dup = issues.filter((i) => i.rule === "catalog.duplicate-id");
    expect(dup.length).toBe(1);
    expect(dup[0]?.message).toBe("Section 'profiles' declares id 'downstream' more than once.");
  });

  test("an id a fragment puts in a second addressable section is reported against the fragment", () => {
    const { issues } = loadCatalog(
      makeTree({
        "catalog.yaml": MINIMAL,
        "catalog.d/a.yaml":
          "schema_version: 1\nprotocols:\n  - id: alpha\n    status: contract\n    summary: Also a protocol.\n",
      }),
    );
    const hits = issues.filter((i) => i.rule === "catalog.id-in-two-addressable-sections");
    expect(hits.map((i) => i.file)).toEqual(["catalog.d/a.yaml"]);
  });

  test("a fragment never supplies package identity", () => {
    // The schema check reports the block (tests/schemas.test.ts); the loader
    // must not have read it in the meantime, or every consumer that does not
    // run the schema check would take a fork's identity from a fragment.
    const { catalog } = loadCatalog(
      makeTree({
        "catalog.yaml": MINIMAL,
        "catalog.d/a.yaml": "schema_version: 1\npackage:\n  id: other\n  default_profile: downstream\n",
      }),
    );
    expect(catalog?.package.id).toBe("ak");
    expect(catalog?.package.defaultProfile).toBe("core");
  });

  test("an unreadable fragment is reported against itself and left out, and catalog.yaml's entries still load", () => {
    const { catalog, issues } = loadCatalog(
      makeTree({
        "catalog.yaml": MINIMAL,
        "catalog.d/broken.yaml": "profiles: [unclosed\n",
        "catalog.d/list.yaml": "- id: downstream\n",
        "catalog.d/empty.yaml": "",
      }),
    );
    const unparseable = issues.filter((i) => i.rule === "catalog.unparseable");
    expect(unparseable.map((i) => i.file).toSorted()).toEqual([
      "catalog.d/broken.yaml",
      "catalog.d/empty.yaml",
      "catalog.d/list.yaml",
    ]);
    expect(unparseable.every((i) => i.severity === "error")).toBe(true);
    expect(catalog?.bySection("skills").map((e) => e.id)).toEqual(["alpha", "beta"]);
    expect(catalog?.fragments).toEqual([]);
  });

  test("a section that is not a list is reported against the fragment that wrote it", () => {
    const { issues } = loadCatalog(
      makeTree({ "catalog.yaml": MINIMAL, "catalog.d/a.yaml": "schema_version: 1\nprofiles:\n  id: downstream\n" }),
    );
    const hits = issues.filter((i) => i.rule === "catalog.section-not-a-list");
    expect(hits.map((i) => i.file)).toEqual(["catalog.d/a.yaml"]);
  });

  test("only .yaml and .yml files are fragments", () => {
    const { catalog } = loadCatalog(
      makeTree({
        "catalog.yaml": MINIMAL,
        "catalog.d/README.md": "profiles:\n  - id: prose\n",
        "catalog.d/a.yml": PROFILE_FRAGMENT,
      }),
    );
    expect(catalog?.fragments).toEqual(["catalog.d/a.yml"]);
    expect(catalog?.bySection("profiles").map((e) => e.id)).toEqual(["downstream"]);
  });

  test("each merged fragment is named in the run's own output, and a tree without fragments reports nothing new", () => {
    const withFragment = loadCatalog(makeTree({ "catalog.yaml": MINIMAL, "catalog.d/a.yaml": PROFILE_FRAGMENT }));
    const notes = withFragment.issues.filter((i) => i.rule === "catalog.fragment-merged");
    expect(notes.length).toBe(1);
    expect(notes[0]?.severity).toBe("note");
    expect(notes[0]?.file).toBe("catalog.d/a.yaml");
    expect(notes[0]?.message).toContain("profiles/downstream");

    const without = loadCatalog(makeTree({ "catalog.yaml": MINIMAL }));
    expect(without.issues).toEqual([]);
    expect(without.catalog?.fragments).toEqual([]);
  });
});

describe("catalog layout", () => {
  test("directory-backed sections are the five with both-direction completeness", () => {
    expect([...DIRECTORY_SECTIONS]).toEqual(["skills", "packs", "protocols", "roles", "references"]);
  });

  test("the sections whose body file name is mandatory are all five directory sections", () => {
    // Membership in this list is what makes `catalog.unexpected-body-name` an
    // error rather than a warning, and bodies.test.ts covers each of the five
    // directory sections by that consequence, so dropping any one fails a
    // behavioural test there.
    //
    // The pin stays for the direction no behavioural test reaches: a sixth
    // directory section added to DIRECTORY_SECTIONS would be absent here with
    // nothing failing, and its body name would silently be only preferred.
    // This pin failed when `references` and then `packs` were promoted, which
    // is the pin working: the list cannot change without someone deciding,
    // here, that it should.
    expect([...MANDATORY_BODY_SECTIONS]).toEqual(["skills", "packs", "protocols", "roles", "references"]);
    expect([...MANDATORY_BODY_SECTIONS].sort()).toEqual([...DIRECTORY_SECTIONS].sort());
  });

  test("entryDir joins the section root and the id, including nested role ids", () => {
    expect(entryDir("skills", "super-align")).toBe("skills/super-align");
    expect(entryDir("roles", "code-review/security")).toBe("roles/code-review/security");
  });

  test("each directory section has a preferred canonical body file name", () => {
    expect(preferredBodyFile("skills")).toBe("SKILL.md");
    expect(preferredBodyFile("protocols")).toBe("PROTOCOL.md");
    expect(preferredBodyFile("packs")).toBe("PACK.md");
    expect(preferredBodyFile("roles")).toBe("ROLE.md");
    expect(preferredBodyFile("references")).toBe("REFERENCE.md");
  });

  test("file-backed sections map an id to a single path", () => {
    expect(entryFilePath("schemas", "ticket")).toBe("schemas/ticket.schema.json");
    expect(entryFilePath("policies", "invocation")).toBe("policies/invocation.yaml");
    expect(entryFilePath("profiles", "core")).toBe("profiles/core.yaml");
    expect(entryFilePath("adapters", "codex")).toBe("adapters/codex/CONTRACT.md");
  });
});
