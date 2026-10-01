import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  DOCUMENT_FILE,
  DOCUMENT_REFERENCE,
  checkProvenance,
  parseGLocator,
  parseLocatorField,
} from "../src/validation/provenance.ts";
import { loadCatalog } from "../src/catalog/load.ts";
import { writeAdaptations } from "../src/packaging/build.ts";
import { makeTree } from "./helpers/tree.ts";

const CATALOG = `schema_version: 1
package:
  id: ak
  name: agent-kit
  version: 0.1.0
  namespace: "/ak:"
  default_profile: core
skills:
  - id: adapted
    status: authored
    invocation: U
    provenance_origin: donor
  - id: invented
    status: authored
    invocation: M
    provenance_origin: conversation
schemas:
  - id: common
    status: contract
`;

const TRANSCRIPT = `${"line\n".repeat(2263)}line`;

function ctxFor(files: Record<string, string>) {
  const root = makeTree({
    "catalog.yaml": CATALOG,
    "skills/adapted/SKILL.md": "---\nname: adapted\ndescription: d\n---\nbody\n",
    "skills/invented/SKILL.md": "---\nname: invented\ndescription: d\n---\nbody\n",
    "research/sources/grok-transcript.md": TRANSCRIPT,
    ...files,
  });
  const { catalog } = loadCatalog(root);
  if (catalog === null) throw new Error("fixture has no catalog");
  return { root, catalog };
}

