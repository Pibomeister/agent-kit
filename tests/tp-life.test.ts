import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { decideEvidence, TEMPLATE_REL } from "../src/tp-life/evidence.ts";
import { parseEvidenceRecord, parseOracleReport } from "../src/tp-life/parse.ts";
import { redactRepoUrl } from "../src/tp-life/receipt.ts";
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
  if (child.exitCode !== null || child.signalCode !== null) return;
  const pid = child.pid;
  if (pid === undefined) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "ESRCH") return;
  }
}

async function waitGone(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const pid = child.pid;
  if (pid === undefined) return;
  const deadline = Date.now() + 2000;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch (err) {
      if (err instanceof Error && "code" in err && err.code === "ESRCH") return;
      throw err;
    }
    if (Date.now() >= deadline) throw new Error(`fixture ${pid} still running`);
    await new Promise((settle) => setTimeout(settle, 50));
  }
}

async function stopRunChildren(): Promise<void> {
  for (const child of children) stopFixture(child);
  for (const child of children) await waitGone(child);
  children.length = 0;
}

afterEach(stopRunChildren);

function onSigint(): void {
  for (const child of children) stopFixture(child);
  process.exit(130);
}

function onSigterm(): void {
  for (const child of children) stopFixture(child);
  process.exit(143);
}

beforeAll(() => {
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
});

afterAll(() => {
  process.off("SIGINT", onSigint);
  process.off("SIGTERM", onSigterm);
});

function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.PORT;
  delete env.AK_TP_LIFE_BROKEN;
  return { ...env, ...extra };
}

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
  const args = [SERVICE, "--port", "0"];
  if (broken !== undefined) args.push("--broken", broken);
  const child = spawn(process.execPath, args, {
    cwd: REPO,
    env: childEnv(),
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
    child.stderr?.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
    });
  });
}

function evidenceAt(receiptsDir: string, repo = REPO) {
  return runScript(["evidence", "--cwd", repo, "--receipts-dir", receiptsDir]);
}

interface WrittenOracle {
  oracle: string;
  receipt: string;
  status: number;
  repo: string;
}

/** Git env for a fixture repo: cwd is the repo, and the crowded per-user temp dir is not used. */
function isolatedGitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    TMPDIR: "/tmp",
  };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_CEILING_DIRECTORIES;
  return env;
}

/**
 * A private one-commit checkout with this repo's schemas, package.json and evidence template.
 * Receipt binding snapshots whatever `--cwd` names. The suite's other files run git in the
 * working tree at the same time, and a snapshot that fails operationally exits 1, which is
 * the code a diff_hash refusal is not. Binding against this checkout keeps that snapshot
 * off the shared work tree.
 */
function boundRepo(): string {
  const work = processScratch("ak-tp-life-bound-");
  cpSync(join(REPO, "schemas"), join(work, "schemas"), { recursive: true });
  copyFileSync(join(REPO, "package.json"), join(work, "package.json"));
  mkdirSync(join(work, "research/tp-life"), { recursive: true });
  copyFileSync(join(REPO, TEMPLATE_REL), join(work, TEMPLATE_REL));
  const env = isolatedGitEnv();
  const git = (args: string[]): void => {
    const result = spawnSync("git", ["-C", work, ...args], { env, encoding: "utf8" });
    if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  };
  git(["init", "-q"]);
  git(["add", "-A"]);
  git(["-c", "user.email=td@example.invalid", "-c", "user.name=td", "commit", "-qm", "bound"]);
  return work;
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
  createdAt?: string,
): OracleObservation {
  return {
    path,
    digest,
    status,
    exit_status: exitStatus,
    created_at: createdAt,
    cases: allCases(failId),
  };
}

