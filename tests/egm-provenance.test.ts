/**
 * Provenance-only files are pinned by sha256 of the raw bytes. Mixed files wrap
 * claims in begin/end markers that must appear once, outside any code fence;
 * the test hashes the block after CRLF folds to LF. A fenced copy cannot
 * satisfy a pin. A split rewrite of the live block changes the hash. Overlay
 * copies must equal source bytes. The lock is YAML. One loader walks donors,
 * rejects duplicate ids, coerces a Date commit_date, and asserts the egm
 * commit, commit_date, license, copyright, license_file, path, url, and repo.
 * Duplicate-id rejection lives in this test, not in loadDonors. Every egm
 * adaptation source commit must equal the lock pin. Free-text claims
 * elsewhere are review's job.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import { parse, stringify } from "yaml";

import { loadCatalog } from "../src/catalog/load.ts";
import { DENY_TERMS, matchTerms } from "../src/denylist.ts";
import { loadAdaptationFragments, loadDonors, parseDonorSource } from "../src/validation/provenance.ts";
import { processScratch } from "./helpers/process-tmp.ts";

const REPO = resolve(import.meta.dir, "..");
const EGM_COMMIT = "403d8881d62022490637d740657b33f01e321ea8";
const EGM_COMMIT_DATE = "2026-10-30T08:43:28Z";
const EGM_COPYRIGHT = "Copyright 2026 Google LLC";
const EGM_LICENSE_FILE = "provenance/licenses/google_elephant-goldfish-model.LICENSE";
const EGM_REPO = "google/elephant-goldfish-model";
const EGM_URL = "https://github.com/google/elephant-goldfish-model";
const EGM_PATH = ".donors/google_elephant-goldfish-model";
const LOCK = "provenance/upstream.lock.yaml";
const GAP_PROBE = "research/host-facts/2026-11-18/GAP-PROBE.md";
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

const FILE_HASHES: Array<{ file: string; sha256: string }> = [
  { file: "NOTICE", sha256: "4e3959890e74c13743d11acd92fa4bf9fa2fcde378896d4f042e2e48a0f64f19" },
  { file: GAP_PROBE, sha256: "73f79b67e12b388b09b482959faaf83c4370f664d6476f4eec321cd830e322ca" },
  {
    file: "research/dossiers/egm.md",
    sha256: "77af72c4a42a0fd5867a30aa0d5aa7306c081fc5e692d2f9d5cad148fec69df9",
  },
  {
    file: "provenance/adaptations.d/comprehension-seat.yaml",
    sha256: "478be32d48f0c566370b3f8af8d6f196330e6811e3b615aa0c7abd1b8a1608f0",
  },
];

const LOCK_ENTRY_SHA256 = "1f48385ba3ca27a065fa1448af81d6b8aa5cd05dc545d3d76ab605fbbd03da77";
const FINGERPRINT_DESC_SHA256 = "7df2fe33f96517c13e3756bdb727912f1f9d7a1a8bc61fdcda8fdb7f737581ff";

type BlockPin = { file: string; begin: string; end: string; sha256: string };

const BLOCK_PINS: BlockPin[] = [
  {
    file: "README.md",
    begin: "<!-- ak-egm-begin -->",
    end: "<!-- ak-egm-end -->",
    sha256: "088c4feef4d2b12e01ffdf6c0c528768ac4b3a549945f80009370527e2bc496d",
  },
  {
    file: "adapters/claude-code/CONTRACT.md",
    begin: "<!-- ak-egm-begin -->",
    end: "<!-- ak-egm-end -->",
    sha256: "0387535cb2bf969fa90bc7f41ce1f1921e3bd31d120342d27bc2fa956c54c0d8",
  },
  {
    file: "src/review-isolation-probe/hosts.ts",
    begin: " * ak-egm-begin",
    end: " * ak-egm-end",
    sha256: "08e49b8642e290b9c010414ad3bbaa068c8b34d97a9d83b984cae47f0a069d3c",
  },
  {
    file: "roles/doc-review/comprehension/ROLE.md",
    begin: "<!-- ak-egm-begin -->",
    end: "<!-- ak-egm-end -->",
    sha256: "0c78637607160ea80eee311aa7866905b2cbcc3bf7b955cdfd215cdc1ccd6fed",
  },
  {
    file: "policies/resolved-conflicts.yaml",
    begin: "# ak-egm-begin",
    end: "# ak-egm-end",
    sha256: "4e80885494d7da2683f47f94b4ff4451d71c3097205cddb19e897886d87f19d0",
  },
  {
    file: ".cursor/references/shared/adapters/claude-code/CONTRACT.md",
    begin: "<!-- ak-egm-begin -->",
    end: "<!-- ak-egm-end -->",
    sha256: "0387535cb2bf969fa90bc7f41ce1f1921e3bd31d120342d27bc2fa956c54c0d8",
  },
  {
    file: ".cursor/references/shared/roles/doc-review/comprehension/ROLE.md",
    begin: "<!-- ak-egm-begin -->",
    end: "<!-- ak-egm-end -->",
    sha256: "c5d858d91739c6c72bb1be77e055c23e3879295995d023d5db851eb8d4b2fafc",
  },
];

const OVERLAY_COPIES: Array<{ src: string; dest: string }> = [
  { src: "NOTICE", dest: ".cursor/licenses/NOTICE" },
  {
    src: "roles/doc-review/comprehension/ROLE.md",
    dest: ".cursor/roles/doc-review/comprehension/ROLE.md",
  },
  { src: "schemas/finding.schema.json", dest: ".cursor/schemas/finding.schema.json" },
  {
    src: "schemas/finding.schema.json",
    dest: ".cursor/references/shared/schemas/finding.schema.json",
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

function countWord(n: number): string {
  if (n === 2) return "two";
  if (n === 10) return "ten";
  if (n === 12) return "twelve";
  expect(n, `count-word ${n}`).toBe(12);
  return "twelve";
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
  path: string;
  url: string;
  repo: string;
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
  path?: unknown;
  url?: unknown;
  repo?: unknown;
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

const isPluginExample = new Ajv2020({ strict: false }).compile<{ description: string }>({
  type: "object",
  required: ["description"],
  properties: { description: { type: "string" } },
});

const isFingerprintSchema = new Ajv2020({ strict: false }).compile<{
  properties: { fingerprint: { description: string } };
}>({
  type: "object",
  required: ["properties"],
  properties: {
    properties: {
      type: "object",
      required: ["fingerprint"],
      properties: {
        fingerprint: {
          type: "object",
          required: ["description"],
          properties: { description: { type: "string" } },
        },
      },
    },
  },
});

const isLockDonor = new Ajv2020({ strict: false }).compile<LockDonor>({
  type: "object",
  required: ["id", "commit", "commit_date", "license", "copyright", "license_file", "path", "url", "repo"],
  properties: {
    id: { type: "string" },
    commit: { type: "string" },
    commit_date: { type: "string" },
    license: { type: "string" },
    copyright: { type: "string" },
    license_file: { type: "string" },
    path: { type: "string" },
    url: { type: "string" },
    repo: { type: "string" },
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
      path: entry.path,
      url: entry.url,
      repo: entry.repo,
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

function textSha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function maskFences(text: string): string {
  const lines = text.split("\n");
  let fence = false;
  const out: string[] = [];
  for (const line of lines) {
    if (line.trimStart().startsWith("```")) {
      fence = !fence;
      out.push(" ".repeat(line.length));
      continue;
    }
    out.push(fence ? " ".repeat(line.length) : line);
  }
  return out.join("\n");
}

function indicesOf(haystack: string, needle: string): number[] {
  const hits: number[] = [];
  let from = 0;
  while (from <= haystack.length - needle.length) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) break;
    hits.push(at);
    from = at + needle.length;
  }
  return hits;
}

function extractPinnedBlock(text: string, pin: BlockPin): string {
  const folded = text.replaceAll("\r\n", "\n");
  const visible = maskFences(folded);
  const begins = indicesOf(visible, pin.begin);
  const ends = indicesOf(visible, pin.end);
  expect(begins.length, `${pin.file} begin matches=${begins.length}`).toBe(1);
  expect(ends.length, `${pin.file} end matches=${ends.length}`).toBe(1);
  const start = (begins[0] ?? 0) + pin.begin.length;
  const stop = ends[0] ?? 0;
  expect(start <= stop, `${pin.file} inverted markers`).toBe(true);
  return folded.slice(start, stop);
}

function lockEntry(text: string): string {
  const startNeedle = "  # Catalog donor, no EGM plugin, probe plus comprehension and cold read.";
  const start = text.indexOf(startNeedle);
  expect(start, "lock egm entry").toBeGreaterThanOrEqual(0);
  const end = text.indexOf("\n# ---------------------------------------------------------------------------", start);
  expect(end, "lock egm entry end").toBeGreaterThan(start);
  return text.slice(start, end);
}

function contractPluginDescription(text: string): string {
  const folded = text.replaceAll("\r\n", "\n");
  const start = folded.indexOf("```json\n");
  expect(start, "plugin.json example fence").toBeGreaterThanOrEqual(0);
  const body = start + "```json\n".length;
  const end = folded.indexOf("\n```", body);
  expect(end, "plugin.json example close").toBeGreaterThan(body);
  const value: unknown = JSON.parse(folded.slice(body, end));
  expect(isPluginExample(value), "plugin.json example").toBe(true);
  if (!isPluginExample(value)) return "";
  return value.description;
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
    expect(fields?.path).toBe(EGM_PATH);
    expect(fields?.url).toBe(EGM_URL);
    expect(fields?.repo).toBe(EGM_REPO);
  });

  test("counts twelve catalog donors, ten MIT and two Apache-2.0", () => {
    expectTwelveCatalogDonors(catalogDonorLicenses(REPO));
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
    expect(fields?.path).toBe(EGM_PATH);
    expect(fields?.url).toBe(EGM_URL);
    expect(fields?.repo).toBe(EGM_REPO);
    const yaml11 = loadLockDonors(scratch, "1.1").get("egm");
    expect(yaml11?.commit_date).toBe(EGM_COMMIT_DATE);
    expectTwelveCatalogDonors(catalogDonorLicenses(scratch));
  });

  test("hashed provenance files and unique marker blocks", () => {
    for (const pin of FILE_HASHES) {
      expect(fileSha256(join(REPO, pin.file)), pin.file).toBe(pin.sha256);
    }
    expect(textSha256(lockEntry(readFileSync(join(REPO, LOCK), "utf8"))), LOCK).toBe(LOCK_ENTRY_SHA256);
    for (const pin of BLOCK_PINS) {
      const text = readFileSync(join(REPO, pin.file), "utf8");
      expect(textSha256(extractPinnedBlock(text, pin)), pin.file).toBe(pin.sha256);
    }
    const schema: unknown = JSON.parse(readFileSync(join(REPO, "schemas/finding.schema.json"), "utf8"));
    expect(isFingerprintSchema(schema), "fingerprint description").toBe(true);
    if (!isFingerprintSchema(schema)) return;
    expect(textSha256(schema.properties.fingerprint.description), "fingerprint").toBe(FINGERPRINT_DESC_SHA256);
    for (const copy of OVERLAY_COPIES) {
      expect(existsSync(join(REPO, copy.dest)), copy.dest).toBe(true);
      expect(readFileSync(join(REPO, copy.dest)).equals(readFileSync(join(REPO, copy.src))), copy.dest).toBe(true);
    }
    const catalog = catalogDonorLicenses(REPO);
    expectTwelveCatalogDonors(catalog);
    const { catalog: loaded } = loadCatalog(REPO);
    const description = loaded?.package.description ?? "";
    expect(description.length, "catalog.yaml package.description").toBeGreaterThan(0);
    expect(description).toContain(countWord(catalog.size));
    expect(description).toContain(countWord([...catalog.values()].filter((license) => license === "MIT").length));
    expect(description).toContain(
      countWord([...catalog.values()].filter((license) => license === "Apache-2.0").length),
    );
    expect(contractPluginDescription(readFileSync(join(REPO, "adapters/claude-code/CONTRACT.md"), "utf8"))).toBe(
      description,
    );
  });

  test("every egm adaptation source commit matches the lock pin", () => {
    const lockCommit = loadLockDonors(REPO).get("egm")?.commit;
    expect(lockCommit).toBe(EGM_COMMIT);
    const { rows } = loadAdaptationFragments(REPO);
    const egm = rows.filter((row) => parseDonorSource(row.source)?.donor === "egm");
    expect(egm.length).toBeGreaterThan(0);
    for (const row of egm) {
      expect(parseDonorSource(row.source)?.commit, row.file).toBe(lockCommit);
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
