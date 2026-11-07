import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { compileSchemas } from "../src/validation/schemas.ts";
import { checkDocument, indexDocuments } from "../src/validation/docrules.ts";
import { checkRunArtifact } from "../src/kb/artifacts.ts";
import { parseJson, type JsonValue } from "./helpers/json.ts";

const ROOT = join(import.meta.dir, "..");
const set = compileSchemas(ROOT);
const validate = set.validatorFor("behavior-contract");
const validateTicket = set.validatorFor("ticket");
if (validate === undefined || validateTicket === undefined)
  throw new Error("behavior-contract schemas did not compile");

function example(name: string): JsonValue {
  return parseJson(readFileSync(join(ROOT, "templates", name), "utf8"));
}

function asObject(value: JsonValue): { [key: string]: JsonValue } {
  if (value instanceof Object && !Array.isArray(value)) return value;
  throw new Error("expected an object fixture");
}

const contract = asObject(example("behavior-contract.example.json"));
const ticket = asObject(example("ticket.example.json"));

function issuesOf(doc: JsonValue): string[] {
  const record = asObject(doc);
  return checkDocument(
    "templates/behavior-contract.example.json",
    record,
    indexDocuments([{ file: "doc.json", doc: record }]),
  ).map((issue) => `${issue.rule}: ${issue.message}`);
}

function requirementList(): JsonValue[] {
  const requirements = contract["requirements"];
  if (!Array.isArray(requirements) || requirements.length < 2) throw new Error("expected requirements");
  return requirements;
}

function requirementAt(index: number): { [key: string]: JsonValue } {
  const row = requirementList()[index];
  if (row === undefined) throw new Error(`expected requirement ${String(index)}`);
  return asObject(row);
}

function withRequirement(index: number, patch: { [key: string]: JsonValue }): JsonValue {
  const next = requirementList().map((item, i) => (i === index ? { ...requirementAt(index), ...patch } : item));
  return { ...contract, requirements: next };
}

describe("behavior-contract schema", () => {
  test("the shipped example is valid and publishable", () => {
    expect(validate(contract)).toBe(true);
    expect(checkRunArtifact(JSON.stringify(contract)).problem).toBe("");
  });

  test("an accepted requirement without sources is rejected", () => {
    const stripped = withRequirement(0, { sources: [] });
    expect(validate(stripped)).toBe(false);
    expect(
      issuesOf(stripped).some((line) => line.includes("behavior-contract.accepted-intent-requires-accepted-source")),
    ).toBe(true);
  });

  test("intent observed is not a requirement class", () => {
    expect(validate(withRequirement(0, { intent: "observed" }))).toBe(false);
  });

  test("an unknown intent class cannot become a verified requirement", () => {
    expect(validate(withRequirement(0, { intent: "verified" }))).toBe(false);
  });

  test("accepted intent needs a source of accepted kind", () => {
    const mutated = withRequirement(0, { sources: [{ kind: "observation", ref: "src/loader.ts" }] });
    expect(
      issuesOf(mutated).some((line) => line.includes("behavior-contract.accepted-intent-requires-accepted-source")),
    ).toBe(true);
  });

  test("a property supported only by proposed intent is refused", () => {
    const proposedOnly = {
      ...contract,
      properties: [
        {
          id: "retry-is-required",
          statement: "Retries twice.",
          kind: "safety",
          requirement_ids: ["retry-twice"],
        },
      ],
    };
    const messages = issuesOf(proposedOnly);
    expect(messages.some((line) => line.includes("behavior-contract.proposed-intent-cannot-discharge-accepted"))).toBe(
      true,
    );
    expect(validate(proposedOnly)).toBe(true);
    expect(checkRunArtifact(JSON.stringify(proposedOnly)).problem).toContain(
      "behavior-contract.proposed-intent-cannot-discharge-accepted",
    );
  });

  test("a property citing a requirement that is not on the contract is refused at admission", () => {
    const missing = {
      ...contract,
      properties: [
        {
          id: "ghost-property",
          statement: "Cites a requirement this contract does not carry.",
          kind: "safety",
          requirement_ids: ["not-a-requirement"],
        },
      ],
    };
    expect(validate(missing)).toBe(true);
    expect(checkRunArtifact(JSON.stringify(missing)).problem).toContain(
      "behavior-contract.proposed-intent-cannot-discharge-accepted",
    );
  });

  test("the shipped example keeps observed notes out of accepted requirements", () => {
    const observed = contract["observed_behavior"];
    if (!Array.isArray(observed)) throw new Error("expected observed_behavior");
    expect(requirementList().every((row) => asObject(row)["intent"] !== "observed")).toBe(true);
    expect(observed.length).toBeGreaterThan(0);
    expect(issuesOf(contract)).toEqual([]);
  });
});

describe("ticket optional behavior fields", () => {
  test("the shipped ticket example stays valid without behavior fields", () => {
    expect("behavior_contracts" in ticket).toBe(false);
    expect("behavior_applicability" in ticket).toBe(false);
    expect(validateTicket(ticket)).toBe(true);
  });

  test("a ticket may name a contract and a check-level behavior binding", () => {
    const verification = ticket["verification"];
    if (!Array.isArray(verification)) throw new Error("expected verification");
    const first = verification[0];
    if (first === undefined) throw new Error("expected a verification check");
    const check = asObject(first);
    const HASH = `sha256:${"a".repeat(64)}`;
    expect(
      validateTicket({
        ...ticket,
        behavior_applicability: "eligible",
        behavior_contracts: [{ id: "example-behavior-contract-1", schema: "behavior-contract", hash: HASH }],
        verification: [
          {
            ...check,
            behavior: {
              evidence_layer: "implementation",
              property_ids: ["every-configured-directory-is-read"],
              property_types: { "every-configured-directory-is-read": "safety" },
              contract: { id: "example-behavior-contract-1", schema: "behavior-contract", hash: HASH },
            },
          },
        ],
      }),
    ).toBe(true);
  });
});