/** A real donor clone: the pin check shells out to git, so the test does too. */
function makeDonorRepo(
  root: string,
  dir: string,
  files: Record<string, string>,
  links: Record<string, string> = {},
): string {
  const full = join(root, dir);
  mkdirSync(full, { recursive: true });
  const git = (...args: string[]) => execFileSync("git", ["-C", full, ...args], { encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  for (const [rel, contents] of Object.entries(files)) {
    mkdirSync(join(full, rel, ".."), { recursive: true });
    writeFileSync(join(full, rel), contents);
  }
  // Symlinks are committed, not just made: the three donors that carry them
  // (AGENTS.md -> CLAUDE.md, .agy/skills -> ../skills, .claude/skills ->
  // ../.agents/skills) are what forced the mode check, so a fixture that cannot
  // hold one cannot test it.
  for (const [rel, target] of Object.entries(links)) {
    mkdirSync(join(full, rel, ".."), { recursive: true });
    symlinkSync(target, join(full, rel));
  }
  git("add", "-A");
  git("commit", "-q", "-m", "seed");
  return git("rev-parse", "HEAD").trim();
}

function lockFor(commit: string): string {
  return `schema_version: 1
donors:
  - id: donor-one
    repo: example/one
    path: .donors/donor_one
    commit: ${commit}
    license: MIT
`;
}

/**
 * The real map is capability-keyed: one row per capability, pointing at the
 * entry directory it landed in. An entry's coverage is therefore resolved
 * through `destination`, never through an id that happens to match.
 */
const CONVERSATION_MAP = `schema_version: 1
capabilities:
  - id: invented-capability
    disposition: retained
    destination: skills/invented
    origin: conversation
    locator: G:L1672-1676
`;

describe("G:L locator parsing", () => {
  test("accepts a single line and a range", () => {
    expect(parseGLocator("G:L1672")).toEqual({ start: 1672, end: 1672 });
    expect(parseGLocator("G:L1672-1676")).toEqual({ start: 1672, end: 1676 });
  });

  test("rejects a malformed locator", () => {
    expect(parseGLocator("L1672")).toBeNull();
    expect(parseGLocator("G:1672")).toBeNull();
    expect(parseGLocator("G:L")).toBeNull();
  });

  test("rejects an inverted range: start must be <= end", () => {
    expect(parseGLocator("G:L1676-1672")).toBeNull();
  });
});

describe("donor provenance", () => {
  test("an adapted file whose donor path exists at the pin passes", () => {
    const root = makeTree({
      "catalog.yaml": CATALOG,
      "skills/adapted/SKILL.md": "---\nname: adapted\ndescription: d\n---\nbody\n",
      "skills/invented/SKILL.md": "---\nname: invented\ndescription: d\n---\nbody\n",
      "research/sources/grok-transcript.md": TRANSCRIPT,
      "provenance/conversation-map.yaml": CONVERSATION_MAP,
    });
    const commit = makeDonorRepo(root, ".donors/donor_one", { "skills/brainstorm/SKILL.md": "# Brainstorm\n" });
    writeFileSync(join(root, "provenance/upstream.lock.yaml"), lockFor(commit));
    mkdirSync(join(root, "provenance/adaptations.d"), { recursive: true });
    writeFileSync(
      join(root, "provenance/adaptations.d/batch-1.yaml"),
      `adaptations:\n  - path: skills/adapted/SKILL.md\n    source: donor-one@${commit}:skills/brainstorm/SKILL.md\n`,
    );
    const { catalog } = loadCatalog(root);
    // A real tree has the generated file beside its fragments; build it so the
    // assertion is about the donor pin and not about a tree that never built.
    expect(writeAdaptations({ root, catalog: catalog! })).toEqual([]);
    expect(checkProvenance({ root, catalog: catalog! }).filter((i) => i.severity === "error")).toEqual([]);
  });

  test("a donor path that does not exist at the pin is an error naming the pin", () => {
    const root = makeTree({
      "catalog.yaml": CATALOG,
      "skills/adapted/SKILL.md": "---\nname: adapted\ndescription: d\n---\nbody\n",
      "skills/invented/SKILL.md": "---\nname: invented\ndescription: d\n---\nbody\n",
      "research/sources/grok-transcript.md": TRANSCRIPT,
      "provenance/conversation-map.yaml": CONVERSATION_MAP,
    });
    const commit = makeDonorRepo(root, ".donors/donor_one", { "skills/brainstorm/SKILL.md": "# Brainstorm\n" });
    writeFileSync(join(root, "provenance/upstream.lock.yaml"), lockFor(commit));
    mkdirSync(join(root, "provenance/adaptations.d"), { recursive: true });
    writeFileSync(
      join(root, "provenance/adaptations.d/batch-1.yaml"),
      `adaptations:\n  - path: skills/adapted/SKILL.md\n    source: donor-one@${commit}:skills/ghost/SKILL.md\n`,
    );
    const { catalog } = loadCatalog(root);
    const issue = checkProvenance({ root, catalog: catalog! }).find((i) => i.rule === "provenance.source-not-at-pin");
    expect(issue?.severity).toBe("error");
    expect(issue?.message).toContain("skills/ghost/SKILL.md");
  });

  /**
   * What a donor path is, not merely whether the pin has something there.
   *
   * `git cat-file -e` and `cat-file -t` both accept a symlink -- git types one
   * as a blob -- so the old check passed a row whose "source" is ten bytes of
   * target path rather than the text the row claims was adapted. Three of the
   * six pinned donors carry exactly that shape at their repository root
   * (AGENTS.md -> CLAUDE.md and the inverse), so it is a live hazard here, not
   * a hypothetical one. These cases use a real git repository for the same
   * reason: a hand-built fixture would be a copy of the mode table, and a copy
   * of the table proves the copy works.
   */
  function symlinkTree(source: string) {
    const root = makeTree({
      "catalog.yaml": CATALOG,
      "skills/adapted/SKILL.md": "---\nname: adapted\ndescription: d\n---\nbody\n",
      "skills/invented/SKILL.md": "---\nname: invented\ndescription: d\n---\nbody\n",
      "research/sources/grok-transcript.md": TRANSCRIPT,
      "provenance/conversation-map.yaml": CONVERSATION_MAP,
    });
    const commit = makeDonorRepo(
      root,
      ".donors/donor_one",
      { "CLAUDE.md": "# Guide\n", "skills/ce-work/SKILL.md": "# Work\n", ".agents/notes.md": "# Notes\n" },
      // `.agy/skills` mirrors the link that resolves in compound-engineering;
      // `.claude/skills` mirrors the one that resolves to nothing at its pin.
      { "AGENTS.md": "CLAUDE.md", ".agy/skills": "../skills", ".claude/skills": "../.agents/skills" },
    );
    writeFileSync(join(root, "provenance/upstream.lock.yaml"), lockFor(commit));
    mkdirSync(join(root, "provenance/adaptations.d"), { recursive: true });
    writeFileSync(
      join(root, "provenance/adaptations.d/batch-1.yaml"),
      `adaptations:\n  - path: skills/adapted/SKILL.md\n    source: donor-one@${commit}:${source}\n`,
    );
    const { catalog } = loadCatalog(root);
    return checkProvenance({ root, catalog: catalog! });
  }

  test("a row naming a symlink is rejected, though git calls it a blob", () => {
    const issue = symlinkTree("AGENTS.md").find((i) => i.rule === "provenance.source-is-symlink");
    expect(issue?.severity).toBe("error");
    expect(issue?.message).toContain("records the target path");
  });

  test("the symlink rejection names the file the row should have cited", () => {
    const issue = symlinkTree("AGENTS.md").find((i) => i.rule === "provenance.source-is-symlink");
    expect(issue?.message).toContain("Cite 'CLAUDE.md', the file it points at.");
  });

  test("a row naming a directory is rejected, and not as a missing path", () => {
    const issues = symlinkTree("skills");
    expect(issues.find((i) => i.rule === "provenance.source-is-directory")?.severity).toBe("error");
    expect(issues.some((i) => i.rule === "provenance.source-not-at-pin")).toBe(false);
  });

  test("a path through a symlinked directory is repaired, because git resolves neither", () => {
    // ls-tree returns nothing for a path crossing a link, so this arrives as
    // not-at-pin. Walking the prefix is what turns it into a one-line fix.
    const issue = symlinkTree(".agy/skills/ce-work/SKILL.md").find((i) => i.rule === "provenance.source-not-at-pin");
    expect(issue?.message).toContain("Cite 'skills/ce-work/SKILL.md'");
  });

  /**
   * The constraint that makes the suggestion worth printing.
   *
   * Measured on the two real symlinked skill directories in the pinned donors:
   * `.agy/skills -> ../skills` resolves to a file that is there, and
   * `.claude/skills -> ../.agents/skills` resolves to a path the pin does not
   * contain. One of two would have produced a confident repair pointing at
   * nothing, inside an error about a path that points at nothing.
   */
  test("a repair that does not resolve at the pin is not offered at all", () => {
    const issue = symlinkTree(".claude/skills/ce-work/SKILL.md").find((i) => i.rule === "provenance.source-not-at-pin");
    expect(issue?.severity).toBe("error");
    expect(issue?.message).not.toContain("Cite");
  });

  test("a row naming an ordinary file still passes, so the check did not just start failing", () => {
    expect(symlinkTree("skills/ce-work/SKILL.md").filter((i) => i.rule.startsWith("provenance.source"))).toEqual([]);
  });

  test("an adapted entry with no adaptations row at all is an error", () => {
    const ctx = ctxFor({
      "provenance/upstream.lock.yaml": lockFor("0".repeat(40)),
      "provenance/adaptations.d/batch-1.yaml": "adaptations: []\n",
      "provenance/conversation-map.yaml": CONVERSATION_MAP,
    });
    const issue = checkProvenance(ctx).find((i) => i.rule === "provenance.missing-adaptation");
    expect(issue?.severity).toBe("error");
    expect(issue?.message).toContain("skills/adapted");
  });

  test("a malformed source locator is an error", () => {
    const ctx = ctxFor({
      "provenance/upstream.lock.yaml": lockFor("0".repeat(40)),
      "provenance/adaptations.d/batch-1.yaml":
        "adaptations:\n  - path: skills/adapted/SKILL.md\n    source: not-a-locator\n",
      "provenance/conversation-map.yaml": CONVERSATION_MAP,
    });
    expect(checkProvenance(ctx).some((i) => i.rule === "provenance.malformed-source")).toBe(true);
  });

  test("an unknown donor id is an error", () => {
    const ctx = ctxFor({
      "provenance/upstream.lock.yaml": lockFor("0".repeat(40)),
      "provenance/adaptations.d/batch-1.yaml":
        "adaptations:\n  - path: skills/adapted/SKILL.md\n    source: nobody@0000000000000000000000000000000000000000:x.md\n",
      "provenance/conversation-map.yaml": CONVERSATION_MAP,
    });
    expect(checkProvenance(ctx).some((i) => i.rule === "provenance.unknown-donor")).toBe(true);
  });

  test("a row citing a commit other than the pin is a warning naming both", () => {
    const ctx = ctxFor({
      "provenance/upstream.lock.yaml": lockFor("a".repeat(40)),
      "provenance/adaptations.d/batch-1.yaml":
        "adaptations:\n  - path: skills/adapted/SKILL.md\n    source: donor-one@bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb:x.md\n",
      "provenance/conversation-map.yaml": CONVERSATION_MAP,
    });
    const issue = checkProvenance(ctx).find((i) => i.rule === "provenance.commit-not-pinned");
    expect(issue?.severity).toBe("warning");
  });

  test("absent .donors/ is reported as skipped, never as a failure", () => {
    const ctx = ctxFor({
      "provenance/upstream.lock.yaml": lockFor("a".repeat(40)),
      "provenance/adaptations.d/batch-1.yaml":
        "adaptations:\n  - path: skills/adapted/SKILL.md\n    source: donor-one@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:x.md\n",
      "provenance/conversation-map.yaml": CONVERSATION_MAP,
    });
    const issues = checkProvenance(ctx);
    expect(issues.some((i) => i.rule === "provenance.donors-unavailable" && i.severity === "note")).toBe(true);
    expect(issues.some((i) => i.rule === "provenance.source-not-at-pin")).toBe(false);
  });

  test("every fragment under provenance/adaptations.d/ counts toward the merged view", () => {
    const ctx = ctxFor({
      "provenance/upstream.lock.yaml": lockFor("a".repeat(40)),
      "provenance/adaptations.d/batch-3.yaml":
        "adaptations:\n  - path: skills/adapted/SKILL.md\n    source: donor-one@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:x.md\n",
      "provenance/conversation-map.yaml": CONVERSATION_MAP,
    });
    expect(checkProvenance(ctx).some((i) => i.rule === "provenance.missing-adaptation")).toBe(false);
  });

  test("a hand-written provenance/adaptations.yaml is not an input; the fragments are", () => {
    const ctx = ctxFor({
      "provenance/upstream.lock.yaml": lockFor("a".repeat(40)),
      "provenance/adaptations.yaml":
        "adaptations:\n  - path: skills/adapted/SKILL.md\n    source: donor-one@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:x.md\n",
      "provenance/conversation-map.yaml": CONVERSATION_MAP,
    });
    const issues = checkProvenance(ctx);
    expect(issues.some((i) => i.rule === "provenance.missing-adaptation")).toBe(true);
    expect(issues.some((i) => i.rule === "provenance.adaptations-out-of-sync")).toBe(true);
  });
});

describe("local-source provenance", () => {
  const REPORT = "first\nsecond\nthird\n";
  const REPORT_DIGEST = createHash("sha256").update(REPORT, "utf8").digest("hex");
  const localLock = `schema_version: 1
donors: []
local_sources:
  - id: report
    working_copy: research/sources/report.md
    sha256: ${REPORT_DIGEST}
    lines: 3
    cited_in_adaptations: true
`;

  function localSourceIssues(source: string, path = "skills/invented/SKILL.md") {
    const ctx = ctxFor({
      "provenance/upstream.lock.yaml": localLock,
      "provenance/adaptations.d/batch-1.yaml": `adaptations:\n  - path: ${path}\n    source: ${source}\n`,
      "provenance/conversation-map.yaml": CONVERSATION_MAP,
      "research/sources/report.md": REPORT,
    });
    writeAdaptations(ctx);
    return checkProvenance(ctx);
  }

  test("an adaptation can cite an anchored local-source range without requiring donor clones", () => {
    const issues = localSourceIssues(`local:report@sha256:${REPORT_DIGEST}#L1-2`);
    expect(issues.filter((i) => i.severity === "error" && i.file !== "skills/adapted")).toEqual([]);
    expect(issues.some((i) => i.rule === "provenance.donors-unavailable")).toBe(false);
  });

  test("a local row does not stand in for the donor row a donor-origin entry owes", () => {
    const issues = localSourceIssues(`local:report@sha256:${REPORT_DIGEST}#L1-2`, "skills/adapted/SKILL.md");
    const issue = issues.find((i) => i.rule === "provenance.missing-adaptation");
    expect(issue?.severity).toBe("error");
    expect(issue?.message).toContain("skills/adapted");
  });

  test("a local adaptation digest must equal the digest registered for that source", () => {
    const issues = localSourceIssues(`local:report@sha256:${"0".repeat(64)}#L1-2`);
    const issue = issues.find((i) => i.rule === "provenance.local-adaptation-digest-mismatch");
    expect(issue?.severity).toBe("error");
    expect(issue?.message).toContain(REPORT_DIGEST.slice(0, 12));
  });

  test("a single-line local range is not a spelling the route accepts", () => {
    const issues = localSourceIssues(`local:report@sha256:${REPORT_DIGEST}#L2`);
    const issue = issues.find((i) => i.rule === "provenance.malformed-source");
    expect(issue?.severity).toBe("error");
  });

  test("a local adaptation range must resolve inside the registered source", () => {
    const issues = localSourceIssues(`local:report@sha256:${REPORT_DIGEST}#L2-4`);
    const issue = issues.find((i) => i.rule === "provenance.local-adaptation-range");
    expect(issue?.severity).toBe("error");
    expect(issue?.message).toContain("3 lines");
  });
});

describe("conversation provenance", () => {
  test("a conversation-origin entry with a valid in-range locator passes", () => {
    const ctx = ctxFor({
      "provenance/conversation-map.yaml": CONVERSATION_MAP,
      "provenance/adaptations.d/batch-1.yaml": "adaptations: []\n",
    });
    expect(checkProvenance(ctx).filter((i) => i.rule.startsWith("provenance.g-locator"))).toEqual([]);
  });

  test("a conversation-origin entry with no map row is an error", () => {
    const ctx = ctxFor({
      "provenance/conversation-map.yaml": "capabilities: []\n",
      "provenance/adaptations.d/batch-1.yaml": "adaptations: []\n",
    });
    const issue = checkProvenance(ctx).find((i) => i.rule === "provenance.missing-conversation-origin");
    expect(issue?.message).toContain("invented");
  });

  test("a locator past the end of the transcript is an error naming the bound", () => {
    const ctx = ctxFor({
      "provenance/conversation-map.yaml":
        "capabilities:\n  - id: invented-capability\n    disposition: retained\n    destination: skills/invented\n    origin: conversation\n    locator: G:L9999\n",
      "provenance/adaptations.d/batch-1.yaml": "adaptations: []\n",
    });
    const issue = checkProvenance(ctx).find((i) => i.rule === "provenance.g-locator-out-of-range");
    expect(issue?.severity).toBe("error");
    expect(issue?.message).toContain("2264");
  });

  test("an inverted range is an error", () => {
    const ctx = ctxFor({
      "provenance/conversation-map.yaml":
        "capabilities:\n  - id: invented-capability\n    disposition: retained\n    destination: skills/invented\n    origin: conversation\n    locator: G:L200-100\n",
      "provenance/adaptations.d/batch-1.yaml": "adaptations: []\n",
    });
    expect(checkProvenance(ctx).some((i) => i.rule === "provenance.g-locator-invalid")).toBe(true);
  });

  test("a conversation-origin entry carrying a donor source path is a fabricated source", () => {
    const ctx = ctxFor({
      "provenance/conversation-map.yaml":
        "capabilities:\n  - id: invented-capability\n    disposition: retained\n    destination: skills/invented\n    origin: conversation\n    locator: G:L100\n    source: donor-one@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:x.md\n",
      "provenance/adaptations.d/batch-1.yaml": "adaptations: []\n",
    });
    const issue = checkProvenance(ctx).find((i) => i.rule === "provenance.fabricated-source");
    expect(issue?.severity).toBe("error");
  });

  test("a missing transcript is reported as skipped rather than failing every locator", () => {
    const root = makeTree({
      "catalog.yaml": CATALOG,
      "skills/adapted/SKILL.md": "---\nname: adapted\ndescription: d\n---\nbody\n",
      "skills/invented/SKILL.md": "---\nname: invented\ndescription: d\n---\nbody\n",
      "provenance/conversation-map.yaml": CONVERSATION_MAP,
      "provenance/adaptations.d/batch-1.yaml": "adaptations: []\n",
    });
    const { catalog } = loadCatalog(root);
    const issues = checkProvenance({ root, catalog: catalog! });
    expect(issues.some((i) => i.rule === "provenance.transcript-unavailable")).toBe(true);
    expect(issues.some((i) => i.rule === "provenance.g-locator-out-of-range")).toBe(false);
  });
});

describe("locator field grammar", () => {
  test("a field is a semicolon-separated list of one or more references", () => {
    expect(parseLocatorField("G:L2159-2173; G:L2072-2074")).toEqual([
      { kind: "transcript", start: 2159, end: 2173 },
      { kind: "transcript", start: 2072, end: 2074 },
    ]);
  });

  test("a single reference is still a valid field", () => {
    expect(parseLocatorField("G:L1672")).toEqual([{ kind: "transcript", start: 1672, end: 1672 }]);
  });

  test("a plan or arch section is a reference, and the plan outranks the transcript", () => {
    expect(parseLocatorField("plan §7.1")).toEqual([{ kind: "document", document: "plan", section: "7.1" }]);
    expect(parseLocatorField("arch §3")).toEqual([{ kind: "document", document: "arch", section: "3" }]);
    expect(parseLocatorField("plan §9 (Milestone 7)")).toEqual([
      { kind: "document", document: "plan", section: "9 (Milestone 7)" },
    ]);
  });

  test("transcript and document references mix in one field", () => {
    expect(parseLocatorField("G:L1668-1676; G:L1530-1532; plan §7.1")).toHaveLength(3);
  });

  test("free text is not a reference, so the widened grammar is not an escape hatch", () => {
    expect(parseLocatorField("see the discussion above")).toBeNull();
    expect(parseLocatorField("plan")).toBeNull();
    expect(parseLocatorField("plan §")).toBeNull();
    expect(parseLocatorField("")).toBeNull();
    expect(parseLocatorField(";")).toBeNull();
  });

  test("one bad reference fails the whole field rather than being skipped", () => {
    expect(parseLocatorField("G:L100; see above")).toBeNull();
    expect(parseLocatorField("G:L200-100; plan §2")).toBeNull();
  });

  test("every G:L reference in a multi-valued field is range-checked, not just the first", () => {
    const ctx = ctxFor({
      "provenance/conversation-map.yaml":
        "capabilities:\n  - id: invented-capability\n    disposition: retained\n    destination: skills/invented\n" +
        "    origin: conversation\n    locator: G:L100; G:L9999; plan §2.1\n",
      "provenance/adaptations.d/batch-1.yaml": "adaptations: []\n",
    });
    const issue = checkProvenance(ctx).find((i) => i.rule === "provenance.g-locator-out-of-range");
    expect(issue?.severity).toBe("error");
    expect(issue?.message).toContain("G:L9999");
  });

  test("a multi-valued field whose references all resolve passes", () => {
    const ctx = ctxFor({
      "provenance/conversation-map.yaml":
        "capabilities:\n  - id: invented-capability\n    disposition: retained\n    destination: skills/invented\n" +
        "    origin: conversation\n    locator: G:L2159-2173; G:L2072-2074; plan §7.1\n",
      "provenance/adaptations.d/batch-1.yaml": "adaptations: []\n",
    });
    expect(checkProvenance(ctx).filter((i) => i.rule.startsWith("provenance.g-locator"))).toEqual([]);
  });
});

describe("conversation-map destinations", () => {
  test("coverage is resolved through destination, not through an id that happens to match", () => {
    const ctx = ctxFor({
      "provenance/conversation-map.yaml":
        "capabilities:\n  - id: invented\n    disposition: retained\n    destination: skills/adapted\n" +
        "    origin: donor\n    locator: G:L100\n",
      "provenance/adaptations.d/batch-1.yaml": "adaptations: []\n",
    });
    const issue = checkProvenance(ctx).find((i) => i.rule === "provenance.missing-conversation-origin");
    expect(issue?.severity).toBe("error");
    expect(issue?.message).toContain("skills/invented");
  });

  test("several capabilities may land in one destination", () => {
    const ctx = ctxFor({
      "provenance/conversation-map.yaml":
        "capabilities:\n" +
        "  - id: cap-one\n    disposition: retained\n    destination: skills/invented\n    origin: conversation\n    locator: G:L100\n" +
        "  - id: cap-two\n    disposition: folded\n    destination: skills/invented\n    origin: conversation\n    locator: G:L200-210\n",
      "provenance/adaptations.d/batch-1.yaml": "adaptations: []\n",
    });
    expect(checkProvenance(ctx).some((i) => i.rule === "provenance.missing-conversation-origin")).toBe(false);
  });

  test("a destination no catalog entry owns is an error naming it", () => {
    const ctx = ctxFor({
      "provenance/conversation-map.yaml":
        "capabilities:\n  - id: invented-capability\n    disposition: retained\n    destination: skills/invented\n" +
        "    origin: conversation\n    locator: G:L100\n" +
        "  - id: ghost\n    disposition: retained\n    destination: skills/ghost\n    origin: conversation\n    locator: G:L120\n",
      "provenance/adaptations.d/batch-1.yaml": "adaptations: []\n",
    });
    const issue = checkProvenance(ctx).find((i) => i.rule === "provenance.destination-without-entry");
    expect(issue?.severity).toBe("error");
    expect(issue?.message).toContain("skills/ghost");
  });

  test("a destination naming a file-section entry resolves too", () => {
    const ctx = ctxFor({
      "provenance/conversation-map.yaml":
        "capabilities:\n  - id: invented-capability\n    disposition: retained\n    destination: skills/invented\n" +
        "    origin: conversation\n    locator: G:L100\n" +
        "  - id: envelope\n    disposition: retained\n    destination: schemas/common\n    origin: donor\n    locator: G:L130\n",
      "provenance/adaptations.d/batch-1.yaml": "adaptations: []\n",
    });
    expect(checkProvenance(ctx).some((i) => i.rule === "provenance.destination-without-entry")).toBe(false);
  });

  test("an excluded capability carries no destination and is not a drift", () => {
    const ctx = ctxFor({
      "provenance/conversation-map.yaml":
        "capabilities:\n  - id: invented-capability\n    disposition: retained\n    destination: skills/invented\n" +
        "    origin: conversation\n    locator: G:L100\n" +
        "  - id: dropped\n    disposition: excluded\n    origin: conversation\n    locator: G:L140; plan §2.6\n",
      "provenance/adaptations.d/batch-1.yaml": "adaptations: []\n",
    });
    const issues = checkProvenance(ctx);
    expect(issues.some((i) => i.rule === "provenance.destination-without-entry")).toBe(false);
    expect(issues.some((i) => i.rule === "provenance.capability-without-destination")).toBe(false);
  });

  test("a retained capability with nowhere to land is a warning", () => {
    const ctx = ctxFor({
      "provenance/conversation-map.yaml":
        "capabilities:\n  - id: invented-capability\n    disposition: retained\n    destination: skills/invented\n" +
        "    origin: conversation\n    locator: G:L100\n" +
        "  - id: homeless\n    disposition: retained\n    origin: conversation\n    locator: G:L150\n",
      "provenance/adaptations.d/batch-1.yaml": "adaptations: []\n",
    });
    const issue = checkProvenance(ctx).find((i) => i.rule === "provenance.capability-without-destination");
    expect(issue?.severity).toBe("warning");
    expect(issue?.message).toContain("homeless");
  });

  test("every row's locator is checked, not only the rows an authored entry reaches", () => {
    const ctx = ctxFor({
      "provenance/conversation-map.yaml":
        "capabilities:\n  - id: invented-capability\n    disposition: retained\n    destination: skills/invented\n" +
        "    origin: conversation\n    locator: G:L100\n" +
        "  - id: dropped\n    disposition: excluded\n    origin: conversation\n    locator: nowhere in particular\n",
      "provenance/adaptations.d/batch-1.yaml": "adaptations: []\n",
    });
    const issue = checkProvenance(ctx).find((i) => i.rule === "provenance.g-locator-invalid");
    expect(issue?.severity).toBe("error");
    expect(issue?.message).toContain("dropped");
  });
});

describe("amalgam provenance: a boundary the catalog created", () => {
  /** A map holding one amalgam row, so each test varies exactly one field. */
  function mapWith(fields: string): string {
    return `schema_version: 1
capabilities:
  - id: invented-capability
    disposition: retained
    destination: skills/invented
    origin: conversation
    locator: G:L1672-1676
  - id: seat-boundary
${fields}
`;
  }

  function amalgamIssues(fields: string) {
    const ctx = ctxFor({
      "provenance/conversation-map.yaml": mapWith(fields),
      "provenance/adaptations.d/batch-1.yaml": "adaptations: []\n",
    });
    return checkProvenance(ctx).filter(
      (i) => i.rule.startsWith("provenance.amalgam") || i.rule === "provenance.fabricated-source",
    );
  }

  const WELL_FORMED = `    disposition: retained
    destination: skills/adapted
    origin: amalgam
    locator: amalgam skills/adapted + skills/invented`;

  test("the locator grammar parses a seat pair", () => {
    expect(parseLocatorField("amalgam skills/adapted + skills/invented")).toEqual([
      { kind: "amalgam", left: "skills/adapted", right: "skills/invented" },
    ]);
  });

  test("a pair can sit beside a transcript range and a plan section", () => {
    expect(parseLocatorField("G:L10-12; amalgam skills/adapted + skills/invented; plan §2.1")).toHaveLength(3);
  });

  test("a half-written pair is not a locator", () => {
    expect(parseLocatorField("amalgam skills/adapted")).toBeNull();
    expect(parseLocatorField("amalgam skills/adapted +")).toBeNull();
  });

  test("a well-formed amalgam row passes", () => {
    expect(amalgamIssues(WELL_FORMED)).toEqual([]);
  });

  test("origin: amalgam with no pair in the locator is an error", () => {
    const issue = amalgamIssues(`    disposition: retained
    destination: skills/adapted
    origin: amalgam
    locator: G:L1672-1676`).find((i) => i.rule === "provenance.amalgam-origin-mismatch");
    expect(issue?.message).toContain("has recorded nothing");
  });

  test("a pair under any other origin is an error, so the label cannot drift", () => {
    const issue = amalgamIssues(`    disposition: retained
    destination: skills/adapted
    origin: conversation
    locator: amalgam skills/adapted + skills/invented`).find((i) => i.rule === "provenance.amalgam-origin-mismatch");
    expect(issue?.message).toContain("origin: conversation");
  });

  test("an endpoint the catalog does not declare is an error naming it", () => {
    const issue = amalgamIssues(`    disposition: retained
    destination: skills/adapted
    origin: amalgam
    locator: amalgam skills/adapted + skills/ghost`).find((i) => i.rule === "provenance.amalgam-endpoint-unknown");
    expect(issue?.message).toContain("skills/ghost");
  });

  test("a row landing outside its own pair is an error", () => {
    const issue = amalgamIssues(`    disposition: retained
    destination: skills/invented
    origin: amalgam
    locator: amalgam skills/adapted + skills/adapted`).find(
      (i) => i.rule === "provenance.amalgam-destination-outside-pair",
    );
    expect(issue?.message).toContain("skills/invented");
  });

  test("an amalgam row carrying a donor source is the same defect as a fabricated one", () => {
    const issue = amalgamIssues(`${WELL_FORMED}
    source: donor-one@abc1234:skills/brainstorm/SKILL.md`).find((i) => i.rule === "provenance.fabricated-source");
    expect(issue?.message).toContain("origin: amalgam");
  });
});

describe("a locator that parses is not a locator that resolves", () => {
  const PLAN_TEXT = "# Plan\n\n## 2. Scope\n\ntext\n\n### 2.1 A subsection\n\ntext\n\n## 9. Milestones\n\ntext\n";

  function rowIssues(locator: string, origin = "conversation", withPlan = true) {
    const files: Record<string, string> = {
      "provenance/conversation-map.yaml": `schema_version: 1
capabilities:
  - id: invented-capability
    disposition: retained
    destination: skills/invented
    origin: ${origin}
    locator: ${locator}
`,
      "provenance/adaptations.d/batch-1.yaml": "adaptations: []\n",
    };
    if (withPlan) files["research/sources/engineering-skills-repo-plan.md"] = PLAN_TEXT;
    return checkProvenance(ctxFor(files));
  }

  test("a document reference naming a real section passes", () => {
    expect(rowIssues("plan §2.1").filter((i) => i.rule === "provenance.document-reference-unresolved")).toEqual([]);
  });

  test("a reference to a section the plan does not have is an error", () => {
    const issue = rowIssues("plan §2.7").find((i) => i.rule === "provenance.document-reference-unresolved");
    expect(issue?.message).toContain("plan §2.7");
  });

  test("the parenthetical form resolves on its number", () => {
    expect(
      rowIssues("plan §9 (Milestone 7)").filter((i) => i.rule === "provenance.document-reference-unresolved"),
    ).toEqual([]);
  });

  test("an absent plan is a skip when a row cites a section, not a pass", () => {
    const issue = rowIssues("plan §2.1", "conversation", false).find((i) => i.rule === "provenance.plan-unavailable");
    expect(issue?.skipped).toBe("plan section references");
  });

  test("an absent plan is a note when nothing cites a section", () => {
    const issue = rowIssues("G:L10-12", "conversation", false).find((i) => i.rule === "provenance.plan-unavailable");
    expect(issue?.skipped).toBeUndefined();
  });

  test("an unknown origin is an error listing the three that exist", () => {
    const issue = rowIssues("G:L10-12", "invented-by-me").find((i) => i.rule === "provenance.unknown-origin");
    expect(issue?.message).toContain("donor, conversation, amalgam");
  });
});

describe("a line number is evidence only about the content it was taken against", () => {
  const BODY = "alpha\nbeta\ngamma\n";
  // sha256 of BODY, recomputed here rather than pasted so a change to BODY cannot
  // leave the fixture asserting against a digest of text that no longer exists.
  const DIGEST = createHash("sha256").update(BODY, "utf8").digest("hex");

  function lockWith(entry: string): string {
    return `schema_version: 1
donors: []
local_sources:
${entry}
`;
  }

  function anchorIssues(entry: string, extra: Record<string, string> = {}) {
    const ctx = ctxFor({
      "provenance/upstream.lock.yaml": lockWith(entry),
      "provenance/conversation-map.yaml": "schema_version: 1\ncapabilities: []\n",
      "provenance/adaptations.d/batch-1.yaml": "adaptations: []\n",
      "research/sources/design.md": BODY,
      ...extra,
    });
    return checkProvenance(ctx).filter((i) => i.rule.startsWith("provenance.local-source"));
  }

  const ANCHORED = `  - id: design
    working_copy: research/sources/design.md
    sha256: ${DIGEST}
    lines: 3`;

  test("an anchored source whose file is unchanged reports nothing", () => {
    expect(anchorIssues(ANCHORED)).toEqual([]);
  });

  test("a source registered without a digest is an error, not a silence", () => {
    const issues = anchorIssues(`  - id: design
    working_copy: research/sources/design.md`);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.rule).toBe("provenance.local-source-unanchored");
    expect(issues[0]?.severity).toBe("error");
  });

  test("the remediation does not tell the reader to use wc -l", () => {
    // The first run of this check failed on a count taken with `wc -l`, which
    // counts newlines and so misses the last line of a file that does not end in
    // one. Advice that reproduces the defect it is fixing is worse than none.
    const issues = anchorIssues(`  - id: design
    working_copy: research/sources/design.md`);
    expect(issues[0]?.message).toContain("do not use 'wc -l'");
  });

  test("editing the file breaks the anchor even when the line count is unchanged", () => {
    // The defect this check exists for: content moves, every locator still parses
    // and still passes its bounds check. A same-length edit is the hardest case.
    const issues = anchorIssues(ANCHORED, { "research/sources/design.md": "alpha\nBETA!\ngamma\n" });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.rule).toBe("provenance.local-source-modified");
    expect(issues[0]?.severity).toBe("error");
  });

  test("the failure says what to do, and says not to silence it by editing the digest", () => {
    const issues = anchorIssues(ANCHORED, { "research/sources/design.md": "alpha\nBETA!\ngamma\n" });
    expect(issues[0]?.message).toContain("re-derive the locators");
    expect(issues[0]?.message).toContain("Do not update the digest alone");
  });

  test("a wrong line count beside a matching digest indicts the register, not the tree", () => {
    const issues = anchorIssues(`  - id: design
    working_copy: research/sources/design.md
    sha256: ${DIGEST}
    lines: 99`);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.rule).toBe("provenance.local-source-line-count");
    expect(issues[0]?.message).toContain("correct lines to 3");
  });

  test("a file with no trailing newline counts its last line", () => {
    // `wc -l` reports 2 here and the range checker resolves L3, so the register
    // has to mean what the range checker means or the two disagree by one.
    const noTrailing = "alpha\nbeta\ngamma";
    const issues = anchorIssues(
      `  - id: design
    working_copy: research/sources/design.md
    sha256: ${createHash("sha256").update(noTrailing, "utf8").digest("hex")}
    lines: 3`,
      { "research/sources/design.md": noTrailing },
    );
    expect(issues).toEqual([]);
  });

  test("an absent file is a skip, because the check could not examine what it owns", () => {
    const ctx = ctxFor({
      "provenance/upstream.lock.yaml": lockWith(`  - id: design
    working_copy: research/sources/absent.md
    sha256: ${DIGEST}
    lines: 3`),
      "provenance/conversation-map.yaml": "schema_version: 1\ncapabilities: []\n",
      "provenance/adaptations.d/batch-1.yaml": "adaptations: []\n",
    });
    const issues = checkProvenance(ctx).filter((i) => i.rule === "provenance.local-source-unavailable");
    expect(issues).toHaveLength(1);
    expect(issues[0]?.skipped).toBe("local source anchors");
  });
});

