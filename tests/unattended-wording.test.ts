/**
 * Unattended-policy wording (ADR-0014): super-ship's needs-input stop names the
 * unattended start, and the capability-map review is an unattended advance.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

const REPO = join(import.meta.dir, "..");
const read = (p: string): string => readFileSync(join(REPO, p), "utf8").replace(/\s+/g, " ");

describe("unattended wording", () => {
  test("super-ship needs-input names the unattended start", () => {
    const body = read("skills/super-ship/SKILL.md");
    const at = body.indexOf("`needs-input`:");
    expect(at).toBeGreaterThan(-1);
    const condition = body.slice(at, body.indexOf("the mode was not named", at));
    expect(condition).toContain("unattended check");
  });

  test("the unattended reference lists the capability-map review as an advance", () => {
    const body = read("references/unattended-lifecycle/REFERENCE.md");
    const at = body.indexOf("## Advancing without a human");
    const section = body.slice(at, body.indexOf("Every other stop still stops", at));
    expect(section).toContain("capability-map review");
  });

  test("super-bound step 3 cites the unattended advance", () => {
    const body = read("skills/super-bound/SKILL.md");
    const at = body.indexOf("draw the capability map first");
    expect(at).toBeGreaterThan(-1);
    const step = body.slice(at, body.indexOf("4. Write the specification", at));
    expect(step).toContain("unattended advance");
    expect(step).toContain("unattended-lifecycle/REFERENCE.md");
  });
});
