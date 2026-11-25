/**
 * Dated evidence files are pinned by sha256 of the raw bytes. Living docs pin
 * whole lines: after CRLF is folded to LF, a locator must match exactly one
 * trimmed line, counting fenced and commented copies, and that line must equal
 * expected. Do not paste an honest example of a pinned line into that file.
 * The lock is YAML. One loader walks donors, rejects duplicate ids, coerces a
 * Date commit_date, and asserts the egm fields. Duplicate-id rejection lives
 * in this test, not in loadDonors (product last-wins is out of scope here).
 * Free-text claims elsewhere are review's job.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
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
const GAP_PROBE = "research/host-facts/2026-11-18/GAP-PROBE.md";
const GAP_PROBE_SHA256 = "73f79b67e12b388b09b482959faaf83c4370f664d6476f4eec321cd830e322ca";
const CLAUDE_ISOLATION_ROW =
  "| `isolated-review-context` | `partial` | The host provides fresh-context subagents. It provides no attestation that a reviewer context never saw the author's narrative, so the package cannot verify the property it depends on. GS-004e live Claude Code and Codex arms did not run (GAP-PROBE, `research/host-facts/2026-11-18/GAP-PROBE.md`). That coverage limit is not a pass |";
const CURSOR_ISOLATION_ROW =
  "| `isolated-review-context` | `partial` | Docs only, not session-tested. Custom subagents have their own context window and start clean ([subagents](https://cursor.com/docs/subagents)). The parent includes whatever it puts in the task prompt. The host does not attest that a reviewer never saw the author's narrative. Upgrade when a Cloud Agent reviewer subagent whose prompt omitted the author's narrative cannot read the parent transcript |";
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

type LinePin = { file: string; locator: string; expected: string };

const EVIDENCE_HASHES: Array<{ file: string; sha256: string }> = [{ file: GAP_PROBE, sha256: GAP_PROBE_SHA256 }];

const LINE_PINS: LinePin[] = [
  {
    file: "adapters/claude-code/CONTRACT.md",
    locator: "| `isolated-review-context` |",
    expected: CLAUDE_ISOLATION_ROW,
  },
  {
    file: ".cursor/references/shared/adapters/claude-code/CONTRACT.md",
    locator: "| `isolated-review-context` |",
    expected: CLAUDE_ISOLATION_ROW,
  },
  {
    file: "adapters/cursor/CONTRACT.md",
    locator: "| `isolated-review-context` |",
    expected: CURSOR_ISOLATION_ROW,
  },
  {
    file: "src/review-isolation-probe/hosts.ts",
    locator: " * GAP-PROBE:",
    expected: " * GAP-PROBE: the GS-004e Claude Code and Codex live probe arms did not run.",
  },
  {
    file: "src/review-isolation-probe/hosts.ts",
    locator: " * They need a host login nobody granted. Recorded, not a pass.",
    expected: " * They need a host login nobody granted. Recorded, not a pass. Do not copy,",
  },
  {
    file: "src/review-isolation-probe/hosts.ts",
    locator: " * read, or use any credential.",
    expected: " * read, or use any credential. See research/host-facts/2026-11-18/GAP-PROBE.md.",
  },
  {
    file: "README.md",
    locator: "`google/elephant-goldfish-model` (Apache-2.0",
    expected:
      "`google/elephant-goldfish-model` (Apache-2.0, Google LLC, pinned at its 2026-10-30 commit) is the second",
  },
  {
    file: "README.md",
    locator: "Apache-2.0 catalog donor. It feeds the comprehension seat",
    expected: "Apache-2.0 catalog donor. It feeds the comprehension seat, the ticket cold read, and the",
  },
  {
    file: "README.md",
    locator: "review-isolation probe. It ships no NOTICE file.",
    expected: "review-isolation probe. It ships no NOTICE file. The licence text is in `provenance/licenses/`,",
  },
  {
    file: "README.md",
    locator: "the root `NOTICE` carries an attribution entry",
    expected: "the root `NOTICE` carries an attribution entry, and each adapted file records what was changed.",
  },
  {
    file: "README.md",
    locator: "See `research/dossiers/egm.md`.",
    expected: "See `research/dossiers/egm.md`.",
  },
  {
    file: "research/dossiers/egm.md",
    locator: "| Commit |",
    expected: `| Commit | \`${EGM_COMMIT}\`, committed ${EGM_COMMIT_DATE} |`,
  },
  {
    file: "research/dossiers/egm.md",
    locator: "| License |",
    expected: `| License | Apache-2.0. \`egm@${EGM_COMMIT}:LICENSE\`. Byte-identical to \`provenance/licenses/google_elephant-goldfish-model.LICENSE\`. Copyright 2026 Google LLC |`,
  },
  {
    file: "research/dossiers/egm.md",
    locator: "cold read. Count those files with the catalog donors",
    expected: "cold read. Count those files with the catalog donors, not with the",
  },
  {
    file: "research/dossiers/egm.md",
    locator: "research-only pins (`tester-army-e2e`",
    expected: "research-only pins (`tester-army-e2e`, `blocks`).",
  },
  {
    file: "src/review-isolation-probe/children.ts",
    locator: " * Adapted from EGM",
    expected: " * Adapted from EGM tests/integration/test_claude.py and test_codex.py at",
  },
  {
    file: "src/review-isolation-probe/children.ts",
    locator: ` * elephant-goldfish-model@${EGM_COMMIT}.`,
    expected: ` * elephant-goldfish-model@${EGM_COMMIT}.`,
  },
  {
    file: "NOTICE",
    locator: "The installable catalog adapts material from",
    expected: "The installable catalog adapts material from twelve catalog donors: ten under",
  },
  {
    file: "NOTICE",
    locator: "the MIT License and two under the Apache License 2.0 (claude-mem and",
    expected: "the MIT License and two under the Apache License 2.0 (claude-mem and",
  },
  {
    file: "NOTICE",
    locator: "google/elephant-goldfish-model). Each adapted",
    expected: "google/elephant-goldfish-model). Each adapted",
  },
  {
    file: "NOTICE",
    locator: "provenance/licenses/BayramAnnakov_claude-reflect.LICENSE",
    expected: "provenance/licenses/BayramAnnakov_claude-reflect.LICENSE",
  },
  {
    file: "NOTICE",
    locator: "provenance/licenses/BuilderIO_skills.LICENSE",
    expected: "provenance/licenses/BuilderIO_skills.LICENSE",
  },
  {
    file: "NOTICE",
    locator: "provenance/licenses/EveryInc_compound-engineering-plugin.LICENSE",
    expected: "provenance/licenses/EveryInc_compound-engineering-plugin.LICENSE",
  },
  {
    file: "NOTICE",
    locator: "provenance/licenses/Yeachan-Heo_oh-my-claudecode.LICENSE",
    expected: "provenance/licenses/Yeachan-Heo_oh-my-claudecode.LICENSE",
  },
  {
    file: "NOTICE",
    locator: "provenance/licenses/Yeachan-Heo_oh-my-codex.LICENSE",
    expected: "provenance/licenses/Yeachan-Heo_oh-my-codex.LICENSE",
  },
  {
    file: "NOTICE",
    locator: "provenance/licenses/addyosmani_agent-skills.LICENSE",
    expected: "provenance/licenses/addyosmani_agent-skills.LICENSE",
  },
  {
    file: "NOTICE",
    locator: "provenance/licenses/cursor_plugins.LICENSE",
    expected: "provenance/licenses/cursor_plugins.LICENSE",
  },
  {
    file: "NOTICE",
    locator: "provenance/licenses/google_elephant-goldfish-model.LICENSE",
    expected: "provenance/licenses/google_elephant-goldfish-model.LICENSE",
  },
  {
    file: "NOTICE",
    locator: "provenance/licenses/mattpocock_skills.LICENSE",
    expected: "provenance/licenses/mattpocock_skills.LICENSE",
  },
  {
    file: "NOTICE",
    locator: "provenance/licenses/mizchi_jev-lint.LICENSE",
    expected: "provenance/licenses/mizchi_jev-lint.LICENSE",
  },
  {
    file: "NOTICE",
    locator: "provenance/licenses/obra_superpowers.LICENSE",
    expected: "provenance/licenses/obra_superpowers.LICENSE",
  },
  {
    file: "NOTICE",
    locator: "provenance/licenses/thedotmack_claude-mem.LICENSE",
    expected: "provenance/licenses/thedotmack_claude-mem.LICENSE",
  },
  {
    file: "NOTICE",
    locator: "provenance/licenses/thedotmack_claude-mem.NOTICE",
    expected: "provenance/licenses/thedotmack_claude-mem.NOTICE",
  },
  {
    file: "NOTICE",
    locator: "provenance/licenses/warpdotdev_common-skills.LICENSE",
    expected: "provenance/licenses/warpdotdev_common-skills.LICENSE",
  },
  {
    file: "NOTICE",
    locator: "- elephant-goldfish-model —",
    expected: "- elephant-goldfish-model — Copyright 2026 Google LLC — Apache License 2.0",
  },
  {
    file: "NOTICE",
    locator: "  https://github.com/google/elephant-goldfish-model @",
    expected: `  https://github.com/google/elephant-goldfish-model @ ${EGM_COMMIT}`,
  },
  {
    file: "NOTICE",
    locator: "  The files adapted from elephant-goldfish-model were modified;",
    expected: "  The files adapted from elephant-goldfish-model were modified;",
  },
  {
    file: "NOTICE",
    locator: "  provenance/adaptations.yaml states the change for each.",
    expected: "  provenance/adaptations.yaml states the change for each. The license text is",
  },
  {
    file: "NOTICE",
    locator: "  provenance/licenses/google_elephant-goldfish-model.LICENSE. EGM ships no",
    expected: "  provenance/licenses/google_elephant-goldfish-model.LICENSE. EGM ships no",
  },
  {
    file: "NOTICE",
    locator: "  NOTICE file, so nothing is quoted here.",
    expected: "  NOTICE file, so nothing is quoted here.",
  },
  {
    file: "AGENTS.md",
    locator: "twelve donors —",
    expected: "twelve donors — ten MIT, two Apache-2.0 (claude-mem, which feeds only the opt-in learning runtime,",
  },
  {
    file: "AGENTS.md",
    locator: "and google/elephant-goldfish-model",
    expected:
      "and google/elephant-goldfish-model (Google LLC), which feeds the comprehension seat, the ticket cold read, and",
  },
  {
    file: "AGENTS.md",
    locator: "the review-isolation probe) — into *one* lifecycle",
    expected: "the review-isolation probe) — into *one* lifecycle rather than shipping four plugins that fight",
  },
  {
    file: "AGENTS.md",
    locator: "over activation descriptions.",
    expected: "over activation descriptions.",
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

interface LockDonor {
  id: string;
  commit: string;
  commit_date: string;
  license: string;
  copyright: string;
  license_file: string;
}

interface LockDoc {
  donors: unknown[];
}

interface LooseDonor {
  id: string;
  commit?: unknown;
  commit_date?: unknown;
  license?: unknown;
  copyright?: unknown;
  license_file?: unknown;
}

const isLockDoc = new Ajv2020({ strict: false }).compile<LockDoc>({
  type: "object",
  required: ["donors"],
  properties: { donors: { type: "array" } },
});

const isLooseDonor = new Ajv2020({ strict: false }).compile<LooseDonor>({
  type: "object",
  required: ["id"],
  properties: { id: { type: "string" } },
  additionalProperties: true,
});

const isLockDonor = new Ajv2020({ strict: false }).compile<LockDonor>({
  type: "object",
  required: ["id", "commit", "commit_date", "license", "copyright", "license_file"],
  properties: {
    id: { type: "string" },
    commit: { type: "string" },
    commit_date: { type: "string" },
    license: { type: "string" },
    copyright: { type: "string" },
    license_file: { type: "string" },
  },
});

function loadLockDonors(root: string, version?: "1.1"): Map<string, LockDonor> {
  const text = readFileSync(join(root, LOCK), "utf8");
  const value: unknown = version === "1.1" ? parse(text, { version: "1.1" }) : parse(text);
  expect(isLockDoc(value), "lock donors").toBe(true);
  if (!isLockDoc(value)) return new Map();
  const ids: string[] = [];
  const out = new Map<string, LockDonor>();
  for (const entry of value.donors) {
    if (!isLooseDonor(entry)) continue;
    ids.push(entry.id);
    let commitDate = entry.commit_date;
    if (commitDate instanceof Date && !Number.isNaN(commitDate.getTime())) {
      commitDate = commitDate.toISOString().replace(".000Z", "Z");
    }
    const built = {
      id: entry.id,
      commit: entry.commit,
      commit_date: commitDate,
      license: entry.license,
      copyright: entry.copyright,
      license_file: entry.license_file,
    };
    if (!isLockDonor(built)) continue;
    out.set(built.id, built);
  }
  const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
  expect(duplicates, `duplicate donor ids=${duplicates.join(",")}`).toEqual([]);
  return out;
}

function fileSha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function locatedLine(text: string, pin: LinePin): string {
  const hits: string[] = [];
  const locator = pin.locator.trimStart();
  const expected = pin.expected.trim();
  for (const line of text.replaceAll("\r\n", "\n").split("\n")) {
    const trimmed = line.trim();
    if (pin.locator === pin.expected) {
      if (trimmed === expected) hits.push(line);
    } else if (line.trimStart().startsWith(locator)) {
      hits.push(line);
    }
  }
  expect(hits.length, `${pin.file} ${pin.locator} matches=${hits.length}`).toBe(1);
  return hits[0]?.trim() === expected ? pin.expected : (hits[0] ?? "");
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

describe("EGM provenance (GS-004f)", () => {
  test("pins google/elephant-goldfish-model at the PRD commit", () => {
    const { donors } = loadDonors(REPO);
    const egm = donors.get("egm");
    expect(egm?.commit).toBe(EGM_COMMIT);
    expect(egm?.license).toBe("Apache-2.0");
    const fields = loadLockDonors(REPO).get("egm");
    expect(fields).toBeDefined();
    expect(fields?.commit).toBe(EGM_COMMIT);
    expect(fields?.commit_date).toBe(EGM_COMMIT_DATE);
    expect(fields?.license).toBe("Apache-2.0");
    expect(fields?.copyright).toBe(EGM_COPYRIGHT);
    expect(fields?.license_file).toBe(EGM_LICENSE_FILE);
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
    const fields = loadLockDonors(scratch).get("egm");
    expect(fields).toBeDefined();
    expect(fields?.commit).toBe(EGM_COMMIT);
    expect(fields?.commit_date).toBe(EGM_COMMIT_DATE);
    expect(fields?.license).toBe("Apache-2.0");
    expect(fields?.copyright).toBe(EGM_COPYRIGHT);
    expect(fields?.license_file).toBe(EGM_LICENSE_FILE);
    const yaml11 = loadLockDonors(scratch, "1.1").get("egm");
    expect(yaml11?.commit_date).toBe(EGM_COMMIT_DATE);
    expectTwelveCatalogDonors(catalogDonorLicenses(scratch));
  });

  test("SURFACES pins match hashed evidence and unique whole lines", () => {
    for (const pin of EVIDENCE_HASHES) {
      expect(fileSha256(join(REPO, pin.file)), pin.file).toBe(pin.sha256);
    }
    for (const pin of LINE_PINS) {
      const text = readFileSync(join(REPO, pin.file), "utf8");
      expect(locatedLine(text, pin), pin.file).toBe(pin.expected);
    }
  });

  test("each catalog donor's lock license matches the counted set and its licence file", () => {
    const catalog = catalogDonorLicenses(REPO);
    const { donors } = loadDonors(REPO);
    const lockDonors = loadLockDonors(REPO);
    expectTwelveCatalogDonors(catalog);
    expect(lockDonors.get("egm")?.license_file).toBe(EGM_LICENSE_FILE);
    for (const [id, license] of catalog) {
      expect(donors.get(id)?.license, id).toBe(license);
      const licenseFile = lockDonors.get(id)?.license_file;
      expect(licenseFile, id).toBeDefined();
      expect(existsSync(join(REPO, licenseFile ?? "")), licenseFile).toBe(true);
      const text = readFileSync(join(REPO, licenseFile ?? ""), "utf8");
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