describe("a scenario number that names nothing still reads as coverage", () => {
  const PLAN_10 = `# Plan

## 10. Evaluation and release gates

1. First scenario.
2. Second scenario.
3. Third scenario.

## 11. Next section

1. Not a scenario; this list belongs to another section.
`;

  function scenarioIssues(prose: string, plan: string = PLAN_10) {
    const ctx = ctxFor({
      "research/sources/engineering-skills-repo-plan.md": plan,
      "provenance/conversation-map.yaml": `schema_version: 1
capabilities:
  - id: some-capability
    disposition: retained
    destination: skills/adapted
    origin: conversation
    locator: G:L1-2
    acceptance_test: ${prose}
`,
      "provenance/adaptations.d/batch-1.yaml": "adaptations: []\n",
    });
    return checkProvenance(ctx).filter(
      (i) => i.rule === "provenance.unknown-scenario" || i.rule === "provenance.plan-scenarios-unavailable",
    );
  }

  test("a scenario inside the plan's list passes", () => {
    expect(scenarioIssues("Covers release scenario 2.")).toEqual([]);
  });

  test("a scenario past the end of the list is an error", () => {
    const issues = scenarioIssues("Covers release scenario 25.");
    expect(issues).toHaveLength(1);
    expect(issues[0]?.rule).toBe("provenance.unknown-scenario");
    expect(issues[0]?.severity).toBe("error");
  });

  test("the plural form is read as two references, not one", () => {
    // The spelling that defeated a hand count and a reviewer's regex on the same
    // day: `scenarios 3 and 9` has an `s` where a singular pattern expects a space.
    const issues = scenarioIssues("Covers release scenarios 3 and 9.");
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain("scenario 9");
  });

  test("the error names the line, because the map is long and the tag is prose", () => {
    const issues = scenarioIssues("Covers release scenario 25.");
    expect(issues[0]?.line).toBeGreaterThan(0);
  });

  test("the list is scoped to §10 and does not absorb a later section's numbering", () => {
    // §11 carries its own `1.` item. If the scan ran to end of file it would be
    // read as a scenario and the range would silently widen.
    expect(scenarioIssues("Covers release scenario 4.")).toHaveLength(1);
  });

  test("an unparseable §10 skips rather than indicting every reference", () => {
    const issues = scenarioIssues("Covers release scenarios 1 and 2.", "# Plan\n\n## Evaluation\n\nNo numbers.\n");
    expect(issues).toHaveLength(1);
    expect(issues[0]?.rule).toBe("provenance.plan-scenarios-unavailable");
    expect(issues[0]?.skipped).toBe("release scenario numbers");
    expect(issues[0]?.severity).not.toBe("error");
  });

  test("a map citing no scenario at all is silent, not skipped", () => {
    // Nothing to check is not the same as something unchecked, and a skip here
    // would report an instrument failure on a tree that has no subject for it.
    expect(scenarioIssues("Covers nothing numbered.")).toEqual([]);
  });
});

