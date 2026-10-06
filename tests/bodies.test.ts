import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { loadCatalog } from "../src/catalog/load.ts";
import {
  ANTI_RATIONALIZATION_HEADER,
  AUTHORSHIP_CONVERSE_ROW,
  MANDATORY_NEVER_RULINGS,
  PACK_FORBIDDEN,
  PACK_SECTIONS,
  PRODUCING_SEATS,
  PROTOCOL_SECTIONS,
  ROLE_FORBIDDEN_SECTIONS,
  ROLE_SECTIONS,
  SKILL_SECTIONS,
  STANDARDS_GATE_TIER,
  STANDARDS_GROUNDING_ROW,
  COUNTERPART_TABLE_HEADER,
  checkBodyShapes,
  counterpartFamilies,
} from "../src/validation/bodies.ts";
import { checkCompleteness } from "../src/validation/completeness.ts";
import { makeTree } from "./helpers/tree.ts";

const CATALOG_HEAD = `schema_version: 1
package:
  id: ak
  name: agent-kit
  version: 0.1.0
  namespace: "/ak:"
  default_profile: core
`;

const TABLE = [
  ANTI_RATIONALIZATION_HEADER,
  "|---|---|---|",
  '| "The lane did not run but the others agreed." | An unavailable required lane is not a passing lane (ruling `required-lane-failure-is-unavailable`). | Mark it unavailable and block. |',
  "",
].join("\n");

function sectionBody(heading: string): string {
  if (
    heading === "## Hard gates" ||
    heading === "## Rationalizations this seat makes" ||
    heading === "## Rationalizations this pack counters"
  )
    return TABLE;
  // The two universal rows plus the plain authorship row: the shape §12.2 puts
  // in thirty-two of the thirty-four seats. Defined below, next to the other
  // governed rows, so the whole contract reads in one place.
  if (heading === "## Never") return COMPLIANT_JUDGING_SEAT;
  return "Prose for this section.\n";
}

function body(title: string, sections: ReadonlyArray<string>): string {
  return [`# ${title}`, "", ...sections.map((h) => `${h}\n\n${sectionBody(h)}`)].join("\n");
}

const protocolBody = (sections: ReadonlyArray<string> = PROTOCOL_SECTIONS): string => body("Alpha", sections);
const roleBody = (sections: ReadonlyArray<string> = ROLE_SECTIONS): string => body("Seat", sections);

function ctxFor(files: Record<string, string>): {
  root: string;
  catalog: NonNullable<ReturnType<typeof loadCatalog>["catalog"]>;
} {
  const root = makeTree(files);
  const { catalog } = loadCatalog(root);
  if (catalog === null) throw new Error("fixture has no catalog");
  return { root, catalog };
}

function protocolTree(extra: Record<string, string> = {}, sections?: ReadonlyArray<string>) {
  return ctxFor({
    "catalog.yaml": `${CATALOG_HEAD}protocols:\n  - id: alpha\n    status: authored\n`,
    "protocols/alpha/PROTOCOL.md": protocolBody(sections),
    ...extra,
  });
}

const packBody = (sections: ReadonlyArray<string> = PACK_SECTIONS): string => body("Pack alpha", sections);

function packTree(extra: Record<string, string> = {}, sections?: ReadonlyArray<string>) {
  return ctxFor({
    "catalog.yaml": `${CATALOG_HEAD}packs:\n  - id: pack-alpha\n    status: authored\n`,
    "packs/pack-alpha/PACK.md": packBody(sections),
    "packs/pack-alpha/pack.yaml": "id: pack-alpha\n",
    ...extra,
  });
}

function roleTree(extra: Record<string, string> = {}, sections?: ReadonlyArray<string>) {
  return ctxFor({
    "catalog.yaml": `${CATALOG_HEAD}roles:\n  - id: seat\n    status: authored\n${CATALOG_TWINS}`,
    // §12.2's mandated rows are read from this file at runtime, so a role
    // fixture without it is a role fixture the row gate cannot judge.
    "AUTHORING.md": CONTRACT,
    "roles/seat/ROLE.md": roleBody(sections),
    ...extra,
  });
}

const errors = (issues: ReturnType<typeof checkBodyShapes>) => issues.filter((i) => i.severity === "error");

describe("protocol body shape (AUTHORING 12.1)", () => {
  test("a protocol carrying all ten sections with Invoked by passes", () => {
    expect(errors(checkBodyShapes(protocolTree()))).toEqual([]);
  });

  test("a protocol missing ## Invoked by is an error naming the heading", () => {
    const ctx = protocolTree(
      {},
      PROTOCOL_SECTIONS.filter((h) => h !== "## Invoked by"),
    );
    const issue = errors(checkBodyShapes(ctx)).find((i) => i.rule === "body.missing-section");
    expect(issue?.file).toBe("protocols/alpha/PROTOCOL.md");
    expect(issue?.message).toContain("## Invoked by");
  });

  test("a protocol carrying ## Authority is an error saying it holds none of its own", () => {
    const sections = PROTOCOL_SECTIONS.map((h) => (h === "## Invoked by" ? "## Authority" : h));
    const issues = errors(checkBodyShapes(protocolTree({}, sections)));
    const forbidden = issues.find((i) => i.rule === "body.forbidden-section");
    expect(forbidden?.message).toContain("## Authority");
    expect(forbidden?.message).toContain("## Invoked by");
    expect(issues.some((i) => i.rule === "body.missing-section")).toBe(true);
  });

  test("the ten sections must appear in order", () => {
    const swapped = [...PROTOCOL_SECTIONS];
    const a = swapped[4] as string;
    swapped[4] = swapped[5] as string;
    swapped[5] = a;
    const issue = errors(checkBodyShapes(protocolTree({}, swapped))).find(
      (i) => i.rule === "body.sections-out-of-order",
    );
    expect(issue?.message).toContain("## Hard gates");
  });

  test("an extra section between two required ones is an error; after the last one it is allowed", () => {
    const inserted = [...PROTOCOL_SECTIONS.slice(0, 5), "## Notes", ...PROTOCOL_SECTIONS.slice(5)];
    const issue = errors(checkBodyShapes(protocolTree({}, inserted))).find((i) => i.rule === "body.section-inserted");
    expect(issue?.message).toContain("## Notes");
    expect(errors(checkBodyShapes(protocolTree({}, [...PROTOCOL_SECTIONS, "## Notes"])))).toEqual([]);
  });

  test("a protocol whose ## Hard gates carries no anti-rationalization table is an error", () => {
    const withoutTable = protocolBody().replace(TABLE, "Prose instead of the table.\n");
    const ctx = ctxFor({
      "catalog.yaml": `${CATALOG_HEAD}protocols:\n  - id: alpha\n    status: authored\n`,
      "protocols/alpha/PROTOCOL.md": withoutTable,
    });
    const issue = errors(checkBodyShapes(ctx)).find((i) => i.rule === "body.missing-anti-rationalization-table");
    expect(issue?.message).toContain("## Hard gates");
  });

  test("frontmatter on a protocol is an error: the packager emits none", () => {
    const ctx = ctxFor({
      "catalog.yaml": `${CATALOG_HEAD}protocols:\n  - id: alpha\n    status: authored\n`,
      "protocols/alpha/PROTOCOL.md": `---\nname: alpha\n---\n${protocolBody()}`,
    });
    const issue = errors(checkBodyShapes(ctx)).find((i) => i.rule === "body.frontmatter-forbidden");
    expect(issue?.file).toBe("protocols/alpha/PROTOCOL.md");
    expect(issue?.message).toContain("frontmatter");
  });

  test("a protocol.yaml sidecar is an error: the catalog entry plus the prose is the contract", () => {
    const issue = errors(checkBodyShapes(protocolTree({ "protocols/alpha/protocol.yaml": "id: alpha\n" }))).find(
      (i) => i.rule === "body.sidecar-forbidden",
    );
    expect(issue?.file).toBe("protocols/alpha/protocol.yaml");
    expect(issue?.message).toContain("no execution contract of its own");
  });
});

/**
 * §3's ten headings, seated the way §12.1 seats a protocol's.
 *
 * Every authored body in the tree already satisfies this, so a green run over
 * the repository is not evidence the check exists -- that silence is what §10's
 * batch-4 entry reported, and it read identically before and after. These tests
 * are the evidence instead: each one removes the thing under test from a fixture
 * and asserts the rule fires, and the two paired controls below assert that
 * seating skills did not reach across into the other two shapes.
 */
const SKILL_FRONTMATTER = ["---", "name: alpha", "description: Does the one thing.", "license: MIT", "---", ""].join(
  "\n",
);

const skillBody = (sections: ReadonlyArray<string> = SKILL_SECTIONS): string =>
  `${SKILL_FRONTMATTER}${body("Alpha", sections)}`;

function skillTree(extra: Record<string, string> = {}, sections?: ReadonlyArray<string>) {
  return ctxFor({
    "catalog.yaml": `${CATALOG_HEAD}skills:\n  - id: alpha\n    status: authored\n`,
    "skills/alpha/SKILL.md": skillBody(sections),
    ...extra,
  });
}

