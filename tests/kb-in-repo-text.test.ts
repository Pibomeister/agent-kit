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
    expect(text).toContain("kb.in-repo-missing");
    expect(text).toContain("kb.read-only");
    expect(text).toContain("bound, read-only");
  });
});

describe("the contract and its decisions", () => {
  const contract = flat("adapters/knowledgebase/CONTRACT.md");

  test("§1 counts both new causes as unconfigured, never failed", () => {
    expect(contract).toContain("kb.in-repo-missing");
    expect(contract).toContain("kb.read-only");
  });

  test("§3 allows a read-only knowledgebase inside the application repository and no writable one", () => {
    expect(contract).toContain("A knowledgebase that can be written never resolves to the application repository");
    expect(contract).toContain("A read-only binding (backend in-repo) may");
  });

  test("§7 lists the in-repo binding", () => {
    expect(contract).toContain("| in-repo |");
  });

  test("ADR-0010 item 5 is amended in place", () => {
    const adr = flat("docs/decisions/0010-file-backed-knowledgebase.md");
    expect(adr).toContain("**Amended:** 2026-11-09");
    expect(adr).toContain("A knowledgebase that can be written is never the application repository");
  });

  test("ADR-0001 records the read-only divergence from its §1", () => {
    const adr = flat("docs/decisions/0001-kb-document-vocabulary.md");
    expect(adr).toContain("**Amended:** 2026-11-09");
    expect(adr).toContain("read through a read-only binding");
  });

  test("the local-git binding names the in-repo exception", () => {
    expect(flat("adapters/knowledgebase/backends/local-git.md")).toContain("backends/in-repo.md");
  });
});
