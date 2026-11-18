/**
 * Super-review workflow step 12: a changes-requested full review is recorded with
 * `--verdict changes-requested`. The 0.1.37 wording recorded the gate only on approved.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

const REPO = join(import.meta.dir, "..");
const read = (p: string): string => readFileSync(join(REPO, p), "utf8").replace(/\s+/g, " ");

describe("super-review wording", () => {
  test("step 12 records a changes-requested full review with --verdict changes-requested", () => {
    const body = read("skills/super-review/SKILL.md");
    const at = body.indexOf("12. On `approved`");
    expect(at).toBeGreaterThan(-1);
    const end = body.indexOf("## Hard gates", at);
    expect(end).toBeGreaterThan(at);
    expect(body.slice(at, end)).toContain("review-full --verdict changes-requested");
  });
});
