import { describe, expect, test } from "bun:test";

import { loadCatalog } from "../src/catalog/load.ts";
import {
  BODY_LINE_WARN,
  BODY_TOKEN_SOFT_WARN,
  BODY_TOKEN_WARN,
  DESCRIPTION_CHAR_WARN,
  ENFORCEMENT_DENSITY_WARN,
  isSkillStyleIssue,
  LEGACY_PHRASES,
  REFERENCE_FILE_LINE_WARN,
  SELECTION_SECTION_LINE_REPORT_MIN,
  SKILL_STYLE_RULE_PREFIX,
  checkSkillStyle,
} from "../src/validation/skill-style.ts";
import { makeTree } from "./helpers/tree.ts";

function ctxFor(skillFiles: Record<string, string>, ids: string[] = ["alpha"]) {
  const root = makeTree({
    "catalog.yaml": `schema_version: 1\npackage:\n  id: ak\n  name: agent-kit\n  version: 0.1.0\n  namespace: "/ak:"\n  default_profile: core\nskills:\n${ids
      .map((id) => `  - id: ${id}\n    status: authored\n    invocation: U\n`)
      .join("")}`,
    ...skillFiles,
  });
  const { catalog } = loadCatalog(root);
  if (catalog === null) throw new Error("fixture has no catalog");
  return { root, catalog };
}

/** A description carrying a trigger clause, so tests aimed at one check do not also trip the trigger check. */
const OK_DESCRIPTION = "Use when a ticket needs summarizing.";

function skill(body: string, description: string = OK_DESCRIPTION): string {
  return `---\nname: alpha\ndescription: ${description}\n---\n\n${body}`;
}

/** A skill named `id`, for a tree that holds several. */
function named(id: string, body: string, description = OK_DESCRIPTION): string {
  return `---\nname: ${id}\ndescription: ${description}\n---\n\n${body}`;
}

/** An n-token filler line with no spaces, digits or punctuation: it cannot trip any other check. */
function tokensOfFiller(tokens: number): string {
  return "w".repeat(4 * tokens + 1);
}

describe("skill-style: setup", () => {
  test("every rule id this module emits starts with the declared prefix", () => {
    expect(SKILL_STYLE_RULE_PREFIX).toBe("skill-style.");
    // One skill per check, so every id the module can emit is actually emitted and read here.
    const files = {
      "skills/s-long/SKILL.md": named("s-long", tokensOfFiller(BODY_TOKEN_WARN)),
      "skills/s-near/SKILL.md": named("s-near", tokensOfFiller(BODY_TOKEN_SOFT_WARN)),
      "skills/s-desc/SKILL.md": named("s-desc", "# S\n\nBody.\n", "word ".repeat(210).trim()),
      "skills/s-dense/SKILL.md": named(
        "s-dense",
        "Never skip a step. You must always check the queue, and skipping is forbidden.\n".repeat(3),
      ),
      "skills/s-table/SKILL.md": named(
        "s-table",
        '# S\n\n| The thought | Why it is wrong | Do this instead |\n|---|---|---|\n| "Obvious." | A guess. | Ask. |\n',
      ),
      "skills/s-select/SKILL.md": named(
        "s-select",
        "# S\n\n## When to use\n\nOne.\nTwo.\nThree.\n\n## Not for\n\nNo.\n",
      ),
      "skills/s-link/SKILL.md": named("s-link", "# S\n\nSee [the schema](../../schemas/dossier.schema.json).\n"),
      "skills/s-refs/SKILL.md": named("s-refs", "# S\n\nSee [a](./references/a.md) and [g](./references/guide.md).\n"),
      "skills/s-refs/references/a.md": "# A\n\nSee also [b](./b.md).\n",
      "skills/s-refs/references/b.md": "# B\n\nMore.\n",
      "skills/s-refs/references/guide.md": `# Guide\n\n${"Detail line.\n".repeat(REFERENCE_FILE_LINE_WARN + 1)}`,
      "skills/s-legacy/SKILL.md": named("s-legacy", "# S\n\nDo this: think step by step, then stop.\n"),
    };
    const ids = [...new Set(Object.keys(files).flatMap((path) => path.split("/").slice(1, 2)))];
    const emitted = [...new Set(checkSkillStyle(ctxFor(files, ids)).map((i) => i.rule))].toSorted();
    expect(emitted).toEqual(
      [
        "skill-style.body-approaching-limit",
        "skill-style.body-too-long",
        "skill-style.description-missing-trigger",
        "skill-style.description-too-long",
        "skill-style.enforcement-density-high",
        "skill-style.legacy-phrase",
        "skill-style.link-outside-skill-dir",
        "skill-style.rationalization-table",
        "skill-style.reference-chain-depth",
        "skill-style.reference-missing-toc",
        "skill-style.selection-text-in-body",
      ].toSorted(),
    );
    expect(emitted.every((rule) => rule.startsWith(SKILL_STYLE_RULE_PREFIX))).toBe(true);
  });

  test("isSkillStyleIssue matches only that prefix", () => {
    expect(isSkillStyleIssue({ severity: "warning", rule: "skill-style.body-too-long", file: "x", message: "m" })).toBe(
      true,
    );
    expect(isSkillStyleIssue({ severity: "warning", rule: "budget.skill-over-target", file: "x", message: "m" })).toBe(
      false,
    );
  });

  test("a skill with no SKILL.md yet is silent here; completeness owns that", () => {
    expect(checkSkillStyle(ctxFor({}))).toEqual([]);
  });
});

