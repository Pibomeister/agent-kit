import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { loadCatalog } from "../src/catalog/load.ts";
import { checkDocument, indexDocuments } from "../src/validation/docrules.ts";
import { checkSchemas } from "../src/validation/schemas.ts";
import { makeTree } from "./helpers/tree.ts";

type Receipt = Record<string, unknown>;

const ROOT = join(import.meta.dir, "..");
const FIXTURES = join(import.meta.dir, "fixtures", "verification-zero-exit");
const SCHEMAS = join(ROOT, "schemas");

function readJson(path: string): Receipt {
  return JSON.parse(readFileSync(path, "utf8")) as Receipt;
}

function fixture(name: string): Receipt {
  return readJson(join(FIXTURES, name));
}

function withDisagreement(receipt: Receipt, outputReports = "2 fail"): Receipt {
  return {
    ...receipt,
    exit_disagreement: { verdict_from: "output", output_reports: outputReports },
  };
}

function validationContext(receipt: Receipt) {
  const schemaFiles: Record<string, string> = {};
  const schemaNames = readdirSync(SCHEMAS).filter((name) => name.endsWith(".schema.json"));
  for (const name of schemaNames) {
    schemaFiles[`schemas/${name}`] = readFileSync(join(SCHEMAS, name), "utf8");
  }
  const root = makeTree({
    "catalog.yaml": [
      "schema_version: 1",
      "package:",
      "  id: ak",
      "  name: agent-kit",
      "  version: 0.1.0",
      '  namespace: "/ak:"',
      "  default_profile: core",
      "schemas:",
      ...schemaNames.map((name) => `  - id: ${name.replace(".schema.json", "")}\n    status: authored`),
      "",
    ].join("\n"),
    ...schemaFiles,
    "templates/verification.json": JSON.stringify(receipt),
  });
  const { catalog } = loadCatalog(root);
  if (catalog === null) throw new Error("verification fixture catalog did not load");
  return { root, catalog };
}

function akValidateAccepts(receipt: Receipt): boolean {
  const issues = checkSchemas(validationContext(receipt));
  return !issues.some((issue) => issue.file === "templates/verification.json" && issue.severity === "error");
}

function checkDocumentAccepts(receipt: Receipt, others: Receipt[] = []): boolean {
  const documents = [
    { file: "templates/verification.json", doc: receipt },
    ...others.map((doc, index) => ({ file: `templates/other-${index}.json`, doc })),
  ];
  return checkDocument("templates/verification.json", receipt, indexDocuments(documents)).length === 0;
}

function expectVerdict(receipt: Receipt, valid: boolean, others: Receipt[] = []): void {
  expect(akValidateAccepts(receipt)).toBe(valid);
  expect(checkDocumentAccepts(receipt, others)).toBe(valid);
}

describe("verification exit disagreement", () => {
  const truthful = fixture("receipt.truthful.json");

  test("accepts the truthful zero-exit failure only when output establishes the disagreement", () => {
    expectVerdict(withDisagreement(truthful), true);
    expectVerdict(truthful, false);
  });

  test("rejects exit_disagreement outside its one truthful shape", () => {
    expect(akValidateAccepts(withDisagreement({ ...truthful, status: "passed" }))).toBe(false);
    expect(akValidateAccepts(withDisagreement({ ...truthful, exit_status: 1 }))).toBe(false);
    expect(akValidateAccepts(withDisagreement(truthful, "   "))).toBe(false);
  });

  test("still rejects a failed command receipt that omits the observed exit", () => {
    expectVerdict(fixture("variant.exit-omitted.json"), false);
  });

  test("keeps the four dishonest forms valid as a known limit of this representational slice", () => {
    // This slice makes the truth representable. Detecting a fabricated exit,
    // verdict, certainty, or kind needs trusted run evidence and remains later work.
    for (const name of [
      "variant.invented-exit.json",
      "variant.manufactured-green.json",
      "variant.inconclusive.json",
      "variant.recast-as-probe.json",
    ]) {
      expectVerdict(fixture(name), true);
    }
  });

  test("keeps both shipped verification templates valid with an optional instrument id", () => {
    const decision = readJson(join(ROOT, "templates", "decision.weakening.example.json"));
    expectVerdict(readJson(join(ROOT, "templates", "verification.example.json")), true);
    expectVerdict(readJson(join(ROOT, "templates", "verification.weakened.example.json")), true, [decision]);
  });
});
