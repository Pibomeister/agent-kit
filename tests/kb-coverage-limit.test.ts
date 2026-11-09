/**
 * An unbound or unregistered knowledgebase, or a missing `ak kb` command, is a recorded coverage
 * limit, never a lifecycle stop. A configured knowledgebase that is unreachable still stops.
 *
 * Pins the wording an agent following the packaged lifecycle reads: `ak kb check` exit 3
 * (`kb.unbound`, `kb.unregistered`) and a missing or unknown `ak kb` command are a coverage limit
 * that never stops align, bound, scout, build, verify, review or ship under any policy; only exit 1
 * (a configured knowledgebase that cannot be used) stops. Live runs stopped on the older wording
 * (exit 3 "a publish refuses", a missing command "is needs-input"). Beyond the required sentences,
 * it checks that no other sentence in those files still ties a stop to a coverage limit, that the
 * review seats reading the knowledgebase stay covered under one, and that the executable evals
 * grade the same contract.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

const REPO = join(import.meta.dir, "..");

/** The file's text with backticks dropped and every run of whitespace, YAML indentation included, made one space. */
function flat(path: string): string {
  return readFileSync(join(REPO, path), "utf8").replaceAll("`", "").replaceAll(/\s+/g, " ");
}

const PHASES = ["align", "bound", "scout", "build", "verify", "review", "ship"];

describe("the knowledgebase-binding reference", () => {
  const text = flat("references/knowledgebase-binding/REFERENCE.md");

  test("a missing or unknown ak kb command is a coverage limit, not needs-input", () => {
    expect(text).not.toContain("is needs-input naming that prerequisite");
    expect(text).toContain("missing or unknown ak kb command");
    expect(text).toContain("no kb subcommand");
  });

  test("the exit 3 row skips a publish instead of refusing the run", () => {
    const row = text.match(/\| 3 \|[^\n]*?\| 1 \|/)?.[0] ?? "";
    expect(row).not.toBe("");
    expect(row).not.toContain("refuses");
    expect(row).toContain("coverage limit");
    expect(row).toContain("skipped");
  });

  test("a coverage limit never stops a lifecycle phase under any policy, and only exit 1 stops", () => {
    expect(text).toContain("never stops align, bound, scout, build, verify, review or ship");
    expect(text).toContain("under any policy: attended, Firstmate or unattended");
    expect(text).toContain("named in the run result as not published");
    expect(text).toContain("ak-gate.mjs record");
    expect(text).toContain("only exit 1 stops");
  });

  test("no agent creates the binding or registers a path", () => {
    expect(text).toContain("An agent does not create a knowledgebase, write ak.kb.yaml or register a path");
  });
});

describe("the unattended-lifecycle reference", () => {
  const text = flat("references/unattended-lifecycle/REFERENCE.md");

  test("a coverage limit is not a missing prerequisite and has its own gate evidence", () => {
    expect(text).toContain("a knowledgebase coverage limit is not one");
    expect(text).toContain("Under a knowledgebase coverage limit");
  });
});

describe.each(PHASES)("super-%s", (phase) => {
  for (const file of ["SKILL.md", "skill.yaml"]) {
    test(`${file} says a coverage limit never stops the phase and only exit 1 does`, () => {
      const text = flat(`skills/super-${phase}/${file}`);
      expect(text).toContain("knowledgebase coverage limit");
      expect(text).toContain("ak kb check exit 3 (kb.unbound, kb.unregistered)");
      expect(text).toContain("a missing or unknown ak kb command");
      expect(text).toContain("never stops this phase under any policy");
      expect(text).toContain("named in the result as not published");
      expect(text).toContain("only exit 1");
    });
  }
});

describe("publication under a coverage limit is skipped, not a needs-input stop", () => {
  test("super-align continues past publication", () => {
    for (const file of ["skills/super-align/SKILL.md", "skills/super-align/skill.yaml"]) {
      const text = flat(file);
      expect(text).not.toContain("stop before publication with needs-input");
      expect(text).not.toContain("publish nothing and return needs-input");
      expect(text).not.toContain("publication reached an unavailable knowledgebase adapter");
      expect(text).not.toContain("publication reaches an unavailable knowledgebase adapter");
      expect(text).not.toContain("publication stops with needs-input");
      expect(text).not.toContain("unavailable kb-read and kb-write at publication");
      expect(text).not.toContain("stop at publication with needs-input");
    }
  });

  test.each(["super-align", "super-bound", "doc-review"])(
    "%s does not stop with needs-input on a missing kb-write",
    (skill) => {
      const text = flat(`skills/${skill}/skill.yaml`);
      expect(text).not.toContain("stops with needs-input, names kb-write");
      expect(text).toContain("names kb-write as the capability the host does not provide");
    },
  );

  test("doc-review returns its record unpublished under a coverage limit", () => {
    for (const file of ["skills/doc-review/SKILL.md", "skills/doc-review/skill.yaml"]) {
      expect(flat(file)).toContain("knowledgebase coverage limit");
    }
  });
});

/** A sentence naming a coverage-limit cause: unbound, unregistered, exit 3, a missing ak kb command or kb-read/kb-write. */
const COVERAGE_CAUSE =
  /\bunbound\b|\bunregistered\b|exit 3|ak kb command|kb-(?:read|write)|knowledgebase-write|no knowledgebase|knowledgebase coverage limit|knowledgebase (?:is |was )?(?:unavailable|not configured|unconfigured)/i;
