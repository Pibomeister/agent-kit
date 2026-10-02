import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { describe, expect, test } from "bun:test";

import validProject from "./fixtures/delegation/valid.project.json" with { type: "json" };
import validTicket from "./fixtures/delegation/valid.ticket.json" with { type: "json" };
import { loadCatalog } from "../src/catalog/load.ts";
import { runCli } from "../src/cli.ts";
import {
  scoreDelegation,
  type DelegationFactorName,
  type DelegationProject,
  type DelegationRecord,
  type DelegationTicket,
} from "../src/delegation.ts";
import { planBundle } from "../src/packaging/plan.ts";
import { makeTree } from "./helpers/tree.ts";

const REPO = join(import.meta.dir, "..");
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

  test("fractional weights that sum onto a cut point reach its class", () => {
    const fractional: DelegationProject = {
      guidance: {
        delegation: {
          weights: { reversibility: 0.7, size: 0.1, complexity: 0.2, spec: 0, verification: 0 },
          cut_points: { yellow_agent: 1, yellow_owner: 2, red: 3 },
          enforcement: "advisory",
        },
      },
    };
    const input = ticket("green", { reversibility: 1, size: 1, complexity: 1 });
    expect(scoreDelegation(input, fractional).class).toBe("yellow-agent");
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
          from: "red",
        },
      },
    );
    expect(scoreDelegation(lowered, PROJECT).class).toBe("yellow-agent");

    const belowFloor = ticket(
      "green",
      {},
      {
        floor: { packs: ["pack-secure"], sensitive_actions: [] },
        lowered_by: {
          human: "Avery Owner",
          reason: "The pack matched a read-only path.",
          at: "2026-09-30T12:00:00Z",
          from: "yellow-owner",
        },
      },
    );
    expect(scoreDelegation(belowFloor, PROJECT).class).toBe("yellow-owner");
  });
});

test("a later assessment above the class a lowering started from supersedes the lowering", () => {
  const lowering = {
    human: "Avery Owner",
    reason: "The change is behind a flag that stays off.",
    at: "2026-09-30T12:00:00Z",
    from: "yellow-owner",
  } as const;
  const atTicketTime = ticket("yellow-agent", { reversibility: 3, size: 3, complexity: 1 }, { lowered_by: lowering });
  expect(scoreDelegation(atTicketTime, PROJECT)).toMatchObject({ class: "yellow-agent", lowered_by: lowering });

  const atMergeTime = ticket(
    "yellow-agent",
    { reversibility: 3, size: 3, complexity: 3, spec: 1 },
    { lowered_by: lowering },
  );
  const raised = scoreDelegation(atMergeTime, PROJECT);
  expect(raised).toMatchObject({ class: "red", lowered_by: { ...lowering, superseded: true } });

  const rescored = scoreDelegation({ delegation: { ...raised, factors: FACTORS } }, PROJECT);
  expect(rescored).toMatchObject({ class: "red", lowered_by: { superseded: true } });
});

test("ak delegation reads the ticket and the named project record and prints the ticket delegation shape", () => {
  const root = makeTree({});
  mkdirSync(join(root, "work"), { recursive: true });
  writeFileSync(join(root, "work", "ticket.json"), readFileSync(join(FIXTURES, "valid.ticket.json")));
  writeFileSync(join(root, "work", "project.json"), readFileSync(join(FIXTURES, "valid.project.json")));
  const out: string[] = [];
  const err: string[] = [];
  const code = runCli(["delegation", "work/ticket.json", "--project", "work/project.json"], {
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

test("ak delegation names the block a record lacks", () => {
  const root = makeTree({});
  writeFileSync(join(root, "ticket.json"), JSON.stringify(validTicket));
  writeFileSync(join(root, "bare-ticket.json"), JSON.stringify({ ...validTicket, delegation: undefined }));
  writeFileSync(join(root, "project.json"), JSON.stringify(validProject));
  writeFileSync(
    join(root, "bare-project.json"),
    JSON.stringify({ ...validProject, guidance: { ...validProject.guidance, delegation: undefined } }),
  );
  const run = (...argv: string[]) => {
    const err: string[] = [];
    const code = runCli(["delegation", ...argv], { cwd: root, io: { out: () => {}, err: (line) => err.push(line) } });
    return { code, err: err.join("\n") };
  };
  expect(run("bare-ticket.json", "--project", "project.json")).toEqual({
    code: 1,
    err: "ak delegation: ticket has no delegation block to score",
  });
  expect(run("ticket.json").code).toBe(2);
  expect(run("ticket.json", "--project", "bare-project.json")).toEqual({
    code: 1,
    err: "ak delegation: project has no guidance.delegation block (weights and cut points)",
  });
});

test("the bare scorer command the packaged super-bound body names scores with a current ak on PATH and is absent without one", () => {
  const { catalog } = loadCatalog(REPO);
  if (catalog === null) throw new Error("no catalog");
  const { files } = planBundle({ root: REPO, catalog }, "claude-code", {});
  const skill = files.get("skills/super-bound/SKILL.md");
  const script = files.get("bin/ak");
  if (skill === undefined || script === undefined) throw new Error("the bundle lacks super-bound or bin/ak");
  const root = makeTree({});
  mkdirSync(join(root, "path"));
  writeFileSync(join(root, "path", "ak"), script.contents, { mode: 0o755 });
  writeFileSync(join(root, "ticket.json"), JSON.stringify(validTicket));
  writeFileSync(join(root, "project.json"), JSON.stringify(validProject));

  // The packaged body is the generated interface a host reads: every scorer command it prints must run.
  const body = skill.contents.replace(/\s+/g, " ");
  const commands = [...body.matchAll(/`([^`]*\bdelegation <ticket> --project <project-record>)`/g)].map(
    (match) => match[1] ?? "",
  );
  expect(commands).toEqual(Array(2).fill("ak delegation <ticket> --project <project-record>"));
  expect(body).toContain("A current `ak` on `PATH` is a prerequisite");
  const bun = dirname(process.execPath);
  const ak = (command: string, ticketPath: string, path = `${join(root, "path")}:${bun}`) => {
    const [program = "", ...argv] = command
      .replace("<ticket>", ticketPath)
      .replace("<project-record>", "project.json")
      .split(" ");
    return spawnSync(program, argv, { cwd: root, encoding: "utf8", env: { PATH: path } });
  };

  const expected: string[] = [];
  runCli(["delegation", "ticket.json", "--project", "project.json"], {
    cwd: root,
    io: { out: (line) => expected.push(line), err: () => {} },
  });
  const [command = ""] = commands;
  const scored = ak(command, "ticket.json");
  expect({ status: scored.status, stderr: scored.stderr }).toEqual({ status: 0, stderr: "" });
  expect(scored.stdout.trimEnd()).toBe(expected.join("\n"));

  const missing = ak(command, "absent.json");
  expect({ status: missing.status, stderr: missing.stderr.trimEnd(), stdout: missing.stdout }).toEqual({
    status: 1,
    stderr: "ak delegation: ticket does not exist: absent.json",
    stdout: "",
  });
  expect(ak(command, "ticket.json", bun).error).toMatchObject({ code: "ENOENT" });
}, 60_000);
