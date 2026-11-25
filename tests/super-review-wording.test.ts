/**
 * Super-review workflow step 12: a changes-requested full review is recorded with
 * `--verdict changes-requested`. The 0.1.37 wording recorded the gate only on approved.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

const REPO = join(import.meta.dir, "..");
const collapse = (s: string): string => s.replace(/\s+/g, " ").trim();
const HEADING = /^## (?:Workflow|Hard gates)\s*$/gm;
const STEP12 = /^12\. /gm;
const RECORDING = "A `full` that returned `changes-requested` records `review-full --verdict changes-requested`";

describe("super-review wording", () => {
  test("step 12 records a changes-requested full review with --verdict changes-requested", () => {
    const raw = readFileSync(join(REPO, "skills/super-review/SKILL.md"), "utf8");
    const numbered = [...raw.matchAll(STEP12)];
    const headings = [...raw.matchAll(HEADING)];
    expect(numbered.length).toBe(1);
    expect(headings.length).toBe(2);
    const firstHeading = headings[0];
    const secondHeading = headings[1];
    const stepMatch = numbered[0];
    if (firstHeading === undefined || secondHeading === undefined || stepMatch === undefined) {
      throw new Error("heading or step 12 match is missing");
    }
    expect(firstHeading[0].trimEnd()).toBe("## Workflow");
    expect(secondHeading[0].trimEnd()).toBe("## Hard gates");
    const workflowAt = firstHeading.index;
    const hardAt = secondHeading.index;
    const stepAt = stepMatch.index;
    if (workflowAt === undefined || hardAt === undefined || stepAt === undefined) {
      throw new Error("heading or step 12 match has no index");
    }
    expect(hardAt).toBeGreaterThan(workflowAt);
    expect(stepAt).toBeGreaterThan(workflowAt);
    expect(stepAt).toBeLessThan(hardAt);
    const step = collapse(raw.slice(stepAt, hardAt));
    expect(step.startsWith("12. On `approved`")).toBe(true);
    const outside = collapse(raw.slice(0, stepAt) + "\n" + raw.slice(hardAt)).toLowerCase();
    expect(outside).not.toContain("and only then");
    expect(outside).not.toContain("do not record --verdict changes-requested");
    try {
      expect(step).toContain(RECORDING);
    } catch (cause) {
      throw new Error("issue #147: step 12 must tell reviewers to record a changes-requested full review", { cause });
    }
  });
});
