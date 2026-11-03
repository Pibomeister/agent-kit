import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { loadCatalog } from "../src/catalog/load.ts";
import {
  HOST_IDS,
  explicitStartForHost,
  explicitStartPattern,
  loadHostCapabilities,
  packagedBinFile,
  packagedSkillFile,
  relocateForHost,
  rewriteExplicitStarts,
} from "../src/packaging/hosts.ts";
import { schemaRefs } from "../src/packaging/mentions.ts";
import { BUILD_RECORD_FILE, LICENCE_FILES, isExecutable, planBundle } from "../src/packaging/plan.ts";
import { writeBundles } from "../src/packaging/build.ts";
import { parseFrontmatter } from "../src/util/frontmatter.ts";
import { walkFiles } from "../src/util/fs.ts";
import { extractRelativeLinks, resolveFromFile } from "../src/util/links.ts";
import { splitSections } from "../src/validation/bodies.ts";
import { firstNumberedItem } from "../src/validation/human-start.ts";
import { checkBundleLinks } from "../src/validation/links.ts";
import { parseJson, type JsonValue } from "./helpers/json.ts";
import { makeTree } from "./helpers/tree.ts";

const root = join(import.meta.dir, "..");
const { catalog } = loadCatalog(root);
if (catalog === null) throw new Error("catalog missing");
const ctx = { root, catalog };

const EXISTING_HOSTS = HOST_IDS.filter((host) => host !== "cursor");

function agentPath(id: string): string {
  return `.cursor/agents/${id.replaceAll("/", "-")}.md`;
}

function isReviewerRole(id: string): boolean {
  return (
    id === "reviewer-spec" ||
    id === "reviewer-standards" ||
    id === "verifier" ||
    id === "trail-auditor" ||
    id.startsWith("code-review/") ||
    id.startsWith("doc-review/") ||
    id.startsWith("plan-review/")
  );
}

function objectMember(value: JsonValue, key: string): JsonValue | undefined {
  return value instanceof Object && !Array.isArray(value) ? value[key] : undefined;
}

function excludedSkillIds(record: JsonValue): string[] {
  const excluded = objectMember(record, "excluded");
  if (!Array.isArray(excluded)) return [];
  const ids: string[] = [];
  for (const row of excluded) {
    const skill = objectMember(row, "skill");
    if (skill === null || skill === undefined || Array.isArray(skill) || skill instanceof Object) continue;
    ids.push(`${skill}`);
  }
  return ids;
}

