import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { compileSchemas } from "../src/validation/schemas.ts";
import { checkDocument, indexDocuments } from "../src/validation/docrules.ts";
import { checkRunArtifact } from "../src/kb/artifacts.ts";
import type { ResolvedKb } from "../src/kb/binding.ts";
import { git } from "../src/kb/git.ts";
import { publishRunArtifact } from "../src/kb/local-git.ts";
import { artifactHash } from "../src/util/hash.ts";
import { parseJson, type JsonValue } from "./helpers/json.ts";
import { processScratch } from "./helpers/process-tmp.ts";

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

function issuesOf(doc: JsonValue, extra: JsonValue[] = [ticket]): string[] {
  const record = asObject(doc);
  return checkDocument(
    "templates/behavior-contract.example.json",
    record,
    indexDocuments([
      { file: "doc.json", doc: record },
      ...extra.map((item, i) => ({ file: `extra-${i}.json`, doc: asObject(item) })),
    ]),
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
    expect(checkRunArtifact(JSON.stringify(contract)).problem).toContain("not resolved at admission");
    expect(
      checkRunArtifact(JSON.stringify(contract), (id) =>
        id === "example-ticket-1" ? { schema: "ticket", id, doc: asObject(ticket) } : undefined,
      ).problem,
    ).toBe("");
    expect(issuesOf(contract)).toEqual([]);
  });

  test("an accepted source that names no document is refused", () => {
    const ghost = withRequirement(0, { sources: [{ kind: "decision", ref: "nonexistent" }] });
    expect(issuesOf(ghost).some((line) => line.includes("accepted source nonexistent is unknown"))).toBe(true);
    expect(checkRunArtifact(JSON.stringify(ghost)).problem).toContain("not resolved at admission");
  });

  test("a proposed or unruled decision cannot back accepted intent", () => {
    const openDecision = {
      schema: "decision",
      id: "open-decision",
      status: "open",
      ruling: { outcome: "blocked" },
    };
    const citing = withRequirement(0, {
      sources: [{ kind: "decision", ref: "open-decision", hash: artifactHash(openDecision) }],
    });
    expect(issuesOf(citing, [openDecision]).some((line) => line.includes("is not an accepted source"))).toBe(true);
  });

  test("a hash-mismatched accepted source is refused", () => {
    const citing = withRequirement(0, {
      sources: [
        {
          kind: "ticket",
          ref: "example-ticket-1",
          hash: `sha256:${"b".repeat(64)}`,
        },
      ],
    });
    expect(issuesOf(citing).some((line) => line.includes("does not match"))).toBe(true);
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

  test("user-instruction cannot launder a verification receipt into accepted intent", () => {
    const verification = asObject(example("verification.example.json"));
    const citing = withRequirement(0, {
      sources: [{ kind: "user-instruction", ref: "example-verification-1", hash: artifactHash(verification) }],
    });
    expect(issuesOf(citing, [verification]).some((line) => line.includes("is not an accepted source"))).toBe(true);
    expect(
      checkRunArtifact(JSON.stringify(citing), (id) =>
        id === "example-verification-1" ? { schema: "verification", id, doc: verification } : undefined,
      ).problem,
    ).toContain("is not an accepted source");
  });

  test("user-instruction accepted intent resolves an approved ticket", () => {
    const citing = withRequirement(0, {
      sources: [{ kind: "user-instruction", ref: "example-ticket-1", hash: artifactHash(ticket) }],
    });
    expect(issuesOf(citing)).toEqual([]);
    expect(
      checkRunArtifact(JSON.stringify(citing), (id) =>
        id === "example-ticket-1" ? { schema: "ticket", id, doc: asObject(ticket) } : undefined,
      ).problem,
    ).toBe("");
  });

  test("an approved ticket without a human approval bound to its hash cannot back accepted intent", () => {
    const unsigned = { ...asObject(ticket), approvals: [] };
    const citing = withRequirement(0, {
      sources: [{ kind: "ticket", ref: "example-ticket-1", hash: artifactHash(unsigned) }],
    });
    expect(issuesOf(citing, [unsigned]).some((line) => line.includes("is not an accepted source"))).toBe(true);
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
    expect(
      checkRunArtifact(JSON.stringify(proposedOnly), (id) =>
        id === "example-ticket-1" ? { schema: "ticket", id, doc: asObject(ticket) } : undefined,
      ).problem,
    ).toContain("behavior-contract.proposed-intent-cannot-discharge-accepted");
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
    expect(
      checkRunArtifact(JSON.stringify(missing), (id) =>
        id === "example-ticket-1" ? { schema: "ticket", id, doc: asObject(ticket) } : undefined,
      ).problem,
    ).toContain("behavior-contract.proposed-intent-cannot-discharge-accepted");
  });

  test("KB admission refuses an unresolved accepted source and accepts a genuine one", () => {
    const root = processScratch("ak-bv-intent-kb-");
    expect(git(root, ["init", "-q", "-b", "main"]).status).toBe(0);
    expect(git(root, ["config", "user.name", "fixture"]).status).toBe(0);
    expect(git(root, ["config", "user.email", "fixture@example.invalid"]).status).toBe(0);
    expect(git(root, ["config", "commit.gpgsign", "false"]).status).toBe(0);
    mkdirSync(join(root, "projects", "example-project", "runs"), { recursive: true });
    const kb: ResolvedKb = {
      root,
      knowledgebase: "fixture-kb",
      binding: { backend: "local-git", project: "example-project", locator: { knowledgebase: "fixture-kb" } },
    };
    const ghost = withRequirement(0, { sources: [{ kind: "decision", ref: "nonexistent" }] });
    const refused = publishRunArtifact(kb, JSON.stringify(ghost), "example-run-1", []);
    expect(refused).toMatchObject({ status: "refused", code: "kb.artifact-invalid" });
    expect(JSON.stringify(refused)).toContain("accepted source nonexistent is unknown");
    expect(publishRunArtifact(kb, JSON.stringify(ticket), "example-run-1", [])).toMatchObject({
      status: "complete",
      effect: "published",
    });
    expect(publishRunArtifact(kb, JSON.stringify(contract), "example-run-1", [])).toMatchObject({
      status: "complete",
      effect: "published",
    });
  });

  test("a requirements source cannot cite this contract or a cycle", () => {
    const self = withRequirement(0, {
      sources: [{ kind: "requirements", ref: "example-behavior-contract-1", hash: artifactHash(contract) }],
    });
    expect(issuesOf(self).some((line) => line.includes("is not an accepted source"))).toBe(true);
    const peer = {
      ...contract,
      id: "peer-contract",
      requirements: [
        {
          ...requirementAt(0),
          sources: [{ kind: "requirements", ref: "example-behavior-contract-1", hash: artifactHash(contract) }],
        },
        requirementAt(1),
      ],
    };
    const cyclic = withRequirement(0, {
      sources: [{ kind: "requirements", ref: "peer-contract", hash: artifactHash(peer) }],
    });
    expect(issuesOf(cyclic, [peer]).some((line) => line.includes("is not an accepted source"))).toBe(true);
  });

  test("a requirements source needs an immutable hash and an accepted row", () => {
    const peer = {
      ...contract,
      id: "peer-contract",
    };
    const noHash = withRequirement(0, { sources: [{ kind: "requirements", ref: "peer-contract" }] });
    expect(issuesOf(noHash, [peer]).some((line) => line.includes("needs an immutable hash"))).toBe(true);
    const proposedPeer = {
      ...contract,
      id: "proposed-peer",
      requirements: [{ ...requirementAt(0), intent: "proposed", sources: [] }, requirementAt(1)],
    };
    const citingProposed = withRequirement(0, {
      sources: [{ kind: "requirements", ref: "proposed-peer", hash: artifactHash(proposedPeer) }],
    });
    expect(issuesOf(citingProposed, [proposedPeer]).some((line) => line.includes("is not an accepted source"))).toBe(
      true,
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
