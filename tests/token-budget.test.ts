/**
 * The token-budget ratchet (`tools/budget/`): every fixed text agent-kit hands an agent is held at
 * the size `tools/budget/baseline.json` pins for it.
 *
 * The first case is the gate, measured on this tree. The population case keeps the collector from
 * passing by measuring nothing: a pin that no surface reaches is reported, but a whole family of
 * surfaces that stopped being collected would leave nothing behind to report. The remaining cases
 * drive the comparison with invented surfaces and invented pins, so each assertion is about what
 * the ratchet does, not about the size of any text in the repository.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { loadCatalog } from "../src/catalog/load.ts";
import { HOST_IDS } from "../src/packaging/hosts.ts";
import {
  applyUpdate,
  compare,
  describeChange,
  ESTIMATOR,
  estimatorMessage,
  isGrowth,
  measure,
  parseBaseline,
  readBaseline,
  serialize,
  type Baseline,
} from "../tools/budget/ratchet.ts";
import { collectSurfaces, withDefaultInstall, type Surface } from "../tools/budget/surfaces.ts";

const REPO = resolve(import.meta.dir, "..");

describe("this tree's agent-facing text", () => {
  const surfaces = collectSurfaces(REPO);

  test("every surface is at its pin", () => {
    const baseline = readBaseline(REPO);
    const result = compare(baseline, surfaces);
    const lines = [
      ...(result.estimatorChanged ? [estimatorMessage(baseline)] : []),
      ...result.changes.map(describeChange),
    ];
    expect(lines).toEqual([]);
  });

  test("the collector reaches every family it claims, and none of them is empty", () => {
    const ids = new Set(surfaces.map((surface) => surface.id));
    const { catalog } = loadCatalog(REPO);
    if (catalog === null) throw new Error("catalog.yaml did not load");

    const expected = [
      "repo:AGENTS.md",
      "repo:CLAUDE.md",
      "hook:session-start (no repository)",
      "hook:session-start (invented project)",
      "firstmate:adapters/firstmate/WORKER.md",
      "firstmate:stock-brief",
      ...["pattern-maintainer", "reflector", "consolidator", "lesson-merger", "skill-scout"].map((r) => `judge:${r}`),
      "distill:tool-calls",
      ...catalog
        .bySection("roles")
        .filter((entry) => entry.status === "authored")
        .map((entry) => `role:${entry.id}`),
      ...HOST_IDS.flatMap((host) => [
        `bundle/${host}:skill-listing`,
        ...catalog
          .bySection("skills")
          .filter((entry) => entry.status === "authored")
          .map((entry) => `bundle/${host}:skills/${entry.id}/SKILL.md`),
      ]),
    ];
    expect(expected.filter((id) => !ids.has(id))).toEqual([]);
    expect(surfaces.filter((surface) => surface.text.trim() === "").map((surface) => surface.id)).toEqual([]);
  });
});

const surface = (id: string, text: string, file = `${id}.md`): Surface => ({ id, file, text });

function pinned(...entries: Surface[]): Baseline {
  return { estimator: ESTIMATOR, surfaces: Object.fromEntries(entries.map((s) => [s.id, measure(s)])) };
}

describe("the ratchet", () => {
  test("bytes are UTF-8 and tokens are the named chars/4 estimate", () => {
    expect(measure(surface("a", "héllo"))).toEqual({ file: "a.md", bytes: 6, tokens: 2 });
    expect(ESTIMATOR).toContain("chars/4");
  });

  test("growth fails, naming the file to edit and the delta", () => {
    const result = compare(pinned(surface("skill", "x".repeat(40))), [surface("skill", "x".repeat(48))]);
    expect(result.changes.map((change) => change.kind)).toEqual(["grew"]);
    const [line] = result.changes.map(describeChange);
    expect(line).toStartWith("skill.md: skill grew +8 bytes, +2 est. tokens (40 -> 48 bytes, 10 -> 12 est. tokens).");
    expect(line).toContain("--allow-growth");
  });

  test("a shrink is reported rather than passed, and the update lowers the pin without a flag", () => {
    const baseline = pinned(surface("role", "y".repeat(40)));
    const result = compare(baseline, [surface("role", "y".repeat(20))]);
    expect(result.changes.map((change) => change.kind)).toEqual(["shrank"]);
    expect(result.changes.map(describeChange).join("")).toContain("-20 bytes, -5 est. tokens");
    expect(result.changes.some(isGrowth)).toBe(false);
    expect(applyUpdate(result, false)?.surfaces["role"]).toEqual({ file: "role.md", bytes: 20, tokens: 5 });
  });

  test("the update refuses growth unless it is allowed, and then records it", () => {
    const result = compare(pinned(surface("hook", "z")), [surface("hook", "zz")]);
    expect(applyUpdate(result, false)).toBeNull();
    expect(applyUpdate(result, true)?.surfaces["hook"]?.bytes).toBe(2);
  });

  test("an unpinned surface is growth; a pin for a surface no longer emitted is not", () => {
    const result = compare(pinned(surface("old", "text")), [surface("new", "text")]);
    expect(result.changes.map((change) => [change.kind, isGrowth(change)])).toEqual([
      ["unpinned", true],
      ["gone", false],
    ]);
    expect(applyUpdate(result, false)).toBeNull();
    const dropped = compare(pinned(surface("old", "text")), []);
    expect(applyUpdate(dropped, false)).toEqual({ estimator: ESTIMATOR, surfaces: {} });
  });

  test("a baseline measured with another estimator needs a deliberate re-pin", () => {
    const baseline: Baseline = { ...pinned(surface("a", "text")), estimator: "words * 1.3" };
    const result = compare(baseline, [surface("a", "text")]);
    expect(result.estimatorChanged).toBe(true);
    expect(result.changes).toEqual([]);
    expect(applyUpdate(result, false)).toBeNull();
    expect(estimatorMessage(baseline)).toContain('"words * 1.3"');
  });

  test("the serialized baseline is sorted by code unit and parses back through the schema", () => {
    const baseline = pinned(surface("b", "2"), surface("B", "1"), surface("a", "3"));
    const text = serialize(baseline);
    expect(Object.keys(parseBaseline(text).surfaces)).toEqual(["B", "a", "b"]);
    expect(() => parseBaseline('{"estimator": "x", "surfaces": {"a": {"bytes": -1}}}', "fixture")).toThrow(
      "fixture is malformed",
    );
  });

  test("the bundle is planned without the install file, which would change its frontmatter", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "ak-budget-test-")));
    writeFileSync(join(root, "ak.install.yaml"), "attached: []\n");
    writeFileSync(join(root, "catalog.yaml"), "skills: []\n");
    const seen = withDefaultInstall(root, (planRoot) => ({
      install: existsSync(join(planRoot, "ak.install.yaml")),
      catalog: lstatSync(join(planRoot, "catalog.yaml")).isSymbolicLink(),
      planRoot,
    }));
    expect([seen.install, seen.catalog]).toEqual([false, true]);
    expect(existsSync(seen.planRoot)).toBe(false);
  });
});
