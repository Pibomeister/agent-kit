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
    const end = body.indexOf("the mode was not named", at);
    expect(end).toBeGreaterThan(at);
    expect(body.slice(at, end)).toContain("unattended check");
  });

  const START =
    "none of the typed command, a validated grant, a passing bypass check and the unattended policy's passing `unattended check`";
  const HUMAN_STARTED = ["super-align", "super-bound", "super-ship"];

  test.each(HUMAN_STARTED)("%s prose needs-input names every accepted start", (skill) => {
    const body = read(`skills/${skill}/SKILL.md`);
    const section = body.indexOf("## Stop conditions");
    expect(section).toBeGreaterThan(-1);
    const at = body.indexOf("`needs-input`", section);
    expect(at).toBeGreaterThan(-1);
    const next = body.indexOf(" - `", at);
    expect(body.slice(at, next > at ? next : undefined)).toContain(START);
    expect(body).not.toContain("neither the typed command nor a validated grant");
  });

  test.each(HUMAN_STARTED)("%s manifest stop wording names every accepted start", (skill) => {
    const yaml = read(`skills/${skill}/skill.yaml`);
    expect(yaml).not.toContain("neither the typed command nor a validated grant");
    expect(yaml).not.toContain("neither the typed command nor a grant");
    expect(yaml.split(START).length - 1).toBeGreaterThanOrEqual(2);
  });

  test("super-bound Authority lists the capability-map review as an unattended advance", () => {
    const body = read("skills/super-bound/SKILL.md");
    const at = body.indexOf("Under the unattended policy (ADR-0014)");
    expect(at).toBeGreaterThan(-1);
    const para = body.slice(at, body.indexOf("## Workflow", at));
    expect(para).toContain("the capability-map review");
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
