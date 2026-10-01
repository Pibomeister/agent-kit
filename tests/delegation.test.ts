import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { runCli } from "../src/cli.ts";
import {
  scoreDelegation,
  type DelegationFactorName,
  type DelegationProject,
  type DelegationRecord,
  type DelegationTicket,
} from "../src/delegation.ts";
import { makeTree } from "./helpers/tree.ts";

const FIXTURES = join(import.meta.dir, "fixtures", "delegation");

const FACTORS: DelegationRecord["factors"] = {
  reversibility: { score: 0, evidence: ["A reversible internal change."] },
  size: { score: 0, evidence: ["One small file."] },
  complexity: { score: 0, evidence: ["No concurrency or hotspot overlap."] },
  spec: { score: 0, evidence: ["Every decision is settled."] },
  verification: { score: 3, evidence: ["Independent integration coverage exists."] },
};

const PROJECT: DelegationProject = {
  guidance: {
    delegation: {
      weights: { reversibility: 1, size: 1, complexity: 1, spec: 1, verification: 1 },
      cut_points: { yellow_agent: 4, yellow_owner: 7, red: 10 },
      enforcement: "advisory",
    },
  },
};

type AssessmentOverrides = Partial<Pick<DelegationRecord, "floor" | "lowered_by">>;

function ticket(
  current: DelegationRecord["class"],
  scores: Partial<Record<DelegationFactorName, number>> = {},
  overrides: AssessmentOverrides = {},
): DelegationTicket {
  return {
    delegation: {
      class: current,
      stage: "ticket",
      floor: overrides.floor ?? { packs: [], sensitive_actions: [] },
      factors: {
        reversibility: { ...FACTORS.reversibility, score: scores.reversibility ?? FACTORS.reversibility.score },
        size: { ...FACTORS.size, score: scores.size ?? FACTORS.size.score },
        complexity: { ...FACTORS.complexity, score: scores.complexity ?? FACTORS.complexity.score },
        spec: { ...FACTORS.spec, score: scores.spec ?? FACTORS.spec.score },
        verification: { ...FACTORS.verification, score: scores.verification ?? FACTORS.verification.score },
      },
      lowered_by: overrides.lowered_by ?? null,
    },
  };
}

describe("deterministic delegation scoring", () => {
  test.each([
    ["green", ticket("green")],
    ["yellow-agent", ticket("green", { reversibility: 3, size: 1 })],
    ["yellow-owner", ticket("green", { reversibility: 3, size: 3, complexity: 1 })],
    ["red", ticket("green", { reversibility: 3, size: 3, complexity: 3, spec: 1 })],
  ] as const)("scores the %s boundary", (expected, input) => {
    expect(scoreDelegation(input, PROJECT).class).toBe(expected);
  });

  test("a never-dropped pack sets a floor", () => {
    const input = ticket("green", {}, { floor: { packs: ["pack-secure"], sensitive_actions: [] } });
    expect(scoreDelegation(input, PROJECT).class).toBe("yellow-owner");
  });

  test("a required money-movement action sets a red floor", () => {
    const input = ticket("green", {}, { floor: { packs: [], sensitive_actions: ["money-movement"] } });
    expect(scoreDelegation(input, PROJECT).class).toBe("red");
  });

  test("automatic recomputation raises but never lowers", () => {
    expect(scoreDelegation(ticket("yellow-owner"), PROJECT).class).toBe("yellow-owner");
    expect(scoreDelegation(ticket("green", { reversibility: 3, size: 1 }), PROJECT).class).toBe("yellow-agent");
  });

  test("a named human may lower the score-derived class but not the floor", () => {
    const lowered = ticket(
      "yellow-agent",
      { reversibility: 3, size: 3, complexity: 3, spec: 1 },
      {
        lowered_by: {
          human: "Avery Owner",
          reason: "The measured blast radius is isolated by the existing flag.",
          at: "2026-09-30T12:00:00Z",
        },
      },
    );
    expect(scoreDelegation(lowered, PROJECT).class).toBe("yellow-agent");

    const belowFloor = ticket(
      "green",
      {},
      {
        floor: { packs: ["pack-secure"], sensitive_actions: [] },
        lowered_by: { human: "Avery Owner", reason: "The pack matched a read-only path.", at: "2026-09-30T12:00:00Z" },
      },
    );
    expect(scoreDelegation(belowFloor, PROJECT).class).toBe("yellow-owner");
  });
});

test("ak delegation reads sibling ticket and project records and prints the ticket delegation shape", () => {
  const root = makeTree({});
  mkdirSync(join(root, "work"), { recursive: true });
  writeFileSync(join(root, "work", "ticket.json"), readFileSync(join(FIXTURES, "valid.ticket.json")));
  writeFileSync(join(root, "work", "project.json"), readFileSync(join(FIXTURES, "valid.project.json")));
  const out: string[] = [];
  const err: string[] = [];
  const code = runCli(["delegation", "work/ticket.json"], {
    cwd: root,
    io: { out: (line) => out.push(line), err: (line) => err.push(line) },
  });
  expect(code).toBe(0);
  expect(err).toEqual([]);
  expect(JSON.parse(out.join("\n"))).toMatchObject({
    class: "yellow-agent",
    stage: "ticket",
    floor: { packs: ["pack-data"], sensitive_actions: [] },
    factors: { reversibility: { score: 2 } },
    lowered_by: null,
  });
});
