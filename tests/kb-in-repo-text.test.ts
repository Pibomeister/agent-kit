import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The read-only in-repo knowledgebase in the text an agent follows: a publish
 * skipped with kb.read-only and a missing in-repo knowledgebase
 * (kb.in-repo-missing) are coverage limits in every phase that publishes, and
 * the contract and its decisions say why a read-only knowledgebase may sit
 * inside the application repository while a writable one never may.
 */

const REPO = join(import.meta.dir, "..");

/** The file's text with backticks dropped and every run of whitespace made one space. */
function flat(path: string): string {
  return readFileSync(join(REPO, path), "utf8").replaceAll("`", "").replaceAll(/\s+/g, " ");
}

const PHASES = ["align", "bound", "scout", "build", "verify", "review", "ship"];

describe.each(PHASES)("super-%s", (phase) => {
  for (const file of ["SKILL.md", "skill.yaml"]) {
    test(`${file} names a skipped publish and a missing in-repo knowledgebase as coverage limits`, () => {
      const text = flat(`skills/super-${phase}/${file}`);
      expect(text).toContain(
        "ak kb check exit 3 (kb.unbound, kb.unregistered), a publish exit 3 (kb.read-only), kb.in-repo-missing,",
      );
    });
  }
});

describe("doc-review", () => {
  for (const file of ["SKILL.md", "skill.yaml"]) {
    test(`${file} names a skipped publish and a missing in-repo knowledgebase as coverage limits`, () => {
      const text = flat(`skills/doc-review/${file}`);
      expect(text).toContain(
        "a publish skipped as read-only (kb.read-only), a missing in-repo one (kb.in-repo-missing)",
      );
    });
  }
});

describe("the knowledgebase-binding reference", () => {
  const text = flat("references/knowledgebase-binding/REFERENCE.md");

  test("names both new causes and what check exit 0 on a read-only binding means", () => {
    expect(text).toContain(
      "- **kb.in-repo-missing** — an in-repo binding with nothing to read at the revision it would read",
    );
    expect(text).toContain("superseded, deprecated and rejected are not settled either");
    expect(text).toContain("- **kb.read-only** — from a publish only: the binding is read-only, nothing was written");
    expect(text).toContain("| 0 | bound, read-only (backend in-repo)");
  });
});

describe("the in-repo binding document", () => {
  test("reads at the remote default branch and lets no binding name its own base", () => {
    const text = flat("adapters/knowledgebase/backends/in-repo.md");
    expect(text).toContain("The revision read is the merge-base of HEAD and the remote's default branch");
    expect(text).toContain("refs/remotes/origin/HEAD, with no local fallback");
    expect(text).not.toContain("base: main");
  });
});

describe("the contract and its decisions", () => {
  const contract = flat("adapters/knowledgebase/CONTRACT.md");

  test("Capabilities and side effects counts both new causes as unconfigured, never failed", () => {
    expect(contract).toContain(
      "A missing in-repo knowledgebase (kb.in-repo-missing) and a publish to a read-only one (kb.read-only) are unconfigured too",
    );
  });

  test("Centrality allows a read-only knowledgebase inside the application repository and no writable one", () => {
    expect(contract).toContain("A knowledgebase that can be written never resolves to the application repository");
    expect(contract).toContain("A read-only binding (backend in-repo) may");
  });

  test("Bindings lists the in-repo binding", () => {
    expect(contract).toContain("| in-repo |");
  });

  test("ADR-0010 item 5 is amended in place", () => {
    const adr = flat("docs/decisions/0010-file-backed-knowledgebase.md");
    expect(adr).toContain("**Amended:** 2026-11-09");
    expect(adr).toContain("A knowledgebase that can be written is never the application repository");
  });

  test("ADR-0001 records the read-only divergence from its central-ownership decision", () => {
    const adr = flat("docs/decisions/0001-kb-document-vocabulary.md");
    expect(adr).toContain("**Amended:** 2026-11-09");
    expect(adr).toContain("read through a read-only binding");
  });

  test("ruling kb-binding-is-a-locator carries the read-only exception", () => {
    const ruling = flat("policies/resolved-conflicts.yaml");
    expect(ruling).toContain("A binding that can be written and resolves to the application repository");
    expect(ruling).toContain("a read-only binding may name a directory inside it, because it carries no publish");
  });

  test("the local-git binding names the in-repo exception", () => {
    expect(flat("adapters/knowledgebase/backends/local-git.md")).toContain("backends/in-repo.md");
  });
});
