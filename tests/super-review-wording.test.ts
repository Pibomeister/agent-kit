/**
 * Super-review workflow step 12: a changes-requested full review is recorded with
 * `--verdict changes-requested`. The 0.1.37 wording recorded the gate only on approved.
 *
 * The lock reads the skill bytes after CRLF-to-LF only. STEP12 is the
 * whitespace-collapsed live step. A deliberate rewording updates STEP12 in the
 * same commit. Reflow, CRLF, and a newline or tab after `12.` still pass. The
 * two-phrase denylist is a tripwire. Headings are found case-insensitively.
 * SKILL.md may contain U+2014 EM DASH. Any other non-ASCII character fails.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

const REPO = join(import.meta.dir, "..");
const collapse = (s: string): string => s.replace(/\s+/g, " ").trim();

/** Collapsed skills/super-review/SKILL.md workflow step 12. */
const STEP12 =
  "12. On `approved`, record the gate for this mode: `node <this skill's directory>/../../bin/ak-gate.mjs record --gate review-full`, `review-delta` or `review-readiness` (the bundle's `bin/`). A `full` that returned `changes-requested` records `review-full --verdict changes-requested`; no other verdict is recorded. A full record on an earlier head, or one that requested changes, counts once an approved delta recorded after it covers the head. Run it from the project checkout; the run defaults to the branch's opened-run pointer (or the branch-named v1 run) and records to the git directory. A binding's brief supplies `--dir`. A record on a run that `ship-preflight` has closed is refused; the task needs a new `open`.";

describe("super-review wording", () => {
  test("step 12 records a changes-requested full review with --verdict changes-requested", () => {
    const raw = readFileSync(join(REPO, "skills/super-review/SKILL.md"), "utf8").replace(/\r\n/g, "\n");
    expect(raw.replace(/[\t\n\x20-\x7E\u2014]/g, "")).toBe("");
    const workflows = [...raw.matchAll(/^## workflow\s*$/gim)];
    const hards = [...raw.matchAll(/^## hard gates\s*$/gim)];
    const numbered = [...raw.matchAll(/^12\.[ \t\n]/gm)];
    expect(workflows.length).toBe(1);
    expect(hards.length).toBe(1);
    expect(numbered.length).toBe(1);
    const workflow = workflows[0];
    const hard = hards[0];
    const stepMatch = numbered[0];
    if (workflow === undefined || hard === undefined || stepMatch === undefined) {
      throw new Error("heading or step 12 match is missing");
    }
    const workflowAt = workflow.index;
    const hardAt = hard.index;
    const stepAt = stepMatch.index;
    if (workflowAt === undefined || hardAt === undefined || stepAt === undefined) {
      throw new Error("heading or step 12 match has no index");
    }
    expect(hardAt).toBeGreaterThan(workflowAt);
    expect(stepAt).toBeGreaterThan(workflowAt);
    expect(stepAt).toBeLessThan(hardAt);
    const between = raw.slice(workflowAt, hardAt);
    expect(between).not.toContain("```");
    expect(between).not.toContain("~~~");
    expect(between).not.toContain("<!--");
    const outside = collapse(raw.slice(0, stepAt) + "\n" + raw.slice(hardAt)).toLowerCase();
    expect(outside).not.toContain("and only then");
    expect(outside).not.toContain("do not record --verdict changes-requested");
    try {
      expect(collapse(raw.slice(stepAt, hardAt))).toBe(STEP12);
    } catch (cause) {
      throw new Error("issue #147: step 12 must tell reviewers to record a changes-requested full review", { cause });
    }
  });
});
