import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { loadSkillManifest } from "../../src/packaging/manifest.ts";
import { REPO } from "./fixture.ts";

test("super-ship contract declares the no-mistakes handoff gate as an output", () => {
  const outputs = loadSkillManifest(REPO, "super-ship").raw["outputs"];
  expect(Array.isArray(outputs)).toBe(true);
  const ids = Array.isArray(outputs) ? outputs.map((output: { id?: unknown }) => output.id) : [];
  expect(ids).toContain("ship-preflight-gate");
  expect(ids).toContain("ship-evidence");
});

// These instruction files are the shipped contract. Check section authority, not prose wording.
function directivesOutsideDeprecatedSections(markdown: string): string[] {
  const headings: { level: number; title: string }[] = [];
  const violations: string[] = [];
  let paragraph: string[] = [];

  const checkParagraph = () => {
    const text = paragraph.join(" ");
    const skipReview = text.includes("--skip review");
    const zeroAutoFix = /auto_fix.*(?:to be `0`|must be zero|set .* to zero)/i.test(text);
    if ((skipReview || zeroAutoFix) && !headings.some(({ title }) => /deprecated/i.test(title))) {
      violations.push(text.trim());
    }
    paragraph = [];
  };

  for (const line of markdown.split(/\r?\n/)) {
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      checkParagraph();
      const level = (heading[1] ?? "").length;
      for (;;) {
        const previous = headings.at(-1);
        if (!previous || previous.level < level) break;
        headings.pop();
      }
      headings.push({ level, title: heading[2] ?? "" });
    } else if (line.trim() === "") {
      checkParagraph();
    } else {
      paragraph.push(line);
    }
  }
  checkParagraph();
  return violations;
}

test("legacy skip and auto-fix instructions stay inside deprecated sections", () => {
  const skill = readFileSync(join(REPO, "skills/super-ship/SKILL.md"), "utf8");
  const reference = readFileSync(join(REPO, "skills/super-ship/references/transport-no-mistakes.md"), "utf8");
  expect(directivesOutsideDeprecatedSections(skill)).toEqual([]);
  expect(directivesOutsideDeprecatedSections(reference)).toEqual([]);

  const displaced = reference
    .replace("--skip review,document,rebase\n", "")
    .replace("## Handoff\n", "## Handoff\n\n--skip review,document,rebase\n");
  expect(displaced).not.toBe(reference);
  expect(directivesOutsideDeprecatedSections(displaced)).toContain("--skip review,document,rebase");
});
