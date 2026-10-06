import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { verificationShapeReasons as reasonsOf } from "../../src/lifecycle/gate.ts";
import { compileSchemas } from "../../src/validation/schemas.ts";
import { edited, parseJson, pathsOf } from "../helpers/json.ts";

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
      "verification.surface.example.json",
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
      expect(reasonsOf(receipt).length === 0, JSON.stringify(receipt)).toBe(validate(receipt) as boolean);
    }
  });

  // Known divergences on main: the predicate accepts these and ajv rejects them. Each is an optional or
  // nested metadata member the gate's refusals do not read. Reported as a product bug (Firstmate,
  // 2026-10-06, ak-test-hardening predicate-divergence); fixing it in src/lifecycle/gate.ts makes this
  // test fail until the fixed entries are removed, and any new divergence fails it too.
  const KNOWN_DIVERGENCES = [
    "delete environment.toolchain.0.name",
    "delete environment.toolchain.0.version",
    "delete weakened_checks.0.decision",
    "delete weakened_checks.0.decision.hash",
    "delete weakened_checks.0.decision.id",
    "delete weakened_checks.0.what",
    "null command.cwd",
    "null command.duration_ms",
    "null command.started_at",
    "null created_by.operation",
    "null created_by.skill",
    "null environment.config_digest",
    "null environment.image_digest",
    "null environment.toolchain",
    "null environment.toolchain.0",
    "null environment.toolchain.0.name",
    "null environment.toolchain.0.version",
    "null finding.schema",
    "null notes",
    "null output_excerpt",
    "null probe.observed",
    "null project.repo",
    "null recipe.schema",
    "null ticket.schema",
    "null weakened_checks",
    "null weakened_checks.0",
    "null weakened_checks.0.decision",
    "null weakened_checks.0.decision.hash",
    "null weakened_checks.0.decision.id",
    "null weakened_checks.0.decision.schema",
    "null weakened_checks.0.detail",
    "null weakened_checks.0.what",
    "retype command.cwd",
    "retype command.duration_ms",
    "retype command.started_at",
    "retype created_by.operation",
    "retype created_by.skill",
    "retype environment.config_digest",
    "retype environment.image_digest",
    "retype environment.toolchain",
    "retype environment.toolchain.0",
    "retype environment.toolchain.0.name",
    "retype environment.toolchain.0.version",
    "retype finding.schema",
    "retype notes",
    "retype output_excerpt",
    "retype probe.observed",
    "retype project.repo",
    "retype recipe.schema",
    "retype ticket.schema",
    "retype weakened_checks",
    "retype weakened_checks.0",
    "retype weakened_checks.0.decision",
    "retype weakened_checks.0.decision.hash",
    "retype weakened_checks.0.decision.id",
    "retype weakened_checks.0.decision.schema",
    "retype weakened_checks.0.detail",
    "retype weakened_checks.0.what",
  ];

  test("agrees with ajv when any one member, top-level or nested, is deleted, nulled or retyped", () => {
    const base = [
      "verification.example.json",
      "verification.surface.example.json",
      "verification.weakened.example.json",
      "verification.zero-exit-failure.example.json",
    ].map((name) => parseJson(readFileSync(join(ROOT, "templates", name), "utf8")));
    let compared = 0;
    let rejected = 0;
    const divergent = new Set<string>();
    for (const doc of base) {
      expect(validate(doc)).toBe(true);
      for (const path of pathsOf(doc, [])) {
        for (const how of ["delete", "null", "retype"] as const) {
          const receipt = edited(doc, path, how);
          const ajv = validate(receipt);
          if ((reasonsOf(receipt).length === 0) !== ajv) divergent.add(`${how} ${path.join(".")}`);
          compared += 1;
          if (!ajv) rejected += 1;
        }
      }
    }
    expect([...divergent].toSorted()).toEqual([...KNOWN_DIVERGENCES].toSorted());
    // The sweep must reach the predicate's reasons: most single corruptions are invalid.
    expect(compared).toBeGreaterThan(600);
    expect(rejected).toBeGreaterThan(compared / 2);
  });
});
