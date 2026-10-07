import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { attach } from "../src/attach/index.ts";
import { loadCatalog } from "../src/catalog/load.ts";
import { runValidation } from "../src/validation/run.ts";
import { parseGLocator, parseLocatorField } from "../src/validation/provenance.ts";
import { readTextIfPresent } from "../src/util/fs.ts";
import { planAll } from "../src/packaging/build.ts";

/**
 * The one test that runs against the real repository rather than a fixture.
 *
 * It is deliberately allowed to report failures: this tree is being authored by
 * several agents at once, so unauthored skills and in-flight files are the
 * expected state. What it asserts is that the validator survives that state --
 * no check throws, every issue names a file and a rule, and the scanner never
 * flags the validator's own source.
 */
const ROOT = join(import.meta.dir, "..");

describe("ak validate against the live tree", () => {
  const run = runValidation(ROOT);

  test("the catalog loads and the run completes", () => {
    expect(run.catalog).not.toBeNull();
    expect(run.catalog?.bySection("skills").length).toBeGreaterThan(0);
  });

  test("no check throws; a missing or half-written file is a reported issue, never a crash", () => {
    const threw = run.issues.filter((i) => i.rule === "check.threw");
    expect(threw.map((i) => `${i.file}: ${i.message}`)).toEqual([]);
  });

  test("every issue names the file and the rule an author has to act on", () => {
    const nameless = run.issues.filter((i) => i.file.trim() === "" || i.rule.trim() === "" || i.message.trim() === "");
    expect(nameless).toEqual([]);
  });

  test("the validator does not flag its own source", () => {
    const own = run.issues.filter((i) => i.file.startsWith("src/") || i.file.startsWith("tests/"));
    expect(own.map((i) => `${i.rule} ${i.file}`)).toEqual([]);
  });

  test("today's failures are about the tree being authored, not about the validator", () => {
    // Not an assertion that the tree is clean. Every issue, at every severity, must carry a rule id an
    // author can look up. Errors alone would leave this vacuous on a tree with none, as it was.
    // The population is never empty: the validator always reports its own coverage notes.
    expect(run.issues.map((i) => i.rule)).toContain("schemas.validator-rule-coverage");
    const malformed = run.issues
      .filter((i) => !/^[a-z][a-z0-9-]*(\.[a-z0-9-]+)+$/.test(i.rule))
      .map((i) => `${i.severity} ${i.rule} ${i.file}`);
    expect(malformed).toEqual([]);
  });
});

describe("the other two commands survive the live tree", () => {
  test("ak build plans both hosts without throwing", () => {
    const { catalog } = loadCatalog(ROOT);
    expect(catalog).not.toBeNull();
    if (catalog === null) return;
    const plans = planAll({ root: ROOT, catalog }, {});
    expect(plans.map((p) => p.host).sort()).toEqual(["claude-code", "codex"]);
    // Each plan is asked for its own host's manifest. Asking both for
    // `.claude-plugin/plugin.json` is what this line used to do, and it passed
    // -- it was the assertion that one bundle was being emitted twice under two
    // names, written as if that were the requirement. The comparison that owns
    // this properly is in tests/packaging.test.ts; here it only has to be the
    // right question against the real tree.
    const expected: Record<string, string> = {
      "claude-code": ".claude-plugin/plugin.json",
      codex: ".codex-plugin/plugin.json",
    };
    for (const plan of plans) {
      expect(`${plan.host}: ${[...plan.files.keys()].includes(expected[plan.host] ?? "")}`).toBe(`${plan.host}: true`);
    }
  });

  test("ak attach answers for a real path in this repository", () => {
    const { catalog } = loadCatalog(ROOT);
    expect(catalog).not.toBeNull();
    if (catalog === null) return;
    const result = attach({ root: ROOT, catalog }, "schemas/ticket.schema.json");
    expect(result.subject.path).toBe("schemas/ticket.schema.json");
    for (const selection of result.selections) expect(selection.evidence.length).toBeGreaterThan(0);
  });
});

/**
 * The measurement behind the field-level locator parser, kept as a test because
 * the next reader will see "the parser accepts more inputs" and reach for the
 * opposite conclusion.
 */
describe("the locator field parser restored a check rather than loosening one", () => {
  const MAP = "provenance/conversation-map.yaml";
  const FIELDS = /^\s*locator:\s*(.+?)\s*$/gm;

  function fields(): string[] {
    const text = readTextIfPresent(join(ROOT, MAP));
    expect(text).not.toBeNull();
    return [...(text ?? "").matchAll(FIELDS)].map((m) => (m[1] ?? "").replace(/^["']|["']$/g, ""));
  }

  test("the single-range parser it replaced accepted 4 of 102 fields, dropping 157 of 161 G:L references", () => {
    const all = fields();
    expect(all.length).toBeGreaterThan(0);

    // What the old parser saw: a field was one range or it was nothing.
    const acceptedWhole = all.filter((f) => parseGLocator(f) !== null);

    // What is actually cited: every reference in every field.
    const transcript = all.flatMap((f) => parseLocatorField(f) ?? []).filter((r) => r.kind === "transcript");

    expect(acceptedWhole.length).toBeLessThan(all.length);
    expect(transcript.length).toBeGreaterThan(acceptedWhole.length);
  });

  test("every locator field in the live map parses, so every transcript reference is range-checkable", () => {
    const unparsed = fields().filter((f) => parseLocatorField(f) === null);
    expect(unparsed).toEqual([]);
  });
});
