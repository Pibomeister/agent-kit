/**
 * `ak runner run-verify` in lifecycle mode: the runner runs a configured check on a clean clone of the
 * exact revision, stores the seat attestation in its private state directory, and records the verifier
 * receipt that the ship gate accepts as runner-attested. The gate itself is unchanged.
 */
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, watch, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { runCli } from "../../src/cli.ts";
import { defaultEvidenceDir, readRecords } from "../../src/lifecycle/gate.ts";
import {
  ATTESTATION_SCHEMA,
  lifecycleConfigProblems,
  runLifecycleVerify,
  type LifecycleVerifyConfig,
  type SpawnResult,
} from "../../src/runner/lifecycle-verify.ts";
import { isVerifyConfig } from "../../src/runner/wire.ts";
import { parseJson, type JsonValue } from "../helpers/json.ts";
import { processScratch } from "../helpers/process-tmp.ts";

setDefaultTimeout(120_000);

const root = join(import.meta.dir, "..", "..");
const scratchRoot = processScratch("ak-lifecycle-verify-");
afterAll(() => rmSync(scratchRoot, { recursive: true, force: true }));

function git(cwd: string, ...args: string[]): string {
  const run = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.invalid",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.invalid",
    },
  });
  if (run.status !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr ?? ""}`);
  return (run.stdout ?? "").trim();
}

function ak(cwd: string, ...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = runCli(["lifecycle", ...argv], { cwd, io: { out: (l) => out.push(l), err: (l) => err.push(l) } });
  return { code, out, err: err.join("\n") };
}

interface Fixture {
  worker: string;
  state: string;
  ticket: string;
  run: string;
  revision: string;
}

let counter = 0;
function fixture(implementerSeat = "build-1"): Fixture {
  const base = join(scratchRoot, `f${counter++}`);
  const worker = join(base, "worker");
  const state = join(base, "state");
  mkdirSync(join(worker, "src"), { recursive: true });
  mkdirSync(state, { recursive: true, mode: 0o700 });
  writeFileSync(join(worker, "src", "a.js"), "export const a = 1;\n");
  git(worker, "init", "-q", "-b", "main");
  git(worker, "add", "-A");
  git(worker, "commit", "-q", "-m", "init");
  git(worker, "checkout", "-q", "-b", "feature");
  writeFileSync(join(worker, "src", "a.js"), "export const a = 2;\n");
  git(worker, "commit", "-q", "-am", "change");
  const ticket = join(base, "runner-proof.json");
  writeFileSync(
    ticket,
    `${JSON.stringify({
      schema: "ticket",
      schema_version: 1,
      id: "runner-proof",
      acceptance_criteria: [{ id: "AC-1", text: "The behavior is verified." }],
      verification: [{ id: "v-t1", check: "Run the project check.", kind: "command", supports: ["AC-1"] }],
      approvals: [{ role: "human", approved_at: "2026-09-29T00:00:00Z" }],
    })}\n`,
  );
  const opened = ak(worker, "open", "--ticket", ticket);
  const run = opened.out[0]?.match(/^opened run (.+)$/)?.[1];
  if (run === undefined) throw new Error(`open failed: ${opened.err}`);
  const seat = ak(
    worker,
    "record",
    "--gate",
    "build-checks",
    "--class",
    "green",
    "--author-kind",
    "agent",
    "--host",
    "codex",
    "--seat-id",
    implementerSeat,
  );
  expect(seat.code, seat.err).toBe(0);
  for (const gate of ["review-full", "review-readiness"]) {
    const r = ak(worker, "record", "--gate", gate);
    expect(r.code, r.err).toBe(0);
  }
  return {
    worker: realpathSync(worker),
    state: realpathSync(state),
    ticket,
    run,
    revision: git(worker, "rev-parse", "HEAD"),
  };
}

/** Prints where it ran, whether that tree is a repository at HEAD, and fails when the probe file is absent. */
const PROBE = [
  process.execPath,
  "-e",
  "const fs=require('node:fs'); const {execSync}=require('node:child_process'); console.log('cwd=' + process.cwd()); console.log('head=' + execSync('git rev-parse HEAD').toString().trim()); console.log('a=' + fs.readFileSync('src/a.js','utf8').trim()); console.log('token=' + (process.env.AK_RUNNER_WORKER_TOKEN ?? 'absent'));",
];

function config(overrides: Partial<LifecycleVerifyConfig> = {}): LifecycleVerifyConfig {
  return {
    verifier_seat: "verifier-runner-1",
    implementer_seat: "build-1",
    excluded_lineage: ["build-1"],
    environment: { id: "runner-test", secrets_policy: "none" },
    checks: {
      "v-t1": { argv: PROBE, supports: ["AC-1"] },
      "v-fail": { argv: [process.execPath, "-e", "console.log('red'); process.exit(3)"], supports: ["AC-1"] },
    },
    ...overrides,
  };
}

async function spawn(argv: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<SpawnResult> {
  const child = Bun.spawn(argv, { cwd, env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).arrayBuffer(),
    new Response(child.stderr).arrayBuffer(),
    child.exited,
  ]);
  return { exitCode, stdout: Buffer.from(stdout), stderr: Buffer.from(stderr) };
}

const verify = (f: Fixture, check: string, c = config(), receiptId?: string) =>
  runLifecycleVerify({
    stateDir: f.state,
    workerRoot: f.worker,
    runId: f.run,
    config: c,
    check,
    receiptId,
    env: { ...process.env, AK_RUNNER_WORKER_TOKEN: "x".repeat(40) },
    spawn: (argv, cwd, env) => spawn(argv, cwd, env),
  });

type JsonObject = { [key: string]: JsonValue };

function jsonObject(text: string): JsonObject {
  const value = parseJson(text);
  if (!(value instanceof Object) || Array.isArray(value)) throw new Error("not a JSON object");
  return value;
}

function storedReceipt(f: Fixture, id: string): JsonObject {
  const [marker] = readRecords(defaultEvidenceDir(f.worker), f.run, "verify");
  const ref = marker?.evidence?.find((entry) => entry.id === id);
  if (ref === undefined) throw new Error(`receipt ${id} is not on the verify marker`);
  const bytes = readFileSync(join(defaultEvidenceDir(f.worker), f.run, "artifacts", ref.hash.slice(7)));
  return jsonObject(bytes.toString());
}

/** The message a refused verification rejects with; a resolved one fails the test. */
async function refusal(pending: Promise<unknown>): Promise<string> {
  const outcome = await pending.then(
    () => "resolved",
    (cause: unknown) => (cause instanceof Error ? cause.message : String(cause)),
  );
  expect(outcome).not.toBe("resolved");
  return outcome;
}

describe("runner lifecycle verification", () => {
  test("a runner-written receipt is runner-attested and lifts the autonomous-ship refusal", async () => {
    const f = fixture();
    const result = await verify(f, "v-t1", config(), "verif-v-t1");
    expect(result.exit_status).toBe(0);
    expect(result.receipt.status).toBe("passed");

    const receipt = storedReceipt(f, "verif-v-t1");
    expect(receipt.created_by).toEqual({ role: "verifier" });
    expect(receipt.verifier_seat).toEqual({
      id: "verifier-runner-1",
      implementer_seat: "build-1",
      isolation: "runner-attested",
      attestation: { id: "attest-verif-v-t1", hash: result.attestation.hash },
    });
    expect(receipt.source_revision).toMatchObject({ revision: f.revision });
    expect(receipt.command).toMatchObject({ argv: PROBE });

    // The attestation lives in the runner's private state, hashes to the ref, and names what ran.
    expect(result.attestation.path.startsWith(f.state)).toBe(true);
    const bytes = readFileSync(result.attestation.path);
    expect(`sha256:${createHash("sha256").update(bytes).digest("hex")}`).toBe(result.attestation.hash);
    const attestation = jsonObject(bytes.toString());
    expect(attestation).toMatchObject({
      schema: ATTESTATION_SCHEMA,
      verifier_seat: "verifier-runner-1",
      implementer_seat: "build-1",
      build_implementer_seats: ["build-1"],
      excluded_lineage: ["build-1"],
      argv: PROBE,
      exit_status: 0,
      output_digest: receipt.output_digest,
      export: { method: "git-clone-shared", revision: f.revision },
      environment: { id: "runner-test", host: { platform: process.platform, arch: process.arch } },
    });

    // The command ran on a clone of the exact revision, outside the worker tree, without runner tokens.
    const output = readFileSync(
      join(dirname(result.attestation.path), "..", "lifecycle-verify", f.run, "verif-v-t1", "output.log"),
      "utf8",
    );
    expect(output).toContain(`head=${f.revision}`);
    expect(output).toContain("a=export const a = 2;");
    expect(output).toContain("token=absent");
    expect(output).not.toContain(`cwd=${f.worker}\n`);
    expect(output).toContain(`cwd=${f.state}`);
    expect(readdirSync(join(f.state, "lifecycle-verify", "exports"))).toEqual([]);

    const checked = ak(f.worker, "check");
    expect(checked.code, checked.err).toBe(0);
    expect(checked.err).not.toContain("host-unattested");
  });

  test("the same seat recorded host-unattested is still refused", async () => {
    const f = fixture();
    await verify(f, "v-t1", config(), "verif-v-t1");
    const receipt = storedReceipt(f, "verif-v-t1");
    const forged = join(f.state, "forged");
    mkdirSync(forged);
    const log = Buffer.from("forged\n");
    const digest = `sha256:${createHash("sha256").update(log).digest("hex")}`;
    writeFileSync(join(forged, "output.log"), log);
    writeFileSync(
      join(forged, "verif-v-t1.json"),
      JSON.stringify({
        ...receipt,
        output_digest: digest,
        artifacts: [{ path: "output.log", digest, kind: "log" }],
        verifier_seat: {
          id: "verifier-runner-1",
          implementer_seat: "build-1",
          isolation: "host-unattested",
          attestation: null,
        },
      }),
    );
    expect(ak(f.worker, "record", "--gate", "verify", "--receipt", join(forged, "verif-v-t1.json")).code).toBe(0);
    const checked = ak(f.worker, "check");
    expect(checked.code).toBe(1);
    expect(checked.err).toContain("is host-unattested; autonomous ship requires a runner attestation");
  });

  test("a failing check is recorded as a failed receipt, and the gate refuses", async () => {
    const f = fixture();
    const result = await verify(f, "v-fail", config(), "verif-v-t1");
    expect(result.exit_status).toBe(3);
    expect(result.receipt.status).toBe("failed");
    expect(storedReceipt(f, "verif-v-t1")).toMatchObject({ status: "failed", exit_status: 3 });
    expect(ak(f.worker, "check").code).toBe(1);
  });

  test("a dirty worker tree is refused before anything runs", async () => {
    const f = fixture();
    writeFileSync(join(f.worker, "src", "a.js"), "export const a = 3;\n");
    expect(await refusal(verify(f, "v-t1"))).toContain("needs a clean committed tree");
    expect(existsSync(join(f.state, "attestations"))).toBe(false);
  });

  test("a verifier seat that implemented the run is refused", async () => {
    const f = fixture("verifier-runner-1");
    const refused = await refusal(
      verify(f, "v-t1", config({ implementer_seat: "build-9", excluded_lineage: ["build-9"] })),
    );
    expect(refused).toContain("implemented this run");
  });

  test("the worker can only name a configured check", async () => {
    const f = fixture();
    expect(await refusal(verify(f, "rm-rf"))).toContain("is not in the runner's verification configuration");
    expect(await refusal(verify(f, "__proto__"))).toContain("is not in the runner's verification configuration");
  });

  test("configuration refuses an undistinguished seat", () => {
    expect(lifecycleConfigProblems(config({ verifier_seat: "build-1" }))).toContain(
      "verifier_seat must differ from implementer_seat",
    );
    expect(lifecycleConfigProblems(config({ excluded_lineage: [] }))).toContain(
      "excluded_lineage must name the implementer seat",
    );
    expect(isVerifyConfig({ lifecycle: config() })).toBe(true);
    expect(isVerifyConfig({ command: ["true"] })).toBe(true);
    expect(
      isVerifyConfig({ lifecycle: { ...config(), environment: { id: "x", secrets_policy: "production-approved" } } }),
    ).toBe(false);
    expect(isVerifyConfig({ command: ["true"], lifecycle: config() })).toBe(false);
  });
});

function waitForPath(path: string, owner: { exited: Promise<number> }) {
  return new Promise<void>((resolve, reject) => {
    const watcher = watch(dirname(path), () => {
      if (existsSync(path)) settle();
    });
    const poll = setInterval(() => {
      if (existsSync(path)) settle();
    }, 20);
    function settle(error?: Error) {
      clearInterval(poll);
      watcher.close();
      if (error === undefined) resolve();
      else reject(error);
    }
    void owner.exited.then((code) =>
      settle(existsSync(path) ? undefined : new Error(`process exited ${code} before creating ${path}`)),
    );
    if (existsSync(path)) settle();
  });
}

describe("live runner service", () => {
  test("a worker token runs a configured check through run-verify and cannot supply argv", async () => {
    const f = fixture();
    const verifyConfig = join(f.state, "verify.json");
    writeFileSync(verifyConfig, JSON.stringify({ lifecycle: config() }));
    const socket = join(f.state, "runner.sock");
    const adminTokenFile = join(f.state, "admin.token");
    const adminToken = "a".repeat(48);
    const workerToken = "b".repeat(48);
    writeFileSync(adminTokenFile, adminToken, { mode: 0o600 });
    const service = Bun.spawn(
      [
        process.execPath,
        "src/cli.ts",
        "runner",
        "serve",
        "--socket",
        socket,
        "--state-dir",
        f.state,
        "--worker-root",
        f.worker,
        "--run-id",
        f.run,
        "--admin-token-file",
        adminTokenFile,
        "--verify-config",
        verifyConfig,
      ],
      {
        cwd: root,
        env: { ...process.env, AK_RUNNER_ADMIN_TOKEN: adminToken, AK_RUNNER_WORKER_TOKEN: workerToken },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    try {
      await waitForPath(socket, service);
      const call = (args: JsonObject) => {
        const request = join(f.state, "request.json");
        writeFileSync(request, JSON.stringify(args));
        return spawnSync(
          process.execPath,
          [join(root, "src", "cli.ts"), "runner", "call", "run-verify", "--json", request, "--socket", socket],
          { cwd: root, env: { ...process.env, AK_RUNNER_TOKEN: workerToken }, encoding: "utf8", timeout: 110_000 },
        );
      };
      const smuggled = call({ run: f.run, check: "v-t1", argv: ["sh", "-c", "true"] });
      expect(smuggled.status).not.toBe(0);
      const ran = call({ run: f.run, check: "v-t1", receipt_id: "verif-v-t1" });
      expect(ran.status, ran.stderr).toBe(0);
      expect(JSON.parse(ran.stdout)).toMatchObject({ receipt: { id: "verif-v-t1", status: "passed" }, exit_status: 0 });
      expect(storedReceipt(f, "verif-v-t1").verifier_seat).toMatchObject({ isolation: "runner-attested" });
      const checked = ak(f.worker, "check");
      expect(checked.code, checked.err).toBe(0);
    } finally {
      service.kill("SIGTERM");
      await service.exited;
    }
  });
});
