import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { loadCatalog } from "../src/catalog/load.ts";
import {
  SCHEMA_RULE_IMPLEMENTATIONS,
  checkSchemaRuleCoverage,
  collectValidatorRules,
  isPending,
} from "../src/validation/rulemap.ts";
import { makeTree } from "./helpers/tree.ts";

const REPO = join(import.meta.dir, "..");

const CATALOG = `schema_version: 1
package:
  id: ak
  name: agent-kit
  version: 0.1.0
  namespace: "/ak:"
  default_profile: core
`;

function ctxFor(files: Record<string, string>) {
  const root = makeTree({ "catalog.yaml": CATALOG, ...files });
  const { catalog } = loadCatalog(root);
  if (catalog === null) throw new Error("fixture has no catalog");
  return { root, catalog };
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (full.endsWith(".ts")) out.push(full);
  }
  return out;
}

describe("x-validator-rule coverage", () => {
  test("an unimplemented rule is a reported failure, not a silent pass", () => {
    const ctx = ctxFor({
      "schemas/thing.schema.json": JSON.stringify({
        $id: "thing.schema.json",
        type: "object",
        properties: { a: { type: "string", "x-validator-rule": "thing.nobody-implemented-this" } },
      }),
    });
    const issues = checkSchemaRuleCoverage(ctx);
    const issue = issues.find((i) => i.rule === "schemas.unimplemented-validator-rule");
    expect(issue?.severity).toBe("error");
    expect(issue?.file).toBe("schemas/thing.schema.json");
    expect(issue?.message).toContain("thing.nobody-implemented-this");
  });

  test("an implemented rule passes", () => {
    const ctx = ctxFor({
      "schemas/thing.schema.json": JSON.stringify({
        $id: "thing.schema.json",
        type: "object",
        properties: { a: { type: "string", "x-validator-rule": "finding.synthesis-may-only-worsen-a-grade" } },
      }),
    });
    expect(checkSchemaRuleCoverage(ctx).filter((i) => i.severity !== "note")).toEqual([]);
  });

  test("an absent schemas directory is a note, not a crash", () => {
    const issues = checkSchemaRuleCoverage(ctxFor({}));
    expect(issues.map((i) => i.severity)).toEqual(["note"]);
  });

  test("a rule nested in $defs, allOf or an array is still found", () => {
    const rules = collectValidatorRules(
      {
        $defs: { a: { "x-validator-rule": "one" } },
        allOf: [{ properties: { b: { "x-validator-rule": "two" } } }],
        items: [{ "x-validator-rule": "three" }],
      },
      new Set<string>(),
    );
    expect([...rules].sort()).toEqual(["one", "three", "two"]);
  });
});

describe("the map is a receipt, not a wish", () => {
  test("every rule id the map claims is emitted somewhere in src/", () => {
    const source = sourceFiles(join(REPO, "src"))
      .filter((f) => !f.endsWith("rulemap.ts"))
      .map((f) => readFileSync(f, "utf8"))
      .join("\n");
    const missing: string[] = [];
    for (const [schemaRule, emitted] of Object.entries(SCHEMA_RULE_IMPLEMENTATIONS)) {
      if (isPending(emitted)) continue;
      for (const id of emitted) if (!source.includes(`"${id}"`)) missing.push(`${schemaRule} -> ${id}`);
    }
    expect(missing).toEqual([]);
  });

  test("every x-validator-rule in this repository's schemas is mapped", () => {
    const { catalog } = loadCatalog(REPO);
    expect(catalog).not.toBeNull();
    if (catalog === null) return;
    expect(checkSchemaRuleCoverage({ root: REPO, catalog }).filter((i) => i.severity === "error")).toEqual([]);
  });
});

describe("a pending rule is declared, not missing", () => {
  test("a declared-pending rule is a warning naming its reason, not silence and not an error", () => {
    // Nothing in the registry is pending today, so the test registers one for its own duration.
    const pendingRule = "thing.pending-for-this-test";
    expect(SCHEMA_RULE_IMPLEMENTATIONS[pendingRule]).toBeUndefined();
    expect(
      Reflect.set(SCHEMA_RULE_IMPLEMENTATIONS, pendingRule, {
        status: "not-implemented",
        reason: "waits on the thing checker",
      }),
    ).toBe(true);
    try {
      const registered = SCHEMA_RULE_IMPLEMENTATIONS[pendingRule];
      expect(registered !== undefined && isPending(registered)).toBe(true);
      const pendingCtx = ctxFor({
        "schemas/thing.schema.json": JSON.stringify({
          $id: "thing.schema.json",
          type: "object",
          properties: { a: { type: "string", "x-validator-rule": [pendingRule, "review.third-fix-cycle-stops"] } },
        }),
      });
      const pendingIssues = checkSchemaRuleCoverage(pendingCtx);
      expect(pendingIssues.filter((i) => i.rule === "schemas.validator-rule-pending")).toEqual([
        {
          severity: "warning",
          rule: "schemas.validator-rule-pending",
          file: "schemas/thing.schema.json",
          message: `x-validator-rule '${pendingRule}' is declared not-implemented: waits on the thing checker`,
        },
      ]);
      expect(pendingIssues.filter((i) => i.severity === "error")).toEqual([]);
      expect(pendingIssues.find((i) => i.rule === "schemas.validator-rule-coverage")?.message).toBe(
        "2 rules, 1 implemented, 1 declared pending.",
      );
    } finally {
      Reflect.deleteProperty(SCHEMA_RULE_IMPLEMENTATIONS, pendingRule);
    }
    const ctx = ctxFor({
      "schemas/thing.schema.json": JSON.stringify({
        $id: "thing.schema.json",
        type: "object",
        properties: {
          a: {
            type: "string",
            "x-validator-rule": ["finding.synthesis-may-only-worsen-a-grade", "review.third-fix-cycle-stops"],
          },
        },
      }),
    });
    const issues = checkSchemaRuleCoverage(ctx);
    const count = issues.find((i) => i.rule === "schemas.validator-rule-coverage");
    expect(count?.severity).toBe("note");
    expect(count?.message).toBe("2 rules, 2 implemented, 0 declared pending.");
  });

  test("the coverage count is reported against this repository's real schemas", () => {
    const { catalog } = loadCatalog(REPO);
    if (catalog === null) return;
    const count = checkSchemaRuleCoverage({ root: REPO, catalog }).find(
      (i) => i.rule === "schemas.validator-rule-coverage",
    );
    expect(count?.message).toMatch(/^\d+ rules, \d+ implemented, \d+ declared pending\.$/);
  });
});