describe("Cursor generated bundle (offline, not session behavior)", () => {
  test("existing hosts keep their previous layout and gain no Cursor overlay", () => {
    const claude = planBundle(ctx, "claude-code", { profile: "all" });
    for (const host of EXISTING_HOSTS) {
      const plan = planBundle(ctx, host, { profile: "all" });
      const paths = [...plan.files.keys()];
      expect(
        `${host}:${paths.filter((path) => path.startsWith(".cursor/") || path.startsWith(".cursor-plugin/")).join(",")}`,
      ).toBe(`${host}:`);
      expect(paths.includes("AGENTS.md")).toBe(false);
      expect(paths.some((path) => /^skills\/[^/]+\/SKILL\.md$/.test(path))).toBe(true);
      expect(plan.files.has("bin/ak")).toBe(true);
      expect(plan.files.has(packagedBinFile("cursor", "ak"))).toBe(false);
    }
    expect(claude.files.has("skills/super-review/SKILL.md")).toBe(true);
  }, 120_000);

  test("Cursor renders /<id>, independent of the Claude namespace", () => {
    expect(explicitStartForHost("cursor", "/ak:", "super-review")).toBe("/super-review");
    expect(
      rewriteExplicitStarts("/ak:compound /ak:compound-refresh /ak:super-scout ordinary prose", "cursor", "/ak:", [
        "compound",
      ]),
    ).toBe("/compound /ak:compound-refresh /ak:super-scout ordinary prose");
  });

  test("the Cursor bundle is the catalog in a Cloud-discoverable layout", () => {
    const cursor = planBundle(ctx, "cursor", { profile: "all" });
    const claude = planBundle(ctx, "claude-code", { profile: "all" });
    expect(cursor.issues.filter((issue) => issue.severity === "error")).toEqual([]);
    expect(cursor.decisions.map((decision) => decision.skill)).toEqual(
      claude.decisions.map((decision) => decision.skill),
    );
    expect(cursor.decisions.map(({ skill, mode }) => ({ skill, mode }))).toEqual(
      claude.decisions.map(({ skill, mode }) => ({ skill, mode })),
    );

    const manifest: unknown = JSON.parse(cursor.files.get(".cursor-plugin/plugin.json")?.contents ?? "{}");
    expect(manifest).toMatchObject({
      name: "ak",
      license: "MIT",
      agents: "./.cursor/agents/",
    });
    const skills = manifest instanceof Object && "skills" in manifest ? manifest.skills : undefined;
    if (!Array.isArray(skills)) throw new Error("plugin.json does not enumerate its skills");
    expect(skills).toEqual(cursor.decisions.map((decision) => `./.cursor/skills/${decision.skill}`));
    expect(cursor.files.has(".cursor-plugin/marketplace.json")).toBe(true);
    expect(cursor.files.has(".cursor-plugin/ak.json")).toBe(true);
    expect(cursor.files.has("hooks/hooks.json")).toBe(false);
    expect(cursor.files.has(".cursor/hooks.json")).toBe(false);
    expect(cursor.files.has(".cursor/environment.json")).toBe(false);
    expect([...cursor.files.keys()].some((path) => path.startsWith("evals/"))).toBe(false);

    const record = parseJson(cursor.files.get(BUILD_RECORD_FILE.cursor)?.contents ?? "{}");
    expect(record).toMatchObject({ host: { id: "cursor", enforces: [] } });
    const excludedIds = excludedSkillIds(record);
    expect(loadHostCapabilities(root, "cursor").declared).toBe(true);
    expect([...loadHostCapabilities(root, "cursor").enforces]).toEqual([]);

    const authoredSkills = catalog.bySection("skills").filter((entry) => entry.status === "authored");
    const unauthoredSkills = catalog.bySection("skills").filter((entry) => entry.status !== "authored");
    for (const entry of authoredSkills) {
      const path = packagedSkillFile("cursor", entry.id);
      const emitted = cursor.files.get(path)?.contents;
      if (emitted === undefined) throw new Error(`authored skill ${entry.id} missing from ${path}`);
      const parsed = parseFrontmatter(emitted);
      expect(parsed.data["name"]).toBe(entry.id);
      expect(parsed.data["description"]).toBeString();
      expect(parsed.data["disable-model-invocation"]).toBeUndefined();
      expect(parsed.data["paths"]).toBeUndefined();
      expect(parsed.data["globs"]).toBeUndefined();
      expect(parsed.data["allowed-tools"]).toBeUndefined();
      expect(parsed.data["argument-hint"]).toBeUndefined();
    }
    expect(cursor.files.has("skills/super-review/SKILL.md")).toBe(false);
    for (const entry of unauthoredSkills) {
      expect(cursor.files.has(packagedSkillFile("cursor", entry.id))).toBe(false);
      expect(excludedIds).toContain(entry.id);
    }

    const agentsGuide = cursor.files.get("AGENTS.md")?.contents ?? "";
    expect(agentsGuide).toContain("`/super-review`");
    expect(agentsGuide).toContain("`.cursor/agents/`");

    const authoredRoles = catalog.bySection("roles").filter((entry) => entry.status === "authored");
    const unauthoredRoles = catalog.bySection("roles").filter((entry) => entry.status !== "authored");
    for (const entry of authoredRoles) {
      const path = agentPath(entry.id);
      const emitted = cursor.files.get(path)?.contents;
      if (emitted === undefined) throw new Error(`authored role ${entry.id} missing from ${path}`);
      expect(cursor.files.get(path)?.verbatim).toBe(true);
      const parsed = parseFrontmatter(emitted);
      expect(parsed.data["name"]).toBe(entry.id.replaceAll("/", "-"));
      expect(parsed.data["description"]).toBeString();
      if (isReviewerRole(entry.id)) expect(parsed.data["readonly"]).toBe(true);
      else expect(parsed.data["readonly"]).toBeUndefined();
      expect(cursor.files.has(`.cursor/roles/${entry.id}/ROLE.md`)).toBe(true);
    }
    for (const entry of unauthoredRoles) {
      expect(cursor.files.has(agentPath(entry.id))).toBe(false);
      expect(agentsGuide).toContain(`\`${entry.id}\``);
    }

    const rule = cursor.files.get(".cursor/rules/ak-super-review.mdc")?.contents ?? "";
    const ruleMatter = parseFrontmatter(rule);
    expect(ruleMatter.data["alwaysApply"]).toBe(false);
    expect(ruleMatter.data["description"]).toBeString();
    expect(ruleMatter.data["globs"]).toBeUndefined();
    expect(rule).toContain("`/super-review`");

    const userCommands = catalog
      .bySection("skills")
      .flatMap((entry) => (entry.invocation === "U" ? [`/ak:${entry.id}`] : []));
    const canonical = explicitStartPattern(userCommands);
    expect(
      [...cursor.files.values()].flatMap((file) =>
        /^(?:\.cursor\/)?(?:skills|references)\//.test(file.path) && file.contents.search(canonical) !== -1
          ? [file.path]
          : [],
      ),
    ).toEqual([]);

    for (const entry of catalog.bySection("skills")) {
      const emitted = cursor.files.get(packagedSkillFile("cursor", entry.id))?.contents;
      const original = claude.files.get(packagedSkillFile("claude-code", entry.id))?.contents;
      if (emitted === undefined || original === undefined) continue;
      const parsed = parseFrontmatter(emitted);
      if (entry.invocation === "U") {
        expect(cursor.decisions.find((decision) => decision.skill === entry.id)?.mode).toBe("manual");
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

    expect(cursor.files.has(packagedSkillFile("cursor", "super-review"))).toBe(true);
    expect(
      parseFrontmatter(cursor.files.get(packagedSkillFile("cursor", "super-review"))?.contents ?? "").data["name"],
    ).toBe("super-review");
    expect(cursor.files.has(".cursor/bin/ak-gate.mjs")).toBe(true);
    expect(cursor.files.has(packagedBinFile("cursor", "ak"))).toBe(true);
    expect(cursor.files.get(agentPath("trail-auditor"))?.contents).toContain(
      "](../templates/trail-audit.example.json)",
    );
    expect(cursor.files.get(agentPath("trail-auditor"))?.contents).not.toContain("../../templates/");

    expect(
      checkBundleLinks(ctx, { hosts: ["cursor"], profile: "all" }).filter(
        (issue) => issue.rule === "links.mention-not-bundled" || issue.rule === "links.broken-bundle",
      ),
    ).toEqual([]);
  }, 120_000);

  test("a Cursor fixture relocates skills and keeps relative links valid", () => {
    const tree = makeTree({
      "catalog.yaml": `schema_version: 1
package:
  id: ak
  name: agent-kit
  version: 0.1.0
  namespace: "/ak:"
  default_profile: core
  description: What the host is told, which is a different sentence again.
  author: agent-kit maintainers
  license: MIT
skills:
  - id: alpha
    status: authored
    invocation: U
    profiles: [core]
roles:
  - id: implementer
    status: authored
  - id: reviewer-standards
    status: authored
adapters:
  - id: claude-code
    status: authored
  - id: cursor
    status: authored
profiles:
  - id: core
    status: authored
`,
      "package.json": `${JSON.stringify({ name: "fixture-package", version: "0.1.0", license: "MIT" }, null, 2)}\n`,
      "adapters/claude-code/CONTRACT.md": [
        "# claude-code",
        "",
        "## 3. Capability support",
        "",
        "| Capability | Status | Detail |",
        "|---|---|---|",
        "| `repository-read` | `satisfied` | Read, Glob, Grep |",
        "| `kb-write` | `not-provided` | Transport only |",
        "",
        "## 4. Host-capability honesty",
        "",
        "A host that cannot enforce a restriction an autonomous run requires exposes the affected",
        "skill in guided/manual mode and rejects autonomous mode.",
        "",
      ].join("\n"),
      "skills/alpha/SKILL.md": `---
name: alpha
description: >-
  Human-started command: it runs only when the human's message begins with \`/ak:alpha\`. On any
  other request do not load or follow it; tell the human to type that command.
---

Follow [tdd](../../protocols/tdd/PROTOCOL.md).

## Authority

A human starts the public entrypoint by typing \`/ak:alpha\`. A request in prose is not a start.

## Workflow

1. Check how this run was started. It is started only when the human's message begins with
   \`/ak:alpha\`. Otherwise stop, name the command and do nothing else.
`,
      "skills/alpha/skill.yaml": "id: alpha\nversion: 0.1.0\ninvocation: U\n",
      "protocols/tdd/PROTOCOL.md": "# TDD\n",
      "roles/implementer/ROLE.md": "# Implementer\n",
      "roles/reviewer-standards/ROLE.md": "# Standards reviewer\n",
      "profiles/core.yaml": "id: core\nskills: [alpha]\n",
      NOTICE: "agent-kit\n",
      LICENSE: "MIT License\n",
      "node_modules/ajv/LICENSE": "Copyright\n",
      "node_modules/ajv-formats/LICENSE": "Copyright\n",
      "node_modules/fast-deep-equal/LICENSE": "Copyright\n",
      "node_modules/fast-uri/LICENSE": "Copyright\n",
      "node_modules/json-schema-traverse/LICENSE": "Copyright\n",
      "node_modules/yaml/LICENSE": "Copyright\n",
      "provenance/licenses/thedotmack_claude-mem.LICENSE": "Apache License\n",
      "provenance/licenses/thedotmack_claude-mem.NOTICE": "Claude-Mem\n",
    });
    const { catalog: fixtureCatalog } = loadCatalog(tree);
    if (fixtureCatalog === null) throw new Error("fixture catalog missing");
    const plan = planBundle({ root: tree, catalog: fixtureCatalog }, "cursor", {});
    expect(plan.issues.filter((issue) => issue.severity === "error")).toEqual([]);
    const alpha = plan.files.get(".cursor/skills/alpha/SKILL.md")?.contents ?? "";
    expect(alpha).toContain("`/alpha`");
    expect(alpha).not.toContain("/ak:alpha");
    expect(alpha).toContain("](../../references/shared/protocols/tdd/PROTOCOL.md)");
    expect(plan.files.has(".cursor/references/shared/protocols/tdd/PROTOCOL.md")).toBe(true);
    expect(plan.files.has("skills/alpha/SKILL.md")).toBe(false);
    const reviewer = parseFrontmatter(plan.files.get(".cursor/agents/reviewer-standards.md")?.contents ?? "");
    expect(reviewer.data["readonly"]).toBe(true);
    expect(
      parseFrontmatter(plan.files.get(".cursor/agents/implementer.md")?.contents ?? "").data["readonly"],
    ).toBeUndefined();

    const out = join(tree, "dedicated");
    const built = writeBundles({ root: tree, catalog: fixtureCatalog }, { hosts: ["cursor"], out });
    expect(built.issues.filter((issue) => issue.severity === "error")).toEqual([]);
    expect(existsSync(join(out, ".cursor/skills/alpha/SKILL.md"))).toBe(true);
    expect(existsSync(join(tree, "dist/cursor"))).toBe(false);
    expect(readFileSync(join(out, ".cursor-plugin/plugin.json"), "utf8")).toContain("./.cursor/skills/alpha");
  });

  test("every relative link in the Cursor bundle resolves inside it, and the licence files are present", () => {
    const cursor = planBundle(ctx, "cursor", { profile: "all" });
    expect(cursor.issues.filter((issue) => issue.severity === "error")).toEqual([]);
    const present = new Set(cursor.files.keys());
    const dirs = new Set<string>();
    for (const path of present) {
      const parts = path.split("/");
      for (let i = 1; i < parts.length; i += 1) dirs.add(parts.slice(0, i).join("/"));
    }
    const dangling: string[] = [];
    for (const file of cursor.files.values()) {
      if (file.path.endsWith(".schema.json")) {
        for (const ref of schemaRefs(file.path, file.contents)) {
          if (!present.has(ref)) dangling.push(`${file.path} $ref ${ref}`);
        }
        continue;
      }
      if (!/\.(?:md|mdc)$/.test(file.path)) continue;
      for (const link of extractRelativeLinks(file.contents)) {
        const resolved = resolveFromFile(file.path, link.target);
        if (resolved === null) {
          dangling.push(`${file.path} -> ${link.target} (escapes bundle)`);
          continue;
        }
        if (present.has(resolved) || dirs.has(resolved)) continue;
        dangling.push(`${file.path} -> ${link.target} (${resolved})`);
      }
    }
    expect(dangling).toEqual([]);
    expect(present.has(".cursor/templates/trail-audit.example.json")).toBe(true);
    expect(cursor.files.get(agentPath("trail-auditor"))?.contents).toContain(
      "](../templates/trail-audit.example.json)",
    );
    expect(cursor.files.get(".cursor/roles/trail-auditor/ROLE.md")?.contents).toContain(
      "](../../templates/trail-audit.example.json)",
    );
    for (const licence of LICENCE_FILES) {
      const path = relocateForHost("cursor", licence.path);
      expect(path.startsWith(".cursor/licenses/")).toBe(true);
      expect(`${path}:${present.has(path)}`).toBe(`${path}:true`);
      expect(present.has(licence.path)).toBe(false);
    }
    expect(present.has("LICENSE")).toBe(false);
    expect(present.has("NOTICE")).toBe(false);
    expect(present.has("LICENSES/ajv.LICENSE")).toBe(false);
    expect(present.has(".cursor/licenses/LICENSE")).toBe(true);
    expect(present.has(".cursor/licenses/NOTICE")).toBe(true);
    expect(present.has(".cursor/licenses/provenance/licenses/thedotmack_claude-mem.NOTICE")).toBe(true);
    const gate = cursor.files.get(".cursor/bin/ak-gate.mjs")?.contents ?? "";
    expect(gate.startsWith("// Licence texts for this file")).toBe(true);
    expect(gate).toContain("// --- LICENSE ---");
    expect(gate).toContain("// --- NOTICE ---");
    expect(gate).toContain("// --- provenance/licenses/thedotmack_claude-mem.NOTICE ---");
  }, 120_000);

  test("the committed .cursor overlay matches a fresh default Cursor plan except environment.json", () => {
    const cursor = planBundle(ctx, "cursor", {});
    expect(cursor.issues.filter((issue) => issue.severity === "error")).toEqual([]);
    const planned = [...cursor.files.keys()].filter((path) => path.startsWith(".cursor/")).toSorted();
    const extras = walkFiles(root, ".cursor").filter((path) => path !== ".cursor/environment.json");
    expect(extras).toEqual(planned);
    expect(JSON.parse(readFileSync(join(root, ".cursor/environment.json"), "utf8"))).toEqual({
      name: "agent-kit",
      install: "bash tools/cursor/install.sh",
    });
    expect(existsSync(join(root, ".cursor/skills/super-review/SKILL.md"))).toBe(true);
    const missing: string[] = [];
    const stale: string[] = [];
    const notExecutable: string[] = [];
    for (const file of cursor.files.values()) {
      if (!file.path.startsWith(".cursor/")) continue;
      const disk = join(root, file.path);
      if (!existsSync(disk)) {
        missing.push(file.path);
        continue;
      }
      if (readFileSync(disk, "utf8") !== file.contents) stale.push(file.path);
      if (isExecutable(file) && (statSync(disk).mode & 0o111) === 0) notExecutable.push(file.path);
    }
    expect({ missing, stale, notExecutable }).toEqual({ missing: [], stale: [], notExecutable: [] });
  }, 120_000);
});
