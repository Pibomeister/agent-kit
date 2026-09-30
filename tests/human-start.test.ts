import { describe, expect, test } from "bun:test";

import { loadCatalog } from "../src/catalog/load.ts";
import { checkHumanStart, firstNumberedItem, namesCommand } from "../src/validation/human-start.ts";
import { runValidation } from "../src/validation/run.ts";
import { makeTree, wellFormedSkill } from "./helpers/tree.ts";

/**
 * `alpha` is user-invoked and carries the two things the check reads; `scout`
 * is model-invoked and carries neither, which is what the check has to leave
 * alone. `compound-refresh` sits beside `compound` so that a description naming
 * the longer command is not read as naming the shorter one.
 */
function catalog(skills: ReadonlyArray<{ id: string; invocation: "U" | "M" }>): string {
  return `schema_version: 1
package:
  id: ak
  name: agent-kit
  version: 0.1.0
  namespace: "/ak:"
  default_profile: core
skills:
${skills.map((s) => `  - id: ${s.id}\n    status: authored\n    invocation: ${s.invocation}`).join("\n")}
`;
}

interface Body {
  readonly description?: string;
  readonly firstStep?: string;
}

/** `wellFormedSkill` with the description or the first step swapped for the text under test. */
function body(name: string, edit: Body = {}): string {
  let text = wellFormedSkill(name, `Runs the ${name} workflow on a ticket that already exists.`, "Read the ticket first.");
  if (edit.description !== undefined) {
    text = text.replace(/^description: >-\n(?:  .*\n)+/m, `description: ${edit.description}\n`);
  }
  if (edit.firstStep !== undefined) {
    text = text.replace(/^1\. Check how this run was started\.[^]*?\n(?=2\. )/m, `${edit.firstStep}\n`);
  }
  return text;
}

function ctxFor(files: Record<string, string>) {
  const root = makeTree(files);
  const { catalog: loaded } = loadCatalog(root);
  if (loaded === null) throw new Error("fixture has no catalog");
  return { root, catalog: loaded };
}

function issues(files: Record<string, string>) {
  return checkHumanStart(ctxFor(files)).map((i) => ({ rule: i.rule, file: i.file, line: i.line }));
}

/** 1-based line of the first line of `text` that starts with `prefix`. */
function lineOf(text: string, prefix: string): number {
  const index = text.split("\n").findIndex((line) => line.startsWith(prefix));
  if (index === -1) throw new Error(`no line starts with ${JSON.stringify(prefix)}`);
  return index + 1;
}

const ONE_U = catalog([{ id: "alpha", invocation: "U" }]);

describe("the positive control", () => {
  test("a user-invoked skill that names its command, states its class and stops first is clean", () => {
    expect(issues({ "catalog.yaml": ONE_U, "skills/alpha/SKILL.md": body("alpha") })).toEqual([]);
  });

  test("a model-invoked skill is not read at all", () => {
    const files = {
      "catalog.yaml": catalog([{ id: "scout", invocation: "M" }]),
      "skills/scout/SKILL.md": body("scout", {
        description: "Surveys the repository before a change.",
        firstStep: "1. Read the repository and list what the change touches.",
      }),
    };
    expect(issues(files)).toEqual([]);
  });

  test("the check is wired into the run under its own name", () => {
    const root = makeTree({
      "catalog.yaml": ONE_U,
      "skills/alpha/SKILL.md": body("alpha", { firstStep: "1. Read the named ticket and record its id." }),
    });
    const run = runValidation(root, { only: ["human-start"] });
    expect(run.issues.map((i) => i.rule)).toEqual(["invocation.first-step-not-stop"]);
  });
});

describe("the description", () => {
  test("must name the typed command", () => {
    const files = {
      "catalog.yaml": ONE_U,
      "skills/alpha/SKILL.md": body("alpha", {
        description: "Human-started command; on any other request tell the human to type the command.",
      }),
    };
    expect(issues(files)).toEqual([{ rule: "invocation.description-omits-command", file: "skills/alpha/SKILL.md", line: 3 }]);
  });

  test("must state the class", () => {
    const files = {
      "catalog.yaml": ONE_U,
      "skills/alpha/SKILL.md": body("alpha", {
        description: "Runs the alpha workflow when a human types `/ak:alpha`.",
      }),
    };
    expect(issues(files)).toEqual([{ rule: "invocation.description-omits-class", file: "skills/alpha/SKILL.md", line: 3 }]);
  });

  test("a topic-only description raises both, on the description's line", () => {
    const files = {
      "catalog.yaml": ONE_U,
      "skills/alpha/SKILL.md": body("alpha", { description: "Runs the alpha workflow when a human asks for it." }),
    };
    expect(issues(files).map((i) => i.rule).sort()).toEqual([
      "invocation.description-omits-class",
      "invocation.description-omits-command",
    ]);
  });

  test("naming a longer command that starts with this one does not count", () => {
    // `/ak:compound-refresh` contains `/ak:compound`; a description of `compound`
    // that only ever names the refresh command has not told anyone how to start
    // `compound`.
    const files = {
      "catalog.yaml": catalog([
        { id: "compound", invocation: "U" },
        { id: "compound-refresh", invocation: "U" },
      ]),
      "skills/compound/SKILL.md": body("compound", {
        description: "Human-started command; a human types `/ak:compound-refresh` to refresh, and this skill captures.",
      }),
      "skills/compound-refresh/SKILL.md": body("compound-refresh"),
    };
    expect(issues(files)).toEqual([{ rule: "invocation.description-omits-command", file: "skills/compound/SKILL.md", line: 3 }]);
  });

  test("the command is matched whole: a longer id that starts with it does not name it", () => {
    expect(namesCommand("type `/ak:compound`.", "/ak:compound")).toBe(true);
    expect(namesCommand("type `/ak:compound-refresh`.", "/ak:compound")).toBe(false);
    expect(namesCommand("type `/ak:compound2`.", "/ak:compound")).toBe(false);
    expect(namesCommand("type /ak:compound, then wait.", "/ak:compound")).toBe(true);
  });
});

