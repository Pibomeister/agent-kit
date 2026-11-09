/**
 * An unbound or unreachable knowledgebase is a recorded coverage limit, never a lifecycle stop.
 *
 * Pins the wording an agent following the packaged lifecycle reads: `ak kb check` exit 3
 * (`kb.unbound`, `kb.unregistered`) and a missing or unknown `ak kb` command are a coverage limit
 * that never stops align, bound, scout, build, verify, review or ship under any policy; only exit 1
 * stops. Live runs stopped on the older wording (exit 3 "a publish refuses", a missing command
 * "is needs-input").
 */
import { readFileSync } from "node:fs";
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
