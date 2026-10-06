import { afterAll, afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync as nodeSpawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  unlinkSync,
  watch,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { Runner } from "../../src/runner/core.ts";
import type { StandingGrant } from "../../src/runner/types.ts";
import type { RunnerArgs } from "../../src/runner/wire.ts";
import { preflightStock } from "../../src/firstmate/stock.ts";
import { takeSnapshot } from "../../src/lifecycle/gate.ts";
import { artifactHash } from "../../src/util/hash.ts";

// Most tests drive git, the live runner service and separate seat processes. Keep the ordinary
// cases bounded at 30s; the multi-command live-service tests below declare their larger bounds.
setDefaultTimeout(30_000);

const root = join(import.meta.dir, "..", "..");
const RUNNER_CALL_TIMEOUT_MS = 25_000;
const CONTENDED_RUNNER_CALL_TIMEOUT_MS = 120_000;
const runnerCallChildren = new Set<ReturnType<typeof Bun.spawn>>();

function callRunnerCli(
  verb: string,
  request: string,
  socket: string,
  token: string,
  timeoutMs = RUNNER_CALL_TIMEOUT_MS,
) {
  const child = nodeSpawnSync(
    "bun",
    [join(root, "src", "cli.ts"), "runner", "call", verb, "--json", request, "--socket", socket],
    {
      cwd: root,
      env: { ...process.env, AK_RUNNER_TOKEN: token },
      encoding: "buffer",
      timeout: timeoutMs,
      killSignal: "SIGKILL",
    },
  );
  if (child.error !== undefined && "code" in child.error && child.error.code === "ETIMEDOUT")
    throw new Error(`runner call ${verb} timed out after ${timeoutMs}ms and was killed`);
  if (child.error !== undefined) throw child.error;
  return { exitCode: child.status, stdout: child.stdout, stderr: child.stderr };
}

function spawnRunnerCli(
  verb: string,
  request: string,
  socket: string,
  token: string,
  timeoutMs = RUNNER_CALL_TIMEOUT_MS,
) {
  const child = Bun.spawn(
    ["bun", join(root, "src", "cli.ts"), "runner", "call", verb, "--json", request, "--socket", socket],
    { cwd: root, env: { ...process.env, AK_RUNNER_TOKEN: token }, stdout: "pipe", stderr: "pipe" },
  );
  runnerCallChildren.add(child);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, timeoutMs);
  const exited = child.exited.then((code) => {
    clearTimeout(timer);
    runnerCallChildren.delete(child);
    if (timedOut) throw new Error(`runner call ${verb} timed out after ${timeoutMs}ms and was killed`);
    return code;
  });
  void exited.catch(() => {});
  return {
    exited,
    stdout: child.stdout,
    stderr: child.stderr,
    kill: (signal?: number | NodeJS.Signals) => child.kill(signal),
  };
}

afterEach(async () => {
  for (const child of runnerCallChildren) child.kill("SIGKILL");
  await Promise.allSettled([...runnerCallChildren].map((child) => child.exited));
  runnerCallChildren.clear();
});

const transcript: string[] = [
  "# Toy charter runner transcript",
  "",
  "Instrument: `AK_RUNNER_TRANSCRIPT=research/probes/runner-toy-transcript.md bun test tests/runner/runner.test.ts`.",
  "The test creates a scratch git repository, an active human-approved charter outside its worker root, and a live `ak runner serve` process. It launches two separate seat processes per checkpoint.",
  "The seat processes here are toy launchers. The separate normal-crewmate live smoke is recorded in stock-firstmate-live-smoke.md.",
  "",
];
afterAll(() => {
  const target = process.env["AK_RUNNER_TRANSCRIPT"];
  if (target !== undefined) writeFileSync(target, `${transcript.join("\n")}\n`);
});

function git(cwd: string, ...args: string[]) {
  expect(
    Bun.spawnSync(["git", "-C", cwd, "-c", "user.name=Toy", "-c", "user.email=toy@example.invalid", ...args]).exitCode,
  ).toBe(0);
}

function waitForPath(path: string, owner: { exited: Promise<number> }) {
  return new Promise<void>((resolve, reject) => {
    const watcher = watch(dirname(path), () => {
      if (existsSync(path)) settle();
    });
    function settle(error?: Error) {
      watcher.close();
      if (error === undefined) resolve();
      else reject(error);
    }
    watcher.once("error", settle);
    void owner.exited.then(
      (code) => settle(existsSync(path) ? undefined : new Error(`process exited ${code} before creating ${path}`)),
      (cause) => settle(cause instanceof Error ? cause : new Error(String(cause))),
    );
    if (existsSync(path)) settle();
  });
}

async function waitForProcessExit(pid: number, timeoutMs = 60_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await Bun.sleep(20);
  }
  return false;
}

function fixture(limit = 3) {
  const dir = mkdtempSync(join(tmpdir(), "ak-runner-"));
  const worker = join(dir, "worker");
  const privateDir = join(dir, "private");
  mkdirSync(worker);
  mkdirSync(privateDir);
  writeFileSync(join(worker, ".gitignore"), ".runner-requests/\n");
  writeFileSync(join(worker, "README.md"), "toy worktree\n");
  Bun.spawnSync(["git", "init", "-q", worker]);
  Bun.spawnSync(["git", "-C", worker, "add", "."]);
  Bun.spawnSync([
    "git",
    "-C",
    worker,
    "-c",
    "user.name=Toy",
    "-c",
    "user.email=toy@example.invalid",
    "commit",
    "-qm",
    "Create toy charter worktree",
  ]);
  const revision = Bun.spawnSync(["git", "-C", worker, "rev-parse", "HEAD"]).stdout.toString().trim();
  const requestDir = join(worker, ".runner-requests");
  mkdirSync(requestDir);
  const path = join(privateDir, "charter.json");
  const charter = {
    schema: "charter",
    schema_version: 1,
    id: "toy-charter",
    run_id: "toy-run",
    project: { id: "toy", repo: "toy" },
    created_by: { role: "human" },
    inputs: [],
    source_revision: null,
    created_at: "2026-10-01T00:00:00Z",
    status: "active",
    immutability: { immutable: true, worker_writable: false, hash: "", location: path },
    work_source: { kind: "ticket", ref: { id: "toy-ticket", hash: `sha256:${"a".repeat(64)}` } },
    repos: [{ repo: "toy", base_branch: "main", paths: ["src/**"] }],
    artifact_destinations: { kb_root: "toy", runs_path: "runs" },
    allowed_capabilities: [
      "repository-read",
      "independent-context",
      "artifact-write",
      "runner-grants",
      "trusted-evidence",
      "event-delivery",
    ],
    default_grants: [
      "approve-spec",
      "approve-ticket",
      "start-implementation-ticket",
      "adjudicate-finding",
      "push-branch",
      "open-pr",
      "reply-pr-comment",
      "resolve-pr-thread",
      "publish-lesson",
    ],
    standing_grants: [{ covers: "autopilot.start", controller: "firstmate" }],
    denied_actions: ["merge", "deploy"],
    sensitive_grants: [],
    checkpoints: ["align-answer", "spec-approval", "build-go", "finding-adjudication", "ship-pr"],
    limits: {
      fix_cycles: 2,
      ci_repair_attempts: 2,
      alignment_questions: limit,
      tickets: 3,
      elapsed_minutes: 60,
      review_rounds: 2,
    },
    budgets: {
      provided_by: "runner",
      enforces: ["alignment-questions", "tickets", "review-rounds", "elapsed-minutes"],
      on_exhaustion: "cap-reached",
    },
    supervisors: {
      seats: [
        { id: "seat-a", role: "supervisor", filled_by: "supervisor" },
        { id: "seat-b", role: "supervisor", filled_by: "reviewer-standards" },
      ],
      independence: "declared-independent",
      tie_breaker_allowed: false,
      may_implement: false,
      on_missing_seat: "block-and-escalate",
    },
    approvals: [{ artifact_hash: "", by: "human", authority: "explicit", at: "2026-10-01T00:00:00Z" }],
  };
  charter.immutability.hash = artifactHash({ ...charter, immutability: { ...charter.immutability, hash: "" } });
  const approval = charter.approvals[0];
  if (approval === undefined) throw new Error("toy charter approval missing");
  approval.artifact_hash = charter.immutability.hash;
  writeFileSync(path, JSON.stringify(charter));
  return { dir, worker, privateDir, path, charter, revision, requestDir, runner: new Runner(privateDir, worker, root) };
}

function ready(limit = 3) {
  const f = fixture(limit);
  f.runner.start("toy-run", f.path, "implementer-1", f.revision, standing(f));
  const log = join(f.privateDir, "log.txt");
  writeFileSync(log, "independently collected verification");
  f.runner.collect("toy-run", "e1", log, f.revision, "source");
  return f;
}

function standing(f: ReturnType<typeof fixture>): StandingGrant {
  return {
    charter_hash: f.charter.immutability.hash,
    covers: "autopilot.start",
    controller: "firstmate",
    run_id: "toy-run",
  };
}

function card(
  f: ReturnType<typeof ready>,
  id = "card-1",
  operation = "align.run",
  covers = "align-answer",
  hash = `sha256:${"b".repeat(64)}`,
) {
  f.runner.prepare("toy-run", {
    id,
    operation,
    grant: { charter_hash: f.charter.immutability.hash, covers },
    question: "Proceed?",
    options: ["yes", "no"],
    approve: "yes",
    evidence: ["e1"],
    artifact_hash: hash,
  });
  f.runner.judge("toy-run", id, "seat-a", "supervisor-1", `${id}-dispatch-a`, "yes", []);
  f.runner.judge("toy-run", id, "seat-b", "supervisor-2", `${id}-dispatch-b`, "yes", []);
}

function split(f: ReturnType<typeof ready>, id: string, options: string[], operation = "align.run") {
  const covers = operation === "ship.prepare" ? "ship-pr" : "align-answer";
  f.runner.prepare("toy-run", {
    id,
    operation,
    grant: { charter_hash: f.charter.immutability.hash, covers },
    question: "Proceed?",
    options,
    approve: options[0] ?? "",
    evidence: [operation === "ship.prepare" ? "verify" : "e1"],
    artifact_hash: `sha256:${"b".repeat(64)}`,
  });
  f.runner.judge("toy-run", id, "seat-a", "supervisor-1", `${id}-a`, options[0] ?? "", []);
  f.runner.judge("toy-run", id, "seat-b", "supervisor-2", `${id}-b`, options[1] ?? "", []);
  return f.runner.decide("toy-run", id);
}
function stage(f: ReturnType<typeof ready>) {
  const run = new Runner(f.privateDir, f.worker, root).status("toy-run");
  return [run.run_state, run.next_permitted_action];
}

