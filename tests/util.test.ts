import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { canonicalJson, artifactHash, sha256Hex } from "../src/util/hash.ts";
import { parseFrontmatter } from "../src/util/frontmatter.ts";
import { walkFiles, readTextIfPresent, listDirs } from "../src/util/fs.ts";
import { DENY_TERMS, PLACEHOLDER_TERMS, SCANNER_DEFINITION_FILE, matchTerms } from "../src/denylist.ts";
import { processScratch } from "./helpers/process-tmp.ts";

function tmpRoot(): string {
  return processScratch("ak-util-");
}

describe("canonical hashing", () => {
  test("canonicalJson sorts keys recursively and drops insignificant whitespace", () => {
    const a = canonicalJson({ b: 1, a: { d: 2, c: [3, { f: 4, e: 5 }] } });
    expect(a).toBe('{"a":{"c":[3,{"e":5,"f":4}],"d":2},"b":1}');
  });

  test("canonicalJson is stable across key insertion order", () => {
    expect(canonicalJson({ x: 1, y: 2 })).toBe(canonicalJson({ y: 2, x: 1 }));
  });

  test("artifactHash removes the top-level approvals member", () => {
    const bare = { schema: "ticket", id: "T-1" };
    const approved = { schema: "ticket", id: "T-1", approvals: [{ by: "human" }] };
    expect(artifactHash(approved)).toBe(artifactHash(bare));
  });

  test("artifactHash is a sha256: prefixed 64 hex digest", () => {
    expect(artifactHash({ id: "T-1" })).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test("artifactHash changes when a non-approval field changes", () => {
    expect(artifactHash({ id: "T-1", goal: "a" })).not.toBe(artifactHash({ id: "T-1", goal: "b" }));
  });

  test("sha256Hex hashes raw text", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });
});

describe("frontmatter parsing", () => {
  test("splits YAML frontmatter from the body and records the body start line", () => {
    const fm = parseFrontmatter("---\nname: foo\ndescription: bar\n---\n\n# Title\ntext\n");
    expect(fm.present).toBe(true);
    expect(fm.data).toEqual({ name: "foo", description: "bar" });
    expect(fm.body.trimStart().startsWith("# Title")).toBe(true);
    expect(fm.bodyStartLine).toBe(5);
  });

  test("reports absence rather than throwing when there is no frontmatter", () => {
    const fm = parseFrontmatter("# Title\n");
    expect(fm.present).toBe(false);
    expect(fm.data).toEqual({});
    expect(fm.body).toBe("# Title\n");
  });

  test("reports a parse error instead of throwing on malformed YAML", () => {
    const fm = parseFrontmatter("---\nname: [unclosed\n---\nbody\n");
    expect(fm.present).toBe(true);
    expect(fm.error).toBeTruthy();
  });

  test("keeps key order so frontmatter key checks can report the offending line", () => {
    const fm = parseFrontmatter("---\nname: foo\nallowed-tools: [Read]\n---\nbody\n");
    expect(fm.keyLines["allowed-tools"]).toBe(3);
  });
});

describe("filesystem helpers", () => {
  test("walkFiles returns repo-relative posix paths and skips ignored directories", () => {
    const root = tmpRoot();
    mkdirSync(join(root, "skills", "a"), { recursive: true });
    mkdirSync(join(root, "node_modules", "x"), { recursive: true });
    writeFileSync(join(root, "skills", "a", "SKILL.md"), "hi");
    writeFileSync(join(root, "node_modules", "x", "index.js"), "hi");
    const files = walkFiles(root, "skills");
    expect(files).toEqual(["skills/a/SKILL.md"]);
    expect(walkFiles(root, ".")).not.toContain("node_modules/x/index.js");
  });

  test("walkFiles on a missing directory returns empty rather than throwing", () => {
    expect(walkFiles(tmpRoot(), "does-not-exist")).toEqual([]);
  });

  test("readTextIfPresent returns null for a missing file", () => {
    expect(readTextIfPresent(join(tmpRoot(), "nope.md"))).toBeNull();
  });

  test("listDirs returns only directories, sorted", () => {
    const root = tmpRoot();
    mkdirSync(join(root, "packs", "b"), { recursive: true });
    mkdirSync(join(root, "packs", "a"), { recursive: true });
    writeFileSync(join(root, "packs", "README.md"), "x");
    expect(listDirs(join(root, "packs"))).toEqual(["a", "b"]);
  });
});

describe("scanner term definitions", () => {
  test("exposes a non-empty denylist and names its own definition file for self-exemption", () => {
    expect(DENY_TERMS.length).toBeGreaterThan(5);
    expect(SCANNER_DEFINITION_FILE).toBe("src/denylist.ts");
  });

  test("every deny term carries an id, a kind and a human-readable reason", () => {
    const ids = new Set<string>();
    for (const term of DENY_TERMS) {
      expect(term.id.length).toBeGreaterThan(0);
      expect(term.reason.length).toBeGreaterThan(0);
      expect(["model-name", "pricing", "ladder"]).toContain(term.kind);
      expect(ids.has(term.id)).toBe(false);
      ids.add(term.id);
    }
  });

  test("ordinary English is not matched by the short model-name terms", () => {
    const prose =
      "The solution is solid and the terrain of the problem is well understood. " +
      "A terrace of options, lunar phases, a fabled approach, and an opusculum of notes. " +
      "Consolidate, absolve, resolve, console, hapaxes, terracotta, astral projection.";
    expect(matchTerms(prose, DENY_TERMS)).toEqual([]);
  });

  test("a bare model name in prose is matched", () => {
    const sample = DENY_TERMS.find((t) => t.kind === "model-name");
    expect(sample).toBeDefined();
    const hits = matchTerms(`we should route this to ${sample!.probe} for review`, DENY_TERMS);
    expect(hits.length).toBeGreaterThan(0);
  });

  test("every deny term's own probe string matches its own pattern", () => {
    for (const term of DENY_TERMS) {
      const sample = term.anchored === true ? term.probe : `prefix ${term.probe} suffix`;
      const hits = matchTerms(sample, [term]);
      expect({ id: term.id, hit: hits.length > 0 }).toEqual({ id: term.id, hit: true });
    }
  });

  test("pricing and ladder shapes are matched, prose about them is not", () => {
    // Written as literals on purpose. The probe round-trip above already proves
    // each pattern matches its own probe; what these lines add is that the
    // patterns fire on the real-world shapes an author would actually type, and
    // that the paired negatives do not. tests/ is exempt from the scan for
    // exactly this (see DENYLIST_EXEMPT_PREFIXES).
    expect(matchTerms("cost is $/1M tokens", DENY_TERMS).length).toBeGreaterThan(0);
    expect(matchTerms("priced per 1M tokens", DENY_TERMS).length).toBeGreaterThan(0);
    expect(matchTerms("reasoning_effort: high", DENY_TERMS).length).toBeGreaterThan(0);
    expect(matchTerms("model_tier: 2", DENY_TERMS).length).toBeGreaterThan(0);
    expect(matchTerms("No effort ladder or escalation tier appears in this catalog.", DENY_TERMS)).toEqual([]);
    expect(matchTerms("tier: always-on", DENY_TERMS)).toEqual([]);
    expect(matchTerms("Model routing is stripped, and the stripping is enforced", DENY_TERMS)).toEqual([]);
  });

  test("placeholder terms match on word boundaries", () => {
    expect(matchTerms("TODO: finish this", PLACEHOLDER_TERMS).length).toBe(1);
    expect(matchTerms("TBD", PLACEHOLDER_TERMS).length).toBe(1);
    expect(matchTerms("lorem ipsum", PLACEHOLDER_TERMS).length).toBe(1);
    expect(matchTerms("a placeholder value", PLACEHOLDER_TERMS).length).toBe(1);
    expect(matchTerms("the toddler placeholders", PLACEHOLDER_TERMS).length).toBe(0);
  });

  test("matchTerms reports 1-based line numbers", () => {
    const hits = matchTerms("clean\nclean\nTODO here\n", PLACEHOLDER_TERMS);
    expect(hits[0]?.line).toBe(3);
  });
});