describe("skill body shape (AUTHORING 3)", () => {
  test("a skill carrying the ten sections and its spec frontmatter passes", () => {
    expect(errors(checkBodyShapes(skillTree()))).toEqual([]);
  });

  test("the ten headings are §3's, with ## Authority and not the protocol substitution", () => {
    // Reading the list off the contract rather than off `PROTOCOL_SECTIONS`:
    // §12.1 derives the protocol set *from* this one by replacing a single
    // heading, so a seating that reused the protocol list would pass every
    // other test in this block and demand `## Invoked by` from a skill.
    expect(SKILL_SECTIONS).toContain("## Authority");
    expect(SKILL_SECTIONS).not.toContain("## Invoked by");
    expect(SKILL_SECTIONS).toHaveLength(10);
    const issues = errors(checkBodyShapes(skillTree({}, PROTOCOL_SECTIONS)));
    expect(issues.find((i) => i.rule === "body.missing-section")?.message).toContain("## Authority");
  });

  test("a skill missing ## Stop conditions is an error naming the heading and the file", () => {
    const ctx = skillTree(
      {},
      SKILL_SECTIONS.filter((h) => h !== "## Stop conditions"),
    );
    const issue = errors(checkBodyShapes(ctx)).find((i) => i.rule === "body.missing-section");
    expect(issue?.file).toBe("skills/alpha/SKILL.md");
    expect(issue?.message).toContain("## Stop conditions");
  });

  test("the ten sections must appear in §3's order", () => {
    const swapped = [...SKILL_SECTIONS];
    const a = swapped[2] as string;
    swapped[2] = swapped[3] as string;
    swapped[3] = a;
    const issue = errors(checkBodyShapes(skillTree({}, swapped))).find((i) => i.rule === "body.sections-out-of-order");
    expect(issue?.message).toContain("## Authority");
  });

  test("an extra section between two required ones is an error; after ## Limits it is allowed", () => {
    const inserted = [...SKILL_SECTIONS.slice(0, 6), "## Notes", ...SKILL_SECTIONS.slice(6)];
    const issue = errors(checkBodyShapes(skillTree({}, inserted))).find((i) => i.rule === "body.section-inserted");
    expect(issue?.message).toContain("## Notes");
    expect(errors(checkBodyShapes(skillTree({}, [...SKILL_SECTIONS, "## Notes"])))).toEqual([]);
  });

  test("a skill whose ## Hard gates carries no anti-rationalization table is an error", () => {
    const withoutTable = skillBody().replace(TABLE, "Prose instead of the table.\n");
    const ctx = skillTree({ "skills/alpha/SKILL.md": withoutTable });
    const issue = errors(checkBodyShapes(ctx)).find((i) => i.rule === "body.missing-anti-rationalization-table");
    expect(issue?.file).toBe("skills/alpha/SKILL.md");
    expect(issue?.message).toContain("## Hard gates");
  });

  test("frontmatter on a skill is required, not forbidden -- and a protocol's still is", () => {
    // The paired control. `body.frontmatter-forbidden` says "neither a protocol
    // nor a role carries frontmatter", and a skill carries the Agent Skills spec
    // keys by §4. Exempting skills must not switch the rule off, so both bodies
    // are in one tree and the assertion is about which one it names.
    const ctx = ctxFor({
      "catalog.yaml": `${CATALOG_HEAD}skills:\n  - id: alpha\n    status: authored\nprotocols:\n  - id: alpha\n    status: authored\n`,
      "skills/alpha/SKILL.md": skillBody(),
      "protocols/alpha/PROTOCOL.md": `---\nname: alpha\n---\n${protocolBody()}`,
    });
    const named = errors(checkBodyShapes(ctx))
      .filter((i) => i.rule === "body.frontmatter-forbidden")
      .map((i) => i.file);
    expect(named).toEqual(["protocols/alpha/PROTOCOL.md"]);
  });

  test("the sections behind the frontmatter are the ones checked", () => {
    // Without this the exemption above could be read as "skip the frontmatter",
    // and a body whose headings live after a `---` block would go unsplit.
    const ctx = skillTree(
      {},
      SKILL_SECTIONS.filter((h) => h !== "## When to use"),
    );
    const issue = errors(checkBodyShapes(ctx)).find((i) => i.rule === "body.missing-section");
    expect(issue?.message).toContain("## When to use");
  });

  test("a skill.yaml sidecar is legitimate; protocol.yaml beside a protocol is not", () => {
    const ctx = ctxFor({
      "catalog.yaml": `${CATALOG_HEAD}skills:\n  - id: alpha\n    status: authored\nprotocols:\n  - id: alpha\n    status: authored\n`,
      "skills/alpha/SKILL.md": skillBody(),
      "skills/alpha/skill.yaml": "id: alpha\n",
      "protocols/alpha/PROTOCOL.md": protocolBody(),
      "protocols/alpha/protocol.yaml": "id: alpha\n",
    });
    const named = errors(checkBodyShapes(ctx))
      .filter((i) => i.rule === "body.sidecar-forbidden")
      .map((i) => i.file);
    expect(named).toEqual(["protocols/alpha/protocol.yaml"]);
  });

  test("a skill is not counted into §12.2's role-row population", () => {
    // `population.bodies` drives the row gate's census and its blocking skip.
    // Counting skills there would make a skill-only tree with no AUTHORING.md
    // report that role rows went unread -- a blocking `unavailable` over a
    // population of zero seats.
    const skillsOnly = checkBodyShapes(skillTree());
    expect(skillsOnly.filter((i) => i.rule.startsWith("role.mandated-row"))).toEqual([]);
    expect(skillsOnly.some((i) => i.blocking === true)).toBe(false);

    const withSeat = checkBodyShapes(
      ctxFor({
        "catalog.yaml": `${CATALOG_HEAD}skills:\n  - id: alpha\n    status: authored\nroles:\n  - id: seat\n    status: authored\n${CATALOG_TWINS}`,
        "AUTHORING.md": CONTRACT,
        "skills/alpha/SKILL.md": skillBody(),
        "roles/seat/ROLE.md": roleBody(),
      }),
    );
    const census = withSeat.find((i) => i.rule === "role.mandated-row-population");
    expect(census?.message).toContain("across 1 role body");
  });
});

describe("role body shape (AUTHORING 12.2)", () => {
  test("a role carrying the required headings and neither forbidden one passes", () => {
    expect(errors(checkBodyShapes(roleTree()))).toEqual([]);
  });

  test("a role missing ## Evidence it must cite is an error naming the heading", () => {
    const ctx = roleTree(
      {},
      ROLE_SECTIONS.filter((h) => h !== "## Evidence it must cite"),
    );
    const issue = errors(checkBodyShapes(ctx)).find((i) => i.rule === "body.missing-section");
    expect(issue?.message).toContain("## Evidence it must cite");
  });

  test("## Side effects in a role is an error saying the work belongs in a skill or protocol", () => {
    const ctx = roleTree({}, [...ROLE_SECTIONS, "## Side effects"]);
    const issue = errors(checkBodyShapes(ctx)).find((i) => i.rule === "body.forbidden-section");
    expect(issue?.message).toContain("## Side effects");
    expect(issue?.message).toMatch(/a role has none/i);
    expect(issue?.message).toMatch(/skill or a protocol/i);
  });

  test("every forbidden role heading is rejected, each with its own reason", () => {
    for (const heading of ROLE_FORBIDDEN_SECTIONS) {
      const ctx = roleTree({}, [...ROLE_SECTIONS, heading]);
      const issue = errors(checkBodyShapes(ctx)).find((i) => i.rule === "body.forbidden-section");
      expect(issue?.message).toContain(heading);
      expect(issue?.message.length).toBeGreaterThan(heading.length + 20);
    }
  });

  test("## Rationalizations this seat makes comes last", () => {
    const moved = [
      "## What this seat judges",
      "## Not this seat",
      "## Evidence it must cite",
      "## Never",
      "## Rationalizations this seat makes",
      "## What it returns",
      "## When it has nothing to say",
    ];
    const issue = errors(checkBodyShapes(roleTree({}, moved))).find((i) => i.rule === "body.sections-out-of-order");
    expect(issue?.message).toContain("## Rationalizations this seat makes");
  });

  test("a ## Never that carries neither universal row is an error naming both rulings", () => {
    const issues = errors(checkBodyShapes(seatTree("seat", "- The seat never edits.\n"))).filter(
      (i) => i.rule === "role.missing-universal-never-row",
    );
    expect(issues.map((i) => i.message).join(" ")).toContain(MANDATORY_NEVER_RULINGS[0] as string);
    expect(issues.map((i) => i.message).join(" ")).toContain(MANDATORY_NEVER_RULINGS[1] as string);
  });

  test("a seat may add a section of its own between the required ones; only the order of the required set is fixed", () => {
    const withOwn = [...ROLE_SECTIONS.slice(0, 3), "## How this seat reads a diff", ...ROLE_SECTIONS.slice(3)];
    expect(errors(checkBodyShapes(roleTree({}, withOwn)))).toEqual([]);
  });

  test("a role whose ## Rationalizations this seat makes carries no table is an error", () => {
    const withoutTable = roleBody().replace(TABLE, "The seat has no rationalizations.\n");
    const ctx = ctxFor({
      "catalog.yaml": `${CATALOG_HEAD}roles:\n  - id: seat\n    status: authored\n`,
      "roles/seat/ROLE.md": withoutTable,
    });
    const issue = errors(checkBodyShapes(ctx)).find((i) => i.rule === "body.missing-anti-rationalization-table");
    expect(issue?.message).toContain("## Rationalizations this seat makes");
  });

  test("a role.yaml sidecar is an error", () => {
    const issue = errors(checkBodyShapes(roleTree({ "roles/seat/role.yaml": "id: seat\n" }))).find(
      (i) => i.rule === "body.sidecar-forbidden",
    );
    expect(issue?.file).toBe("roles/seat/role.yaml");
  });

  test("a role nested more than one level is an error", () => {
    const ctx = ctxFor({
      "catalog.yaml": `${CATALOG_HEAD}roles:\n  - id: code-review/deep/security\n    status: authored\n`,
      "roles/code-review/deep/security/ROLE.md": roleBody(),
    });
    const issue = errors(checkBodyShapes(ctx)).find((i) => i.rule === "body.role-nesting-too-deep");
    expect(issue?.message).toContain("code-review/deep/security");
  });
});

