import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { verificationShapeReasons } from "../../src/lifecycle/gate.ts";
import { compileSchemas } from "../../src/validation/schemas.ts";

const ROOT = join(import.meta.dir, "..", "..");
const validate = compileSchemas(ROOT).validatorFor("verification")!;
const read = (path: string): Record<string, unknown> => JSON.parse(readFileSync(path, "utf8"));

describe("the bundled verification predicate", () => {
  test("agrees with ajv over every receipt fixture and representative malformed shapes", () => {
    const fixtureDir = join(ROOT, "tests", "fixtures", "verification-zero-exit");
    const fixtures = readdirSync(fixtureDir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => read(join(fixtureDir, name)));
    const templates = [
      "verification.example.json",
      "verification.weakened.example.json",
      "verification.zero-exit-failure.example.json",
    ].map((name) => read(join(ROOT, "templates", name)));
    const valid = structuredClone(templates[0]!);
    const surface = structuredClone(valid);
    surface.created_by = { role: "verifier" };
    surface.recipe = { id: "settings-runtime", hash: `sha256:${"a".repeat(64)}` };
    surface.evidence_kind = "rendered-screenshot";
    surface.verifier_seat = {
      id: "verify-1",
      implementer_seat: "build-1",
      isolation: "runner-attested",
      attestation: { id: "seat-verify-1", hash: `sha256:${"b".repeat(64)}` },
    };
    surface.artifacts = [{ path: "settings.png", digest: `sha256:${"c".repeat(64)}`, kind: "screenshot" }];
    const without = (key: string) => {
      const doc = structuredClone(valid);
      delete doc[key];
      return doc;
    };
    const malformed = [
      without("kind"),
      { ...structuredClone(valid), status: "green" },
      { ...structuredClone(valid), check: "Not Kebab" },
      { ...structuredClone(valid), invented: true },
      { ...structuredClone(valid), command: { argv: [] } },
      { ...structuredClone(valid), exit_status: 1 },
      { ...structuredClone(valid), status: "failed", exit_status: 0 },
      { ...structuredClone(valid), status: "not-run", reason: "not available" },
      { ...structuredClone(valid), environment: { id: "Not Kebab", isolated: true, secrets_policy: "none" } },
      { ...structuredClone(valid), ticket: { id: "ticket-1", hash: "not-a-hash" } },
    ];

    for (const receipt of [...fixtures, ...templates, surface, ...malformed]) {
      expect(verificationShapeReasons(receipt).length === 0, JSON.stringify(receipt)).toBe(
        validate(receipt) as boolean,
      );
    }
  });
});
