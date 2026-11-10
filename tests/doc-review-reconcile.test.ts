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
    expect(findingsOfKind(findings, "contradiction")).toEqual([]);
    expect(findingsOfKind(findings, "material-addition")).toEqual([]);
    expect(omissions.find((finding) => finding.seed === "ALT1")).toBeUndefined();
  });

  test("contradicting D1 cites both predecessor and successor lines", () => {
    const findings = against("contradict-d1.md");
    const contradictions = findingsOfKind(findings, "contradiction");
    const d1 = contradictions.find((finding) => finding.seed === "D1");
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

  test("the valid control raises no omission, contradiction or addition", () => {
    const findings = against("valid-control.md");
    expect(findingsOfKind(findings, "omission")).toEqual([]);
    expect(findingsOfKind(findings, "contradiction")).toEqual([]);
    expect(findingsOfKind(findings, "material-addition")).toEqual([]);
    expect(parseSeeds(load("valid-control.md")).map((seed) => seed.id)).toEqual(["D1", "R1", "R2", "ALT1"]);
  });
});
