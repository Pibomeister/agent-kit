import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { parse as parseYaml } from "yaml";

import { loadCatalog } from "../src/catalog/load.ts";
import { writeAdaptations } from "../src/packaging/build.ts";
import {
  ADAPTATIONS_FILE,
  ADAPTATIONS_FRAGMENT_DIR,
  checkAdaptationsSync,
  loadAdaptationFragments,
  renderAdaptations,
} from "../src/validation/provenance.ts";
import { checkProvenance } from "../src/validation/provenance.ts";
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
    provenance_origin: donor
`;

const SKILL =
  "---\nname: alpha\ndescription: Runs the alpha workflow when a human asks for it.\n---\n\n# Alpha\n\nRun it.\n";
const LOCK =
  "donors:\n  - id: donorx\n    path: .donors/donorx\n    commit: 0123456789abcdef0123456789abcdef01234567\n";
const SOURCE = "donorx@0123456789abcdef0123456789abcdef01234567:docs/guide.md";

function ctxFor(files: Record<string, string>) {
  const root = makeTree({
    "catalog.yaml": CATALOG,
    "skills/alpha/SKILL.md": SKILL,
    "provenance/upstream.lock.yaml": LOCK,
    ...files,
  });
  const { catalog } = loadCatalog(root);
  if (catalog === null) throw new Error("fixture has no catalog");
  return { root, catalog };
}

function fragment(path: string, source: string): string {
  return `adaptations:\n  - path: ${path}\n    source: ${source}\n`;
}

describe("adaptations.d fragments are the write surface", () => {
  test("rows merge across fragments, and adaptations.yaml is not required to exist", () => {
    const ctx = ctxFor({
      [`${ADAPTATIONS_FRAGMENT_DIR}/batch-1.yaml`]: fragment("skills/alpha/SKILL.md", SOURCE),
      [`${ADAPTATIONS_FRAGMENT_DIR}/batch-2.yaml`]: fragment("references/guide/REFERENCE.md", SOURCE),
    });
    const { rows, issues } = loadAdaptationFragments(ctx.root);
    expect(rows.map((r) => r.path).sort()).toEqual(["references/guide/REFERENCE.md", "skills/alpha/SKILL.md"]);
    expect(issues.filter((i) => i.severity === "error")).toEqual([]);
    // The merged view satisfies the donor-origin requirement with no file on disk.
    expect(checkProvenance(ctx).filter((i) => i.rule === "provenance.missing-adaptation")).toEqual([]);
  });

  test("an absent fragment directory is a note, and an empty merge is valid", () => {
    const ctx = ctxFor({});
    const { rows, issues } = loadAdaptationFragments(ctx.root);
    expect(rows).toEqual([]);
    expect(issues.map((i) => i.severity)).toEqual(["note"]);
  });

  test("two fragments claiming the same path with different sources is a conflict", () => {
    const ctx = ctxFor({
      [`${ADAPTATIONS_FRAGMENT_DIR}/batch-1.yaml`]: fragment("skills/alpha/SKILL.md", SOURCE),
      [`${ADAPTATIONS_FRAGMENT_DIR}/batch-2.yaml`]: fragment(
        "skills/alpha/SKILL.md",
        "donory@abcdef1234567890abcdef1234567890abcdef12:other.md",
      ),
    });
    const issue = loadAdaptationFragments(ctx.root).issues.find((i) => i.rule === "provenance.conflicting-adaptation");
    expect(issue?.severity).toBe("error");
    expect(issue?.message).toContain("skills/alpha/SKILL.md");
    expect(issue?.message).toContain("batch-1.yaml");
  });

  test("an exactly repeated row is redundant rather than contradictory, so it is a warning", () => {
    const ctx = ctxFor({
      [`${ADAPTATIONS_FRAGMENT_DIR}/batch-1.yaml`]: fragment("skills/alpha/SKILL.md", SOURCE),
      [`${ADAPTATIONS_FRAGMENT_DIR}/batch-2.yaml`]: fragment("skills/alpha/SKILL.md", SOURCE),
    });
    const { rows, issues } = loadAdaptationFragments(ctx.root);
    const issue = issues.find((i) => i.rule === "provenance.duplicate-adaptation");
    expect(issue?.severity).toBe("warning");
    // Both sides say the same thing, so the merge is still well defined and the
    // row appears once. Nothing is lost, which is why this is not an error.
    expect(rows).toHaveLength(1);
    expect(issues.filter((i) => i.severity === "error")).toEqual([]);
  });

  test("one fragment may record several donor sources for one body, and both survive the merge", () => {
    const second = "donory@abcdef1234567890abcdef1234567890abcdef12:other.md";
    const ctx = ctxFor({
      [`${ADAPTATIONS_FRAGMENT_DIR}/batch-1.yaml`]: `adaptations:\n  - path: skills/alpha/SKILL.md\n    source: ${SOURCE}\n  - path: skills/alpha/SKILL.md\n    source: ${second}\n`,
    });
    const { rows, issues } = loadAdaptationFragments(ctx.root);
    expect(issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(rows.map((r) => r.source).sort()).toEqual([SOURCE, second].sort());
    // Both sources survive into the generated file: attribution is not deduplicated away.
    const rendered = renderAdaptations(rows);
    expect(rendered).toContain(SOURCE);
    expect(rendered).toContain(second);
  });

  test("a row repeated inside one fragment is caught too", () => {
    const ctx = ctxFor({
      [`${ADAPTATIONS_FRAGMENT_DIR}/batch-1.yaml`]: `adaptations:\n  - path: a.md\n    source: ${SOURCE}\n  - path: a.md\n    source: ${SOURCE}\n`,
    });
    const issue = loadAdaptationFragments(ctx.root).issues.find((i) => i.rule === "provenance.duplicate-adaptation");
    expect(issue?.severity).toBe("warning");
  });
});

describe("adaptations.yaml is generated, never hand-edited", () => {
  test("the rendered file carries a generated header naming the write surface", () => {
    const text = renderAdaptations([]);
    expect(text).toContain("ak build");
    expect(text).toContain(ADAPTATIONS_FRAGMENT_DIR);
    expect(parseYaml(text)).toEqual({ adaptations: [] });
  });

  test("rows render sorted by path, so two fragment orders produce one file", () => {
    const a = renderAdaptations([
      { path: "b.md", source: SOURCE, file: "x", row: { path: "b.md", source: SOURCE } },
      { path: "a.md", source: SOURCE, file: "y", row: { path: "a.md", source: SOURCE } },
    ]);
    const b = renderAdaptations([
      { path: "a.md", source: SOURCE, file: "y", row: { path: "a.md", source: SOURCE } },
      { path: "b.md", source: SOURCE, file: "x", row: { path: "b.md", source: SOURCE } },
    ]);
    expect(a).toBe(b);
    expect((parseYaml(a) as { adaptations: Array<{ path: string }> }).adaptations.map((r) => r.path)).toEqual([
      "a.md",
      "b.md",
    ]);
  });

  test("fields a fragment carries beyond path and source survive the merge", () => {
    const ctx = ctxFor({
      [`${ADAPTATIONS_FRAGMENT_DIR}/batch-1.yaml`]: `adaptations:\n  - path: a.md\n    source: ${SOURCE}\n    license: MIT\n    note: reworded for this catalog\n`,
    });
    const rendered = renderAdaptations(loadAdaptationFragments(ctx.root).rows);
    expect(rendered).toContain("license: MIT");
    expect(rendered).toContain("reworded for this catalog");
  });

  test("a stale generated file is an error naming the command that fixes it", () => {
    const ctx = ctxFor({
      [`${ADAPTATIONS_FRAGMENT_DIR}/batch-1.yaml`]: fragment("a.md", SOURCE),
      [ADAPTATIONS_FILE]: "adaptations: []\n",
    });
    const issue = checkAdaptationsSync(ctx).find((i) => i.rule === "provenance.adaptations-out-of-sync");
    expect(issue?.severity).toBe("error");
    expect(issue?.message).toContain("ak build");
  });

  test("fragments with no generated file at all is the same drift", () => {
    const ctx = ctxFor({ [`${ADAPTATIONS_FRAGMENT_DIR}/batch-1.yaml`]: fragment("a.md", SOURCE) });
    expect(checkAdaptationsSync(ctx).some((i) => i.rule === "provenance.adaptations-out-of-sync")).toBe(true);
  });

  test("no fragments and no file is not drift; there is nothing to record yet", () => {
    const ctx = ctxFor({});
    expect(checkAdaptationsSync(ctx).filter((i) => i.severity === "error")).toEqual([]);
  });

  test("a hand-edited generated file is drift, which is how the header is enforced", () => {
    const ctx = ctxFor({
      [`${ADAPTATIONS_FRAGMENT_DIR}/batch-1.yaml`]: fragment("a.md", SOURCE),
      [ADAPTATIONS_FILE]: `${renderAdaptations([{ path: "a.md", source: SOURCE, file: "f", row: { path: "a.md", source: SOURCE } }])}# hand-added\n`,
    });
    expect(checkAdaptationsSync(ctx).some((i) => i.rule === "provenance.adaptations-out-of-sync")).toBe(true);
  });

  test("ak build writes the file, and the written file then validates in sync", () => {
    const ctx = ctxFor({ [`${ADAPTATIONS_FRAGMENT_DIR}/batch-1.yaml`]: fragment("a.md", SOURCE) });
    const issues = writeAdaptations(ctx);
    expect(issues.filter((i) => i.severity === "error")).toEqual([]);
    const written = readFileSync(join(ctx.root, ADAPTATIONS_FILE), "utf8");
    expect(written).toContain("a.md");
    expect(checkAdaptationsSync(ctx).filter((i) => i.severity === "error")).toEqual([]);
  });

  test("ak build refuses to write a file merged from conflicting fragments", () => {
    const ctx = ctxFor({
      [`${ADAPTATIONS_FRAGMENT_DIR}/batch-1.yaml`]: fragment("a.md", SOURCE),
      [`${ADAPTATIONS_FRAGMENT_DIR}/batch-2.yaml`]: fragment(
        "a.md",
        "donory@abcdef1234567890abcdef1234567890abcdef12:other.md",
      ),
    });
    const issues = writeAdaptations(ctx);
    expect(issues.some((i) => i.rule === "provenance.conflicting-adaptation")).toBe(true);
    expect(readFileSync(join(ctx.root, ADAPTATIONS_FILE), "utf8")).not.toContain("a.md");
  });
});
