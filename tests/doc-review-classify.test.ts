import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";

import { classifyDocumentFile, classifyDocumentKind, documentIdentity } from "../src/validation/classify-document.ts";

const FIXTURES = join(import.meta.dir, "fixtures/doc-review/classify");

describe("doc-review classifier (FR-01 / AT-20)", () => {
  test("a requirements-only product contract classifies as requirements", () => {
    const path = join(FIXTURES, "requirements-only.md");
    expect(classifyDocumentFile(path)).toBe("requirements");
    expect(classifyDocumentKind(readFileSync(path, "utf8"))).toBe("requirements");
  });

  test("a mixed document with implementation planning classifies as plan", () => {
    const path = join(FIXTURES, "mixed-plan.md");
    expect(classifyDocumentFile(path)).toBe("plan");
    expect(classifyDocumentKind(readFileSync(path, "utf8"))).toBe("plan");
  });

  test("a requirements body named plan.md is still requirements", () => {
    const path = join(FIXTURES, "plan.md");
    expect(basename(path)).toBe("plan.md");
    const content = readFileSync(path, "utf8");
    expect(content).toContain("expected: requirements");
    expect(content).toContain("filename_trap: plan.md");
    expect(content).toContain("status: ready-for-implementation");
    expect(content).not.toContain("## Rollout");
    expect(classifyDocumentFile(path)).toBe("requirements");
    expect(classifyDocumentKind(content)).toBe("requirements");
  });

  test("CRLF frontmatter is stripped the same as LF", () => {
    const lf = readFileSync(join(FIXTURES, "requirements-only.md"), "utf8");
    const crlf = lf.replaceAll("\n", "\r\n");
    expect(classifyDocumentKind(crlf)).toBe("requirements");
    expect(classifyDocumentKind(crlf)).toBe(classifyDocumentKind(lf));
  });

  test("changed bytes change identity", () => {
    const content = readFileSync(join(FIXTURES, "requirements-only.md"), "utf8");
    const identity = documentIdentity(content);
    expect(identity).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(documentIdentity(`${content}\n`)).not.toBe(identity);
    expect(documentIdentity(content)).toBe(identity);
  });
});
