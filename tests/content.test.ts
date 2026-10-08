import { describe, expect, test } from "bun:test";

import { checkContent, DENYLIST_EXEMPT_PREFIXES, contentScanRoots } from "../src/validation/content.ts";
import { loadCatalog } from "../src/catalog/load.ts";
import { DENY_TERMS, SCANNER_DEFINITION_FILE } from "../src/denylist.ts";
import { makeTree } from "./helpers/tree.ts";
import { sampleModelTerm } from "./helpers/tree.ts";

const CATALOG = `schema_version: 1
package:
  id: ak
  name: agent-kit
  version: 0.1.0
  namespace: "/ak:"
  default_profile: core
skills:
  - id: alpha
    status: authored
    invocation: U
`;

function ctxFor(files: Record<string, string>) {
  const root = makeTree({ "catalog.yaml": CATALOG, ...files });
  const { catalog } = loadCatalog(root);
  if (catalog === null) throw new Error("fixture has no catalog");
  return { root, catalog };
}

const HEAD = "---\nname: alpha\ndescription: d\n---\n";

describe("model and pricing denylist", () => {
  test("a model name in a skill body is an error naming the file, line and rule", () => {
    const ctx = ctxFor({ "skills/alpha/SKILL.md": `${HEAD}\nRoute the work to ${sampleModelTerm()} first.\n` });
    const issue = checkContent(ctx).find((i) => i.rule === "content.denylist");
    expect(issue?.severity).toBe("error");
    expect(issue?.file).toBe("skills/alpha/SKILL.md");
    expect(issue?.line).toBe(6);
  });

  test("provenance/ and research/sources/ quote the sources verbatim and are exempt", () => {
    const term = sampleModelTerm();
    const ctx = ctxFor({
      "skills/alpha/SKILL.md": HEAD,
      "provenance/conversation-map.yaml": `note: ${term}\n`,
      "research/sources/grok-transcript.md": `the ${term} option\n`,
    });
    expect(checkContent(ctx).filter((i) => i.rule === "content.denylist")).toEqual([]);
  });

  test.each([
    "LICENSE",
    "NOTICE",
    "provenance/licenses/thedotmack_claude-mem.LICENSE",
    "provenance/licenses/ajv-validator_ajv.LICENSE",
    "provenance/licenses/ajv-validator_ajv-formats.LICENSE",
  ])("a shipped license rejects a denylisted term: %s", (file) => {
    const text = "Copyright notice\nPricing: $3/1M output\n";
    const ctx = ctxFor({ [file]: text, "provenance/licenses/donor.LICENSE": text });
    expect(checkContent(ctx).filter((issue) => issue.rule === "content.denylist")).toEqual([
      expect.objectContaining({ file, line: 2, severity: "error" }),
    ]);
  });

  test("the exempt prefixes are exactly provenance/, research/ and the scanner's own definition", () => {
    expect([...DENYLIST_EXEMPT_PREFIXES].sort()).toEqual(
      ["provenance/", "research/", SCANNER_DEFINITION_FILE, "tests/"].sort(),
    );
  });

  test("ordinary English in a skill body is not flagged", () => {
    const ctx = ctxFor({
      "skills/alpha/SKILL.md": `${HEAD}\nThe solution is solid; consolidate the terrain and resolve it on the console.\n`,
    });
    expect(checkContent(ctx).filter((i) => i.rule === "content.denylist")).toEqual([]);
  });

  test("the scan covers src/ and tests/ so the tool cannot exempt itself", () => {
    expect(contentScanRoots()).toContain("src");
    expect(contentScanRoots()).toContain("tests");
    const ctx = ctxFor({ "skills/alpha/SKILL.md": HEAD, "src/thing.ts": `const m = "${sampleModelTerm()}";\n` });
    expect(checkContent(ctx).some((i) => i.rule === "content.denylist" && i.file === "src/thing.ts")).toBe(true);
  });

  test("the scan covers catalog.d/, though this repository carries no fragment there", () => {
    // A tracked tree missing from the scan roots reports clean whatever it
    // holds, and a downstream fork's catalog fragment is catalog content.
    expect(contentScanRoots()).toContain("catalog.d");
    const ctx = ctxFor({
      "skills/alpha/SKILL.md": HEAD,
      "catalog.d/downstream.yaml": `schema_version: 1\nprofiles:\n  - id: downstream\n    summary: Route it to ${sampleModelTerm()}.\n`,
    });
    expect(checkContent(ctx).some((i) => i.rule === "content.denylist" && i.file === "catalog.d/downstream.yaml")).toBe(
      true,
    );
  });

  test("the scanner's own definition file is not flagged by its own terms", () => {
    const body = DENY_TERMS.map((t) => t.probe).join("\n");
    const ctx = ctxFor({ "skills/alpha/SKILL.md": HEAD, [SCANNER_DEFINITION_FILE]: body });
    expect(checkContent(ctx).filter((i) => i.file === SCANNER_DEFINITION_FILE)).toEqual([]);
  });

  test("pricing shapes are flagged wherever they appear in the catalog", () => {
    const ctx = ctxFor({ "skills/alpha/SKILL.md": `${HEAD}\nBudget line: $/1M tokens\n` });
    expect(checkContent(ctx).some((i) => i.rule === "content.denylist")).toBe(true);
  });

  test.each(["$3/1M", "$3.00/1M", "$15/1M output", "$0.25 / 1M tokens"])(
    "a rate written the way a pricing table writes it is flagged: %s",
    (price) => {
      // The rule permitted only whitespace between `$` and `/`, so it matched
      // its own probe and nothing else. No pricing table writes `$/1M`; a real
      // one carries the number that makes it a price, and every form here was
      // silent. A probe written from the pattern rather than from the artifact
      // confirms only that the regex agrees with itself, so the probe for this
      // term is now a priced rate too.
      const ctx = ctxFor({ "skills/alpha/SKILL.md": `${HEAD}\nBudget line: ${price}\n` });
      expect(checkContent(ctx).some((i) => i.rule === "content.denylist")).toBe(true);
    },
  );

  test("a routing tier written as configuration is flagged", () => {
    // `model_tier` was covered and a bare `tier:` was not, while the sibling
    // effort rule needs no qualifier -- so `effort: high` was caught and
    // `tier: high` was not. A routing ladder in YAML writes the bare key.
    const ctx = ctxFor({ "skills/alpha/SKILL.md": `${HEAD}\ntier: high\n` });
    expect(checkContent(ctx).some((i) => i.rule === "content.denylist")).toBe(true);
  });

  test("the review persona tiers this repo declares are not routing tiers", () => {
    // policies/review.yaml carries twenty-odd `tier:` keys whose values are
    // always-on, conditional, stack-conditional, standards-gate. The rule
    // enumerates ladder values on purpose so those stay legal: measured across
    // the whole repository, the assignment form matches zero existing lines.
    const ctx = ctxFor({
      "skills/alpha/SKILL.md": HEAD,
      "policies/review.yaml":
        "personas:\n  - id: a\n    tier: always-on\n  - id: b\n    tier: conditional\n  - id: c\n    tier: stack-conditional\n",
    });
    expect(checkContent(ctx).filter((i) => i.rule === "content.denylist")).toEqual([]);
  });

  test("research/ is out of scan scope, so its exemption is defensive rather than a boundary", () => {
    // Measured on this repository: if research/ were scanned it would raise 651
    // hits under research/sources/ and 129 under research/dossiers/, every one
    // of them donor text quoted on purpose. The entry cannot suppress anything
    // today because nothing under research/ is offered to the scanner. It is
    // kept so that adding research/ to SCAN_DIRS fails safe rather than raising
    // 780 errors, and this pins the relationship so the entry is not misread as
    // a boundary someone drew.
    expect(contentScanRoots()).not.toContain("research");
    expect(DENYLIST_EXEMPT_PREFIXES).toContain("research/");
  });

  test("the exemption boundary: a denied term is evidence under tests/ and a defect under src/", () => {
    const term = sampleModelTerm();
    const ctx = ctxFor({
      "skills/alpha/SKILL.md": HEAD,
      "tests/anything.test.ts": `const sample = "${term}";\n`,
      "src/thing.ts": `const m = "${term}";\n`,
    });
    const flagged = checkContent(ctx)
      .filter((i) => i.rule === "content.denylist")
      .map((i) => i.file);
    expect(flagged).toEqual(["src/thing.ts"]);
  });
});