describe("plan and arch are two spellings of one document", () => {
  function archIssues(locator: string) {
    const ctx = ctxFor({
      "research/sources/engineering-skills-repo-plan.md": "# Plan\n\n## 5. A section the plan does have\n\nbody\n",
      "provenance/conversation-map.yaml": `schema_version: 1
capabilities:
  - id: some-capability
    disposition: retained
    destination: skills/adapted
    origin: conversation
    locator: ${locator}
`,
      "provenance/adaptations.d/batch-1.yaml": "adaptations: []\n",
    });
    // `document-unavailable` is kept in the filter with no producer left in
    // src/: if anything reintroduces it, the first test below fails rather than
    // the rule quietly returning.
    return checkProvenance(ctx).filter(
      (i) => i.rule === "provenance.document-unavailable" || i.rule === "provenance.document-reference-unresolved",
    );
  }

  test("arch \u00a75 resolves against the plan's \u00a75, because it is the same file", () => {
    // This asserted the opposite until the premise under it was checked. The
    // architecture document is not missing from this tree: it is
    // research/sources/engineering-skills-repo-plan.md, which ADR-0001 names as
    // its authority before citing the same sections as `arch \u00a78`. Erroring here
    // sent a writer using the canonical spelling to go hold a document the tree
    // already holds, and to register it in a lock where it is already registered.
    expect(archIssues("arch \u00a75")).toEqual([]);
  });

  test("the plan's own \u00a75 still resolves", () => {
    expect(archIssues("plan \u00a75")).toEqual([]);
  });

  test("a section the document does not have fails under either spelling", () => {
    // The identity has to hold in both directions. If only `plan` were checked,
    // `arch` would be a spelling that silently passes anything.
    for (const locator of ["plan \u00a799", "arch \u00a799"]) {
      const issues = archIssues(locator);
      expect(issues).toHaveLength(1);
      expect(issues[0]?.rule).toBe("provenance.document-reference-unresolved");
    }
  });

  test("the failure names the file rather than the keyword the row used", () => {
    // A writer who cites `arch` and a writer who cites `plan` are sent to the
    // same file to look, because there is only one file to look in.
    for (const locator of ["plan \u00a799", "arch \u00a799"]) {
      expect(archIssues(locator)[0]?.message).toContain("research/sources/engineering-skills-repo-plan.md");
    }
  });
});