describe("skill-style: a clean skill triggers nothing", () => {
  const CLEAN = skill(
    [
      "# Alpha",
      "",
      "Read the ticket and produce a short summary.",
      "",
      "## When to use",
      "",
      "Use when a ticket needs summarizing.",
      "",
      "## Not for",
      "",
      "Not for editing code.",
    ].join("\n"),
  );

  test("no skill-style issues on a short, plain, self-contained body", () => {
    const ctx = ctxFor({ "skills/alpha/SKILL.md": CLEAN });
    expect(checkSkillStyle(ctx)).toEqual([]);
  });
});

describe("skill-style: 1. body length", () => {
  test("the thresholds are the named constants", () => {
    expect(BODY_LINE_WARN).toBe(500);
    expect(BODY_TOKEN_WARN).toBe(5000);
    expect(BODY_TOKEN_SOFT_WARN).toBe(3500);
  });

  test("over the line threshold is a warning", () => {
    // Built without skill()'s usual blank line after the frontmatter close, so
    // the body's own line count is not off by the one line that gap adds.
    const body = "Guidance line.\n".repeat(BODY_LINE_WARN + 1);
    const file = `---\nname: alpha\ndescription: ${OK_DESCRIPTION}\n---\n${body}`;
    const ctx = ctxFor({ "skills/alpha/SKILL.md": file });
    const issue = checkSkillStyle(ctx).find((i) => i.rule === "skill-style.body-too-long");
    expect(issue?.severity).toBe("warning");
    expect(issue?.message).toContain(`${BODY_LINE_WARN + 1} lines`);
  });

  test("over the token threshold is a warning even with few lines", () => {
    const ctx = ctxFor({ "skills/alpha/SKILL.md": skill(tokensOfFiller(BODY_TOKEN_WARN)) });
    const issue = checkSkillStyle(ctx).find((i) => i.rule === "skill-style.body-too-long");
    expect(issue?.severity).toBe("warning");
  });

  test("between the soft-warn and hard-warn token counts is a note, not a warning", () => {
    const ctx = ctxFor({ "skills/alpha/SKILL.md": skill(tokensOfFiller(BODY_TOKEN_SOFT_WARN)) });
    const issue = checkSkillStyle(ctx).find((i) => i.rule === "skill-style.body-approaching-limit");
    expect(issue?.severity).toBe("note");
    expect(checkSkillStyle(ctx).some((i) => i.rule === "skill-style.body-too-long")).toBe(false);
  });

  test("under the soft-warn line is silent", () => {
    const ctx = ctxFor({ "skills/alpha/SKILL.md": skill(tokensOfFiller(BODY_TOKEN_SOFT_WARN - 100)) });
    expect(checkSkillStyle(ctx).some((i) => i.rule.startsWith("skill-style.body"))).toBe(false);
  });
});

describe("skill-style: 2. frontmatter description", () => {
  test("the threshold is the named constant", () => {
    expect(DESCRIPTION_CHAR_WARN).toBe(1024);
  });

  test("a description over the character threshold is a warning", () => {
    const long = "word ".repeat(210).trim(); // > 1024 chars, "use when" absent on purpose
    expect(long.length).toBeGreaterThan(DESCRIPTION_CHAR_WARN);
    const ctx = ctxFor({ "skills/alpha/SKILL.md": skill("# Alpha\n\nBody.\n", long) });
    const issue = checkSkillStyle(ctx).find((i) => i.rule === "skill-style.description-too-long");
    expect(issue?.severity).toBe("warning");
    expect(issue?.message).toContain(String(long.length));
  });

  test("a description with no use-when-style trigger is a note", () => {
    const ctx = ctxFor({
      "skills/alpha/SKILL.md": skill("# Alpha\n\nBody.\n", "Summarizes tickets and prioritizes the backlog."),
    });
    const issue = checkSkillStyle(ctx).find((i) => i.rule === "skill-style.description-missing-trigger");
    expect(issue?.severity).toBe("note");
  });

  test("a description carrying 'use when' does not trip the trigger check", () => {
    const ctx = ctxFor({ "skills/alpha/SKILL.md": skill("# Alpha\n\nBody.\n") });
    expect(checkSkillStyle(ctx).some((i) => i.rule === "skill-style.description-missing-trigger")).toBe(false);
  });
});