describe("the body file is named by kind", () => {
  test("a wrongly named body file in protocols/ is an error naming the file and the expected name", () => {
    const ctx = ctxFor({
      "catalog.yaml": `${CATALOG_HEAD}protocols:\n  - id: alpha\n    status: authored\n`,
      "protocols/alpha/README.md": protocolBody(),
    });
    const issue = checkCompleteness(ctx).find((i) => i.rule === "catalog.unexpected-body-name");
    expect(issue?.severity).toBe("error");
    expect(issue?.file).toBe("protocols/alpha/README.md");
    expect(issue?.message).toContain("PROTOCOL.md");
  });

  test("a wrongly named body file in roles/ is an error", () => {
    const ctx = ctxFor({
      "catalog.yaml": `${CATALOG_HEAD}roles:\n  - id: seat\n    status: authored\n`,
      "roles/seat/SEAT.md": roleBody(),
    });
    const issue = checkCompleteness(ctx).find((i) => i.rule === "catalog.unexpected-body-name");
    expect(issue?.severity).toBe("error");
    expect(issue?.message).toContain("ROLE.md");
  });

  test("a wrongly named body file in references/ is an error", () => {
    // Promoted from a warning. The membership criterion for
    // `MANDATORY_BODY_SECTIONS` is the shapes AUTHORING.md §12 gives one body
    // file, and §12.5 gives a reference pack exactly one,
    // `references/<id>/REFERENCE.md`, one per catalog entry. So this applies
    // the existing criterion to a shape that now meets it rather than setting
    // a new policy, and it landed while all four `references` entries were
    // still `status: contract` with no directory on disk -- nothing was
    // grandfathered and the first packs authored are written under the
    // enforced rule rather than having it tightened around them afterwards.
    const ctx = ctxFor({
      "catalog.yaml": `${CATALOG_HEAD}references:\n  - id: guide\n    status: authored\n`,
      "references/guide/NOTES.md": "# Notes\n",
    });
    const issue = checkCompleteness(ctx).find((i) => i.rule === "catalog.unexpected-body-name");
    expect(issue?.severity).toBe("error");
    expect(issue?.message).toContain("REFERENCE.md");
  });

  test("a correctly named reference body validates clean", () => {
    // The direction that a gate test cannot establish on its own. Proving the
    // error fires proves nothing about what clears it, and a rule that flags
    // the right name as well as the wrong one would pass the test above.
    const ctx = ctxFor({
      "catalog.yaml": `${CATALOG_HEAD}references:\n  - id: guide\n    status: authored\n`,
      "references/guide/REFERENCE.md": "# Guide\n\nBody.\n",
    });
    expect(checkCompleteness(ctx).filter((i) => i.rule === "catalog.unexpected-body-name")).toEqual([]);
  });

  test("a wrongly named body file in packs/ is an error", () => {
    // Promoted once §12.6 gave a domain pack exactly one body file,
    // `packs/<id>/PACK.md`, the criterion the other four sections meet. It
    // was held at a warning while the contract said nothing about what a
    // `PACK.md` contains, and promoted while all eight entries were still
    // `status: contract`, so no authored pack was grandfathered.
    const ctx = ctxFor({
      "catalog.yaml": `${CATALOG_HEAD}packs:\n  - id: pack-test\n    status: authored\n`,
      "packs/pack-test/NOTES.md": "# Notes\n",
    });
    const issue = checkCompleteness(ctx).find((i) => i.rule === "catalog.unexpected-body-name");
    expect(issue?.severity).toBe("error");
    expect(issue?.file).toBe("packs/pack-test/NOTES.md");
    expect(issue?.message).toContain("PACK.md");
  });

  test("a correctly named pack body raises no body-name issue", () => {
    const ctx = packTree();
    expect(checkCompleteness(ctx).filter((i) => i.rule === "catalog.unexpected-body-name")).toEqual([]);
  });
});

describe("domain pack body shape (AUTHORING 12.6)", () => {
  test("a pack with every section in order, its table and its manifest validates clean", () => {
    // The direction a gate test cannot establish on its own: that the right
    // shape clears every rule the wrong ones trip.
    expect(errors(checkBodyShapes(packTree()))).toEqual([]);
  });

  test("a missing required section is an error naming it", () => {
    const ctx = packTree(
      {},
      PACK_SECTIONS.filter((h) => h !== "## Does not attach when"),
    );
    const issue = errors(checkBodyShapes(ctx)).find((i) => i.rule === "body.missing-section");
    expect(issue?.file).toBe("packs/pack-alpha/PACK.md");
    expect(issue?.message).toContain("## Does not attach when");
  });

  test("sections out of order are an error", () => {
    const swapped = [...PACK_SECTIONS];
    [swapped[1], swapped[2]] = [swapped[2] as string, swapped[1] as string];
    const issue = errors(checkBodyShapes(packTree({}, swapped))).find((i) => i.rule === "body.sections-out-of-order");
    expect(issue?.file).toBe("packs/pack-alpha/PACK.md");
  });

  test("a section inserted between required ones is an error; one after the table is not", () => {
    const inserted = [...PACK_SECTIONS.slice(0, 2), "## Background", ...PACK_SECTIONS.slice(2)];
    const issue = errors(checkBodyShapes(packTree({}, inserted))).find((i) => i.rule === "body.section-inserted");
    expect(issue?.message).toContain("## Background");
    expect(errors(checkBodyShapes(packTree({}, [...PACK_SECTIONS, "## Background"])))).toEqual([]);
  });

  test("each heading §12.6 rejects by name is an error carrying its reason", () => {
    for (const heading of Object.keys(PACK_FORBIDDEN)) {
      const issue = errors(checkBodyShapes(packTree({}, [...PACK_SECTIONS, heading]))).find(
        (i) => i.rule === "body.forbidden-section",
      );
      expect(issue?.message).toContain(heading);
    }
    expect(Object.keys(PACK_FORBIDDEN).sort()).toEqual(["## Authority", "## When to use", "## Workflow"]);
  });

  test("a rationalizations section with no three-column table is an error", () => {
    const withoutTable = packBody().replace(TABLE, "Prose instead of the table.\n");
    const ctx = packTree({ "packs/pack-alpha/PACK.md": withoutTable });
    const issue = errors(checkBodyShapes(ctx)).find((i) => i.rule === "body.missing-anti-rationalization-table");
    expect(issue?.message).toContain("## Rationalizations this pack counters");
  });

  test("frontmatter on a pack is an error citing the statement that names packs", () => {
    const ctx = packTree({ "packs/pack-alpha/PACK.md": `---\nname: pack-alpha\n---\n${packBody()}` });
    const issue = errors(checkBodyShapes(ctx)).find((i) => i.rule === "body.frontmatter-forbidden");
    expect(issue?.file).toBe("packs/pack-alpha/PACK.md");
    expect(issue?.message).toContain("packs-never-start-a-phase");
  });

  test("a pack directory with no pack.yaml is an error; a manifest.yaml does not stand in", () => {
    const ctx = ctxFor({
      "catalog.yaml": `${CATALOG_HEAD}packs:\n  - id: pack-alpha\n    status: authored\n`,
      "packs/pack-alpha/PACK.md": packBody(),
      "packs/pack-alpha/manifest.yaml": "id: pack-alpha\n",
    });
    const issue = errors(checkBodyShapes(ctx)).find((i) => i.rule === "body.pack-manifest-missing");
    expect(issue?.file).toBe("packs/pack-alpha/pack.yaml");
  });

  test("an unauthored pack with no directory raises nothing here", () => {
    const ctx = ctxFor({ "catalog.yaml": `${CATALOG_HEAD}packs:\n  - id: pack-alpha\n    status: contract\n` });
    expect(checkBodyShapes(ctx)).toEqual([]);
  });
});

describe("loose doctrine files (AUTHORING 12.3)", () => {
  test("a loose .md at a section root has no catalog entry and is never an orphan", () => {
    const ctx = ctxFor({
      "catalog.yaml": `${CATALOG_HEAD}protocols:\n  - id: alpha\n    status: authored\n`,
      "protocols/alpha/PROTOCOL.md": protocolBody(),
      "protocols/invocation-authority.md": "# Invocation authority\n\nDoctrine, not a catalog entry.\n",
    });
    const flagged = [...checkCompleteness(ctx), ...checkBodyShapes(ctx)].filter((i) =>
      i.file.includes("invocation-authority"),
    );
    expect(flagged).toEqual([]);
  });

  test("a loose .md is not mistaken for an unnamed body of a sibling entry", () => {
    const ctx = ctxFor({
      "catalog.yaml": `${CATALOG_HEAD}protocols:\n  - id: alpha\n    status: authored\n`,
      "protocols/alpha/PROTOCOL.md": protocolBody(),
      "protocols/invocation-authority.md": "# Invocation authority\n",
    });
    expect(checkCompleteness(ctx).filter((i) => i.severity === "error")).toEqual([]);
  });
});

