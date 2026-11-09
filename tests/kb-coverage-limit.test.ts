/**
 * An unbound or unregistered knowledgebase, or a missing `ak kb` command, is a recorded coverage
 * limit, never a lifecycle stop. A configured knowledgebase that is unreachable still stops.
 *
 * Pins the wording an agent following the packaged lifecycle reads: `ak kb check` exit 3
 * (`kb.unbound`, `kb.unregistered`) and a missing or unknown `ak kb` command are a coverage limit
 * that never stops align, bound, scout, build, verify, review or ship under any policy; only exit 1
 * (a configured knowledgebase that cannot be used) stops. Live runs stopped on the older wording
 * (exit 3 "a publish refuses", a missing command "is needs-input"). Beyond the required sentences,
 * it checks that no other sentence in those files, the review roles or the unattended reference
 * still ties a stop to a coverage limit, that the review seats reading the knowledgebase stay
 * covered under one while the learnings lane is skipped with it as the reason, and that the
 * executable evals grade the same contract, their configured-failure scaffolds exiting 1.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { runKb } from "../src/kb/cli.ts";

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

  test("super-build stops on a failed receipt publish only for a configured knowledgebase", () => {
    const text = flat("skills/super-build/SKILL.md");
    expect(text).not.toContain("a failed receipt publish stops the build as before");
    expect(text).toContain("a configured knowledgebase (exit 1) failing a receipt publish stops the build");
    expect(text).toContain(
      "under a knowledgebase coverage limit the receipts are named as not published and the build goes on",
    );
  });

  test.each([
    ["super-scout", "under a knowledgebase coverage limit, skip it and name the dossier as not published"],
    ["super-verify", "under a knowledgebase coverage limit, skip it and name them as not published"],
  ])("%s's publish step skips the publish under a coverage limit", (skill, words) => {
    expect(flat(`skills/${skill}/SKILL.md`)).toContain(words);
  });

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
  /never stops?|does not stop|do not stop|not stop(?:ping)?(?: for it)?|without stopping|stops nothing|only exit 1 stops|(?:never|rather than) a stop|## stop conditions|refuses rather than falling back/gi;
/** A stop in any of its wordings: needs-input, a stop, a failure, a refusal or a block. */
const STOP =
  /needs-input|needs input|\bstop(?:s|ped|ping)?\b|\bfail(?:s|ed|ing)?\b|\brefus(?:e|es|ed|ing)\b|\bblock(?:s|ed|ing)?\b/i;
/** A clause about a configured knowledgebase that cannot be used: the one case that does stop. */
const CONFIGURED_FAILURE = /exit 1\b|(?<!not |un)configured knowledgebase|readContext failed/i;
/** Clause boundaries inside a sentence: commas, colons, dashes and contrasting conjunctions. */
const CLAUSE = /,\s+|:\s+|\s[—–]\s|\s(?:but|while|whereas|although|though|unless|except)\s/i;

/**
 * Sentences (and table cells) of a flattened file that tie a stop to a coverage-limit cause. A
 * sentence is read clause by clause: a clause stops when, with its own negations dropped, it still
 * names a stop, so a "never stops" in one clause cannot excuse a stop in the next. A stopping
 * clause is tied to a coverage limit when it or the clause before it names a cause, and a clause
 * about a configured knowledgebase failing (exit 1) may stop unless it names a cause itself.
 */
function stopsOnCoverageLimit(text: string): string[] {
  return text
    .split(/(?<=[.;])\s+|\s-\s|\s?\|\s/)
    .filter((s) => COVERAGE_CAUSE.test(s))
    .filter((s) => {
      const clauses = s.split(CLAUSE);
      return clauses.some((clause, i) => {
        const cause = COVERAGE_CAUSE.test(clause);
        if (CONFIGURED_FAILURE.test(clause) && !cause) return false;
        if (!STOP.test(clause.replaceAll(NOT_A_STOP, ""))) return false;
        return cause || COVERAGE_CAUSE.test(clauses[i - 1] ?? "");
      });
    });
}

