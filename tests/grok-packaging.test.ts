import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { loadCatalog } from "../src/catalog/load.ts";
import {
  explicitStartForHost,
  explicitStartPattern,
  loadHostCapabilities,
  rewriteExplicitStarts,
} from "../src/packaging/hosts.ts";
import { planBundle } from "../src/packaging/plan.ts";
import { parseFrontmatter } from "../src/util/frontmatter.ts";
import { splitSections } from "../src/validation/bodies.ts";
import { firstNumberedItem } from "../src/validation/human-start.ts";
import discovery from "./fixtures/grok-discovery.json";

const root = join(import.meta.dir, "..");
const { catalog } = loadCatalog(root);
if (catalog === null) throw new Error("catalog missing");
const ctx = { root, catalog };

describe("Grok generated bundle contract (offline, not session behavior)", () => {
  test("the recorded discovery fixture still matches the generated bundle", () => {
    const grok = planBundle(ctx, "grok", { profile: "all" });
    const skillFiles = [...grok.files.keys()].filter((path) => /^skills\/[^/]+\/SKILL\.md$/.test(path));
    expect(discovery.skillCount).toBe(skillFiles.length);
    for (const skill of discovery.skills) {
      const emitted = grok.files.get(`skills/${skill.name}/SKILL.md`)?.contents;
      if (emitted === undefined) throw new Error(`fixture names ${skill.name}, which the bundle does not emit`);
      expect(parseFrontmatter(emitted).data["description"]).toBe(skill.description);
    }
  });

  test("Grok renders its native command, independent of the Claude namespace", () => {
    expect(explicitStartForHost("grok", "/ak:", "super-align")).toBe("/super-align");
    expect(
      rewriteExplicitStarts("/ak:compound /ak:compound-refresh /ak:super-scout ordinary prose", "grok", "/ak:", [
        "compound",
      ]),
    ).toBe("/compound /ak:compound-refresh /ak:super-scout ordinary prose");
  });

  test("Grok reuses the Claude layout and skill set without claiming its permissions", () => {
    const grok = planBundle(ctx, "grok", { profile: "all" });
    const claude = planBundle(ctx, "claude-code", { profile: "all" });
    expect(grok.issues.filter((issue) => issue.severity === "error")).toEqual([]);
    expect(grok.decisions.map((decision) => decision.skill)).toEqual(
      claude.decisions.map((decision) => decision.skill),
    );
    expect(grok.decisions.length).toBeGreaterThan(0);
    expect(grok.decisions.map(({ skill, mode }) => ({ skill, mode }))).toEqual(
      claude.decisions.map(({ skill, mode }) => ({ skill, mode })),
    );
    expect(grok.files.has(".claude-plugin/plugin.json")).toBe(true);
    expect(grok.files.has(".claude-plugin/ak.json")).toBe(true);
    expect([...grok.files.keys()].some((path) => path.startsWith("evals/"))).toBe(false);
    expect(loadHostCapabilities(root, "grok").declared).toBe(true);
    expect([...loadHostCapabilities(root, "grok").enforces]).toEqual([]);
    const userCommands = catalog
      .bySection("skills")
      .flatMap((entry) => (entry.invocation === "U" ? [`/ak:${entry.id}`] : []));
    const canonical = explicitStartPattern(userCommands);
    expect(
      [...grok.files.values()].flatMap((file) =>
        /^(skills|references)\//.test(file.path) && file.contents.search(canonical) !== -1 ? [file.path] : [],
      ),
    ).toEqual([]);

    for (const entry of catalog.bySection("skills")) {
      const path = `skills/${entry.id}/SKILL.md`;
      const emitted = grok.files.get(path)?.contents;
      const original = claude.files.get(path)?.contents;
      if (emitted === undefined || original === undefined) throw new Error(`missing ${entry.id}`);
      const parsed = parseFrontmatter(emitted);
      expect(parsed.data["disable-model-invocation"]).toBeUndefined();
      expect(parsed.data["user-invocable"]).toBeUndefined();
      if (entry.invocation === "U") {
        expect(grok.decisions.find((decision) => decision.skill === entry.id)?.mode).toBe("manual");
        // This tests the generated agent interface, not whether a session obeys it.
        const command = `/${entry.id}`;
        expect(parsed.data["description"]).toContain(command);
        expect(parsed.data["description"]).toMatch(
          /On any other request do not load or follow it|prose mention alone is not a start/,
        );
        const workflow = splitSections(parsed.body).find((section) => section.heading === "## Workflow");
        const first = workflow === undefined ? null : firstNumberedItem(workflow.text);
        expect(first?.text).toContain(command);
        expect(first?.text).toMatch(/\bstop\b/i);
        expect(emitted).not.toContain(`/ak:${entry.id}`);
      } else {
        expect(parsed.data["description"]).toBe(parseFrontmatter(original).data["description"]);
      }
    }
  });
});