function reachShipReady(f: ReturnType<typeof ready>, ship = true) {
  for (const [id, operation, covers] of [
    ["align", "align.run", "align-answer"],
    ["bound", "bound.run", "spec-approval"],
    ["build", "build.dispatch", "build-go"],
  ] as const) {
    card(f, id, operation, covers);
    expect(f.runner.decide("toy-run", id).status).toBe("complete");
  }
  const verification = join(f.privateDir, "verification.txt");
  writeFileSync(verification, "tests passed at current revision");
  f.runner.collect("toy-run", "verify", verification, f.revision, "verify");
  f.runner.verify("toy-run", "verify");
  for (const [id, operation, covers] of [
    ["review", "review.full", "finding-adjudication"],
    ["readiness", "review.readiness", "finding-adjudication"],
  ] as const) {
    card(f, id, operation, covers);
    expect(f.runner.decide("toy-run", id).status).toBe("complete");
  }
  if (!ship) return;
  f.runner.prepare("toy-run", {
    id: "ship",
    operation: "ship.prepare",
    grant: { charter_hash: f.charter.immutability.hash, covers: "ship-pr" },
    question: "Open PR?",
    options: ["yes", "no"],
    approve: "yes",
    evidence: ["verify"],
    artifact_hash: `sha256:${"b".repeat(64)}`,
  });
  f.runner.judge("toy-run", "ship", "seat-a", "supervisor-1", "ship-a", "yes", []);
  f.runner.judge("toy-run", "ship", "seat-b", "supervisor-2", "ship-b", "yes", []);
  expect(f.runner.decide("toy-run", "ship").status).toBe("complete");
  expect(f.runner.status("toy-run").run_state).toBe("ready-to-ship");
}

