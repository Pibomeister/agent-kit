import { expect } from "bun:test";

import type { Issue } from "../../src/validation/types.ts";

/**
 * Asserts the rule fired as an error with the given message fragment, and returns that issue. `report()`
 * exits non-zero on errors only, so a test that checks the rule id alone still passes when the issue is
 * downgraded to a warning and the gate stops gating.
 */
export function expectError(issues: readonly Issue[], rule: string, messageFragment: string): Issue {
  const matching = issues.filter((issue) => issue.rule === rule);
  expect(matching.map((issue) => issue.rule)).toContain(rule);
  for (const issue of matching) expect(issue.severity).toBe("error");
  const issue = matching.find((candidate) => candidate.message.includes(messageFragment));
  expect(issue?.message ?? matching.map((candidate) => candidate.message).join("\n")).toContain(messageFragment);
  if (issue === undefined) throw new Error(`no ${rule} issue carries "${messageFragment}"`);
  return issue;
}