describe("unauthored and absent trees", () => {
  test("a protocol declared with status: contract and no directory reports nothing here", () => {
    const ctx = ctxFor({ "catalog.yaml": `${CATALOG_HEAD}protocols:\n  - id: alpha\n    status: contract\n` });
    expect(checkBodyShapes(ctx)).toEqual([]);
  });

  test("a catalog with no protocols or roles reports nothing here", () => {
    expect(checkBodyShapes(ctxFor({ "catalog.yaml": CATALOG_HEAD }))).toEqual([]);
  });
});

/**
 * §12.2's mandated block: the contract the gate reads at runtime.
 *
 * Written out here rather than copied from the real `AUTHORING.md` at test
 * time. A fixture that reads the live contract cannot fail when the contract
 * and the bodies drift *together*, and separating those two is the whole job of
 * a gate that compares one against the other. The row constants below are
 * written out a second time, independently, as the text a body carries — so the
 * equality this gate asserts is an equality between two literals rather than a
 * string compared with itself.
 */
const CONTRACT = [
  "### 12.2 Role bodies",
  "",
  "**Mandatory, verbatim in every role body:**",
  "",
  "1. **Only independent verification closes a finding.** Reading a patch is the author's confidence,",
  "   not a receipt, and no seat closes what it produced (ruling",
  "   `closure-requires-independent-verification`).",
  "2. **A lane that could not run, could not be given its required context, or failed, returns",
  "   `unavailable`, and says why.** That is a result, not an absence. A required lane that is",
  "   `unavailable` **blocks approval**; it is never downgraded to an empty result and never backfilled",
  "   by the author, the implementer, another seat or the synthesis step (ruling",
  "   `required-lane-failure-is-unavailable`).",
  "",
  "**Conditional, required exactly where the condition holds:**",
  "",
  "3. **Never edits: it judges and returns.** Carried by every seat except the two that produce an",
  "   artifact. `implementer` and `plan-review/planner` carry the converse instead, naming what the",
  "   seat writes and stating that it never writes a finding, a receipt, a review record or a ticket,",
  "   and never closes or approves what it produced.",
  "4. **Standards grounding.** Two seats judge against a project standard: `reviewer-standards` and",
  "   `code-review/project-standards` (the catalog's only `tier: standards-gate`). They carry *\"cites an",
  '   actual project rule or returns empty; an absent standard is never an invented preference."* This',
  "   row is **not** an instance of ruling `required-lane-failure-is-unavailable` and does not cite it.",
  "   No ruling states it; §12.2 does.",
  "",
  "Beyond those four, each seat writes its own grounding rule as its own row.",
  "",
  // §12.2 also carries the counterpart table, and `checkBodyShapes` reads it
  // from this same file. A fixture that supplied the mandated block and not the
  // table would put every tree that uses it into
  // `role.counterpart-table-unreadable`, so the two seats below stand in for a
  // family. They are declared in the fixture catalogs and have no directories,
  // which is what keeps them out of every other check here.
  COUNTERPART_TABLE_HEADER,
  "|---|---|",
  "| `twin-a` | `twin-b` |",
  "| `twin-b` | `twin-a` |",
  "",
].join("\n");

/** The catalog rows for the two seats §12.2's fixture table pairs. */
const CATALOG_TWINS = "  - id: twin-a\n    status: contract\n  - id: twin-b\n    status: contract\n";

/**
 * The four governed rows as a body carries them.
 *
 * Rows 1 and 2 are the contract's numbered items reproduced as they stand, wrap
 * points included, because §12.2 governs a block-set row byte-for-byte. Row 3
 * is the bolded sentence alone: the rest of the contract's item 3 is the
 * condition, not the row. Row 4 is the quotation, which §12.2 says is
 * punctuated to its host — so a body bolds its lead clause and ends it with a
 * period where the contract uses a semicolon, and is not in breach.
 */
const CLOSURE_ROW = [
  "1. **Only independent verification closes a finding.** Reading a patch is the author's confidence,",
  "   not a receipt, and no seat closes what it produced (ruling",
  "   `closure-requires-independent-verification`).",
].join("\n");

const UNAVAILABLE_ROW = [
  "2. **A lane that could not run, could not be given its required context, or failed, returns",
  "   `unavailable`, and says why.** That is a result, not an absence. A required lane that is",
  "   `unavailable` **blocks approval**; it is never downgraded to an empty result and never backfilled",
  "   by the author, the implementer, another seat or the synthesis step (ruling",
  "   `required-lane-failure-is-unavailable`).",
].join("\n");

/** The same words, broken at different points. Under a block bar this is a breach. */
const UNAVAILABLE_ROW_REFLOWED = [
  "2. **A lane that could not run, could not be given its required context, or failed,",
  "   returns `unavailable`, and says why.** That is a result, not an absence. A required",
  "   lane that is `unavailable` **blocks approval**; it is never downgraded to an empty",
  "   result and never backfilled by the author, the implementer, another seat or the",
  "   synthesis step (ruling `required-lane-failure-is-unavailable`).",
].join("\n");

/** The wording that stood in all twenty-nine bodies before `ed81a69`. */
const UNAVAILABLE_ROW_NARROWED = [
  "2. **A lane that could not run returns `unavailable`.** That is a result, not an absence:",
  "   never an empty result, and never backfilled by the author, another seat or the",
  "   synthesis step (ruling `required-lane-failure-is-unavailable`).",
].join("\n");

/** Two substrings and the citation: everything the clause floor ever required. */
const UNAVAILABLE_ROW_GUTTED =
  "2. A lane that could not run returns `unavailable` (ruling `required-lane-failure-is-unavailable`).";

const PLAIN_AUTHORSHIP_ROW = "3. **Never edits: it judges and returns.**";

/** The same row with a seat-shaped prefix: words added, so not the mandated row. */
const PLAIN_AUTHORSHIP_ROW_PREFIXED = "3. **This seat never edits: it judges and returns.**";

const CONVERSE_AUTHORSHIP_ROW = [
  "3. **This seat writes the patch its approved ticket allows.** It never writes a finding, a",
  "   receipt, a review record or a ticket, and never closes or approves what it produced.",
].join("\n");

const STANDARDS_ROW = [
  "4. **Cites an actual project rule or returns empty.** An absent standard is never an invented",
  "   preference.",
].join("\n");

/** The quotation with its second half dropped: punctuation is free, words are not. */
const STANDARDS_ROW_HALVED = "4. **Cites an actual project rule or returns empty.**";

function neverSection(rows: ReadonlyArray<string>): string {
  return `${rows.join("\n")}\n`;
}

/** A role body whose `## Never` is exactly the given rows. */
function seatBody(never: string): string {
  return body("Seat", ROLE_SECTIONS).replace(sectionBody("## Never"), never);
}

function seatTree(id: string, never: string, catalogRows = "", extra: Record<string, string> = {}) {
  return ctxFor({
    "catalog.yaml": `${CATALOG_HEAD}roles:\n  - id: ${id}\n    status: authored\n${catalogRows}${CATALOG_TWINS}`,
    "AUTHORING.md": CONTRACT,
    [`roles/${id}/ROLE.md`]: seatBody(never),
    ...extra,
  });
}

const COMPLIANT_JUDGING_SEAT = neverSection([CLOSURE_ROW, UNAVAILABLE_ROW, PLAIN_AUTHORSHIP_ROW]);

