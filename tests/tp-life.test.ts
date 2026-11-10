import { afterAll, describe, expect, test } from "bun:test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { decideEvidence, TEMPLATE_REL } from "../src/tp-life/evidence.ts";
import { parseEvidenceRecord, parseOracleReport } from "../src/tp-life/parse.ts";
import { CASE_IDS, type CaseResult, type OracleObservation } from "../src/tp-life/types.ts";
import { compileSchemas } from "../src/validation/schemas.ts";
import { processScratch } from "./helpers/process-tmp.ts";

const REPO = resolve(import.meta.dir, "..");
const SCRIPT = join(REPO, "scripts", "tp-life.sh");
const ORACLE = join(REPO, "tests/fixtures/tp-life/oracle/oracle.mjs");
const SERVICE = join(REPO, "tests/fixtures/tp-life/service/server.mjs");
const ORACLE_TIMEOUT = 25_000;

const children: ChildProcess[] = [];

function stopFixture(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) return;
  try {
    process.kill(-pid, "SIGTERM");
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "ESRCH") return;
  }
}

async function waitGroupGone(pid: number): Promise<void> {
  const deadline = Date.now() + 2000;
  for (;;) {
    try {
      process.kill(-pid, 0);
    } catch (err) {
      if (err instanceof Error && "code" in err && err.code === "ESRCH") return;
      throw err;
    }
    if (Date.now() >= deadline) throw new Error(`fixture process group ${pid} still running`);
    await new Promise((settle) => setTimeout(settle, 50));
  }
}

afterAll(async () => {
  for (const child of children) stopFixture(child);
  for (const child of children) {
    if (child.pid !== undefined) await waitGroupGone(child.pid);
  }
});

function runScript(args: string[], extra: { cwd?: string; timeout?: number } = {}) {
  return spawnSync("bash", [SCRIPT, ...args], {
    cwd: extra.cwd ?? REPO,
    encoding: "utf8",
    timeout: extra.timeout ?? ORACLE_TIMEOUT,
    killSignal: "SIGKILL",
    env: process.env,
  });
}

function startFixture(broken?: string): Promise<string> {
  const args = broken === undefined ? [SERVICE] : [SERVICE, "--broken", broken];
  const child = spawn(process.execPath, args, {
    cwd: REPO,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
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
    child.stderr?.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
    });
  });
}

function evidenceAt(receiptsDir: string) {
  return runScript(["evidence", "--receipts-dir", receiptsDir]);
}

interface WrittenOracle {
  oracle: string;
  receipt: string;
  status: number;
}

function allCases(failId?: string): CaseResult[] {
  const out: CaseResult[] = [];
  for (const id of CASE_IDS) {
    out.push({
      id,
      verdict: failId === id ? "fail" : "pass",
      detail: "fixture",
    });
  }
  return out;
}

function observation(
  path: string,
  digest: string,
  status: string,
  exitStatus: number,
  failId?: string,
): OracleObservation {
  return {
    path,
    digest,
    status,
    exit_status: exitStatus,
    cases: allCases(failId),
  };
}

