import { describe, expect, test } from "bun:test";

import { resolveFindingSectionIdentity } from "../src/validation/headings.ts";

/**
 * AT-15 / FR-07: two sections with the same heading title must resolve uniquely
 * or refuse. A silent first-match / last-wins merge is the defect.
 */
describe("finding identity: duplicate section titles refuse rather than silently merge", () => {
  const document = [
    "# Spec",
    "",
    "## Requirements",
    "",
    "Auth must reject expired tokens.",
    "",
    "## Requirements",
    "",
    "Payments must bound retries.",
    "",
  ].join("\n");

  test("two sections with the same heading title refuse rather than share one identity", () => {
    const first = resolveFindingSectionIdentity(document, "Requirements");
    const second = resolveFindingSectionIdentity(document, "Requirements");
    expect(first.ok).toBe(false);
    expect(second.ok).toBe(false);
    if (first.ok || second.ok) throw new Error("silent merge: duplicate headings produced an identity");
    expect(first.reason).toBe("ambiguous");
    expect(second.reason).toBe("ambiguous");
    expect(first.lines).toEqual([3, 7]);
    expect(first.error).toMatch(/cannot resolve it uniquely/);
  });

  test("a unique heading still resolves, and two unique headings do not share identity", () => {
    const unique = [
      "# Spec",
      "",
      "## Auth",
      "",
      "Reject expired tokens.",
      "",
      "## Payments",
      "",
      "Bound retries.",
      "",
    ].join("\n");
    const auth = resolveFindingSectionIdentity(unique, "Auth");
    const payments = resolveFindingSectionIdentity(unique, "Payments");
    expect(auth.ok).toBe(true);
    expect(payments.ok).toBe(true);
    if (!auth.ok || !payments.ok) throw new Error("unique headings must resolve");
    expect(auth.identity).not.toBe(payments.identity);
    expect(auth.body).toContain("Reject expired tokens.");
    expect(payments.body).toContain("Bound retries.");
  });

  test("a missing heading is missing, not a merged identity", () => {
    const missing = resolveFindingSectionIdentity(document, "Out of scope");
    expect(missing.ok).toBe(false);
    if (missing.ok) throw new Error("missing heading must not resolve");
    expect(missing.reason).toBe("missing");
  });

  test("case and punctuation differences do not match and are not duplicates", () => {
    const mixed = [
      "# Spec",
      "",
      "## 1. Safety",
      "Exact title.",
      "",
      "## C++",
      "Plus plus.",
      "",
      "## C",
      "See.",
      "",
      "## Setup",
      "Capital.",
      "",
      "## setup",
      "Lower.",
      "",
    ].join("\n");
    const punctuated = resolveFindingSectionIdentity(mixed, "1 safety");
    expect(punctuated.ok).toBe(false);
    if (punctuated.ok) throw new Error("normalized punctuation must not match an exact title");
    expect(punctuated.reason).toBe("missing");

    const cpp = resolveFindingSectionIdentity(mixed, "C++");
    const c = resolveFindingSectionIdentity(mixed, "C");
    expect(cpp.ok).toBe(true);
    expect(c.ok).toBe(true);
    if (!cpp.ok || !c.ok) throw new Error("C++ and C must each resolve uniquely");
    expect(c.body).toContain("See.");
    expect(cpp.body).toContain("Plus plus.");

    const setup = resolveFindingSectionIdentity(mixed, "Setup");
    const setupLower = resolveFindingSectionIdentity(mixed, "setup");
    expect(setup.ok).toBe(true);
    expect(setupLower.ok).toBe(true);
    if (!setup.ok || !setupLower.ok) throw new Error("Setup and setup must each resolve uniquely");
    expect(setup.body).toContain("Capital.");
    expect(setupLower.body).toContain("Lower.");
  });

  test("the requested heading is compared as given, not trimmed", () => {
    const spec = ["# Spec", "", "## Requirements", "", "Body.", ""].join("\n");
    const padded = resolveFindingSectionIdentity(spec, " Requirements");
    expect(padded.ok).toBe(false);
    if (padded.ok) throw new Error("a padded request must not match a document heading");
    expect(padded.reason).toBe("missing");
    const trailing = resolveFindingSectionIdentity(spec, "Requirements ");
    expect(trailing.ok).toBe(false);
    if (trailing.ok) throw new Error("a trailing-space request must not match a document heading");
    expect(trailing.reason).toBe("missing");
  });

  test("heading-like lines inside fenced code are not headings", () => {
    const fenced = [
      "# Spec",
      "",
      "## Requirements",
      "",
      "Auth must reject expired tokens.",
      "",
      "```markdown",
      "## Requirements",
      "sample",
      "```",
      "",
      "~~~",
      "## Requirements",
      "tilde sample",
      "~~~",
      "",
      "## Unique",
      "",
      "After fences.",
      "",
    ].join("\n");
    const requirements = resolveFindingSectionIdentity(fenced, "Requirements");
    expect(requirements.ok).toBe(true);
    if (!requirements.ok) throw new Error("fenced duplicates must not make a unique heading ambiguous");
    expect(requirements.line).toBe(3);
    expect(requirements.body).toContain("Auth must reject expired tokens.");
    expect(requirements.body).toContain("sample");
    expect(requirements.body).toContain("tilde sample");
    expect(requirements.body).not.toContain("After fences.");
  });

  test("a longer fence does not close on a shorter inner fence", () => {
    const nested = [
      "# Spec",
      "",
      "## Requirements",
      "",
      "Auth must reject expired tokens.",
      "",
      "````",
      "```ts",
      "## Requirements",
      "console.log(1)",
      "```",
      "````",
      "",
      "## Unique",
      "",
      "After the nested fence.",
      "",
    ].join("\n");
    const requirements = resolveFindingSectionIdentity(nested, "Requirements");
    expect(requirements.ok).toBe(true);
    if (!requirements.ok) throw new Error("an inner ```ts must not close a ```` fence");
    expect(requirements.line).toBe(3);
    expect(requirements.body).toContain("console.log(1)");
    expect(requirements.body).not.toContain("After the nested fence.");
  });
});