describe("the two universal ## Never rows (AUTHORING 12.2)", () => {
  test("a seat carrying both universal rows and the plain authorship row passes", () => {
    expect(errors(checkBodyShapes(seatTree("seat", COMPLIANT_JUDGING_SEAT)))).toEqual([]);
  });

  test("a missing universal row is an error naming the ruling it cites", () => {
    const issues = errors(checkBodyShapes(seatTree("seat", neverSection([CLOSURE_ROW, PLAIN_AUTHORSHIP_ROW])))).filter(
      (i) => i.rule === "role.missing-universal-never-row",
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain("required-lane-failure-is-unavailable");
  });

  test("the citation alone does not satisfy the row; the row's own text must be there", () => {
    const hollow = "2. Some other prohibition entirely (ruling `required-lane-failure-is-unavailable`).";
    const issues = errors(
      checkBodyShapes(seatTree("seat", neverSection([CLOSURE_ROW, hollow, PLAIN_AUTHORSHIP_ROW]))),
    ).filter((i) => i.rule === "role.never-row-not-verbatim");
    expect(issues).toHaveLength(1);
  });

  test("the row's text alone does not satisfy it either; the citation must be there too", () => {
    const uncited = UNAVAILABLE_ROW.replace(" (ruling\n   `required-lane-failure-is-unavailable`)", "");
    expect(uncited).not.toBe(UNAVAILABLE_ROW);
    const issues = errors(
      checkBodyShapes(seatTree("seat", neverSection([CLOSURE_ROW, uncited, PLAIN_AUTHORSHIP_ROW]))),
    ).filter((i) => i.rule === "role.missing-universal-never-row");
    expect(issues).toHaveLength(1);
  });

  test("the citation and the text must sit in the same row, not merely in the section", () => {
    const split = neverSection([
      CLOSURE_ROW,
      "2. **A lane that could not run returns `unavailable`.** Never backfilled.",
      "3. An unrelated prohibition (ruling `required-lane-failure-is-unavailable`).",
      PLAIN_AUTHORSHIP_ROW,
    ]);
    expect(
      errors(checkBodyShapes(seatTree("seat", split))).filter((i) => i.rule === "role.never-row-not-verbatim"),
    ).toHaveLength(1);
  });
});

/**
 * The bar §12.2 states, rather than the floor the gate used to hold.
 *
 * `ed81a69` narrowed row 2 in all twenty-nine bodies, dropping four clauses
 * including the one that makes an `unavailable` required lane block approval.
 * The sweep at `e6ab663` restored them and changed no validate output at all:
 * before and after, 0 errors. The gate was requiring two substrings beside the
 * citation, so both wordings satisfied it and so does a row stripped to nothing
 * else.
 */
describe("a mandated row is compared with the contract, not with two substrings", () => {
  const rowsOf = (never: string, id = "seat") =>
    errors(checkBodyShapes(seatTree(id, never))).filter((i) => i.rule === "role.never-row-not-verbatim");

  test("the pre-sweep narrow row 2 is an error", () => {
    const issues = rowsOf(neverSection([CLOSURE_ROW, UNAVAILABLE_ROW_NARROWED, PLAIN_AUTHORSHIP_ROW]));
    expect(issues).toHaveLength(1);
    expect(issues[0]?.severity).toBe("error");
    // The message shows where the two part company, or the writer is told only
    // that something is wrong with a five-line row.
    expect(issues[0]?.message).toContain("could not be given its required context");
  });

  test("a row stripped to the two matched substrings and the citation is an error", () => {
    expect(rowsOf(neverSection([CLOSURE_ROW, UNAVAILABLE_ROW_GUTTED, PLAIN_AUTHORSHIP_ROW]))).toHaveLength(1);
  });

  test("the same words rewrapped at different points is an error: a block row is carried as it stands", () => {
    // §12.2: byte-for-byte governs a row reproduced as a block, and the wrap is
    // part of what is reproduced. Two things are deliberately *not* governed,
    // because §12.2 mandates the row's text and never its setting: the list
    // marker, so a seat may number its `## Never` rows as it likes, and the
    // continuation indent that follows from the marker's width.
    expect(rowsOf(neverSection([CLOSURE_ROW, UNAVAILABLE_ROW_REFLOWED, PLAIN_AUTHORSHIP_ROW]))).toHaveLength(1);
  });

  test("the list marker and the indent that follows it are not governed: the text is", () => {
    // The stated limit of the bar, held as a test rather than left in a comment.
    // A seat orders its own `## Never` list, so the same row numbered 5 is the
    // same row, and a seat that writes its rows as bullets is not in breach.
    const renumbered = UNAVAILABLE_ROW.replace(/^2\. /, "5. ");
    const bulleted = CLOSURE_ROW.replace(/^1\. /, "- ").replaceAll("\n   ", "\n  ");
    expect(bulleted).not.toBe(CLOSURE_ROW);
    expect(renumbered).not.toBe(UNAVAILABLE_ROW);
    expect(rowsOf(neverSection([bulleted, renumbered, PLAIN_AUTHORSHIP_ROW]))).toEqual([]);
  });

  test("a bulleted row is still compared, so the marker's freedom is not the row's", () => {
    // Paired with the test above: the tolerance is in finding the row, and a
    // narrowed row that borrowed the same freedom is still caught.
    const narrowed = UNAVAILABLE_ROW_NARROWED.replace(/^2\. /, "- ").replaceAll("\n   ", "\n  ");
    expect(rowsOf(neverSection([CLOSURE_ROW, narrowed, PLAIN_AUTHORSHIP_ROW]))).toHaveLength(1);
  });

  test("a row that carries the contract's text and then adds to it is an error", () => {
    // The weld §12.2's split exists to remove. A writer keeps the mandated row
    // whole and absorbs a seat-specific clause onto the end of it, where the
    // clause is load-bearing and nothing can check it. A bar that asked whether
    // the row *contains* the contract would pass exactly this.
    const welded = `${CLOSURE_ROW} It also never reopens a finding another seat closed.`;
    expect(rowsOf(neverSection([welded, UNAVAILABLE_ROW, PLAIN_AUTHORSHIP_ROW]))).toHaveLength(1);
  });

  test("a row this seat never wrote does not stop the next row being compared", () => {
    // `reviewer-standards` here carries no authorship row at all, so row 3
    // cannot be located. Row 4 is still compared: an absent row is the presence
    // check's finding, not a reason to stop reading the seat.
    const never = neverSection([CLOSURE_ROW, UNAVAILABLE_ROW, STANDARDS_ROW_HALVED]);
    const issues = rowsOf(never, "reviewer-standards");
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain("invented preference");
  });

  test("a fenced example inside ## Never is not read as one of the seat's rows", () => {
    // A seat may show a wrong row in order to rule it out. Read as a row, the
    // example is the seat's own text and the seat fails on prose it disowned.
    const never = [
      "```",
      "2. **A lane that could not run returns `unavailable`.** (ruling `required-lane-failure-is-unavailable`)",
      "```",
      "",
      CLOSURE_ROW,
      UNAVAILABLE_ROW,
      PLAIN_AUTHORSHIP_ROW,
      "",
    ].join("\n");
    expect(rowsOf(never)).toEqual([]);
  });

  test("the contract's own rows pass, which is what makes the three above evidence", () => {
    expect(rowsOf(neverSection([CLOSURE_ROW, UNAVAILABLE_ROW, PLAIN_AUTHORSHIP_ROW]))).toEqual([]);
  });

  test("row 3 with a seat-shaped prefix is an error: the mandated sentence is the whole row", () => {
    const issues = rowsOf(neverSection([CLOSURE_ROW, UNAVAILABLE_ROW, PLAIN_AUTHORSHIP_ROW_PREFIXED]));
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain("Never edits");
  });

  test("row 4 is punctuated to its host, so bolding and a period for the semicolon pass", () => {
    // §12.2 says this in as many words: row 4 is a quotation embedded in a
    // sentence, and a body that bolds its lead clause or ends it with a period
    // is not in breach. A byte bar here would fail both seats that carry it.
    const never = neverSection([CLOSURE_ROW, UNAVAILABLE_ROW, PLAIN_AUTHORSHIP_ROW, STANDARDS_ROW]);
    expect(rowsOf(never, "reviewer-standards")).toEqual([]);
  });

  test("row 4 with half the quotation dropped is still an error: punctuation is free, words are not", () => {
    const never = neverSection([CLOSURE_ROW, UNAVAILABLE_ROW, PLAIN_AUTHORSHIP_ROW, STANDARDS_ROW_HALVED]);
    const issues = rowsOf(never, "reviewer-standards");
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain("invented preference");
  });
});

describe("the contract is the authority, and its absence is said rather than passed", () => {
  test("no AUTHORING.md means the row gate did not run, and says which check that was", () => {
    const ctx = ctxFor({
      "catalog.yaml": `${CATALOG_HEAD}roles:\n  - id: seat\n    status: authored\n`,
      "roles/seat/ROLE.md": seatBody(neverSection([CLOSURE_ROW, UNAVAILABLE_ROW, PLAIN_AUTHORSHIP_ROW])),
    });
    const skips = checkBodyShapes(ctx).filter((i) => i.rule === "role.mandated-rows-unavailable");
    expect(skips).toHaveLength(1);
    expect(skips[0]?.skipped).toBe("mandated role rows");
    // And no row verdict is reported off a contract that was never read.
    expect(checkBodyShapes(ctx).filter((i) => i.rule.startsWith("role.never-row"))).toEqual([]);
  });

  test("an AUTHORING.md whose mandated block has gone is the same skip, not a clean pass", () => {
    const gutted = CONTRACT.replace("**Mandatory, verbatim in every role body:**", "**Mandatory:**");
    expect(gutted).not.toBe(CONTRACT);
    const ctx = ctxFor({
      "catalog.yaml": `${CATALOG_HEAD}roles:\n  - id: seat\n    status: authored\n${CATALOG_TWINS}`,
      "AUTHORING.md": gutted,
      "roles/seat/ROLE.md": seatBody(neverSection([CLOSURE_ROW, UNAVAILABLE_ROW, PLAIN_AUTHORSHIP_ROW])),
    });
    expect(checkBodyShapes(ctx).filter((i) => i.rule === "role.mandated-rows-unavailable")).toHaveLength(1);
  });

  test("losing the anchor blocks the run: the bodies are present and went unjudged", () => {
    // `sweep-reviewer` against `817b583`. Rewording the anchor leaves the row
    // text untouched and the meaning identical, and it took `ak validate` from
    // exit 1 to exit 0 with a gutted row sitting in the tree -- because the gate
    // reported itself skipped, and a skip did not reach the exit code.
    //
    // This is the row the gate enforces, applied to the gate: a required lane
    // that could not be given its context returns `unavailable`, and an
    // `unavailable` required lane blocks approval
    // (ruling `required-lane-failure-is-unavailable`).
    const reworded = CONTRACT.replace(
      "**Mandatory, verbatim in every role body:**",
      "**Mandatory in every role body, verbatim:**",
    );
    expect(reworded).not.toBe(CONTRACT);

    const files = {
      "catalog.yaml": `${CATALOG_HEAD}roles:\n  - id: seat\n    status: authored\n${CATALOG_TWINS}`,
      // A row missing everything but its two old clauses and the citation: the
      // defect the gate exists to catch, present in both trees below.
      "roles/seat/ROLE.md": seatBody(neverSection([CLOSURE_ROW, UNAVAILABLE_ROW_GUTTED, PLAIN_AUTHORSHIP_ROW])),
    };

    const intact = checkBodyShapes(ctxFor({ ...files, "AUTHORING.md": CONTRACT }));
    expect(intact.filter((i) => i.rule === "role.never-row-not-verbatim")).toHaveLength(1);
    expect(intact.some((i) => i.severity === "error")).toBe(true);

    const lost = checkBodyShapes(ctxFor({ ...files, "AUTHORING.md": reworded }));
    const skips = lost.filter((i) => i.rule === "role.mandated-rows-unavailable");
    expect(skips).toHaveLength(1);
    // The assertion that closes the hole. Before this, the two runs above
    // differed at the exit code in the wrong direction: the tree with the
    // defect *and* a disarmed gate was the one that passed.
    expect(skips[0]?.blocking).toBe(true);
    expect(lost.some((i) => i.severity === "error")).toBe(false);
  });

  test("a mandatory block with a row this gate cannot place is a skip, not a narrowing", () => {
    // Adding a fifth mandated row is a contract change, and a gate that read
    // the two it recognised and passed the rest would report a clean tree while
    // a row nothing checks stands in AUTHORING.md.
    const anchor = "**Conditional, required exactly where the condition holds:**";
    const extended = CONTRACT.replace(
      anchor,
      `3. **A third universal row.** Stated here and nowhere else.\n\n${anchor}`,
    );
    expect(extended).not.toBe(CONTRACT);
    const ctx = ctxFor({
      "catalog.yaml": `${CATALOG_HEAD}roles:\n  - id: seat\n    status: authored\n${CATALOG_TWINS}`,
      "AUTHORING.md": extended,
      "roles/seat/ROLE.md": seatBody(neverSection([CLOSURE_ROW, UNAVAILABLE_ROW, PLAIN_AUTHORSHIP_ROW])),
    });
    expect(checkBodyShapes(ctx).filter((i) => i.rule === "role.mandated-rows-unavailable")).toHaveLength(1);
    expect(checkBodyShapes(ctx).filter((i) => i.rule === "role.mandated-row-population")).toEqual([]);
  });

  test("a mandated row that no longer cites its ruling is a skip, not a row dropped in silence", () => {
    // The gate pairs rows 1 and 2 to their rulings by citation. A contract that
    // stopped citing one leaves the gate unable to say which row is which, and
    // the honest report is that it did not run.
    const uncited = CONTRACT.replace("`closure-requires-independent-verification`", "`a-ruling-by-another-name`");
    expect(uncited).not.toBe(CONTRACT);
    const ctx = ctxFor({
      "catalog.yaml": `${CATALOG_HEAD}roles:\n  - id: seat\n    status: authored\n${CATALOG_TWINS}`,
      "AUTHORING.md": uncited,
      "roles/seat/ROLE.md": seatBody(neverSection([CLOSURE_ROW, UNAVAILABLE_ROW, PLAIN_AUTHORSHIP_ROW])),
    });
    const issues = checkBodyShapes(ctx);
    expect(issues.filter((i) => i.rule === "role.mandated-rows-unavailable")).toHaveLength(1);
    expect(issues.filter((i) => i.rule === "role.never-row-not-verbatim")).toEqual([]);
  });

  test("the rows are read from the contract, so editing the contract moves the bar", () => {
    // The property that keeps the row text out of src/. A body carrying the
    // contract's row passes; change the contract alone and the same body fails.
    const moved = CONTRACT.replace(
      "Only independent verification closes a finding.",
      "Only independent verification closes it.",
    );
    expect(moved).not.toBe(CONTRACT);
    const never = neverSection([CLOSURE_ROW, UNAVAILABLE_ROW, PLAIN_AUTHORSHIP_ROW]);
    const ctx = ctxFor({
      "catalog.yaml": `${CATALOG_HEAD}roles:\n  - id: seat\n    status: authored\n${CATALOG_TWINS}`,
      "AUTHORING.md": moved,
      "roles/seat/ROLE.md": seatBody(never),
    });
    expect(errors(checkBodyShapes(ctx)).filter((i) => i.rule === "role.never-row-not-verbatim")).toHaveLength(1);
  });
});

describe("the gate names the population it covered", () => {
  test("the census reports each row's seats, so a seat missing from one is visible", () => {
    const judging = neverSection([CLOSURE_ROW, UNAVAILABLE_ROW, PLAIN_AUTHORSHIP_ROW]);
    const producing = neverSection([CLOSURE_ROW, UNAVAILABLE_ROW, CONVERSE_AUTHORSHIP_ROW]);
    const ctx = ctxFor({
      "catalog.yaml": `${CATALOG_HEAD}roles:\n  - id: seat\n    status: authored\n  - id: implementer\n    status: authored\n${CATALOG_TWINS}`,
      "AUTHORING.md": CONTRACT,
      "roles/seat/ROLE.md": seatBody(judging),
      "roles/implementer/ROLE.md": seatBody(producing),
    });
    const census = checkBodyShapes(ctx).find((i) => i.rule === "role.mandated-row-population");
    expect(census?.severity).toBe("note");
    // Two seats saw the universal rows; one saw each authorship form; neither
    // judges against a project standard. A tally would hide that split.
    expect(census?.message).toContain("2 for each universal row");
    expect(census?.message).toContain("1 for the plain authorship row");
    expect(census?.message).toContain("1 for the converse");
    expect(census?.message).toContain("0 for standards grounding");
  });
});

describe("the conditional authorship row (AUTHORING 12.2)", () => {
  test("a judging seat carries the plain form", () => {
    expect(
      errors(checkBodyShapes(seatTree("seat", COMPLIANT_JUDGING_SEAT))).filter(
        (i) => i.rule === "role.authorship-row-mismatch",
      ),
    ).toEqual([]);
  });

  test.each(["implementer", "plan-review/planner", "verifier"])("the producing seat %s carries the converse", (id) => {
    const never = neverSection([CLOSURE_ROW, UNAVAILABLE_ROW, CONVERSE_AUTHORSHIP_ROW]);
    expect(
      errors(checkBodyShapes(seatTree(id, never))).filter((i) => i.rule === "role.authorship-row-mismatch"),
    ).toEqual([]);
  });

  test("a producing seat claiming it never edits is an error: that is the bug the split exists to catch", () => {
    const issue = errors(checkBodyShapes(seatTree("implementer", COMPLIANT_JUDGING_SEAT))).find(
      (i) => i.rule === "role.authorship-row-mismatch",
    );
    expect(issue?.severity).toBe("error");
    expect(issue?.message).toContain("implementer");
  });

  test("a producing seat that carries neither form is an error", () => {
    const never = neverSection([CLOSURE_ROW, UNAVAILABLE_ROW]);
    const issue = errors(checkBodyShapes(seatTree("implementer", never))).find(
      (i) => i.rule === "role.authorship-row-mismatch",
    );
    expect(issue?.severity).toBe("error");
  });

  test("a judging seat carrying the converse is an error: only the declared producing seats produce", () => {
    const never = neverSection([CLOSURE_ROW, UNAVAILABLE_ROW, CONVERSE_AUTHORSHIP_ROW]);
    const issue = errors(checkBodyShapes(seatTree("supervisor", never))).find(
      (i) => i.rule === "role.authorship-row-mismatch",
    );
    expect(issue?.severity).toBe("error");
  });

  test("a judging seat carrying no authorship row at all is an error", () => {
    const never = neverSection([CLOSURE_ROW, UNAVAILABLE_ROW]);
    const issue = errors(checkBodyShapes(seatTree("supervisor", never))).find(
      (i) => i.rule === "role.authorship-row-mismatch",
    );
    expect(issue?.severity).toBe("error");
  });

  test("the producing seats are a closed list, not something read off the bodies", () => {
    expect([...PRODUCING_SEATS].sort()).toEqual(["implementer", "plan-review/planner", "verifier"]);
  });
});

describe("the conditional standards-grounding row (AUTHORING 12.2)", () => {
  const withStandards = neverSection([CLOSURE_ROW, UNAVAILABLE_ROW, PLAIN_AUTHORSHIP_ROW, STANDARDS_ROW]);

  test("reviewer-standards is named in the contract and carries the row", () => {
    expect(
      errors(checkBodyShapes(seatTree("reviewer-standards", withStandards))).filter(
        (i) => i.rule === "role.standards-row-mismatch",
      ),
    ).toEqual([]);
  });

  test("the second standards seat is derived from the catalog's tier, not hardcoded", () => {
    const ctx = ctxFor({
      "catalog.yaml": `${CATALOG_HEAD}roles:\n  - id: code-review/project-standards\n    status: authored\n    tier: ${STANDARDS_GATE_TIER}\n`,
      "roles/code-review/project-standards/ROLE.md": seatBody(withStandards),
    });
    expect(errors(checkBodyShapes(ctx)).filter((i) => i.rule === "role.standards-row-mismatch")).toEqual([]);
  });

  test("a batch-2 seat that acquires the standards tier picks the row up automatically", () => {
    const ctx = ctxFor({
      "catalog.yaml": `${CATALOG_HEAD}roles:\n  - id: code-review/newcomer\n    status: authored\n    tier: ${STANDARDS_GATE_TIER}\n`,
      "roles/code-review/newcomer/ROLE.md": seatBody(COMPLIANT_JUDGING_SEAT),
    });
    const issue = errors(checkBodyShapes(ctx)).find((i) => i.rule === "role.standards-row-mismatch");
    expect(issue?.severity).toBe("error");
    expect(issue?.message).toContain("code-review/newcomer");
  });

  test("a standards seat missing the row is an error", () => {
    const issue = errors(checkBodyShapes(seatTree("reviewer-standards", COMPLIANT_JUDGING_SEAT))).find(
      (i) => i.rule === "role.standards-row-mismatch",
    );
    expect(issue?.severity).toBe("error");
  });

  test("a seat that does not judge against a project standard carrying the row is an error", () => {
    const issue = errors(checkBodyShapes(seatTree("supervisor", withStandards))).find(
      (i) => i.rule === "role.standards-row-mismatch",
    );
    expect(issue?.severity).toBe("error");
    expect(issue?.message).toContain("supervisor");
  });

  test("the standards row carries no ruling citation, and no rulings check demands one", () => {
    const issues = checkBodyShapes(seatTree("reviewer-standards", withStandards));
    expect(issues.filter((i) => i.rule.startsWith("rulings."))).toEqual([]);
    expect(STANDARDS_GROUNDING_ROW.ruling).toBeNull();
  });

  test("a role tier other than the standards gate does not pull the row in", () => {
    const ctx = ctxFor({
      "catalog.yaml": `${CATALOG_HEAD}roles:\n  - id: code-review/correctness\n    status: authored\n    tier: always-on\n`,
      "AUTHORING.md": CONTRACT,
      "roles/code-review/correctness/ROLE.md": seatBody(COMPLIANT_JUDGING_SEAT),
    });
    expect(errors(checkBodyShapes(ctx)).filter((i) => i.rule === "role.standards-row-mismatch")).toEqual([]);
  });
});

/**
 * The converse authorship row is the one governed row §12.2 does not set as
 * text, so it is the one row this gate still matches on substrings.
 *
 * That leaves a copy of the contract's wording in `src/`, which is the drift
 * shape the rest of this gate exists to remove. It cannot be removed here
 * without §12.2 stating the row; what can be removed is the silence, so the
 * copy is checked against the contract that describes it.
 */
describe("the one row with no verbatim form keeps its clauses under check", () => {
  test("every converse clause appears in the contract paragraph that describes it", () => {
    const authoring = readFileSync(join(import.meta.dir, "..", "AUTHORING.md"), "utf8");
    const anchor = "**Conditional, required exactly where the condition holds:**";
    const start = authoring.indexOf(anchor);
    expect(start).toBeGreaterThan(-1);
    const item = authoring.slice(start).split(/\n\d+\. /)[1] ?? "";
    // Guard against an empty subject: a slice that matched nothing would make
    // every `toContain` below vacuous.
    expect(item).toContain("carry the converse instead");

    const flat = item.replace(/\s+/g, " ");
    for (const clause of AUTHORSHIP_CONVERSE_ROW.clauses) {
      expect(flat).toContain(clause);
    }
  });
});

describe("the gate against the real contract and the real seats", () => {
  const repo = join(import.meta.dir, "..");

  function realTree(edit: (id: string, text: string) => string = (_, text) => text) {
    const catalog = readFileSync(join(repo, "catalog.yaml"), "utf8");
    const files: Record<string, string> = {
      "catalog.yaml": catalog,
      "AUTHORING.md": readFileSync(join(repo, "AUTHORING.md"), "utf8"),
    };
    const { catalog: loaded } = loadCatalog(repo);
    if (loaded === null) throw new Error("the repository has no readable catalog");
    let bodies = 0;
    for (const entry of loaded.bySection("roles")) {
      const path = join(repo, "roles", entry.id, "ROLE.md");
      if (!existsSync(path)) continue;
      files[`roles/${entry.id}/ROLE.md`] = edit(entry.id, readFileSync(path, "utf8"));
      bodies += 1;
    }
    // The denominator this gate is measured on. §12.2 mandates the universal
    // rows in thirty-four seats and `required-lane-failure-is-unavailable`
    // binds exactly thirty-four role ids.
    expect(bodies).toBe(35);
    return ctxFor(files);
  }

  test("all thirty-five authored bodies carry the contract's rows exactly", () => {
    const issues = checkBodyShapes(realTree()).filter((i) => i.rule.startsWith("role.never-row"));
    expect(issues).toEqual([]);
  });

  test("the census over the real tree names 35, 32 and 3", () => {
    const census = checkBodyShapes(realTree()).find((i) => i.rule === "role.mandated-row-population");
    expect(census?.message).toContain("35 for each universal row");
    expect(census?.message).toContain("32 for the plain authorship row");
    expect(census?.message).toContain("3 for the converse");
    expect(census?.message).toContain("2 for standards grounding");
  });

  test("narrowing one real body's row 2 by one clause is caught, naming that body", () => {
    // The paired assertion. Silence over thirty-four real bodies is evidence
    // only if the gate can tell them apart from thirty-four narrowed ones, and
    // a gate that located nothing would be silent in exactly the same way.
    let edited = 0;
    const ctx = realTree((id, text) => {
      if (id !== "supervisor") return text;
      const narrowed = text.replace(", could not be given its required context,", ",");
      if (narrowed !== text) edited += 1;
      return narrowed;
    });
    expect(edited).toBe(1);

    const issues = checkBodyShapes(ctx).filter((i) => i.rule === "role.never-row-not-verbatim");
    expect(issues).toHaveLength(1);
    expect(issues[0]?.file).toBe("roles/supervisor/ROLE.md");
    expect(issues[0]?.severity).toBe("error");
  });

  test("the gate is live against the repository itself, not only against a copy", () => {
    const { catalog } = loadCatalog(repo);
    if (catalog === null) throw new Error("the repository has no readable catalog");
    const issues = checkBodyShapes({ root: repo, catalog });
    expect(issues.filter((i) => i.rule.startsWith("role.never-row"))).toEqual([]);
    expect(issues.filter((i) => i.rule === "role.mandated-rows-unavailable")).toEqual([]);
  });
});

/**
 * §12.2's counterpart table, as AUTHORING.md writes it. The fixtures carry a
 * small one rather than the real families, so a test asserts a rule and not a
 * snapshot of today's catalog.
 */
function authoringWith(rows: ReadonlyArray<[string, string]>): string {
  return [
    "# Authoring",
    "",
    "The families that exist today:",
    "",
    COUNTERPART_TABLE_HEADER,
    "|---|---|",
    ...rows.map(([seat, counterparts]) => `| \`${seat}\` | ${counterparts} |`),
    "",
  ].join("\n");
}

/** A role body whose `## Not this seat` is exactly the given bullets. */
function seatBodyNotThisSeat(bullets: string): string {
  return body("Seat", ROLE_SECTIONS).replace(
    "## Not this seat\n\nProse for this section.\n",
    `## Not this seat\n\n${bullets}`,
  );
}

function panelTree(id: string, bullets: string, extra: Record<string, string> = {}, catalogRows = "") {
  return ctxFor({
    "catalog.yaml": `${CATALOG_HEAD}roles:\n  - id: ${id}\n    status: authored\n${catalogRows}`,
    [`roles/${id}/ROLE.md`]: seatBodyNotThisSeat(bullets),
    ...extra,
  });
}

const OTHER_PANEL_SEATS =
  "  - id: code-review/security\n    status: contract\n  - id: doc-review/security-lens\n    status: contract\n";

describe("a bullet naming another panel names a seat in it (AUTHORING 12.2)", () => {
  test("another panel in prose with no id anywhere in the bullet is an error", () => {
    const bullets = "- **A code-review architect lane.** It runs a different concurrency model.\n";
    const issue = errors(checkBodyShapes(panelTree("plan-review/architect", bullets, {}, OTHER_PANEL_SEATS))).find(
      (i) => i.rule === "role.panel-mention-without-seat-id",
    );
    expect(issue?.file).toBe("roles/plan-review/architect/ROLE.md");
    expect(issue?.message).toContain("code-review");
  });

  test("the same bullet naming a seat that resolves in catalog.yaml passes", () => {
    const bullets = "- **`code-review/security`.** That seat judges a diff, not a plan.\n";
    expect(
      errors(checkBodyShapes(panelTree("plan-review/architect", bullets, {}, OTHER_PANEL_SEATS))).filter(
        (i) => i.rule === "role.panel-mention-without-seat-id",
      ),
    ).toEqual([]);
  });

  test("a backticked token that is not a role does not satisfy it, which is the three-namespace collision", () => {
    const bullets = "- **The synthesis step.** The code-review verdict comes from `consensus-plan-gate`.\n";
    const catalogRows = `${OTHER_PANEL_SEATS}protocols:\n  - id: consensus-plan-gate\n    status: contract\n`;
    const issue = errors(checkBodyShapes(panelTree("plan-review/architect", bullets, {}, catalogRows))).find(
      (i) => i.rule === "role.panel-mention-without-seat-id",
    );
    expect(issue?.message).toContain("code-review");
  });

  test("this seat's own panel may be named without an id, which 12.2 permits", () => {
    const bullets = "- **The other plan-review seat.** Two seats answer the same card independently.\n";
    expect(
      errors(checkBodyShapes(panelTree("plan-review/architect", bullets, {}, OTHER_PANEL_SEATS))).filter(
        (i) => i.rule === "role.panel-mention-without-seat-id",
      ),
    ).toEqual([]);
  });

  test("a non-seat boundary with no panel and no id is a kind-2 bullet and passes", () => {
    const bullets = "- **The closure decision.** This seat supplies the disposition, not the verdict.\n";
    expect(
      errors(checkBodyShapes(panelTree("plan-review/architect", bullets, {}, OTHER_PANEL_SEATS))).filter(
        (i) => i.rule === "role.panel-mention-without-seat-id",
      ),
    ).toEqual([]);
  });

  test("a collective lead-in passes when the seats it covers are named by id inside it", () => {
    const bullets = "- **A review lane.** `code-review/security` and `doc-review/security-lens` judge a change.\n";
    expect(
      errors(checkBodyShapes(panelTree("supervisor", bullets, {}, OTHER_PANEL_SEATS))).filter(
        (i) => i.rule === "role.panel-mention-without-seat-id",
      ),
    ).toEqual([]);
  });
});

describe("every counterpart the table declares is named (AUTHORING 12.2)", () => {
  const AUTHORING = authoringWith([["code-review/security", "`doc-review/security-lens`"]]);

  test("a seat that omits its declared counterpart is an error naming the missing id", () => {
    const bullets = "- **The closure decision.** Not this seat's call.\n";
    const ctx = panelTree("code-review/security", bullets, { "AUTHORING.md": AUTHORING }, OTHER_PANEL_SEATS);
    const issue = errors(checkBodyShapes(ctx)).find((i) => i.rule === "role.counterpart-not-named");
    expect(issue?.file).toBe("roles/code-review/security/ROLE.md");
    expect(issue?.message).toContain("doc-review/security-lens");
  });

  test("naming it passes", () => {
    const bullets = "- **`doc-review/security-lens`.** That seat reads a plan, not a diff.\n";
    const ctx = panelTree("code-review/security", bullets, { "AUTHORING.md": AUTHORING }, OTHER_PANEL_SEATS);
    expect(errors(checkBodyShapes(ctx)).filter((i) => i.rule === "role.counterpart-not-named")).toEqual([]);
  });

  test("a three-seat family requires both of the other two, not either", () => {
    const authoring = authoringWith([["code-review/security", "`doc-review/security-lens`, `plan-review/critic`"]]);
    const bullets = "- **`doc-review/security-lens`.** That seat reads a plan.\n";
    const rows = `${OTHER_PANEL_SEATS}  - id: plan-review/critic\n    status: contract\n`;
    const ctx = panelTree("code-review/security", bullets, { "AUTHORING.md": authoring }, rows);
    const issue = errors(checkBodyShapes(ctx)).find((i) => i.rule === "role.counterpart-not-named");
    expect(issue?.message).toContain("plan-review/critic");
    expect(issue?.message).not.toContain("doc-review/security-lens");
  });

  test("a table naming a seat catalog.yaml does not declare is an error, not a silent requirement", () => {
    const authoring = authoringWith([["code-review/security", "`doc-review/ghost`"]]);
    const bullets = "- **The closure decision.** Not this seat's call.\n";
    const ctx = panelTree("code-review/security", bullets, { "AUTHORING.md": authoring }, OTHER_PANEL_SEATS);
    const issue = errors(checkBodyShapes(ctx)).find((i) => i.rule === "role.counterpart-table-unknown-seat");
    expect(issue?.message).toContain("doc-review/ghost");
  });

  test("a present AUTHORING.md whose table has gone is an error, not a check that quietly passes", () => {
    const ctx = panelTree(
      "code-review/security",
      "- **The closure decision.** Not this seat's call.\n",
      {
        "AUTHORING.md": "# Authoring\n\nThe families that exist today:\n\nnone, apparently.\n",
      },
      OTHER_PANEL_SEATS,
    );
    const issue = errors(checkBodyShapes(ctx)).find((i) => i.rule === "role.counterpart-table-unreadable");
    expect(issue?.file).toBe("AUTHORING.md");
  });

  test("a one-way family is an error naming both, because a reader arrives from either side", () => {
    const ctx = panelTree(
      "code-review/security",
      "- **`doc-review/security-lens`.** Reads a plan.\n",
      {
        "AUTHORING.md": AUTHORING,
      },
      OTHER_PANEL_SEATS,
    );
    const issue = checkBodyShapes(ctx).find((i) => i.rule === "role.counterpart-table-asymmetric");
    expect(issue?.severity).toBe("error");
    expect(issue?.message).toContain("code-review/security");
    expect(issue?.message).toContain("doc-review/security-lens");
  });

  test("the table is checked with no role body on disk at all, because the table is the specification", () => {
    // This one is the whole point: the asymmetry that shipped was introduced by
    // editing the table, with no role edit anywhere. A check that only ran when
    // a body moved would have passed it.
    const ctx = ctxFor({
      "catalog.yaml": `${CATALOG_HEAD}roles:\n${OTHER_PANEL_SEATS}`,
      "AUTHORING.md": AUTHORING,
    });
    const issue = errors(checkBodyShapes(ctx)).find((i) => i.rule === "role.counterpart-table-asymmetric");
    expect(issue?.file).toBe("AUTHORING.md");
  });

  test("the prose count beside the table is checked against the table, not trusted", () => {
    // The sentence is load-bearing -- it is what tells a reader the table makes
    // no completeness claim -- so it stays. What cannot stay is a hand-typed
    // number standing beside the list it counts, which is the same shape that
    // produced the asymmetry.
    const ctx = panelTree(
      "plan-review/architect",
      "- **`doc-review/security-lens`.** Reads a plan.\n",
      {
        "AUTHORING.md": `${authoringWith([
          ["code-review/security", "`doc-review/security-lens`"],
          ["doc-review/security-lens", "`code-review/security`"],
        ])}\nSeven seats of twenty-nine are named here.\n`,
      },
      OTHER_PANEL_SEATS,
    );
    const issue = errors(checkBodyShapes(ctx)).find((i) => i.rule === "role.counterpart-census-count-stale");
    expect(issue?.message).toContain("Seven");
    expect(issue?.message).toContain("2");
  });

  test("a prose count that matches the table is left alone", () => {
    const ctx = panelTree(
      "plan-review/architect",
      "- **`doc-review/security-lens`.** Reads a plan.\n",
      {
        "AUTHORING.md": `${authoringWith([
          ["code-review/security", "`doc-review/security-lens`"],
          ["doc-review/security-lens", "`code-review/security`"],
        ])}\nTwo seats of three are named here.\n`,
      },
      OTHER_PANEL_SEATS,
    );
    expect(checkBodyShapes(ctx).filter((i) => i.rule === "role.counterpart-census-count-stale")).toEqual([]);
  });

  test("the coverage of the census is reported, since a symmetry guard cannot prove completeness", () => {
    const ctx = panelTree(
      "plan-review/architect",
      "- **`doc-review/security-lens`.** Reads a plan.\n",
      {
        "AUTHORING.md": authoringWith([
          ["code-review/security", "`doc-review/security-lens`"],
          ["doc-review/security-lens", "`code-review/security`"],
        ]),
      },
      OTHER_PANEL_SEATS,
    );
    const note = checkBodyShapes(ctx).find((i) => i.rule === "role.counterpart-census-coverage");
    expect(note?.severity).toBe("note");
    expect(note?.message).toContain("2");
    expect(note?.message).toContain("3");
  });

  test("a three-seat family counts once, because a family is not its pairs", () => {
    // Counting undirected pairs inflates with family size: a triple reads as
    // three families. The count has to track how many distinct groups exist,
    // which is the number of connected components in the counterpart graph.
    const ctx = ctxFor({
      "catalog.yaml": `${CATALOG_HEAD}roles:\n  - id: a/one\n    status: contract\n  - id: b/two\n    status: contract\n  - id: c/three\n    status: contract\n`,
      "AUTHORING.md": authoringWith([
        ["a/one", "`b/two`, `c/three`"],
        ["b/two", "`a/one`, `c/three`"],
        ["c/three", "`a/one`, `b/two`"],
      ]),
    });
    const note = checkBodyShapes(ctx).find((i) => i.rule === "role.counterpart-census-coverage");
    expect(note?.message).toContain("1 family");
    expect(note?.message).not.toContain("3 families");
  });

  test("the families parse out of AUTHORING.md rather than being a second copy in the checker", () => {
    const root = makeTree({ "AUTHORING.md": authoringWith([["a/one", "`b/two`, `c/three`"]]) });
    expect(counterpartFamilies(root).families).toEqual(new Map([["a/one", ["b/two", "c/three"]]]));
  });
});
