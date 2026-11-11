/**
 * Super-bound R2 cold-read contract (phase 1b, GS-004i and GS-004k).
 *
 * Pins what an agent following the packaged skill must do. Off and shadow must
 * not change class or score. When on, an unavailable read raises green to
 * yellow-agent by the captain's Q1 decision. The scorer formula is unchanged.
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

function subsection(text: string, name: string): string {
  const marker = `**${name}.**`;
  const start = text.indexOf(marker);
  if (start < 0) return "";
  const rest = text.slice(start);
  const next = rest.slice(marker.length).search(/\n\*\*[A-Za-z]/);
  return next < 0 ? rest : rest.slice(0, marker.length + next);
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
      expect(text).toContain("exempts that ticket from `cold_read_ref`");
      expect(text).toContain("Off and shadow do not change the class or the scorer");
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
    expect(note).toContain("The read adds evidence only and does not change factor scores or weights");
    expect(note).toContain("A completed cold read is binding");
    expect(note).toContain("is cited with its reason");
    expect(note).toContain(
      "for that ticket only, the author's empty-context check decides whether it publishes, is reshaped, or is reclassified `type: decision` and sent back",
    );
    expect(note).toContain("Step 13 skips the independent cold read on this route");
    expect(note).toContain("A note or approval does not exempt");
    expect(note).toContain("(phase 1b, GS-004i)");
  });

  test("the execution contract names the cold-read output and keeps off as the default", () => {
    expect(contract).toContain("version: 0.9.0");
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

describe("unavailable on-mode cold read raises green to yellow-agent (GS-004k)", () => {
  const projectSchema = readFileSync(join(REPO, "schemas/project.schema.json"), "utf8");
  const coldReadSchema = readFileSync(join(REPO, "schemas/cold-read.schema.json"), "utf8");

  test("on: an unavailable read seeds yellow-agent from green by the captain's Q1 decision", () => {
    const note = reference.replace(/\s+/g, " ");
    expect(note).toContain("four cases is a hand-derived class");
    expect(note).not.toContain("three cases is a hand-derived class");
    expect(note).toContain(
      "When `review.cold_read` is on, the cited read is unavailable, and the computed class is `green`, seed `yellow-agent` by the captain's Q1 decision (GS-004k), unless a live named-human lowering is in force",
    );
    expect(note).toContain("A live lowering supersedes that raise");
    expect(note).toContain("leave `lowered_by` unsuperseded");
    expect(note).toContain("the raised class persists until a named human lowers it");
    expect(note).toContain("A later completed read does not reseed `green`");
    expect(note).toContain("Only a named human may lower the class, with the reason recorded");
    const on = subsection(reference, "On").replace(/\s+/g, " ");
    expect(on).toContain("If that ticket's class is `green`, seed `yellow-agent`");
    expect(on).toContain("unless a live named-human lowering is in force");
    expect(on).toContain("A live lowering supersedes this raise");
    expect(on).toContain("the raised class persists until a named human lowers it");
    expect(on).toContain("An unscored ticket has no class, so the raise is skipped");
    expect(on).toContain("That yellow-agent seed is the captain's Q1 decision (GS-004k)");
    expect(on).toContain("Only a named human may lower the class, with the reason recorded");
    expect(on).toContain("ruling `delegation-class-is-authority-not-finding`");
    expect(on).toContain("Off and shadow do not seed from the read");
    expect(on).toContain("A later completed read does not reseed `green`");
    expect(on).toContain(
      "The validator does not yet check the raise; that check and a revert path are follow-ups (GS-004l hardening).",
    );
    expect(on).not.toContain("Neither case changes the class");
    const packedOn = subsection(packagedReference(), "On").replace(/\s+/g, " ");
    expect(packedOn).toContain("If that ticket's class is `green`, seed `yellow-agent`");
    expect(packedOn).toContain("unless a live named-human lowering is in force");
    const skillText = skill.replace(/\s+/g, " ");
    expect(skillText).toContain("green-to-yellow-agent");
    expect(skillText).toContain(
      "When on and the read is unavailable, a green class rises to `yellow-agent` by the captain's Q1 decision (GS-004k), unless a live named-human lowering is in force",
    );
    expect(skillText).toContain(
      "an unavailable read with its reason and, where the ticket is scored and its computed class was green, carries `yellow-agent` or the live named-human lowering that supersedes the raise",
    );
    expect(packagedBody().replace(/\s+/g, " ")).toContain(
      "When on and the read is unavailable, a green class rises to `yellow-agent` by the captain's Q1 decision (GS-004k), unless a live named-human lowering is in force",
    );
    expect(contract.replace(/\s+/g, " ")).toContain(
      "When on and the read is unavailable, a green class rises to yellow-agent by the captain's Q1 decision (GS-004k), unless a live named-human lowering is in force",
    );
    expect(contract.replace(/\s+/g, " ")).toContain(
      "an unavailable read with its reason and, where the ticket is scored and its computed class was green, carries `yellow-agent` or the live named-human lowering that supersedes the raise",
    );
    expect(projectSchema).toContain(
      "When on, an unavailable read raises a green class to yellow-agent by the captain's Q1 decision (GS-004k), unless a live named-human lowering is in force. Only a named human may lower the class, with the reason recorded (ruling `delegation-class-is-authority-not-finding`). Off and shadow do not raise (phase 1b, GS-004k).",
    );
    expect(projectSchema).toContain(
      "The validator does not yet check the raise; that check and a revert path are follow-ups (GS-004l hardening).",
    );
    expect(projectSchema).not.toContain("later phase (GS-004k)");
    expect(projectSchema).not.toContain("Off and shadow do not raise. (phase 1b, GS-004k).");
    expect(coldReadSchema).toContain(
      "When review.cold_read is on, an unavailable read raises a green class to yellow-agent by the captain's Q1 decision (GS-004k), unless a live named-human lowering is in force. Off and shadow do not raise (phase 1b, GS-004k).",
    );
    expect(coldReadSchema).not.toContain("later phase (GS-004k)");
    expect(coldReadSchema).not.toContain("Off and shadow do not raise. (phase 1b, GS-004k).");
  });

  test("shadow: the read is stored and listed, and it does not seed a class", () => {
    const shadow = subsection(reference, "Shadow").replace(/\s+/g, " ");
    expect(shadow).toContain("The read runs and is stored");
    expect(shadow).toContain("Print listed decisions beside the ticket");
    expect(shadow).toContain("Do not change the class");
    expect(shadow).not.toContain("seed `yellow-agent`");
    expect(subsection(packagedReference(), "Shadow").replace(/\s+/g, " ")).toContain("Do not change the class");
    expect(skill.replace(/\s+/g, " ")).toContain("Off and shadow do not change the class or the scorer");
  });

  test("off: the author type-check stays, and nothing is stored or seeded", () => {
    const mode = subsection(reference, "Mode").replace(/\s+/g, " ");
    expect(mode).toContain("Off dispatches nothing, stores nothing");
    expect(mode).toContain("leaves the author's type-check as the zero-context gate");
    expect(mode).not.toContain("seed `yellow-agent`");
    expect(skill.replace(/\s+/g, " ")).toContain("Off keeps the author type-check");
    expect(skill).toContain("Off stores none");
    expect(projectSchema).toContain("Default off");
  });
});
