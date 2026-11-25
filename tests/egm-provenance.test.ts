import { describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse, stringify } from "yaml";

import { DENY_TERMS, matchTerms } from "../src/denylist.ts";
import { loadAdaptationFragments, loadDonors, parseDonorSource } from "../src/validation/provenance.ts";
import { processScratch } from "./helpers/process-tmp.ts";

const REPO = resolve(import.meta.dir, "..");
const EGM_COMMIT = "403d8881d62022490637d740657b33f01e321ea8";
const LOCK = "provenance/upstream.lock.yaml";
const CATALOG_PREFIXES = [
  "skills/",
  "roles/",
  "packs/",
  "protocols/",
  "references/",
  "policies/",
  "adapters/",
] as const;

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
  expect(mit).toHaveLength(10);
  expect(apache.toSorted()).toEqual(["claude-mem", "egm"]);
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

function catalogDonorBullet(notice: string, name: string): string {
  const lines = notice.split("\n");
  const start = lines.findIndex((line) => line.startsWith(`- ${name}`));
  expect(start, `NOTICE catalog-donor bullet for ${name}`).toBeGreaterThanOrEqual(0);
  const rest = lines.slice(start + 1);
  const stop = rest.findIndex((line) => line.startsWith("- ") || (line.length > 0 && !line.startsWith(" ")));
  const end = stop === -1 ? lines.length : start + 1 + stop;
  return lines.slice(start, end).join("\n");
}

function armVerdictCells(note: string): string[] {
  const section = note.split("## Arms")[1]?.split("\n## ")[0] ?? "";
  const rows = section.split("\n").filter((line) => line.startsWith("|"));
  const header = rows[0];
  if (header === undefined) return [];
  const cols = header
    .split("|")
    .slice(1, -1)
    .map((cell) => cell.trim());
  const verdictAt = cols.indexOf("Verdict");
  expect(verdictAt, "Arms table Verdict column").toBeGreaterThanOrEqual(0);
  const cells: string[] = [];
  for (const row of rows.slice(2)) {
    const values = row
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim());
    const verdict = values[verdictAt];
    if (verdict !== undefined && verdict !== "") cells.push(verdict);
  }
  return cells;
}

describe("EGM provenance (GS-004f)", () => {
  test("pins google/elephant-goldfish-model at the PRD commit", () => {
    const { donors } = loadDonors(REPO);
    const egm = donors.get("egm");
    expect(egm?.commit).toBe(EGM_COMMIT);
    expect(egm?.license).toBe("Apache-2.0");
  });

  test("counts twelve catalog donors, ten MIT and two Apache-2.0", () => {
    expectTwelveCatalogDonors(catalogDonorLicenses(REPO));
  });

  test("public donor-count prose names twelve catalog donors, ten MIT and two Apache-2.0", () => {
    const surfaces: Array<[string, RegExp]> = [
      ["AGENTS.md", /twelve donors — ten MIT, two Apache-2\.0/],
      ["README.md", /twelve donors \(ten MIT-licensed, two Apache-2\.0\)/],
      ["catalog.yaml", /twelve donors: ten MIT, two Apache-2\.0/],
      ["package.json", /twelve donors \(ten MIT, two Apache-2\.0\)/],
      ["NOTICE", /twelve catalog donors: ten under\s+the MIT License and two under the Apache License 2\.0/],
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
    expectTwelveCatalogDonors(catalogDonorLicenses(scratch));
  });

  test("GAP-PROBE is a named coverage limit and not a pass", () => {
    const note = readFileSync(join(REPO, "research/host-facts/2026-11-18/GAP-PROBE.md"), "utf8");
    const hosts = readFileSync(join(REPO, "src/review-isolation-probe/hosts.ts"), "utf8");
    expect(note).toContain("GAP-PROBE");
    expect(note).toContain("not a pass");
    expect(note).toContain("did not run");
    expect(note).toMatch(/No credential was copied, read,\s*or used/);
    const verdicts = armVerdictCells(note);
    expect(verdicts.length).toBeGreaterThan(0);
    for (const verdict of verdicts) {
      expect(verdict).toBe("not-run");
      expect(verdict).not.toMatch(/^pass(?:ed)?$/i);
    }
    expect(verdicts.some((verdict) => /pass/i.test(verdict))).toBe(false);
    expect(hosts).toContain("GAP-PROBE");
    expect(hosts).toContain("GAP-MASTRA");
    expect(hosts).toContain("not a pass");
  });

  test("NOTICE carries the EGM catalog-donor block", () => {
    const notice = readFileSync(join(REPO, "NOTICE"), "utf8");
    const block = catalogDonorBullet(notice, "elephant-goldfish-model");
    expect(block).toContain("elephant-goldfish-model");
    expect(block).toContain("Google LLC");
    expect(block).toContain(EGM_COMMIT);
    expect(block).toMatch(/Apache License 2\.0/);
  });

  test("each catalog donor's lock license matches the counted set and its licence file", () => {
    const catalog = catalogDonorLicenses(REPO);
    const { donors } = loadDonors(REPO);
    const lockText = readFileSync(join(REPO, LOCK), "utf8");
    expectTwelveCatalogDonors(catalog);
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
  });
});
