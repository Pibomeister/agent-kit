import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { findingsOfKind, parseSeeds, reconcilePredecessor } from "../src/validation/reconciliation.ts";

const FIXTURES = join(import.meta.dir, "fixtures/doc-review/reconcile");
const PREDECESSOR_ID = "auth-requirements";
const SUCCESSOR_ID = "auth-plan";

function load(name: string): string {
  return readFileSync(join(FIXTURES, name), "utf8");
}

function against(name: string) {
  return reconcilePredecessor(PREDECESSOR_ID, load("predecessor.md"), SUCCESSOR_ID, load(name));
}

describe("doc-review predecessor reconciliation (FR-02 / AT-03)", () => {
  test("the predecessor names D1, R1, R2 and ALT1", () => {
    const ids = parseSeeds(load("predecessor.md")).map((seed) => seed.id);
    expect(ids).toContain("D1");
    expect(ids).toContain("R1");
    expect(ids).toContain("R2");
    expect(ids).toContain("ALT1");
  });

  test("omitting R2 cites the predecessor seed and not successor prose", () => {
    const findings = against("omit-r2.md");
    const omissions = findingsOfKind(findings, "omission");
    const r2 = omissions.find((finding) => finding.seed === "R2");
    expect(r2).toBeDefined();
    expect(r2?.predecessor).toEqual({ artifact: PREDECESSOR_ID, seed: "R2", line: 19 });
    expect(r2?.successor).toBeNull();
    expect(findingsOfKind(findings, "changed")).toEqual([]);
    expect(findingsOfKind(findings, "material-addition")).toEqual([]);
    expect(omissions.find((finding) => finding.seed === "ALT1")).toBeUndefined();
  });

  test("omitting ALT1 cites the predecessor alternative", () => {
    const findings = against("omit-alt1.md");
    const omissions = findingsOfKind(findings, "omission");
    const alt1 = omissions.find((finding) => finding.seed === "ALT1");
    expect(alt1).toBeDefined();
    expect(alt1?.predecessor).toEqual({ artifact: PREDECESSOR_ID, seed: "ALT1", line: 23 });
    expect(alt1?.successor).toBeNull();
    expect(findingsOfKind(findings, "changed")).toEqual([]);
    expect(findingsOfKind(findings, "material-addition")).toEqual([]);
  });

  test("a changed D1 cites both predecessor and successor lines", () => {
    const findings = against("changed-d1.md");
    const changed = findingsOfKind(findings, "changed");
    const d1 = changed.find((finding) => finding.seed === "D1");
    expect(d1).toBeDefined();
    expect(d1?.predecessor).toEqual({ artifact: PREDECESSOR_ID, seed: "D1", line: 14 });
    expect(d1?.successor).toEqual({ artifact: SUCCESSOR_ID, seed: "D1", line: 15 });
    expect(findingsOfKind(findings, "omission")).toEqual([]);
    expect(findingsOfKind(findings, "material-addition")).toEqual([]);
  });

  test("adding R3 cites the successor seed and leaves alternatives in place", () => {
    const findings = against("add-r3.md");
    const additions = findingsOfKind(findings, "material-addition");
    const r3 = additions.find((finding) => finding.seed === "R3");
    expect(r3).toBeDefined();
    expect(r3?.predecessor).toBeNull();
    expect(r3?.successor).toEqual({ artifact: SUCCESSOR_ID, seed: "R3", line: 21 });
    expect(findingsOfKind(findings, "omission")).toEqual([]);
    expect(parseSeeds(load("add-r3.md")).some((seed) => seed.id === "ALT1")).toBe(true);
  });

  test("the valid control raises no omission, changed seed or addition", () => {
    const findings = against("valid-control.md");
    expect(findingsOfKind(findings, "omission")).toEqual([]);
    expect(findingsOfKind(findings, "changed")).toEqual([]);
    expect(findingsOfKind(findings, "material-addition")).toEqual([]);
    expect(parseSeeds(load("valid-control.md")).map((seed) => seed.id)).toEqual(["D1", "R1", "R2", "ALT1"]);
  });

  test("seeds in frontmatter, fences and non-seed sections are ignored", () => {
    const text = [
      "---",
      "R0. not a seed",
      "---",
      "",
      "## Product contract",
      "R9. not in a seed section.",
      "",
      "## Requirements",
      "R1. real.",
      "",
      "```",
      "R8. fenced.",
      "```",
      "",
    ].join("\n");
    expect(parseSeeds(text).map((seed) => seed.id)).toEqual(["R1"]);
  });
});
