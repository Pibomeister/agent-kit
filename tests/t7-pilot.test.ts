import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { forceNotRun } from "../src/t7-pilot/evidence.ts";
import { parseT7Evidence } from "../src/t7-pilot/parse.ts";
import {
  CHANGES_REQUIRED,
  HUMAN_STEPS_REL,
  REPOS_REQUIRED,
  SCHEMA_REL,
  TEMPLATE_REL,
  type T7Evidence,
} from "../src/t7-pilot/types.ts";
import { processScratch } from "./helpers/process-tmp.ts";

const REPO = resolve(import.meta.dir, "..");
const SCRIPT = join(REPO, "scripts/t7-pilot.sh");

function scriptEnv(): NodeJS.ProcessEnv {
  const bunDir = dirname(process.execPath);
  const path = `${bunDir}:${process.env["PATH"] ?? ""}`;
  return { ...process.env, PATH: path, GIT_CONFIG_GLOBAL: "/dev/null" };
}

function runScript(args: readonly string[], cwd: string = REPO) {
  return spawnSync("bash", [SCRIPT, ...args], {
    cwd,
    encoding: "utf8",
    timeout: 30_000,
    killSignal: "SIGKILL",
    env: scriptEnv(),
  });
}

function template(): T7Evidence {
  const parsed = parseT7Evidence(readFileSync(join(REPO, TEMPLATE_REL), "utf8"));
  if (parsed === null) throw new Error("committed T7 template must validate");
  return parsed;
}

function human(value: number) {
  return { value, recorder: "human" as const };
}

function passedRecord(): T7Evidence {
  const changes = Array.from({ length: CHANGES_REQUIRED }, (_, i) => ({ id: `c${i}` }));
  return {
    ...template(),
    verdict: "passed",
    reason: "Maintainer named the repos. Humans recorded the measures.",
    pilot: {
      ...template().pilot,
      repos: ["repo-a", "repo-b"],
      matched_baseline: "human-baseline",
      changes,
    },
    measures: { rework: human(1), cost: human(2), attention: human(3) },
  };
}

describe("T7 pilot schema (GAP-16)", () => {
  test("the committed template validates as not-run with empty slots", () => {
    const record = template();
    expect(record.verdict).toBe("not-run");
    expect(record.suite).toBe("T7");
    expect(record.gate).toBe("G5");
    expect(record.pilot.changes_required).toBe(CHANGES_REQUIRED);
    expect(record.pilot.repos_required).toBe(REPOS_REQUIRED);
    expect(record.pilot.repos).toEqual([]);
    expect(record.pilot.matched_baseline).toBeNull();
    expect(record.pilot.changes).toEqual([]);
    expect(record.measures.rework).toBeNull();
    expect(record.who_fills.maintainer.includes("two repos")).toBe(true);
    expect(record.who_fills.humans.includes("must not self-report")).toBe(true);
    expect(record.human_steps).toBe(HUMAN_STEPS_REL);
  });

  test("a filled pass with two repos, 20 changes and human measures validates", () => {
    expect(parseT7Evidence(JSON.stringify(passedRecord()))).not.toBeNull();
  });

  test("rejects a pass with empty repos and an agent recorder", () => {
    expect(parseT7Evidence(JSON.stringify({ ...template(), verdict: "passed" }))).toBeNull();
    expect(
      parseT7Evidence(JSON.stringify({ ...passedRecord(), pilot: { ...passedRecord().pilot, repos: ["one"] } })),
    ).toBeNull();
    expect(
      parseT7Evidence(JSON.stringify({ ...passedRecord(), measures: { ...passedRecord().measures, rework: null } })),
    ).toBeNull();
    expect(
      parseT7Evidence(
        JSON.stringify({
          ...passedRecord(),
          measures: { ...passedRecord().measures, rework: { value: 1, recorder: "agent" } },
        }),
      ),
    ).toBeNull();
    expect(
      parseT7Evidence(JSON.stringify({ ...template(), measures: { ...template().measures, rework: human(1) } })),
    ).toBeNull();
  });

  test("rejects wrong suite, extra keys and missing required fields", () => {
    expect(parseT7Evidence(JSON.stringify({ ...template(), suite: "T4" }))).toBeNull();
    expect(parseT7Evidence(JSON.stringify({ ...template(), extra: true }))).toBeNull();
    const { reason, ...rest } = template();
    expect(reason.length > 0).toBe(true);
    expect(parseT7Evidence(JSON.stringify(rest))).toBeNull();
    expect(parseT7Evidence("{ not json")).toBeNull();
  });
});

describe("T7 pilot command", () => {
  test("evidence prints the empty not-run template and names who fills it", () => {
    const run = runScript(["evidence"]);
    expect(run.status).toBe(0);
    const printed = parseT7Evidence(run.stdout);
    expect(printed === null).toBe(false);
    if (printed === null) return;
    expect(printed.verdict).toBe("not-run");
    expect(printed.pilot.repos).toEqual([]);
    expect(printed.measures.rework).toBeNull();
    expect(printed.who_fills.harness.includes("do not mark passed")).toBe(true);
    expect(run.stdout.includes('"verdict": "passed"')).toBe(false);
  });

  test("forceNotRun strips a forged pass", () => {
    const stripped = forceNotRun(passedRecord());
    expect(stripped.verdict).toBe("not-run");
    expect(stripped.pilot.repos).toEqual([]);
    expect(stripped.measures).toEqual({ rework: null, cost: null, attention: null });
    expect(parseT7Evidence(JSON.stringify(stripped))).not.toBeNull();
  });

  test("missing template and bad argv", () => {
    const empty = processScratch("ak-t7-none-");
    mkdirSync(join(empty, "research", "t7-pilot"), { recursive: true });
    const missing = runScript(["evidence", "--cwd", empty]);
    expect(missing.status).toBe(1);
    expect(missing.stdout).toBe("");
    const help = runScript(["--help"]);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("t7-pilot:");
    const refused = [[], ["evidence", "extra"], ["--bogus"]] as const;
    for (const args of refused) {
      const r = runScript(args);
      expect(r.status).toBe(2);
      expect(r.stdout).toBe("");
    }
  });

  test("a template forged to passed still prints not-run", () => {
    const dir = processScratch("ak-t7-forge-");
    mkdirSync(join(dir, "research", "t7-pilot"), { recursive: true });
    writeFileSync(join(dir, TEMPLATE_REL), `${JSON.stringify(passedRecord(), null, 2)}\n`);
    writeFileSync(join(dir, SCHEMA_REL), readFileSync(join(REPO, SCHEMA_REL)));
    const run = runScript(["evidence", "--cwd", dir]);
    expect(run.status).toBe(0);
    const printed = parseT7Evidence(run.stdout);
    expect(printed?.verdict).toBe("not-run");
    expect(printed?.pilot.repos).toEqual([]);
  });
});