describe("skill-style: 3. enforcement density", () => {
  test("the threshold is the named constant", () => {
    expect(ENFORCEMENT_DENSITY_WARN).toBe(15);
  });

  test("a body dense with never/must/forbidden/always is a warning", () => {
    const body = "Never skip a step. You must always check the queue, and skipping is forbidden.\n".repeat(3);
    const ctx = ctxFor({ "skills/alpha/SKILL.md": skill(body) });
    const issue = checkSkillStyle(ctx).find((i) => i.rule === "skill-style.enforcement-density-high");
    expect(issue?.severity).toBe("warning");
  });

  test("ordinary prose with none of those words is silent", () => {
    const ctx = ctxFor({ "skills/alpha/SKILL.md": skill("# Alpha\n\nRead the ticket and write a summary.\n") });
    expect(checkSkillStyle(ctx).some((i) => i.rule === "skill-style.enforcement-density-high")).toBe(false);
  });
});

describe("skill-style: 4. rationalization tables", () => {
  test("a table row opening with a quoted thought is reported by count", () => {
    const body = [
      "# Alpha",
      "",
      "| The thought | Why it is wrong | Do this instead |",
      "|---|---|---|",
      '| "The user obviously wants this." | It is a guess. | Ask. |',
    ].join("\n");
    const ctx = ctxFor({ "skills/alpha/SKILL.md": skill(body) });
    const issue = checkSkillStyle(ctx).find((i) => i.rule === "skill-style.rationalization-table");
    expect(issue?.severity).toBe("note");
    expect(issue?.message).toContain("1 rationalization-table row");
  });

  test("a table with no quoted-thought rows is silent", () => {
    const body = ["# Alpha", "", "| Name | Value |", "|---|---|", "| alpha | 1 |"].join("\n");
    const ctx = ctxFor({ "skills/alpha/SKILL.md": skill(body) });
    expect(checkSkillStyle(ctx).some((i) => i.rule === "skill-style.rationalization-table")).toBe(false);
  });
});

describe("skill-style: 5. selection text in the body", () => {
  test("the threshold is the named constant", () => {
    expect(SELECTION_SECTION_LINE_REPORT_MIN).toBe(3);
  });

  test("a 'When to use' section at or past the line threshold is a note", () => {
    const body = [
      "# Alpha",
      "",
      "## When to use",
      "",
      "Line one.",
      "Line two.",
      "Line three.",
      "",
      "## Not for",
      "",
      "Nothing.",
    ].join("\n");
    const ctx = ctxFor({ "skills/alpha/SKILL.md": skill(body) });
    const issue = checkSkillStyle(ctx).find((i) => i.rule === "skill-style.selection-text-in-body");
    expect(issue?.severity).toBe("note");
    expect(issue?.message).toContain("## When to use");
  });

  test("a section under the threshold is silent", () => {
    const body = ["# Alpha", "", "## When to use", "", "One line.", "", "## Not for", "", "One line."].join("\n");
    const ctx = ctxFor({ "skills/alpha/SKILL.md": skill(body) });
    expect(checkSkillStyle(ctx).some((i) => i.rule === "skill-style.selection-text-in-body")).toBe(false);
  });
});

describe("skill-style: 6. links outside the skill's own directory, and reference chain depth", () => {
  test("a link to a top-level directory outside the skill is reported by count", () => {
    const body = "# Alpha\n\nSee [the schema](../../schemas/dossier.schema.json) for the shape.\n";
    const ctx = ctxFor({ "skills/alpha/SKILL.md": skill(body) });
    const issue = checkSkillStyle(ctx).find((i) => i.rule === "skill-style.link-outside-skill-dir");
    expect(issue?.severity).toBe("note");
    expect(issue?.message).toContain("1 link");
  });

  test("a link to the skill's own references/ is not outside", () => {
    const body = "# Alpha\n\nSee [the guide](./references/guide.md) for detail.\n";
    const ctx = ctxFor({
      "skills/alpha/SKILL.md": skill(body),
      "skills/alpha/references/guide.md": "# Guide\n\nDetail.\n",
    });
    expect(checkSkillStyle(ctx).some((i) => i.rule === "skill-style.link-outside-skill-dir")).toBe(false);
  });

  test("a reference file linking to another reference file is a warning (depth > 1)", () => {
    const ctx = ctxFor({
      "skills/alpha/SKILL.md": skill("# Alpha\n\nSee [the guide](./references/a.md).\n"),
      "skills/alpha/references/a.md": "# A\n\nSee also [b](./b.md).\n",
      "skills/alpha/references/b.md": "# B\n\nMore detail.\n",
    });
    const issue = checkSkillStyle(ctx).find((i) => i.rule === "skill-style.reference-chain-depth");
    expect(issue?.severity).toBe("warning");
    expect(issue?.file).toBe("skills/alpha/references/a.md");
  });

  test("a reference file with no links to other reference files is silent", () => {
    const ctx = ctxFor({
      "skills/alpha/SKILL.md": skill("# Alpha\n\nSee [the guide](./references/a.md).\n"),
      "skills/alpha/references/a.md": "# A\n\nNo further links.\n",
    });
    expect(checkSkillStyle(ctx).some((i) => i.rule === "skill-style.reference-chain-depth")).toBe(false);
  });
});