describe("every keyword the grammar admits resolves somewhere", () => {
  // The population is the alternation inside DOCUMENT_REFERENCE, read from the
  // pattern rather than retyped here -- a list copied into a test drifts from
  // the thing it claims to cover, and then agrees with it by construction.
  function keywordsInGrammar(): string[] {
    const alternation = /\^\((([a-z]+\|)*[a-z]+)\)/.exec(DOCUMENT_REFERENCE.source);
    if (alternation?.[1] === undefined)
      throw new Error("could not read the keyword alternation out of DOCUMENT_REFERENCE");
    return alternation[1].split("|");
  }

  test("the grammar's keywords are the ones this test thinks they are", () => {
    // Guards the guard: if the pattern is restructured so the alternation stops
    // being readable, the check above must fail loudly rather than return [].
    expect(keywordsInGrammar()).toEqual(["plan", "arch"]);
  });

  test("each keyword has a DOCUMENT_FILE entry", () => {
    // Widening the grammar without deciding what the new keyword resolves
    // against fails here. Nothing in this repository typechecks, so the
    // Record<DocumentKeyword, string> annotation cannot do this job.
    for (const keyword of keywordsInGrammar()) {
      expect(Object.keys(DOCUMENT_FILE)).toContain(keyword);
    }
  });

  test("every keyword maps to a file the resolver has an index for", () => {
    // checkLocatorField resolves document references against one index, built
    // from PLAN. A keyword mapped to any other file would be checked against
    // the wrong sections -- the original defect, one indirection further out.
    for (const file of Object.values(DOCUMENT_FILE)) {
      expect(file).toBe("research/sources/engineering-skills-repo-plan.md");
    }
  });
});