const OLD_REDACT = /^([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^@/]+@/;

const REDACT_ROWS: { input: string; output: string }[] = [
  { input: "https://user:pass@host/repo", output: "https://host/repo" },
  { input: "https://token@host/repo", output: "https://host/repo" },
  { input: "ssh://git@host/repo", output: "ssh://host/repo" },
  { input: "HTTPS://x:y@host/repo", output: "HTTPS://host/repo" },
  { input: "git+https://x:y@host/repo", output: "git+https://host/repo" },
  { input: "https://user:p%40ss@host/repo", output: "https://host/repo" },
  { input: "https://user:p@ss@host/repo", output: "https://host/repo" },
  { input: "https://evil?@github.com/o/r", output: "https://evil?@github.com/o/r" },
  { input: "https://evil#@github.com/o/r", output: "https://evil#@github.com/o/r" },
  { input: "https://github.com/o/r", output: "https://github.com/o/r" },
  { input: "https://github.com/o/@r", output: "https://github.com/o/@r" },
  { input: "git@host:o/r", output: "git@host:o/r" },
];

function isConnRefused(err: Error): boolean {
  let cur: Error | undefined = err;
  for (let i = 0; i < 6 && cur !== undefined; i += 1) {
    if ("code" in cur && (cur.code === "ECONNREFUSED" || cur.code === "ConnectionRefused")) return true;
    const next: unknown = "cause" in cur ? cur.cause : undefined;
    cur = next instanceof Error ? next : undefined;
  }
  return false;
}

function writeOracle(base: string, dir: string, name: string, repo = boundRepo()): WrittenOracle {
  const oracleJson = join(dir, `${name}.oracle.json`);
  const receiptPath = join(dir, `${name}.json`);
  const oracle = runScript(["oracle", "--base-url", base, "--out", oracleJson]);
  const written = runScript(["receipt", "write", "--cwd", repo, "--oracle-json", oracleJson, "--out", receiptPath]);
  expect(written.status, written.stderr).toBe(0);
  expect(written.stderr.includes("will stale")).toBe(false);
  return { oracle: oracleJson, receipt: receiptPath, status: oracle.status ?? 1, repo };
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
    const run = spawnSync("bash", [SCRIPT, "fixture", "--port", "0", "--broken", "nope"], {
      cwd: REPO,
      encoding: "utf8",
      timeout: 5_000,
      env: childEnv(),
    });
    expect(run.status).toBe(2);
    expect(run.stderr.includes("unknown --broken")).toBe(true);
  });

  test("unknown AK_TP_LIFE_BROKEN is refused", () => {
    const run = spawnSync("bash", [SCRIPT, "fixture", "--port", "0"], {
      cwd: REPO,
      encoding: "utf8",
      timeout: 5_000,
      env: childEnv({ AK_TP_LIFE_BROKEN: "nope" }),
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
    const check = runScript(["receipt", "check", "--cwd", written.repo, written.receipt]);
    expect(check.status, check.stderr).toBe(0);
    const cwdFirst = runScript(["receipt", "check", "--cwd", written.repo, written.receipt]);
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

  test("write then check with a relative path", async () => {
    const base = await startFixture();
    const work = processScratch("ak-tp-life-rel-");
    const oracleJson = join(work, "report.oracle.json");
    const oracle = runScript(["oracle", "--base-url", base, "--out", oracleJson]);
    expect(oracle.status).toBe(0);
    cpSync(join(REPO, "schemas"), join(work, "schemas"), { recursive: true });
    copyFileSync(join(REPO, "package.json"), join(work, "package.json"));
    writeFileSync(join(work, ".gitignore"), "rel.json\n");
    const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
    const init = spawnSync("git", ["-C", work, "init", "-q"], { env: gitEnv });
    expect(init.status).toBe(0);
    const add = spawnSync("git", ["-C", work, "add", "-A"], { env: gitEnv });
    expect(add.status).toBe(0);
    const commit = spawnSync(
      "git",
      ["-C", work, "-c", "user.email=td@example.invalid", "-c", "user.name=td", "commit", "-qm", "td"],
      { encoding: "utf8", env: gitEnv },
    );
    expect(commit.status).toBe(0);
    const written = runScript(["receipt", "write", "--cwd", work, "--oracle-json", oracleJson, "--out", "rel.json"]);
    expect(written.status).toBe(0);
    expect(existsSync(join(work, "rel.json"))).toBe(true);
    expect(existsSync(join(REPO, "rel.json"))).toBe(false);
    const check = runScript(["receipt", "check", "--cwd", work, "rel.json"]);
    expect(check.status).toBe(0);
  });

  test("receipt write redacts origin userinfo", async () => {
    const base = await startFixture();
    const dir = processScratch("ak-tp-life-userinfo-");
    const work = join(dir, "repo");
    mkdirSync(work);
    const oracleJson = join(dir, "report.oracle.json");
    expect(runScript(["oracle", "--base-url", base, "--out", oracleJson]).status).toBe(0);
    cpSync(join(REPO, "schemas"), join(work, "schemas"), { recursive: true });
    copyFileSync(join(REPO, "package.json"), join(work, "package.json"));
    const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
    expect(spawnSync("git", ["-C", work, "init", "-q"], { env: gitEnv }).status).toBe(0);
    expect(
      spawnSync("git", ["-C", work, "remote", "add", "origin", "https://x:tok_aw1@example.invalid/repo.git"], {
        env: gitEnv,
      }).status,
    ).toBe(0);
    expect(spawnSync("git", ["-C", work, "add", "-A"], { env: gitEnv }).status).toBe(0);
    expect(
      spawnSync(
        "git",
        ["-C", work, "-c", "user.email=td@example.invalid", "-c", "user.name=td", "commit", "-qm", "td"],
        { env: gitEnv },
      ).status,
    ).toBe(0);
    const out = join(dir, "receipt.json");
    const written = runScript(["receipt", "write", "--cwd", work, "--oracle-json", oracleJson, "--out", out]);
    expect(written.status).toBe(0);
    const raw = readFileSync(out, "utf8");
    expect(raw.includes("tok_aw1")).toBe(false);
    expect(raw.includes("https://example.invalid/repo.git")).toBe(true);
    const check = runScript(["receipt", "check", "--cwd", work, out]);
    expect(check.status).toBe(0);
  });

  test("redactRepoUrl covers the userinfo table", () => {
    for (const row of REDACT_ROWS) {
      expect(redactRepoUrl(row.input)).toBe(row.output);
    }
  });

  test("the previous userinfo regex fails the redaction table", () => {
    let failed = 0;
    for (const row of REDACT_ROWS) {
      if (row.input.replace(OLD_REDACT, "$1") !== row.output) failed += 1;
    }
    expect(failed > 0).toBe(true);
  });

  test("receipt write redacts base_url userinfo and allowlists host_login", async () => {
    const base = await startFixture();
    const dir = processScratch("ak-tp-life-login-");
    const oracleJson = join(dir, "report.oracle.json");
    expect(runScript(["oracle", "--base-url", base, "--out", oracleJson]).status).toBe(0);
    const parsed = parseOracleReport(readFileSync(oracleJson, "utf8"));
    expect(parsed === null).toBe(false);
    if (parsed === null) return;
    parsed.base_url = "http://x:tok_d42@127.0.0.1:9";
    writeFileSync(oracleJson, `${JSON.stringify(parsed, null, 2)}\n`);
    const repo = boundRepo();
    const prev = process.env.AK_TP_LIFE_HOST_LOGIN;
    process.env.AK_TP_LIFE_HOST_LOGIN = "not-a-host";
    try {
      const out = join(dir, "receipt.json");
      const written = runScript(["receipt", "write", "--cwd", repo, "--oracle-json", oracleJson, "--out", out]);
      expect(written.status).toBe(0);
      const raw = readFileSync(out, "utf8");
      expect(raw.includes("tok_d42")).toBe(false);
      expect(raw.includes("http://127.0.0.1:9")).toBe(true);
      expect(raw.includes('\\"host_login\\":\\"unrecorded\\"')).toBe(true);
      process.env.AK_TP_LIFE_HOST_LOGIN = "claude";
      const allowed = join(dir, "receipt-claude.json");
      expect(runScript(["receipt", "write", "--cwd", repo, "--oracle-json", oracleJson, "--out", allowed]).status).toBe(
        0,
      );
      expect(readFileSync(allowed, "utf8").includes('\\"host_login\\":\\"claude\\"')).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.AK_TP_LIFE_HOST_LOGIN;
      else process.env.AK_TP_LIFE_HOST_LOGIN = prev;
    }
  });

  test("a relative --out inside the repo prints a stale-snapshot warning", async () => {
    const base = await startFixture();
    const work = processScratch("ak-tp-life-stale-");
    const oracleJson = join(work, "report.oracle.json");
    expect(runScript(["oracle", "--base-url", base, "--out", oracleJson]).status).toBe(0);
    cpSync(join(REPO, "schemas"), join(work, "schemas"), { recursive: true });
    copyFileSync(join(REPO, "package.json"), join(work, "package.json"));
    const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
    expect(spawnSync("git", ["-C", work, "init", "-q"], { env: gitEnv }).status).toBe(0);
    expect(spawnSync("git", ["-C", work, "add", "-A"], { env: gitEnv }).status).toBe(0);
    expect(
      spawnSync(
        "git",
        ["-C", work, "-c", "user.email=td@example.invalid", "-c", "user.name=td", "commit", "-qm", "td"],
        { env: gitEnv },
      ).status,
    ).toBe(0);
    const written = runScript(["receipt", "write", "--cwd", work, "--oracle-json", oracleJson, "--out", "inside.json"]);
    expect(written.status).toBe(0);
    expect(written.stderr.includes("will stale the next snapshot")).toBe(true);
    expect(existsSync(join(work, "inside.json"))).toBe(true);
  });

  test("--cwd with no value exits 2", () => {
    const run = runScript(["receipt", "check", "--cwd"]);
    expect(run.status).toBe(2);
    expect(run.stderr.includes("--cwd needs a path")).toBe(true);
  });

  test("a missing package.json under --cwd prints one line", async () => {
    const base = await startFixture();
    const work = processScratch("ak-tp-life-nopkg-");
    const oracleJson = join(work, "report.oracle.json");
    expect(runScript(["oracle", "--base-url", base, "--out", oracleJson]).status).toBe(0);
    cpSync(join(REPO, "schemas"), join(work, "schemas"), { recursive: true });
    const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
    expect(spawnSync("git", ["-C", work, "init", "-q"], { env: gitEnv }).status).toBe(0);
    expect(spawnSync("git", ["-C", work, "add", "-A"], { env: gitEnv }).status).toBe(0);
    expect(
      spawnSync(
        "git",
        ["-C", work, "-c", "user.email=td@example.invalid", "-c", "user.name=td", "commit", "-qm", "td"],
        { env: gitEnv },
      ).status,
    ).toBe(0);
    const run = runScript([
      "receipt",
      "write",
      "--cwd",
      work,
      "--oracle-json",
      oracleJson,
      "--out",
      join(work, "receipt.json"),
    ]);
    expect(run.status).toBe(1);
    expect(run.stderr.includes("cannot read package.json")).toBe(true);
    expect(run.stderr.includes("\n    at ")).toBe(false);
  });

  test("a missing template under --cwd prints one line", () => {
    const dir = processScratch("ak-tp-life-notpl-");
    const run = runScript(["evidence", "--cwd", dir]);
    expect(run.status).toBe(1);
    expect(run.stderr.includes("cannot read")).toBe(true);
    expect(run.stderr.includes("\n    at ")).toBe(false);
  });

  test("a null receipt is refused as not an object", () => {
    const dir = processScratch("ak-tp-life-null-");
    const path = join(dir, "null.json");
    writeFileSync(path, "null\n");
    const check = runScript(["receipt", "check", "--cwd", boundRepo(), path]);
    expect(check.status).toBe(2);
    expect(check.stderr.includes("receipt is not an object")).toBe(true);
  });

  test("an array receipt is refused as not an object", () => {
    const dir = processScratch("ak-tp-life-arr-");
    const path = join(dir, "array.json");
    writeFileSync(path, "[]\n");
    const check = runScript(["receipt", "check", "--cwd", boundRepo(), path]);
    expect(check.status).toBe(2);
    expect(check.stderr.includes("receipt is not an object")).toBe(true);
  });

  test("a missing oracle JSON prints one line and exits non-zero", () => {
    const dir = processScratch("ak-tp-life-miss-oracle-");
    const run = runScript([
      "receipt",
      "write",
      "--cwd",
      boundRepo(),
      "--oracle-json",
      join(dir, "missing-oracle.json"),
      "--out",
      join(dir, "missing-out.json"),
    ]);
    expect(run.status).toBe(1);
    expect(run.stderr.includes("cannot read")).toBe(true);
    expect(run.stderr.includes("\n    at ")).toBe(false);
  });

  test("a missing receipt prints one line and exits non-zero", () => {
    const dir = processScratch("ak-tp-life-miss-receipt-");
    const run = runScript(["receipt", "check", "--cwd", boundRepo(), join(dir, "missing-receipt.json")]);
    expect(run.status).toBe(1);
    expect(run.stderr.includes("cannot read")).toBe(true);
    expect(run.stderr.includes("\n    at ")).toBe(false);
  });

  test("a missing --out directory prints one line and exits non-zero", async () => {
    const base = await startFixture();
    const dir = processScratch("ak-tp-life-miss-outdir-");
    const oracleJson = join(dir, "report.oracle.json");
    const oracle = runScript(["oracle", "--base-url", base, "--out", oracleJson]);
    expect(oracle.status).toBe(0);
    const run = runScript([
      "receipt",
      "write",
      "--cwd",
      boundRepo(),
      "--oracle-json",
      oracleJson,
      "--out",
      join(dir, "no-such", "receipt.json"),
    ]);
    expect(run.status).toBe(1);
    expect(run.stderr.includes("cannot write")).toBe(true);
    expect(run.stderr.includes("\n    at ")).toBe(false);
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
    const check = runScript(["receipt", "check", "--cwd", written.repo, mutatedPath]);
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
    const check = runScript(["receipt", "check", "--cwd", written.repo, missingPath]);
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
    const check = runScript(["receipt", "check", "--cwd", written.repo, mutatedPath]);
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
    const check = runScript(["receipt", "check", "--cwd", written.repo, mutatedPath]);
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
    const check = runScript(["receipt", "check", "--cwd", written.repo, mutatedPath]);
    expect(check.status, check.stderr).toBe(2);
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
    const check = runScript(["receipt", "check", "--cwd", written.repo, join(receiptsDir, "passed.json")]);
    expect(check.status).toBe(0);
    const evidence = evidenceAt(receiptsDir, written.repo);
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
    const check = runScript(["receipt", "check", "--cwd", written.repo, join(receiptsDir, "forged.json")]);
    expect(check.status).toBe(0);
    const run = evidenceAt(receiptsDir, written.repo);
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
    const check = runScript(["receipt", "check", "--cwd", written.repo, join(receiptsDir, "failed.json")]);
    expect(check.status).toBe(0);
    const run = evidenceAt(receiptsDir, written.repo);
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
    const repo = boundRepo();
    const failed = writeOracle(failedBase, dir, "failed", repo);
    expect(failed.status).toBe(1);
    const passed = writeOracle(passedBase, dir, "passed", repo);
    expect(passed.status).toBe(0);
    copyFileSync(failed.receipt, join(receiptsDir, "failed.json"));
    copyFileSync(passed.receipt, join(receiptsDir, "passed.json"));
    copyFileSync(passed.receipt, join(receiptsDir, "passed-copy.json"));
    const run = evidenceAt(receiptsDir, repo);
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
    const repo = boundRepo();
    const failed = writeOracle(failedBase, dir, "failed", repo);
    expect(failed.status).toBe(1);
    const passed = writeOracle(passedBase, dir, "passed", repo);
    expect(passed.status).toBe(0);
    copyFileSync(failed.receipt, join(receiptsDir, "failed.json"));
    copyFileSync(passed.receipt, join(receiptsDir, "passed.json"));
    const run = evidenceAt(receiptsDir, repo);
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
    const repo = boundRepo();
    const failed = writeOracle(failedBase, dir, "failed", repo);
    expect(failed.status).toBe(1);
    const passed = writeOracle(base, dir, "passed", repo);
    expect(passed.status).toBe(0);
    const mutated = readFileSync(passed.receipt, "utf8").replace(
      '\\"id\\":\\"success\\",\\"verdict\\":\\"pass\\"',
      '\\"id\\":\\"success\\",\\"verdict\\":\\"fail\\"',
    );
    copyFileSync(failed.receipt, join(receiptsDir, "failed.json"));
    writeFileSync(join(receiptsDir, "passed.json"), mutated);
    const run = evidenceAt(receiptsDir, repo);
    expect(run.status).toBe(0);
    const printed = parseEvidenceRecord(run.stdout);
    expect(printed?.oracle_sub_verdict).toBe("incomplete");
  });

  test("a later failed receipt does not make red-to-green", () => {
    const raw = readFileSync(join(REPO, TEMPLATE_REL), "utf8");
    const template = parseEvidenceRecord(raw);
    expect(template === null).toBe(false);
    if (template === null) return;
    const printed = decideEvidence(template, [
      observation("passed.json", "sha256:b", "passed", 0, undefined, "2026-01-01T00:00:01.000Z"),
      observation("failed.json", "sha256:a", "failed", 1, "duplicate", "2026-01-01T00:00:02.000Z"),
    ]);
    expect(printed.verdict).toBe("not-run");
    expect(printed.oracle_sub_verdict).toBe("incomplete");
    expect(printed.reason.includes("a later bound passed receipt")).toBe(true);
  });

  test("failed duplicate-only before a passed receipt is red-to-green", () => {
    const raw = readFileSync(join(REPO, TEMPLATE_REL), "utf8");
    const template = parseEvidenceRecord(raw);
    expect(template === null).toBe(false);
    if (template === null) return;
    const printed = decideEvidence(template, [
      observation("failed.json", "sha256:a", "failed", 1, "duplicate", "2026-01-01T00:00:01.000Z"),
      observation("passed.json", "sha256:b", "passed", 0, undefined, "2026-01-01T00:00:02.000Z"),
    ]);
    expect(printed.verdict).toBe("not-run");
    expect(printed.oracle_sub_verdict).toBe("red-to-green");
  });

  test("a failed observation with a non-1 exit_status is incomplete", () => {
    const raw = readFileSync(join(REPO, TEMPLATE_REL), "utf8");
    const template = parseEvidenceRecord(raw);
    expect(template === null).toBe(false);
    if (template === null) return;
    const printed = decideEvidence(template, [
      observation("failed.json", "sha256:a", "failed", 0, "duplicate", "2026-01-01T00:00:01.000Z"),
      observation("passed.json", "sha256:b", "passed", 0, undefined, "2026-01-01T00:00:02.000Z"),
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
      observation("failed.json", "sha256:a", "failed", 1, "duplicate", "2026-01-01T00:00:01.000Z"),
      observation("passed.json", "sha256:b", "passed", 1, undefined, "2026-01-01T00:00:02.000Z"),
    ]);
    expect(printed.verdict).toBe("not-run");
    expect(printed.oracle_sub_verdict).toBe("incomplete");
  });

  test("equal timestamps leave oracle_sub_verdict incomplete", () => {
    const raw = readFileSync(join(REPO, TEMPLATE_REL), "utf8");
    const template = parseEvidenceRecord(raw);
    expect(template === null).toBe(false);
    if (template === null) return;
    const printed = decideEvidence(template, [
      observation("failed.json", "sha256:a", "failed", 1, "duplicate", "2026-01-01T00:00:01.000Z"),
      observation("passed.json", "sha256:b", "passed", 0, undefined, "2026-01-01T00:00:01.000Z"),
    ]);
    expect(printed.oracle_sub_verdict).toBe("incomplete");
  });

  test("a non-ISO created_at is skipped", () => {
    const raw = readFileSync(join(REPO, TEMPLATE_REL), "utf8");
    const template = parseEvidenceRecord(raw);
    expect(template === null).toBe(false);
    if (template === null) return;
    const printed = decideEvidence(template, [
      observation("failed.json", "sha256:a", "failed", 1, "duplicate", "not-a-date"),
      observation("passed.json", "sha256:b", "passed", 0, undefined, "2026-01-01T00:00:02.000Z"),
    ]);
    expect(printed.oracle_sub_verdict).toBe("incomplete");
  });

  test("an offset created_at is ordered by instant", () => {
    const raw = readFileSync(join(REPO, TEMPLATE_REL), "utf8");
    const template = parseEvidenceRecord(raw);
    expect(template === null).toBe(false);
    if (template === null) return;
    const printed = decideEvidence(template, [
      observation("failed.json", "sha256:a", "failed", 1, "duplicate", "2026-01-01T10:00:00.000Z"),
      observation("passed.json", "sha256:b", "passed", 0, undefined, "2026-01-01T06:00:00-05:00"),
    ]);
    expect(printed.oracle_sub_verdict).toBe("red-to-green");
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
    const check = runScript(["receipt", "check", "--cwd", written.repo, join(receiptsDir, "probe.json")]);
    expect(check.status).toBe(0);
    const run = evidenceAt(receiptsDir, written.repo);
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
    const check = runScript(["receipt", "check", "--cwd", written.repo, mutatedPath]);
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
    let refused = false;
    while (Date.now() < deadline) {
      try {
        await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(150) });
      } catch (err) {
        if (err instanceof Error && isConnRefused(err)) {
          refused = true;
          break;
        }
      }
      await new Promise((settle) => setTimeout(settle, 50));
    }
    expect(refused).toBe(true);
  });

  test("inherited PORT and AK_TP_LIFE_BROKEN do not bind a clean fixture", async () => {
    const first = await startFixture();
    const port = first.slice("http://127.0.0.1:".length);
    const prevPort = process.env.PORT;
    const prevBroken = process.env.AK_TP_LIFE_BROKEN;
    process.env.PORT = port;
    process.env.AK_TP_LIFE_BROKEN = "duplicate";
    try {
      const second = await startFixture();
      expect(second).not.toBe(first);
      const dir = processScratch("ak-tp-life-env-");
      const oracle = runScript(["oracle", "--base-url", second, "--out", join(dir, "o.json")]);
      expect(oracle.status).toBe(0);
    } finally {
      if (prevPort === undefined) delete process.env.PORT;
      else process.env.PORT = prevPort;
      if (prevBroken === undefined) delete process.env.AK_TP_LIFE_BROKEN;
      else process.env.AK_TP_LIFE_BROKEN = prevBroken;
    }
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
