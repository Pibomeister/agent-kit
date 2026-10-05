import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { compileSchemas } from "../src/validation/schemas.ts";
import projectTemplate from "../templates/project.example.json" with { type: "json" };
import recipeTemplate from "../templates/verification-recipe.example.json" with { type: "json" };
import ticketTemplate from "../templates/ticket.example.json" with { type: "json" };
import receiptTemplate from "../templates/verification.example.json" with { type: "json" };

const ROOT = join(import.meta.dir, "..");
const schemas = compileSchemas(ROOT);

const hash = (character: string): string => `sha256:${character.repeat(64)}`;

describe("verification recipe and surface evidence schemas", () => {
  test("accepts a project facility, ticket requirement, verifier receipt and recipe artifact", () => {
    const project = {
      ...structuredClone(projectTemplate),
      verification_recipes: [
        {
          id: "settings-runtime",
          hash: hash("a"),
          scope: ["app/settings/**"],
          surfaces: ["frontend"],
          evidence_kinds: ["rendered-screenshot", "user-path-trial", "log"],
          environment: "test",
          steps: {
            setup: [],
            build: [{ kind: "command", argv: ["bun", "run", "build"] }],
            launch: [{ kind: "command", argv: ["bun", "run", "start"] }],
            readiness: [{ kind: "probe", name: "health", target: "http://127.0.0.1:3000/health" }],
            drive: [{ kind: "probe", name: "settings", target: "http://127.0.0.1:3000/settings" }],
            cleanup: [{ kind: "command", argv: ["bun", "run", "stop"] }],
          },
        },
      ],
    };

    const ticket = {
      ...structuredClone(ticketTemplate),
      acceptance_criteria: [{ id: "AC-1", text: "Settings render for an authenticated user.", surface: "frontend" }],
      verification: [
        {
          id: "settings-runtime",
          check: "Drive the settings path.",
          kind: "probe",
          supports: ["AC-1"],
          recipe: { id: "settings-runtime", hash: hash("a") },
          evidence_required: ["rendered-screenshot", "user-path-trial"],
        },
      ],
    };

    const receipt = {
      ...structuredClone(receiptTemplate),
      created_by: { role: "verifier" },
      recipe: { id: "settings-runtime", hash: hash("a") },
      evidence_kind: "rendered-screenshot",
      verifier_seat: {
        id: "verify-1",
        implementer_seat: "build-1",
        isolation: "runner-attested",
        attestation: { id: "seat-verify-1", hash: hash("b") },
      },
      artifacts: [
        ...structuredClone(receiptTemplate.artifacts),
        { path: "settings.png", digest: hash("c"), kind: "screenshot" },
      ],
    };

    const recipe = structuredClone(recipeTemplate);

    expect(schemas.validatorFor("project")?.(project)).toBe(true);
    expect(schemas.validatorFor("ticket")?.(ticket)).toBe(true);
    expect(schemas.validatorFor("verification")?.(receipt)).toBe(true);
    expect(schemas.validatorFor("verification-recipe")?.(recipe)).toBe(true);
  });

  test("rejects an unknown evidence kind and an API response without status and body digest", () => {
    const validate = schemas.validatorFor("verification");
    const surface = {
      ...structuredClone(receiptTemplate),
      created_by: { role: "verifier" },
      recipe: { id: "settings-runtime", hash: hash("a") },
      verifier_seat: {
        id: "verify-1",
        implementer_seat: "build-1",
        isolation: "runner-attested",
        attestation: { id: "seat-verify-1", hash: hash("b") },
      },
    };
    expect(validate?.({ ...surface, evidence_kind: "log" })).toBe(true);
    expect(validate?.({ ...surface, evidence_kind: "screen-video" })).toBe(false);

    const api = {
      ...surface,
      evidence_kind: "api-response",
      artifacts: [
        ...structuredClone(receiptTemplate.artifacts),
        { path: "response.json", digest: hash("c"), kind: "response" },
      ],
    };
    expect(validate?.({ ...api, api_response: { status: 200, body_digest: hash("c") } })).toBe(true);
    expect(validate?.({ ...api, api_response: { body_digest: hash("c") } })).toBe(false);
    expect(validate?.({ ...api, api_response: { status: 200 } })).toBe(false);
  });

  test("rejects a frontend ticket that requests no declared evidence kind", () => {
    const ticket = {
      ...structuredClone(ticketTemplate),
      acceptance_criteria: [{ id: "AC-1", text: "Settings render for an authenticated user.", surface: "frontend" }],
      verification: [
        {
          id: "settings-runtime",
          check: "Drive the settings path.",
          kind: "probe",
          supports: ["AC-1"],
          recipe: { id: "settings-runtime", hash: hash("a") },
          evidence_required: [],
        },
      ],
    };
    expect(schemas.validatorFor("ticket")?.(ticket)).toBe(false);
  });
});
