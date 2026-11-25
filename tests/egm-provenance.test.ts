/**
 * This file pins named claim-bearing strings byte-exact after CRLF is folded
 * to LF. Markdown locators match only outside fenced code and HTML comments.
 * A table row matches when its first cell, trimmed, equals the key. Each
 * locator must match exactly once. The lock is YAML: the donor with id egm
 * is selected and its fields are asserted. Free-text claims elsewhere are
 * review's job.
 */
import { describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import { parse, stringify } from "yaml";

import { DENY_TERMS, matchTerms } from "../src/denylist.ts";
import { loadAdaptationFragments, loadDonors, parseDonorSource } from "../src/validation/provenance.ts";
import { processScratch } from "./helpers/process-tmp.ts";

const REPO = resolve(import.meta.dir, "..");
const EGM_COMMIT = "403d8881d62022490637d740657b33f01e321ea8";
const EGM_COMMIT_DATE = "2026-10-30T08:43:28Z";
const EGM_COPYRIGHT = "Copyright 2026 Google LLC";
const EGM_LICENSE_FILE = "provenance/licenses/google_elephant-goldfish-model.LICENSE";
const LOCK = "provenance/upstream.lock.yaml";
const CLAUDE_ISOLATION_ROW =
  "| `isolated-review-context` | `partial` | The host provides fresh-context subagents. It provides no attestation that a reviewer context never saw the author's narrative, so the package cannot verify the property it depends on. GS-004e live Claude Code and Codex arms did not run (GAP-PROBE, `research/host-facts/2026-11-18/GAP-PROBE.md`). That coverage limit is not a pass |";
const MIT_CATALOG_IDS = [
  "compound-engineering",
  "superpowers",
  "pocock",
  "addy",
  "omc",
  "omx",
  "builderio-skills",
  "pstack",
  "claude-reflect",
  "common-skills",
] as const;
const CATALOG_PREFIXES = [
  "skills/",
  "roles/",
  "packs/",
  "protocols/",
  "references/",
  "policies/",
  "adapters/",
] as const;

type SurfacePin = {
  file: string;
  kind: "row" | "block";
  locator: string;
  expected: string;
};

const SURFACES: SurfacePin[] = [
  {
    file: "research/host-facts/2026-11-18/GAP-PROBE.md",
    kind: "block",
    locator: "Coverage limit,",
    expected: `Coverage limit, not a pass. The GS-004e Claude Code and Codex probe arms did
not run. They need a host login nobody granted. No credential was copied, read,
or used.`,
  },
  {
    file: "research/host-facts/2026-11-18/GAP-PROBE.md",
    kind: "block",
    locator: "Every arm below is",
    expected: "Every arm below is `not-run`. None is `pass`.",
  },
  {
    file: "research/host-facts/2026-11-18/GAP-PROBE.md",
    kind: "row",
    locator: "parent-turn",
    expected: "| parent-turn | none planted | not-run | live spawn needs an authenticated host CLI |",
  },
  {
    file: "research/host-facts/2026-11-18/GAP-PROBE.md",
    kind: "row",
    locator: "hooks-and-memory",
    expected: "| hooks-and-memory | none planted | not-run | live spawn needs an authenticated host CLI |",
  },
  {
    file: "research/host-facts/2026-11-18/GAP-PROBE.md",
    kind: "row",
    locator: "auto-loaded-instructions",
    expected: "| auto-loaded-instructions | none planted | not-run | live spawn needs an authenticated host CLI |",
  },
  {
    file: "research/host-facts/2026-11-18/GAP-PROBE.md",
    kind: "row",
    locator: "transcript-on-disk",
    expected: "| transcript-on-disk | none planted | not-run | live spawn needs an authenticated host CLI |",
  },
  {
    file: "research/host-facts/2026-11-18/GAP-PROBE.md",
    kind: "row",
    locator: "role-file-denied",
    expected: "| role-file-denied | none planted | not-run | live spawn needs an authenticated host CLI |",
  },
  {
    file: "research/host-facts/2026-11-18/GAP-PROBE.md",
    kind: "block",
    locator: "The same five arms on Codex",
    expected: "The same five arms on Codex are `not-run` for the same reason. Codex",
  },
  {
    file: "adapters/claude-code/CONTRACT.md",
    kind: "row",
    locator: "`isolated-review-context`",
    expected: CLAUDE_ISOLATION_ROW,
  },
  {
    file: ".cursor/references/shared/adapters/claude-code/CONTRACT.md",
    kind: "row",
    locator: "`isolated-review-context`",
    expected: CLAUDE_ISOLATION_ROW,
  },
  {
    file: "adapters/cursor/CONTRACT.md",
    kind: "row",
    locator: "`isolated-review-context`",
    expected:
      "| `isolated-review-context` | `partial` | Docs only, not session-tested. Custom subagents have their own context window and start clean ([subagents](https://cursor.com/docs/subagents)). The parent includes whatever it puts in the task prompt. The host does not attest that a reviewer never saw the author's narrative. Upgrade when a Cloud Agent reviewer subagent whose prompt omitted the author's narrative cannot read the parent transcript |",
  },
  {
    file: "src/review-isolation-probe/hosts.ts",
    kind: "block",
    locator: " * GAP-PROBE:",
    expected: ` * GAP-PROBE: the GS-004e Claude Code and Codex live probe arms did not run.
 * They need a host login nobody granted. Recorded, not a pass. Do not copy,
 * read, or use any credential. See research/host-facts/2026-11-18/GAP-PROBE.md.`,
  },
  {
    file: "README.md",
    kind: "block",
    locator: "`google/elephant-goldfish-model` (Apache-2.0",
    expected: `\`google/elephant-goldfish-model\` (Apache-2.0, Google LLC, pinned at its 2026-10-30 commit) is the second
Apache-2.0 catalog donor. It feeds the comprehension seat, the ticket cold read, and the
review-isolation probe. It ships no NOTICE file. The licence text is in \`provenance/licenses/\`,
the root \`NOTICE\` carries an attribution entry, and each adapted file records what was changed.
See \`research/dossiers/egm.md\`.`,
  },
  {
    file: "research/dossiers/egm.md",
    kind: "row",
    locator: "Commit",
    expected: `| Commit | \`${EGM_COMMIT}\`, committed ${EGM_COMMIT_DATE} |`,
  },
  {
    file: "research/dossiers/egm.md",
    kind: "row",
    locator: "License",
    expected: `| License | Apache-2.0. \`egm@${EGM_COMMIT}:LICENSE\`. Byte-identical to \`provenance/licenses/google_elephant-goldfish-model.LICENSE\`. Copyright 2026 Google LLC |`,
  },
  {
    file: "src/review-isolation-probe/children.ts",
    kind: "block",
    locator: " * Adapted from EGM",
    expected: ` * Adapted from EGM tests/integration/test_claude.py and test_codex.py at
 * elephant-goldfish-model@${EGM_COMMIT}.`,
  },
  {
    file: "NOTICE",
    kind: "block",
    locator: "The installable catalog adapts material from",
    expected: `The installable catalog adapts material from twelve catalog donors: ten under
the MIT License and two under the Apache License 2.0 (claude-mem and
google/elephant-goldfish-model).`,
  },
  {
    file: "NOTICE",
    kind: "block",
    locator: "provenance/licenses/BayramAnnakov_claude-reflect.LICENSE",
    expected: `provenance/licenses/BayramAnnakov_claude-reflect.LICENSE
provenance/licenses/BuilderIO_skills.LICENSE
provenance/licenses/EveryInc_compound-engineering-plugin.LICENSE
provenance/licenses/Yeachan-Heo_oh-my-claudecode.LICENSE
provenance/licenses/Yeachan-Heo_oh-my-codex.LICENSE
provenance/licenses/addyosmani_agent-skills.LICENSE
provenance/licenses/cursor_plugins.LICENSE
provenance/licenses/google_elephant-goldfish-model.LICENSE
provenance/licenses/mattpocock_skills.LICENSE
provenance/licenses/mizchi_jev-lint.LICENSE
provenance/licenses/obra_superpowers.LICENSE
provenance/licenses/thedotmack_claude-mem.LICENSE
provenance/licenses/thedotmack_claude-mem.NOTICE
provenance/licenses/warpdotdev_common-skills.LICENSE`,
  },
  {
    file: "NOTICE",
    kind: "block",
    locator: "- elephant-goldfish-model —",
    expected: `- elephant-goldfish-model — Copyright 2026 Google LLC — Apache License 2.0
  https://github.com/google/elephant-goldfish-model @ ${EGM_COMMIT}
  The files adapted from elephant-goldfish-model were modified;
  provenance/adaptations.yaml states the change for each. The license text is
  provenance/licenses/google_elephant-goldfish-model.LICENSE. EGM ships no
  NOTICE file, so nothing is quoted here.`,
  },
  {
    file: "AGENTS.md",
    kind: "block",
    locator: "twelve donors —",
    expected: `twelve donors — ten MIT, two Apache-2.0 (claude-mem, which feeds only the opt-in learning runtime,
and google/elephant-goldfish-model (Google LLC), which feeds the comprehension seat, the ticket cold read, and
the review-isolation probe) — into *one* lifecycle rather than shipping four plugins that fight
over activation descriptions.`,
  },
  {
    file: "research/dossiers/egm.md",
    kind: "block",
    locator: "Count those files with the catalog donors",
    expected: `Count those files with the catalog donors, not with the
research-only pins (\`tester-army-e2e\`, \`blocks\`).`,
  },
];

function catalogDonorLicenses(root: string): Map<string, string> {
  const { donors } = loadDonors(root);
  const { rows } = loadAdaptationFragments(root);
  const catalog = new Map<string, string>();
  for (const row of rows) {
    const src = parseDonorSource(row.source);
    if (src === null) continue;
    if (!CATALOG_PREFIXES.some((prefix) => row.path.startsWith(prefix))) continue;
    const donor = donors.get(src.donor);
    if (donor === undefined || donor.license === "") continue;
    catalog.set(src.donor, donor.license);
  }
  return catalog;
}

function expectTwelveCatalogDonors(catalog: Map<string, string>): void {
  const apache: string[] = [];
  const mit: string[] = [];
  for (const [id, license] of catalog) {
    if (license === "Apache-2.0") apache.push(id);
    else if (license === "MIT") mit.push(id);
  }
  expect(catalog.size).toBe(12);
  expect(mit.toSorted()).toEqual([...MIT_CATALOG_IDS].toSorted());
  expect(apache.toSorted()).toEqual(["claude-mem", "egm"]);
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface EgmLockEntry {
  id: string;
  commit: string;
  commit_date: string;
  license: string;
  copyright: string;
}

interface LockDoc {
  donors: unknown[];
}

const isLockDoc = new Ajv2020({ strict: false }).compile<LockDoc>({
  type: "object",
  required: ["donors"],
  properties: { donors: { type: "array" } },
});

const isEgmLockEntry = new Ajv2020({ strict: false }).compile<EgmLockEntry>({
  type: "object",
  required: ["id", "commit", "commit_date", "license", "copyright"],
  properties: {
    id: { type: "string" },
    commit: { type: "string" },
    commit_date: { type: "string" },
    license: { type: "string" },
    copyright: { type: "string" },
  },
});

function egmLockFields(root: string): EgmLockEntry | undefined {
  const value: unknown = parse(readFileSync(join(root, LOCK), "utf8"));
  if (!isLockDoc(value)) return undefined;
  for (const entry of value.donors) {
    if (isEgmLockEntry(entry) && entry.id === "egm") return entry;
  }
  return undefined;
}

type CommentScan = { out: string; inComment: boolean };
type VisibleLines = { ok: true; lines: string[] } | { ok: false; reason: string };

function consumeVisible(line: string, inComment: boolean): CommentScan {
  let out = "";
  let i = 0;
  let comment = inComment;
  if (comment) {
    const end = line.indexOf("-->");
    if (end === -1) return { out: "", inComment: true };
    i = end + 3;
    comment = false;
  }
  while (i < line.length) {
    const start = line.indexOf("<!--", i);
    if (start === -1) {
      out += line.slice(i);
      break;
    }
    out += line.slice(i, start);
    const end = line.indexOf("-->", start + 4);
    if (end === -1) return { out, inComment: true };
    i = end + 3;
  }
  return { out, inComment: comment };
}

function markdownVisible(text: string): VisibleLines {
  const lines: string[] = [];
  let inFence = false;
  let inComment = false;
  for (const line of text.replaceAll("\r\n", "\n").split("\n")) {
    if (!inComment) {
      const trimmed = line.trimStart();
      if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
        inFence = !inFence;
        continue;
      }
    }
    if (inFence) continue;
    const consumed = consumeVisible(line, inComment);
    inComment = consumed.inComment;
    if (consumed.out.length > 0) lines.push(consumed.out);
    else if (!inComment && line.length === 0) lines.push("");
  }
  if (inFence) return { ok: false, reason: "unclosed-fence" };
  if (inComment) return { ok: false, reason: "unclosed-comment" };
  return { ok: true, lines };
}

function firstCell(line: string): string | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|")) return undefined;
  const cells = trimmed.split("|");
  if (cells.length < 3) return undefined;
  return cells[1]?.trim();
}

