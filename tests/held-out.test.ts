import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { forceNotRun } from "../src/held-out/evidence.ts";
import { parseT4Evidence } from "../src/held-out/parse.ts";
import {
  ADJUDICATORS,
  CONTROLS,
  DEFECTS,
  DOCUMENTS,
  HUMAN_STEPS_REL,
  REPS,
  RUNS_PER_HOST,
  SCHEMA_REL,
  TEMPLATE_REL,
  type T4Evidence,
} from "../src/held-out/types.ts";
import { processScratch } from "./helpers/process-tmp.ts";

const REPO = resolve(import.meta.dir, "..");
const SCRIPT = join(REPO, "scripts/t4-held-out.sh");

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

function template(): T4Evidence {
  const parsed = parseT4Evidence(readFileSync(join(REPO, TEMPLATE_REL), "utf8"));
  if (parsed === null) throw new Error("committed T4 template must validate");
  return parsed;
}

function passedRecord(): T4Evidence {
  return {
    ...template(),
    verdict: "passed",
    reason: "Curator and adjudicators filled the record.",
    corpus: { ...template().corpus, location: "/curator/vault" },
    adjudication: { ...template().adjudication, records: [{ seat: "a1" }] },
    metrics: { material_recall: 0.5 },
    scores: { blinded: true },
  };
}

describe("T4 held-out schema (GAP-14)", () => {
  test("the committed template validates as not-run with empty slots", () => {
    const record = template();
    expect(record.verdict).toBe("not-run");
    expect(record.suite).toBe("T4");
    expect(record.gate).toBe("G3");
    expect(record.corpus.documents).toBe(DOCUMENTS);
    expect(record.corpus.defects).toBe(DEFECTS);
    expect(record.corpus.controls).toBe(CONTROLS);
    expect(record.corpus.reps).toBe(REPS);
    expect(record.corpus.runs_per_host).toBe(RUNS_PER_HOST);
    expect(record.corpus.location).toBeNull();
    expect(record.adjudication.adjudicators).toBe(ADJUDICATORS);
    expect(record.adjudication.records).toEqual([]);
    expect(record.metrics.material_recall).toBeNull();
    expect(record.scores).toBeNull();
    expect(record.who_fills.curator.includes("24")).toBe(true);
    expect(record.who_fills.adjudicators.includes("blind")).toBe(true);
    expect(record.human_steps).toBe(HUMAN_STEPS_REL);
    expect(readFileSync(join(REPO, SCHEMA_REL), "utf8").includes("T4 held-out")).toBe(true);
  });

  test("a filled pass with curator location, records and scores validates", () => {
    expect(parseT4Evidence(JSON.stringify(passedRecord()))).not.toBeNull();
  });

  test("rejects a pass with empty adjudication and a not-run with scores", () => {
    expect(parseT4Evidence(JSON.stringify({ ...template(), verdict: "passed" }))).toBeNull();
    expect(
      parseT4Evidence(
        JSON.stringify({ ...passedRecord(), adjudication: { ...passedRecord().adjudication, records: [] } }),
      ),
    ).toBeNull();
    expect(parseT4Evidence(JSON.stringify({ ...passedRecord(), metrics: { material_recall: null } }))).toBeNull();
    expect(parseT4Evidence(JSON.stringify({ ...passedRecord(), scores: null }))).toBeNull();
    expect(
      parseT4Evidence(JSON.stringify({ ...passedRecord(), corpus: { ...passedRecord().corpus, location: null } })),
    ).toBeNull();
    expect(parseT4Evidence(JSON.stringify({ ...template(), scores: { blinded: true } }))).toBeNull();
    expect(parseT4Evidence(JSON.stringify({ ...template(), metrics: { material_recall: 1 } }))).toBeNull();
  });

  test("rejects wrong suite, counts, extra keys and missing required fields", () => {
    expect(parseT4Evidence(JSON.stringify({ ...template(), suite: "T5" }))).toBeNull();
    expect(
      parseT4Evidence(JSON.stringify({ ...template(), corpus: { ...template().corpus, documents: 23 } })),
    ).toBeNull();
    expect(parseT4Evidence(JSON.stringify({ ...template(), extra: true }))).toBeNull();
    const { reason, ...rest } = template();
    expect(reason.length > 0).toBe(true);
    expect(parseT4Evidence(JSON.stringify(rest))).toBeNull();
    expect(parseT4Evidence("{ not json")).toBeNull();
    expect(parseT4Evidence("[]")).toBeNull();
  });
});

describe("T4 held-out command", () => {
  test("evidence prints the empty not-run template and names who fills it", () => {
    const run = runScript(["evidence"]);
    expect(run.status).toBe(0);
    const printed = parseT4Evidence(run.stdout);
    expect(printed === null).toBe(false);
    if (printed === null) return;
    expect(printed.verdict).toBe("not-run");
    expect(printed.scores).toBeNull();
    expect(printed.adjudication.records).toEqual([]);
    expect(printed.corpus.location).toBeNull();
    expect(printed.metrics.material_recall).toBeNull();
    expect(printed.who_fills.curator.includes("curator") || printed.who_fills.curator.includes("24")).toBe(true);
    expect(printed.who_fills.harness.includes("do not mark passed")).toBe(true);
    expect(run.stdout.includes('"verdict": "passed"')).toBe(false);
  });

  test("forceNotRun strips a forged pass", () => {
    const stripped = forceNotRun(passedRecord());
    expect(stripped.verdict).toBe("not-run");
    expect(stripped.scores).toBeNull();
    expect(stripped.adjudication.records).toEqual([]);
    expect(stripped.corpus.location).toBeNull();
    expect(stripped.metrics.material_recall).toBeNull();
    expect(parseT4Evidence(JSON.stringify(stripped))).not.toBeNull();
  });

  test("missing template and bad argv", () => {
    const empty = processScratch("ak-t4-none-");
    mkdirSync(join(empty, "research", "held-out"), { recursive: true });
    const missing = runScript(["evidence", "--cwd", empty]);
    expect(missing.status).toBe(1);
    expect(missing.stdout).toBe("");
    const help = runScript(["--help"]);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("t4-held-out:");
    const refused = [[], ["evidence", "extra"], ["--bogus"], ["passed"]] as const;
    for (const args of refused) {
      const r = runScript(args);
      expect(r.status).toBe(2);
      expect(r.stdout).toBe("");
    }
  });

  test("a template forged to passed still prints not-run", () => {
    const dir = processScratch("ak-t4-forge-");
    mkdirSync(join(dir, "research", "held-out"), { recursive: true });
    writeFileSync(join(dir, TEMPLATE_REL), `${JSON.stringify(passedRecord(), null, 2)}\n`);
    writeFileSync(join(dir, SCHEMA_REL), readFileSync(join(REPO, SCHEMA_REL)));
    const run = runScript(["evidence", "--cwd", dir]);
    expect(run.status).toBe(0);
    const printed = parseT4Evidence(run.stdout);
    expect(printed?.verdict).toBe("not-run");
    expect(printed?.scores).toBeNull();
  });
});
