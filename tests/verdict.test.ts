import { describe, expect, test } from "bun:test";

import { parseVerdict } from "../src/verdict.ts";

describe("parseVerdict", () => {
  test("an out-of-enum choice is echoed bounded, without raw newlines", () => {
    const value = `MAYBE\n${"x".repeat(200)}`;
    const parsed = parseVerdict(JSON.stringify({ choice: value, rationale: "r" }), "choice", ["WORTHY", "REJECT"]);
    expect(parsed.status).toBe("closed");
    if (parsed.status !== "closed") return;
    expect(parsed.reason).toContain("is not in the enum");
    expect(parsed.reason).not.toContain("\n");
    expect(parsed.reason).not.toContain(value);
    expect(parsed.reason).toContain(JSON.stringify(value).slice(0, 64));
    expect(parsed.reason.length).toBeLessThanOrEqual("choice ".length + 64 + " is not in the enum".length);
  });
});
