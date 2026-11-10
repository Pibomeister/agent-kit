import { afterAll, describe, expect, test } from "bun:test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { decideEvidence, TEMPLATE_REL } from "../src/tp-life/evidence.ts";
import { parseEvidenceRecord, parseOracleReport } from "../src/tp-life/parse.ts";
import { compileSchemas } from "../src/validation/schemas.ts";
import { processScratch } from "./helpers/process-tmp.ts";

const REPO = resolve(import.meta.dir, "..");
const SCRIPT = join(REPO, "scripts", "tp-life.sh");
const ORACLE = join(REPO, "tests/fixtures/tp-life/oracle/oracle.mjs");
const SERVICE = join(REPO, "tests/fixtures/tp-life/service/server.mjs");

const children: ChildProcess[] = [];

afterAll(() => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  }
});

function runScript(args: string[], extra: { cwd?: string; timeout?: number } = {}) {
  return spawnSync("bash", [SCRIPT, ...args], {
    cwd: extra.cwd ?? REPO,
    encoding: "utf8",
    timeout: extra.timeout ?? 20_000,
    killSignal: "SIGKILL",
    env: process.env,
  });
}

function startFixture(broken?: string): Promise<string> {
  const args = broken === undefined ? ["fixture"] : ["fixture", "--broken", broken];
  const child = spawn("bash", [SCRIPT, ...args], {
    cwd: REPO,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  return new Promise((ready, reject) => {
    const timer = setTimeout(() => reject(new Error("fixture did not listen")), 8_000);
    let buf = "";
    const onExit = (code: number | null): void => {
      clearTimeout(timer);
      reject(new Error(`fixture exited ${String(code)}: ${buf}`));
    };
    child.once("exit", onExit);
    child.stdout?.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      const match = /listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(buf);
      const base = match?.[1];
      if (base !== undefined) {
        clearTimeout(timer);
        child.removeListener("exit", onExit);
        ready(base);
      }
    });
  });
}

describe("independence", () => {
  test("oracle source does not import the fixture service", () => {
    const oracle = readFileSync(ORACLE, "utf8");
    const service = readFileSync(SERVICE, "utf8");
    expect(oracle.includes("service/server")).toBe(false);
    expect(oracle.includes("service/public")).toBe(false);
    expect(/\bfrom\s+["'][^"']*service/.test(oracle)).toBe(false);
    expect(oracle.includes("takeSnapshot")).toBe(false);
    expect(service.includes("oracle/oracle")).toBe(false);
    expect(service.includes("src/tp-life")).toBe(false);
  });
});

describe("fixture and oracle", () => {
  test("clean fixture: five cases pass", async () => {
    const base = await startFixture();
    const out = join(processScratch("ak-tp-life-"), "oracle.json");
    const run = runScript(["oracle", "--base-url", base, "--out", out]);
    expect(run.status).toBe(0);
    const report = parseOracleReport(readFileSync(out, "utf8"));
    expect(report).not.toBeNull();
    expect(report?.passed).toBe(5);
    expect(report?.failed).toBe(0);
    const html = await fetch(`${base}/`);
    const page = await html.text();
    expect(page.includes('fetch("/jobs/"')).toBe(true);
  });

  test("broken duplicate: oracle fails that case and exits 1", async () => {
    const base = await startFixture("duplicate");
    const run = runScript(["oracle", "--base-url", base]);
    expect(run.status).toBe(1);
    const report = parseOracleReport(run.stdout);
    expect(report).not.toBeNull();
    expect(report?.failed).toBeGreaterThan(0);
    const dup = report?.cases.find((row) => row.id === "duplicate");
    expect(dup?.verdict).toBe("fail");
  });
});

describe("bound receipts", () => {
  test("write then check accepts the current head", async () => {
    const base = await startFixture();
    const dir = processScratch("ak-tp-life-r-");
    const oracleJson = join(dir, "oracle.json");
    const receiptPath = join(dir, "receipt.json");
    const oracle = runScript(["oracle", "--base-url", base, "--out", oracleJson]);
    expect(oracle.status).toBe(0);
    const written = runScript(["receipt", "write", "--oracle-json", oracleJson, "--out", receiptPath]);
    expect(written.status).toBe(0);
    const check = runScript(["receipt", "check", receiptPath]);
    expect(check.status).toBe(0);
    const schemas = compileSchemas(REPO);
    const validate = schemas.validatorFor("verification");
    expect(validate === undefined).toBe(false);
    if (validate === undefined) return;
    // SAFETY: JSON.parse is any; schemas/verification.schema.json is the contract before use.
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as unknown;
    expect(validate(receipt)).toBe(true);
  });

  test("a receipt bound to the wrong head is refused with exit 2", () => {
    const dir = processScratch("ak-tp-life-wrong-");
    const receiptPath = join(dir, "wrong.json");
    writeFileSync(
      receiptPath,
      `${JSON.stringify({ source_revision: { revision: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" } })}\n`,
    );
    const check = runScript(["receipt", "check", receiptPath]);
    expect(check.status).toBe(2);
    expect(check.stderr.includes("refused")).toBe(true);
  });
});

describe("G4 evidence", () => {
  test("template and evidence command stay not-run with no live receipts", () => {
    const raw = readFileSync(join(REPO, TEMPLATE_REL), "utf8");
    const template = parseEvidenceRecord(raw);
    expect(template === null).toBe(false);
    if (template === null) return;
    expect(template.verdict).toBe("not-run");
    expect(template.receipts).toEqual([]);
    expect(decideEvidence(template, 0).verdict).toBe("not-run");
    const forced = decideEvidence({ ...template, verdict: "passed" }, 0);
    expect(forced.verdict).toBe("not-run");
    const run = runScript(["evidence"]);
    expect(run.status).toBe(0);
    const printed = parseEvidenceRecord(run.stdout);
    expect(printed === null).toBe(false);
    if (printed === null) return;
    expect(printed.verdict).toBe("not-run");
  });
});