describe("placeholder scan", () => {
  test.each(["TODO: write this", "TBD", "lorem ipsum dolor", "a placeholder here"])(
    "%s in an authored body is an error",
    (line) => {
      const ctx = ctxFor({ "skills/alpha/SKILL.md": `${HEAD}\n${line}\n` });
      const issue = checkContent(ctx).find((i) => i.rule === "content.placeholder");
      expect(issue?.severity).toBe("error");
    },
  );

  test("the placeholder scan is scoped to authored bodies, so meta-docs may name the rule", () => {
    const ctx = ctxFor({
      "skills/alpha/SKILL.md": HEAD,
      "AGENTS.md": "No placeholders. TODO, TBD, lorem and placeholder fail validation.\n",
    });
    expect(checkContent(ctx).filter((i) => i.rule === "content.placeholder")).toEqual([]);
  });

  test("a clean authored body produces nothing", () => {
    const ctx = ctxFor({ "skills/alpha/SKILL.md": `${HEAD}\nRun the checks and report evidence.\n` });
    expect(checkContent(ctx)).toEqual([]);
  });
});

describe("application-local documentation write targets", () => {
  test.each(["Write findings to CONTEXT.md.", "Store it under docs/solutions/ for later.", "Add docs/adr/0001.md."])(
    "%s in a skill body is an error citing ADR-0001",
    (line) => {
      const ctx = ctxFor({ "skills/alpha/SKILL.md": `${HEAD}\n${line}\n` });
      const issue = checkContent(ctx).find((i) => i.rule === "content.local-doc-target");
      expect(issue?.severity).toBe("error");
      expect(issue?.message).toContain("ADR-0001");
    },
  );

  test("the ADR itself may name the paths it replaces", () => {
    const ctx = ctxFor({
      "skills/alpha/SKILL.md": HEAD,
      "docs/decisions/0001-kb-document-vocabulary.md": "CONTEXT.md and docs/solutions/ are replaced.\n",
    });
    expect(checkContent(ctx).filter((i) => i.rule === "content.local-doc-target")).toEqual([]);
  });

  test("a KB adapter call is the accepted form and passes", () => {
    const ctx = ctxFor({ "skills/alpha/SKILL.md": `${HEAD}\nPublish through the KB adapter as a gotcha page.\n` });
    expect(checkContent(ctx)).toEqual([]);
  });
});
