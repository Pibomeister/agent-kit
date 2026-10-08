import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

import { REPO } from "./fixture.ts";

function body(path: string): string {
  return readFileSync(join(REPO, path), "utf8");
}

test("no-mistakes handoff and legacy transport are separated", () => {
  const reference = body("skills/super-ship/references/transport-no-mistakes.md");
  const skill = body("skills/super-ship/SKILL.md");
  for (const text of [reference, skill]) {
    for (const section of text.split(/(?=^#{1,6} )/m)) {
      if (/--skip review|auto_fix[\s\S]{0,90}(?:to be `0`|zero)/.test(section)) {
        expect(section.split("\n", 1)[0]).toMatch(/^#{1,6} .*deprecated/i);
      }
    }
  }
  expect(reference.replace(/\s+/g, " ")).toContain("handoff head");
  expect(reference).toContain("ship-preflight");
  expect(reference).toContain("empty working-tree diff");
  expect(reference).toContain("inside the pipeline");
  expect(reference).toContain("ask-user");
  expect(reference).toContain("supervisor");
  expect(reference).toContain("captain's words");
  expect(reference).toContain("expressly adopt source material by");
  expect(reference).not.toContain("substance of a referenced decision when the words depend on it");

  const handoff = reference.replace(/\s+/g, " ");
  const commit = handoff.indexOf("Commit the change before verification and review-readiness");
  const preflight = handoff.indexOf("Record ship-preflight at the same head");
  const stop = handoff.indexOf("super-ship ends at that record: it does not push or open a pull request");
  expect(commit).toBeGreaterThan(-1);
  expect(preflight).toBeGreaterThan(commit);
  expect(stop).toBeGreaterThan(preflight);
});

test("super-ship execution contract mirrors the no-mistakes handoff", () => {
  const skill = body("skills/super-ship/SKILL.md");
  const contract: unknown = parseYaml(body("skills/super-ship/skill.yaml"));
  const serialized = JSON.stringify(contract);
  expect(skill).toContain("stop at this immutable handoff");
  expect(serialized).toContain("committed handoff");
  expect(serialized).toContain("complete under no-mistakes delivery");
  expect(serialized).toContain("ship-preflight-gate");
  expect(serialized).toContain("not required at the no-mistakes handoff");
});
