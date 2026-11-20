/**
 * `policies/review.yaml` and `policies/limits.yaml` hold the convergence rules
 * as data (ADR-0018). The tools read their own constants, so these tests hold
 * the two equal: a number or a list changed on one side alone is a red test.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";
import { parse } from "yaml";

import { CLASS_RANK } from "../../src/delegation.ts";
import { DEFAULT_POLICY, SCOPE_TRIGGERS } from "../../src/review/types.ts";
import { parseJson, type JsonValue } from "../helpers/json.ts";

const ROOT = join(import.meta.dir, "..", "..");

/** A policy file as a JSON value: the YAML is parsed, then read back as typed JSON. */
function policy(name: string): JsonValue {
  const parsed: unknown = parse(readFileSync(join(ROOT, "policies", name), "utf8"));
  return parseJson(JSON.stringify(parsed));
}

/** The member at the object path `path`, or null where a step is absent or not in an object. */
function at(value: JsonValue, ...path: string[]): JsonValue {
  let current = value;
  for (const step of path) {
    if (Array.isArray(current) || !(current instanceof Object)) return null;
    current = current[step] ?? null;
  }
  return current;
}

const review = policy("review.yaml");
const limits = policy("limits.yaml");

describe("policies/review.yaml convergence", () => {
  test("holds the cap, the scope count, the blocking severities and the always-block categories of the engine", () => {
    expect({
      max_rounds: at(review, "convergence", "cap", "max_rounds"),
      max_scopes: at(review, "convergence", "scope", "max_scopes"),
      blocking_severities: at(review, "convergence", "blocking_bar", "severities"),
      always_block: at(review, "convergence", "always_block", "categories"),
    }).toEqual({
      max_rounds: DEFAULT_POLICY.max_rounds,
      max_scopes: DEFAULT_POLICY.max_scopes,
      blocking_severities: [...DEFAULT_POLICY.blocking_severities],
      always_block: [...DEFAULT_POLICY.always_block],
    });
  });

  test("the cap is the review-rounds limit", () => {
    expect(at(review, "convergence", "cap", "max_rounds")).toBe(at(limits, "enforced", "review_rounds", "value"));
    expect(at(review, "convergence", "cap", "limit")).toBe("policy:limits/review_rounds");
  });

  test("names the triggers of the ledger in the ledger's order", () => {
    const triggers = at(review, "convergence", "full_re_review", "triggers");
    expect(Array.isArray(triggers) ? triggers.map((trigger) => at(trigger, "id")) : null).toEqual([...SCOPE_TRIGGERS]);
  });

  test("holds the thresholds `ak review scope` compares", () => {
    const triggers = at(review, "convergence", "full_re_review", "triggers");
    const byId = (id: string) =>
      (Array.isArray(triggers) ? triggers.find((trigger) => at(trigger, "id") === id) : null) ?? null;
    expect({
      rebase_rewritten_percent: at(byId("large-rebase"), "rewritten_percent"),
      growth_percent: at(byId("scope-growth"), "percent"),
      growth_lines: at(byId("scope-growth"), "lines"),
    }).toEqual(DEFAULT_POLICY.triggers);
  });
});

describe("policies/review.yaml pass_1.depth.evidence_by_class", () => {
  /** The delegation classes from the lowest to the highest. */
  const classes = Object.entries(CLASS_RANK)
    .toSorted(([, left], [, right]) => left - right)
    .map(([name]) => name);
  const depth = at(review, "pass_1", "depth");

  test("gives every delegation class its evidence, and restates the depth of by_class", () => {
    for (const name of classes) {
      const row = at(depth, "evidence_by_class", name);
      const evidence = at(row, "evidence");
      expect({ name, depth: at(row, "depth") }).toEqual({ name, depth: at(depth, "by_class", name) });
      expect({ name, items: Array.isArray(evidence) ? evidence.length > 0 : false }).toEqual({ name, items: true });
    }
  });

  test("sits one independent seat for the two lower classes and two for the two higher, as the plan's table says", () => {
    expect(classes.map((name) => [name, at(depth, "evidence_by_class", name, "independent_seats")])).toEqual([
      ["green", 1],
      ["yellow-agent", 1],
      ["yellow-owner", 2],
      ["red", 2],
    ]);
  });

  test("absent class evidence is the full depth, as the depth block says", () => {
    expect(at(depth, "evidence_by_class", "absent_class_evidence")).toBe("full");
  });
});

describe("policies/limits.yaml", () => {
  test("the round cap and the fix-cycle cap apply to a merge gate, with the values unchanged", () => {
    expect(at(limits, "enforced", "review_rounds", "applies_to", "operations")).toContain("review.merge-gate");
    expect(at(limits, "enforced", "fix_cycles", "applies_to", "operations")).toContain("review.merge-gate");
    expect([at(limits, "enforced", "review_rounds", "value"), at(limits, "enforced", "fix_cycles", "value")]).toEqual([
      3, 2,
    ]);
  });
});
