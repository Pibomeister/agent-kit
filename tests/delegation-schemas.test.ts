import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import classOutside from "./fixtures/delegation/invalid/class-outside-enum.json" with { type: "json" };
import factorWithoutEvidence from "./fixtures/delegation/invalid/factor-without-evidence.json" with { type: "json" };
import loweredWithoutHuman from "./fixtures/delegation/invalid/lowered-without-human-or-reason.json" with { type: "json" };
import readinessAboveTwo from "./fixtures/delegation/invalid/readiness-above-two.json" with { type: "json" };
import project from "./fixtures/delegation/valid.project.json" with { type: "json" };
import ticket from "./fixtures/delegation/valid.ticket.json" with { type: "json" };
import { DENY_TERMS, matchTerms } from "../src/denylist.ts";
import { compileSchemas } from "../src/validation/schemas.ts";

const ROOT = join(import.meta.dir, "..");
const FIXTURES = join(import.meta.dir, "fixtures", "delegation");
const schemas = compileSchemas(ROOT);
const validateTicket = schemas.validatorFor("ticket");
const validateProject = schemas.validatorFor("project");
if (validateTicket === undefined || validateProject === undefined)
  throw new Error("delegation schemas did not compile");

describe("delegation schema records", () => {
  test("the valid fixtures exercise every new ticket and project block", () => {
    expect(validateTicket(ticket)).toBe(true);
    expect(validateProject(project)).toBe(true);
  });

  test("a class outside the enum is rejected", () => {
    expect(validateTicket({ ...ticket, delegation: { ...ticket.delegation, ...classOutside.delegation } })).toBe(false);
  });

  test("a lowering without a named human and reason is rejected", () => {
    expect(validateTicket({ ...ticket, delegation: { ...ticket.delegation, ...loweredWithoutHuman.delegation } })).toBe(
      false,
    );
  });

  test("a readiness score above two is rejected", () => {
    expect(validateTicket({ ...ticket, readiness: { ...ticket.readiness, ...readinessAboveTwo.readiness } })).toBe(
      false,
    );
  });

  test("a factor without evidence is rejected", () => {
    expect(
      validateTicket({
        ...ticket,
        delegation: {
          ...ticket.delegation,
          factors: { ...ticket.delegation.factors, ...factorWithoutEvidence.delegation.factors },
        },
      }),
    ).toBe(false);
  });

  test("the forbidden tier key is caught by the denylist", () => {
    const text = readFileSync(join(import.meta.dir, "data", "delegation", "tier-key.yaml"), "utf8");
    expect(matchTerms(text, DENY_TERMS).map((hit) => hit.term.id)).toContain("ladder-tier-assignment");
  });

  test("every fixture directory entry is covered", () => {
    expect(readdirSync(join(FIXTURES, "invalid")).toSorted()).toEqual([
      "class-outside-enum.json",
      "factor-without-evidence.json",
      "lowered-without-human-or-reason.json",
      "readiness-above-two.json",
    ]);
  });
});