function writeOracle(base: string, dir: string, name: string): WrittenOracle {
  const oracleJson = join(dir, `${name}.oracle.json`);
  const receiptPath = join(dir, `${name}.json`);
  const oracle = runScript(["oracle", "--base-url", base, "--out", oracleJson]);
  const written = runScript(["receipt", "write", "--oracle-json", oracleJson, "--out", receiptPath]);
  expect(written.status).toBe(0);
  return { oracle: oracleJson, receipt: receiptPath, status: oracle.status ?? 1 };
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
  test("clean fixture: six cases pass", async () => {
    const base = await startFixture();
    const out = join(processScratch("ak-tp-life-"), "oracle.json");
    const run = runScript(["oracle", "--base-url", base, "--out", out]);
    expect(run.status).toBe(0);
    const report = parseOracleReport(readFileSync(out, "utf8"));
    expect(report).not.toBeNull();
    expect(report?.passed).toBe(CASE_IDS.length);
    expect(report?.failed).toBe(0);
    expect(report?.base_url).toBe(base);
    expect((report?.duration_ms ?? -1) >= 0).toBe(true);
    const html = await fetch(`${base}/`);
    const page = await html.text();
    expect(page.includes('fetch("/jobs/"')).toBe(true);
  });

  test("two back-to-back clean runs against one fixture both pass", async () => {
    const base = await startFixture();
    const first = runScript(["oracle", "--base-url", base]);
    expect(first.status).toBe(0);
    const second = runScript(["oracle", "--base-url", base]);
    expect(second.status).toBe(0);
  });

  for (const id of CASE_IDS) {
    test(`broken ${id}: only that case fails`, async () => {
      const base = await startFixture(id);
      const run = runScript(["oracle", "--base-url", base]);
      expect(run.status).toBe(1);
      const report = parseOracleReport(run.stdout);
      expect(report).not.toBeNull();
      if (report === null) return;
      expect(report.failed).toBe(1);
      expect(report.passed).toBe(CASE_IDS.length - 1);
      for (const row of report.cases) {
        expect(row.verdict).toBe(row.id === id ? "fail" : "pass");
      }
    });
  }

  test("unknown --broken is refused", () => {
    const run = spawnSync("bash", [SCRIPT, "fixture", "--broken", "nope"], {
      cwd: REPO,
      encoding: "utf8",
      timeout: 5_000,
      env: process.env,
    });
    expect(run.status).toBe(2);
    expect(run.stderr.includes("unknown --broken")).toBe(true);
  });

  test("unknown AK_TP_LIFE_BROKEN is refused", () => {
    const run = spawnSync("bash", [SCRIPT, "fixture"], {
      cwd: REPO,
      encoding: "utf8",
      timeout: 5_000,
      env: { ...process.env, AK_TP_LIFE_BROKEN: "nope" },
    });
    expect(run.status).toBe(2);
    expect(run.stderr.includes("unknown --broken")).toBe(true);
  });
});