describe("no lifecycle instruction ties a stop to a knowledgebase coverage limit", () => {
  const roles = spawnSync("git", ["ls-files", "roles"], { cwd: REPO, encoding: "utf8" })
    .stdout.split("\n")
    .filter((f) => f.endsWith(".md"));
  const files = [
    ...PHASES.flatMap((p) => [`skills/super-${p}/SKILL.md`, `skills/super-${p}/skill.yaml`]),
    "skills/doc-review/SKILL.md",
    "skills/doc-review/skill.yaml",
    "references/knowledgebase-binding/REFERENCE.md",
    "references/unattended-lifecycle/REFERENCE.md",
    ...roles,
  ];

  test("the conflict check catches the stop wording it guards against", () => {
    expect(stopsOnCoverageLimit("A missing kb-write is needs-input naming that prerequisite.")).toHaveLength(1);
    expect(stopsOnCoverageLimit("- id: no-knowledgebase-write-stops-before-publishing kind: x")).toHaveLength(1);
    expect(stopsOnCoverageLimit("With kb.unbound, stop at publication.")).toHaveLength(1);
    expect(stopsOnCoverageLimit("Exit 3 fails the phase.")).toHaveLength(1);
    expect(stopsOnCoverageLimit("Under kb.unregistered the run is failed.")).toHaveLength(1);
    expect(stopsOnCoverageLimit("A missing ak kb command refuses the run.")).toHaveLength(1);
    expect(stopsOnCoverageLimit("An unbound knowledgebase blocks approval.")).toHaveLength(1);
    expect(
      stopsOnCoverageLimit("A missing kb-write never stops review, but kb.unbound stops publication."),
    ).toHaveLength(1);
    expect(stopsOnCoverageLimit("kb.unbound stops the build like exit 1 does.")).toHaveLength(1);
    expect(stopsOnCoverageLimit("A coverage limit never stops this phase, and only exit 1 stops.")).toEqual([]);
    expect(
      stopsOnCoverageLimit(
        "A configured knowledgebase (exit 1) failing a publish stops the build, while under a knowledgebase coverage limit the build goes on.",
      ),
    ).toEqual([]);
  });

  test.each(files)("%s", (file) => {
    expect(stopsOnCoverageLimit(flat(file))).toEqual([]);
  });
});

describe("review seats that read the knowledgebase under a coverage limit", () => {
  test("code-review/learnings is recorded skipped with the coverage limit as its reason", () => {
    const text = flat("roles/code-review/learnings/ROLE.md");
    expect(text).not.toContain("The knowledgebase adapter was unavailable, or readContext failed: return unavailable");
    expect(text).not.toContain("records the lane covered");
    expect(text).toContain("knowledgebase coverage limit");
    expect(text).toContain(
      "the lane's activation condition, a readable corpus with hits on the touched surface, is not met",
    );
    expect(text).toContain("records the lane skipped with that limit as its reason, never unavailable");
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

  test("super-review says a lane whose only gap is a coverage limit is covered, and learnings is skipped", () => {
    for (const file of ["skills/super-review/SKILL.md", "skills/super-review/skill.yaml"]) {
      expect(flat(file)).toContain("a lane whose only gap is that limit is covered, not unavailable");
      expect(flat(file)).toContain(
        "the learnings lane, which activates only on a readable corpus with hits, is recorded skipped with the limit as its reason",
      );
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
    expect(c.graders).toContain("no-write-call");
    expect(c.text).toMatch(/no knowledgebase transport configured|transport is not configured/);
    expect(c.text).not.toMatch(/\bis down\b|unreachable|could not be opened/);
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
    expect(c.graders).toContain("no-edit-call");
    expect(c.graders).toContain("no-write-call");
  });

  /** ak kb check's exit for a case's scaffolded workspace, against an empty registry. */
  function kbCheckExit(id: string): number {
    const tmp = mkdtempSync(join(tmpdir(), "kb-case-"));
    try {
      const scaffold = spawnSync("bash", [join(REPO, `evals/${skill}/${id}/scaffold.sh`)], { cwd: tmp });
      expect(scaffold.status).toBe(0);
      const io = { out: () => {}, err: () => {} };
      return runKb(["check", tmp], { cwd: tmp, io, registry: join(tmp, ".no-registry.json") });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  test("the configured-failure scaffold makes ak kb check exit 1, and the unconfigured one exit 3", () => {
    expect(kbCheckExit("configured-knowledgebase-failure-stops")).toBe(1);
    expect(kbCheckExit("no-knowledgebase-write-continues-unpublished")).toBe(3);
  });
});
