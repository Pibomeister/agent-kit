/**
 * Super-bound R2 cold-read contract (phase 1b, GS-004i).
 *
 * Pins what an agent following the packaged skill must do. Off and shadow must
 * not change class or score. The scorer formula is unchanged.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { loadCatalog } from "../src/catalog/load.ts";
import { scoreDelegation, type DelegationProject, type DelegationRecord } from "../src/delegation.ts";
import { planBundle } from "../src/packaging/plan.ts";

const REPO = join(import.meta.dir, "..");

const skill = readFileSync(join(REPO, "skills/super-bound/SKILL.md"), "utf8");
const reference = readFileSync(join(REPO, "references/delegation/REFERENCE.md"), "utf8");
const contract = readFileSync(join(REPO, "skills/super-bound/skill.yaml"), "utf8");
const scorer = readFileSync(join(REPO, "src/delegation.ts"), "utf8");

function packagedFile(path: string): string {
  const { catalog } = loadCatalog(REPO);
  if (catalog === null) throw new Error("no catalog");
  const { files } = planBundle({ root: REPO, catalog }, "claude-code", {});
  const packed = files.get(path);
  if (packed === undefined) throw new Error(`the bundle lacks ${path}`);
  return packed.contents;
}

function packagedBody(): string {
  return packagedFile("skills/super-bound/SKILL.md");
}

function packagedReference(): string {
  return packagedFile("references/shared/references/delegation/REFERENCE.md");
}

const OFF_TRIGGERS =
  "missing review object, a missing key, an unknown value, a missing project, or an unindexed project";

const UNAVAILABLE_FALLBACK = "When that read is unavailable, the author check decides";

const PROJECT: DelegationProject = {
  guidance: {
    delegation: {
      weights: { reversibility: 1, size: 1, complexity: 1, spec: 1, verification: 1 },
      cut_points: { yellow_agent: 4, yellow_owner: 7, red: 10 },
      enforcement: "advisory",
    },
  },
};

const GREEN_FACTORS: DelegationRecord["factors"] = {
  reversibility: { score: 0, evidence: ["reversible"] },
  size: { score: 0, evidence: ["small"] },
  complexity: { score: 0, evidence: ["simple"] },
  spec: { score: 0, evidence: ["settled"] },
  verification: { score: 3, evidence: ["covered"] },
};

describe("super-bound cold read (phase 1b, GS-004i)", () => {
  test("the source skill and the packaged skill both dispatch only in shadow or on", () => {
    const packed = packagedBody();
    for (const body of [skill, packed]) {
      const text = body.replace(/\s+/g, " ");
      expect(text).toContain("review.cold_read");
      expect(text).toContain("Off keeps the author type-check");
      expect(text).toContain("Shadow and on dispatch one cold reader");
      expect(text).toContain("text-only single-slice light route skips the dispatch");
      expect(text).toContain("reshape it, or reclassify it");
      expect(text).toContain("cannot be published until GS-004j");
      expect(text).toContain("Off and shadow do not change the class or the scorer");
      expect(text).not.toContain("green-to-yellow-agent");
    }
  });

  test("the delegation note states claims, readiness, rewrite cap, shadow, and unavailable handling", () => {
    const note = reference.replace(/\s+/g, " ");
    expect(note).toContain("## Independent cold read of a ticket");
    expect(note).toContain("labelled `exists` or `proposed`");
    expect(note).toContain("six readiness criteria");
    expect(note).toContain("at most twice per ticket");
    expect(note).toContain("Do not reclassify the ticket");
    expect(note).toContain("Do not add the read to spec-factor or readiness evidence");
    expect(note).not.toContain("seed `yellow-agent`");
    expect(note).toContain("The read adds evidence only and does not change factor scores or weights");
    expect(note).toContain("A completed cold read is binding");
    expect(note).toContain("is cited with its reason");
    expect(note).toContain(
      "for that ticket only, the author's empty-context check decides whether it publishes, is reshaped, or is reclassified `type: decision` and sent back",
    );
    expect(note).toContain("Neither case changes the class");
    expect(note).toContain("Step 13 skips the independent cold read on this route");
    expect(note).toContain("(phase 1b, GS-004i)");
  });

  test("the execution contract names the cold-read output and keeps off as the default", () => {
    expect(contract).toContain("version: 0.7.0");
    expect(contract).toContain("id: cold-read\n    schema: cold-read");
    expect(contract).toContain("Off and shadow keep the author type-check as the outcome gate");
    expect(skill).toContain("Off stores none");
  });

  test("complete admits a cited unavailable on-mode read", () => {
    const phrase = "cites a finished cold read, or an unavailable read with its reason";
    expect(skill.replace(/\s+/g, " ")).toContain(phrase);
    expect(contract.replace(/\s+/g, " ")).toContain(phrase);
    expect(packagedBody().replace(/\s+/g, " ")).toContain(phrase);
  });

  test("off triggers match in the skill and in the source and packaged delegation note", () => {
    expect(skill.replace(/\s+/g, " ")).toContain(OFF_TRIGGERS);
    expect(reference.replace(/\s+/g, " ")).toContain(OFF_TRIGGERS);
    expect(packagedReference().replace(/\s+/g, " ")).toContain(OFF_TRIGGERS);
  });

  test("an unavailable on-mode read falls back to the author empty-context check", () => {
    expect(skill.replace(/\s+/g, " ")).toContain(UNAVAILABLE_FALLBACK);
    expect(contract.replace(/\s+/g, " ")).toContain(UNAVAILABLE_FALLBACK);
    expect(packagedBody().replace(/\s+/g, " ")).toContain(UNAVAILABLE_FALLBACK);
    const note = reference.replace(/\s+/g, " ");
    expect(note).toContain("for that ticket only, the author's empty-context check decides");
    expect(note).toContain("is reshaped, or is reclassified `type: decision` and sent back");
    expect(note).toContain("A completed cold read is binding");
    expect(packagedReference().replace(/\s+/g, " ")).toContain(
      "for that ticket only, the author's empty-context check decides",
    );
  });

  test("the scorer formula is unchanged and still only raises the seed", () => {
    expect(scorer).not.toContain("cold_read");
    expect(scorer).not.toContain("cold-read");
    const green = scoreDelegation(
      {
        delegation: {
          class: "green",
          stage: "ticket",
          floor: { packs: [], sensitive_actions: [] },
          factors: GREEN_FACTORS,
          lowered_by: null,
        },
      },
      PROJECT,
    );
    expect(green.class).toBe("green");
    const seeded = scoreDelegation(
      {
        delegation: {
          class: "yellow-agent",
          stage: "ticket",
          floor: { packs: [], sensitive_actions: [] },
          factors: GREEN_FACTORS,
          lowered_by: null,
        },
      },
      PROJECT,
    );
    expect(seeded.class).toBe("yellow-agent");
  });
});