describe("skill-style: 7. reference files over the line threshold with no table of contents", () => {
  test("the threshold is the named constant", () => {
    expect(REFERENCE_FILE_LINE_WARN).toBe(100);
  });

  test("a long reference file with no ToC heading is a warning", () => {
    const long = `# Guide\n\n${"Detail line.\n".repeat(REFERENCE_FILE_LINE_WARN + 1)}`;
    const ctx = ctxFor({
      "skills/alpha/SKILL.md": skill("# Alpha\n\nSee [the guide](./references/guide.md).\n"),
      "skills/alpha/references/guide.md": long,
    });
    const issue = checkSkillStyle(ctx).find((i) => i.rule === "skill-style.reference-missing-toc");
    expect(issue?.severity).toBe("warning");
    expect(issue?.file).toBe("skills/alpha/references/guide.md");
  });

  test("the same length file with a table-of-contents heading is silent", () => {
    const long = `# Guide\n\n## Table of contents\n\n${"Detail line.\n".repeat(REFERENCE_FILE_LINE_WARN + 1)}`;
    const ctx = ctxFor({
      "skills/alpha/SKILL.md": skill("# Alpha\n\nSee [the guide](./references/guide.md).\n"),
      "skills/alpha/references/guide.md": long,
    });
    expect(checkSkillStyle(ctx).some((i) => i.rule === "skill-style.reference-missing-toc")).toBe(false);
  });

  test("a short reference file with no ToC is silent", () => {
    const ctx = ctxFor({
      "skills/alpha/SKILL.md": skill("# Alpha\n\nSee [the guide](./references/guide.md).\n"),
      "skills/alpha/references/guide.md": "# Guide\n\nShort.\n",
    });
    expect(checkSkillStyle(ctx).some((i) => i.rule === "skill-style.reference-missing-toc")).toBe(false);
  });
});

describe("skill-style: 8. legacy phrases", () => {
  test("the phrase list is exactly these five", () => {
    expect([...LEGACY_PHRASES].sort()).toEqual(
      [
        "before every edit",
        "hold all findings",
        "if in doubt, use",
        "show your reasoning",
        "think step by step",
      ].sort(),
    );
  });

  test.each([...LEGACY_PHRASES])("carrying the legacy phrase %j is a warning naming it", (phrase) => {
    const ctx = ctxFor({ "skills/alpha/SKILL.md": skill(`# Alpha\n\nDo this: ${phrase}, then stop.\n`) });
    const issue = checkSkillStyle(ctx).find((i) => i.rule === "skill-style.legacy-phrase");
    expect(issue?.severity).toBe("warning");
    expect(issue?.message).toContain(phrase);
  });

  test("prose that avoids every legacy phrase is silent", () => {
    const ctx = ctxFor({ "skills/alpha/SKILL.md": skill("# Alpha\n\nRead the ticket and write a summary.\n") });
    expect(checkSkillStyle(ctx).some((i) => i.rule === "skill-style.legacy-phrase")).toBe(false);
  });
});

describe("skill-style: body findings report file lines, not body lines", () => {
  test("legacy-phrase, rationalization-table and selection-text lines count the frontmatter", () => {
    const body = [
      "# Alpha",
      "",
      "| The thought | Why | Instead |",
      "|---|---|---|",
      '| "Obviously fine." | A guess. | Ask. |',
      "",
      "## When to use",
      "",
      "Line one.",
      "Line two.",
      "Line three.",
      "",
      "Then think step by step.",
    ].join("\n");
    const text = skill(body);
    const fileLine = (needle: string) => text.split("\n").findIndex((l) => l.includes(needle)) + 1;
    const issues = checkSkillStyle(ctxFor({ "skills/alpha/SKILL.md": text }));
    const lineOf = (rule: string) => issues.find((i) => i.rule === rule)?.line;
    expect(lineOf("skill-style.legacy-phrase")).toBe(fileLine("think step by step"));
    expect(lineOf("skill-style.rationalization-table")).toBe(fileLine('"Obviously fine."'));
    expect(lineOf("skill-style.selection-text-in-body")).toBe(fileLine("## When to use"));
  });
});
