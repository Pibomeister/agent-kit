import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

import { verificationShapeReasons as verificationReasons } from "../../src/lifecycle/gate.ts";
import { compileSchemas } from "../../src/validation/schemas.ts";

const ROOT = join(import.meta.dir, "..", "..");
const validate = compileSchemas(ROOT).validatorFor("verification")!;
type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;
interface JsonObject {
  [key: string]: JsonValue;
}
const read = (path: string): JsonObject => JSON.parse(readFileSync(path, "utf8"));

type Path = (string | number)[];
function members(value: JsonValue, path: Path = []): Path[] {
  if (value === null || !(value instanceof Object)) return [];
  return Object.entries(value).flatMap(([key, child]) => {
    const next = [...path, Array.isArray(value) ? Number(key) : key];
    return [next, ...members(child, next)];
  });
}

function jsonObject(value: JsonValue | undefined): value is JsonObject {
  return value !== null && value !== undefined && value instanceof Object && !Array.isArray(value);
}

function at(value: JsonValue, path: Path): JsonValue {
  let current = value;
  for (const key of path) {
    const child = Array.isArray(current)
      ? current[Number(key)]
      : jsonObject(current)
        ? current[String(key)]
        : undefined;
    if (child === undefined) throw new Error(`Missing fixture member ${path.join(".")}`);
    current = child;
  }
  return current;
}

function mutated(doc: JsonObject, path: Path, mutation: string): JsonObject {
  const copy = structuredClone(doc);
  const parent = at(copy, path.slice(0, -1));
  const key = path.at(-1);
  if (key === undefined) throw new Error("mutation requires a member");
  if (mutation === "delete") {
    if (Array.isArray(parent)) parent.splice(Number(key), 1);
    else if (jsonObject(parent)) Reflect.deleteProperty(parent, key);
    else throw new Error("mutation requires a container");
  } else {
    const replacement =
      mutation === "null"
        ? null
        : mutation === "retype"
          ? Object.prototype.toString.call(at(doc, path)) === "[object String]"
            ? 7
            : "x"
          : mutation;
    if (Array.isArray(parent)) parent[Number(key)] = replacement;
    else if (jsonObject(parent)) parent[String(key)] = replacement;
    else throw new Error("mutation requires a container");
  }
  return copy;
}

// These are lifecycle policy, not JSON schema: neither may become a general parity exemption.
function predicateOnlyRules(doc: JsonObject): string[] {
  const rules: string[] = [];
  if (!("supports" in doc)) rules.push("no_criteria rejection");
  if (doc.evidence_kind === "api-response") {
    const response = doc.api_response;
    const artifacts = doc.artifacts;
    if (!jsonObject(response) || !Array.isArray(artifacts)) throw new Error("Expected schema-valid response");
    if (
      !artifacts.some(
        (artifact) => jsonObject(artifact) && artifact.kind === "response" && artifact.digest === response.body_digest,
      )
    )
      rules.push("api-response body_digest must match a response artifact");
  }
  return rules;
}

describe("the bundled verification predicate", () => {
  test("agrees with ajv across per-member corruptions, unknown members and invalid strings", () => {
    const names = [
      "verification.example.json",
      "verification.surface.example.json",
      "verification.weakened.example.json",
      "verification.zero-exit-failure.example.json",
    ];
    const examples = names.map((name) => ({ name, path: join(ROOT, "templates", name) }));
    examples.push({ name: "all-members", path: join(ROOT, "tests", "fixtures", "verification-all-members.json") });
    const disagreements: string[] = [];
    for (const { name, path } of examples) {
      const bytes = readFileSync(path);
      const hash = createHash("sha256").update(bytes).digest("hex");
      const doc = read(path);
      let compared = 0;
      const compare = (candidate: JsonObject, label: string) => {
        const schemaAccepted = validate(candidate);
        const policyReasons = schemaAccepted ? predicateOnlyRules(candidate) : [];
        const predicateAccepted = verificationReasons(candidate).length === 0;
        compared++;
        if (predicateAccepted !== (schemaAccepted && policyReasons.length === 0))
          disagreements.push(`${name} sha256:${hash} ${label}: ajv=${schemaAccepted} predicate=${predicateAccepted}`);
      };
      expect(validate(doc), `${name}: ${JSON.stringify(validate.errors)}`).toBe(true);
      compare(doc, "unchanged");
      for (const member of members(doc)) {
        for (const mutation of ["delete", "null", "retype"])
          compare(mutated(doc, member, mutation), `${mutation} ${member.join(".")}`);
        // Probe every string, including plain strings whose acceptance must not be narrowed.
        if (Object.prototype.toString.call(at(doc, member)) === "[object String]")
          for (const invalid of ["", " ", "../escape", "/absolute", "Jan 1 2026", "invalid", "a".repeat(129)])
            compare(mutated(doc, member, invalid), `string ${member.join(".")}=${JSON.stringify(invalid)}`);
      }
      for (const objectPath of [[], ...members(doc)]) {
        const value = at(doc, objectPath);
        if (value === null || !(value instanceof Object) || Array.isArray(value)) continue;
        const copy = structuredClone(doc);
        const container = at(copy, objectPath);
        if (!jsonObject(container)) throw new Error("Expected an object path");
        container.unknown_member = true;
        compare(copy, `unknown member ${objectPath.join(".")}`);
      }
      expect(compared, `${name} sha256:${hash}`).toBeGreaterThan(0);
      console.info(`parity: ${name} sha256:${hash} compared=${compared}`);
    }
    expect(disagreements).toEqual([]);
  });

  test("names the only two schema-valid predicate-only rejections", () => {
    const noCriteria = read(join(ROOT, "templates", "verification.example.json"));
    delete noCriteria.supports;
    noCriteria.no_criteria = "No criteria were supplied.";
    const mismatch = read(join(ROOT, "tests", "fixtures", "verification-all-members.json"));
    const schema = read(join(ROOT, "schemas", "verification.schema.json"));
    const common = read(join(ROOT, "schemas", "common.schema.json"));
    if (!jsonObject(schema.properties) || !jsonObject(common.$defs) || !jsonObject(common.$defs.envelope))
      throw new Error("Expected receipt and envelope property definitions");
    const envelope = common.$defs.envelope;
    if (!jsonObject(envelope.properties)) throw new Error("Expected envelope properties");
    const defined = new Set([...Object.keys(schema.properties), ...Object.keys(envelope.properties)]);
    const covered = new Set([...Object.keys(mismatch), ...Object.keys(noCriteria)]);
    expect(covered).toEqual(defined);
    mismatch.api_response = { status: 200, body_digest: `sha256:${"d".repeat(64)}` };
    for (const [doc, rule, reason] of [
      [noCriteria, "no_criteria rejection", "supports is invalid"],
      [
        mismatch,
        "api-response body_digest must match a response artifact",
        "api_response body_digest has no matching response artifact",
      ],
    ] as const) {
      expect(validate(doc), JSON.stringify(validate.errors)).toBe(true);
      expect(predicateOnlyRules(doc)).toEqual([rule]);
      expect(verificationReasons(doc)).toContain(reason);
    }
  });

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
      expect(verificationReasons(receipt).length === 0, JSON.stringify(receipt)).toBe(validate(receipt));
    }
  });
});