/**
 * §5: "A `rationale:` that cites a section names the document, or it cites
 * nothing." `per dossier §24.2` shipped into `provenance/adaptations.yaml` at
 * `ae061b2` and a reviewer caught it, not a check.
 *
 * §5 also says the fragment and the generated artifact are two surfaces and a
 * repair to one is not a repair to both, so each case below is asserted on
 * whichever surface carries the defect rather than on the pair.
 */
describe("a section cited in a rationale names its document", () => {
  const PLAN_FILE = "research/sources/engineering-skills-repo-plan.md";
  const PLAN_TEXT = "# Plan\n\n## 5.5 Findings\n\nbody\n\n## 10. Release scenarios\n\n1. One\n";
  const SOURCE = "donor-one@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:x.md";

  function fragment(rationale: string): string {
    return `adaptations:\n  - path: skills/adapted/SKILL.md\n    source: ${SOURCE}\n    rationale: ${JSON.stringify(rationale)}\n`;
  }

  /** The merge copies each row verbatim, which is why both surfaces carry it. */
  function generated(rationale: string): string {
    return [
      "# Generated by `ak build` from provenance/adaptations.d/*.yaml. Do not edit this file.",
      "# Write surface: provenance/adaptations.d/<batch>.yaml, one fragment per batch.",
      "# Each adapted file is recorded here with an exact donor@commit:path or anchored local: source.",
      "adaptations:",
      "  - path: skills/adapted/SKILL.md",
      `    source: ${SOURCE}`,
      `    rationale: ${JSON.stringify(rationale)}`,
      "",
    ].join("\n");
  }

  function issuesFor(files: Record<string, string>, plan: string | null = PLAN_TEXT) {
    const tree: [string, string][] = [
      ["provenance/upstream.lock.yaml", lockFor("a".repeat(40))],
      ["provenance/conversation-map.yaml", CONVERSATION_MAP],
    ];
    if (plan !== null) tree.push([PLAN_FILE, plan]);
    const ctx = ctxFor({ ...Object.fromEntries(tree), ...files });
    return checkProvenance(ctx).filter((i) => i.rule.startsWith("provenance.rationale-"));
  }

  test("a bare section number in a fragment rationale is an error naming the file", () => {
    const issues = issuesFor({ "provenance/adaptations.d/batch-1.yaml": fragment("Adopted per dossier §24.2.") });
    expect(issues.map((i) => i.rule)).toEqual(["provenance.rationale-unanchored-section"]);
    expect(issues[0]?.severity).toBe("error");
    expect(issues[0]?.file).toBe("provenance/adaptations.d/batch-1.yaml");
    // The message carries the spelling that would be accepted, or the writer's
    // next attempt is a guess.
    expect(issues[0]?.message).toContain("plan §");
  });

  test("a rationale that cites no section is silent", () => {
    // The positive control. A rule that fired on every rationale would pass
    // every error-severity assertion above.
    expect(issuesFor({ "provenance/adaptations.d/batch-1.yaml": fragment("Severity and owner routing.") })).toEqual([]);
  });

  test("plan §N resolves and passes", () => {
    expect(
      issuesFor({ "provenance/adaptations.d/batch-1.yaml": fragment("Recorded conflict: plan §5.5's enum stands.") }),
    ).toEqual([]);
  });

  test("plan §N naming a section the plan does not have is an error", () => {
    // Anchoring is not resolution. A reference that parses is not one that
    // resolves, and the reason §8 distrusts positional references into a live
    // document is that they keep parsing after the document moves.
    const issues = issuesFor({ "provenance/adaptations.d/batch-1.yaml": fragment("See plan §99.") });
    expect(issues.map((i) => i.rule)).toEqual(["provenance.rationale-section-unresolved"]);
    expect(issues[0]?.severity).toBe("error");
  });

  test("arch is the plan's second spelling and resolves against the same index", () => {
    // `DOCUMENT_FILE` is where that is decided, so a rationale writing `arch §N`
    // is naming this tree's one design document under its other name. Resolved
    // rather than rejected -- and a section it does not have still fails, which
    // is the half that matters.
    expect(issuesFor({ "provenance/adaptations.d/batch-1.yaml": fragment("See arch §5.5.") })).toEqual([]);
    const issues = issuesFor({ "provenance/adaptations.d/batch-1.yaml": fragment("See arch §99.") });
    expect(issues.map((i) => i.rule)).toEqual(["provenance.rationale-section-unresolved"]);
  });

  test("a repair to the fragment alone leaves the published record failing", () => {
    // The case §5 names: the merge copies each row verbatim, so the defect
    // exists in two files from the moment it is written. A check reading only
    // the write surface would go green on a half-done repair -- and the
    // generated file is the one NOTICE points a downstream consumer at.
    const issues = issuesFor({
      "provenance/adaptations.d/batch-1.yaml": fragment("Adopted per the dossier."),
      "provenance/adaptations.yaml": generated("Adopted per dossier §24.2."),
    });
    expect(issues.map((i) => i.rule)).toEqual(["provenance.rationale-unanchored-section"]);
    expect(issues[0]?.file).toBe("provenance/adaptations.yaml");
  });

  test("a repair to the generated file alone leaves the fragment failing", () => {
    // The inverse, and the one that keeps the rule from being satisfiable by
    // editing the generated file -- which `ak build` would then overwrite.
    const issues = issuesFor({
      "provenance/adaptations.d/batch-1.yaml": fragment("Adopted per dossier §24.2."),
      "provenance/adaptations.yaml": generated("Adopted per the dossier."),
    });
    expect(issues.map((i) => i.rule)).toEqual(["provenance.rationale-unanchored-section"]);
    expect(issues[0]?.file).toBe("provenance/adaptations.d/batch-1.yaml");
  });

  test("both surfaces carrying it are reported once each", () => {
    const issues = issuesFor({
      "provenance/adaptations.d/batch-1.yaml": fragment("Adopted per dossier §24.2."),
      "provenance/adaptations.yaml": generated("Adopted per dossier §24.2."),
    });
    expect(issues.map((i) => i.file).sort()).toEqual([
      "provenance/adaptations.d/batch-1.yaml",
      "provenance/adaptations.yaml",
    ]);
  });

  test("with no plan in the tree an anchored reference is skipped, never passed", () => {
    // A reference that resolves against nothing looks exactly like one that
    // resolves.
    const issues = issuesFor({ "provenance/adaptations.d/batch-1.yaml": fragment("See plan §99.") }, null);
    expect(issues.map((i) => i.rule)).toEqual(["provenance.rationale-plan-unavailable"]);
    expect(issues[0]?.severity).not.toBe("error");
    expect(issues[0]?.skipped).toBe("plan sections cited in rationales");
  });

  test("with no plan in the tree an unanchored reference still fails", () => {
    // The anchoring half needs no plan and goes on failing closed without one.
    const issues = issuesFor({ "provenance/adaptations.d/batch-1.yaml": fragment("Adopted per dossier §24.2.") }, null);
    expect(issues.map((i) => i.rule)).toEqual(["provenance.rationale-unanchored-section"]);
    expect(issues[0]?.severity).toBe("error");
  });

  test("with no plan and no rationale citing a section, nothing is skipped", () => {
    // Nothing to check is not the same as something unchecked. A skip here
    // would report an instrument failure on a tree that has no subject for it.
    expect(
      issuesFor({ "provenance/adaptations.d/batch-1.yaml": fragment("Severity and owner routing.") }, null),
    ).toEqual([]);
  });

  test("a section reference in a key the merge drops is not this rule's subject", () => {
    // `conversation_origin_fragments` sits beside `adaptations:` and the merge
    // takes the adaptations list and nothing else, so its rows never reach the
    // published record. The adjacent sibling-key rule owns that case; widening
    // this one to reach it would report a defect on the wrong surface.
    const doc = [
      "adaptations: []",
      "conversation_origin_fragments:",
      "  - path: protocols/worktree-ownership/PROTOCOL.md",
      "    locator: G:L1668-1676",
      "    rationale: Anchored in the plan at §5.3 and §10 scenario 13.",
      "",
    ].join("\n");
    expect(issuesFor({ "provenance/adaptations.d/batch-1.yaml": doc })).toEqual([]);
  });
});
