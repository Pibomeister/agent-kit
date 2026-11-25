/**
 * Super-review workflow step 12: a changes-requested full review is recorded with
 * `--verdict changes-requested`. The 0.1.37 wording recorded the gate only on approved.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

const REPO = join(import.meta.dir, "..");
const times = (hay: string, needle: string): number => hay.split(needle).length - 1;

/** Collapsed skills/super-review/SKILL.md workflow step 12, including the trailing space before Hard gates. */
const STEP12 =
  "12. On `approved`, record the gate for this mode: `node <this skill's directory>/../../bin/ak-gate.mjs record --gate review-full`, `review-delta` or `review-readiness` (the bundle's `bin/`). A `full` that returned `changes-requested` records `review-full --verdict changes-requested`; no other verdict is recorded. A full record on an earlier head, or one that requested changes, counts once an approved delta recorded after it covers the head. Run it from the project checkout; the run defaults to the branch's opened-run pointer (or the branch-named v1 run) and records to the git directory. A binding's brief supplies `--dir`. A record on a run that `ship-preflight` has closed is refused; the task needs a new `open`. ";

describe("super-review wording", () => {
  test("step 12 records a changes-requested full review with --verdict changes-requested", () => {
    const raw = readFileSync(join(REPO, "skills/super-review/SKILL.md"), "utf8");
    const body = raw.replace(/\s+/g, " ");
    expect([...raw.matchAll(/^## Workflow\s*$/gm)].length).toBe(1);
    expect([...raw.matchAll(/^## Hard gates\s*$/gm)].length).toBe(1);
    expect(times(body, "12. On `approved`")).toBe(1);
    const hard = body.indexOf("## Hard gates");
    const at = body.indexOf("12. On `approved`");
    expect(hard).toBeGreaterThan(at);
    const step = body.slice(at, hard);
    try {
      expect(step).toBe(STEP12);
    } catch (cause) {
      throw new Error("issue #147: step 12 must tell reviewers to record a changes-requested full review", { cause });
    }
  });
});
