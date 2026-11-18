import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { loadAdaptationFragments, parseDonorSource } from "../src/validation/provenance.ts";

const REPO = resolve(import.meta.dir, "..");
const EGM_COMMIT = "403d8881d62022490637d740657b33f01e321ea8";
const CATALOG_PREFIXES = [
  "skills/",
  "roles/",
  "packs/",
  "protocols/",
  "references/",
  "policies/",
  "adapters/",
] as const;

function licenseByDonorId(lockText: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /\n  - id: ([a-z0-9-]+)\n(?:    .*\n)*?    license: (\S+)/g;
  for (const match of lockText.matchAll(re)) {
    const id = match[1];
    const license = match[2];
    if (id === undefined || license === undefined) continue;
    out.set(id, license);
  }
  return out;
}

describe("EGM provenance (GS-004f)", () => {
  test("pins google/elephant-goldfish-model at the PRD commit", () => {
    const lock = readFileSync(join(REPO, "provenance/upstream.lock.yaml"), "utf8");
    expect(lock).toContain("repo: google/elephant-goldfish-model");
    expect(lock).toMatch(
      new RegExp(`id: egm\\n(?:    .*\\n)*    commit: ${EGM_COMMIT}\\n(?:    .*\\n)*    license: Apache-2\\.0`),
    );
  });

  test("counts twelve catalog donors, ten MIT and two Apache-2.0", () => {
    const lock = readFileSync(join(REPO, "provenance/upstream.lock.yaml"), "utf8");
    const licenses = licenseByDonorId(lock);
    const { rows } = loadAdaptationFragments(REPO);
    const catalog = new Map<string, string>();
    for (const row of rows) {
      const src = parseDonorSource(row.source);
      if (src === null) continue;
      if (!CATALOG_PREFIXES.some((prefix) => row.path.startsWith(prefix))) continue;
      const license = licenses.get(src.donor);
      if (license === undefined) continue;
      catalog.set(src.donor, license);
    }
    const apache: string[] = [];
    const mit: string[] = [];
    for (const [id, license] of catalog) {
      if (license === "Apache-2.0") apache.push(id);
      else if (license === "MIT") mit.push(id);
    }
    expect(catalog.size).toBe(12);
    expect(mit).toHaveLength(10);
    expect(apache.toSorted()).toEqual(["claude-mem", "egm"]);
  });

  test("GAP-PROBE is a named coverage limit and not a pass", () => {
    const note = readFileSync(join(REPO, "research/host-facts/2026-11-18/GAP-PROBE.md"), "utf8");
    const hosts = readFileSync(join(REPO, "src/review-isolation-probe/hosts.ts"), "utf8");
    expect(note).toContain("GAP-PROBE");
    expect(note).toContain("not a pass");
    expect(note).toContain("did not run");
    expect(note).not.toMatch(/\|\s*pass\s*\|/i);
    expect(hosts).toContain("GAP-PROBE");
    expect(hosts).toContain("GAP-MASTRA");
    expect(hosts).toContain("not a pass");
  });

  test("the two phase-1b rulings name both seats and the four resolutions", () => {
    const rulings = readFileSync(join(REPO, "policies/resolved-conflicts.yaml"), "utf8");
    expect(rulings).toContain("id: comprehension-seat-stays-naive");
    expect(rulings).toContain("id: comprehension-gap-not-contestable");
    expect(rulings).toContain("ticket cold reader");
    expect(rulings).toContain("never rejected on the author's word");
  });
});