/** The phrasings that say a coverage limit does not stop, removed before a stop is looked for. */
const NOT_A_STOP =
  /never stops?|does not stop|do not stop|not stop(?:ping)?(?: for it)?|without stopping|stops nothing|only exit 1 stops|(?:never|rather than) a stop|## stop conditions/gi;
const STOP = /needs-input|needs input|\bstop(?:s|ped|ping)?\b/i;

/** Sentences (and table cells) of a flattened file that tie a stop or needs-input to a coverage-limit cause. */
function stopsOnCoverageLimit(text: string): string[] {
  return text
    .split(/(?<=[.;])\s+|\s-\s|\s?\|\s/)
    .filter((s) => COVERAGE_CAUSE.test(s) && STOP.test(s.replaceAll(NOT_A_STOP, "")));
}

describe("no lifecycle instruction ties a stop to a knowledgebase coverage limit", () => {
  const files = [
    ...PHASES.flatMap((p) => [`skills/super-${p}/SKILL.md`, `skills/super-${p}/skill.yaml`]),
    "skills/doc-review/SKILL.md",
    "skills/doc-review/skill.yaml",
    "references/knowledgebase-binding/REFERENCE.md",
  ];

  test("the conflict check catches the stop wording it guards against", () => {
    expect(stopsOnCoverageLimit("A missing kb-write is needs-input naming that prerequisite.")).toHaveLength(1);
    expect(stopsOnCoverageLimit("- id: no-knowledgebase-write-stops-before-publishing kind: x")).toHaveLength(1);
    expect(stopsOnCoverageLimit("With kb.unbound, stop at publication.")).toHaveLength(1);
    expect(stopsOnCoverageLimit("A coverage limit never stops this phase, and only exit 1 stops.")).toEqual([]);
  });

  test.each(files)("%s", (file) => {
    expect(stopsOnCoverageLimit(flat(file))).toEqual([]);
  });
});

describe("review seats that read the knowledgebase stay covered under a coverage limit", () => {
  test("code-review/learnings runs against no recorded learnings and is recorded covered", () => {
    const text = flat("roles/code-review/learnings/ROLE.md");
    expect(text).not.toContain("The knowledgebase adapter was unavailable, or readContext failed: return unavailable");
    expect(text).toContain("knowledgebase coverage limit");
    expect(text).toContain("Run against no recorded learnings and return empty naming the coverage limit");
    expect(text).toContain("records the lane covered with that limit as its reason, never unavailable");
    expect(text).toContain("ak kb check exit 1");
  });

  test.each([
    "roles/reviewer-spec/ROLE.md",
    "roles/reviewer-standards/ROLE.md",
    "roles/doc-review/comprehension/ROLE.md",
  ])("%s names the coverage limit instead of going unavailable, and exit 1 stays unavailable", (file) => {
    const text = flat(file);
    expect(text).toContain("knowledgebase coverage limit");
    expect(text).toContain("never makes this lane unavailable");
    expect(text).toContain("ak kb check exit 1");
  });

  test("super-review says a lane whose only gap is a coverage limit is covered", () => {
    for (const file of ["skills/super-review/SKILL.md", "skills/super-review/skill.yaml"]) {
      expect(flat(file)).toContain("a lane whose only gap is that limit is covered, not unavailable");
    }
  });
});

describe.each(["super-align", "super-bound", "doc-review"])("%s knowledgebase evals", (skill) => {
  /** A case's prompt and graders, flattened: grader names are its `- name:` entries. */
  function load(id: string) {
    const raw = readFileSync(join(REPO, `evals/${skill}/${id}/case.yaml`), "utf8");
    return {
      text: flat(`evals/${skill}/${id}/case.yaml`),
      graders: [...raw.matchAll(/^ {2}- name: (\S+)$/gm)].map((m) => m[1]),
    };
  }
  const declared = [
    ...readFileSync(join(REPO, `skills/${skill}/skill.yaml`), "utf8").matchAll(/^ {2}- id: (\S+)$/gm),
  ].map((m) => m[1]);

  test("the stop-named case is gone from the tree and the declarations", () => {
    expect(existsSync(join(REPO, `evals/${skill}/no-knowledgebase-write-stops-before-publishing`))).toBe(false);
    expect(declared).not.toContain("no-knowledgebase-write-stops-before-publishing");
  });

  test("an unconfigured knowledgebase continues, names the artifacts not published and writes no substitute", () => {
    expect(declared).toContain("no-knowledgebase-write-continues-unpublished");
    const c = load("no-knowledgebase-write-continues-unpublished");
    expect(c.graders).not.toContain("reports-needs-input");
    expect(c.graders).not.toContain("stops-naming-kb-write");
    expect(c.graders).toContain("nothing-written-into-the-repository");
    expect(c.graders).toContain("no-edit-call");
    expect(c.text).toContain("not published");
    expect(c.text).toContain("does not stop");
    expect(c.text).not.toMatch(/needs input|stops there/);
  });

  test("a configured knowledgebase that fails (exit 1) stops", () => {
    expect(declared).toContain("configured-knowledgebase-failure-stops");
    const c = load("configured-knowledgebase-failure-stops");
    expect(c.text).toContain("ak kb check exited 1");
    expect(c.text).toContain("The response stops with failed");
    expect(c.graders).toContain("nothing-written-into-the-repository");
  });
});