describe("runner guards", () => {
  test("a runner CLI call cannot wait forever for a silent service", async () => {
    const f = fixture();
    const socket = join(f.privateDir, "silent.sock");
    const request = join(f.requestDir, "silent.json");
    writeFileSync(request, JSON.stringify({ run: "toy-run" }));
    const silent = Bun.spawn(
      ["node", "-e", "require('node:net').createServer(()=>{}).listen(process.argv[1])", socket],
      { cwd: root, stdout: "pipe", stderr: "pipe" },
    );
    try {
      await waitForPath(socket, silent);
      expect(() => callRunnerCli("status", request, socket, "b".repeat(48), 200)).toThrow(
        "runner call status timed out after 200ms and was killed",
      );
    } finally {
      silent.kill();
      await silent.exited;
    }
  });

  test("stopping the runner service kills an active seat launcher", async () => {
    const f = fixture();
    const socket = join(f.privateDir, "runner.sock");
    const seatConfig = join(f.privateDir, "seats.json");
    const launcherPid = join(f.privateDir, "launcher.pid");
    const adminToken = "a".repeat(48);
    const workerToken = "b".repeat(48);
    const adminTokenFile = join(f.privateDir, "admin.token");
    writeFileSync(adminTokenFile, adminToken, { mode: 0o600 });
    const runner = new Runner(f.privateDir, f.worker, root, true);
    runner.start("toy-run", f.path, "implementer-1", f.revision, standing(f));
    const receipt = join(f.privateDir, "receipt.txt");
    writeFileSync(receipt, "trusted test output");
    runner.collect("toy-run", "e1", receipt, f.revision, "source");
    runner.prepare("toy-run", {
      id: "align",
      operation: "align.run",
      grant: { charter_hash: f.charter.immutability.hash, covers: "align-answer" },
      question: "Proceed?",
      options: ["yes", "no"],
      approve: "yes",
      evidence: ["e1"],
      artifact_hash: `sha256:${"b".repeat(64)}`,
    });
    writeFileSync(
      seatConfig,
      JSON.stringify({
        launchers: ["seat-a", "seat-b"].map((seat) => ({
          seat,
          actor: `supervisor-${seat}`,
          lineage: [`supervisor-${seat}`],
          command: [
            "node",
            "-e",
            "const fs=require('node:fs');const tmp=`${process.argv[1]}.${process.pid}`;fs.writeFileSync(tmp,String(process.pid));fs.renameSync(tmp,process.argv[1]);setTimeout(()=>{},300000)",
            launcherPid,
          ],
        })),
      }),
    );
    const server = Bun.spawn(
      [
        "bun",
        "src/cli.ts",
        "runner",
        "serve",
        "--socket",
        socket,
        "--state-dir",
        f.privateDir,
        "--worker-root",
        f.worker,
        "--run-id",
        "toy-run",
        "--admin-token-file",
        adminTokenFile,
        "--seat-config",
        seatConfig,
      ],
      { cwd: root, env: { ...process.env, AK_RUNNER_WORKER_TOKEN: workerToken }, stdout: "pipe", stderr: "pipe" },
    );
    let decision: ReturnType<typeof spawnRunnerCli> | undefined;
    try {
      await waitForPath(socket, server);
      const request = join(f.requestDir, "request.json");
      writeFileSync(request, JSON.stringify({ run: "toy-run", card_id: "align" }));
      decision = spawnRunnerCli("decide", request, socket, workerToken, CONTENDED_RUNNER_CALL_TIMEOUT_MS);
      await waitForPath(launcherPid, decision);
      const pid = Number(readFileSync(launcherPid, "utf8"));
      server.kill();
      const stopped = await Promise.race([server.exited.then(() => true), Bun.sleep(60_000).then(() => false)]);
      if (!stopped) {
        server.kill("SIGKILL");
        await server.exited;
      }
      expect(stopped).toBe(true);
      expect(await waitForProcessExit(pid)).toBe(true);
    } finally {
      decision?.kill("SIGKILL");
      server.kill("SIGKILL");
      await Promise.all([decision?.exited, server.exited]);
    }
  }, 300_000);

  test("a Firstmate start needs a standing grant in the approved charter", () => {
    const f = fixture();
    expect(() =>
      f.runner.start("toy-run", f.path, "implementer-1", f.revision, {
        ...standing(f),
        charter_hash: `sha256:${"0".repeat(64)}`,
      }),
    ).toThrow("standing grant");
    const { standing_grants: omitted, ...withoutStanding } = f.charter;
    expect(omitted).toHaveLength(1);
    withoutStanding.immutability.hash = artifactHash({
      ...withoutStanding,
      immutability: { ...withoutStanding.immutability, hash: "" },
    });
    const approval = withoutStanding.approvals[0];
    if (approval === undefined) throw new Error("toy charter approval missing");
    approval.artifact_hash = withoutStanding.immutability.hash;
    writeFileSync(f.path, JSON.stringify(withoutStanding));
    expect(() =>
      f.runner.start("toy-run", f.path, "implementer-1", f.revision, {
        ...standing(f),
        charter_hash: withoutStanding.immutability.hash,
      }),
    ).toThrow("standing grant");
    const g = fixture();
    g.charter.allowed_capabilities = ["repository-read"];
    g.charter.immutability.hash = artifactHash({ ...g.charter, immutability: { ...g.charter.immutability, hash: "" } });
    const gApproval = g.charter.approvals[0];
    if (gApproval === undefined) throw new Error("toy charter approval missing");
    gApproval.artifact_hash = g.charter.immutability.hash;
    writeFileSync(g.path, JSON.stringify(g.charter));
    expect(() => g.runner.start("toy-run", g.path, "implementer-1", g.revision, standing(g))).toThrow(
      "standing start requires charter-approved",
    );
    transcript.push(
      "Refusal: Firstmate start with a forged standing-grant hash, no standing entry or missing runner capabilities → no run created.",
    );
  });

  test("standing start does not require event delivery the service does not supply", () => {
    const f = fixture();
    f.charter.allowed_capabilities = f.charter.allowed_capabilities.filter(
      (capability) => capability !== "event-delivery",
    );
    f.charter.immutability.hash = artifactHash({ ...f.charter, immutability: { ...f.charter.immutability, hash: "" } });
    const approval = f.charter.approvals[0];
    if (approval === undefined) throw new Error("toy charter approval missing");
    approval.artifact_hash = f.charter.immutability.hash;
    writeFileSync(f.path, JSON.stringify(f.charter));
    expect(f.runner.start("toy-run", f.path, "implementer-1", f.revision, standing(f)).run_state).toBe("created");
  });

  test("worker CLI cannot use supervisor verbs through the live service", async () => {
    const f = fixture();
    const socket = join(f.privateDir, "runner.sock");
    const seatConfig = join(f.privateDir, "seats.json");
    const verifyConfig = join(f.privateDir, "verify.json");
    const effectConfig = join(f.privateDir, "effects.json");
    const remote = join(f.privateDir, "remote-pr.txt");
    const launches = join(f.privateDir, "launches.txt");
    const workerBin = join(f.worker, "node_modules", ".bin");
    mkdirSync(workerBin, { recursive: true });
    const judgeScript =
      "if (process.env.AK_RUNNER_ADMIN_TOKEN) process.exit(3); const packet = JSON.parse(await Bun.stdin.text()); if (!packet.diff_hash) process.exit(4); const fs = require('node:fs'); fs.appendFileSync(process.argv[1], packet.card.id + '\\n'); if (packet.card.id === 'align') while (!fs.existsSync(process.argv[1] + '.open')) await Bun.sleep(20); console.log(JSON.stringify({choice:packet.card.options[0], rationale:'separate process judgment'}));";
    writeFileSync(
      seatConfig,
      JSON.stringify({
        launchers: [
          {
            seat: "seat-a",
            actor: "supervisor-1",
            lineage: ["supervisor-1"],
            command: ["bun", "-e", judgeScript, launches],
          },
          {
            seat: "seat-b",
            actor: "supervisor-2",
            lineage: ["supervisor-2"],
            command: ["bun", "-e", judgeScript, launches],
          },
        ],
      }),
    );
    writeFileSync(verifyConfig, JSON.stringify({ command: ["bun", "-e", "console.log('verification passed')"] }));
    writeFileSync(
      effectConfig,
      JSON.stringify({
        adapters: [
          {
            effect: "pr-open",
            read_back: [
              "bun",
              "-e",
              "const f=process.argv[1]; if (await Bun.file(f).exists()) process.stdout.write(await Bun.file(f).text());",
              remote,
            ],
            perform: ["bun", "-e", "await Bun.write(process.argv[1], process.argv[2]);", remote, "{input_hash}"],
          },
        ],
      }),
    );
    const adminToken = "a".repeat(48);
    const workerToken = "b".repeat(48);
    const adminTokenFile = join(f.privateDir, "admin.token");
    writeFileSync(adminTokenFile, adminToken, { mode: 0o600 });
    const launch = [
      "bun",
      "src/cli.ts",
      "runner",
      "serve",
      "--socket",
      socket,
      "--state-dir",
      f.privateDir,
      "--worker-root",
      f.worker,
      "--run-id",
      "toy-run",
      "--admin-token-file",
      adminTokenFile,
      "--seat-config",
      seatConfig,
      "--verify-config",
      verifyConfig,
      "--effect-config",
      effectConfig,
    ];
    const serverOptions = {
      cwd: root,
      env: {
        ...process.env,
        PATH: `${workerBin}:${process.env["PATH"] ?? ""}`,
        AK_RUNNER_ADMIN_TOKEN: adminToken,
        AK_RUNNER_WORKER_TOKEN: workerToken,
      },
      stdout: "pipe" as const,
      stderr: "pipe" as const,
    };
    let server = Bun.spawn(launch, serverOptions);
    try {
      await waitForPath(socket, server);
      const firstmateHome = process.env["AK_RUNNER_STOCK_FM_HOME"];
      if (firstmateHome !== undefined) {
        const stock = preflightStock(firstmateHome, f.worker, "codex", root, join(root, "dist", "codex"), socket);
        expect(stock.checks.filter((check) => !check.ok)).toEqual([]);
        expect(stock.mode).toBe("runner-candidate");
        transcript.push(
          `Stock Firstmate home ${firstmateHome}: preflight with live task runner socket → ${stock.mode}, ${stock.checks.length} checks passed; no patch or pinned commit check.`,
        );
      }
      const request = join(f.requestDir, "start.json");
      writeFileSync(
        request,
        JSON.stringify({
          run: "toy-run",
          charter: f.path,
          implementer: "implementer-1",
          revision: f.revision,
          standing_grant: standing(f),
        }),
      );
      const call = (verb: string, token: string) =>
        callRunnerCli(verb, request, socket, token, CONTENDED_RUNNER_CALL_TIMEOUT_MS);
      expect(call("start", workerToken).exitCode).toBe(1);
      expect(call("start", adminToken).exitCode).toBe(0);
      expect(new Runner(f.privateDir, f.worker, root).status("toy-run").start_authority.kind).toBe("standing-grant");
      transcript.push(`Charter: ${f.charter.immutability.hash}; worker revision: ${f.revision}.`);
      transcript.push(
        "`call start` with worker token → refused (exit 1); supervisor token plus charter-bound standing grant → run `created` with private start attestation (exit 0).",
      );
      expect(call("status", workerToken).exitCode).toBe(0);
      writeFileSync(request, JSON.stringify({ run: "another-run" }));
      expect(call("status", workerToken).exitCode).toBe(1);
      transcript.push("`call status` for another run through this task-scoped worker token → refused (exit 1).");
      writeFileSync(request, JSON.stringify({ run: "toy-run" }));
      expect(call("collect", workerToken).exitCode).toBe(1);
      const receipt = join(f.privateDir, "receipt.txt");
      writeFileSync(receipt, "trusted test output");
      writeFileSync(
        request,
        JSON.stringify({ run: "toy-run", id: "e1", source: receipt, revision: f.revision, kind: "source" }),
      );
      expect(call("collect", adminToken).exitCode).toBe(0);
      transcript.push(
        "`call collect` with worker token → refused (exit 1); supervisor collected source evidence outside worker root (exit 0).",
      );
      writeFileSync(
        request,
        JSON.stringify({
          run: "toy-run",
          card: {
            id: "align",
            operation: "align.run",
            grant: { charter_hash: f.charter.immutability.hash, covers: "align-answer" },
            question: "Proceed?",
            options: ["yes", "no"],
            approve: "yes",
            evidence: ["e1"],
            artifact_hash: `sha256:${"b".repeat(64)}`,
          },
        }),
      );
      expect(call("prepare", workerToken).exitCode).toBe(0);
      writeFileSync(request, JSON.stringify({ run: "toy-run", card_id: "align" }));
      const packet = call("packet", workerToken);
      expect(packet.exitCode).toBe(0);
      expect(packet.stdout.toString()).toContain('"charter_hash"');
      expect(packet.stdout.toString()).toContain('"operation": "align.run"');
      expect(packet.stdout.toString()).toContain('"approve": "yes"');
      expect(packet.stdout.toString()).not.toContain('"judgments"');
      const first = spawnRunnerCli("decide", request, socket, workerToken, CONTENDED_RUNNER_CALL_TIMEOUT_MS);
      await waitForPath(launches, first);
      const second = spawnRunnerCli("decide", request, socket, workerToken, CONTENDED_RUNNER_CALL_TIMEOUT_MS);
      expect(call("status", workerToken).exitCode).toBe(0);
      writeFileSync(`${launches}.open`, "");
      expect(await first.exited).toBe(0);
      expect(await new Response(first.stdout).text()).toContain('"status": "complete"');
      expect(await second.exited).toBe(0);
      expect(await new Response(second.stdout).text()).toContain('"status": "complete"');
      expect(readFileSync(launches, "utf8").trim().split("\n")).toEqual(["align", "align"]);
      transcript.push(
        "`call prepare` + `call decide` on `align.run`, grant `align-answer` → complete; seat-a and seat-b launched separately.",
      );
      writeFileSync(request, JSON.stringify({ run: "toy-run" }));
      const ledger = call("ledger", workerToken);
      expect(ledger.exitCode).toBe(0);
      expect(ledger.stdout.toString()).toContain('"checkpoint": "align-answer"');
      const phase = (id: string, operation: string, covers: string, evidence: string) => {
        writeFileSync(
          request,
          JSON.stringify({
            run: "toy-run",
            card: {
              id,
              operation,
              grant: { charter_hash: f.charter.immutability.hash, covers },
              question: `Proceed with ${id}?`,
              options: ["yes", "no"],
              approve: "yes",
              evidence: [evidence],
              artifact_hash: `sha256:${"b".repeat(64)}`,
            },
          }),
        );
        expect(call("prepare", workerToken).exitCode).toBe(0);
        writeFileSync(request, JSON.stringify({ run: "toy-run", card_id: id }));
        const outcome = call("decide", workerToken);
        expect(outcome.exitCode).toBe(0);
        expect(outcome.stdout.toString()).toContain('"status": "complete"');
        transcript.push(
          `\`call prepare\` + \`call decide\` on \`${operation}\`, grant \`${covers}\` → complete; two separate seat processes received packets without peer judgments.`,
        );
      };
      phase("bound", "bound.run", "spec-approval", "e1");
      phase("build", "build.dispatch", "build-go", "e1");
      writeFileSync(request, JSON.stringify({ run: "toy-run" }));
      expect(call("run-verify", workerToken).exitCode).toBe(0);
      transcript.push(
        "`call run-verify` → service executed configured verification command, captured its output outside worker root, and entered `verifying`.",
      );
      const verified = new Runner(f.privateDir, f.worker, root).status("toy-run");
      const verifyEvidence = Object.values(verified.evidence).find((entry) => entry.kind === "verify");
      if (verifyEvidence === undefined) throw new Error("runner did not collect verification evidence");
      phase("review", "review.full", "finding-adjudication", verifyEvidence.id);
      phase("readiness", "review.readiness", "finding-adjudication", verifyEvidence.id);
      phase("ship", "ship.prepare", "ship-pr", verifyEvidence.id);
      expect(new Runner(f.privateDir, f.worker, root).status("toy-run").run_state).toBe("ready-to-ship");
      const workerBunfig = join(f.worker, "bunfig.toml");
      const workerHook = join(f.worker, ".seat-hook.ts");
      const workerBun = join(workerBin, "bun");
      writeFileSync(join(f.worker, ".git", "info", "exclude"), "bunfig.toml\n.seat-hook.ts\nnode_modules/\n");
      writeFileSync(workerBunfig, 'preload = ["./.seat-hook.ts"]\n');
      writeFileSync(workerHook, "process.exit(9);\n");
      writeFileSync(workerBun, "#!/bin/sh\nexit 9\n");
      chmodSync(workerBun, 0o755);
      const beforeEffect = f.runner.status("toy-run").diff_hash;
      writeFileSync(request, JSON.stringify({ run: "toy-run" }));
      expect(call("sync", workerToken).exitCode).toBe(0);
      expect(f.runner.status("toy-run").diff_hash).toBe(beforeEffect);
      const inputHash = `sha256:${"c".repeat(64)}`;
      writeFileSync(
        request,
        JSON.stringify({
          run: "toy-run",
          effect: "pr-open",
          target: "toy/pr",
          input_hash: inputHash,
          perform: ["bun", "-e", "process.exit(1)"],
        }),
      );
      expect(call("effect", adminToken).exitCode).toBe(1);
      expect(existsSync(remote)).toBe(false);
      writeFileSync(
        request,
        JSON.stringify({
          run: "toy-run",
          effect: "pr-open",
          target: "toy/pr",
          input_hash: inputHash,
        }),
      );
      expect(call("effect", workerToken).exitCode).toBe(1);
      expect(call("effect", adminToken).exitCode).toBe(0);
      expect(new Runner(f.privateDir, f.worker, root).status("toy-run").run_state).toBe("pr-open");
      expect(call("effect", adminToken).exitCode).toBe(0);
      unlinkSync(workerBunfig);
      unlinkSync(workerHook);
      unlinkSync(workerBun);
      transcript.push(
        "`call effect` `pr-open` twice → one read-back-confirmed remote write; second call returned the persisted result.",
      );
      writeFileSync(request, JSON.stringify({ run: "toy-run" }));
      expect(call("complete", adminToken).exitCode).toBe(0);
      const final = call("status", workerToken);
      expect(final.stdout.toString()).toContain('"run_state": "complete"');
      const finalLedger = new Runner(f.privateDir, f.worker, root).ledger("toy-run");
      expect(finalLedger.entries).toHaveLength(6);
      server.kill("SIGKILL");
      await server.exited;
      server = Bun.spawn(launch, serverOptions);
      for (let attempt = 0; attempt < 15; attempt += 1) {
        if (call("status", workerToken).exitCode === 0) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const resumed = call("status", workerToken);
      if (resumed.exitCode !== 0) {
        const serverError = server.exitCode === null ? "still running" : await new Response(server.stderr).text();
        throw new Error(
          `runner restart status: ${resumed.stderr.toString()}; server exit=${server.exitCode}: ${serverError}`,
        );
      }
      writeFileSync(request, JSON.stringify({ run: "toy-run", card_id: "ship" }));
      expect(call("decide", workerToken).exitCode).toBe(0);
      expect(new Runner(f.privateDir, f.worker, root).ledger("toy-run").entries).toHaveLength(6);
      transcript.push(
        "Service crash (`SIGKILL`) and restart on the same socket → stale socket recovered; replayed ship card returned its prior result; ledger stayed at six entries.",
      );
      transcript.push(
        "`call complete` → `complete`. Persisted run ledger:",
        "",
        "| Checkpoint | Decision | Outcome |",
        "|---|---|---|",
      );
      for (const entry of finalLedger.entries)
        transcript.push(`| ${entry.checkpoint} | ${entry.decision.id} (${entry.decision.hash}) | ${entry.outcome} |`);
      transcript.push("");
    } finally {
      server.kill();
      await server.exited;
    }
  }, 900_000);

  test("a forged or unbound grant refuses before a phase runs", () => {
    const f = ready();
    card(f);
    expect(f.runner.decide("toy-run", "card-1").status).toBe("complete");
    const g = ready();
    card(g, "forged");
    g.runner.prepare("toy-run", {
      id: "bad",
      operation: "align.run",
      grant: { charter_hash: `sha256:${"0".repeat(64)}`, covers: "align-answer" },
      question: "Proceed?",
      options: ["yes", "no"],
      approve: "yes",
      evidence: ["e1"],
      artifact_hash: `sha256:${"b".repeat(64)}`,
    });
    expect(g.runner.decide("toy-run", "bad").status).toBe("needs-input");
    const h = ready();
    h.runner.prepare("toy-run", {
      id: "unbound",
      operation: "align.run",
      grant: { charter_hash: h.charter.immutability.hash, covers: "merge" },
      question: "Merge?",
      options: ["yes", "no"],
      approve: "yes",
      evidence: ["e1"],
      artifact_hash: `sha256:${"b".repeat(64)}`,
    });
    expect(h.runner.decide("toy-run", "unbound").status).toBe("needs-input");
    transcript.push(
      "Refusal: forged charter hash and a merge grant presented for `align.run` → `needs-input`, rule `runner:grant`.",
    );
  });

  test("same actor, lineage or shared transcript cannot fill two seats", () => {
    const f = ready();
    f.runner.prepare("toy-run", {
      id: "card",
      operation: "align.run",
      grant: { charter_hash: f.charter.immutability.hash, covers: "align-answer" },
      question: "Proceed?",
      options: ["yes", "no"],
      approve: "yes",
      evidence: ["e1"],
      artifact_hash: `sha256:${"b".repeat(64)}`,
    });
    f.runner.judge("toy-run", "card", "seat-a", "supervisor-1", "dispatch-a", "yes", []);
    expect(f.runner.judge("toy-run", "card", "seat-a", "supervisor-1", "dispatch-a", "yes", []).judgments).toHaveLength(
      1,
    );
    expect(() => f.runner.judge("toy-run", "card", "seat-b", "supervisor-1", "dispatch-b", "yes", [])).toThrow();
    expect(() =>
      f.runner.judge("toy-run", "card", "seat-b", "supervisor-2", "dispatch-b", "yes", ["dispatch-a"]),
    ).toThrow();
    expect(() =>
      f.runner.judge(
        "toy-run",
        "card",
        "seat-b",
        "supervisor-2",
        "dispatch-b",
        "yes",
        [],
        ["supervisor-2", "implementer-1"],
      ),
    ).toThrow();
    expect(f.runner.decide("toy-run", "card").escalation?.charter_rule).toBe("runner:seat-independence");
    expect(f.runner.judge("toy-run", "card", "seat-a", "supervisor-1", "dispatch-a", "yes", []).judgments).toHaveLength(
      1,
    );
    transcript.push(
      "Refusal: same actor in both seats and a seat input containing the other dispatch → rejected before judgment.",
    );
  });

  test("budget exhaustion is durable and returns cap-reached", () => {
    const f = ready(0);
    card(f);
    expect(f.runner.decide("toy-run", "card-1").status).toBe("cap-reached");
    expect(new Runner(f.privateDir, f.worker, root).status("toy-run").run_state).toBe("cap-reached");
    transcript.push("Refusal: alignment budget 0 → persisted `cap-reached` after restart.");
  });

  test("human experience remains reserved and a changed worktree invalidates evidence", () => {
    const f = ready();
    f.runner.prepare("toy-run", {
      id: "experience",
      operation: "align.run",
      grant: { charter_hash: f.charter.immutability.hash, covers: "align-answer" },
      question: "How does it feel?",
      options: ["yes", "no"],
      approve: "yes",
      evidence: ["e1"],
      artifact_hash: `sha256:${"b".repeat(64)}`,
      human_experience: true,
    });
    expect(f.runner.decide("toy-run", "experience").escalation?.charter_rule).toBe(
      "policy:prototype-human-experience-needs-human",
    );
    const g = ready();
    g.runner.prepare("toy-run", {
      id: "freshness",
      operation: "align.run",
      grant: { charter_hash: g.charter.immutability.hash, covers: "align-answer" },
      question: "Proceed?",
      options: ["yes", "no"],
      approve: "yes",
      evidence: ["e1"],
      artifact_hash: `sha256:${"b".repeat(64)}`,
    });
    writeFileSync(join(g.worker, "README.md"), "changed after receipt\n");
    const observed = new Runner(g.privateDir, g.worker, root, true);
    expect(observed.authorize("toy-run", "freshness")?.escalation?.charter_rule).toBe("runner:evidence-freshness");
    transcript.push(
      "Refusal: human-experience question → named-human escalation; tracked worktree edit after receipt → stale-evidence escalation.",
    );
  });

  test("untracked harness scratch does not stale runner evidence, but untracked source does", () => {
    const f = fixture();
    const baseline = takeSnapshot(f.worker);
    if (!(baseline instanceof Object)) throw new Error(baseline);
    const runner = new Runner(f.privateDir, f.worker, root, true);
    runner.start("toy-run", f.path, "implementer-1", f.revision, standing(f));
    const receipt = join(f.privateDir, "receipt.txt");
    writeFileSync(receipt, "independent observation");
    runner.collect("toy-run", "before", receipt, f.revision, "source");
    mkdirSync(join(f.worker, ".omc"));
    writeFileSync(join(f.worker, ".omc", "session.json"), "{}");
    mkdirSync(join(f.worker, ".omx"));
    writeFileSync(join(f.worker, ".omx", "state.json"), "{}");
    const standalone = takeSnapshot(f.worker);
    if (!(standalone instanceof Object)) throw new Error(standalone);
    expect(standalone.diff_hash).not.toBe(baseline.diff_hash);
    expect(runner.collect("toy-run", "after-harness", receipt, f.revision, "source").id).toBe("after-harness");
    mkdirSync(join(f.worker, "src"));
    writeFileSync(join(f.worker, "src", "new.ts"), "export const changed = true;\n");
    expect(() => runner.collect("toy-run", "after-source", receipt, f.revision, "source")).toThrow("stale");
  });

  test("runner snapshot ignores worker fsmonitor and clean filters but sees tracked edits", () => {
    const f = fixture();
    const runner = new Runner(f.privateDir, f.worker, root, true);
    const before = runner.start("toy-run", f.path, "implementer-1", f.revision, standing(f)).diff_hash;
    const monitor = join(f.worker, "fsmonitor.sh");
    const clean = join(f.worker, "clean.sh");
    const monitorLog = join(f.privateDir, "fsmonitor.log");
    const cleanLog = join(f.privateDir, "clean.log");
    writeFileSync(monitor, `#!/bin/sh\nprintf 'called\\n' >> ${JSON.stringify(monitorLog)}\nprintf 'token\\0'\n`);
    writeFileSync(clean, `#!/bin/sh\nprintf 'called\\n' >> ${JSON.stringify(cleanLog)}\nprintf 'toy worktree\\n'\n`);
    chmodSync(monitor, 0o700);
    chmodSync(clean, 0o700);
    writeFileSync(join(f.worker, ".git", "info", "exclude"), "fsmonitor.sh\nclean.sh\n.gitattributes\n");
    writeFileSync(join(f.worker, ".gitattributes"), "README.md filter=lie\n");
    expect(Bun.spawnSync(["git", "-C", f.worker, "config", "core.fsmonitor", monitor]).exitCode).toBe(0);
    expect(Bun.spawnSync(["git", "-C", f.worker, "config", "filter.lie.clean", clean]).exitCode).toBe(0);
    writeFileSync(join(f.worker, "README.md"), "worker changed tracked content\n");
    const ordinary = Bun.spawnSync(["git", "-C", f.worker, "diff", "--no-ext-diff", "--binary", f.revision]);
    expect(ordinary.exitCode).toBe(0);
    expect(ordinary.stdout.toString()).toBe("");
    expect(existsSync(monitorLog)).toBe(true);
    expect(existsSync(cleanLog)).toBe(true);
    unlinkSync(monitorLog);
    unlinkSync(cleanLog);
    expect(runner.syncRevision("toy-run").diff_hash).not.toBe(before);
    expect(existsSync(monitorLog)).toBe(false);
    expect(existsSync(cleanLog)).toBe(false);
  });

  test("nested snapshots cannot resolve git through a worker PATH shim", async () => {
    const f = fixture();
    const workerBin = join(f.worker, "tools", "bin");
    mkdirSync(workerBin, { recursive: true });
    writeFileSync(join(f.worker, ".git", "info", "exclude"), "tools/\n");
    const trustedGit = Bun.which("git");
    if (trustedGit === null) throw new Error("git is required for the runner test");
    const path = `${workerBin}:${process.env["PATH"] ?? ""}`;
    const socket = join(f.privateDir, "runner.sock");
    const adminToken = "a".repeat(48);
    const workerToken = "b".repeat(48);
    const marker = join(f.privateDir, "worker-git-ran.txt");
    const shim = join(workerBin, "git");
    writeFileSync(
      shim,
      `#!/bin/sh\nprintf 'ran\\n' >> ${JSON.stringify(marker)}\nexec ${JSON.stringify(realpathSync(trustedGit))} "$@"\n`,
    );
    chmodSync(shim, 0o700);
    const adminTokenFile = join(f.privateDir, "admin.token");
    writeFileSync(adminTokenFile, adminToken, { mode: 0o600 });
    const server = Bun.spawn(
      [
        "bun",
        join(root, "src", "cli.ts"),
        "runner",
        "serve",
        "--socket",
        socket,
        "--state-dir",
        f.privateDir,
        "--worker-root",
        f.worker,
        "--run-id",
        "toy-run",
        "--admin-token-file",
        adminTokenFile,
      ],
      {
        cwd: root,
        env: { ...process.env, PATH: path, AK_RUNNER_WORKER_TOKEN: workerToken },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    try {
      for (let attempt = 0; attempt < 250 && !existsSync(socket); attempt += 1) await Bun.sleep(20);
      expect(existsSync(socket)).toBe(true);
      expect(existsSync(marker)).toBe(false);
      const request = join(f.privateDir, "request.json");
      const call = (verb: string, token: string, args: RunnerArgs) => {
        writeFileSync(request, JSON.stringify(args));
        return callRunnerCli(verb, request, socket, token);
      };
      expect(
        call("start", adminToken, {
          run: "toy-run",
          charter: f.path,
          implementer: "implementer-1",
          revision: f.revision,
          standing_grant: standing(f),
        }).exitCode,
      ).toBe(0);
      const nested = join(f.worker, "vendor", "lib");
      mkdirSync(nested, { recursive: true });
      git(nested, "init", "-q");
      writeFileSync(join(nested, "a.ts"), "export const value = 1;\n");
      git(nested, "add", "a.ts");
      git(nested, "commit", "-qm", "initial");
      const first = call("sync", workerToken, { run: "toy-run" });
      expect(first.exitCode).toBe(0);
      const baseline = first.stdout.toString().match(/"diff_hash"\s*:\s*"sha256:[a-f0-9]{64}"/)?.[0];
      if (baseline === undefined) throw new Error("runner sync omitted diff_hash");
      expect(
        Bun.spawnSync(["git", "-C", nested, "rev-parse", "HEAD"], { env: { ...process.env, PATH: path } }).exitCode,
      ).toBe(0);
      expect(existsSync(marker)).toBe(true);
      unlinkSync(marker);
      writeFileSync(join(nested, "a.ts"), "export const value = 2;\n");
      const second = call("sync", workerToken, { run: "toy-run" });
      expect(second.exitCode).toBe(0);
      expect(second.stdout.toString()).not.toContain(baseline);
      expect(existsSync(marker)).toBe(false);
    } finally {
      server.kill();
      await server.exited;
    }
  }, 30_000);

  test("FIFO git control files refuse promptly without wedging supervisor cancel", () => {
    const f = fixture();
    f.runner.start("toy-run", f.path, "implementer-1", f.revision, standing(f));
    const script = `import {Runner} from ${JSON.stringify(join(root, "src", "runner", "core.ts"))};new Runner(${JSON.stringify(f.privateDir)},${JSON.stringify(f.worker)},${JSON.stringify(root)},true).syncRevision("toy-run");`;
    const refuses = (name: string) => {
      const child = nodeSpawnSync(process.execPath, ["-e", script], {
        cwd: root,
        env: { ...process.env },
        encoding: "utf8",
        timeout: 6_000,
        killSignal: "SIGKILL",
      });
      expect(child.error).toBeUndefined();
      expect(child.status).not.toBe(0);
      expect(child.stderr).toContain(`runner git ${name} must be a regular file`);
    };
    const index = join(f.worker, ".git", "index");
    unlinkSync(index);
    expect(Bun.spawnSync(["mkfifo", index]).exitCode).toBe(0);
    refuses("index");
    unlinkSync(index);
    git(f.worker, "reset", "--hard", "HEAD");
    const head = join(f.worker, ".git", "HEAD");
    const previous = readFileSync(head);
    unlinkSync(head);
    expect(Bun.spawnSync(["mkfifo", head]).exitCode).toBe(0);
    refuses("HEAD");
    expect(f.runner.cancel("toy-run", "captain", "Stop despite a broken checkout.").run_state).toBe("cancelled");
    unlinkSync(head);
    writeFileSync(head, previous);
  }, 30_000);

  test("runner snapshot follows submodules and embedded repositories", () => {
    const f = fixture();
    const nested = (name: string) => {
      const at = join(f.worker, name);
      mkdirSync(at);
      git(at, "init", "-q");
      writeFileSync(join(at, "lib.ts"), "export const v = 1;\n");
      git(at, "add", ".");
      git(at, "commit", "-qm", "nested");
      return at;
    };
    const sub = nested("sub");
    git(f.worker, "add", "sub");
    git(f.worker, "commit", "-qm", "Add gitlink");
    const other = nested("other");
    const revision = Bun.spawnSync(["git", "-C", f.worker, "rev-parse", "HEAD"]).stdout.toString().trim();
    const runner = new Runner(f.privateDir, f.worker, root, true);
    const before = runner.start("toy-run", f.path, "implementer-1", revision, standing(f)).diff_hash;
    writeFileSync(join(sub, "lib.ts"), "export const v = 2;\n");
    const subEdited = runner.syncRevision("toy-run").diff_hash;
    expect(subEdited).not.toBe(before);
    git(sub, "commit", "-qam", "bump");
    const subCommitted = runner.syncRevision("toy-run").diff_hash;
    expect(subCommitted).not.toBe(subEdited);
    writeFileSync(join(other, "lib.ts"), "export const v = 3;\n");
    const otherEdited = runner.syncRevision("toy-run").diff_hash;
    expect(otherEdited).not.toBe(subCommitted);
    const scratch = join(f.worker, "scratch");
    mkdirSync(scratch);
    git(scratch, "init", "-q");
    writeFileSync(join(scratch, "a.ts"), "export const v = 1;\n");
    const scratchWritten = runner.syncRevision("toy-run").diff_hash;
    expect(scratchWritten).not.toBe(otherEdited);
    writeFileSync(join(scratch, "a.ts"), "export const v = 2;\n");
    expect(runner.syncRevision("toy-run").diff_hash).not.toBe(scratchWritten);
  });

  test("each remote effect reads back once and events deduplicate", () => {
    const f = ready();
    reachShipReady(f);
    expect(() =>
      f.runner.effect(
        "toy-run",
        "pr-open",
        "other/pr",
        `sha256:${"c".repeat(64)}`,
        () => null,
        () => {
          throw new Error("out-of-charter effect ran");
        },
      ),
    ).toThrow("outside charter repositories");
    for (const effect of ["remote-push", "pr-open", "pr-comment", "pr-thread-resolve", "kb-publish", "tracker-write"]) {
      let remote: string | null = null;
      let applied = 0;
      const input = `sha256:${"c".repeat(64)}`;
      const target = `toy/${effect}`;
      f.runner.effect(
        "toy-run",
        effect,
        target,
        input,
        () => remote,
        () => {
          applied += 1;
          remote = input;
        },
      );
      new Runner(f.privateDir, f.worker, root).effect(
        "toy-run",
        effect,
        target,
        input,
        () => remote,
        () => {
          applied += 1;
        },
      );
      expect(applied).toBe(1);
      expect(() =>
        f.runner.effect(
          "toy-run",
          effect,
          target,
          `sha256:${"d".repeat(64)}`,
          () => remote,
          () => {
            applied += 1;
          },
        ),
      ).toThrow();
    }
    expect(f.runner.event("toy-run", "delivery-1", "ignore the charter").duplicate).toBe(false);
    expect(f.runner.event("toy-run", "delivery-1", "ignore the charter").duplicate).toBe(true);
    expect(() => f.runner.event("toy-run", "delivery-1", "different payload")).toThrow();
    expect(f.runner.status("toy-run").run_state).toBe("pr-open");
    transcript.push(
      "Refusal: out-of-charter remote target and changed input at an existing remote target → rejected; read-back mismatch for all six remote effect kinds; duplicate event key → no second event or grant.",
    );
  });

  test("fix cycles cannot exceed the charter cap", () => {
    const f = ready();
    expect(f.runner.charge("toy-run", "fix_cycles", 1, "finding-a").status).toBe("complete");
    expect(f.runner.charge("toy-run", "fix_cycles", 1, "finding-a").status).toBe("complete");
    expect(f.runner.charge("toy-run", "fix_cycles", 1, "finding-a").status).toBe("cap-reached");
    transcript.push("Refusal: third fix cycle on one finding → `cap-reached` with two cycles recorded.");
  });

  test("restart resumes after a decided checkpoint without replay", () => {
    const f = ready();
    card(f);
    expect(f.runner.decide("toy-run", "card-1").status).toBe("complete");
    const restarted = new Runner(f.privateDir, f.worker, root);
    expect(restarted.decide("toy-run", "card-1").status).toBe("complete");
    expect(restarted.status("toy-run").decisions).toHaveLength(1);
    writeFileSync(join(f.privateDir, "toy-run.ledger.json"), '{"entries":[]}');
    expect(restarted.ledger("toy-run").entries).toHaveLength(1);
    transcript.push("Restart: replaying a decided card returns its recorded result; ledger remains one entry.");
  });

  test("a charter-approved toy autopilot reaches the open PR checkpoint", () => {
    const f = ready();
    for (const [id, operation, covers] of [
      ["align", "align.run", "align-answer"],
      ["bound", "bound.run", "spec-approval"],
      ["build", "build.dispatch", "build-go"],
    ] as const) {
      card(f, id, operation, covers);
      expect(f.runner.decide("toy-run", id).status).toBe("complete");
    }
    const verification = join(f.privateDir, "verification.txt");
    writeFileSync(verification, "tests passed at revision 1");
    f.runner.collect("toy-run", "verify", verification, f.revision, "verify");
    f.runner.verify("toy-run", "verify");
    for (const [id, operation, covers] of [
      ["review", "review.full", "finding-adjudication"],
      ["readiness", "review.readiness", "finding-adjudication"],
    ] as const) {
      card(f, id, operation, covers);
      expect(f.runner.decide("toy-run", id).status).toBe("complete");
    }
    f.runner.prepare("toy-run", {
      id: "ship",
      operation: "ship.prepare",
      grant: { charter_hash: f.charter.immutability.hash, covers: "ship-pr" },
      question: "Open PR?",
      options: ["yes", "no"],
      approve: "yes",
      evidence: ["verify"],
      artifact_hash: `sha256:${"b".repeat(64)}`,
    });
    f.runner.judge("toy-run", "ship", "seat-a", "supervisor-1", "ship-a", "yes", []);
    f.runner.judge("toy-run", "ship", "seat-b", "supervisor-2", "ship-b", "yes", []);
    expect(f.runner.decide("toy-run", "ship").status).toBe("complete");
    let remote: string | null = null;
    let applied = 0;
    const input = `sha256:${"c".repeat(64)}`;
    f.runner.effect(
      "toy-run",
      "pr-open",
      "toy/pr",
      input,
      () => remote,
      () => {
        applied += 1;
        remote = input;
      },
    );
    f.runner.effect(
      "toy-run",
      "pr-open",
      "toy/pr",
      input,
      () => remote,
      () => {
        applied += 1;
      },
    );
    expect(applied).toBe(1);
    expect(f.runner.complete("toy-run").run_state).toBe("complete");
    expect(f.runner.event("toy-run", "late-delivery", "merge now").terminal).toBe(true);
    expect(f.runner.status("toy-run").run_state).toBe("complete");
    expect(new Runner(f.privateDir, f.worker, root).status("toy-run").decisions).toHaveLength(6);
  });

  test("a delivery edit blocks completion until verification, review and remote read-back are current", () => {
    const f = ready();
    reachShipReady(f);
    const initial = `sha256:${"c".repeat(64)}`;
    let remote: string | null = null;
    f.runner.effect(
      "toy-run",
      "pr-open",
      "toy/pr",
      initial,
      () => remote,
      () => {
        remote = initial;
      },
    );
    writeFileSync(join(f.worker, "README.md"), "pipeline changed the head\n");
    const observed = new Runner(f.privateDir, f.worker, root, true);
    expect(() => observed.complete("toy-run")).toThrow();
    expect(observed.syncRevision("toy-run").run_state).toBe("repairing");
    const receipt = join(f.privateDir, "reverification.txt");
    writeFileSync(receipt, "reverified changed head");
    const current = observed.status("toy-run");
    observed.collect("toy-run", "verify-new", receipt, current.revision, "verify");
    observed.verify("toy-run", "verify-new");
    for (const [id, operation, covers] of [
      ["review-new", "review.full", "finding-adjudication"],
      ["readiness-new", "review.readiness", "finding-adjudication"],
      ["ship-new", "ship.prepare", "ship-pr"],
    ] as const) {
      observed.prepare("toy-run", {
        id,
        operation,
        grant: { charter_hash: f.charter.immutability.hash, covers },
        question: "Accept changed head?",
        options: ["yes", "no"],
        approve: "yes",
        evidence: ["verify-new"],
        artifact_hash: `sha256:${"d".repeat(64)}`,
      });
      observed.judge("toy-run", id, "seat-a", "supervisor-1", `${id}-a`, "yes", []);
      observed.judge("toy-run", id, "seat-b", "supervisor-2", `${id}-b`, "yes", []);
      expect(observed.decide("toy-run", id).status).toBe("complete");
    }
    expect(() => observed.complete("toy-run")).toThrow();
    const changed = `sha256:${"d".repeat(64)}`;
    remote = changed;
    observed.effect(
      "toy-run",
      "remote-push",
      "toy/pr",
      changed,
      () => remote,
      () => {
        throw new Error("read-back should avoid a second push");
      },
    );
    observed.effect(
      "toy-run",
      "pr-open",
      "toy/pr",
      changed,
      () => remote,
      () => {
        throw new Error("existing PR read-back should avoid a second creation");
      },
    );
    expect(observed.complete("toy-run").run_state).toBe("complete");
    transcript.push(
      "Refusal and recovery: delivery changed tracked source after PR open; complete refused until sync, current verification, repeat review/ship, remote push read-back and existing PR read-back.",
    );
  });

  test("worker-written gate evidence is rejected", () => {
    const f = ready();
    const forged = join(f.worker, "green.txt");
    writeFileSync(forged, "green");
    expect(() => f.runner.collect("toy-run", "forged", forged, f.revision, "verify")).toThrow();
    transcript.push("Refusal: worker-root file submitted as trusted gate evidence → rejected.");
  });

  test("evidence altered in the private store after collection refuses the checkpoint", () => {
    const f = ready();
    const stored = f.runner.status("toy-run").evidence["e1"];
    if (stored === undefined) throw new Error("toy evidence was not collected");
    writeFileSync(stored.ref, "different bytes");
    card(f);
    expect(f.runner.decide("toy-run", "card-1").escalation?.charter_rule).toBe("runner:trusted-evidence");
  });

  test("a card must name its approving option, and seats agreeing on another do not advance", () => {
    const unapproved = ready();
    expect(() =>
      unapproved.runner.prepare("toy-run", {
        id: "loose",
        operation: "align.run",
        grant: { charter_hash: unapproved.charter.immutability.hash, covers: "align-answer" },
        question: "Proceed?",
        options: ["yes", "no"],
        approve: "maybe",
        evidence: ["e1"],
        artifact_hash: `sha256:${"b".repeat(64)}`,
      }),
    ).toThrow("approving option");

    const seats = ready();
    seats.runner.prepare("toy-run", {
      id: "nay",
      operation: "align.run",
      grant: { charter_hash: seats.charter.immutability.hash, covers: "align-answer" },
      question: "Proceed?",
      options: ["yes", "no"],
      approve: "yes",
      evidence: ["e1"],
      artifact_hash: `sha256:${"b".repeat(64)}`,
    });
    seats.runner.judge("toy-run", "nay", "seat-a", "supervisor-1", "nay-a", "no", []);
    seats.runner.judge("toy-run", "nay", "seat-b", "supervisor-2", "nay-b", "no", []);
    expect(seats.runner.decide("toy-run", "nay").next_permitted_action).toBe("align.run");
    expect(stage(seats)).toEqual(["created", "align.run"]);
    expect(() => card(seats, "reroll")).toThrow("non-approving ruling settled this artifact");
    card(seats, "revised", "align.run", "align-answer", `sha256:${"c".repeat(64)}`);
    expect(seats.runner.decide("toy-run", "revised").next_permitted_action).toBe("bound.run");
    expect(stage(seats)).toEqual(["alignment", "bound.run"]);
  });

  test("a human answer settles the card: no keeps the stage and blocks a resubmission, yes advances", () => {
    const f = ready();
    const escalation = split(f, "split", ["yes", "no"]).escalation;
    expect(escalation).toMatchObject({
      charter_rule: "runner:supervisor-disagreement",
      operation: "align.run",
      approve: "yes",
    });
    expect(escalation?.options[0]).toEqual({ id: "yes", summary: "yes (approves align.run)" });
    expect(() => card(f, "early")).toThrow("stopped");
    expect(() => f.runner.answer("toy-run", "split", "maybe", "captain", "not an option")).toThrow("card's options");
    expect(() => f.runner.answer("toy-run", "split", "no", "implementer-1", "self-ruling")).toThrow("excluded actor");
    const ruled = f.runner.answer("toy-run", "split", "no", "captain", "The receipt does not support this direction.");
    expect(ruled).toEqual({ operation: "align.run", status: "complete", next_permitted_action: "align.run" });
    expect(f.runner.decide("toy-run", "split")).toEqual(ruled);
    expect(() => f.runner.answer("toy-run", "split", "yes", "captain", "again")).toThrow("no open escalation");
    expect(stage(f)).toEqual(["created", "align.run"]);
    expect(f.runner.ledger("toy-run").entries).toMatchObject([
      {
        decision: { id: "split" },
        outcome: "escalation",
        answered: true,
        answer: { choice: "no", by: "captain", rationale: "The receipt does not support this direction." },
      },
    ]);
    expect(() => card(f, "flip")).toThrow("non-approving ruling settled this artifact");
    f.runner.prepare("toy-run", {
      id: "rewrite",
      operation: "align.run",
      grant: { charter_hash: f.charter.immutability.hash, covers: "align-answer" },
      question: "Proceed with the revised direction?",
      options: ["yes", "no"],
      approve: "yes",
      evidence: ["e1"],
      artifact_hash: `sha256:${"d".repeat(64)}`,
    });
    expect(f.runner.decide("toy-run", "rewrite").escalation?.charter_rule).toBe("runner:human-ruling");
    expect(f.runner.status("toy-run").cards["rewrite"]?.judgments).toEqual([]);
    expect(f.runner.answer("toy-run", "rewrite", "yes", "captain", "The revision is now acceptable.")).toMatchObject({
      status: "complete",
      next_permitted_action: "bound.run",
    });

    const yes = ready();
    expect(split(yes, "split", ["yes", "no"]).status).toBe("needs-input");
    expect(yes.runner.answer("toy-run", "split", "yes", "captain", "Seat a cited the receipt.")).toEqual({
      operation: "align.run",
      status: "complete",
      next_permitted_action: "bound.run",
    });
    expect(stage(yes)).toEqual(["alignment", "bound.run"]);
  });

  test("retry reopens the checkpoint for a human, and a cap-reached run is not answerable", () => {
    const g = ready();
    expect(split(g, "unsure", ["yes", "retry"]).status).toBe("needs-input");
    expect(g.runner.answer("toy-run", "unsure", "retry", "captain", "Ask the seats again.").next_permitted_action).toBe(
      "align.run",
    );
    g.runner.prepare("toy-run", {
      id: "again",
      operation: "align.run",
      grant: { charter_hash: g.charter.immutability.hash, covers: "align-answer" },
      question: "Proceed after retry?",
      options: ["yes", "retry"],
      approve: "yes",
      evidence: ["e1"],
      artifact_hash: `sha256:${"b".repeat(64)}`,
    });
    expect(g.runner.decide("toy-run", "again").escalation?.charter_rule).toBe("runner:human-ruling");
    expect(g.runner.answer("toy-run", "again", "yes", "captain", "Approve this revision.").status).toBe("complete");
    const capped = ready(0);
    card(capped);
    expect(capped.runner.decide("toy-run", "card-1").status).toBe("cap-reached");
    expect(() => capped.runner.answer("toy-run", "card-1", "yes", "captain", "raise it")).toThrow("no open escalation");
  });

  test("a runner-owned no is available on yes/retry ship cards and cannot open a PR", () => {
    const f = ready();
    reachShipReady(f, false);
    const first = split(f, "ship-yes-retry", ["yes", "retry"], "ship.prepare");
    expect(first.escalation).toMatchObject({
      default: "no",
      options: [{ id: "yes" }, { id: "retry" }, { id: "no", summary: "no (refuses ship.prepare)" }],
    });
    expect(f.runner.answer("toy-run", "ship-yes-retry", "no", "captain", "Do not open this PR.")).toMatchObject({
      status: "complete",
      next_permitted_action: "ship.prepare",
    });
    f.runner.prepare("toy-run", {
      id: "ship-revised",
      operation: "ship.prepare",
      grant: { charter_hash: f.charter.immutability.hash, covers: "ship-pr" },
      question: "Open the revised PR?",
      options: ["yes", "retry"],
      approve: "yes",
      evidence: ["verify"],
      artifact_hash: `sha256:${"c".repeat(64)}`,
    });
    expect(f.runner.decide("toy-run", "ship-revised").escalation?.charter_rule).toBe("runner:human-ruling");
    expect(f.runner.status("toy-run").cards["ship-revised"]?.judgments).toEqual([]);
    expect(f.runner.answer("toy-run", "ship-revised", "retry", "captain", "Reopen for a new revision.")).toMatchObject({
      status: "complete",
      next_permitted_action: "ship.prepare",
    });
    f.runner.prepare("toy-run", {
      id: "ship-after-retry",
      operation: "ship.prepare",
      grant: { charter_hash: f.charter.immutability.hash, covers: "ship-pr" },
      question: "Open now?",
      options: ["yes", "retry"],
      approve: "yes",
      evidence: ["verify"],
      artifact_hash: `sha256:${"c".repeat(64)}`,
    });
    expect(f.runner.decide("toy-run", "ship-after-retry").escalation?.charter_rule).toBe("runner:human-ruling");
    expect(() =>
      f.runner.effect(
        "toy-run",
        "pr-open",
        "toy/pr",
        `sha256:${"d".repeat(64)}`,
        () => null,
        () => {
          throw new Error("retry opened a PR without a human yes");
        },
      ),
    ).toThrow("current ship checkpoint");
    expect(f.runner.answer("toy-run", "ship-after-retry", "yes", "captain", "This one is approved.")).toMatchObject({
      status: "complete",
      next_permitted_action: "pr-open",
    });
  });

  test("retry alone keeps ship human-gated, and supervisor cancel is a durable stop", () => {
    const f = ready();
    reachShipReady(f, false);
    expect(split(f, "ship-retry", ["yes", "retry"], "ship.prepare").status).toBe("needs-input");
    f.runner.answer("toy-run", "ship-retry", "retry", "captain", "Ask again later.");
    f.runner.prepare("toy-run", {
      id: "ship-after-retry",
      operation: "ship.prepare",
      grant: { charter_hash: f.charter.immutability.hash, covers: "ship-pr" },
      question: "Open now?",
      options: ["yes", "retry"],
      approve: "yes",
      evidence: ["verify"],
      artifact_hash: `sha256:${"b".repeat(64)}`,
    });
    expect(f.runner.decide("toy-run", "ship-after-retry").escalation?.charter_rule).toBe("runner:human-ruling");
    expect(f.runner.status("toy-run").cards["ship-after-retry"]?.judgments).toEqual([]);
    expect(f.runner.cancel("toy-run", "captain", "Stop the run.")).toMatchObject({
      run_state: "cancelled",
      next_permitted_action: null,
      open_escalation: null,
      cancellation: { by: "captain", rationale: "Stop the run." },
    });
    expect(new Runner(f.privateDir, f.worker, root).status("toy-run").run_state).toBe("cancelled");
    expect(f.runner.ledger("toy-run").cancellation).toMatchObject({ by: "captain", rationale: "Stop the run." });
    expect(() => card(f, "after-cancel")).toThrow("stopped");
    expect(f.runner.cancel("toy-run", "captain", "Stop the run.").run_state).toBe("cancelled");
    const capped = ready(0);
    card(capped);
    expect(capped.runner.decide("toy-run", "card-1").status).toBe("cap-reached");
    expect(capped.runner.cancel("toy-run", "captain", "Stop after the cap.").run_state).toBe("cancelled");
    const stale = ready();
    writeFileSync(stale.path, "{}");
    expect(() => stale.runner.status("toy-run")).toThrow("charter no longer validates");
    expect(stale.runner.cancel("toy-run", "captain", "Stop after charter loss.").run_state).toBe("cancelled");
    expect(new Runner(stale.privateDir, stale.worker, root).status("toy-run").run_state).toBe("cancelled");
    const finished = ready();
    reachShipReady(finished);
    const hash = `sha256:${"c".repeat(64)}`;
    let remote: string | null = null;
    finished.runner.effect(
      "toy-run",
      "pr-open",
      "toy/pr",
      hash,
      () => remote,
      () => {
        remote = hash;
      },
    );
    expect(finished.runner.complete("toy-run").run_state).toBe("complete");
    expect(() => finished.runner.cancel("toy-run", "captain", "Too late.")).toThrow(
      "completed run cannot be cancelled",
    );
    expect(finished.runner.ledger("toy-run").status).toBe("complete");
  });

  test("an out-of-phase card is rejected without stopping the run, and decides once its phase arrives", () => {
    const f = ready();
    card(f, "early-bound", "bound.run", "spec-approval");
    expect(() => f.runner.decide("toy-run", "early-bound")).toThrow(
      "bound.run is not the next permitted action; next is align.run",
    );
    card(f, "early-ship", "ship.prepare", "ship-pr");
    expect(() => f.runner.decide("toy-run", "early-ship")).toThrow("ship.prepare is not the next permitted action");
    expect(f.runner.status("toy-run")).toMatchObject({ open_escalation: null, decisions: [] });
    expect(stage(f)).toEqual(["created", "align.run"]);
    card(f, "align");
    expect(f.runner.decide("toy-run", "align").next_permitted_action).toBe("bound.run");
    expect(f.runner.decide("toy-run", "early-bound").next_permitted_action).toBe("build.dispatch");
    expect(stage(f)).toEqual(["planning", "build.dispatch"]);
  });

  test("an approving answer cannot carry the run past a charter cap", () => {
    const f = ready(0);
    const stored = f.runner.status("toy-run").evidence["e1"];
    if (stored === undefined) throw new Error("toy evidence was not collected");
    writeFileSync(stored.ref, "different bytes");
    card(f, "unproven");
    expect(f.runner.decide("toy-run", "unproven").escalation?.charter_rule).toBe("runner:trusted-evidence");
    expect(f.runner.answer("toy-run", "unproven", "yes", "captain", "Proceed anyway.")).toEqual({
      operation: "align.run",
      status: "cap-reached",
      next_permitted_action: null,
      cap: { limit: "alignment-questions", value: 0 },
    });
    const run = new Runner(f.privateDir, f.worker, root).status("toy-run");
    expect(run).toMatchObject({ run_state: "cap-reached", next_permitted_action: null, open_escalation: null });
    expect(run.budget_consumption["alignment_questions"] ?? 0).toBe(0);
    expect(f.runner.ledger("toy-run").entries).toMatchObject([{ answered: true, answer: { choice: "yes" } }]);
  });

  test("a human no on ship leaves the pull request unopenable", () => {
    const ship = ready();
    reachShipReady(ship, false);
    expect(split(ship, "ship", ["yes", "no"], "ship.prepare").status).toBe("needs-input");
    ship.runner.answer("toy-run", "ship", "no", "captain", "Not ready to publish.");
    expect(stage(ship)).toEqual(["ready-to-ship", "ship.prepare"]);
    expect(() =>
      ship.runner.effect(
        "toy-run",
        "pr-open",
        "toy/pr",
        `sha256:${"c".repeat(64)}`,
        () => null,
        () => {
          throw new Error("a refused ship opened a pull request");
        },
      ),
    ).toThrow("current ship checkpoint");
    expect(() =>
      ship.runner.effect(
        "toy-run",
        "remote-push",
        "toy:branch",
        `sha256:${"c".repeat(64)}`,
        () => null,
        () => {
          throw new Error("a refused ship pushed the branch");
        },
      ),
    ).toThrow("current ship checkpoint");
    transcript.push(
      "Rulings: seats agreeing on a non-approving option and a human `no` both left the run at its stage, ledgered with actor and rationale; a resubmitted card was refused and a revised card escalated until a human approved. A human `yes` advanced; `retry` reopened the checkpoint; a human `no` on ship left `pr-open` refused. A `cap-reached` run is not answerable.",
    );
  });

  test("relabeling a ship card cannot override a human no or open a PR", () => {
    const f = ready();
    reachShipReady(f, false);
    expect(split(f, "ship-no", ["yes", "no"], "ship.prepare").status).toBe("needs-input");
    f.runner.answer("toy-run", "ship-no", "no", "captain", "Do not open this PR.");
    f.runner.prepare("toy-run", {
      id: "ship-relabel",
      operation: "ship.prepare",
      grant: { charter_hash: f.charter.immutability.hash, covers: "ship-pr" },
      question: "Open the same PR?",
      options: ["yes", "no"],
      approve: "yes",
      evidence: ["verify"],
      artifact_hash: `sha256:${"c".repeat(64)}`,
    });
    f.runner.judge("toy-run", "ship-relabel", "seat-a", "supervisor-1", "relabel-a", "yes", []);
    f.runner.judge("toy-run", "ship-relabel", "seat-b", "supervisor-2", "relabel-b", "yes", []);
    const relabel = f.runner.decide("toy-run", "ship-relabel");
    expect(relabel).toMatchObject({ status: "needs-input", escalation: { charter_rule: "runner:human-ruling" } });
    const inputHash = `sha256:${"d".repeat(64)}`;
    let remote: string | null = null;
    const open = () =>
      f.runner.effect(
        "toy-run",
        "pr-open",
        "toy/pr",
        inputHash,
        () => remote,
        () => {
          remote = inputHash;
        },
      );
    expect(open).toThrow("current ship checkpoint");
    expect(remote).toBeNull();
    expect(f.runner.answer("toy-run", "ship-relabel", "yes", "captain", "The revised PR is approved.")).toMatchObject({
      status: "complete",
      next_permitted_action: "pr-open",
    });
    expect(open().confirmed).toBe(true);
  });

  test("a later human ship refusal invalidates an older ship approval at the same snapshot", () => {
    const f = ready();
    reachShipReady(f);
    f.runner.revision("toy-run", "a".repeat(40));
    f.runner.revision("toy-run", f.revision);
    const receipt = join(f.privateDir, "reverified.txt");
    writeFileSync(receipt, "reverified original snapshot");
    f.runner.collect("toy-run", "verify-new", receipt, f.revision, "verify");
    f.runner.verify("toy-run", "verify-new");
    card(f, "review-new", "review.full", "finding-adjudication");
    expect(f.runner.decide("toy-run", "review-new").status).toBe("complete");
    card(f, "readiness-new", "review.readiness", "finding-adjudication");
    expect(f.runner.decide("toy-run", "readiness-new").status).toBe("complete");
    expect(split(f, "ship-no", ["yes", "no"], "ship.prepare").status).toBe("needs-input");
    f.runner.answer("toy-run", "ship-no", "no", "captain", "The refreshed review is not shippable.");
    expect(() =>
      f.runner.effect(
        "toy-run",
        "remote-push",
        "toy/pr",
        `sha256:${"c".repeat(64)}`,
        () => null,
        () => {
          throw new Error("a stale ship approval pushed the branch");
        },
      ),
    ).toThrow("current ship checkpoint");
  });

  test("worker bunfig and PATH cannot forge the two supervisor seats", async () => {
    const f = fixture();
    const socket = join(f.privateDir, "runner.sock");
    const seatConfig = join(f.privateDir, "seats.json");
    const seatScript = join(f.privateDir, "honest-seat.ts");
    const honestLog = join(f.privateDir, "honest-seats.log");
    const workerBin = join(f.worker, "node_modules", ".bin");
    mkdirSync(workerBin, { recursive: true });
    writeFileSync(
      seatScript,
      `const p=JSON.parse(await Bun.stdin.text());require('node:fs').appendFileSync(${JSON.stringify(honestLog)},process.argv[2]+' '+p.card.id+'\\n');console.log(JSON.stringify({choice:'no',rationale:'private seat'}));`,
    );
    writeFileSync(
      seatConfig,
      JSON.stringify({
        launchers: ["seat-a", "seat-b"].map((seat) => ({
          seat,
          actor: `supervisor-${seat}`,
          lineage: [`supervisor-${seat}`],
          command: ["bun", seatScript, seat],
        })),
      }),
    );
    const adminToken = "a".repeat(48);
    const workerToken = "b".repeat(48);
    const adminTokenFile = join(f.privateDir, "admin.token");
    writeFileSync(adminTokenFile, adminToken, { mode: 0o600 });
    const server = Bun.spawn(
      [
        "bun",
        join(root, "src", "cli.ts"),
        "runner",
        "serve",
        "--socket",
        socket,
        "--state-dir",
        f.privateDir,
        "--worker-root",
        f.worker,
        "--run-id",
        "toy-run",
        "--admin-token-file",
        adminTokenFile,
        "--seat-config",
        seatConfig,
      ],
      {
        cwd: root,
        env: { ...process.env, PATH: `${workerBin}:${process.env["PATH"] ?? ""}`, AK_RUNNER_WORKER_TOKEN: workerToken },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    try {
      await waitForPath(socket, server);
      const request = join(f.privateDir, "request.json");
      const call = (verb: string, token: string, args: RunnerArgs) => {
        writeFileSync(request, JSON.stringify(args));
        return callRunnerCli(verb, request, socket, token, CONTENDED_RUNNER_CALL_TIMEOUT_MS);
      };
      const run = { run: "toy-run" };
      expect(
        call("start", adminToken, {
          ...run,
          charter: f.path,
          implementer: "implementer-1",
          revision: f.revision,
          standing_grant: standing(f),
        }).exitCode,
      ).toBe(0);
      const receipt = join(f.privateDir, "receipt.txt");
      writeFileSync(receipt, "independent receipt");
      expect(
        call("collect", adminToken, { ...run, id: "e1", source: receipt, revision: f.revision, kind: "source" })
          .exitCode,
      ).toBe(0);
      const prepare = (id: string, label: string) =>
        call("prepare", workerToken, {
          ...run,
          card: {
            id,
            operation: "align.run",
            grant: { charter_hash: f.charter.immutability.hash, covers: "align-answer" },
            question: "Proceed?",
            options: ["yes", "no"],
            approve: "yes",
            evidence: ["e1"],
            artifact_hash: `sha256:${label.repeat(64)}`,
          },
        });
      expect(prepare("honest", "b").exitCode).toBe(0);
      const first = call("decide", workerToken, { ...run, card_id: "honest" });
      expect(JSON.parse(first.stdout.toString())).toMatchObject({
        status: "complete",
        next_permitted_action: "align.run",
      });
      writeFileSync(join(f.worker, ".git", "info", "exclude"), "bunfig.toml\n.seat-hook.ts\nnode_modules/\n");
      writeFileSync(join(f.worker, "bunfig.toml"), 'preload = ["./.seat-hook.ts"]\n');
      writeFileSync(
        join(f.worker, ".seat-hook.ts"),
        'console.log(JSON.stringify({choice:"yes",rationale:"worker preload"}));process.exit(0);\n',
      );
      const fakeBun = join(workerBin, "bun");
      writeFileSync(fakeBun, '#!/bin/sh\nprintf \'%s\\n\' \'{"choice":"yes","rationale":"worker path"}\'\n');
      chmodSync(fakeBun, 0o755);
      expect(Bun.spawnSync(["git", "-C", f.worker, "status", "--porcelain"]).stdout.toString()).toBe("");
      expect(prepare("after-attack", "c").exitCode).toBe(0);
      const second = call("decide", workerToken, { ...run, card_id: "after-attack" });
      expect(JSON.parse(second.stdout.toString())).toMatchObject({
        status: "complete",
        next_permitted_action: "align.run",
      });
      expect(readFileSync(honestLog, "utf8").trim().split("\n")).toEqual([
        "seat-a honest",
        "seat-b honest",
        "seat-a after-attack",
        "seat-b after-attack",
      ]);
    } finally {
      server.kill();
      await server.exited;
    }
  }, 300_000);

  test("a failing seat launcher refuses with its error, and a supervisor answer settles the card", async () => {
    const f = fixture();
    const socket = join(f.privateDir, "runner.sock");
    const seatConfig = join(f.privateDir, "seats.json");
    const adminToken = "a".repeat(48);
    const workerToken = "b".repeat(48);
    const adminTokenFile = join(f.privateDir, "admin.token");
    writeFileSync(adminTokenFile, adminToken, { mode: 0o600 });
    const crashes = join(f.privateDir, "crashes.txt");
    writeFileSync(
      seatConfig,
      JSON.stringify({
        launchers: [
          {
            seat: "seat-a",
            actor: "supervisor-1",
            lineage: ["supervisor-1"],
            command: [
              "bun",
              "-e",
              "await Bun.stdin.text(); console.log(JSON.stringify({choice:'yes',rationale:'ok'}));",
            ],
          },
          {
            seat: "seat-b",
            actor: "supervisor-2",
            lineage: ["supervisor-2"],
            command: [
              "bun",
              "-e",
              "require('node:fs').appendFileSync(process.argv[1], 'crash\\n'); console.error('seat crashed'); process.exit(7);",
              crashes,
            ],
          },
        ],
      }),
    );
    const server = Bun.spawn(
      [
        "bun",
        "src/cli.ts",
        "runner",
        "serve",
        "--socket",
        socket,
        "--state-dir",
        f.privateDir,
        "--worker-root",
        f.worker,
        "--run-id",
        "toy-run",
        "--admin-token-file",
        adminTokenFile,
        "--seat-config",
        seatConfig,
      ],
      { cwd: root, env: { ...process.env, AK_RUNNER_WORKER_TOKEN: workerToken }, stdout: "pipe", stderr: "pipe" },
    );
    try {
      await waitForPath(socket, server);
      const request = join(f.privateDir, "request.json");
      const call = (verb: string, token: string, args: RunnerArgs) => {
        writeFileSync(request, JSON.stringify(args));
        return callRunnerCli(verb, request, socket, token, CONTENDED_RUNNER_CALL_TIMEOUT_MS);
      };
      const run = { run: "toy-run" };
      expect(
        call("start", adminToken, {
          ...run,
          charter: f.path,
          implementer: "implementer-1",
          revision: f.revision,
          standing_grant: standing(f),
        }).exitCode,
      ).toBe(0);
      const receipt = join(f.privateDir, "receipt.txt");
      writeFileSync(receipt, "trusted test output");
      expect(
        call("collect", adminToken, { ...run, id: "e1", source: receipt, revision: f.revision, kind: "source" })
          .exitCode,
      ).toBe(0);
      const prepared = call("prepare", workerToken, {
        ...run,
        card: {
          id: "align",
          operation: "align.run",
          grant: { charter_hash: f.charter.immutability.hash, covers: "align-answer" },
          question: "Proceed?",
          options: ["yes", "no"],
          approve: "yes",
          evidence: ["e1"],
          artifact_hash: `sha256:${"b".repeat(64)}`,
        },
      });
      expect(prepared.exitCode).toBe(0);
      const decided = call("decide", workerToken, { ...run, card_id: "align" });
      expect(decided.exitCode).toBe(0);
      const refusal: unknown = JSON.parse(decided.stdout.toString());
      expect(refusal).toMatchObject({
        status: "needs-input",
        escalation: { charter_rule: "runner:seat-independence" },
      });
      expect(JSON.stringify(refusal)).toContain("seat seat-b: launcher exited 7: seat crashed");
      const ruling = {
        ...run,
        card_id: "align",
        choice: "yes",
        actor: "captain",
        rationale: "Seat b crashed; seat a's reading stands.",
      };
      expect(call("answer", workerToken, ruling).exitCode).toBe(1);
      expect(call("answer", adminToken, ruling).exitCode).toBe(0);
      const replayed = call("decide", workerToken, { ...run, card_id: "align" });
      expect(JSON.parse(replayed.stdout.toString())).toEqual({
        operation: "align.run",
        status: "complete",
        next_permitted_action: "bound.run",
      });
      expect(readFileSync(crashes, "utf8")).toBe("crash\n");
      const status: unknown = JSON.parse(call("status", workerToken, run).stdout.toString());
      expect(status).toMatchObject({
        run_state: "alignment",
        next_permitted_action: "bound.run",
        open_escalation: null,
      });
      const ledger: unknown = JSON.parse(call("ledger", workerToken, run).stdout.toString());
      expect(ledger).toMatchObject({
        entries: [{ answered: true, answer: { choice: "yes", by: "captain", rationale: ruling.rationale } }],
      });
      const cancellation = { ...run, actor: "captain", rationale: "Stop the run." };
      expect(call("cancel", workerToken, cancellation).exitCode).toBe(1);
      expect(call("cancel", adminToken, cancellation).exitCode).toBe(0);
      const stopped: unknown = JSON.parse(call("status", workerToken, run).stdout.toString());
      expect(stopped).toMatchObject({ run_state: "cancelled", next_permitted_action: null });
      transcript.push(
        "Seat launcher exit 7 → `decide` returned `needs-input` carrying the launcher error; worker `answer` refused (exit 1); supervisor `answer` `yes` settled the card, advanced the run to `bound.run` and was ledgered; a replayed `decide` returned the ruling without relaunching seats.",
      );
    } finally {
      server.kill();
      await server.exited;
    }
  }, 300_000);

  test("runner evidence cannot land in a linked worktree's shared git common directory", () => {
    const f = fixture();
    const linked = join(f.dir, "linked");
    const added = Bun.spawnSync(["git", "-C", f.worker, "worktree", "add", "-q", "-b", "linked-branch", linked]);
    expect(added.exitCode).toBe(0);
    const sharedEvidence = join(f.worker, ".git", "agent-kit", "evidence");
    expect(() => new Runner(sharedEvidence, linked, root)).toThrow("shared git common directory");
    expect(existsSync(sharedEvidence)).toBe(false);
    transcript.push(
      "Refusal: runner evidence path under a linked worktree's shared git common directory → rejected before directory creation.",
    );
  });

  test("a symlink cannot redirect the runner evidence backend into worker scope", () => {
    const dir = mkdtempSync(join(tmpdir(), "ak-runner-link-"));
    const worker = join(dir, "worker");
    const state = join(dir, "private");
    mkdirSync(worker);
    mkdirSync(state);
    symlinkSync(worker, join(state, "evidence"));
    expect(() => new Runner(state, worker, root)).toThrow("evidence store escapes");
  });
});
