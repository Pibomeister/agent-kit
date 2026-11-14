import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { extractFunctions, findDuplicateFunctions, simplifyDuplicates } from "../src/validation/simplify-duplicates.ts";

const FIXTURES = join(import.meta.dir, "fixtures/simplify");
const DUPLICATE_HELPER = join(FIXTURES, "duplicate-helper");
const SECURITY_BOUNDARY = join(FIXTURES, "security-boundary");

function cites(
  hit: { left: { file: string; name: string }; right: { file: string; name: string } },
  file: string,
  name: string,
) {
  return (hit.left.file === file && hit.left.name === name) || (hit.right.file === file && hit.right.name === name);
}

describe("simplify paired fixtures (FR-05 / AT-06 / AT-07)", () => {
  test("the duplicate-helper repo cites formatDate in dates.js and csv.js", () => {
    const hits = findDuplicateFunctions(DUPLICATE_HELPER);
    const formatDate = hits.find(
      (hit) => cites(hit, "src/lib/dates.js", "formatDate") && cites(hit, "src/export/csv.js", "formatDate"),
    );
    expect(formatDate).toBeDefined();
    expect(formatDate?.kind).toBe("helper");
    expect(formatDate?.left.line).toBeGreaterThan(0);
    expect(formatDate?.right.line).toBeGreaterThan(0);
    expect(
      simplifyDuplicates(DUPLICATE_HELPER).some((hit) => hit.kind === "helper" && hit.left.name === "formatDate"),
    ).toBe(true);
    expect(hits.some((hit) => cites(hit, "src/export/write.js", "joinRows"))).toBe(false);
  });

  test("the security-boundary repo retains requireSession and does not offer it as cleanup", () => {
    const hits = findDuplicateFunctions(SECURITY_BOUNDARY);
    const admin = hits.find(
      (hit) =>
        cites(hit, "src/auth/require-session.js", "requireSession") &&
        cites(hit, "src/http/admin.js", "requireSession"),
    );
    const billing = hits.find(
      (hit) =>
        cites(hit, "src/auth/require-session.js", "requireSession") &&
        cites(hit, "src/http/billing.js", "requireSession"),
    );
    expect(admin).toBeDefined();
    expect(billing).toBeDefined();
    expect(admin?.kind).toBe("security-boundary");
    expect(billing?.kind).toBe("security-boundary");
    expect(
      simplifyDuplicates(SECURITY_BOUNDARY).some(
        (hit) => hit.left.name === "requireSession" || hit.right.name === "requireSession",
      ),
    ).toBe(false);
    expect(hits.some((hit) => cites(hit, "src/lib/dates.js", "formatDate"))).toBe(false);
  });

  test("function f(a = {}) uses the body brace, not the default object", () => {
    const source = "function f(a = {}) {\n  return a;\n}\n";
    const fns = extractFunctions("src/f.js", source);
    expect(fns).toHaveLength(1);
    expect(fns[0]?.name).toBe("f");
    expect(fns[0]?.body).toBe("{ return a; }");
  });

  test("an arrow function is outside the supported subset", () => {
    expect(extractFunctions("src/a.js", "const f = (a = {}) => a;\n")).toEqual([]);
  });
});