describe("bound receipts", () => {
  test("write then check accepts the current head", async () => {
    const base = await startFixture();
    const dir = processScratch("ak-tp-life-r-");
    const written = writeOracle(base, dir, "receipt");
    expect(written.status).toBe(0);
    const check = runScript(["receipt", "check", written.receipt]);
    expect(check.status).toBe(0);
    const cwdFirst = runScript(["receipt", "check", "--cwd", REPO, written.receipt]);
    expect(cwdFirst.status).toBe(0);
    const schemas = compileSchemas(REPO);
    const validate = schemas.validatorFor("verification");
    expect(validate === undefined).toBe(false);
    if (validate === undefined) return;
    // SAFETY: JSON.parse is any; schemas/verification.schema.json is the contract before use.
    const receipt = JSON.parse(readFileSync(written.receipt, "utf8")) as unknown;
    expect(validate(receipt)).toBe(true);
    const raw = readFileSync(written.receipt, "utf8");
    expect(raw.includes("unattested:")).toBe(true);
    expect(raw.includes("tp-life-unattested")).toBe(true);
    expect(raw.includes("host_login")).toBe(true);
    expect(raw.includes("cases")).toBe(true);
  });

  test("a receipt bound to the wrong head is refused with exit 2", async () => {
    const base = await startFixture();
    const dir = processScratch("ak-tp-life-wrong-");
    const written = writeOracle(base, dir, "receipt");
    const mutatedPath = join(dir, "wrong-head.json");
    const mutated = readFileSync(written.receipt, "utf8").replace(
      /"revision": "[0-9a-f]{40}"/,
      '"revision": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"',
    );
    writeFileSync(mutatedPath, mutated);
    const check = runScript(["receipt", "check", mutatedPath]);
    expect(check.status).toBe(2);
    expect(check.stderr.includes("refused")).toBe(true);
  });

  test("a receipt missing diff_hash is refused with exit 2", async () => {
    const base = await startFixture();
    const dir = processScratch("ak-tp-life-nodiff-");
    const written = writeOracle(base, dir, "receipt");
    const missingPath = join(dir, "missing-hash.json");
    const missing = readFileSync(written.receipt, "utf8").replace(/,\s*"diff_hash": "sha256:[0-9a-f]+"/, "");
    writeFileSync(missingPath, missing);
    const check = runScript(["receipt", "check", missingPath]);
    expect(check.status).toBe(2);
    expect(check.stderr.includes("diff_hash is missing")).toBe(true);
    expect(check.stderr.includes("is invalid")).toBe(false);
  });

  test("a receipt with an invalid diff_hash is refused as invalid", async () => {
    const base = await startFixture();
    const dir = processScratch("ak-tp-life-baddiffshape-");
    const written = writeOracle(base, dir, "receipt");
    const mutatedPath = join(dir, "invalid-hash.json");
    const mutated = readFileSync(written.receipt, "utf8").replace(
      /"diff_hash": "sha256:[0-9a-f]+"/,
      '"diff_hash": "not-a-hash"',
    );
    writeFileSync(mutatedPath, mutated);
    const check = runScript(["receipt", "check", mutatedPath]);
    expect(check.status).toBe(2);
    expect(check.stderr.includes("diff_hash is invalid")).toBe(true);
    expect(check.stderr.includes("is missing")).toBe(false);
  });

  test("a receipt with a 40-character non-hex revision is refused as invalid", async () => {
    const base = await startFixture();
    const dir = processScratch("ak-tp-life-badrev-");
    const written = writeOracle(base, dir, "receipt");
    const mutatedPath = join(dir, "invalid-rev.json");
    const mutated = readFileSync(written.receipt, "utf8").replace(
      /"revision": "[0-9a-f]{40}"/,
      `"revision": "${"z".repeat(40)}"`,
    );
    writeFileSync(mutatedPath, mutated);
    const check = runScript(["receipt", "check", mutatedPath]);
    expect(check.status).toBe(2);
    expect(check.stderr.includes("revision is invalid")).toBe(true);
  });

  test("a receipt with a different diff_hash is refused with exit 2", async () => {
    const base = await startFixture();
    const dir = processScratch("ak-tp-life-baddiff-");
    const written = writeOracle(base, dir, "receipt");
    const mutatedPath = join(dir, "other-hash.json");
    const mutated = readFileSync(written.receipt, "utf8").replace(
      /"diff_hash": "sha256:[0-9a-f]+"/,
      `"diff_hash": "sha256:${"b".repeat(64)}"`,
    );
    writeFileSync(mutatedPath, mutated);
    const check = runScript(["receipt", "check", mutatedPath]);
    expect(check.status).toBe(2);
    expect(check.stderr.includes("different working tree")).toBe(true);
  });

  test("a genuine oracle receipt copied into a temp receipts dir binds and leaves G4 not-run", async () => {
    const base = await startFixture();
    const dir = processScratch("ak-tp-life-bind-");
    const receiptsDir = join(dir, "receipts");
    mkdirSync(receiptsDir);
    const written = writeOracle(base, dir, "receipt");
    expect(written.status).toBe(0);
    copyFileSync(written.receipt, join(receiptsDir, "passed.json"));
    const check = runScript(["receipt", "check", join(receiptsDir, "passed.json")]);
    expect(check.status).toBe(0);
    const evidence = evidenceAt(receiptsDir);
    expect(evidence.status).toBe(0);
    const printed = parseEvidenceRecord(evidence.stdout);
    expect(printed === null).toBe(false);
    if (printed === null) return;
    expect(printed.verdict).toBe("not-run");
    expect(printed.oracle_sub_verdict).toBe("incomplete");
    expect(printed.receipts.length).toBe(1);
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
    expect(raw.includes("FR-12")).toBe(false);
    expect(template.covers).toEqual(["AT-01", "AT-16", "AT-24", "AT-25", "AT-26"]);
    const empty = decideEvidence(template, []);
    expect(empty.verdict).toBe("not-run");
    expect(empty.oracle_sub_verdict).toBe("incomplete");
    const forced = decideEvidence({ ...template, verdict: "passed", receipts: ["nope.json"] }, []);
    expect(forced.verdict).toBe("not-run");
    expect(forced.receipts).toEqual([]);
    const receiptsDir = join(processScratch("ak-tp-life-empty-"), "receipts");
    mkdirSync(receiptsDir);
    const run = evidenceAt(receiptsDir);
    expect(run.status).toBe(0);
    const printed = parseEvidenceRecord(run.stdout);
    expect(printed === null).toBe(false);
    if (printed === null) return;
    expect(printed.verdict).toBe("not-run");
    expect(printed.oracle_sub_verdict).toBe("incomplete");
    expect(printed.receipts).toEqual([]);
    expect(printed.reason.includes("unattested receipts")).toBe(true);
    expect(printed.reason.includes("per-case comparison inside each receipt")).toBe(true);
  });

  test("a forged receipt bound to this head still leaves G4 not-run", async () => {
    const base = await startFixture();
    const dir = processScratch("ak-tp-life-forged-");
    const receiptsDir = join(dir, "receipts");
    mkdirSync(receiptsDir);
    const written = writeOracle(base, dir, "receipt");
    const forged = readFileSync(written.receipt, "utf8").replace(/"id": "tp-life-oracle"/, '"id": "forged-receipt"');
    writeFileSync(join(receiptsDir, "forged.json"), forged);
    const check = runScript(["receipt", "check", join(receiptsDir, "forged.json")]);
    expect(check.status).toBe(0);
    const run = evidenceAt(receiptsDir);
    expect(run.status).toBe(0);
    const printed = parseEvidenceRecord(run.stdout);
    expect(printed?.verdict).toBe("not-run");
    expect(printed?.oracle_sub_verdict).toBe("incomplete");
    expect(printed?.receipts).toEqual([]);
  });

  test("a failed oracle receipt alone leaves oracle_sub_verdict incomplete", async () => {
    const base = await startFixture("duplicate");
    const dir = processScratch("ak-tp-life-fail-");
    const receiptsDir = join(dir, "receipts");
    mkdirSync(receiptsDir);
    const written = writeOracle(base, dir, "failed");
    expect(written.status).toBe(1);
    copyFileSync(written.receipt, join(receiptsDir, "failed.json"));
    const check = runScript(["receipt", "check", join(receiptsDir, "failed.json")]);
    expect(check.status).toBe(0);
    const run = evidenceAt(receiptsDir);
    expect(run.status).toBe(0);
    const printed = parseEvidenceRecord(run.stdout);
    expect(printed?.verdict).toBe("not-run");
    expect(printed?.oracle_sub_verdict).toBe("incomplete");
    expect(printed?.receipts.length).toBe(1);
  });

  test("failed duplicate-only plus passed receipts print red-to-green and G4 not-run", async () => {
    const failedBase = await startFixture("duplicate");
    const passedBase = await startFixture();
    const dir = processScratch("ak-tp-life-pair-");
    const receiptsDir = join(dir, "receipts");
    mkdirSync(receiptsDir);
    const failed = writeOracle(failedBase, dir, "failed");
    expect(failed.status).toBe(1);
    const passed = writeOracle(passedBase, dir, "passed");
    expect(passed.status).toBe(0);
    copyFileSync(failed.receipt, join(receiptsDir, "failed.json"));
    copyFileSync(passed.receipt, join(receiptsDir, "passed.json"));
    copyFileSync(passed.receipt, join(receiptsDir, "passed-copy.json"));
    const run = evidenceAt(receiptsDir);
    expect(run.status).toBe(0);
    const printed = parseEvidenceRecord(run.stdout);
    expect(printed?.verdict).toBe("not-run");
    expect(printed?.oracle_sub_verdict).toBe("red-to-green");
    expect(printed?.receipts.length).toBe(2);
    expect(printed?.reason.includes("unattested receipts")).toBe(true);
    expect(printed?.reason.includes("origin")).toBe(true);
    expect(printed?.reason.includes("the head they ran on rest on the operator's word")).toBe(true);
    expect(printed?.reason.includes("per-case comparison inside each receipt")).toBe(true);
    expect(printed?.reason.includes("observed on this head")).toBe(false);
    const passedRaw = readFileSync(passed.receipt, "utf8");
    expect(passedRaw.includes("host_login")).toBe(true);
    expect(passedRaw.includes("porcelain")).toBe(true);
  });

  test("a broken-success failed receipt plus a passed receipt is incomplete", async () => {
    const failedBase = await startFixture("success");
    const passedBase = await startFixture();
    const dir = processScratch("ak-tp-life-success-pair-");
    const receiptsDir = join(dir, "receipts");
    mkdirSync(receiptsDir);
    const failed = writeOracle(failedBase, dir, "failed");
    expect(failed.status).toBe(1);
    const passed = writeOracle(passedBase, dir, "passed");
    expect(passed.status).toBe(0);
    copyFileSync(failed.receipt, join(receiptsDir, "failed.json"));
    copyFileSync(passed.receipt, join(receiptsDir, "passed.json"));
    const run = evidenceAt(receiptsDir);
    expect(run.status).toBe(0);
    const printed = parseEvidenceRecord(run.stdout);
    expect(printed?.verdict).toBe("not-run");
    expect(printed?.oracle_sub_verdict).toBe("incomplete");
  });

  test("a passed receipt with a failing case is incomplete", async () => {
    const base = await startFixture();
    const dir = processScratch("ak-tp-life-pass-failcase-");
    const receiptsDir = join(dir, "receipts");
    mkdirSync(receiptsDir);
    const failedBase = await startFixture("duplicate");
    const failed = writeOracle(failedBase, dir, "failed");
    expect(failed.status).toBe(1);
    const passed = writeOracle(base, dir, "passed");
    expect(passed.status).toBe(0);
    const mutated = readFileSync(passed.receipt, "utf8").replace(
      '\\"id\\":\\"success\\",\\"verdict\\":\\"pass\\"',
      '\\"id\\":\\"success\\",\\"verdict\\":\\"fail\\"',
    );
    copyFileSync(failed.receipt, join(receiptsDir, "failed.json"));
    writeFileSync(join(receiptsDir, "passed.json"), mutated);
    const run = evidenceAt(receiptsDir);
    expect(run.status).toBe(0);
    const printed = parseEvidenceRecord(run.stdout);
    expect(printed?.oracle_sub_verdict).toBe("incomplete");
  });

  test("a failed observation with a non-1 exit_status is incomplete", () => {
    const raw = readFileSync(join(REPO, TEMPLATE_REL), "utf8");
    const template = parseEvidenceRecord(raw);
    expect(template === null).toBe(false);
    if (template === null) return;
    const printed = decideEvidence(template, [
      observation("failed.json", "sha256:a", "failed", 0, "duplicate"),
      observation("passed.json", "sha256:b", "passed", 0),
    ]);
    expect(printed.verdict).toBe("not-run");
    expect(printed.oracle_sub_verdict).toBe("incomplete");
  });

  test("a passed observation with nonzero exit_status is incomplete", () => {
    const raw = readFileSync(join(REPO, TEMPLATE_REL), "utf8");
    const template = parseEvidenceRecord(raw);
    expect(template === null).toBe(false);
    if (template === null) return;
    const printed = decideEvidence(template, [
      observation("failed.json", "sha256:a", "failed", 1, "duplicate"),
      observation("passed.json", "sha256:b", "passed", 1),
    ]);
    expect(printed.verdict).toBe("not-run");
    expect(printed.oracle_sub_verdict).toBe("incomplete");
  });

  test("a receipt of the wrong kind is not counted", async () => {
    const base = await startFixture();
    const dir = processScratch("ak-tp-life-kind-");
    const receiptsDir = join(dir, "receipts");
    mkdirSync(receiptsDir);
    const written = writeOracle(base, dir, "receipt");
    const mutated = readFileSync(written.receipt, "utf8").replace(
      '"kind": "command"',
      '"kind": "probe",\n  "probe": { "name": "tp-life", "target": "jobs" }',
    );
    writeFileSync(join(receiptsDir, "probe.json"), mutated);
    const check = runScript(["receipt", "check", join(receiptsDir, "probe.json")]);
    expect(check.status).toBe(0);
    const run = evidenceAt(receiptsDir);
    expect(run.status).toBe(0);
    const printed = parseEvidenceRecord(run.stdout);
    expect(printed?.oracle_sub_verdict).toBe("incomplete");
    expect(printed?.receipts).toEqual([]);
  });

  test("a receipt with a different source_revision.repo is refused with exit 2", async () => {
    const base = await startFixture();
    const dir = processScratch("ak-tp-life-repo-");
    const written = writeOracle(base, dir, "receipt");
    const mutatedPath = join(dir, "other-repo.json");
    const mutated = readFileSync(written.receipt, "utf8").replace(
      /("source_revision": \{\s*"repo": ")([^"]+)(")/,
      "$1https://example.invalid/other$3",
    );
    writeFileSync(mutatedPath, mutated);
    const check = runScript(["receipt", "check", mutatedPath]);
    expect(check.status).toBe(2);
    expect(check.stderr.includes("different repo")).toBe(true);
  });

  test("stopping a fixture leaves no listener on its port", async () => {
    const base = await startFixture();
    const port = base.slice("http://127.0.0.1:".length);
    const child = children[children.length - 1];
    expect(child === undefined).toBe(false);
    if (child === undefined) return;
    const alive = await fetch(base, { signal: AbortSignal.timeout(500) });
    expect(alive.ok).toBe(true);
    stopFixture(child);
    const deadline = Date.now() + 2000;
    let open = true;
    while (Date.now() < deadline) {
      try {
        await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(150) });
      } catch {
        open = false;
        break;
      }
    }
    expect(open).toBe(false);
  });

  test("an edited template verdict does not pass G4", () => {
    const raw = readFileSync(join(REPO, TEMPLATE_REL), "utf8");
    const template = parseEvidenceRecord(raw);
    expect(template === null).toBe(false);
    if (template === null) return;
    const edited = decideEvidence({ ...template, verdict: "passed" }, []);
    expect(edited.verdict).toBe("not-run");
    expect(edited.oracle_sub_verdict).toBe("incomplete");
    expect(edited.receipts).toEqual([]);
  });
});
