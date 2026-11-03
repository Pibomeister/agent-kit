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

function packagedBody(): string {
  const { catalog } = loadCatalog(REPO);
  if (catalog === null) throw new Error("no catalog");
  const { files } = planBundle({ root: REPO, catalog }, "claude-code", {});
  const packed = files.get("skills/super-bound/SKILL.md");
  if (packed === undefined) throw new Error("the bundle lacks super-bound");
  return packed.contents;
}

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
    expect(note).toContain("is cited and published");
    expect(note).toContain("It does not change the class");
    expect(note).toContain("Step 13 skips the independent cold read on this route");
    expect(note).toContain("(phase 1b, GS-004i)");
  });

  test("the execution contract names the cold-read output and keeps off as the default", () => {
    expect(contract).toContain("version: 0.5.0");
    expect(contract).toContain("id: cold-read\n    schema: cold-read");
    expect(contract).toContain("Off and shadow keep the author type-check as the outcome gate");
    expect(skill).toContain("Off stores none");
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