describe("the first workflow step", () => {
  test("must name the command and say to stop, reported on the step's own line", () => {
    const skill = body("alpha", { firstStep: "1. Read the named ticket and record its id." });
    const files = { "catalog.yaml": ONE_U, "skills/alpha/SKILL.md": skill };
    expect(issues(files)).toEqual([
      { rule: "invocation.first-step-not-stop", file: "skills/alpha/SKILL.md", line: lineOf(skill, "1. Read the named") },
    ]);
  });

  test("naming the command without stopping is not enough", () => {
    const files = {
      "catalog.yaml": ONE_U,
      "skills/alpha/SKILL.md": body("alpha", { firstStep: "1. Note that a human types `/ak:alpha` to start this, then read the ticket." }),
    };
    const found = checkHumanStart(ctxFor(files));
    expect(found.map((i) => i.rule)).toEqual(["invocation.first-step-not-stop"]);
    expect(found[0]?.message).toContain("does not say to stop");
    expect(found[0]?.message).not.toContain("name `/ak:alpha` or");
  });

  test("stopping without naming the command is not enough", () => {
    const files = {
      "catalog.yaml": ONE_U,
      "skills/alpha/SKILL.md": body("alpha", { firstStep: "1. Check authority. Started by anyone but a human, stop." }),
    };
    const found = checkHumanStart(ctxFor(files));
    expect(found.map((i) => i.rule)).toEqual(["invocation.first-step-not-stop"]);
    expect(found[0]?.message).toContain("does not name `/ak:alpha`.");
  });

  test("the stop may sit on a continuation line of step 1, not only its first line", () => {
    const files = {
      "catalog.yaml": ONE_U,
      "skills/alpha/SKILL.md": body("alpha", {
        firstStep: "1. Check how this run was started.\n   Without `/ak:alpha` at the head of the human's message, stop and name the command.",
      }),
    };
    expect(issues(files)).toEqual([]);
  });

  test("a stop that only appears in step 2 does not rescue a step 1 that opens on the work", () => {
    const files = {
      "catalog.yaml": ONE_U,
      "skills/alpha/SKILL.md": body("alpha", {
        firstStep: "1. Read the named ticket and record its id.\n2. Started without `/ak:alpha`, stop.",
      }),
    };
    expect(issues(files).map((i) => i.rule)).toEqual(["invocation.first-step-not-stop"]);
  });

  test("a workflow with no numbered step is reported at the heading", () => {
    const skill = body("alpha").replace(/^1\. [^]*?^3\. .*\n/m, "Do the work and return the receipt.\n");
    const files = { "catalog.yaml": ONE_U, "skills/alpha/SKILL.md": skill };
    expect(issues(files)).toEqual([
      { rule: "invocation.first-step-not-stop", file: "skills/alpha/SKILL.md", line: lineOf(skill, "## Workflow") },
    ]);
  });

  test("a sub-heading before the steps is skipped, not read as the first step", () => {
    const files = {
      "catalog.yaml": ONE_U,
      "skills/alpha/SKILL.md": body("alpha").replace(/^1\. Check/m, "**Chart the map.**\n\n1. Check"),
    };
    expect(issues(files)).toEqual([]);
  });
});

describe("firstNumberedItem", () => {
  test("takes the item's continuation lines and stops at the next unindented line", () => {
    const item = firstNumberedItem("\nintro\n\n1. first\n   more of first\n\n   still first\nparagraph\n2. second\n");
    expect(item).toEqual({ text: "1. first\n   more of first\n\n   still first", line: 4 });
  });

  test("stops at the next numbered item even without a blank line", () => {
    expect(firstNumberedItem("1. first\n2. second\n")?.text).toBe("1. first");
  });

  test("returns null when the section holds no numbered item", () => {
    expect(firstNumberedItem("Just prose.\n- a bullet\n")).toBeNull();
  });
});