function locatorHits(body: string, locator: string): number[] {
  const hits: number[] = [];
  let from = 0;
  while (from <= body.length - locator.length) {
    const at = body.indexOf(locator, from);
    if (at === -1) break;
    hits.push(at);
    from = at + 1;
  }
  return hits;
}

function located(text: string, pin: SurfacePin): string {
  const visible = markdownVisible(text);
  const status = visible.ok ? "ok" : visible.reason;
  expect(status, `${pin.file}: ${status}`).toBe("ok");
  if (!visible.ok) return "";
  if (pin.kind === "row") {
    const hits = visible.lines.filter((line) => firstCell(line) === pin.locator);
    expect(hits.length, `${pin.file} ${pin.locator} matches=${hits.length}`).toBe(1);
    return hits[0] ?? "";
  }
  const body = visible.lines.join("\n");
  const hits = locatorHits(body, pin.locator);
  expect(hits.length, `${pin.file} ${pin.locator} matches=${hits.length}`).toBe(1);
  const at = hits[0] ?? 0;
  return body.slice(at, at + pin.expected.length);
}

function sectionAfter(text: string, heading: string): string {
  const needle = `## ${heading}`;
  const start = text.indexOf(needle);
  expect(start, heading).toBeGreaterThanOrEqual(0);
  const rest = text.slice(start + needle.length);
  const next = rest.search(/\n## /);
  return next === -1 ? rest : rest.slice(0, next);
}

function labelledIds(block: string, label: string): string[] {
  const match = new RegExp(`${escapeRegex(label)}:\\s*([\\s\\S]*?)(?:\\n- |\\n\\n|$)`).exec(block);
  expect(match, label).toBeTruthy();
  return (match?.[1] ?? "")
    .split(/[,\n]/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function yamlItemBlock(text: string, idLine: string): string {
  const start = text.indexOf(idLine);
  expect(start, idLine).toBeGreaterThanOrEqual(0);
  const rest = text.slice(start + idLine.length);
  const next = rest.search(/\n  - id: /);
  return idLine + (next === -1 ? rest : rest.slice(0, next));
}

function lockLicenseFile(lockText: string, id: string): string {
  const block = yamlItemBlock(lockText, `\n  - id: ${id}\n`);
  const match = /\n    license_file: (\S+)/.exec(block);
  expect(match, id).toBeTruthy();
  return match?.[1] ?? "";
}

describe("EGM provenance (GS-004f)", () => {
  test("pins google/elephant-goldfish-model at the PRD commit", () => {
    const { donors } = loadDonors(REPO);
    const egm = donors.get("egm");
    expect(egm?.commit).toBe(EGM_COMMIT);
    expect(egm?.license).toBe("Apache-2.0");
    const fields = egmLockFields(REPO);
    expect(fields).toBeDefined();
    expect(fields?.commit).toBe(EGM_COMMIT);
    expect(fields?.commit_date).toBe(EGM_COMMIT_DATE);
    expect(fields?.license).toBe("Apache-2.0");
    expect(fields?.copyright).toBe(EGM_COPYRIGHT);
  });

  test("counts twelve catalog donors, ten MIT and two Apache-2.0", () => {
    expectTwelveCatalogDonors(catalogDonorLicenses(REPO));
  });

  test("public donor-count prose names twelve catalog donors, ten MIT and two Apache-2.0", () => {
    const surfaces: Array<[string, RegExp]> = [
      ["README.md", /twelve donors \(ten MIT-licensed, two Apache-2\.0\)/],
      ["catalog.yaml", /twelve donors: ten MIT, two Apache-2\.0/],
      ["package.json", /twelve donors \(ten MIT, two Apache-2\.0\)/],
      [".claude-plugin/marketplace.json", /twelve donors \(ten MIT, two Apache-2\.0\)/],
      ["NOTICE", /twelve catalog donors: ten under\s+the MIT License and two under the Apache License 2.0/],
    ];
    for (const [rel, pattern] of surfaces) {
      expect(readFileSync(join(REPO, rel), "utf8"), rel).toMatch(pattern);
    }
  });

  test("re-indenting the lock keeps the pin and the catalog counts", () => {
    const original = readFileSync(join(REPO, LOCK), "utf8");
    const rewritten = stringify(parse(original), { indent: 4 });
    const scratch = processScratch("egm-lock-indent-");
    mkdirSync(join(scratch, "provenance"));
    writeFileSync(join(scratch, LOCK), rewritten);
    cpSync(join(REPO, "provenance/adaptations.d"), join(scratch, "provenance/adaptations.d"), {
      recursive: true,
    });
    const { donors } = loadDonors(scratch);
    const egm = donors.get("egm");
    expect(egm?.commit).toBe(EGM_COMMIT);
    expect(egm?.license).toBe("Apache-2.0");
    const fields = egmLockFields(scratch);
    expect(fields).toBeDefined();
    expect(fields?.commit).toBe(EGM_COMMIT);
    expect(fields?.commit_date).toBe(EGM_COMMIT_DATE);
    expect(fields?.license).toBe("Apache-2.0");
    expect(fields?.copyright).toBe(EGM_COPYRIGHT);
    expectTwelveCatalogDonors(catalogDonorLicenses(scratch));
  });

  test("SURFACES pins match the claim-bearing strings byte-exact", () => {
    for (const pin of SURFACES) {
      const text = readFileSync(join(REPO, pin.file), "utf8");
      expect(located(text, pin), pin.file).toBe(pin.expected);
    }
  });

  test("each catalog donor's lock license matches the counted set and its licence file", () => {
    const catalog = catalogDonorLicenses(REPO);
    const { donors } = loadDonors(REPO);
    const lockText = readFileSync(join(REPO, LOCK), "utf8");
    expectTwelveCatalogDonors(catalog);
    expect(lockLicenseFile(lockText, "egm")).toBe(EGM_LICENSE_FILE);
    for (const [id, license] of catalog) {
      expect(donors.get(id)?.license, id).toBe(license);
      const licenseFile = lockLicenseFile(lockText, id);
      expect(existsSync(join(REPO, licenseFile)), licenseFile).toBe(true);
      const text = readFileSync(join(REPO, licenseFile), "utf8");
      if (license === "Apache-2.0") {
        expect(text, licenseFile).toContain("Apache License");
        expect(text, licenseFile).toMatch(/Version 2\.0/);
      } else {
        expect(text, licenseFile).toMatch(/MIT License|Permission is hereby granted/);
      }
    }
  });

  test("research/dossiers/egm.md carries no denylist term", () => {
    const dossier = readFileSync(join(REPO, "research/dossiers/egm.md"), "utf8");
    expect(matchTerms(dossier, DENY_TERMS)).toEqual([]);
    const catalogCount = sectionAfter(dossier, "6. Catalog count");
    expect(labelledIds(catalogCount, "ten MIT").toSorted()).toEqual([...MIT_CATALOG_IDS].toSorted());
    expect(labelledIds(catalogCount, "two Apache-2.0").toSorted()).toEqual(["claude-mem", "egm"]);
  });

  test("finding.schema.json status and fingerprint descriptions name both phase-1b rulings", () => {
    const schema = readFileSync(join(REPO, "schemas/finding.schema.json"), "utf8");
    expect(schema).toMatch(/"status": \{\s*"description": "[^"]*comprehension-gap-not-contestable/);
    expect(schema).toMatch(/"fingerprint": \{\s*"description": "[^"]*comprehension-seat-stays-naive/);
  });

  test("the two phase-1b rulings name both seats and the four resolutions", () => {
    const rulings = readFileSync(join(REPO, "policies/resolved-conflicts.yaml"), "utf8");
    expect(rulings).toContain("id: comprehension-seat-stays-naive");
    expect(rulings).toContain("id: comprehension-gap-not-contestable");
    expect(rulings).toContain("ticket cold reader");
    expect(rulings).toContain("never rejected on the author's word");
    expect(yamlItemBlock(rulings, "\n  - id: comprehension-seat-stays-naive\n")).toContain("references: [delegation]");
    const delegation = readFileSync(join(REPO, "references/delegation/REFERENCE.md"), "utf8");
    expect(delegation).toContain("no prior-finding packet (ruling `comprehension-seat-stays-naive`)");
    expect(readFileSync(join(REPO, "skills/super-bound/SKILL.md"), "utf8")).toContain("comprehension-seat-stays-naive");
    expect(readFileSync(join(REPO, "skills/super-bound/skill.yaml"), "utf8")).toContain(
      "comprehension-seat-stays-naive",
    );
  });
});
