import { describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse, stringify } from "yaml";

import { DENY_TERMS, matchTerms } from "../src/denylist.ts";
import { loadAdaptationFragments, loadDonors, parseDonorSource } from "../src/validation/provenance.ts";
import { processScratch } from "./helpers/process-tmp.ts";

const REPO = resolve(import.meta.dir, "..");
const EGM_COMMIT = "403d8881d62022490637d740657b33f01e321ea8";
const EGM_LICENSE_FILE = "provenance/licenses/google_elephant-goldfish-model.LICENSE";
const LOCK = "provenance/upstream.lock.yaml";
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
const PASS_ALLOW = ["None is `pass`", "not a pass"] as const;
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
  expect(mit.toSorted()).toEqual([...MIT_CATALOG_IDS].toSorted());
  expect(apache.toSorted()).toEqual(["claude-mem", "egm"]);
}

function passHitsAfterAllowlist(text: string): string[] {
  let rest = text;
  for (const phrase of PASS_ALLOW) rest = rest.split(phrase).join("");
  return rest.match(/pass/gi) ?? [];
}

function markdownTables(text: string): Array<{ header: string[]; rows: string[][] }> {
  const lines = text.split("\n");
  const tables: Array<{ header: string[]; rows: string[][] }> = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (!line.startsWith("|")) {
      i += 1;
      continue;
    }
    const header = line
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim());
    const separator = lines[i + 1] ?? "";
    if (!separator.startsWith("|") || !separator.includes("---")) {
      i += 1;
      continue;
    }
    i += 2;
    const rows: string[][] = [];
    while (i < lines.length && (lines[i] ?? "").startsWith("|")) {
      rows.push(
        (lines[i] ?? "")
          .split("|")
          .slice(1, -1)
          .map((cell) => cell.trim()),
      );
      i += 1;
    }
    tables.push({ header, rows });
  }
  return tables;
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
  const match = new RegExp(`${label}:\\s*([\\s\\S]*?)(?:\\n- |$)`).exec(block);
  expect(match, label).toBeTruthy();
  return (match?.[1] ?? "")
    .split(/[,\n]/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function gapProbeComment(hosts: string): string {
  const start = hosts.indexOf("GAP-PROBE:");
  expect(start).toBeGreaterThanOrEqual(0);
  const from = hosts.slice(start);
  const end = from.search(/\nimport |\n \*\//);
  return end === -1 ? from : from.slice(0, end);
}

function isolatedReviewContextCell(contract: string): string {
  const row = contract.split("\n").find((line) => line.includes("`isolated-review-context`"));
  expect(row).toBeDefined();
  const cells = (row ?? "")
    .split("|")
    .slice(1, -1)
    .map((cell) => cell.trim());
  return cells[2] ?? "";
}

function agentsDonorSentence(agents: string): string {
  const start = agents.indexOf("twelve donors");
  expect(start).toBeGreaterThanOrEqual(0);
  return agents.slice(start, start + 600);
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
  const cells: string[] = [];
  for (const table of markdownTables(note)) {
    const verdictAt = table.header.indexOf("Verdict");
    if (verdictAt < 0) continue;
    for (const row of table.rows) {
      const verdict = row[verdictAt];
      if (verdict !== undefined && verdict !== "") cells.push(verdict);
    }
  }
  expect(cells.length, "Arms Verdict column").toBeGreaterThan(0);
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
      ["README.md", /twelve donors \(ten MIT-licensed, two Apache-2\.0\)/],
      ["catalog.yaml", /twelve donors: ten MIT, two Apache-2\.0/],
      ["package.json", /twelve donors \(ten MIT, two Apache-2\.0\)/],
      [".claude-plugin/marketplace.json", /twelve donors \(ten MIT, two Apache-2\.0\)/],
      ["NOTICE", /twelve catalog donors: ten under\s+the MIT License and two under the Apache License 2\.0/],
    ];
    for (const [rel, pattern] of surfaces) {
      expect(readFileSync(join(REPO, rel), "utf8"), rel).toMatch(pattern);
    }
    const agentsSentence = agentsDonorSentence(readFileSync(join(REPO, "AGENTS.md"), "utf8"));
    expect(agentsSentence).toMatch(/twelve donors — ten MIT, two Apache-2\.0/);
    expect(agentsSentence).toMatch(/google\/elephant-goldfish-model|\begm\b/);
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
    const contract = readFileSync(join(REPO, "adapters/claude-code/CONTRACT.md"), "utf8");
    expect(note).toContain("GAP-PROBE");
    expect(note).toContain("not a pass");
    expect(note).toContain("did not run");
    expect(note).toMatch(/No credential was copied, read,\s*or used/);
    const verdicts = armVerdictCells(note);
    for (const verdict of verdicts) expect(verdict).toBe("not-run");
    expect(passHitsAfterAllowlist(note), "GAP-PROBE.md").toEqual([]);
    expect(passHitsAfterAllowlist(gapProbeComment(hosts)), "hosts.ts GAP-PROBE").toEqual([]);
    expect(passHitsAfterAllowlist(isolatedReviewContextCell(contract)), "isolated-review-context").toEqual([]);
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
    expect(block).toContain(EGM_LICENSE_FILE);
    expect(block).toContain("were modified");
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
