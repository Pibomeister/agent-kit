import { afterAll, afterEach, describe, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { spawnSync as nodeSpawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  watch,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";

import { assert as fcAssert, constantFrom, property, subarray, tuple } from "fast-check";

import { runCli } from "../../src/cli.ts";
import { runRunner } from "../../src/runner/cli.ts";
import { Runner } from "../../src/runner/core.ts";
import { workerControlledPath } from "../../src/runner/path.ts";
import {
  ciConfigDrift,
  cleanCommittedTree,
  isolatedGitArgv,
  mergeTreeClean,
  patchIdentity,
  resolveRunnerGit,
} from "../../src/runner/snapshot.ts";
import { readAdminToken } from "../../src/runner/token.ts";
import type { Run, StandingGrant } from "../../src/runner/types.ts";
import { isAutonomyStatus, type RunnerArgs } from "../../src/runner/wire.ts";
import { preflightStock } from "../../src/firstmate/stock.ts";
import { openRun, takeSnapshot } from "../../src/lifecycle/gate.ts";
import { asJsonObject, classifyRun, RUN_SCHEMA_VERSION, type JsonObject } from "../../src/lifecycle/behavior-policy.ts";
import { charterAllowsProtectedStart } from "../../src/lifecycle/protected-start.ts";
import { artifactHash } from "../../src/util/hash.ts";
import { checkDocument, indexDocuments } from "../../src/validation/docrules.ts";
import { parseJson } from "../helpers/json.ts";
import { processScratch } from "../helpers/process-tmp.ts";

// Most tests drive git, the live runner service and separate seat processes. Under heavy host load
// any ordinary case can pass 30s, and which one does varies run to run, so the default bound is a
// hang detector rather than a speed check. The multi-command live-service tests declare larger bounds.
setDefaultTimeout(120_000);

const root = join(import.meta.dir, "..", "..");
const RUNNER_CALL_TIMEOUT_MS = 25_000;
const CONTENDED_RUNNER_CALL_TIMEOUT_MS = 120_000;
/** The charter-bound live smoke's bound, as for the other live-service tests, and the waits inside it. */
const LIVE_SMOKE_TIMEOUT_MS = 300_000;
const LIVE_SMOKE_WAIT_MS = 60_000;
type LiveChild = ReturnType<typeof spawnLive>;
const runnerCallChildren = new Set<LiveChild>();
const liveChildren = new Set<LiveChild>();

function spawnLive(
  cmd: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; stdout?: "pipe"; stderr?: "pipe" },
) {
  const child = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", ...options });
  liveChildren.add(child);
  void child.exited.finally(() => liveChildren.delete(child));
  return child;
}

/** Hang until killed, argv[3] (the test runner) exits, or 120s pass. Immediate ppid is not watched. Writes argv[2] atomically. */
const HANG_UNTIL_REAPED = `const fs = require("node:fs");
const pidFile = process.argv[2];
const keeper = Number(process.argv[3]);
const deadline = Date.now() + 120000;
const tmp = pidFile + "." + process.pid;
fs.writeFileSync(tmp, String(process.pid));
fs.renameSync(tmp, pidFile);
setInterval(function () {
  if (Date.now() > deadline) process.exit(0);
  try {
    process.kill(keeper, 0);
  } catch {
    process.exit(0);
  }
}, 200);
`;

function writeHangHelper(dir: string): string {
  const script = join(dir, "hang-until-reaped.js");
  writeFileSync(script, HANG_UNTIL_REAPED);
  return script;
}

function shQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function readLivePid(pidFile: string): number {
  const pid = Number(readFileSync(pidFile, "utf8").trim());
  expect(Number.isInteger(pid) && pid > 0).toBe(true);
  expect(() => process.kill(pid, 0)).not.toThrow();
  return pid;
}

// Bun lists every directory above its cwd when it starts, and the live service starts each consumer,
// launcher and verifier in its state directory. A crowded macOS $TMPDIR makes each start there cost
// about a second, so fixtures live under a private root that this file removes when it ends.
const scratchRoot = processScratch("ak-runner-test-");
afterAll(() => rmSync(scratchRoot, { recursive: true, force: true }));

function callRunnerCli(
  verb: string,
  request: string,
  socket: string,
  token: string,
  timeoutMs = RUNNER_CALL_TIMEOUT_MS,
) {
  const child = nodeSpawnSync(
    process.execPath,
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

function autonomyOf(response: ReturnType<typeof callRunnerCli>) {
  const value: unknown = JSON.parse(response.stdout.toString());
  if (!isAutonomyStatus(value)) throw new Error("runner status has no autonomy mode");
  return value.autonomy;
}

function spawnRunnerCli(
  verb: string,
  request: string,
  socket: string,
  token: string,
  timeoutMs = RUNNER_CALL_TIMEOUT_MS,
) {
  const child = spawnLive(
    [process.execPath, join(root, "src", "cli.ts"), "runner", "call", verb, "--json", request, "--socket", socket],
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

async function reapLive(signal: NodeJS.Signals) {
  for (const child of liveChildren) {
    try {
      child.kill(signal);
    } catch {
      // already gone
    }
  }
  const waited = [...liveChildren].map((child) =>
    Promise.race([
      child.exited,
      Bun.sleep(2_000).then(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // already gone
        }
        return child.exited;
      }),
    ]),
  );
  await Promise.allSettled(waited);
  liveChildren.clear();
}

afterEach(async () => {
  for (const child of runnerCallChildren) child.kill("SIGKILL");
  await Promise.allSettled([...runnerCallChildren].map((child) => child.exited));
  runnerCallChildren.clear();
  // SIGTERM so `ak runner serve` can killGroup its detached seats; SIGKILL skips that handler.
  await reapLive("SIGTERM");
});
afterAll(async () => {
  await reapLive("SIGTERM");
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
  const result = gitProc(cwd, args);
  if (result.exitCode !== 0) {
    throw new Error(
      `git ${args.join(" ")} exited ${result.exitCode}\nstdout:\n${result.stdout.toString()}\nstderr:\n${result.stderr.toString()}`,
    );
  }
}

function gitProc(cwd: string, args: readonly string[], stdin?: string) {
  return Bun.spawnSync(
    [
      "git",
      "-C",
      cwd,
      "-c",
      "user.name=Toy",
      "-c",
      "user.email=toy@example.invalid",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    stdin === undefined ? {} : { stdin: Buffer.from(stdin) },
  );
}

function gitText(cwd: string, args: readonly string[], stdin?: string): string {
  const result = gitProc(cwd, args, stdin);
  expect(result.exitCode).toBe(0);
  return result.stdout.toString().trim();
}

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
    watcher.once("error", settle);
    void owner.exited.then(
      (code) => settle(existsSync(path) ? undefined : new Error(`process exited ${code} before creating ${path}`)),
      (cause) => settle(cause instanceof Error ? cause : new Error(String(cause))),
    );
    if (existsSync(path)) settle();
  });
}

async function waitUntil(what: string, holds: () => boolean, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!holds()) {
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
    await Bun.sleep(10);
  }
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

const WORKER_TEMPLATE = (() => {
  const worker = mkdtempSync(join(scratchRoot, "ak-runner-seed-"));
  writeFileSync(join(worker, ".gitignore"), ".runner-requests/\n");
  writeFileSync(join(worker, "README.md"), "toy worktree\n");
  git(worker, "init", "-q", "-b", "main");
  git(worker, "add", ".");
  git(worker, "commit", "-qm", "Create toy charter worktree");
  const revision = workerHead(worker);
  mkdirSync(join(worker, ".runner-requests"));
  return { worker, revision };
})();

const FEATURE_WORKER_TEMPLATE = (() => {
  const worker = mkdtempSync(join(scratchRoot, "ak-runner-feature-seed-"));
  cpSync(WORKER_TEMPLATE.worker, worker, { recursive: true });
  git(worker, "branch", "-M", "main");
  git(worker, "checkout", "-qb", "feature");
  writeFileSync(join(worker, "feature.txt"), "feature\n");
  git(worker, "add", "feature.txt");
  git(worker, "commit", "-qm", "add feature");
  const revision = workerHead(worker);
  return { worker, revision };
})();

function fixture(limit = 3, template = WORKER_TEMPLATE) {
  const dir = mkdtempSync(join(scratchRoot, "ak-runner-"));
  const worker = join(dir, "worker");
  const privateDir = join(dir, "private");
  cpSync(template.worker, worker, { recursive: true });
  mkdirSync(privateDir);
  const { revision } = template;
  const requestDir = join(worker, ".runner-requests");
  const path = join(privateDir, "charter.json");
  const toyTicket = {
    schema: "ticket",
    schema_version: 1,
    id: "toy-ticket",
    project: { id: "toy" },
    acceptance_criteria: [{ id: "AC-1", text: "Toy work is done." }],
    verification: [{ id: "project-check", check: "Run the project check.", kind: "command", supports: ["AC-1"] }],
    approvals: [{ role: "human", approved_at: "2026-10-01T00:00:00Z" }],
  };
  writeFileSync(join(privateDir, "toy-ticket.json"), JSON.stringify(toyTicket));
  const initialCharter = {
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
    work_source: { kind: "ticket", ref: { id: "toy-ticket", schema: "ticket", hash: artifactHash(toyTicket) } },
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
  const charter: typeof initialCharter & {
    audit_cadence_seconds?: number;
    limits: { delegate_replacements?: number; outage_backoff_seconds?: number };
  } = initialCharter;
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

const TOY_BINDING = "backend: local-git\nproject: toy\nlocator:\n  knowledgebase: fixture-kb\n";
const OTHER_BINDING = "backend: local-git\nproject: other\nlocator:\n  knowledgebase: other-kb\n";
const IN_REPO_BINDING = `backend: in-repo
project: toy
locator:
  knowledgebase: fixture-kb
  path: wiki
  kinds:
    adr: adr
`;

function enabledToyTicket(parsed: JsonObject): JsonObject {
  const HASH = `sha256:${"a".repeat(64)}`;
  return {
    ...parsed,
    acceptance_criteria: [{ id: "AC-1", text: "The behavior is verified.", surface: "none" }],
    verification: [
      {
        id: "project-check",
        check: "Run the project check.",
        kind: "command",
        supports: ["AC-1"],
        behavior: {
          evidence_layer: "implementation",
          property_ids: ["every-configured-directory-is-read"],
          property_types: { "every-configured-directory-is-read": "safety" },
          contract: { id: "example-behavior-contract-1", schema: "behavior-contract", hash: HASH },
        },
      },
    ],
  };
}

function freezeRejectingToyTicket(parsed: JsonObject): JsonObject {
  const enabled = enabledToyTicket(parsed);
  const verification = Array.isArray(enabled.verification) ? [...enabled.verification] : [];
  verification.push({
    id: "broken-check",
    check: "A freezeCheck reject.",
    kind: "command",
    supports: ["AC-1"],
    behavior: { evidence_layer: "implementation" },
  });
  return { ...enabled, verification };
}

function rewordedCheckToyTicket(parsed: JsonObject): JsonObject {
  const enabled = enabledToyTicket(parsed);
  const first = Array.isArray(enabled.verification) ? enabled.verification[0] : undefined;
  if (!asJsonObject(first) || !asJsonObject(first.behavior)) throw new Error("enabled ticket has no check");
  return {
    ...enabled,
    verification: [
      {
        ...first,
        check: "Run the project check with a different freeze.",
        behavior: first.behavior,
      },
    ],
  };
}

function publishToyKb(ticket: JsonObject, mode: "off" | "shadow" | "on") {
  const scratch = processScratch("ak-bv-runner-kb-");
  const kb = join(scratch, "kb");
  mkdirSync(join(kb, "projects", "toy", "runs"), { recursive: true });
  git(kb, "init", "-q", "-b", "main");
  const parsedProject: unknown = JSON.parse(readFileSync(join(root, "templates/project.example.json"), "utf8"));
  if (!asJsonObject(parsedProject)) throw new Error("project example is not an object");
  const project: JsonObject = parsedProject;
  const identity = asJsonObject(project.identity) ? project.identity : {};
  project.identity = { ...identity, id: "toy" };
  project.review = { behavior: mode };
  const projectHash = artifactHash(project);
  const ticketHash = artifactHash(ticket);
  writeFileSync(
    join(kb, "projects", "toy", "runs", "artifacts.jsonl"),
    `${JSON.stringify({
      record: {
        ref: "run:bootstrap/project/toy",
        content_hash: projectHash,
        idempotency_key: projectHash,
        links: [],
      },
      artifact: project,
    })}\n${JSON.stringify({
      record: {
        ref: "run:bootstrap/ticket/toy-ticket",
        content_hash: ticketHash,
        idempotency_key: ticketHash,
        links: [],
      },
      artifact: ticket,
    })}\n`,
  );
  git(kb, "add", "-A");
  git(kb, "commit", "-qm", "project-and-ticket");
  const registry = join(scratch, "registry.json");
  writeFileSync(registry, JSON.stringify({ knowledgebases: { "fixture-kb": { path: kb } } }));
  return { registry, kb };
}

function projectOnlyJsonl(kb: string): string {
  const jsonl = readFileSync(join(kb, "projects", "toy", "runs", "artifacts.jsonl"), "utf8");
  const projectLine = jsonl
    .split("\n")
    .find((line) => line.includes('"schema":"project"') || line.includes('"schema": "project"'));
  if (projectLine === undefined) throw new Error("published kb has no project record");
  return `${projectLine}\n`;
}

function artifactsJsonl(kb: string): string {
  return readFileSync(join(kb, "projects", "toy", "runs", "artifacts.jsonl"), "utf8");
}

function commitInRepoKb(worker: string, jsonl: string | null, message: string) {
  mkdirSync(join(worker, "wiki", "adr"), { recursive: true });
  writeFileSync(join(worker, "wiki", "adr", ".gitkeep"), "");
  writeFileSync(join(worker, "ak.kb.yaml"), IN_REPO_BINDING);
  const artifacts = join(worker, "projects", "toy", "runs", "artifacts.jsonl");
  if (jsonl === null) {
    if (existsSync(artifacts)) unlinkSync(artifacts);
  } else {
    mkdirSync(join(worker, "projects", "toy", "runs"), { recursive: true });
    writeFileSync(artifacts, jsonl);
  }
  git(worker, "add", "-A");
  git(worker, "commit", "-qm", message);
  const sha = workerHead(worker);
  git(worker, "update-ref", "refs/remotes/origin/main", sha);
  git(worker, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  return sha;
}

function forkFeatureFromOlderKb(f: ReturnType<typeof fixture>, atO: string | null, atT: string) {
  git(f.worker, "checkout", "main");
  commitInRepoKb(f.worker, atO, "kb at O");
  git(f.worker, "checkout", "feature");
  git(f.worker, "merge", "-q", "-m", "take O", "main");
  git(f.worker, "checkout", "main");
  commitInRepoKb(f.worker, atT, "kb at T");
  git(f.worker, "checkout", "feature");
  git(f.worker, "commit", "--allow-empty", "-qm", "worker");
}

function unlinkStoreTicket(f: ReturnType<typeof fixture>, ticket: JsonObject) {
  unlinkSync(join(f.privateDir, "toy-ticket.json"));
  retargetCharterTicket(f, ticket);
  unlinkSync(join(f.privateDir, "toy-ticket.json"));
}

function retargetCharterTicket(f: ReturnType<typeof fixture>, ticket: JsonObject) {
  writeFileSync(join(f.privateDir, "toy-ticket.json"), JSON.stringify(ticket));
  f.charter.work_source = { kind: "ticket", ref: { id: "toy-ticket", schema: "ticket", hash: artifactHash(ticket) } };
  f.charter.immutability.hash = artifactHash({ ...f.charter, immutability: { ...f.charter.immutability, hash: "" } });
  const approval = f.charter.approvals[0];
  if (approval === undefined) throw new Error("toy charter approval missing");
  approval.artifact_hash = f.charter.immutability.hash;
  writeFileSync(f.path, JSON.stringify(f.charter));
}

function workerHead(worker: string): string {
  const parsed = Bun.spawnSync(["git", "-C", worker, "rev-parse", "HEAD"]);
  expect(parsed.exitCode).toBe(0);
  return parsed.stdout.toString().trim();
}

function withRegistry<T>(registry: string, body: () => T): T {
  const previous = process.env.AK_KB_REGISTRY;
  process.env.AK_KB_REGISTRY = registry;
  try {
    return body();
  } finally {
    if (previous === undefined) delete process.env.AK_KB_REGISTRY;
    else process.env.AK_KB_REGISTRY = previous;
  }
}

function serveLoop(
  f: ReturnType<typeof fixture>,
  script: string,
  stamp: string,
  clockFile?: string,
  kitRoot?: string,
  extraLoopArgs: string[] = [],
) {
  const socket = join(f.privateDir, "runner.sock");
  const eventConfig = join(f.privateDir, "event.json");
  const loopConfig = join(f.privateDir, "loop.json");
  const tokenFile = join(f.privateDir, "admin.token");
  const workerToken = "b".repeat(48);
  writeFileSync(tokenFile, "a".repeat(48), { mode: 0o600 });
  writeFileSync(
    eventConfig,
    JSON.stringify({
      timeout_ms: 10_000,
      command: [
        "bun",
        "-e",
        "const e=JSON.parse(await Bun.stdin.text()); console.log(JSON.stringify({run:e.run,key:e.key}));",
      ],
    }),
  );
  writeFileSync(
    loopConfig,
    JSON.stringify({ timeout_ms: 10_000, command: ["bun", "-e", script, stamp, ...extraLoopArgs] }),
  );
  const env: NodeJS.ProcessEnv = { ...process.env, AK_RUNNER_WORKER_TOKEN: workerToken };
  delete env["AK_RUNNER_CLOCK"];
  const argv = [
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
    tokenFile,
    "--event-config",
    eventConfig,
    "--loop-config",
    loopConfig,
  ];
  if (clockFile !== undefined) {
    argv.push("--clock", clockFile);
  }
  if (kitRoot !== undefined) {
    argv.push("--kit-root", kitRoot);
  }
  const service = spawnLive(argv, { cwd: root, env, stdout: "pipe", stderr: "pipe" });
  return { socket, service, workerToken, request: join(f.requestDir, "audit.json") };
}

function serveEvents(
  f: ReturnType<typeof fixture>,
  clock: string,
  eventCommand: string[],
  timeoutMs = 100,
  loopCommand?: string[],
) {
  const socket = join(f.privateDir, "runner.sock");
  const eventConfig = join(f.privateDir, "event.json");
  const loopConfig = join(f.privateDir, "loop.json");
  const tokenFile = join(f.privateDir, "admin.token");
  const adminToken = "a".repeat(48);
  const workerToken = "b".repeat(48);
  writeFileSync(tokenFile, adminToken, { mode: 0o600 });
  writeFileSync(eventConfig, JSON.stringify({ timeout_ms: timeoutMs, command: eventCommand }));
  writeFileSync(
    loopConfig,
    JSON.stringify({
      timeout_ms: 1000,
      command: loopCommand ?? [
        process.execPath,
        "-e",
        "const x=JSON.parse(await Bun.stdin.text()); console.log(JSON.stringify({probed:x.delegates,progress:[]}));",
      ],
    }),
  );
  const env: NodeJS.ProcessEnv = { ...process.env, AK_RUNNER_WORKER_TOKEN: workerToken };
  delete env["AK_RUNNER_CLOCK"];
  const service = spawnLive(
    [
      process.execPath,
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
      tokenFile,
      "--event-config",
      eventConfig,
      "--loop-config",
      loopConfig,
      "--clock",
      clock,
    ],
    { cwd: root, env, stdout: "pipe", stderr: "pipe" },
  );
  return { socket, service, adminToken, workerToken, request: join(f.requestDir, "event.json") };
}

function withAuditCadence(f: ReturnType<typeof fixture>, delegateReplacements?: number, outageBackoffSeconds?: number) {
  f.charter.audit_cadence_seconds = 1;
  if (delegateReplacements !== undefined) f.charter.limits.delegate_replacements = delegateReplacements;
  if (outageBackoffSeconds !== undefined) f.charter.limits.outage_backoff_seconds = outageBackoffSeconds;
  f.charter.immutability.hash = artifactHash({ ...f.charter, immutability: { ...f.charter.immutability, hash: "" } });
  const approval = f.charter.approvals[0];
  if (approval === undefined) throw new Error("toy charter approval missing");
  approval.artifact_hash = f.charter.immutability.hash;
  writeFileSync(f.path, JSON.stringify(f.charter));
}

function copyKit(): string {
  const kit = mkdtempSync(join(scratchRoot, "ak-kit-"));
  cpSync(join(root, "schemas"), join(kit, "schemas"), { recursive: true });
  mkdirSync(join(kit, "policies"), { recursive: true });
  cpSync(join(root, "policies/invocation.yaml"), join(kit, "policies/invocation.yaml"));
  cpSync(join(root, "package.json"), join(kit, "package.json"));
  cpSync(join(root, "skills/autopilot"), join(kit, "skills/autopilot"), { recursive: true });
  return kit;
}

function procedureKit() {
  const kit = copyKit();
  const f = fixture();
  withAuditCadence(f);
  return { ...f, kit, runner: new Runner(f.privateDir, f.worker, kit) };
}

function upgradeProcedure(kit: string, change: { skill?: boolean; version?: boolean } = {}) {
  const skillPath = join(kit, "skills/autopilot/SKILL.md");
  const originalSkill = readFileSync(skillPath, "utf8");
  if (change.skill !== false) writeFileSync(skillPath, `${originalSkill}\n# upgraded procedure\n`);
  const manifestPath = join(kit, "package.json");
  const originalManifest = readFileSync(manifestPath, "utf8");
  if (!/"version"\s*:\s*"[^"]+"/.test(originalManifest)) throw new Error("copied kit has no package version");
  if (change.version !== false) {
    writeFileSync(manifestPath, originalManifest.replace(/("version"\s*:\s*")([^"]+)/, "$1$2-upgraded"));
  }
  return { skillPath, originalSkill, manifestPath, originalManifest };
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

function patchVerdictFixture(autonomous = false, ship = true, setup?: (worker: string) => void) {
  const f = fixture(3, FEATURE_WORKER_TEMPLATE);
  if (setup !== undefined) {
    setup(f.worker);
    f.revision = Bun.spawnSync(["git", "-C", f.worker, "rev-parse", "HEAD"]).stdout.toString().trim();
  }
  if (autonomous) withAuditCadence(f);
  f.runner.start("toy-run", f.path, "implementer-1", f.revision, standing(f));
  const receipt = join(f.privateDir, "source.txt");
  writeFileSync(receipt, "source evidence");
  f.runner.collect("toy-run", "e1", receipt, f.revision, "source");
  reachShipReady(f, ship);
  return f;
}

function trunkCommit(f: ReturnType<typeof patchVerdictFixture>, path: string, text: string) {
  git(f.worker, "checkout", "main");
  mkdirSync(dirname(join(f.worker, path)), { recursive: true });
  writeFileSync(join(f.worker, path), text);
  git(f.worker, "add", path);
  git(f.worker, "commit", "-qm", `trunk changes ${path}`);
  git(f.worker, "checkout", "feature");
}

function conflictingReadme(worker: string) {
  writeFileSync(join(worker, "README.md"), "feature\n");
  git(worker, "add", "README.md");
  git(worker, "commit", "-qm", "feature readme");
  git(worker, "checkout", "main");
  writeFileSync(join(worker, "README.md"), "main\n");
  git(worker, "add", "README.md");
  git(worker, "commit", "-qm", "main readme");
  git(worker, "checkout", "feature");
}

function commitOnMergeBaseThenDiverge(
  worker: string,
  baseFiles: Record<string, string>,
  featureFiles: Record<string, string>,
  mainFiles: Record<string, string>,
) {
  git(worker, "checkout", "main");
  for (const [path, text] of Object.entries(baseFiles)) {
    writeFileSync(join(worker, path), text);
    git(worker, "add", path);
  }
  git(worker, "commit", "-qm", "merge-base attrs");
  git(worker, "checkout", "feature");
  git(worker, "merge", "--no-edit", "-q", "main");
  for (const [path, text] of Object.entries(featureFiles)) {
    writeFileSync(join(worker, path), text);
    git(worker, "add", path);
  }
  git(worker, "commit", "-qm", "feature side");
  git(worker, "checkout", "main");
  for (const [path, text] of Object.entries(mainFiles)) {
    writeFileSync(join(worker, path), text);
    git(worker, "add", path);
  }
  git(worker, "commit", "-qm", "main side");
  git(worker, "checkout", "feature");
}

function gitSupportsObjectFormat(format: string): boolean {
  const dir = mkdtempSync(join(scratchRoot, `ak-${format}-probe-`));
  const result = Bun.spawnSync(["git", "init", "-q", `--object-format=${format}`, dir]);
  rmSync(dir, { recursive: true, force: true });
  return result.exitCode === 0;
}

const SHA256_SUPPORTED = gitSupportsObjectFormat("sha256");

function shipCard(f: ReturnType<typeof patchVerdictFixture>) {
  return f.runner.prepare("toy-run", {
    id: "ship",
    operation: "ship.prepare",
    grant: { charter_hash: f.charter.immutability.hash, covers: "ship-pr" },
    question: "Open the pull request?",
    options: ["yes", "no"],
    approve: "yes",
    evidence: ["verify"],
    artifact_hash: `sha256:${"b".repeat(64)}`,
  });
}

describe("runner guards", () => {
  // This checks the test harness, not the product: `src/runner/cli.ts` call() sets no client timeout,
  // and the kill below comes from callRunnerCli's own spawn timeout. It keeps a hung service from
  // wedging this suite. A client-side timeout in call() would be a separate feature with its own test.
  test("callRunnerCli kills a call that outlives timeoutMs when the service is silent", async () => {
    const f = fixture();
    const socket = join(f.privateDir, "silent.sock");
    const request = join(f.requestDir, "silent.json");
    writeFileSync(request, JSON.stringify({ run: "toy-run" }));
    const silent = spawnLive(
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
    const hang = writeHangHelper(f.privateDir);
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
          command: ["node", hang, launcherPid, String(process.pid)],
        })),
      }),
    );
    const server = spawnLive(
      [
        process.execPath,
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
    // Nothing else reads either process's stderr, so an early exit would otherwise name only its exit code.
    const awaitPath = async (path: string, owner: { exited: Promise<number> }) => {
      try {
        await waitForPath(path, owner);
      } catch (cause) {
        const pending = decision;
        const serverState = server.exitCode === null ? "was still running" : `exited ${server.exitCode}`;
        pending?.kill("SIGKILL");
        server.kill("SIGTERM");
        const [[decided], serverErr, decisionErr] = await Promise.all([
          Promise.allSettled(pending === undefined ? [] : [pending.exited]),
          new Response(server.stderr).text(),
          pending === undefined ? "" : new Response(pending.stderr).text(),
        ]);
        const decide =
          decided === undefined
            ? "decide was not started"
            : `decide ${decided.status === "fulfilled" ? `exited ${decided.value}` : String(decided.reason)}: ${decisionErr.trim()}`;
        const reason = cause instanceof Error ? cause.message : String(cause);
        throw new Error(`${reason}; ${decide}; server ${serverState}: ${serverErr.trim()}`, { cause });
      }
    };
    try {
      await awaitPath(socket, server);
      const request = join(f.requestDir, "request.json");
      writeFileSync(request, JSON.stringify({ run: "toy-run", card_id: "align" }));
      decision = spawnRunnerCli("decide", request, socket, workerToken, CONTENDED_RUNNER_CALL_TIMEOUT_MS);
      await awaitPath(launcherPid, decision);
      const pid = readLivePid(launcherPid);
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
    ).toThrow("standing grant is absent, forged or unbound to the approved charter");
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
    ).toThrow("standing grant is absent, forged or unbound to the approved charter");
    const g = fixture();
    g.charter.allowed_capabilities = ["repository-read"];
    g.charter.immutability.hash = artifactHash({ ...g.charter, immutability: { ...g.charter.immutability, hash: "" } });
    const gApproval = g.charter.approvals[0];
    if (gApproval === undefined) throw new Error("toy charter approval missing");
    gApproval.artifact_hash = g.charter.immutability.hash;
    writeFileSync(g.path, JSON.stringify(g.charter));
    expect(() => g.runner.start("toy-run", g.path, "implementer-1", g.revision, standing(g))).toThrow(
      "standing start requires charter-approved runner grants, trusted evidence and independent context",
    );
    transcript.push(
      "Refusal: Firstmate start with a forged standing-grant hash, no standing entry or missing runner capabilities → no run created.",
    );
  });

  test("standing start permits a guided charter without event delivery", () => {
    const f = fixture();
    f.charter.allowed_capabilities = f.charter.allowed_capabilities.filter(
      (capability) => capability !== "event-delivery",
    );
    f.charter.immutability.hash = artifactHash({ ...f.charter, immutability: { ...f.charter.immutability, hash: "" } });
    const approval = f.charter.approvals[0];
    if (approval === undefined) throw new Error("toy charter approval missing");
    approval.artifact_hash = f.charter.immutability.hash;
    writeFileSync(f.path, JSON.stringify(f.charter));
    const started = f.runner.start("toy-run", f.path, "implementer-1", f.revision, standing(f));
    expect(started.run_state).toBe("created");
    expect(started.behavior?.run_id).toBe("toy-run");
    expect(started.behavior?.mode).toBe("off");
    expect(f.runner.status("toy-run").behavior?.binding_hash).toBe(started.behavior?.binding_hash);
  });

  test("start freezes the approved ticket and resume consumes that snapshot", () => {
    const f = fixture();
    const HASH = `sha256:${"a".repeat(64)}`;
    const ticket = {
      schema: "ticket",
      schema_version: 1,
      id: "toy-ticket",
      project: { id: "toy" },
      acceptance_criteria: [{ id: "AC-1", text: "The behavior is verified.", surface: "none" }],
      verification: [
        {
          id: "project-check",
          check: "Run the project check.",
          kind: "command",
          supports: ["AC-1"],
          behavior: {
            evidence_layer: "implementation",
            property_ids: ["every-configured-directory-is-read"],
            property_types: { "every-configured-directory-is-read": "safety" },
            contract: { id: "example-behavior-contract-1", schema: "behavior-contract", hash: HASH },
          },
        },
      ],
      approvals: [{ role: "human", approved_at: "2026-10-01T00:00:00Z" }],
    };
    writeFileSync(join(f.privateDir, "toy-ticket.json"), JSON.stringify(ticket));
    f.charter.work_source = { kind: "ticket", ref: { id: "toy-ticket", schema: "ticket", hash: artifactHash(ticket) } };
    f.charter.immutability.hash = artifactHash({ ...f.charter, immutability: { ...f.charter.immutability, hash: "" } });
    const approval = f.charter.approvals[0];
    if (approval === undefined) throw new Error("toy charter approval missing");
    approval.artifact_hash = f.charter.immutability.hash;
    writeFileSync(f.path, JSON.stringify(f.charter));
    const scratch = processScratch("ak-bv-runner-kb-");
    const kb = join(scratch, "kb");
    mkdirSync(join(kb, "projects", "toy", "runs"), { recursive: true });
    git(kb, "init", "-q", "-b", "main");
    const parsedProject: unknown = JSON.parse(readFileSync(join(root, "templates/project.example.json"), "utf8"));
    if (!asJsonObject(parsedProject)) throw new Error("project example is not an object");
    const project: JsonObject = parsedProject;
    const identity = asJsonObject(project.identity) ? project.identity : {};
    project.identity = { ...identity, id: "toy" };
    project.review = { behavior: "on" };
    const projectHash = artifactHash(project);
    writeFileSync(
      join(kb, "projects", "toy", "runs", "artifacts.jsonl"),
      `${JSON.stringify({
        record: {
          ref: "run:bootstrap/project/toy",
          content_hash: projectHash,
          idempotency_key: projectHash,
          links: [],
        },
        artifact: project,
      })}\n`,
    );
    git(kb, "add", "-A");
    git(kb, "commit", "-qm", "project");
    writeFileSync(
      join(f.worker, "ak.kb.yaml"),
      "backend: local-git\nproject: toy\nlocator:\n  knowledgebase: fixture-kb\n",
    );
    git(f.worker, "add", "ak.kb.yaml");
    git(f.worker, "commit", "-qm", "bind");
    const registry = join(scratch, "registry.json");
    writeFileSync(registry, JSON.stringify({ knowledgebases: { "fixture-kb": { path: kb } } }));
    const previousRegistry = process.env.AK_KB_REGISTRY;
    process.env.AK_KB_REGISTRY = registry;
    try {
      const started = f.runner.start("toy-run", f.path, "implementer-1", workerHead(f.worker), standing(f));
      expect(started.behavior?.mode).toBe("on");
      expect(started.behavior?.required_checks.map((check) => check.id)).toEqual(["project-check"]);
      const resumed = new Runner(f.privateDir, f.worker, root).status("toy-run");
      expect(resumed.behavior?.binding_hash).toBe(started.behavior?.binding_hash);
      expect(resumed.behavior?.required_checks).toEqual(started.behavior?.required_checks);
      expect(resumed.behavior?.mode).toBe("on");
      expect(resumed.behavior?.ticket_hash).toBe(artifactHash(ticket));
      expect(resumed.behavior?.ticket_resolution).toBeUndefined();
      expect(resumed.run_state).toBe("created");
      const classified = classifyRun(
        {
          run_id: "toy-run",
          ticket: { id: "toy-ticket", hash: artifactHash(ticket) },
          opened_at: "2026-09-29T00:00:00Z",
          branch: "feature",
          base: f.revision,
        },
        "toy-run",
        ticket,
      );
      expect(classified.kind).toBe("incomplete");
      expect(classified.kind === "incomplete" ? classified.reason : "").toContain("new enabled run");
      expect(classified.kind === "incomplete" ? classified.reason : "").not.toContain("legacy");
    } finally {
      if (previousRegistry === undefined) delete process.env.AK_KB_REGISTRY;
      else process.env.AK_KB_REGISTRY = previousRegistry;
    }
  });

  test("CLI check refuses after stripping the freeze from a Runner.start store", () => {
    const f = fixture();
    const HASH = `sha256:${"a".repeat(64)}`;
    const ticket = {
      schema: "ticket",
      schema_version: 1,
      id: "toy-ticket",
      project: { id: "toy" },
      acceptance_criteria: [{ id: "AC-1", text: "The behavior is verified.", surface: "none" }],
      verification: [
        {
          id: "project-check",
          check: "Run the project check.",
          kind: "command",
          supports: ["AC-1"],
          behavior: {
            evidence_layer: "implementation",
            property_ids: ["every-configured-directory-is-read"],
            property_types: { "every-configured-directory-is-read": "safety" },
            contract: { id: "example-behavior-contract-1", schema: "behavior-contract", hash: HASH },
          },
        },
      ],
      approvals: [{ role: "human", approved_at: "2026-10-01T00:00:00Z" }],
    };
    writeFileSync(join(f.privateDir, "toy-ticket.json"), JSON.stringify(ticket));
    f.charter.work_source = { kind: "ticket", ref: { id: "toy-ticket", schema: "ticket", hash: artifactHash(ticket) } };
    f.charter.immutability.hash = artifactHash({ ...f.charter, immutability: { ...f.charter.immutability, hash: "" } });
    const approval = f.charter.approvals[0];
    if (approval === undefined) throw new Error("toy charter approval missing");
    approval.artifact_hash = f.charter.immutability.hash;
    writeFileSync(f.path, JSON.stringify(f.charter));
    const scratch = processScratch("ak-bv-runner-cli-strip-");
    const kb = join(scratch, "kb");
    mkdirSync(join(kb, "projects", "toy", "runs"), { recursive: true });
    git(kb, "init", "-q", "-b", "main");
    const parsedProject: unknown = JSON.parse(readFileSync(join(root, "templates/project.example.json"), "utf8"));
    if (!asJsonObject(parsedProject)) throw new Error("project example is not an object");
    const project: JsonObject = parsedProject;
    const identity = asJsonObject(project.identity) ? project.identity : {};
    project.identity = { ...identity, id: "toy" };
    project.review = { behavior: "on" };
    const projectHash = artifactHash(project);
    writeFileSync(
      join(kb, "projects", "toy", "runs", "artifacts.jsonl"),
      `${JSON.stringify({
        record: {
          ref: "run:bootstrap/project/toy",
          content_hash: projectHash,
          idempotency_key: projectHash,
          links: [],
        },
        artifact: project,
      })}\n`,
    );
    git(kb, "add", "-A");
    git(kb, "commit", "-qm", "project");
    writeFileSync(
      join(f.worker, "ak.kb.yaml"),
      "backend: local-git\nproject: toy\nlocator:\n  knowledgebase: fixture-kb\n",
    );
    git(f.worker, "add", "ak.kb.yaml");
    git(f.worker, "commit", "-qm", "bind");
    const registry = join(scratch, "registry.json");
    writeFileSync(registry, JSON.stringify({ knowledgebases: { "fixture-kb": { path: kb } } }));
    const previousRegistry = process.env.AK_KB_REGISTRY;
    process.env.AK_KB_REGISTRY = registry;
    const lifecycle = (...argv: string[]) => {
      const out: string[] = [];
      const err: string[] = [];
      const code = runCli(["lifecycle", ...argv], {
        cwd: f.worker,
        io: { out: (l) => out.push(l), err: (l) => err.push(l) },
      });
      return { code, out: out.join("\n"), err: err.join("\n") };
    };
    try {
      f.runner.start("toy-run", f.path, "implementer-1", workerHead(f.worker), standing(f));
      const evidence = join(f.privateDir, "evidence");
      for (const gate of ["build-checks", "review-full", "review-readiness"] as const)
        expect(lifecycle("record", "--dir", evidence, "--run", "toy-run", "--gate", gate).code).toBe(0);
      const runPath = join(evidence, "runs", "toy-run", "run.json");
      const runDoc: unknown = JSON.parse(readFileSync(runPath, "utf8"));
      if (!asJsonObject(runDoc)) throw new Error("run.json is not an object");
      delete runDoc.behavior;
      delete runDoc.schema_version;
      writeFileSync(runPath, `${JSON.stringify(runDoc, null, 2)}\n`);
      const runnerPath = join(f.privateDir, "toy-run.json");
      const runnerDoc: unknown = JSON.parse(readFileSync(runnerPath, "utf8"));
      if (!asJsonObject(runnerDoc)) throw new Error("runner record is not an object");
      delete runnerDoc.behavior;
      writeFileSync(runnerPath, `${JSON.stringify(runnerDoc, null, 2)}\n`);
      const checked = lifecycle("check", "--dir", evidence, "--run", "toy-run");
      expect(checked.code).toBe(1);
      expect(checked.err).toContain("no protected runner creation record");
      expect(checked.err).not.toContain("legacy");
    } finally {
      if (previousRegistry === undefined) delete process.env.AK_KB_REGISTRY;
      else process.env.AK_KB_REGISTRY = previousRegistry;
    }
  });

  test("a malformed knowledgebase binding fails closed at start", () => {
    const f = fixture();
    writeFileSync(join(f.worker, "ak.kb.yaml"), "this is not: [valid\n");
    git(f.worker, "add", "ak.kb.yaml");
    git(f.worker, "commit", "-qm", "malformed bind");
    expect(() => f.runner.start("toy-run", f.path, "implementer-1", workerHead(f.worker), standing(f))).toThrow(
      "Not valid YAML",
    );
  });

  test("an off charter with a non-ticket work source still starts", () => {
    const f = fixture();
    f.charter.work_source = {
      kind: "plan",
      ref: { id: "toy-plan", schema: "plan-record", hash: `sha256:${"a".repeat(64)}` },
    };
    f.charter.immutability.hash = artifactHash({ ...f.charter, immutability: { ...f.charter.immutability, hash: "" } });
    const approval = f.charter.approvals[0];
    if (approval === undefined) throw new Error("toy charter approval missing");
    approval.artifact_hash = f.charter.immutability.hash;
    writeFileSync(f.path, JSON.stringify(f.charter));
    const started = f.runner.start("toy-run", f.path, "implementer-1", f.revision, standing(f));
    expect(started.behavior?.mode).toBe("off");
    expect(started.behavior?.required_checks).toEqual([]);
  });

  test("verify of a pre-feature run does not fail closed on a missing knowledgebase", () => {
    const f = fixture();
    f.charter.work_source = {
      kind: "plan",
      ref: { id: "toy-plan", schema: "plan-record", hash: `sha256:${"a".repeat(64)}` },
    };
    f.charter.immutability.hash = artifactHash({ ...f.charter, immutability: { ...f.charter.immutability, hash: "" } });
    const approval = f.charter.approvals[0];
    if (approval === undefined) throw new Error("toy charter approval missing");
    approval.artifact_hash = f.charter.immutability.hash;
    writeFileSync(f.path, JSON.stringify(f.charter));
    f.runner.start("toy-run", f.path, "implementer-1", f.revision, standing(f));
    const source = join(f.privateDir, "source.txt");
    writeFileSync(source, "approved source");
    f.runner.collect("toy-run", "e1", source, f.revision, "source");
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
    const path = join(f.privateDir, "toy-run.json");
    const stored: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!asJsonObject(stored)) throw new Error("runner state is not an object");
    delete stored.behavior;
    writeFileSync(path, `${JSON.stringify(stored)}\n`);
    writeFileSync(join(f.worker, "ak.kb.yaml"), "this is not: [valid\n");
    expect(() => new Runner(f.privateDir, f.worker, root).verify("toy-run", "verify")).not.toThrow();
  });

  test("verify keeps a frozen on-mode binding when the worker-writable project file is gone", () => {
    const f = fixture();
    const HASH = `sha256:${"a".repeat(64)}`;
    const ticket = {
      schema: "ticket",
      schema_version: 1,
      id: "toy-ticket",
      project: { id: "toy" },
      acceptance_criteria: [{ id: "AC-1", text: "The behavior is verified.", surface: "none" }],
      verification: [
        {
          id: "project-check",
          check: "Run the project check.",
          kind: "command",
          supports: ["AC-1"],
          behavior: {
            evidence_layer: "implementation",
            property_ids: ["every-configured-directory-is-read"],
            property_types: { "every-configured-directory-is-read": "safety" },
            contract: { id: "example-behavior-contract-1", schema: "behavior-contract", hash: HASH },
          },
        },
      ],
      approvals: [{ role: "human", approved_at: "2026-10-01T00:00:00Z" }],
    };
    writeFileSync(join(f.privateDir, "toy-ticket.json"), JSON.stringify(ticket));
    f.charter.work_source = { kind: "ticket", ref: { id: "toy-ticket", schema: "ticket", hash: artifactHash(ticket) } };
    f.charter.immutability.hash = artifactHash({ ...f.charter, immutability: { ...f.charter.immutability, hash: "" } });
    const approval = f.charter.approvals[0];
    if (approval === undefined) throw new Error("toy charter approval missing");
    approval.artifact_hash = f.charter.immutability.hash;
    writeFileSync(f.path, JSON.stringify(f.charter));
    const scratch = processScratch("ak-bv-runner-verify-kb-");
    const kb = join(scratch, "kb");
    mkdirSync(join(kb, "projects", "toy", "runs"), { recursive: true });
    git(kb, "init", "-q", "-b", "main");
    const parsedProject: unknown = JSON.parse(readFileSync(join(root, "templates/project.example.json"), "utf8"));
    if (!asJsonObject(parsedProject)) throw new Error("project example is not an object");
    const project: JsonObject = parsedProject;
    const identity = asJsonObject(project.identity) ? project.identity : {};
    project.identity = { ...identity, id: "toy" };
    project.review = { behavior: "on" };
    const projectHash = artifactHash(project);
    writeFileSync(
      join(kb, "projects", "toy", "runs", "artifacts.jsonl"),
      `${JSON.stringify({
        record: {
          ref: "run:bootstrap/project/toy",
          content_hash: projectHash,
          idempotency_key: projectHash,
          links: [],
        },
        artifact: project,
      })}\n`,
    );
    git(kb, "add", "-A");
    git(kb, "commit", "-qm", "project");
    writeFileSync(
      join(f.worker, "ak.kb.yaml"),
      "backend: local-git\nproject: toy\nlocator:\n  knowledgebase: fixture-kb\n",
    );
    git(f.worker, "add", "ak.kb.yaml");
    git(f.worker, "commit", "-qm", "bind");
    const registry = join(scratch, "registry.json");
    writeFileSync(registry, JSON.stringify({ knowledgebases: { "fixture-kb": { path: kb } } }));
    const previousRegistry = process.env.AK_KB_REGISTRY;
    process.env.AK_KB_REGISTRY = registry;
    try {
      const revision = workerHead(f.worker);
      f.runner.start("toy-run", f.path, "implementer-1", revision, standing(f));
      const source = join(f.privateDir, "source.txt");
      writeFileSync(source, "approved source");
      f.runner.collect("toy-run", "e1", source, revision, "source");
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
      f.runner.collect("toy-run", "verify", verification, revision, "verify");
      writeFileSync(join(f.worker, "ak.kb.yaml"), "");
      const verified = new Runner(f.privateDir, f.worker, root).verify("toy-run", "verify");
      expect(verified.run_state).toBe("verifying");
      expect(verified.behavior?.required_checks.map((check) => check.id)).toEqual(["project-check"]);
    } finally {
      if (previousRegistry === undefined) delete process.env.AK_KB_REGISTRY;
      else process.env.AK_KB_REGISTRY = previousRegistry;
    }
  });

  test("lifecycle open refuses a Runner.start mandatory freeze; the freeze stays after live KB off", () => {
    const f = fixture();
    const HASH = `sha256:${"a".repeat(64)}`;
    const ticket = {
      schema: "ticket",
      schema_version: 1,
      id: "toy-ticket",
      project: { id: "toy" },
      acceptance_criteria: [{ id: "AC-1", text: "The behavior is verified.", surface: "none" }],
      verification: [
        {
          id: "project-check",
          check: "Run the project check.",
          kind: "command",
          supports: ["AC-1"],
          behavior: {
            evidence_layer: "implementation",
            property_ids: ["every-configured-directory-is-read"],
            property_types: { "every-configured-directory-is-read": "safety" },
            contract: { id: "example-behavior-contract-1", schema: "behavior-contract", hash: HASH },
          },
        },
      ],
      approvals: [{ role: "human", approved_at: "2026-10-01T00:00:00Z" }],
    };
    writeFileSync(join(f.privateDir, "toy-ticket.json"), JSON.stringify(ticket));
    f.charter.work_source = { kind: "ticket", ref: { id: "toy-ticket", schema: "ticket", hash: artifactHash(ticket) } };
    f.charter.immutability.hash = artifactHash({ ...f.charter, immutability: { ...f.charter.immutability, hash: "" } });
    const approval = f.charter.approvals[0];
    if (approval === undefined) throw new Error("toy charter approval missing");
    approval.artifact_hash = f.charter.immutability.hash;
    writeFileSync(f.path, JSON.stringify(f.charter));
    const scratch = processScratch("ak-bv-runner-delegated-kb-");
    const kb = join(scratch, "kb");
    mkdirSync(join(kb, "projects", "toy", "runs"), { recursive: true });
    git(kb, "init", "-q", "-b", "main");
    const parsedProject: unknown = JSON.parse(readFileSync(join(root, "templates/project.example.json"), "utf8"));
    if (!asJsonObject(parsedProject)) throw new Error("project example is not an object");
    const project: JsonObject = parsedProject;
    const identity = asJsonObject(project.identity) ? project.identity : {};
    project.identity = { ...identity, id: "toy" };
    project.review = { behavior: "on" };
    const projectHash = artifactHash(project);
    writeFileSync(
      join(kb, "projects", "toy", "runs", "artifacts.jsonl"),
      `${JSON.stringify({
        record: {
          ref: "run:bootstrap/project/toy",
          content_hash: projectHash,
          idempotency_key: projectHash,
          links: [],
        },
        artifact: project,
      })}\n`,
    );
    git(kb, "add", "-A");
    git(kb, "commit", "-qm", "project");
    writeFileSync(
      join(f.worker, "ak.kb.yaml"),
      "backend: local-git\nproject: toy\nlocator:\n  knowledgebase: fixture-kb\n",
    );
    git(f.worker, "add", "ak.kb.yaml");
    git(f.worker, "commit", "-qm", "bind");
    const registry = join(scratch, "registry.json");
    writeFileSync(registry, JSON.stringify({ knowledgebases: { "fixture-kb": { path: kb } } }));
    const previousRegistry = process.env.AK_KB_REGISTRY;
    process.env.AK_KB_REGISTRY = registry;
    try {
      const started = f.runner.start("toy-run", f.path, "implementer-1", workerHead(f.worker), standing(f));
      expect(started.behavior?.required_checks).toHaveLength(1);
      const weaker = { ...project, review: { behavior: "off" } };
      const weakerHash = artifactHash(weaker);
      writeFileSync(
        join(kb, "projects", "toy", "runs", "artifacts.jsonl"),
        `${JSON.stringify({
          record: { ref: "run:weaken/project/toy", content_hash: weakerHash, idempotency_key: weakerHash, links: [] },
          artifact: weaker,
        })}\n`,
      );
      git(kb, "add", "-A");
      git(kb, "commit", "-qm", "weaken");
      writeFileSync(join(f.worker, "delegated.json"), JSON.stringify(ticket));
      const opened = openRun({
        dir: join(f.privateDir, "evidence"),
        project: f.worker,
        ticket: join(f.worker, "delegated.json"),
        registry,
      });
      expect(opened.ok).toBe(false);
      if (opened.ok) throw new Error("expected mandatory open refusal");
      expect(opened.reason).toContain("cannot cancel those checks");
      const resumed = new Runner(f.privateDir, f.worker, root).status("toy-run");
      expect(resumed.behavior?.mode).toBe("on");
      expect(resumed.behavior?.required_checks).toHaveLength(1);
    } finally {
      if (previousRegistry === undefined) delete process.env.AK_KB_REGISTRY;
      else process.env.AK_KB_REGISTRY = previousRegistry;
    }
  });

  test("ordinary ticket-kind start proceeds without a private ticket file when no project is bound", () => {
    const f = fixture();
    unlinkSync(join(f.privateDir, "toy-ticket.json"));
    const spy = spyOn(process.stderr, "write");
    let started;
    let warning = "";
    try {
      started = f.runner.start("toy-run", f.path, "implementer-1", f.revision, standing(f));
      warning = spy.mock.calls.map((call) => String(call[0])).join("");
    } finally {
      spy.mockRestore();
    }
    expect(warning).toContain("Runner.start: ticket toy-ticket is unresolved");
    expect(started.behavior?.mode).toBe("off");
    expect(started.behavior?.required_checks).toEqual([]);
    expect(started.behavior?.ticket_resolution).toBe("unresolved");
    const later = {
      schema: "ticket",
      id: "toy-ticket",
      acceptance_criteria: [{ id: "AC-1", text: "The behavior is verified.", surface: "none" }],
      verification: [
        {
          id: "project-check",
          check: "Run the project check.",
          supports: ["AC-1"],
          behavior: {
            evidence_layer: "implementation",
            property_ids: ["every-configured-directory-is-read"],
            property_types: { "every-configured-directory-is-read": "safety" },
          },
        },
      ],
    };
    if (!asJsonObject(later)) throw new Error("later ticket is not an object");
    const record: unknown = JSON.parse(
      JSON.stringify({ schema_version: RUN_SCHEMA_VERSION, behavior: started.behavior }),
    );
    if (!asJsonObject(record)) throw new Error("run record is not an object");
    const classified = classifyRun(record, "toy-run", later);
    expect(classified.kind).toBe("incomplete");
    expect(classified.kind === "incomplete" ? classified.reason : "").toContain("not frozen-clean");
  });

  test("ticket-kind start reads a committed KB ticket when the private file is absent", () => {
    const f = fixture();
    const parsed: unknown = JSON.parse(readFileSync(join(f.privateDir, "toy-ticket.json"), "utf8"));
    if (!asJsonObject(parsed)) throw new Error("toy ticket is not an object");
    const ticket = parsed;
    unlinkSync(join(f.privateDir, "toy-ticket.json"));
    const scratch = processScratch("ak-bv-runner-committed-ticket-");
    const kb = join(scratch, "kb");
    mkdirSync(join(kb, "projects", "toy", "runs"), { recursive: true });
    git(kb, "init", "-q", "-b", "main");
    const hash = artifactHash(ticket);
    writeFileSync(
      join(kb, "projects", "toy", "runs", "artifacts.jsonl"),
      `${JSON.stringify({
        record: { ref: "run:bootstrap/ticket/toy-ticket", content_hash: hash, idempotency_key: hash, links: [] },
        artifact: ticket,
      })}\n`,
    );
    git(kb, "add", "-A");
    git(kb, "commit", "-qm", "ticket");
    writeFileSync(
      join(f.worker, "ak.kb.yaml"),
      "backend: local-git\nproject: toy\nlocator:\n  knowledgebase: fixture-kb\n",
    );
    git(f.worker, "add", "ak.kb.yaml");
    git(f.worker, "commit", "-qm", "bind");
    const registry = join(scratch, "registry.json");
    writeFileSync(registry, JSON.stringify({ knowledgebases: { "fixture-kb": { path: kb } } }));
    const previousRegistry = process.env.AK_KB_REGISTRY;
    process.env.AK_KB_REGISTRY = registry;
    try {
      const started = f.runner.start("toy-run", f.path, "implementer-1", workerHead(f.worker), standing(f));
      expect(started.behavior?.mode).toBe("off");
      expect(started.behavior?.ticket_hash).toBe(hash);
    } finally {
      if (previousRegistry === undefined) delete process.env.AK_KB_REGISTRY;
      else process.env.AK_KB_REGISTRY = previousRegistry;
    }
  });

  test("start freezes an on ticket from the knowledgebase after the worker deletes ak.kb.yaml", () => {
    const f = fixture();
    const parsed: unknown = JSON.parse(readFileSync(join(f.privateDir, "toy-ticket.json"), "utf8"));
    if (!asJsonObject(parsed)) throw new Error("toy ticket is not an object");
    const HASH = `sha256:${"a".repeat(64)}`;
    const ticket = {
      ...parsed,
      acceptance_criteria: [{ id: "AC-1", text: "The behavior is verified.", surface: "none" }],
      verification: [
        {
          id: "project-check",
          check: "Run the project check.",
          kind: "command",
          supports: ["AC-1"],
          behavior: {
            evidence_layer: "implementation",
            property_ids: ["every-configured-directory-is-read"],
            property_types: { "every-configured-directory-is-read": "safety" },
            contract: { id: "example-behavior-contract-1", schema: "behavior-contract", hash: HASH },
          },
        },
      ],
    };
    unlinkSync(join(f.privateDir, "toy-ticket.json"));
    f.charter.work_source = { kind: "ticket", ref: { id: "toy-ticket", schema: "ticket", hash: artifactHash(ticket) } };
    f.charter.immutability.hash = artifactHash({ ...f.charter, immutability: { ...f.charter.immutability, hash: "" } });
    const approval = f.charter.approvals[0];
    if (approval === undefined) throw new Error("toy charter approval missing");
    approval.artifact_hash = f.charter.immutability.hash;
    writeFileSync(f.path, JSON.stringify(f.charter));
    const scratch = processScratch("ak-bv-runner-deleted-yaml-");
    const kb = join(scratch, "kb");
    mkdirSync(join(kb, "projects", "toy", "runs"), { recursive: true });
    git(kb, "init", "-q", "-b", "main");
    const parsedProject: unknown = JSON.parse(readFileSync(join(root, "templates/project.example.json"), "utf8"));
    if (!asJsonObject(parsedProject)) throw new Error("project example is not an object");
    const project: JsonObject = parsedProject;
    const identity = asJsonObject(project.identity) ? project.identity : {};
    project.identity = { ...identity, id: "toy" };
    project.review = { behavior: "on" };
    const projectHash = artifactHash(project);
    const ticketHash = artifactHash(ticket);
    writeFileSync(
      join(kb, "projects", "toy", "runs", "artifacts.jsonl"),
      `${JSON.stringify({
        record: {
          ref: "run:bootstrap/project/toy",
          content_hash: projectHash,
          idempotency_key: projectHash,
          links: [],
        },
        artifact: project,
      })}\n${JSON.stringify({
        record: {
          ref: "run:bootstrap/ticket/toy-ticket",
          content_hash: ticketHash,
          idempotency_key: ticketHash,
          links: [],
        },
        artifact: ticket,
      })}\n`,
    );
    git(kb, "add", "-A");
    git(kb, "commit", "-qm", "project-and-ticket");
    writeFileSync(
      join(f.worker, "ak.kb.yaml"),
      "backend: local-git\nproject: toy\nlocator:\n  knowledgebase: fixture-kb\n",
    );
    git(f.worker, "add", "ak.kb.yaml");
    git(f.worker, "commit", "-qm", "bind");
    unlinkSync(join(f.worker, "ak.kb.yaml"));
    const revision = workerHead(f.worker);
    const registry = join(scratch, "registry.json");
    writeFileSync(registry, JSON.stringify({ knowledgebases: { "fixture-kb": { path: kb } } }));
    const previousRegistry = process.env.AK_KB_REGISTRY;
    process.env.AK_KB_REGISTRY = registry;
    try {
      const started = f.runner.start("toy-run", f.path, "implementer-1", revision, standing(f));
      expect(started.behavior?.mode).toBe("on");
      expect(started.behavior?.required_checks).toHaveLength(1);
    } finally {
      if (previousRegistry === undefined) delete process.env.AK_KB_REGISTRY;
      else process.env.AK_KB_REGISTRY = previousRegistry;
    }
  });

  test("an uncommitted ak.kb.yaml retarget is ignored at start", () => {
    const f = fixture();
    const parsed: unknown = JSON.parse(readFileSync(join(f.privateDir, "toy-ticket.json"), "utf8"));
    if (!asJsonObject(parsed)) throw new Error("toy ticket is not an object");
    const ticket = enabledToyTicket(parsed);
    unlinkSync(join(f.privateDir, "toy-ticket.json"));
    retargetCharterTicket(f, ticket);
    const planted = publishToyKb(ticket, "on");
    writeFileSync(join(f.worker, "ak.kb.yaml"), TOY_BINDING);
    git(f.worker, "add", "ak.kb.yaml");
    git(f.worker, "commit", "-qm", "bind");
    writeFileSync(join(f.worker, "ak.kb.yaml"), OTHER_BINDING);
    const revision = workerHead(f.worker);
    const started = withRegistry(planted.registry, () =>
      f.runner.start("toy-run", f.path, "implementer-1", revision, standing(f)),
    );
    expect(started.behavior?.mode).toBe("on");
    expect(started.behavior?.required_checks).toHaveLength(1);
  });

  test("a worker commit that deletes or retargets ak.kb.yaml after start does not change resolution", () => {
    const f = fixture();
    const parsed: unknown = JSON.parse(readFileSync(join(f.privateDir, "toy-ticket.json"), "utf8"));
    if (!asJsonObject(parsed)) throw new Error("toy ticket is not an object");
    const ticket = enabledToyTicket(parsed);
    unlinkSync(join(f.privateDir, "toy-ticket.json"));
    retargetCharterTicket(f, ticket);
    const planted = publishToyKb(ticket, "on");
    writeFileSync(join(f.worker, "ak.kb.yaml"), TOY_BINDING);
    git(f.worker, "add", "ak.kb.yaml");
    git(f.worker, "commit", "-qm", "bind");
    const revision = workerHead(f.worker);
    const started = withRegistry(planted.registry, () =>
      f.runner.start("toy-run", f.path, "implementer-1", revision, standing(f)),
    );
    expect(started.behavior?.mode).toBe("on");
    writeFileSync(join(f.worker, "ak.kb.yaml"), OTHER_BINDING);
    git(f.worker, "add", "ak.kb.yaml");
    git(f.worker, "commit", "-qm", "retarget");
    const resumed = new Runner(f.privateDir, f.worker, root).status("toy-run");
    expect(resumed.behavior?.mode).toBe("on");
    expect(resumed.behavior?.binding_hash).toBe(started.behavior?.binding_hash);
    git(f.worker, "rm", "-q", "ak.kb.yaml");
    git(f.worker, "commit", "-qm", "unbind");
    const afterDelete = new Runner(f.privateDir, f.worker, root).status("toy-run");
    expect(afterDelete.behavior?.mode).toBe("on");
    expect(afterDelete.behavior?.required_checks).toHaveLength(1);
  });

  test("a nested project binding is read from its own folder", () => {
    const f = fixture();
    const parsed: unknown = JSON.parse(readFileSync(join(f.privateDir, "toy-ticket.json"), "utf8"));
    if (!asJsonObject(parsed)) throw new Error("toy ticket is not an object");
    const ticket = enabledToyTicket(parsed);
    unlinkSync(join(f.privateDir, "toy-ticket.json"));
    retargetCharterTicket(f, ticket);
    const planted = publishToyKb(ticket, "on");
    const nested = join(f.worker, "app");
    mkdirSync(nested);
    writeFileSync(join(f.worker, "ak.kb.yaml"), OTHER_BINDING);
    writeFileSync(join(nested, "ak.kb.yaml"), TOY_BINDING);
    writeFileSync(join(nested, "nested.txt"), "nested\n");
    git(f.worker, "add", "ak.kb.yaml", "app");
    git(f.worker, "commit", "-qm", "nested bind");
    const revision = workerHead(nested);
    const runner = new Runner(f.privateDir, nested, root);
    const started = withRegistry(planted.registry, () =>
      runner.start("toy-run", f.path, "implementer-1", revision, standing(f)),
    );
    expect(started.behavior?.mode).toBe("on");
    expect(started.behavior?.required_checks).toHaveLength(1);
  });

  test("a nested start with a planted gitfile still uses the nested binding", () => {
    const f = fixture();
    const parsed: unknown = JSON.parse(readFileSync(join(f.privateDir, "toy-ticket.json"), "utf8"));
    if (!asJsonObject(parsed)) throw new Error("toy ticket is not an object");
    const ticket = enabledToyTicket(parsed);
    unlinkSync(join(f.privateDir, "toy-ticket.json"));
    retargetCharterTicket(f, ticket);
    const planted = publishToyKb(ticket, "on");
    const nested = join(f.worker, "app");
    mkdirSync(nested);
    writeFileSync(join(f.worker, "ak.kb.yaml"), OTHER_BINDING);
    writeFileSync(join(nested, "ak.kb.yaml"), TOY_BINDING);
    writeFileSync(join(nested, "nested.txt"), "nested\n");
    git(f.worker, "add", "ak.kb.yaml", "app");
    git(f.worker, "commit", "-qm", "nested bind");
    writeFileSync(join(nested, ".git"), `gitdir: ${realpathSync(join(f.worker, ".git"))}\n`);
    const revision = workerHead(nested);
    const runner = new Runner(f.privateDir, nested, root);
    const started = withRegistry(planted.registry, () =>
      runner.start("toy-run", f.path, "implementer-1", revision, standing(f)),
    );
    expect(started.behavior?.mode).toBe("on");
    expect(started.behavior?.required_checks).toHaveLength(1);
  });

  test("a nested start ignores an ancestor FIFO .git", () => {
    const f = fixture();
    const parsed: unknown = JSON.parse(readFileSync(join(f.privateDir, "toy-ticket.json"), "utf8"));
    if (!asJsonObject(parsed)) throw new Error("toy ticket is not an object");
    const ticket = enabledToyTicket(parsed);
    unlinkSync(join(f.privateDir, "toy-ticket.json"));
    retargetCharterTicket(f, ticket);
    const planted = publishToyKb(ticket, "on");
    const nested = join(f.worker, "app");
    const deeper = join(nested, "sub");
    mkdirSync(deeper, { recursive: true });
    writeFileSync(join(f.worker, "ak.kb.yaml"), OTHER_BINDING);
    writeFileSync(join(nested, "ak.kb.yaml"), TOY_BINDING);
    writeFileSync(join(deeper, "nested.txt"), "nested\n");
    git(f.worker, "add", "ak.kb.yaml", "app");
    git(f.worker, "commit", "-qm", "nested bind");
    const fifo = join(nested, ".git");
    expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
    const revision = workerHead(f.worker);
    const runner = new Runner(f.privateDir, deeper, root);
    const started = withRegistry(planted.registry, () =>
      runner.start("toy-run", f.path, "implementer-1", revision, standing(f)),
    );
    expect(started.behavior?.mode).toBe("on");
    expect(started.behavior?.required_checks).toHaveLength(1);
  }, 30_000);

  test("a nested project binding in a linked worktree is read from its own folder", () => {
    const f = fixture();
    const parsed: unknown = JSON.parse(readFileSync(join(f.privateDir, "toy-ticket.json"), "utf8"));
    if (!asJsonObject(parsed)) throw new Error("toy ticket is not an object");
    const ticket = enabledToyTicket(parsed);
    unlinkSync(join(f.privateDir, "toy-ticket.json"));
    retargetCharterTicket(f, ticket);
    const planted = publishToyKb(ticket, "on");
    const nested = join(f.worker, "app");
    mkdirSync(nested);
    writeFileSync(join(f.worker, "ak.kb.yaml"), OTHER_BINDING);
    writeFileSync(join(nested, "ak.kb.yaml"), TOY_BINDING);
    writeFileSync(join(nested, "nested.txt"), "nested\n");
    git(f.worker, "add", "ak.kb.yaml", "app");
    git(f.worker, "commit", "-qm", "nested bind");
    const linked = join(f.dir, "linked");
    expect(Bun.spawnSync(["git", "-C", f.worker, "worktree", "add", "-q", "--detach", linked]).exitCode).toBe(0);
    const linkedNested = join(linked, "app");
    const revision = workerHead(linkedNested);
    const runner = new Runner(f.privateDir, linkedNested, root);
    const started = withRegistry(planted.registry, () =>
      runner.start("toy-run", f.path, "implementer-1", revision, standing(f)),
    );
    expect(started.behavior?.mode).toBe("on");
    expect(started.behavior?.required_checks).toHaveLength(1);
  });

  test("a worker commit before start that deletes ak.kb.yaml still uses the base binding", () => {
    const f = fixture(3, FEATURE_WORKER_TEMPLATE);
    const parsed: unknown = JSON.parse(readFileSync(join(f.privateDir, "toy-ticket.json"), "utf8"));
    if (!asJsonObject(parsed)) throw new Error("toy ticket is not an object");
    const ticket = enabledToyTicket(parsed);
    unlinkSync(join(f.privateDir, "toy-ticket.json"));
    retargetCharterTicket(f, ticket);
    const planted = publishToyKb(ticket, "on");
    git(f.worker, "checkout", "main");
    writeFileSync(join(f.worker, "ak.kb.yaml"), TOY_BINDING);
    git(f.worker, "add", "ak.kb.yaml");
    git(f.worker, "commit", "-qm", "base bind");
    git(f.worker, "checkout", "feature");
    git(f.worker, "merge", "-q", "-m", "take bind", "main");
    git(f.worker, "rm", "-q", "ak.kb.yaml");
    git(f.worker, "commit", "-qm", "delete bind");
    const revision = workerHead(f.worker);
    const started = withRegistry(planted.registry, () =>
      f.runner.start("toy-run", f.path, "implementer-1", revision, standing(f)),
    );
    expect(started.behavior?.mode).toBe("on");
    expect(started.behavior?.required_checks).toHaveLength(1);
  });

  test("a worker commit before start that retargets ak.kb.yaml still uses the base binding", () => {
    const f = fixture(3, FEATURE_WORKER_TEMPLATE);
    const parsed: unknown = JSON.parse(readFileSync(join(f.privateDir, "toy-ticket.json"), "utf8"));
    if (!asJsonObject(parsed)) throw new Error("toy ticket is not an object");
    const ticket = enabledToyTicket(parsed);
    unlinkSync(join(f.privateDir, "toy-ticket.json"));
    retargetCharterTicket(f, ticket);
    const planted = publishToyKb(ticket, "on");
    git(f.worker, "checkout", "main");
    writeFileSync(join(f.worker, "ak.kb.yaml"), TOY_BINDING);
    git(f.worker, "add", "ak.kb.yaml");
    git(f.worker, "commit", "-qm", "base bind");
    git(f.worker, "checkout", "feature");
    git(f.worker, "merge", "-q", "-m", "take bind", "main");
    writeFileSync(join(f.worker, "ak.kb.yaml"), OTHER_BINDING);
    git(f.worker, "add", "ak.kb.yaml");
    git(f.worker, "commit", "-qm", "retarget bind");
    const revision = workerHead(f.worker);
    const started = withRegistry(planted.registry, () =>
      f.runner.start("toy-run", f.path, "implementer-1", revision, standing(f)),
    );
    expect(started.behavior?.mode).toBe("on");
    expect(started.behavior?.required_checks).toHaveLength(1);
  });

  test("git replace of the binding blob cannot retarget start", () => {
    const f = fixture(3, FEATURE_WORKER_TEMPLATE);
    const parsed: unknown = JSON.parse(readFileSync(join(f.privateDir, "toy-ticket.json"), "utf8"));
    if (!asJsonObject(parsed)) throw new Error("toy ticket is not an object");
    const ticket = enabledToyTicket(parsed);
    unlinkSync(join(f.privateDir, "toy-ticket.json"));
    retargetCharterTicket(f, ticket);
    const planted = publishToyKb(ticket, "on");
    git(f.worker, "checkout", "main");
    writeFileSync(join(f.worker, "ak.kb.yaml"), TOY_BINDING);
    git(f.worker, "add", "ak.kb.yaml");
    git(f.worker, "commit", "-qm", "base bind");
    git(f.worker, "checkout", "feature");
    git(f.worker, "merge", "-q", "-m", "take bind", "main");
    const blob = gitText(f.worker, ["rev-parse", "HEAD:ak.kb.yaml"]);
    const forgedPath = join(f.worker, "forged.kb.yaml");
    writeFileSync(forgedPath, OTHER_BINDING);
    const forged = gitText(f.worker, ["hash-object", "-w", forgedPath]);
    unlinkSync(forgedPath);
    git(f.worker, "replace", blob, forged);
    const started = withRegistry(planted.registry, () =>
      f.runner.start("toy-run", f.path, "implementer-1", workerHead(f.worker), standing(f)),
    );
    expect(started.behavior?.mode).toBe("on");
    expect(started.behavior?.required_checks).toHaveLength(1);
  });

  test("git replace of the binding tree cannot hide the committed binding", () => {
    const f = fixture(3, FEATURE_WORKER_TEMPLATE);
    const parsed: unknown = JSON.parse(readFileSync(join(f.privateDir, "toy-ticket.json"), "utf8"));
    if (!asJsonObject(parsed)) throw new Error("toy ticket is not an object");
    const ticket = enabledToyTicket(parsed);
    unlinkSync(join(f.privateDir, "toy-ticket.json"));
    retargetCharterTicket(f, ticket);
    const planted = publishToyKb(ticket, "on");
    git(f.worker, "checkout", "main");
    writeFileSync(join(f.worker, "ak.kb.yaml"), TOY_BINDING);
    git(f.worker, "add", "ak.kb.yaml");
    git(f.worker, "commit", "-qm", "base bind");
    git(f.worker, "checkout", "feature");
    git(f.worker, "merge", "-q", "-m", "take bind", "main");
    const base = gitText(f.worker, ["merge-base", "HEAD", "main"]);
    const tree = gitText(f.worker, ["rev-parse", `${base}^{tree}`]);
    const empty = gitText(f.worker, ["mktree"], "");
    git(f.worker, "replace", tree, empty);
    writeFileSync(join(f.worker, "ak.kb.yaml"), OTHER_BINDING);
    const started = withRegistry(planted.registry, () =>
      f.runner.start("toy-run", f.path, "implementer-1", workerHead(f.worker), standing(f)),
    );
    expect(started.behavior?.mode).toBe("on");
    expect(started.behavior?.required_checks).toHaveLength(1);
  });

  test("git grafts cannot retarget the merge-base binding", () => {
    const f = fixture(3, FEATURE_WORKER_TEMPLATE);
    const parsed: unknown = JSON.parse(readFileSync(join(f.privateDir, "toy-ticket.json"), "utf8"));
    if (!asJsonObject(parsed)) throw new Error("toy ticket is not an object");
    const ticket = enabledToyTicket(parsed);
    unlinkSync(join(f.privateDir, "toy-ticket.json"));
    retargetCharterTicket(f, ticket);
    const planted = publishToyKb(ticket, "on");
    git(f.worker, "checkout", "main");
    writeFileSync(join(f.worker, "ak.kb.yaml"), TOY_BINDING);
    git(f.worker, "add", "ak.kb.yaml");
    git(f.worker, "commit", "-qm", "base bind");
    git(f.worker, "checkout", "feature");
    git(f.worker, "merge", "-q", "-m", "take bind", "main");
    const featureSha = workerHead(f.worker);
    const mainSha = gitText(f.worker, ["rev-parse", "main"]);
    git(f.worker, "checkout", "--orphan", "forge");
    writeFileSync(join(f.worker, "ak.kb.yaml"), OTHER_BINDING);
    git(f.worker, "add", "ak.kb.yaml");
    git(f.worker, "commit", "-qm", "forged bind");
    const forged = workerHead(f.worker);
    git(f.worker, "checkout", "-q", "feature");
    mkdirSync(join(f.worker, ".git", "info"), { recursive: true });
    writeFileSync(join(f.worker, ".git", "info", "grafts"), `${featureSha} ${forged}\n${mainSha} ${forged}\n`);
    const started = withRegistry(planted.registry, () =>
      f.runner.start("toy-run", f.path, "implementer-1", workerHead(f.worker), standing(f)),
    );
    expect(started.behavior?.mode).toBe("on");
    expect(started.behavior?.required_checks).toHaveLength(1);
  });

  test("an uncommitted nested ak.kb.yaml does not override the committed root binding", () => {
    const f = fixture(3, FEATURE_WORKER_TEMPLATE);
    const parsed: unknown = JSON.parse(readFileSync(join(f.privateDir, "toy-ticket.json"), "utf8"));
    if (!asJsonObject(parsed)) throw new Error("toy ticket is not an object");
    const ticket = enabledToyTicket(parsed);
    unlinkSync(join(f.privateDir, "toy-ticket.json"));
    retargetCharterTicket(f, ticket);
    const planted = publishToyKb(ticket, "on");
    git(f.worker, "checkout", "main");
    writeFileSync(join(f.worker, "ak.kb.yaml"), TOY_BINDING);
    git(f.worker, "add", "ak.kb.yaml");
    git(f.worker, "commit", "-qm", "root bind");
    git(f.worker, "checkout", "feature");
    git(f.worker, "merge", "-q", "-m", "take bind", "main");
    const nested = join(f.worker, "app");
    mkdirSync(nested);
    writeFileSync(join(nested, "ak.kb.yaml"), OTHER_BINDING);
    const runner = new Runner(f.privateDir, nested, root);
    const started = withRegistry(planted.registry, () =>
      runner.start("toy-run", f.path, "implementer-1", workerHead(nested), standing(f)),
    );
    expect(started.behavior?.mode).toBe("on");
    expect(started.behavior?.required_checks).toHaveLength(1);
  });

  test("a worker branched before the binding existed cannot start unbound", () => {
    const f = fixture(3, FEATURE_WORKER_TEMPLATE);
    unlinkSync(join(f.privateDir, "toy-ticket.json"));
    git(f.worker, "checkout", "main");
    writeFileSync(join(f.worker, "ak.kb.yaml"), TOY_BINDING);
    git(f.worker, "add", "ak.kb.yaml");
    git(f.worker, "commit", "-qm", "bind after fork");
    git(f.worker, "checkout", "feature");
    if (existsSync(join(f.worker, "ak.kb.yaml"))) unlinkSync(join(f.worker, "ak.kb.yaml"));
    let started: ReturnType<Runner["start"]> | undefined;
    let error: string | undefined;
    try {
      started = f.runner.start("toy-run", f.path, "implementer-1", workerHead(f.worker), standing(f));
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    }
    expect(error).toBe("the charter base tip has a knowledgebase binding the merge-base does not");
    expect(started).toBeUndefined();
  });

  test("a local branch named origin/main cannot retarget the merge-base binding", () => {
    const f = fixture(3, FEATURE_WORKER_TEMPLATE);
    const parsed: unknown = JSON.parse(readFileSync(join(f.privateDir, "toy-ticket.json"), "utf8"));
    if (!asJsonObject(parsed)) throw new Error("toy ticket is not an object");
    const ticket = enabledToyTicket(parsed);
    unlinkSync(join(f.privateDir, "toy-ticket.json"));
    retargetCharterTicket(f, ticket);
    const planted = publishToyKb(ticket, "on");
    git(f.worker, "checkout", "main");
    writeFileSync(join(f.worker, "ak.kb.yaml"), TOY_BINDING);
    git(f.worker, "add", "ak.kb.yaml");
    git(f.worker, "commit", "-qm", "base bind");
    const mainSha = workerHead(f.worker);
    git(f.worker, "checkout", "feature");
    git(f.worker, "merge", "-q", "-m", "take bind", "main");
    git(f.worker, "checkout", "--orphan", "forge");
    writeFileSync(join(f.worker, "ak.kb.yaml"), OTHER_BINDING);
    git(f.worker, "add", "ak.kb.yaml");
    git(f.worker, "commit", "-qm", "forged bind");
    const forged = workerHead(f.worker);
    git(f.worker, "checkout", "-q", "feature");
    git(f.worker, "update-ref", "refs/heads/origin/main", forged);
    const started = withRegistry(planted.registry, () =>
      f.runner.start("toy-run", f.path, "implementer-1", workerHead(f.worker), standing(f)),
    );
    expect(started.behavior?.mode).toBe("on");
    expect(started.behavior?.required_checks).toHaveLength(1);
    expect(mainSha).not.toBe(forged);
  });

  test("a planted commit-graph file does not retarget the merge-base binding", () => {
    // Does not pin core.commitGraph=false; the argv assertion does.
    const f = fixture(3, FEATURE_WORKER_TEMPLATE);
    const parsed: unknown = JSON.parse(readFileSync(join(f.privateDir, "toy-ticket.json"), "utf8"));
    if (!asJsonObject(parsed)) throw new Error("toy ticket is not an object");
    const ticket = enabledToyTicket(parsed);
    unlinkSync(join(f.privateDir, "toy-ticket.json"));
    retargetCharterTicket(f, ticket);
    const planted = publishToyKb(ticket, "on");
    git(f.worker, "checkout", "main");
    writeFileSync(join(f.worker, "ak.kb.yaml"), TOY_BINDING);
    git(f.worker, "add", "ak.kb.yaml");
    git(f.worker, "commit", "-qm", "base bind");
    git(f.worker, "checkout", "feature");
    git(f.worker, "merge", "-q", "-m", "take bind", "main");
    mkdirSync(join(f.worker, ".git", "objects", "info"), { recursive: true });
    writeFileSync(join(f.worker, ".git", "objects", "info", "commit-graph"), "forged-commit-graph\n");
    const started = withRegistry(planted.registry, () =>
      f.runner.start("toy-run", f.path, "implementer-1", workerHead(f.worker), standing(f)),
    );
    expect(started.behavior?.mode).toBe("on");
    expect(started.behavior?.required_checks).toHaveLength(1);
  });

  test("merge-base git argv disables the commit graph", () => {
    const argv = isolatedGitArgv(root, ["merge-base", "HEAD", "main"]);
    expect(argv).toContain("core.commitGraph=false");
    expect(argv).toContain("merge-base");
    expect(argv.indexOf("-c")).toBeGreaterThanOrEqual(0);
    expect(argv[argv.indexOf("core.commitGraph=false") - 1]).toBe("-c");
  });

  test("verify and ship use origin main when local main lags across a CI change", () => {
    const f = fixture(3, FEATURE_WORKER_TEMPLATE);
    const localMain = gitText(f.worker, ["rev-parse", "refs/heads/main"]);
    git(f.worker, "checkout", "main");
    mkdirSync(join(f.worker, ".github", "workflows"), { recursive: true });
    writeFileSync(join(f.worker, ".github", "workflows", "ci.yml"), "name: current CI\n");
    git(f.worker, "add", ".github/workflows/ci.yml");
    git(f.worker, "commit", "-qm", "advance remote CI");
    const remoteMain = workerHead(f.worker);
    git(f.worker, "update-ref", "refs/remotes/origin/main", remoteMain);
    git(f.worker, "checkout", "feature");
    git(f.worker, "branch", "-f", "main", localMain);
    f.runner.start("toy-run", f.path, "implementer-1", f.revision, standing(f));
    const receipt = join(f.privateDir, "source.txt");
    writeFileSync(receipt, "source evidence");
    f.runner.collect("toy-run", "e1", receipt, f.revision, "source");
    reachShipReady(f, false);
    expect(f.runner.status("toy-run").verified_base_revision).toBe(remoteMain);
    f.runner.bindVerdict("toy-run");
    expect(
      new Runner(f.privateDir, f.worker, root, true).syncRevision("toy-run").verdict?.invalidated_by,
    ).toBeUndefined();
    expect(shipCard(f).id).toBe("ship");
    expect(gitText(f.worker, ["rev-parse", "refs/heads/main"])).toBe(localMain);
  });

  test("an unreadable committed binding refuses run start", () => {
    const f = fixture();
    writeFileSync(join(f.worker, "ak.kb.yaml"), TOY_BINDING);
    git(f.worker, "add", "ak.kb.yaml");
    git(f.worker, "commit", "-qm", "bind project");
    const revision = workerHead(f.worker);
    const oid = gitText(f.worker, ["rev-parse", "HEAD:ak.kb.yaml"]);
    expect(gitText(f.worker, ["ls-tree", "HEAD", "ak.kb.yaml"])).toContain(oid);
    rmSync(join(f.worker, ".git", "objects", oid.slice(0, 2), oid.slice(2)));
    expect(() => f.runner.start("toy-run", f.path, "implementer-1", revision, standing(f))).toThrow(
      "cannot read committed knowledgebase binding",
    );
  });

  test("an unreadable charter tip binding refuses an unbound merge-base start", () => {
    const f = fixture(3, FEATURE_WORKER_TEMPLATE);
    git(f.worker, "checkout", "main");
    writeFileSync(join(f.worker, "ak.kb.yaml"), TOY_BINDING);
    git(f.worker, "add", "ak.kb.yaml");
    git(f.worker, "commit", "-qm", "bind after fork");
    const oid = gitText(f.worker, ["rev-parse", "HEAD:ak.kb.yaml"]);
    git(f.worker, "checkout", "feature");
    rmSync(join(f.worker, ".git", "objects", oid.slice(0, 2), oid.slice(2)));
    expect(() => f.runner.start("toy-run", f.path, "implementer-1", f.revision, standing(f))).toThrow(
      "cannot read committed knowledgebase binding",
    );
  });

  for (const checkpoint of ["binding", "ship"])
    test(`an origin main conflict refuses verdict ${checkpoint} while local main lags`, () => {
      const f = patchVerdictFixture(false, false);
      if (checkpoint === "ship") f.runner.bindVerdict("toy-run");
      const localMain = gitText(f.worker, ["rev-parse", "refs/heads/main"]);
      trunkCommit(f, "feature.txt", "remote conflict\n");
      git(f.worker, "update-ref", "refs/remotes/origin/main", gitText(f.worker, ["rev-parse", "refs/heads/main"]));
      git(f.worker, "branch", "-f", "main", localMain);
      if (checkpoint === "binding")
        expect(() => f.runner.bindVerdict("toy-run")).toThrow("merge-tree reports a conflict");
      else expect(() => shipCard(f)).toThrow("rebase onto main is required");
    });

  test("verdict patch identity excludes changes already on origin main while local main lags", () => {
    const f = fixture(3, FEATURE_WORKER_TEMPLATE);
    const remoteMain = f.revision;
    git(f.worker, "update-ref", "refs/remotes/origin/main", remoteMain);
    writeFileSync(join(f.worker, "feature.txt"), "feature with a follow-up\n");
    git(f.worker, "commit", "-qam", "follow up feature");
    f.revision = workerHead(f.worker);
    f.runner.start("toy-run", f.path, "implementer-1", f.revision, standing(f));
    const receipt = join(f.privateDir, "source.txt");
    writeFileSync(receipt, "source evidence");
    f.runner.collect("toy-run", "e1", receipt, f.revision, "source");
    reachShipReady(f, false);
    const patch = gitText(f.worker, ["diff", "--binary", remoteMain, f.revision, "--"]);
    const expected = gitText(f.worker, ["patch-id", "--stable"], `${patch}\n`).split(" ")[0];
    if (expected === undefined || expected === "") throw new Error("fixture patch has no stable identity");
    expect(f.runner.bindVerdict("toy-run").patch_id).toBe(expected);
    expect(shipCard(f).id).toBe("ship");
  });

  test("verify records the charter base commit, not a short rev-parse", () => {
    const f = fixture(3, FEATURE_WORKER_TEMPLATE);
    const mainSha = gitText(f.worker, ["rev-parse", "refs/heads/main"]);
    git(f.worker, "tag", "main", f.revision);
    f.runner.start("toy-run", f.path, "implementer-1", f.revision, standing(f));
    const receipt = join(f.privateDir, "source.txt");
    writeFileSync(receipt, "source evidence");
    f.runner.collect("toy-run", "e1", receipt, f.revision, "source");
    reachShipReady(f, false);
    expect(f.runner.status("toy-run").verified_base_revision).toBe(mainSha);
    expect(mainSha).not.toBe(f.revision);
  });

  test("a non-ticket charter with a committed binding and an unregistered knowledgebase is refused", () => {
    const f = fixture();
    if (!asJsonObject(f.charter.work_source)) throw new Error("toy work source is missing");
    f.charter.work_source = {
      kind: "plan",
      ref: { id: "toy-plan", schema: "plan-record", hash: `sha256:${"a".repeat(64)}` },
    };
    f.charter.immutability.hash = artifactHash({
      ...f.charter,
      immutability: { ...f.charter.immutability, hash: "" },
    });
    const planApproval = f.charter.approvals[0];
    if (planApproval === undefined) throw new Error("toy charter approval missing");
    planApproval.artifact_hash = f.charter.immutability.hash;
    writeFileSync(f.path, JSON.stringify(f.charter));
    writeFileSync(join(f.worker, "ak.kb.yaml"), TOY_BINDING);
    git(f.worker, "add", "ak.kb.yaml");
    git(f.worker, "commit", "-qm", "bind");
    expect(() => f.runner.start("toy-run", f.path, "implementer-1", workerHead(f.worker), standing(f))).toThrow(
      "the authoritative project record is unavailable; missing project cannot turn this run off",
    );
  });

  test("an unresolvable base branch does not record a planted working binding", () => {
    const f = fixture();
    if (!asJsonObject(f.charter.work_source)) throw new Error("toy work source is missing");
    f.charter.work_source = {
      kind: "plan",
      ref: { id: "toy-plan", schema: "plan-record", hash: `sha256:${"a".repeat(64)}` },
    };
    f.charter.repos = [{ repo: "toy", base_branch: "missing-base", paths: ["src/**"] }];
    f.charter.immutability.hash = artifactHash({
      ...f.charter,
      immutability: { ...f.charter.immutability, hash: "" },
    });
    const planApproval = f.charter.approvals[0];
    if (planApproval === undefined) throw new Error("toy charter approval missing");
    planApproval.artifact_hash = f.charter.immutability.hash;
    writeFileSync(f.path, JSON.stringify(f.charter));
    writeFileSync(join(f.worker, "ak.kb.yaml"), TOY_BINDING);
    const started = f.runner.start("toy-run", f.path, "implementer-1", workerHead(f.worker), standing(f));
    expect(started.run_state).toBe("created");
    expect(started.behavior?.mode).toBe("off");
    expect(started.behavior?.policy_id).toBe(null);
    expect(started.behavior?.required_checks).toEqual([]);
  });

  test("an uncomputable merge-base does not record a planted working binding", () => {
    const f = fixture();
    const parsed: unknown = JSON.parse(readFileSync(join(f.privateDir, "toy-ticket.json"), "utf8"));
    if (!asJsonObject(parsed)) throw new Error("toy ticket is not an object");
    const ticket = enabledToyTicket(parsed);
    const planted = publishToyKb(ticket, "on");
    if (!asJsonObject(f.charter.work_source)) throw new Error("toy work source is missing");
    f.charter.work_source = {
      kind: "plan",
      ref: { id: "toy-plan", schema: "plan-record", hash: `sha256:${"a".repeat(64)}` },
    };
    f.charter.immutability.hash = artifactHash({
      ...f.charter,
      immutability: { ...f.charter.immutability, hash: "" },
    });
    const planApproval = f.charter.approvals[0];
    if (planApproval === undefined) throw new Error("toy charter approval missing");
    planApproval.artifact_hash = f.charter.immutability.hash;
    writeFileSync(f.path, JSON.stringify(f.charter));
    writeFileSync(join(f.worker, "ak.kb.yaml"), TOY_BINDING);
    git(f.worker, "checkout", "--orphan", "orphan");
    git(f.worker, "commit", "--allow-empty", "-qm", "orphan");
    const started = withRegistry(planted.registry, () =>
      f.runner.start("toy-run", f.path, "implementer-1", workerHead(f.worker), standing(f)),
    );
    expect(started.run_state).toBe("created");
    expect(started.behavior?.mode).toBe("off");
    expect(started.behavior?.policy_id).toBe(null);
    expect(started.behavior?.required_checks).toEqual([]);
  });

  test("an in-repo worker commit that flips behavior still uses the base record", () => {
    const f = fixture(3, FEATURE_WORKER_TEMPLATE);
    const parsed: unknown = JSON.parse(readFileSync(join(f.privateDir, "toy-ticket.json"), "utf8"));
    if (!asJsonObject(parsed)) throw new Error("toy ticket is not an object");
    const ticket = enabledToyTicket(parsed);
    unlinkSync(join(f.privateDir, "toy-ticket.json"));
    retargetCharterTicket(f, ticket);
    git(f.worker, "checkout", "main");
    mkdirSync(join(f.worker, "wiki", "adr"), { recursive: true });
    writeFileSync(join(f.worker, "wiki", "adr", ".gitkeep"), "");
    mkdirSync(join(f.worker, "projects", "toy", "runs"), { recursive: true });
    const onKb = publishToyKb(ticket, "on");
    const offKb = publishToyKb(ticket, "off");
    writeFileSync(
      join(f.worker, "projects", "toy", "runs", "artifacts.jsonl"),
      readFileSync(join(onKb.kb, "projects", "toy", "runs", "artifacts.jsonl")),
    );
    writeFileSync(join(f.worker, "ak.kb.yaml"), IN_REPO_BINDING);
    git(f.worker, "add", "-A");
    git(f.worker, "commit", "-qm", "in-repo on");
    const mainSha = workerHead(f.worker);
    git(f.worker, "update-ref", "refs/remotes/origin/main", mainSha);
    git(f.worker, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
    git(f.worker, "checkout", "feature");
    git(f.worker, "merge", "-q", "-m", "take in-repo", "main");
    writeFileSync(
      join(f.worker, "projects", "toy", "runs", "artifacts.jsonl"),
      readFileSync(join(offKb.kb, "projects", "toy", "runs", "artifacts.jsonl")),
    );
    git(f.worker, "add", "projects/toy/runs/artifacts.jsonl");
    git(f.worker, "commit", "-qm", "flip off");
    git(f.worker, "update-ref", "refs/remotes/origin/main", mainSha);
    git(f.worker, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
    const started = f.runner.start("toy-run", f.path, "implementer-1", workerHead(f.worker), standing(f));
    expect(started.behavior?.mode).toBe("on");
    expect(started.behavior?.required_checks).toHaveLength(1);
  });

  test("a worker branched before the base turned behavior on cannot start with the stale record", () => {
    const f = fixture(3, FEATURE_WORKER_TEMPLATE);
    const parsed: unknown = JSON.parse(readFileSync(join(f.privateDir, "toy-ticket.json"), "utf8"));
    if (!asJsonObject(parsed)) throw new Error("toy ticket is not an object");
    const ticket = enabledToyTicket(parsed);
    unlinkStoreTicket(f, ticket);
    const offKb = publishToyKb(ticket, "off");
    const onKb = publishToyKb(ticket, "on");
    forkFeatureFromOlderKb(
      f,
      projectOnlyJsonl(offKb.kb),
      readFileSync(join(onKb.kb, "projects", "toy", "runs", "artifacts.jsonl"), "utf8"),
    );
    expect(() => f.runner.start("toy-run", f.path, "implementer-1", workerHead(f.worker), standing(f))).toThrow(
      "the charter base tip has a knowledgebase record the merge-base does not",
    );
  });

  test("a worker branched before the base published artifacts cannot start with the stale record", () => {
    const f = fixture(3, FEATURE_WORKER_TEMPLATE);
    const parsed: unknown = JSON.parse(readFileSync(join(f.privateDir, "toy-ticket.json"), "utf8"));
    if (!asJsonObject(parsed)) throw new Error("toy ticket is not an object");
    const ticket = enabledToyTicket(parsed);
    unlinkStoreTicket(f, ticket);
    const onKb = publishToyKb(ticket, "on");
    forkFeatureFromOlderKb(f, null, readFileSync(join(onKb.kb, "projects", "toy", "runs", "artifacts.jsonl"), "utf8"));
    expect(() => f.runner.start("toy-run", f.path, "implementer-1", workerHead(f.worker), standing(f))).toThrow(
      "the charter base tip has a knowledgebase record the merge-base does not",
    );
  });

  for (const baseMode of ["off", "shadow"] as const) {
    test(`a worker branched before the base left review.behavior ${baseMode} cannot start when the ticket already exists`, () => {
      const f = fixture(3, FEATURE_WORKER_TEMPLATE);
      const parsed: unknown = JSON.parse(readFileSync(join(f.privateDir, "toy-ticket.json"), "utf8"));
      if (!asJsonObject(parsed)) throw new Error("toy ticket is not an object");
      unlinkStoreTicket(f, parsed);
      const atO = publishToyKb(parsed, baseMode);
      const atT = publishToyKb(parsed, "on");
      forkFeatureFromOlderKb(f, artifactsJsonl(atO.kb), artifactsJsonl(atT.kb));
      expect(() => f.runner.start("toy-run", f.path, "implementer-1", workerHead(f.worker), standing(f))).toThrow(
        "the charter base tip has a knowledgebase record the merge-base does not",
      );
    });
  }

  test("a worker branched before the base published the ticket cannot start when mode and project already match", () => {
    const f = fixture(3, FEATURE_WORKER_TEMPLATE);
    const parsed: unknown = JSON.parse(readFileSync(join(f.privateDir, "toy-ticket.json"), "utf8"));
    if (!asJsonObject(parsed)) throw new Error("toy ticket is not an object");
    unlinkStoreTicket(f, parsed);
    const onKb = publishToyKb(parsed, "on");
    forkFeatureFromOlderKb(f, projectOnlyJsonl(onKb.kb), artifactsJsonl(onKb.kb));
    expect(() => f.runner.start("toy-run", f.path, "implementer-1", workerHead(f.worker), standing(f))).toThrow(
      "the charter base tip has a knowledgebase record the merge-base does not",
    );
  });

  test("a worker branched before the base added ticket checks cannot start with the weaker freeze", () => {
    const f = fixture(3, FEATURE_WORKER_TEMPLATE);
    const parsed: unknown = JSON.parse(readFileSync(join(f.privateDir, "toy-ticket.json"), "utf8"));
    if (!asJsonObject(parsed)) throw new Error("toy ticket is not an object");
    const older = parsed;
    const newer = enabledToyTicket(parsed);
    unlinkStoreTicket(f, older);
    const atO = publishToyKb(older, "on");
    const atT = publishToyKb(newer, "on");
    forkFeatureFromOlderKb(
      f,
      readFileSync(join(atO.kb, "projects", "toy", "runs", "artifacts.jsonl"), "utf8"),
      readFileSync(join(atT.kb, "projects", "toy", "runs", "artifacts.jsonl"), "utf8"),
    );
    expect(() => f.runner.start("toy-run", f.path, "implementer-1", workerHead(f.worker), standing(f))).toThrow(
      "the charter base tip has a knowledgebase record the merge-base does not",
    );
  });

  test("a worker branched before a same-check ticket body edit still starts", () => {
    const f = fixture(3, FEATURE_WORKER_TEMPLATE);
    const parsed: unknown = JSON.parse(readFileSync(join(f.privateDir, "toy-ticket.json"), "utf8"));
    if (!asJsonObject(parsed)) throw new Error("toy ticket is not an object");
    const older = enabledToyTicket(parsed);
    const newer: JsonObject = {
      ...older,
      acceptance_criteria: [{ id: "AC-1", text: "The behavior is verified, with different prose.", surface: "none" }],
    };
    unlinkStoreTicket(f, older);
    const atO = publishToyKb(older, "on");
    const atT = publishToyKb(newer, "on");
    forkFeatureFromOlderKb(
      f,
      readFileSync(join(atO.kb, "projects", "toy", "runs", "artifacts.jsonl"), "utf8"),
      readFileSync(join(atT.kb, "projects", "toy", "runs", "artifacts.jsonl"), "utf8"),
    );
    const started = f.runner.start("toy-run", f.path, "implementer-1", workerHead(f.worker), standing(f));
    expect(started.behavior?.mode).toBe("on");
    expect(started.behavior?.required_checks).toHaveLength(1);
  });

  test("a worker branched before the base added a freezeCheck reject cannot start with an unknown tip freeze", () => {
    const f = fixture(3, FEATURE_WORKER_TEMPLATE);
    const parsed: unknown = JSON.parse(readFileSync(join(f.privateDir, "toy-ticket.json"), "utf8"));
    if (!asJsonObject(parsed)) throw new Error("toy ticket is not an object");
    const older = parsed;
    const newer = freezeRejectingToyTicket(parsed);
    unlinkStoreTicket(f, older);
    const atO = publishToyKb(older, "on");
    const atT = publishToyKb(newer, "on");
    forkFeatureFromOlderKb(f, artifactsJsonl(atO.kb), artifactsJsonl(atT.kb));
    expect(() => f.runner.start("toy-run", f.path, "implementer-1", workerHead(f.worker), standing(f))).toThrow(
      "the charter base tip has a knowledgebase record the merge-base does not",
    );
  });

  for (const tipMode of ["off", "shadow"] as const) {
    test(`a tip in ${tipMode} whose freeze fails still starts from the merge-base record`, () => {
      const f = fixture(3, FEATURE_WORKER_TEMPLATE);
      const parsed: unknown = JSON.parse(readFileSync(join(f.privateDir, "toy-ticket.json"), "utf8"));
      if (!asJsonObject(parsed)) throw new Error("toy ticket is not an object");
      const older = enabledToyTicket(parsed);
      unlinkStoreTicket(f, older);
      const atO = publishToyKb(older, "on");
      const atT = publishToyKb(older, tipMode);
      forkFeatureFromOlderKb(f, artifactsJsonl(atO.kb), artifactsJsonl(atT.kb));
      const started = f.runner.start("toy-run", f.path, "implementer-1", workerHead(f.worker), standing(f));
      expect(started.behavior?.mode).toBe("on");
      expect(started.behavior?.required_checks).toHaveLength(1);
    });
  }

  test("a worker branched before the base reworded a frozen check cannot start with the weaker freeze", () => {
    const f = fixture(3, FEATURE_WORKER_TEMPLATE);
    const parsed: unknown = JSON.parse(readFileSync(join(f.privateDir, "toy-ticket.json"), "utf8"));
    if (!asJsonObject(parsed)) throw new Error("toy ticket is not an object");
    const older = enabledToyTicket(parsed);
    const newer = rewordedCheckToyTicket(parsed);
    unlinkStoreTicket(f, older);
    const atO = publishToyKb(older, "on");
    const atT = publishToyKb(newer, "on");
    forkFeatureFromOlderKb(f, artifactsJsonl(atO.kb), artifactsJsonl(atT.kb));
    expect(() => f.runner.start("toy-run", f.path, "implementer-1", workerHead(f.worker), standing(f))).toThrow(
      "the charter base tip has a knowledgebase record the merge-base does not",
    );
  });

  test("approved ticket is absent from the runner store under W1 on", () => {
    const f = fixture();
    const parsed: unknown = JSON.parse(readFileSync(join(f.privateDir, "toy-ticket.json"), "utf8"));
    if (!asJsonObject(parsed)) throw new Error("toy ticket is not an object");
    const ticket = enabledToyTicket(parsed);
    unlinkSync(join(f.privateDir, "toy-ticket.json"));
    retargetCharterTicket(f, ticket);
    unlinkSync(join(f.privateDir, "toy-ticket.json"));
    const planted = publishToyKb(ticket, "on");
    const jsonl = readFileSync(join(planted.kb, "projects", "toy", "runs", "artifacts.jsonl"), "utf8");
    const projectLine = jsonl
      .split("\n")
      .find((line) => line.includes('"schema":"project"') || line.includes('"schema": "project"'));
    if (projectLine === undefined) throw new Error("published kb has no project record");
    writeFileSync(join(planted.kb, "projects", "toy", "runs", "artifacts.jsonl"), `${projectLine}\n`);
    git(planted.kb, "add", "-A");
    git(planted.kb, "commit", "-qm", "drop ticket");
    writeFileSync(join(f.worker, "ak.kb.yaml"), TOY_BINDING);
    git(f.worker, "add", "ak.kb.yaml");
    git(f.worker, "commit", "-qm", "bind");
    expect(() =>
      withRegistry(planted.registry, () =>
        f.runner.start("toy-run", f.path, "implementer-1", workerHead(f.worker), standing(f)),
      ),
    ).toThrow("approved ticket is absent from the runner store");
  });

  test("Runner.start refusals name the exact charter and binding failures", () => {
    const f = fixture();
    expect(() => f.runner.start("toy-run", f.path, "implementer-1", "not-a-revision", standing(f))).toThrow(
      "revision must be a full version-control object id",
    );
    expect(() =>
      new Runner(f.privateDir, f.worker, root, true).start(
        "toy-run",
        f.path,
        "implementer-1",
        "a".repeat(40),
        standing(f),
      ),
    ).toThrow("start revision differs from worker checkout");
    f.charter.status = "revoked";
    f.charter.immutability.hash = artifactHash({ ...f.charter, immutability: { ...f.charter.immutability, hash: "" } });
    const revokedApproval = f.charter.approvals[0];
    if (revokedApproval === undefined) throw new Error("toy charter approval missing");
    revokedApproval.artifact_hash = f.charter.immutability.hash;
    writeFileSync(f.path, JSON.stringify(f.charter));
    expect(() => f.runner.start("toy-run", f.path, "implementer-1", f.revision, standing(f))).toThrow(
      "charter is inactive, moved or has a mismatched hash",
    );
    const moved = fixture();
    const elsewhere = join(moved.privateDir, "elsewhere.json");
    writeFileSync(elsewhere, readFileSync(moved.path));
    expect(() => moved.runner.start("toy-run", elsewhere, "implementer-1", moved.revision, standing(moved))).toThrow(
      "charter is inactive, moved or has a mismatched hash",
    );
    const humanFixture = fixture();
    const humanParsed: unknown = JSON.parse(readFileSync(humanFixture.path, "utf8"));
    if (!asJsonObject(humanParsed)) throw new Error("toy charter is not an object");
    humanParsed.approvals = [];
    expect(charterAllowsProtectedStart(humanParsed, humanFixture.charter.immutability.hash)).toEqual({
      ok: false,
      reason: "active charter lacks a human approval bound to its hash",
    });
    const sensitive = fixture();
    const sensitiveParsed: unknown = JSON.parse(readFileSync(sensitive.path, "utf8"));
    if (!asJsonObject(sensitiveParsed)) throw new Error("toy charter is not an object");
    const sensitiveCharter = sensitiveParsed;
    sensitiveCharter.sensitive_grants = [
      {
        action: "merge",
        scope: "this toy run only",
        approval: {
          artifact_hash: `sha256:${"0".repeat(64)}`,
          by: "human",
          authority: "explicit",
          at: "2026-10-01T00:00:00Z",
        },
      },
    ];
    if (!asJsonObject(sensitiveCharter.immutability)) throw new Error("charter immutability missing");
    const sensitiveHash = artifactHash({
      ...sensitiveCharter,
      immutability: { ...sensitiveCharter.immutability, hash: "" },
    });
    sensitiveCharter.immutability.hash = sensitiveHash;
    const sensitiveApproval = Array.isArray(sensitiveCharter.approvals) ? sensitiveCharter.approvals[0] : undefined;
    if (!asJsonObject(sensitiveApproval)) throw new Error("toy charter approval missing");
    sensitiveApproval.artifact_hash = sensitiveHash;
    writeFileSync(sensitive.path, JSON.stringify(sensitiveCharter));
    const sensitiveStanding = { ...standing(sensitive), charter_hash: sensitiveHash };
    expect(() =>
      sensitive.runner.start("toy-run", sensitive.path, "implementer-1", sensitive.revision, sensitiveStanding),
    ).toThrow("sensitive grant lacks human approval bound to this charter");
    const runId = fixture();
    expect(() => runId.runner.start("other-run", runId.path, "implementer-1", runId.revision, standing(runId))).toThrow(
      "run id does not match charter",
    );
    const exists = fixture();
    exists.runner.start("toy-run", exists.path, "implementer-1", exists.revision, standing(exists));
    expect(() =>
      exists.runner.start("toy-run", exists.path, "implementer-1", exists.revision, standing(exists)),
    ).toThrow("run already exists");
    const base = fixture();
    base.charter.repos = [{ repo: "toy", base_branch: "missing-base", paths: ["src/**"] }];
    base.charter.immutability.hash = artifactHash({
      ...base.charter,
      immutability: { ...base.charter.immutability, hash: "" },
    });
    const baseApproval = base.charter.approvals[0];
    if (baseApproval === undefined) throw new Error("toy charter approval missing");
    baseApproval.artifact_hash = base.charter.immutability.hash;
    writeFileSync(base.path, JSON.stringify(base.charter));
    expect(() => base.runner.start("toy-run", base.path, "implementer-1", base.revision, standing(base))).toThrow(
      "cannot resolve charter base branch missing-base",
    );
    const orphan = fixture();
    git(orphan.worker, "checkout", "--orphan", "orphan");
    git(orphan.worker, "commit", "--allow-empty", "-qm", "orphan");
    expect(() =>
      orphan.runner.start("toy-run", orphan.path, "implementer-1", workerHead(orphan.worker), standing(orphan)),
    ).toThrow("cannot compute merge-base of the start revision and the charter base branch");
    const planOrphan = fixture();
    if (!asJsonObject(planOrphan.charter.work_source)) throw new Error("toy work source is missing");
    planOrphan.charter.work_source = {
      kind: "plan",
      ref: { id: "toy-plan", schema: "plan-record", hash: `sha256:${"a".repeat(64)}` },
    };
    planOrphan.charter.immutability.hash = artifactHash({
      ...planOrphan.charter,
      immutability: { ...planOrphan.charter.immutability, hash: "" },
    });
    const planApproval = planOrphan.charter.approvals[0];
    if (planApproval === undefined) throw new Error("toy charter approval missing");
    planApproval.artifact_hash = planOrphan.charter.immutability.hash;
    writeFileSync(planOrphan.path, JSON.stringify(planOrphan.charter));
    git(planOrphan.worker, "checkout", "--orphan", "orphan");
    git(planOrphan.worker, "commit", "--allow-empty", "-qm", "orphan");
    const planStarted = planOrphan.runner.start(
      "toy-run",
      planOrphan.path,
      "implementer-1",
      workerHead(planOrphan.worker),
      standing(planOrphan),
    );
    expect(planStarted.run_state).toBe("created");
    const fromRevision = fixture(3, FEATURE_WORKER_TEMPLATE);
    const featureSha = fromRevision.revision;
    git(fromRevision.worker, "checkout", "--orphan", "orphan");
    git(fromRevision.worker, "commit", "--allow-empty", "-qm", "orphan");
    const startedFromRevision = fromRevision.runner.start(
      "toy-run",
      fromRevision.path,
      "implementer-1",
      featureSha,
      standing(fromRevision),
    );
    expect(startedFromRevision.run_state).toBe("created");
    const mismatch = fixture();
    if (!asJsonObject(mismatch.charter.work_source) || !asJsonObject(mismatch.charter.work_source.ref))
      throw new Error("toy work source is missing");
    mismatch.charter.work_source.ref.hash = `sha256:${"0".repeat(64)}`;
    mismatch.charter.immutability.hash = artifactHash({
      ...mismatch.charter,
      immutability: { ...mismatch.charter.immutability, hash: "" },
    });
    const mismatchApproval = mismatch.charter.approvals[0];
    if (mismatchApproval === undefined) throw new Error("toy charter approval missing");
    mismatchApproval.artifact_hash = mismatch.charter.immutability.hash;
    writeFileSync(mismatch.path, JSON.stringify(mismatch.charter));
    expect(() =>
      mismatch.runner.start("toy-run", mismatch.path, "implementer-1", mismatch.revision, standing(mismatch)),
    ).toThrow("approved ticket does not match the charter work source");
    const malformed = fixture();
    writeFileSync(join(malformed.privateDir, "toy-ticket.json"), "{");
    expect(() =>
      malformed.runner.start("toy-run", malformed.path, "implementer-1", malformed.revision, standing(malformed)),
    ).toThrow("approved ticket is malformed");
    const unavailable = fixture();
    writeFileSync(join(unavailable.worker, "ak.kb.yaml"), TOY_BINDING);
    git(unavailable.worker, "add", "ak.kb.yaml");
    git(unavailable.worker, "commit", "-qm", "bind");
    expect(() =>
      unavailable.runner.start(
        "toy-run",
        unavailable.path,
        "implementer-1",
        workerHead(unavailable.worker),
        standing(unavailable),
      ),
    ).toThrow("the authoritative project record is unavailable; missing project cannot turn this run off");
  });

  test("Runner.load refuses a tampered behavior snapshot", () => {
    const f = fixture();
    const parsed: unknown = JSON.parse(readFileSync(join(f.privateDir, "toy-ticket.json"), "utf8"));
    if (!asJsonObject(parsed)) throw new Error("toy ticket is not an object");
    const ticket = enabledToyTicket(parsed);
    unlinkSync(join(f.privateDir, "toy-ticket.json"));
    retargetCharterTicket(f, ticket);
    const planted = publishToyKb(ticket, "on");
    writeFileSync(join(f.worker, "ak.kb.yaml"), TOY_BINDING);
    git(f.worker, "add", "ak.kb.yaml");
    git(f.worker, "commit", "-qm", "bind");
    const revision = workerHead(f.worker);
    withRegistry(planted.registry, () => f.runner.start("toy-run", f.path, "implementer-1", revision, standing(f)));
    const path = join(f.privateDir, "toy-run.json");
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!asJsonObject(raw) || !asJsonObject(raw.behavior)) throw new Error("runner record has no behavior");
    raw.behavior.binding_hash = `sha256:${"0".repeat(64)}`;
    writeFileSync(path, JSON.stringify(raw));
    expect(() => f.runner.status("toy-run")).toThrow("behavior policy snapshot is incomplete");
    expect(() => f.runner.verify("toy-run", "e1")).toThrow("behavior policy snapshot is incomplete");
  });

  test("a charter cannot request unattended decisions without event-delivery authority", () => {
    const f = fixture();
    f.charter.allowed_capabilities = f.charter.allowed_capabilities.filter(
      (capability) => capability !== "event-delivery",
    );
    withAuditCadence(f);
    f.runner.start("toy-run", f.path, "implementer-1", f.revision, standing(f));
    const source = join(f.privateDir, "source.txt");
    writeFileSync(source, "approved source");
    f.runner.collect("toy-run", "e1", source, f.revision, "source");
    card(f);
    expect(f.runner.decide("toy-run", "card-1").escalation?.charter_rule).toBe("charter:allowed_capabilities");
  });

  test("event delivery is durable until acknowledged and terminal events do not wake a run", () => {
    const f = fixture();
    f.runner.start("toy-run", f.path, "implementer-1", f.revision, standing(f));
    expect(f.runner.event("toy-run", "wake-1", "check the next checkpoint")).toEqual({
      duplicate: false,
      terminal: false,
    });
    const restarted = new Runner(f.privateDir, f.worker, root);
    expect(restarted.pendingEvents("toy-run")).toEqual([{ key: "wake-1", payload: "check the next checkpoint" }]);
    restarted.ackEvent("toy-run", "wake-1");
    expect(f.runner.pendingEvents("toy-run")).toEqual([]);
    expect(f.runner.event("toy-run", "wake-1", "check the next checkpoint").duplicate).toBe(true);
    expect(f.runner.pendingEvents("toy-run")).toEqual([]);
    f.runner.event("toy-run", "wake-before-stop", "finish the run");
    f.runner.cancel("toy-run", "captain", "finished");
    f.runner.ackEvent("toy-run", "wake-before-stop");
    expect(f.runner.status("toy-run").events["wake-before-stop"]?.acted).toBe(true);
    expect(f.runner.event("toy-run", "wake-after-stop", "resume").terminal).toBe(true);
    expect(f.runner.pendingEvents("toy-run")).toEqual([]);
  });

  test("transport-scoped event keys remain usable without prototype-key collisions", () => {
    const f = fixture();
    f.runner.start("toy-run", f.path, "implementer-1", f.revision, standing(f));
    expect(f.runner.event("toy-run", "ci:run/42", "check finished").duplicate).toBe(false);
    expect(f.runner.pendingEvents("toy-run")).toEqual([{ key: "ci:run/42", payload: "check finished" }]);
    expect(() => f.runner.event("toy-run", "__proto__", "instruction")).toThrow("invalid event key");
  });

  test("live runner wakes a configured event consumer and reports guided mode without a loop", async () => {
    const f = fixture();
    withAuditCadence(f);
    f.runner.start("toy-run", f.path, "implementer-1", f.revision, standing(f));
    const receipt = join(f.privateDir, "source.txt");
    writeFileSync(receipt, "source evidence");
    f.runner.collect("toy-run", "e1", receipt, f.revision, "source");
    card(f, "guided-align");
    const socket = join(f.privateDir, "runner.sock");
    const config = join(f.privateDir, "event.json");
    const log = join(f.privateDir, "delivered.json");
    const tokenFile = join(f.privateDir, "admin.token");
    const adminToken = "a".repeat(48);
    const workerToken = "b".repeat(48);
    writeFileSync(tokenFile, adminToken, { mode: 0o600 });
    writeFileSync(
      config,
      JSON.stringify({
        timeout_ms: 10_000,
        command: [
          process.execPath,
          "-e",
          "const e=JSON.parse(await Bun.stdin.text()); const t=process.argv[1]+'.tmp'; await Bun.write(t, JSON.stringify(e)); (await import('node:fs')).renameSync(t, process.argv[1]); console.log(JSON.stringify({run:e.run,key:e.key}));",
          log,
        ],
      }),
    );
    const service = spawnLive(
      [
        process.execPath,
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
        tokenFile,
        "--event-config",
        config,
      ],
      { cwd: root, env: { ...process.env, AK_RUNNER_WORKER_TOKEN: workerToken }, stdout: "pipe", stderr: "pipe" },
    );
    try {
      await waitForPath(socket, service);
      const request = join(f.requestDir, "event.json");
      writeFileSync(request, JSON.stringify({ run: "toy-run" }));
      const status = callRunnerCli("status", request, socket, workerToken);
      expect(autonomyOf(status)).toEqual({
        mode: "guided",
        missing: ["loop-adapter"],
      });
      writeFileSync(request, JSON.stringify({ run: "toy-run", card_id: "guided-align" }));
      const refused = callRunnerCli("decide", request, socket, workerToken);
      expect(refused.exitCode).toBe(1);
      expect(refused.stderr.toString()).toContain("guided mode");
      writeFileSync(request, JSON.stringify({ run: "toy-run", key: "wake-1", payload: "check the checkpoint" }));
      expect(callRunnerCli("event", request, socket, adminToken).exitCode).toBe(0);
      await waitForPath(log, service);
      expect(JSON.parse(readFileSync(log, "utf8"))).toMatchObject({
        run: "toy-run",
        key: "wake-1",
        payload: "check the checkpoint",
      });
      await waitUntil("pending events to clear", () => f.runner.pendingEvents("toy-run").length === 0);
      expect(f.runner.pendingEvents("toy-run")).toEqual([]);
    } finally {
      service.kill("SIGTERM");
      await service.exited;
    }
  });

  test("shutdown ends an adapter's whole process group", async () => {
    const f = ready();
    const socket = join(f.privateDir, "runner.sock");
    const adminToken = "a".repeat(48);
    const tokenFile = join(f.privateDir, "admin.token");
    writeFileSync(tokenFile, adminToken, { mode: 0o600 });
    const pidFile = join(f.privateDir, "descendant.pid");
    const hang = writeHangHelper(f.privateDir);
    const eventConfig = join(f.privateDir, "event.json");
    writeFileSync(
      eventConfig,
      JSON.stringify({
        timeout_ms: 300_000,
        command: ["sh", "-c", `node ${shQuote(hang)} ${shQuote(pidFile)} ${process.pid} & wait`],
      }),
    );
    const service = spawnLive(
      [
        process.execPath,
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
        tokenFile,
        "--event-config",
        eventConfig,
      ],
      {
        cwd: root,
        env: { ...process.env, AK_RUNNER_WORKER_TOKEN: "b".repeat(48) },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    try {
      await waitForPath(socket, service);
      const request = join(f.requestDir, "event.json");
      writeFileSync(request, JSON.stringify({ run: "toy-run", key: "wake-1", payload: "check" }));
      expect(callRunnerCli("event", request, socket, adminToken).exitCode).toBe(0);
      await waitUntil("the adapter to start", () => {
        if (!existsSync(pidFile)) return false;
        const pid = Number(readFileSync(pidFile, "utf8").trim());
        if (!Number.isInteger(pid) || pid <= 0) return false;
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      });
      const descendant = readLivePid(pidFile);
      const alive = () => {
        try {
          process.kill(descendant, 0);
          return true;
        } catch {
          return false;
        }
      };
      expect(alive()).toBe(true);
      service.kill("SIGTERM");
      await service.exited;
      await waitUntil("the adapter's descendant to die", () => !alive());
    } finally {
      service.kill("SIGKILL");
    }
  }, 60_000);

  test("failed event delivery goes guided and restart replays it", async () => {
    const f = fixture();
    withAuditCadence(f);
    f.runner.start("toy-run", f.path, "implementer-1", f.revision, standing(f));
    const socket = join(f.privateDir, "runner.sock");
    const eventConfig = join(f.privateDir, "event.json");
    const loopConfig = join(f.privateDir, "loop.json");
    const delivered = join(f.privateDir, "delivered");
    const tokenFile = join(f.privateDir, "admin.token");
    const adminToken = "a".repeat(48);
    const workerToken = "b".repeat(48);
    writeFileSync(tokenFile, adminToken, { mode: 0o600 });
    // The first consumer never answers, so its timeout fails delivery however long the host takes to start it.
    writeFileSync(
      eventConfig,
      JSON.stringify({ timeout_ms: 100, command: [process.execPath, "-e", "await Bun.sleep(60_000);"] }),
    );
    writeFileSync(
      loopConfig,
      JSON.stringify({
        timeout_ms: 1000,
        command: [
          process.execPath,
          "-e",
          "const x=JSON.parse(await Bun.stdin.text()); console.log(JSON.stringify({probed:x.delegates,progress:[]}));",
        ],
      }),
    );
    const launch = [
      process.execPath,
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
      tokenFile,
      "--event-config",
      eventConfig,
      "--loop-config",
      loopConfig,
    ];
    const options = {
      cwd: root,
      env: { ...process.env, AK_RUNNER_WORKER_TOKEN: workerToken },
      stdout: "pipe" as const,
      stderr: "pipe" as const,
    };
    let service = spawnLive(launch, options);
    try {
      await waitForPath(socket, service);
      const request = join(f.requestDir, "event.json");
      writeFileSync(request, JSON.stringify({ run: "toy-run", key: "wake-1", payload: "check" }));
      expect(callRunnerCli("event", request, socket, adminToken).exitCode).toBe(0);
      writeFileSync(request, JSON.stringify({ run: "toy-run" }));
      await waitUntil("status to report event-delivery-failed", () =>
        autonomyOf(callRunnerCli("status", request, socket, workerToken)).missing.includes("event-delivery-failed"),
      );
      expect(f.runner.pendingEvents("toy-run")).toHaveLength(1);
      service.kill("SIGTERM");
      await service.exited;
      expect(await new Response(service.stderr).text()).toContain(
        "event wake-1 remains pending: adapter command timed out after 100ms",
      );
      writeFileSync(
        eventConfig,
        JSON.stringify({
          timeout_ms: 10_000,
          command: [
            process.execPath,
            "-e",
            "const e=JSON.parse(await Bun.stdin.text()); await Bun.write(process.argv[1], e.key); console.log(JSON.stringify({run:e.run,key:e.key}));",
            delivered,
          ],
        }),
      );
      service = spawnLive(launch, options);
      await waitForPath(socket, service);
      await waitUntil(
        "replayed wake-1 to be written",
        () => existsSync(delivered) && readFileSync(delivered, "utf8") === "wake-1",
        20_000,
      );
      expect(readFileSync(delivered, "utf8")).toBe("wake-1");
      await waitUntil("the replayed event to be acknowledged", () => f.runner.pendingEvents("toy-run").length === 0);
    } finally {
      service.kill("SIGTERM");
      await service.exited;
    }
  });

  test("outage backoff acknowledges a recovered event after the first retry delay", async () => {
    const f = fixture();
    withAuditCadence(f, undefined, 300);
    f.runner.start("toy-run", f.path, "implementer-1", f.revision, standing(f));
    const clock = join(f.privateDir, "clock");
    const started = join(f.privateDir, "consumer-started");
    const release = join(f.privateDir, "consumer-release");
    writeFileSync(clock, "0\n");
    const { socket, service, adminToken, workerToken, request } = serveEvents(f, clock, [
      process.execPath,
      "-e",
      "const fs=await import('node:fs'); const started=process.argv[1]; const release=process.argv[2]; fs.appendFileSync(started,'x'); if(!fs.existsSync(release)) await Bun.sleep(60_000); const e=JSON.parse(await Bun.stdin.text()); console.log(JSON.stringify({run:e.run,key:e.key}));",
      started,
      release,
    ]);
    try {
      await waitForPath(socket, service);
      writeFileSync(request, JSON.stringify({ run: "toy-run", key: "wake-1", payload: "check" }));
      expect(callRunnerCli("event", request, socket, adminToken).exitCode).toBe(0);
      await waitUntil("the event consumer to start", () => existsSync(started));
      await Bun.sleep(250);
      writeFileSync(request, JSON.stringify({ run: "toy-run" }));
      expect(autonomyOf(callRunnerCli("status", request, socket, workerToken))).toEqual({
        mode: "autonomous",
        missing: [],
      });
      writeFileSync(release, "go\n");
      writeFileSync(clock, "5000\n");
      await waitUntil("the retried event to be acknowledged", () => f.runner.pendingEvents("toy-run").length === 0);
      expect(autonomyOf(callRunnerCli("status", request, socket, workerToken))).toEqual({
        mode: "autonomous",
        missing: [],
      });
    } finally {
      service.kill("SIGTERM");
      await service.exited;
    }
  });

  test("outage backoff names event-delivery-failed only after a retry and the window", async () => {
    const f = fixture();
    withAuditCadence(f, undefined, 300);
    f.runner.start("toy-run", f.path, "implementer-1", f.revision, standing(f));
    const clock = join(f.privateDir, "clock");
    const started = join(f.privateDir, "consumer-started");
    writeFileSync(clock, "0\n");
    const { socket, service, adminToken, workerToken, request } = serveEvents(f, clock, [
      process.execPath,
      "-e",
      "const fs=await import('node:fs'); fs.appendFileSync(process.argv[1],'x'); await Bun.sleep(60_000);",
      started,
    ]);
    try {
      await waitForPath(socket, service);
      writeFileSync(request, JSON.stringify({ run: "toy-run", key: "wake-1", payload: "check" }));
      expect(callRunnerCli("event", request, socket, adminToken).exitCode).toBe(0);
      await waitUntil(
        "the event consumer to start",
        () => existsSync(started) && readFileSync(started, "utf8").length >= 1,
      );
      await Bun.sleep(250);
      writeFileSync(request, JSON.stringify({ run: "toy-run" }));
      expect(autonomyOf(callRunnerCli("status", request, socket, workerToken))).toEqual({
        mode: "autonomous",
        missing: [],
      });
      writeFileSync(clock, "5000\n");
      await waitUntil("the event consumer to retry", () => readFileSync(started, "utf8").length >= 2);
      expect(autonomyOf(callRunnerCli("status", request, socket, workerToken))).toEqual({
        mode: "autonomous",
        missing: [],
      });
      writeFileSync(clock, "300000\n");
      await waitUntil("status to report event-delivery-failed", () =>
        autonomyOf(callRunnerCli("status", request, socket, workerToken)).missing.includes("event-delivery-failed"),
      );
      expect(autonomyOf(callRunnerCli("status", request, socket, workerToken))).toEqual({
        mode: "guided",
        missing: ["event-delivery-failed"],
      });
    } finally {
      service.kill("SIGTERM");
      await service.exited;
    }
  });

  test("a clock jump then freeze still retries a pending event inside the window", async () => {
    const f = fixture();
    withAuditCadence(f, undefined, 300);
    f.runner.start("toy-run", f.path, "implementer-1", f.revision, standing(f));
    const clock = join(f.privateDir, "clock");
    const stamp = join(f.privateDir, "consumer-stamp");
    writeFileSync(clock, "0\n");
    const { socket, service, adminToken, workerToken, request } = serveEvents(f, clock, [
      process.execPath,
      "-e",
      "const fs=await import('node:fs'); fs.appendFileSync(process.argv[1],'x'); throw new Error('transient');",
      stamp,
    ]);
    try {
      await waitForPath(socket, service);
      writeFileSync(request, JSON.stringify({ run: "toy-run", key: "wake-1", payload: "check" }));
      expect(callRunnerCli("event", request, socket, adminToken).exitCode).toBe(0);
      await waitUntil(
        "the first failing consumer to run",
        () => existsSync(stamp) && readFileSync(stamp, "utf8").length >= 1,
      );
      await Bun.sleep(250);
      writeFileSync(clock, "5000\n");
      await waitUntil("the first backoff retry to run", () => readFileSync(stamp, "utf8").length >= 2);
      writeFileSync(request, JSON.stringify({ run: "toy-run" }));
      expect(autonomyOf(callRunnerCli("status", request, socket, workerToken))).toEqual({
        mode: "autonomous",
        missing: [],
      });
      await waitUntil(
        "the frozen clock to retry the pending event on real elapsed",
        () => readFileSync(stamp, "utf8").length >= 3,
        20_000,
      );
      expect(readFileSync(clock, "utf8").trim()).toBe("5000");
      expect(autonomyOf(callRunnerCli("status", request, socket, workerToken))).toEqual({
        mode: "autonomous",
        missing: [],
      });
    } finally {
      service.kill("SIGTERM");
      await service.exited;
    }
  }, 25_000);

  test("a pending event with a broken payload hash goes guided on the first failure", async () => {
    const f = fixture();
    withAuditCadence(f, undefined, 300);
    f.runner.start("toy-run", f.path, "implementer-1", f.revision, standing(f));
    f.runner.event("toy-run", "wake-1", "check");
    const runPath = join(f.privateDir, "toy-run.json");
    const run = parseJson(readFileSync(runPath, "utf8"));
    if (!(run instanceof Object) || Array.isArray(run) || !("events" in run))
      throw new Error("run state events missing");
    const events = run.events;
    if (!(events instanceof Object) || Array.isArray(events) || !("wake-1" in events))
      throw new Error("wake-1 missing from run state");
    const stored = events["wake-1"];
    if (!(stored instanceof Object) || Array.isArray(stored)) throw new Error("wake-1 missing from run state");
    stored.payload = "tampered";
    writeFileSync(runPath, JSON.stringify(run));
    const clock = join(f.privateDir, "clock");
    writeFileSync(clock, "0\n");
    const { socket, service, workerToken, request } = serveEvents(f, clock, [
      process.execPath,
      "-e",
      "const e=JSON.parse(await Bun.stdin.text()); console.log(JSON.stringify({run:e.run,key:e.key}));",
    ]);
    try {
      await waitForPath(socket, service);
      writeFileSync(request, JSON.stringify({ run: "toy-run" }));
      await waitUntil("status to name event-delivery-failed at clock 0", () =>
        autonomyOf(callRunnerCli("status", request, socket, workerToken)).missing.includes("event-delivery-failed"),
      );
      expect(autonomyOf(callRunnerCli("status", request, socket, workerToken))).toEqual({
        mode: "guided",
        missing: ["event-delivery-failed"],
      });
    } finally {
      service.kill("SIGTERM");
      await service.exited;
    }
  });

  test("a recovered event delivery resets the delivery outage window", async () => {
    const f = fixture();
    withAuditCadence(f, undefined, 300);
    f.runner.start("toy-run", f.path, "implementer-1", f.revision, standing(f));
    const clock = join(f.privateDir, "clock");
    const started = join(f.privateDir, "consumer-started");
    const release = join(f.privateDir, "consumer-release");
    writeFileSync(clock, "0\n");
    const { socket, service, adminToken, workerToken, request } = serveEvents(f, clock, [
      process.execPath,
      "-e",
      "const fs=await import('node:fs'); const started=process.argv[1]; const release=process.argv[2]; fs.appendFileSync(started,'x'); if(!fs.existsSync(release)) await Bun.sleep(60_000); const e=JSON.parse(await Bun.stdin.text()); console.log(JSON.stringify({run:e.run,key:e.key}));",
      started,
      release,
    ]);
    try {
      await waitForPath(socket, service);
      writeFileSync(request, JSON.stringify({ run: "toy-run", key: "wake-1", payload: "first" }));
      expect(callRunnerCli("event", request, socket, adminToken).exitCode).toBe(0);
      await waitUntil("the first event consumer to start", () => existsSync(started));
      await Bun.sleep(250);
      writeFileSync(release, "go\n");
      writeFileSync(clock, "5000\n");
      await waitUntil("the first event to be acknowledged", () => f.runner.pendingEvents("toy-run").length === 0);
      unlinkSync(release);
      writeFileSync(request, JSON.stringify({ run: "toy-run", key: "wake-2", payload: "second" }));
      expect(callRunnerCli("event", request, socket, adminToken).exitCode).toBe(0);
      await waitUntil("the second event consumer to start", () => readFileSync(started, "utf8").length >= 3);
      await Bun.sleep(250);
      writeFileSync(request, JSON.stringify({ run: "toy-run" }));
      writeFileSync(clock, "300000\n");
      await Bun.sleep(200);
      expect(autonomyOf(callRunnerCli("status", request, socket, workerToken))).toEqual({
        mode: "autonomous",
        missing: [],
      });
      writeFileSync(clock, "600000\n");
      await waitUntil("status to name event-delivery-failed after the reset window", () =>
        autonomyOf(callRunnerCli("status", request, socket, workerToken)).missing.includes("event-delivery-failed"),
      );
      expect(autonomyOf(callRunnerCli("status", request, socket, workerToken))).toEqual({
        mode: "guided",
        missing: ["event-delivery-failed"],
      });
    } finally {
      service.kill("SIGTERM");
      await service.exited;
    }
  });

  test("an overlapping event during an in-flight timeout waits for the outage backoff", async () => {
    const f = fixture();
    withAuditCadence(f, undefined, 300);
    f.runner.start("toy-run", f.path, "implementer-1", f.revision, standing(f));
    const clock = join(f.privateDir, "clock");
    const started = join(f.privateDir, "consumer-started");
    writeFileSync(clock, "0\n");
    const { socket, service, adminToken, workerToken, request } = serveEvents(
      f,
      clock,
      [
        process.execPath,
        "-e",
        "const fs=await import('node:fs'); fs.appendFileSync(process.argv[1],'x'); await Bun.sleep(60_000);",
        started,
      ],
      2_000,
    );
    try {
      await waitForPath(socket, service);
      writeFileSync(request, JSON.stringify({ run: "toy-run", key: "wake-1", payload: "first" }));
      expect(callRunnerCli("event", request, socket, adminToken).exitCode).toBe(0);
      await waitUntil(
        "the first event consumer to start",
        () => existsSync(started) && readFileSync(started, "utf8").length >= 1,
      );
      writeFileSync(request, JSON.stringify({ run: "toy-run", key: "wake-2", payload: "second" }));
      expect(callRunnerCli("event", request, socket, adminToken).exitCode).toBe(0);
      await Bun.sleep(2_500);
      expect(readFileSync(started, "utf8").length).toBe(1);
      writeFileSync(request, JSON.stringify({ run: "toy-run" }));
      expect(autonomyOf(callRunnerCli("status", request, socket, workerToken))).toEqual({
        mode: "autonomous",
        missing: [],
      });
      writeFileSync(clock, "5000\n");
      await waitUntil("the backoff retry to spawn", () => readFileSync(started, "utf8").length >= 2);
    } finally {
      service.kill("SIGTERM");
      await service.exited;
    }
  });

  test.each(["order", "code", "evidence"])("priority question continues with a supported %s answer", (kind) => {
    const f = ready();
    const answer = `answer from ${kind}\n`;
    const before = f.runner.status("toy-run");
    expect(
      f.runner.question("toy-run", "q1", "Which command?", { text: answer, source: kind, ref: "source:42" }),
    ).toEqual({
      action: "continue",
      answer,
      evidence: "source:42",
    });
    const output: string[] = [];
    f.runner.emitQuestionBlocker("toy-run", (text) => output.push(text), Date.now() + 600_000);
    expect(output).toEqual([]);
    expect(f.runner.status("toy-run").next_permitted_action).toBe(before.next_permitted_action);
    expect(f.runner.status("toy-run").run_state).toBe(before.run_state);
  });

  test("priority question continues an order answer and emits the blocker at a fixed ten-minute deadline", () => {
    const f = ready();
    const start = Date.parse("2026-11-14T10:00:00.000Z");
    const before = f.runner.status("toy-run");
    const output: string[] = [];
    expect(
      f.runner.question(
        "toy-run",
        "answered",
        "Which command?",
        {
          text: "bun test",
          source: "order",
          ref: "order:verification",
        },
        start,
      ),
    ).toEqual({ action: "continue", answer: "bun test", evidence: "order:verification" });
    f.runner.emitQuestionBlocker("toy-run", (text) => output.push(text), start);
    expect(output).toEqual([]);
    expect(f.runner.status("toy-run").run_state).toBe(before.run_state);
    expect(f.runner.status("toy-run").next_permitted_action).toBe(before.next_permitted_action);
    const need = "Missing environment access\nScope: staging";
    expect(f.runner.question("toy-run", "q1", need, undefined, start).action).toBe("investigate");
    expect(f.runner.question("toy-run", "q1", need, undefined, start + 599_999).action).toBe("investigate");
    expect(() => f.runner.question("toy-run", "q2", need, undefined, start + 599_999)).toThrow(
      "open priority question",
    );
    expect(() => f.runner.question("toy-run", "q1", "replacement", undefined, start + 599_999)).toThrow("changed");
    const restarted = new Runner(f.privateDir, f.worker, root);
    restarted.emitQuestionBlocker("toy-run", (text) => output.push(text), start + 599_999);
    expect(output).toEqual([]);
    expect(restarted.question("toy-run", "q1", need, undefined, start + 600_000).action).toBe("blocked");
    restarted.emitQuestionBlocker("toy-run", (text) => output.push(text), start + 600_000);
    expect(output).toEqual([need]);
  });

  test("priority question resolution preserves approval stops and permits the next question", () => {
    const f = ready();
    const start = Date.now();
    f.runner.question("toy-run", "q1", "Need command", undefined, start);
    expect(split(f, "card-1", ["yes", "no"]).status).toBe("needs-input");
    expect(
      f.runner.question(
        "toy-run",
        "q1",
        "Need command",
        {
          text: "bun test",
          source: "code",
          ref: "package.json:12",
        },
        start + 100,
      ).action,
    ).toBe("continue");
    expect(f.runner.status("toy-run").run_state).toBe("needs-input");
    expect(f.runner.status("toy-run").next_permitted_action).toBeNull();
    expect(f.runner.questionDeadline("toy-run")).toBeNull();
    f.runner.question("toy-run", "q2", "Need access", undefined, start + 200);
    const output: string[] = [];
    f.runner.emitQuestionBlocker("toy-run", (text) => output.push(text), start + 600_000);
    expect(output).toEqual([]);
    f.runner.emitQuestionBlocker("toy-run", (text) => output.push(text), start + 600_200);
    expect(output).toEqual(["Need access"]);
  });

  test("priority question rejects unsupported answers without losing its deadline", () => {
    const f = ready();
    const start = Date.now();
    f.runner.question("toy-run", "q1", "Need an answer", undefined, start);
    for (const answer of [
      { text: "", source: "code", ref: "file.ts:1" },
      { text: "answer", source: "code", ref: "" },
      { text: "answer", source: "guess", ref: "unsupported" },
    ]) {
      expect(() => f.runner.question("toy-run", "q1", "Need an answer", answer)).toThrow("priority answer needs");
    }
    expect(f.runner.questionDeadline("toy-run")).toBe(start + 600_000);
  });

  test("priority question service emits once despite status requests, question retries and audit ticks", async () => {
    const f = fixture();
    withAuditCadence(f);
    f.runner.start("toy-run", f.path, "implementer-1", f.revision, standing(f));
    f.runner.registerDelegate("toy-run", "owner-1", 3600);
    const loopConfig = join(f.privateDir, "loop.json");
    writeFileSync(
      loopConfig,
      JSON.stringify({
        timeout_ms: 2000,
        command: [
          "bun",
          "-e",
          `const input=JSON.parse(await Bun.stdin.text());
        console.log(JSON.stringify({probed:input.delegates,
          progress:[{delegate:input.delegates[0],kind:"store-report",ref:"probe-"+Date.now()}]}));`,
        ],
      }),
    );
    const need = "Exact priority blocker";
    f.runner.question("toy-run", "q1", need, undefined, Date.now() - 598_000);
    const socket = join(f.privateDir, "runner.sock");
    const tokenFile = join(f.privateDir, "admin.token");
    writeFileSync(tokenFile, "a".repeat(48), { mode: 0o600 });
    const service = spawnLive(
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
        tokenFile,
        "--loop-config",
        loopConfig,
      ],
      { cwd: root, env: { ...process.env, AK_RUNNER_WORKER_TOKEN: "b".repeat(48) } },
    );
    const reader = service.stderr.getReader();
    try {
      await waitForPath(socket, service);
      const request = join(f.requestDir, "question.json");
      writeFileSync(request, JSON.stringify({ run: "toy-run", id: "q1", source: need }));
      expect(callRunnerCli("question", request, socket, "b".repeat(48)).exitCode).toBe(0);
      const output = await reader.read();
      expect(new TextDecoder().decode(output.value).trim()).toBe(need);
      const probesBefore = f.runner.status("toy-run").delegates?.["owner-1"]?.progress.length ?? 0;
      const statusRequest = join(f.requestDir, "status.json");
      writeFileSync(statusRequest, JSON.stringify({ run: "toy-run" }));
      expect(callRunnerCli("status", statusRequest, socket, "b".repeat(48)).exitCode).toBe(0);
      expect(callRunnerCli("status", statusRequest, socket, "b".repeat(48)).exitCode).toBe(0);
      expect(callRunnerCli("question", request, socket, "b".repeat(48)).exitCode).toBe(0);
      await waitUntil(
        "another audit probe",
        () => (f.runner.status("toy-run").delegates?.["owner-1"]?.progress.length ?? 0) > probesBefore,
      );
    } finally {
      service.kill("SIGTERM");
      await service.exited;
    }
    const remaining: string[] = [];
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      remaining.push(new TextDecoder().decode(chunk.value));
    }
    reader.releaseLock();
    expect(remaining.join("")).toBe("");
  }, 30_000);

  test("audit replaces silent owners and stalled replacements, then drains only after children finish", () => {
    const f = fixture();
    withAuditCadence(f);
    f.runner.start("toy-run", f.path, "implementer-1", f.revision, standing(f));
    const started = Date.parse("2026-10-16T18:00:00Z");
    f.runner.registerDelegate("toy-run", "owner-1", 1, undefined, started);
    f.runner.registerDelegate("toy-run", "child-1", 10, "owner-1", started);
    expect(f.runner.auditTick("toy-run", started + 2_000).replace).toEqual(["owner-1"]);
    f.runner.replaceDelegate("toy-run", "owner-1", "owner-2", 1, started + 2_000);
    expect(f.runner.auditTick("toy-run", started + 4_000).replace).toEqual(["owner-2"]);
    expect(() => f.runner.recordProgress("toy-run", "child-1", "narration", "still working")).toThrow("side effect");
    f.runner.recordProgress("toy-run", "child-1", "commit", f.revision);
    f.runner.finishDelegate("toy-run", "owner-2");
    expect(f.runner.auditTick("toy-run", started + 5_000).drained).toBe(false);
    f.runner.finishDelegate("toy-run", "child-1");
    expect(f.runner.auditTick("toy-run", started + 6_000).drained).toBe(true);
  });

  test("an early side effect does not protect a delegate that later hangs", () => {
    const f = fixture();
    withAuditCadence(f);
    f.runner.start("toy-run", f.path, "implementer-1", f.revision, standing(f));
    const started = Date.parse("2026-10-16T18:00:00Z");
    f.runner.registerDelegate("toy-run", "owner-1", 10, undefined, started);
    f.runner.recordProgress("toy-run", "owner-1", "commit", f.revision, started + 1_000);
    expect(f.runner.auditTick("toy-run", started + 10_000).replace).toEqual([]);
    expect(f.runner.auditTick("toy-run", started + 12_000).replace).toEqual(["owner-1"]);
    f.runner.replaceDelegate("toy-run", "owner-1", "owner-2", 10, started + 12_000);
    expect(f.runner.status("toy-run").delegates?.["owner-1"]?.state).toBe("replaced");
  });

  test("a silent child stays replaceable after its owner is replaced or finishes", () => {
    const f = fixture();
    withAuditCadence(f);
    f.runner.start("toy-run", f.path, "implementer-1", f.revision, standing(f));
    const started = Date.parse("2026-10-16T18:00:00Z");
    f.runner.registerDelegate("toy-run", "owner-1", 1, undefined, started);
    f.runner.registerDelegate("toy-run", "child-1", 1, "owner-1", started);
    expect(f.runner.auditTick("toy-run", started + 2_000).replace).toEqual(["owner-1", "child-1"]);
    f.runner.replaceDelegate("toy-run", "owner-1", "owner-2", 10, started + 2_000);
    f.runner.replaceDelegate("toy-run", "child-1", "child-2", 1, started + 2_000);
    expect(f.runner.status("toy-run").delegates?.["child-2"]?.parent).toBe("owner-2");
    f.runner.finishDelegate("toy-run", "owner-2");
    f.runner.replaceDelegate("toy-run", "child-2", "child-3", 10, started + 4_000);
    expect(f.runner.status("toy-run").delegates?.["child-3"]?.state).toBe("active");
  });

  // GAP-20 closed for audit-cadence runs; residue: a run without audit_cadence_seconds never
  // re-checks its recorded bundle procedure, and nothing else does. policies/invocation.yaml
  // is an unhashed input the captain can choose to add later.
  test("an audit tick stops when the recorded bundle procedure changes", () => {
    const f = procedureKit();
    f.runner.start("toy-run", f.path, "implementer-1", f.revision, standing(f));
    const before = f.runner.auditTick("toy-run");
    expect(before.procedure.bundle_version).toBeDefined();
    expect(before.procedure.hash).toMatch(/^sha256:[a-f0-9]{64}$/);
    upgradeProcedure(f.kit);
    expect(() => f.runner.auditTick("toy-run")).toThrow("recorded bundle procedure changed; audit cannot continue");
    expect(f.runner.status("toy-run").procedure).toEqual(before.procedure);
  });

  test("an audit tick stops when only the recorded bundle version changes", () => {
    const f = procedureKit();
    f.runner.start("toy-run", f.path, "implementer-1", f.revision, standing(f));
    const before = f.runner.auditTick("toy-run");
    const skillPath = join(f.kit, "skills/autopilot/SKILL.md");
    const skillBefore = readFileSync(skillPath, "utf8");
    upgradeProcedure(f.kit, { skill: false });
    expect(readFileSync(skillPath, "utf8")).toBe(skillBefore);
    expect(() => f.runner.auditTick("toy-run")).toThrow("recorded bundle procedure changed; audit cannot continue");
    expect(f.runner.status("toy-run").procedure).toEqual(before.procedure);
  });

  test("an audit tick stops when the recorded skill changes without a version bump", () => {
    const f = procedureKit();
    f.runner.start("toy-run", f.path, "implementer-1", f.revision, standing(f));
    const before = f.runner.auditTick("toy-run");
    const upgraded = upgradeProcedure(f.kit, { version: false });
    expect(readFileSync(upgraded.manifestPath, "utf8")).toBe(upgraded.originalManifest);
    expect(() => f.runner.auditTick("toy-run")).toThrow("recorded bundle procedure changed; audit cannot continue");
    expect(f.runner.status("toy-run").procedure).toEqual(before.procedure);
  });

  test("an audit tick stops when only the recorded checkpoints procedure changes", () => {
    const f = procedureKit();
    f.runner.start("toy-run", f.path, "implementer-1", f.revision, standing(f));
    const before = f.runner.auditTick("toy-run");
    const skillPath = join(f.kit, "skills/autopilot/SKILL.md");
    const skillBefore = readFileSync(skillPath, "utf8");
    const manifestPath = join(f.kit, "package.json");
    const manifestBefore = readFileSync(manifestPath, "utf8");
    const checkpointsPath = join(f.kit, "skills/autopilot/references/checkpoints.md");
    writeFileSync(checkpointsPath, `${readFileSync(checkpointsPath, "utf8")}\n# upgraded checkpoints\n`);
    expect(readFileSync(skillPath, "utf8")).toBe(skillBefore);
    expect(readFileSync(manifestPath, "utf8")).toBe(manifestBefore);
    expect(() => f.runner.auditTick("toy-run")).toThrow("recorded bundle procedure changed; audit cannot continue");
    expect(f.runner.status("toy-run").procedure).toEqual(before.procedure);
  });

  test("an audit stop for a changed procedure does not rewrite blocked decisions or evidence", () => {
    const f = procedureKit();
    f.runner.start("toy-run", f.path, "implementer-1", f.revision, standing(f));
    const log = join(f.privateDir, "log.txt");
    writeFileSync(log, "independently collected verification");
    f.runner.collect("toy-run", "e1", log, f.revision, "source");
    expect(split(f, "split", ["yes", "no"]).status).toBe("needs-input");
    const decisionFile = join(f.privateDir, "toy-run-split.decision.json");
    const blocked = parseJson(readFileSync(decisionFile, "utf8"));
    if (!(blocked instanceof Object) || Array.isArray(blocked)) throw new Error("expected decision object");
    expect(blocked).toMatchObject({ status: "blocked" });
    const evidence = f.runner.status("toy-run").evidence["e1"];
    expect(evidence?.hash).toMatch(/^sha256:[a-f0-9]{64}$/);
    const recorded = f.runner.status("toy-run").procedure;
    if (recorded === undefined) throw new Error("run recorded no procedure");
    const upgraded = upgradeProcedure(f.kit);
    expect(() => f.runner.auditTick("toy-run")).toThrow("recorded bundle procedure changed; audit cannot continue");
    expect(f.runner.status("toy-run").run_state).toBe("needs-input");
    expect(f.runner.status("toy-run").evidence["e1"]).toEqual(evidence);
    expect(JSON.parse(readFileSync(decisionFile, "utf8"))).toMatchObject({ status: "blocked" });
    writeFileSync(upgraded.skillPath, upgraded.originalSkill);
    writeFileSync(upgraded.manifestPath, upgraded.originalManifest);
    const resumed = f.runner.auditTick("toy-run");
    expect(resumed.procedure).toEqual(recorded);
    expect(f.runner.status("toy-run").run_state).toBe("needs-input");
    expect(f.runner.status("toy-run").evidence["e1"]).toEqual(evidence);
    expect(JSON.parse(readFileSync(decisionFile, "utf8"))).toMatchObject({ status: "blocked" });
  });

  test("live charter tick calls the supervisor adapter to replace an overdue delegate", async () => {
    const f = fixture();
    withAuditCadence(f, 3);
    f.runner.start("toy-run", f.path, "implementer-1", f.revision, standing(f));
    f.runner.registerDelegate("toy-run", "owner-1", 1, undefined, Date.now() - 3_000);
    const socket = join(f.privateDir, "runner.sock");
    const eventConfig = join(f.privateDir, "event.json");
    const loopConfig = join(f.privateDir, "loop.json");
    const replacementLog = join(f.privateDir, "replaced.json");
    const tokenFile = join(f.privateDir, "admin.token");
    writeFileSync(tokenFile, "a".repeat(48), { mode: 0o600 });
    writeFileSync(
      eventConfig,
      JSON.stringify({
        timeout_ms: 10_000,
        command: [
          process.execPath,
          "-e",
          "const e=JSON.parse(await Bun.stdin.text()); console.log(JSON.stringify({run:e.run,key:e.key}));",
        ],
      }),
    );
    writeFileSync(
      loopConfig,
      JSON.stringify({
        timeout_ms: 10_000,
        command: [
          process.execPath,
          "-e",
          "const x=JSON.parse(await Bun.stdin.text()); if(x.action==='probe') console.log(JSON.stringify({probed:x.delegates,progress:[]})); else { await Bun.write(process.argv[1],JSON.stringify(x)); console.log(JSON.stringify({stood_down:true,replacement:'owner-2',expected_runtime_seconds:3600,key:x.key})); }",
          replacementLog,
        ],
      }),
    );
    const service = spawnLive(
      [
        process.execPath,
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
        tokenFile,
        "--event-config",
        eventConfig,
        "--loop-config",
        loopConfig,
      ],
      { cwd: root, env: { ...process.env, AK_RUNNER_WORKER_TOKEN: "b".repeat(48) }, stdout: "pipe", stderr: "pipe" },
    );
    try {
      await waitForPath(socket, service);
      const request = join(f.requestDir, "status.json");
      writeFileSync(request, JSON.stringify({ run: "toy-run" }));
      expect(autonomyOf(callRunnerCli("status", request, socket, "b".repeat(48)))).toEqual({
        mode: "autonomous",
        missing: [],
      });
      await waitForPath(replacementLog, service);
      await waitUntil(
        "replacement delegate to be recorded",
        () => f.runner.status("toy-run").delegates?.["owner-2"] !== undefined,
      );
      expect(f.runner.status("toy-run").delegates?.["owner-1"]?.state).toBe("replaced");
      expect(f.runner.status("toy-run").delegates?.["owner-2"]?.state).toBe("active");
      expect(autonomyOf(callRunnerCli("status", request, socket, "b".repeat(48)))).toEqual({
        mode: "autonomous",
        missing: [],
      });
    } finally {
      service.kill("SIGTERM");
      await service.exited;
    }
  });

  test("one probe failure followed by a successful retry keeps autonomous mode", async () => {
    const f = fixture();
    withAuditCadence(f, 20);
    f.runner.start("toy-run", f.path, "implementer-1", f.revision, standing(f));
    f.runner.registerDelegate("toy-run", "owner-1", 3_600);
    const stamp = join(f.privateDir, "probe-attempt");
    const release = `${stamp}.release`;
    const script = [
      "const x=JSON.parse(await Bun.stdin.text());",
      "const fs=await import('node:fs');",
      "const stamp=process.argv[1];",
      "if(x.action!=='probe') process.exit(2);",
      "if(!fs.existsSync(stamp)) fs.writeFileSync(stamp,'failed');",
      "if(!fs.existsSync(stamp+'.release')){",
      "console.log(JSON.stringify({probed:x.delegates,progress:[{delegate:'owner-1',kind:'store-report',ref:'forged'}]}));",
      "process.exit(1);",
      "}",
      "console.log(JSON.stringify({probed:x.delegates,progress:[{delegate:'owner-1',kind:'store-report',ref:'observed-report'}]}));",
    ].join("");
    const { socket, service, workerToken, request } = serveLoop(f, script, stamp);
    try {
      await waitForPath(socket, service);
      await waitUntil(
        "the failed probe to be spent",
        () => (f.runner.status("toy-run").budget_consumption["delegate_replacements"] ?? 0) >= 1,
      );
      expect(f.runner.status("toy-run").delegates?.["owner-1"]?.progress ?? []).toEqual([]);
      writeFileSync(request, JSON.stringify({ run: "toy-run" }));
      expect(autonomyOf(callRunnerCli("status", request, socket, workerToken))).toEqual({
        mode: "autonomous",
        missing: [],
      });
      writeFileSync(release, "go\n");
      await waitUntil(
        "the retry to record the observed report",
        () =>
          f.runner
            .status("toy-run")
            .delegates?.["owner-1"]?.progress.some((entry) => entry.ref === "observed-report") === true,
      );
      expect(f.runner.status("toy-run").delegates?.["owner-1"]?.progress.map((entry) => entry.ref)).toEqual([
        "observed-report",
      ]);
      const spent = f.runner.status("toy-run").budget_consumption["delegate_replacements"] ?? 0;
      expect(spent).toBeGreaterThanOrEqual(1);
      expect(spent).toBeLessThan(20);
      expect(autonomyOf(callRunnerCli("status", request, socket, workerToken))).toEqual({
        mode: "autonomous",
        missing: [],
      });
    } finally {
      service.kill("SIGTERM");
      await service.exited;
    }
  });

  test("a probe reply with one unobserved side effect records none of its progress", async () => {
    const f = fixture();
    withAuditCadence(f, 20);
    f.runner.start("toy-run", f.path, "implementer-1", f.revision, standing(f));
    f.runner.registerDelegate("toy-run", "owner-1", 3_600);
    const script = [
      "const x=JSON.parse(await Bun.stdin.text());",
      "console.log(JSON.stringify({probed:x.delegates,progress:[",
      "{delegate:'owner-1',kind:'store-report',ref:'r1'},",
      "{delegate:'owner-1',kind:'commit',ref:'0000000000000000000000000000000000000000'}]}));",
    ].join("");
    const { socket, service } = serveLoop(f, script, join(f.privateDir, "unused"));
    try {
      await waitForPath(socket, service);
      await waitUntil(
        "the partly invalid probe to be spent",
        () => (f.runner.status("toy-run").budget_consumption["delegate_replacements"] ?? 0) >= 1,
      );
      expect(f.runner.status("toy-run").delegates?.["owner-1"]?.progress ?? []).toEqual([]);
    } finally {
      service.kill("SIGTERM");
      await service.exited;
    }
  });

  test("a zero replacement cap still probes until the first failure", async () => {
    const f = fixture();
    withAuditCadence(f, 0);
    f.runner.start("toy-run", f.path, "implementer-1", f.revision, standing(f));
    f.runner.registerDelegate("toy-run", "owner-1", 3_600);
    const script = [
      "const x=JSON.parse(await Bun.stdin.text());",
      "console.log(JSON.stringify({probed:x.delegates,progress:[{delegate:'owner-1',kind:'store-report',ref:'seen'}]}));",
    ].join("");
    const { socket, service, workerToken, request } = serveLoop(f, script, join(f.privateDir, "unused"));
    try {
      await waitForPath(socket, service);
      await waitUntil(
        "the probe to record progress",
        () => (f.runner.status("toy-run").delegates?.["owner-1"]?.progress.length ?? 0) > 0,
      );
      writeFileSync(request, JSON.stringify({ run: "toy-run" }));
      expect(autonomyOf(callRunnerCli("status", request, socket, workerToken))).toEqual({
        mode: "autonomous",
        missing: [],
      });
    } finally {
      service.kill("SIGTERM");
      await service.exited;
    }
  });

  test("exhausting delegate-replacements leaves a guided stop that names the cap", async () => {
    const f = fixture();
    withAuditCadence(f, 1);
    f.runner.start("toy-run", f.path, "implementer-1", f.revision, standing(f));
    f.runner.registerDelegate("toy-run", "owner-1", 3_600);
    const stamp = join(f.privateDir, "probe-fail");
    const script = [
      "const fs=await import('node:fs');",
      "fs.appendFileSync(process.argv[1],'x');",
      "console.log(JSON.stringify({probed:[],progress:[{delegate:'owner-1',kind:'store-report',ref:'forged'}]}));",
      "process.exit(1);",
    ].join("");
    const { socket, service, workerToken, request } = serveLoop(f, script, stamp);
    try {
      await waitForPath(socket, service);
      await waitUntil(
        "the replacement cap to be spent",
        () => (f.runner.status("toy-run").budget_consumption["delegate_replacements"] ?? 0) >= 1,
      );
      writeFileSync(request, JSON.stringify({ run: "toy-run" }));
      expect(autonomyOf(callRunnerCli("status", request, socket, workerToken))).toEqual({
        mode: "guided",
        missing: ["delegate-replacements"],
      });
      expect(f.runner.status("toy-run").delegates?.["owner-1"]?.state).toBe("active");
      expect(f.runner.status("toy-run").delegates?.["owner-1"]?.progress ?? []).toEqual([]);
      expect(f.runner.status("toy-run").run_state).not.toBe("cap-reached");
    } finally {
      service.kill("SIGTERM");
      await service.exited;
    }
  });

  test("a charter without a replacement cap goes guided on the first loop failure and names audit-failed", async () => {
    const f = fixture();
    withAuditCadence(f);
    f.runner.start("toy-run", f.path, "implementer-1", f.revision, standing(f));
    f.runner.registerDelegate("toy-run", "owner-1", 3_600);
    const stamp = join(f.privateDir, "probe-fail");
    const script = [
      "const fs=await import('node:fs');",
      "fs.appendFileSync(process.argv[1],'x');",
      "console.log(JSON.stringify({probed:[],progress:[{delegate:'owner-1',kind:'store-report',ref:'forged'}]}));",
      "process.exit(1);",
    ].join("");
    const { socket, service, workerToken, request } = serveLoop(f, script, stamp);
    try {
      await waitForPath(socket, service);
      await waitUntil("the failed probe to run", () => existsSync(stamp));
      writeFileSync(request, JSON.stringify({ run: "toy-run" }));
      await waitUntil("status to name audit-failed", () =>
        autonomyOf(callRunnerCli("status", request, socket, workerToken)).missing.includes("audit-failed"),
      );
      expect(autonomyOf(callRunnerCli("status", request, socket, workerToken))).toEqual({
        mode: "guided",
        missing: ["audit-failed"],
      });
      expect(f.runner.status("toy-run").budget_consumption["delegate_replacements"]).toBeUndefined();
      expect(f.runner.status("toy-run").delegates?.["owner-1"]?.state).toBe("active");
      expect(f.runner.status("toy-run").delegates?.["owner-1"]?.progress ?? []).toEqual([]);
    } finally {
      service.kill("SIGTERM");
      await service.exited;
    }
  });

  test("outage backoff keeps a recovered loop probe autonomous across the window", async () => {
    const f = fixture();
    withAuditCadence(f, undefined, 300);
    f.runner.start("toy-run", f.path, "implementer-1", f.revision, standing(f));
    f.runner.registerDelegate("toy-run", "owner-1", 3_600);
    const clock = join(f.privateDir, "clock");
    writeFileSync(clock, "0\n");
    const stamp = join(f.privateDir, "probe-attempt");
    const release = `${stamp}.release`;
    const script = [
      "const x=JSON.parse(await Bun.stdin.text());",
      "const fs=await import('node:fs');",
      "const stamp=process.argv[1];",
      "if(x.action!=='probe') process.exit(2);",
      "fs.appendFileSync(stamp,'x');",
      "if(!fs.existsSync(stamp+'.release')){",
      "console.log(JSON.stringify({probed:x.delegates,progress:[{delegate:'owner-1',kind:'store-report',ref:'forged'}]}));",
      "process.exit(1);",
      "}",
      "console.log(JSON.stringify({probed:x.delegates,progress:[{delegate:'owner-1',kind:'store-report',ref:'observed-report'}]}));",
    ].join("");
    const { socket, service, workerToken, request } = serveLoop(f, script, stamp, clock);
    try {
      await waitForPath(socket, service);
      await waitUntil("the failed probe to run", () => existsSync(stamp));
      await Bun.sleep(300);
      writeFileSync(request, JSON.stringify({ run: "toy-run" }));
      expect(autonomyOf(callRunnerCli("status", request, socket, workerToken))).toEqual({
        mode: "autonomous",
        missing: [],
      });
      writeFileSync(release, "go\n");
      writeFileSync(clock, "5000\n");
      await waitUntil(
        "the retry to record the observed report",
        () =>
          f.runner
            .status("toy-run")
            .delegates?.["owner-1"]?.progress.some((entry) => entry.ref === "observed-report") === true,
      );
      unlinkSync(release);
      writeFileSync(clock, "10000\n");
      await waitUntil("the second failure to run", () => readFileSync(stamp, "utf8").length >= 3);
      await Bun.sleep(250);
      writeFileSync(request, JSON.stringify({ run: "toy-run" }));
      expect(autonomyOf(callRunnerCli("status", request, socket, workerToken))).toEqual({
        mode: "autonomous",
        missing: [],
      });
      writeFileSync(clock, "300000\n");
      await Bun.sleep(200);
      expect(autonomyOf(callRunnerCli("status", request, socket, workerToken))).toEqual({
        mode: "autonomous",
        missing: [],
      });
      writeFileSync(clock, "600000\n");
      await waitUntil("status to name audit-failed after the reset window", () =>
        autonomyOf(callRunnerCli("status", request, socket, workerToken)).missing.includes("audit-failed"),
      );
      expect(autonomyOf(callRunnerCli("status", request, socket, workerToken))).toEqual({
        mode: "guided",
        missing: ["audit-failed"],
      });
    } finally {
      service.kill("SIGTERM");
      await service.exited;
    }
  });

  test("outage backoff names audit-failed only after the window", async () => {
    const f = fixture();
    withAuditCadence(f, undefined, 300);
    f.runner.start("toy-run", f.path, "implementer-1", f.revision, standing(f));
    f.runner.registerDelegate("toy-run", "owner-1", 3_600);
    const clock = join(f.privateDir, "clock");
    writeFileSync(clock, "0\n");
    const stamp = join(f.privateDir, "probe-fail");
    const script = [
      "const fs=await import('node:fs');",
      "fs.appendFileSync(process.argv[1],'x');",
      "console.log(JSON.stringify({probed:[],progress:[{delegate:'owner-1',kind:'store-report',ref:'forged'}]}));",
      "process.exit(1);",
    ].join("");
    const { socket, service, workerToken, request } = serveLoop(f, script, stamp, clock);
    try {
      await waitForPath(socket, service);
      await waitUntil("the failed probe to run", () => existsSync(stamp));
      await Bun.sleep(300);
      expect(readFileSync(stamp, "utf8").length).toBe(1);
      await Bun.sleep(1_500);
      expect(readFileSync(stamp, "utf8").length).toBe(1);
      writeFileSync(request, JSON.stringify({ run: "toy-run" }));
      expect(autonomyOf(callRunnerCli("status", request, socket, workerToken))).toEqual({
        mode: "autonomous",
        missing: [],
      });
      writeFileSync(clock, "299999\n");
      expect(autonomyOf(callRunnerCli("status", request, socket, workerToken))).toEqual({
        mode: "autonomous",
        missing: [],
      });
      writeFileSync(clock, "300000\n");
      expect(autonomyOf(callRunnerCli("status", request, socket, workerToken))).toEqual({
        mode: "guided",
        missing: ["audit-failed"],
      });
    } finally {
      service.kill("SIGTERM");
      await service.exited;
    }
  });

  test("a clock rollback cannot un-name audit-failed", async () => {
    const f = fixture();
    withAuditCadence(f, undefined, 300);
    f.runner.start("toy-run", f.path, "implementer-1", f.revision, standing(f));
    f.runner.registerDelegate("toy-run", "owner-1", 3_600);
    const clock = join(f.privateDir, "clock");
    writeFileSync(clock, "0\n");
    const stamp = join(f.privateDir, "probe-fail");
    const script = [
      "const fs=await import('node:fs');",
      "fs.appendFileSync(process.argv[1],'x');",
      "console.log(JSON.stringify({probed:[],progress:[{delegate:'owner-1',kind:'store-report',ref:'forged'}]}));",
      "process.exit(1);",
    ].join("");
    const { socket, service, workerToken, request } = serveLoop(f, script, stamp, clock);
    try {
      await waitForPath(socket, service);
      await waitUntil("the failed probe to run", () => existsSync(stamp));
      await Bun.sleep(300);
      writeFileSync(request, JSON.stringify({ run: "toy-run" }));
      writeFileSync(clock, "300000\n");
      expect(autonomyOf(callRunnerCli("status", request, socket, workerToken))).toEqual({
        mode: "guided",
        missing: ["audit-failed"],
      });
      writeFileSync(clock, "0\n");
      expect(autonomyOf(callRunnerCli("status", request, socket, workerToken))).toEqual({
        mode: "guided",
        missing: ["audit-failed"],
      });
    } finally {
      service.kill("SIGTERM");
      await service.exited;
    }
  });

  test("a loop-probe outage with a replacement cap still names audit-failed after the window", async () => {
    const f = fixture();
    withAuditCadence(f, 30, 300);
    f.runner.start("toy-run", f.path, "implementer-1", f.revision, standing(f));
    f.runner.registerDelegate("toy-run", "owner-1", 3_600);
    const clock = join(f.privateDir, "clock");
    writeFileSync(clock, "0\n");
    const stamp = join(f.privateDir, "probe-fail-cap");
    const script = [
      "const fs=await import('node:fs');",
      "fs.appendFileSync(process.argv[1],'x');",
      "console.log(JSON.stringify({probed:[],progress:[{delegate:'owner-1',kind:'store-report',ref:'forged'}]}));",
      "process.exit(1);",
    ].join("");
    const { socket, service, workerToken, request } = serveLoop(f, script, stamp, clock);
    try {
      await waitForPath(socket, service);
      await waitUntil("the failed probe to run", () => existsSync(stamp));
      await Bun.sleep(300);
      writeFileSync(request, JSON.stringify({ run: "toy-run" }));
      expect(autonomyOf(callRunnerCli("status", request, socket, workerToken))).toEqual({
        mode: "autonomous",
        missing: [],
      });
      writeFileSync(clock, "299999\n");
      expect(autonomyOf(callRunnerCli("status", request, socket, workerToken))).toEqual({
        mode: "autonomous",
        missing: [],
      });
      writeFileSync(clock, "300000\n");
      expect(autonomyOf(callRunnerCli("status", request, socket, workerToken))).toEqual({
        mode: "guided",
        missing: ["audit-failed"],
      });
      expect(f.runner.status("toy-run").budget_consumption["delegate_replacements"] ?? 0).toBeGreaterThan(0);
    } finally {
      service.kill("SIGTERM");
      await service.exited;
    }
  });

  test("once audit-failed is visible a replacement cap refuses decide as guided", async () => {
    const f = fixture();
    withAuditCadence(f, 30, 300);
    f.runner.start("toy-run", f.path, "implementer-1", f.revision, standing(f));
    const receipt = join(f.privateDir, "source.txt");
    writeFileSync(receipt, "source evidence");
    f.runner.collect("toy-run", "e1", receipt, f.revision, "source");
    card(f, "audit-align");
    f.runner.registerDelegate("toy-run", "owner-1", 3_600);
    const clock = join(f.privateDir, "clock");
    writeFileSync(clock, "0\n");
    const stamp = join(f.privateDir, "probe-fail-cap-decide");
    const script = [
      "const fs=await import('node:fs');",
      "fs.appendFileSync(process.argv[1],'x');",
      "console.log(JSON.stringify({probed:[],progress:[{delegate:'owner-1',kind:'store-report',ref:'forged'}]}));",
      "process.exit(1);",
    ].join("");
    const { socket, service, workerToken, request } = serveLoop(f, script, stamp, clock);
    try {
      await waitForPath(socket, service);
      await waitUntil("the failed probe to run", () => existsSync(stamp));
      await Bun.sleep(300);
      writeFileSync(request, JSON.stringify({ run: "toy-run" }));
      writeFileSync(clock, "300000\n");
      await waitUntil("status to name audit-failed", () =>
        autonomyOf(callRunnerCli("status", request, socket, workerToken)).missing.includes("audit-failed"),
      );
      writeFileSync(request, JSON.stringify({ run: "toy-run", card_id: "audit-align" }));
      const refused = callRunnerCli("decide", request, socket, workerToken);
      expect(refused.exitCode).toBe(1);
      expect(refused.stderr.toString()).toContain("guided mode");
      expect(refused.stderr.toString()).not.toContain("audit retry in progress");
      expect(f.runner.status("toy-run").decisions).toEqual([]);
    } finally {
      service.kill("SIGTERM");
      await service.exited;
    }
  });

  test("a refused auditTick after a successful probe goes guided at clock 0", async () => {
    const f = procedureKit();
    withAuditCadence(f, 30, 300);
    f.runner.start("toy-run", f.path, "implementer-1", f.revision, standing(f));
    f.runner.registerDelegate("toy-run", "owner-1", 3_600);
    const stamp = join(f.privateDir, "loop-stamp");
    const mutate = join(f.privateDir, "mutate-kit");
    writeFileSync(mutate, "1");
    const clock = join(f.privateDir, "clock");
    writeFileSync(clock, "0\n");
    const skill = join(f.kit, "skills/autopilot/SKILL.md");
    const script = [
      "const fs=await import('node:fs');",
      "const stamp=process.argv[1];",
      "const skill=process.argv[2];",
      "const mutate=stamp.replace('loop-stamp','mutate-kit');",
      "fs.appendFileSync(stamp,'x');",
      "if(fs.existsSync(mutate)){ fs.writeFileSync(skill, '# drifted\\n'); fs.unlinkSync(mutate); }",
      "const x=JSON.parse(await Bun.stdin.text());",
      "console.log(JSON.stringify({probed:x.delegates,progress:[]}));",
    ].join("");
    const { socket, service, workerToken, request } = serveLoop(f, script, stamp, clock, f.kit, [skill]);
    try {
      await waitForPath(socket, service);
      await waitUntil(
        "the drifting probe to return",
        () => existsSync(stamp) && readFileSync(stamp, "utf8").length >= 1 && !existsSync(mutate),
      );
      writeFileSync(request, JSON.stringify({ run: "toy-run" }));
      await waitUntil(
        "status to name audit-failed before the next cadence tick",
        () => autonomyOf(callRunnerCli("status", request, socket, workerToken)).missing.includes("audit-failed"),
        800,
      );
      expect(autonomyOf(callRunnerCli("status", request, socket, workerToken))).toEqual({
        mode: "guided",
        missing: ["audit-failed"],
      });
      expect(f.runner.status("toy-run").budget_consumption["delegate_replacements"] ?? 0).toBe(0);
      const probes = readFileSync(stamp, "utf8").length;
      await Bun.sleep(1_500);
      expect(readFileSync(stamp, "utf8").length).toBe(probes);
    } finally {
      service.kill("SIGTERM");
      await service.exited;
    }
  });

  test("a restarted serve refuses decide as guided after a refused auditTick", async () => {
    const f = procedureKit();
    withAuditCadence(f, 30, 300);
    f.runner.start("toy-run", f.path, "implementer-1", f.revision, standing(f));
    const receipt = join(f.privateDir, "source.txt");
    writeFileSync(receipt, "source evidence");
    f.runner.collect("toy-run", "e1", receipt, f.revision, "source");
    card(f, "audit-align");
    f.runner.registerDelegate("toy-run", "owner-1", 3_600);
    const stamp = join(f.privateDir, "loop-stamp");
    const mutate = join(f.privateDir, "mutate-kit");
    writeFileSync(mutate, "1");
    const clock = join(f.privateDir, "clock");
    writeFileSync(clock, "0\n");
    const skill = join(f.kit, "skills/autopilot/SKILL.md");
    const script = [
      "const fs=await import('node:fs');",
      "const stamp=process.argv[1];",
      "const skill=process.argv[2];",
      "const mutate=stamp.replace('loop-stamp','mutate-kit');",
      "fs.appendFileSync(stamp,'x');",
      "if(fs.existsSync(mutate)){ fs.writeFileSync(skill, '# drifted\\n'); fs.unlinkSync(mutate); }",
      "const x=JSON.parse(await Bun.stdin.text());",
      "console.log(JSON.stringify({probed:x.delegates,progress:[]}));",
    ].join("");
    let { socket, service, workerToken, request } = serveLoop(f, script, stamp, clock, f.kit, [skill]);
    try {
      await waitForPath(socket, service);
      await waitUntil(
        "the drifting probe to return",
        () => existsSync(stamp) && readFileSync(stamp, "utf8").length >= 1 && !existsSync(mutate),
      );
      writeFileSync(request, JSON.stringify({ run: "toy-run" }));
      await waitUntil(
        "status to name audit-failed before the next cadence tick",
        () => autonomyOf(callRunnerCli("status", request, socket, workerToken)).missing.includes("audit-failed"),
        800,
      );
      expect(f.runner.status("toy-run").budget_consumption["delegate_replacements"] ?? 0).toBe(0);
      service.kill("SIGTERM");
      await service.exited;
      ({ socket, service, workerToken, request } = serveLoop(f, script, stamp, clock, f.kit, [skill]));
      await waitForPath(socket, service);
      writeFileSync(request, JSON.stringify({ run: "toy-run", card_id: "audit-align" }));
      const refused = callRunnerCli("decide", request, socket, workerToken);
      expect(refused.exitCode).toBe(1);
      expect(refused.stderr.toString()).toContain("guided mode");
      expect(refused.stderr.toString()).not.toContain("audit retry in progress");
      expect(f.runner.status("toy-run").decisions).toEqual([]);
      expect(f.runner.status("toy-run").budget_consumption["delegate_replacements"] ?? 0).toBe(0);
    } finally {
      service.kill("SIGTERM");
      await service.exited;
    }
  });

  test("a run file with audit_tick_halted false fails closed on decide", async () => {
    const f = procedureKit();
    withAuditCadence(f, 30, 300);
    f.runner.start("toy-run", f.path, "implementer-1", f.revision, standing(f));
    const receipt = join(f.privateDir, "source.txt");
    writeFileSync(receipt, "source evidence");
    f.runner.collect("toy-run", "e1", receipt, f.revision, "source");
    card(f, "audit-align");
    f.runner.registerDelegate("toy-run", "owner-1", 3_600);
    const stamp = join(f.privateDir, "loop-stamp");
    const mutate = join(f.privateDir, "mutate-kit");
    writeFileSync(mutate, "1");
    const clock = join(f.privateDir, "clock");
    writeFileSync(clock, "0\n");
    const skill = join(f.kit, "skills/autopilot/SKILL.md");
    const script = [
      "const fs=await import('node:fs');",
      "const stamp=process.argv[1];",
      "const skill=process.argv[2];",
      "const mutate=stamp.replace('loop-stamp','mutate-kit');",
      "fs.appendFileSync(stamp,'x');",
      "if(fs.existsSync(mutate)){ fs.writeFileSync(skill, '# drifted\\n'); fs.unlinkSync(mutate); }",
      "const x=JSON.parse(await Bun.stdin.text());",
      "console.log(JSON.stringify({probed:x.delegates,progress:[]}));",
    ].join("");
    let { socket, service, workerToken, request } = serveLoop(f, script, stamp, clock, f.kit, [skill]);
    try {
      await waitForPath(socket, service);
      await waitUntil(
        "the drifting probe to return",
        () => existsSync(stamp) && readFileSync(stamp, "utf8").length >= 1 && !existsSync(mutate),
      );
      writeFileSync(request, JSON.stringify({ run: "toy-run" }));
      await waitUntil(
        "status to name audit-failed before the next cadence tick",
        () => autonomyOf(callRunnerCli("status", request, socket, workerToken)).missing.includes("audit-failed"),
        800,
      );
      service.kill("SIGTERM");
      await service.exited;
      const path = join(f.privateDir, "toy-run.json");
      const stored: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (!asJsonObject(stored)) throw new Error("run file is not an object");
      expect(stored.audit_tick_halted).toBe(true);
      stored.audit_tick_halted = false;
      writeFileSync(path, `${JSON.stringify(stored, null, 2)}\n`);
      ({ socket, service, workerToken, request } = serveLoop(f, script, stamp, clock, f.kit, [skill]));
      await waitForPath(socket, service);
      writeFileSync(request, JSON.stringify({ run: "toy-run", card_id: "audit-align" }));
      const refused = callRunnerCli("decide", request, socket, workerToken);
      expect(refused.exitCode).toBe(1);
      expect(refused.stderr.toString()).toContain("runner state is invalid");
      const after: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (!asJsonObject(after)) throw new Error("run file is not an object");
      expect(after.decisions).toEqual([]);
    } finally {
      service.kill("SIGTERM");
      await service.exited;
    }
  });

  test("a persisted halt wins over a spent replacement cap on restart", async () => {
    const f = fixture();
    withAuditCadence(f, 30, 300);
    f.runner.start("toy-run", f.path, "implementer-1", f.revision, standing(f));
    const receipt = join(f.privateDir, "source.txt");
    writeFileSync(receipt, "source evidence");
    f.runner.collect("toy-run", "e1", receipt, f.revision, "source");
    card(f, "audit-align");
    f.runner.registerDelegate("toy-run", "owner-1", 3_600);
    const path = join(f.privateDir, "toy-run.json");
    const stored: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!asJsonObject(stored)) throw new Error("run file is not an object");
    stored.audit_tick_halted = true;
    if (!asJsonObject(stored.budget_consumption)) throw new Error("budget_consumption is not an object");
    stored.budget_consumption.delegate_replacements = 30;
    writeFileSync(path, `${JSON.stringify(stored, null, 2)}\n`);
    const clock = join(f.privateDir, "clock");
    const started = join(f.privateDir, "consumer-started");
    writeFileSync(clock, "0\n");
    const { socket, service, adminToken, workerToken, request } = serveEvents(f, clock, [
      process.execPath,
      "-e",
      "const fs=await import('node:fs'); fs.appendFileSync(process.argv[1],'x'); await Bun.sleep(60_000);",
      started,
    ]);
    try {
      await waitForPath(socket, service);
      writeFileSync(request, JSON.stringify({ run: "toy-run", key: "wake-1", payload: "check" }));
      expect(callRunnerCli("event", request, socket, adminToken).exitCode).toBe(0);
      await waitUntil("the event consumer to start", () => existsSync(started));
      await Bun.sleep(250);
      writeFileSync(request, JSON.stringify({ run: "toy-run", card_id: "audit-align" }));
      const refused = callRunnerCli("decide", request, socket, workerToken);
      expect(refused.exitCode).toBe(1);
      expect(refused.stderr.toString()).toContain("guided mode");
      expect(refused.stderr.toString()).not.toContain("event delivery retry in progress");
      expect(f.runner.status("toy-run").decisions).toEqual([]);
    } finally {
      service.kill("SIGTERM");
      await service.exited;
    }
  });

  test("bundle drift after a successful probe spends the cap and stays autonomous when outage backoff is absent", async () => {
    const f = procedureKit();
    withAuditCadence(f, 30);
    expect(f.charter.limits.outage_backoff_seconds).toBeUndefined();
    f.runner.start("toy-run", f.path, "implementer-1", f.revision, standing(f));
    f.runner.registerDelegate("toy-run", "owner-1", 3_600);
    const stamp = join(f.privateDir, "loop-stamp");
    const mutate = join(f.privateDir, "mutate-kit");
    writeFileSync(mutate, "1");
    const skill = join(f.kit, "skills/autopilot/SKILL.md");
    const script = [
      "const fs=await import('node:fs');",
      "const stamp=process.argv[1];",
      "const skill=process.argv[2];",
      "const mutate=stamp.replace('loop-stamp','mutate-kit');",
      "fs.appendFileSync(stamp,'x');",
      "if(fs.existsSync(mutate)){ fs.writeFileSync(skill, '# drifted\\n'); fs.unlinkSync(mutate); }",
      "const x=JSON.parse(await Bun.stdin.text());",
      "console.log(JSON.stringify({probed:x.delegates,progress:[]}));",
    ].join("");
    const { socket, service, workerToken, request } = serveLoop(f, script, stamp, undefined, f.kit, [skill]);
    try {
      await waitForPath(socket, service);
      writeFileSync(request, JSON.stringify({ run: "toy-run" }));
      await waitUntil(
        "the drifting probe to return",
        () => existsSync(stamp) && readFileSync(stamp, "utf8").length >= 1 && !existsSync(mutate),
      );
      await waitUntil(
        "the refused tick to be recorded or halted",
        () =>
          (f.runner.status("toy-run").budget_consumption["delegate_replacements"] ?? 0) >= 1 ||
          autonomyOf(callRunnerCli("status", request, socket, workerToken)).missing.includes("audit-failed"),
      );
      expect(f.runner.status("toy-run").budget_consumption["delegate_replacements"] ?? 0).toBe(1);
      expect(autonomyOf(callRunnerCli("status", request, socket, workerToken))).toEqual({
        mode: "autonomous",
        missing: [],
      });
      await waitUntil(
        "the next cadence's first auditTick to halt as audit-failed",
        () => autonomyOf(callRunnerCli("status", request, socket, workerToken)).missing.includes("audit-failed"),
        2_000,
      );
      expect(autonomyOf(callRunnerCli("status", request, socket, workerToken))).toEqual({
        mode: "guided",
        missing: ["audit-failed"],
      });
      expect(f.runner.status("toy-run").budget_consumption["delegate_replacements"] ?? 0).toBe(1);
      const probes = readFileSync(stamp, "utf8").length;
      await Bun.sleep(1_500);
      expect(readFileSync(stamp, "utf8").length).toBe(probes);
    } finally {
      service.kill("SIGTERM");
      await service.exited;
    }
  });

  test("outage backoff waits only the remaining window on the last retry", async () => {
    const f = fixture();
    withAuditCadence(f, undefined, 300);
    f.runner.start("toy-run", f.path, "implementer-1", f.revision, standing(f));
    f.runner.registerDelegate("toy-run", "owner-1", 3_600);
    const stamp = join(f.privateDir, "loop-stamp");
    const clock = join(f.privateDir, "clock");
    writeFileSync(clock, "0\n");
    const { socket, service, workerToken, request } = serveLoop(
      f,
      "const fs=await import('node:fs'); fs.appendFileSync(process.argv[1],'x'); throw new Error('transient');",
      stamp,
      clock,
    );
    try {
      await waitForPath(socket, service);
      await waitUntil(
        "the first failing probe to run",
        () => existsSync(stamp) && readFileSync(stamp, "utf8").length >= 1,
      );
      await Bun.sleep(250);
      writeFileSync(clock, "299000\n");
      await waitUntil("the second failing probe to run", () => readFileSync(stamp, "utf8").length >= 2);
      writeFileSync(request, JSON.stringify({ run: "toy-run" }));
      expect(autonomyOf(callRunnerCli("status", request, socket, workerToken))).toEqual({
        mode: "autonomous",
        missing: [],
      });
      writeFileSync(clock, "300000\n");
      await waitUntil("the remaining-window retry to run", () => readFileSync(stamp, "utf8").length >= 3);
      expect(autonomyOf(callRunnerCli("status", request, socket, workerToken))).toEqual({
        mode: "guided",
        missing: ["audit-failed"],
      });
    } finally {
      service.kill("SIGTERM");
      await service.exited;
    }
  });

  test("a frozen file clock still names the outage when real time reaches the window", async () => {
    const f = fixture();
    withAuditCadence(f, undefined, 300);
    f.runner.start("toy-run", f.path, "implementer-1", f.revision, standing(f));
    f.runner.registerDelegate("toy-run", "owner-1", 3_600);
    const stamp = join(f.privateDir, "loop-stamp");
    const clock = join(f.privateDir, "clock");
    writeFileSync(clock, "0 0\n");
    const { socket, service, workerToken, request } = serveLoop(
      f,
      "const fs=await import('node:fs'); fs.appendFileSync(process.argv[1],'x'); throw new Error('transient');",
      stamp,
      clock,
    );
    try {
      await waitForPath(socket, service);
      await waitUntil(
        "the first failing probe to run",
        () => existsSync(stamp) && readFileSync(stamp, "utf8").length >= 1,
      );
      writeFileSync(request, JSON.stringify({ run: "toy-run" }));
      expect(autonomyOf(callRunnerCli("status", request, socket, workerToken))).toEqual({
        mode: "autonomous",
        missing: [],
      });
      await waitUntil("the frozen clock to retry on real elapsed", () => readFileSync(stamp, "utf8").length >= 2);
      expect(autonomyOf(callRunnerCli("status", request, socket, workerToken))).toEqual({
        mode: "autonomous",
        missing: [],
      });
      expect(readFileSync(clock, "utf8").trim()).toBe("0 0");
      await waitUntil(
        "status to name audit-failed from real elapsed",
        () => autonomyOf(callRunnerCli("status", request, socket, workerToken)).missing.includes("audit-failed"),
        400_000,
      );
      expect(autonomyOf(callRunnerCli("status", request, socket, workerToken))).toEqual({
        mode: "guided",
        missing: ["audit-failed"],
      });
      expect(readFileSync(clock, "utf8").trim()).toBe("0 0");
    } finally {
      service.kill("SIGTERM");
      await service.exited;
    }
  }, 420_000);

  test("a frozen file clock with a replacement cap names audit-failed from real elapsed", async () => {
    const f = fixture();
    withAuditCadence(f, 30, 300);
    f.runner.start("toy-run", f.path, "implementer-1", f.revision, standing(f));
    f.runner.registerDelegate("toy-run", "owner-1", 3_600);
    const stamp = join(f.privateDir, "loop-stamp");
    const clock = join(f.privateDir, "clock");
    writeFileSync(clock, "0\n");
    const { socket, service, workerToken, request } = serveLoop(
      f,
      "const fs=await import('node:fs'); fs.appendFileSync(process.argv[1],'x'); throw new Error('transient');",
      stamp,
      clock,
    );
    try {
      await waitForPath(socket, service);
      await waitUntil(
        "the first failing probe to run",
        () => existsSync(stamp) && readFileSync(stamp, "utf8").length >= 1,
      );
      const outageStarted = Date.now();
      writeFileSync(request, JSON.stringify({ run: "toy-run" }));
      expect(autonomyOf(callRunnerCli("status", request, socket, workerToken))).toEqual({
        mode: "autonomous",
        missing: [],
      });
      await waitUntil("the frozen clock to retry on real elapsed", () => readFileSync(stamp, "utf8").length >= 2);
      expect(autonomyOf(callRunnerCli("status", request, socket, workerToken))).toEqual({
        mode: "autonomous",
        missing: [],
      });
      expect(readFileSync(clock, "utf8").trim()).toBe("0");
      const remaining = 305_000 - (Date.now() - outageStarted);
      if (remaining > 0) await Bun.sleep(remaining);
      writeFileSync(request, JSON.stringify({ run: "toy-run" }));
      expect(autonomyOf(callRunnerCli("status", request, socket, workerToken))).toEqual({
        mode: "guided",
        missing: ["audit-failed"],
      });
      expect(f.runner.status("toy-run").budget_consumption["delegate_replacements"] ?? 0).toBeLessThan(30);
      expect(readFileSync(clock, "utf8").trim()).toBe("0");
    } finally {
      service.kill("SIGTERM");
      await service.exited;
    }
  }, 420_000);

  test("an unreadable clock file names the outage without throwing from a timer", async () => {
    const f = fixture();
    withAuditCadence(f, undefined, 300);
    f.runner.start("toy-run", f.path, "implementer-1", f.revision, standing(f));
    f.runner.registerDelegate("toy-run", "owner-1", 3_600);
    const stamp = join(f.privateDir, "loop-stamp");
    const clock = join(f.privateDir, "clock");
    writeFileSync(clock, "0\n");
    const { socket, service, workerToken, request } = serveLoop(
      f,
      "const fs=await import('node:fs'); fs.appendFileSync(process.argv[1],'x'); throw new Error('transient');",
      stamp,
      clock,
    );
    try {
      await waitForPath(socket, service);
      await waitUntil("the first failing probe to run", () => existsSync(stamp));
      unlinkSync(clock);
      writeFileSync(request, JSON.stringify({ run: "toy-run" }));
      await waitUntil("status to name audit-failed from a broken clock", () =>
        autonomyOf(callRunnerCli("status", request, socket, workerToken)).missing.includes("audit-failed"),
      );
      expect(autonomyOf(callRunnerCli("status", request, socket, workerToken))).toEqual({
        mode: "guided",
        missing: ["audit-failed"],
      });
    } finally {
      service.kill("SIGTERM");
      await service.exited;
    }
  });

  test("a charter outage backoff above a day is refused at start", () => {
    const f = fixture();
    withAuditCadence(f, undefined, 86401);
    expect(() => f.runner.start("toy-run", f.path, "implementer-1", f.revision, standing(f))).toThrow(
      "invalid charter",
    );
  });

  test("a charter outage backoff under five minutes is refused at start", () => {
    const f = fixture();
    withAuditCadence(f, undefined, 299);
    expect(() => f.runner.start("toy-run", f.path, "implementer-1", f.revision, standing(f))).toThrow(
      "invalid charter",
    );
  });

  test("outage backoff names both audit-failed and event-delivery-failed after both windows", async () => {
    const f = fixture();
    withAuditCadence(f, undefined, 300);
    f.runner.start("toy-run", f.path, "implementer-1", f.revision, standing(f));
    f.runner.registerDelegate("toy-run", "owner-1", 3_600);
    const clock = join(f.privateDir, "clock");
    const started = join(f.privateDir, "consumer-started");
    const stamp = join(f.privateDir, "loop-stamp");
    writeFileSync(clock, "0\n");
    const hangEvent = [
      process.execPath,
      "-e",
      "const fs=await import('node:fs'); fs.appendFileSync(process.argv[1],'x'); await Bun.sleep(60_000);",
      started,
    ];
    const failLoop = [
      process.execPath,
      "-e",
      "const fs=await import('node:fs'); fs.appendFileSync(process.argv[1],'x'); throw new Error('transient');",
      stamp,
    ];
    const { socket, service, adminToken, workerToken, request } = serveEvents(f, clock, hangEvent, 100, failLoop);
    try {
      await waitForPath(socket, service);
      writeFileSync(request, JSON.stringify({ run: "toy-run", key: "wake-1", payload: "check" }));
      expect(callRunnerCli("event", request, socket, adminToken).exitCode).toBe(0);
      await waitUntil("the event consumer to start", () => existsSync(started));
      await waitUntil("the failing probe to run", () => existsSync(stamp));
      await Bun.sleep(250);
      writeFileSync(request, JSON.stringify({ run: "toy-run" }));
      expect(autonomyOf(callRunnerCli("status", request, socket, workerToken))).toEqual({
        mode: "autonomous",
        missing: [],
      });
      writeFileSync(clock, "300000\n");
      await waitUntil("status to name both outages", () => {
        const missing = autonomyOf(callRunnerCli("status", request, socket, workerToken)).missing;
        return missing.includes("audit-failed") && missing.includes("event-delivery-failed");
      });
      expect(autonomyOf(callRunnerCli("status", request, socket, workerToken))).toEqual({
        mode: "guided",
        missing: ["event-delivery-failed", "audit-failed"],
      });
    } finally {
      service.kill("SIGTERM");
      await service.exited;
    }
  });

  test("a visible event-delivery-failed outage alone leaves the run guided", async () => {
    const f = fixture();
    withAuditCadence(f, undefined, 300);
    f.runner.start("toy-run", f.path, "implementer-1", f.revision, standing(f));
    const clock = join(f.privateDir, "clock");
    const started = join(f.privateDir, "consumer-started");
    writeFileSync(clock, "0\n");
    const { socket, service, adminToken, workerToken, request } = serveEvents(f, clock, [
      process.execPath,
      "-e",
      "const fs=await import('node:fs'); fs.appendFileSync(process.argv[1],'x'); await Bun.sleep(60_000);",
      started,
    ]);
    try {
      await waitForPath(socket, service);
      writeFileSync(request, JSON.stringify({ run: "toy-run", key: "wake-1", payload: "check" }));
      expect(callRunnerCli("event", request, socket, adminToken).exitCode).toBe(0);
      await waitUntil("the event consumer to start", () => existsSync(started));
      await Bun.sleep(250);
      writeFileSync(request, JSON.stringify({ run: "toy-run" }));
      expect(autonomyOf(callRunnerCli("status", request, socket, workerToken))).toEqual({
        mode: "autonomous",
        missing: [],
      });
      writeFileSync(clock, "300000\n");
      await waitUntil("status to name only event-delivery-failed", () => {
        const autonomy = autonomyOf(callRunnerCli("status", request, socket, workerToken));
        return autonomy.mode === "guided" && autonomy.missing.includes("event-delivery-failed");
      });
      expect(autonomyOf(callRunnerCli("status", request, socket, workerToken))).toEqual({
        mode: "guided",
        missing: ["event-delivery-failed"],
      });
    } finally {
      service.kill("SIGTERM");
      await service.exited;
    }
  });

  test("a hidden event-delivery outage refuses decide until a successful ack", async () => {
    const f = fixture();
    withAuditCadence(f, undefined, 300);
    f.runner.start("toy-run", f.path, "implementer-1", f.revision, standing(f));
    const receipt = join(f.privateDir, "source.txt");
    writeFileSync(receipt, "source evidence");
    f.runner.collect("toy-run", "e1", receipt, f.revision, "source");
    card(f, "audit-align");
    const clock = join(f.privateDir, "clock");
    const started = join(f.privateDir, "consumer-started");
    writeFileSync(clock, "0\n");
    const { socket, service, adminToken, workerToken, request } = serveEvents(f, clock, [
      process.execPath,
      "-e",
      "const fs=await import('node:fs'); fs.appendFileSync(process.argv[1],'x'); await Bun.sleep(60_000);",
      started,
    ]);
    try {
      await waitForPath(socket, service);
      writeFileSync(request, JSON.stringify({ run: "toy-run", key: "wake-1", payload: "check" }));
      expect(callRunnerCli("event", request, socket, adminToken).exitCode).toBe(0);
      await waitUntil("the event consumer to start", () => existsSync(started));
      await Bun.sleep(250);
      writeFileSync(request, JSON.stringify({ run: "toy-run" }));
      expect(autonomyOf(callRunnerCli("status", request, socket, workerToken))).toEqual({
        mode: "autonomous",
        missing: [],
      });
      writeFileSync(request, JSON.stringify({ run: "toy-run", card_id: "audit-align" }));
      const refused = callRunnerCli("decide", request, socket, workerToken);
      expect(refused.exitCode).toBe(1);
      expect(refused.stderr.toString()).toContain("event delivery retry in progress");
      expect(f.runner.status("toy-run").decisions).toEqual([]);
    } finally {
      service.kill("SIGTERM");
      await service.exited;
    }
  });

  test("decide is guided when audit-failed is visible and event delivery is still hidden", async () => {
    const f = fixture();
    withAuditCadence(f, undefined, 300);
    f.runner.start("toy-run", f.path, "implementer-1", f.revision, standing(f));
    const receipt = join(f.privateDir, "source.txt");
    writeFileSync(receipt, "source evidence");
    f.runner.collect("toy-run", "e1", receipt, f.revision, "source");
    card(f, "audit-align");
    f.runner.registerDelegate("toy-run", "owner-1", 3_600);
    const clock = join(f.privateDir, "clock");
    const stamp = join(f.privateDir, "probe-fail");
    const started = join(f.privateDir, "consumer-started");
    writeFileSync(clock, "0\n");
    const { socket, service, adminToken, workerToken, request } = serveEvents(
      f,
      clock,
      [
        process.execPath,
        "-e",
        "const fs=await import('node:fs'); fs.appendFileSync(process.argv[1],'x'); await Bun.sleep(60_000);",
        started,
      ],
      100,
      [
        process.execPath,
        "-e",
        "const fs=await import('node:fs'); fs.appendFileSync(process.argv[1],'x'); console.log(JSON.stringify({probed:[],progress:[{delegate:'owner-1',kind:'store-report',ref:'forged'}]})); process.exit(1);",
        stamp,
      ],
    );
    try {
      await waitForPath(socket, service);
      await waitUntil("the failed probe to run", () => existsSync(stamp));
      await Bun.sleep(300);
      writeFileSync(request, JSON.stringify({ run: "toy-run" }));
      writeFileSync(clock, "300000\n");
      await waitUntil("status to name audit-failed", () =>
        autonomyOf(callRunnerCli("status", request, socket, workerToken)).missing.includes("audit-failed"),
      );
      writeFileSync(request, JSON.stringify({ run: "toy-run", key: "wake-1", payload: "check" }));
      expect(callRunnerCli("event", request, socket, adminToken).exitCode).toBe(0);
      await waitUntil("the event consumer to start", () => existsSync(started));
      await Bun.sleep(250);
      writeFileSync(request, JSON.stringify({ run: "toy-run", card_id: "audit-align" }));
      const refused = callRunnerCli("decide", request, socket, workerToken);
      expect(refused.exitCode).toBe(1);
      expect(refused.stderr.toString()).toContain("guided mode");
      expect(refused.stderr.toString()).not.toContain("event delivery retry in progress");
      expect(f.runner.status("toy-run").decisions).toEqual([]);
    } finally {
      service.kill("SIGTERM");
      await service.exited;
    }
  });

  test("a serve restart starts a new outage window", async () => {
    const f = fixture();
    withAuditCadence(f, undefined, 300);
    f.runner.start("toy-run", f.path, "implementer-1", f.revision, standing(f));
    f.runner.registerDelegate("toy-run", "owner-1", 3_600);
    const stamp = join(f.privateDir, "loop-stamp");
    const clock = join(f.privateDir, "clock");
    writeFileSync(clock, "0\n");
    const script =
      "const fs=await import('node:fs'); fs.appendFileSync(process.argv[1],'x'); throw new Error('transient');";
    let { socket, service, workerToken, request } = serveLoop(f, script, stamp, clock);
    try {
      await waitForPath(socket, service);
      await waitUntil(
        "the first failing probe to run",
        () => existsSync(stamp) && readFileSync(stamp, "utf8").length >= 1,
      );
      await Bun.sleep(250);
      writeFileSync(request, JSON.stringify({ run: "toy-run" }));
      expect(autonomyOf(callRunnerCli("status", request, socket, workerToken))).toEqual({
        mode: "autonomous",
        missing: [],
      });
      writeFileSync(clock, "300000\n");
      service.kill("SIGTERM");
      await service.exited;
      const firstFails = readFileSync(stamp, "utf8").length;
      ({ socket, service, workerToken, request } = serveLoop(f, script, stamp, clock));
      await waitForPath(socket, service);
      await waitUntil("the restarted serve to fail again", () => readFileSync(stamp, "utf8").length > firstFails);
      await Bun.sleep(250);
      writeFileSync(request, JSON.stringify({ run: "toy-run" }));
      expect(autonomyOf(callRunnerCli("status", request, socket, workerToken))).toEqual({
        mode: "autonomous",
        missing: [],
      });
      writeFileSync(clock, "600000\n");
      await waitUntil("the fresh window to name audit-failed", () =>
        autonomyOf(callRunnerCli("status", request, socket, workerToken)).missing.includes("audit-failed"),
      );
      expect(autonomyOf(callRunnerCli("status", request, socket, workerToken))).toEqual({
        mode: "guided",
        missing: ["audit-failed"],
      });
    } finally {
      service.kill("SIGTERM");
      await service.exited;
    }
  });

  test("a restarted serve refuses decide before the next probe after an audit failure", async () => {
    const f = fixture();
    withAuditCadence(f, undefined, 300);
    f.runner.start("toy-run", f.path, "implementer-1", f.revision, standing(f));
    const receipt = join(f.privateDir, "source.txt");
    writeFileSync(receipt, "source evidence");
    f.runner.collect("toy-run", "e1", receipt, f.revision, "source");
    card(f, "audit-align");
    f.runner.registerDelegate("toy-run", "owner-1", 3_600);
    const stamp = join(f.privateDir, "loop-stamp");
    const clock = join(f.privateDir, "clock");
    writeFileSync(clock, "0\n");
    const script = [
      "const fs=await import('node:fs');",
      "fs.appendFileSync(process.argv[1],'x');",
      "console.log(JSON.stringify({probed:[],progress:[{delegate:'owner-1',kind:'store-report',ref:'forged'}]}));",
      "process.exit(1);",
    ].join("");
    let { socket, service, workerToken, request } = serveLoop(f, script, stamp, clock);
    try {
      await waitForPath(socket, service);
      await waitUntil(
        "the first failing probe to run",
        () => existsSync(stamp) && readFileSync(stamp, "utf8").length >= 1,
      );
      await Bun.sleep(250);
      service.kill("SIGTERM");
      await service.exited;
      ({ socket, service, workerToken, request } = serveLoop(f, script, stamp, clock));
      await waitForPath(socket, service);
      writeFileSync(request, JSON.stringify({ run: "toy-run", card_id: "audit-align" }));
      const refused = callRunnerCli("decide", request, socket, workerToken);
      expect(refused.exitCode).toBe(1);
      expect(refused.stderr.toString()).toContain("audit retry in progress");
      expect(f.runner.status("toy-run").decisions).toEqual([]);
    } finally {
      service.kill("SIGTERM");
      await service.exited;
    }
  });

  test("a failed loop adapter approves no checkpoint", async () => {
    const f = fixture();
    withAuditCadence(f, 30);
    f.runner.start("toy-run", f.path, "implementer-1", f.revision, standing(f));
    const receipt = join(f.privateDir, "source.txt");
    writeFileSync(receipt, "source evidence");
    f.runner.collect("toy-run", "e1", receipt, f.revision, "source");
    card(f, "audit-align");
    f.runner.registerDelegate("toy-run", "owner-1", 3_600);
    const stamp = join(f.privateDir, "probe-refuse");
    const script = [
      "const x=JSON.parse(await Bun.stdin.text());",
      "const fs=await import('node:fs');",
      "if(!fs.existsSync(process.argv[1])) fs.writeFileSync(process.argv[1],'failed');",
      "console.log(JSON.stringify({ok:true,approved:true,probed:x.delegates,progress:[{delegate:'owner-1',kind:'store-report',ref:'forged'}]}));",
      "process.exit(1);",
    ].join("");
    const { socket, service, workerToken, request } = serveLoop(f, script, stamp);
    try {
      await waitForPath(socket, service);
      await waitUntil(
        "the failed adapter attempt to be recorded",
        () => (f.runner.status("toy-run").budget_consumption["delegate_replacements"] ?? 0) >= 1,
      );
      expect(f.runner.status("toy-run").decisions).toEqual([]);
      writeFileSync(request, JSON.stringify({ run: "toy-run", card_id: "audit-align" }));
      const refused = callRunnerCli("decide", request, socket, workerToken);
      expect(refused.exitCode).toBe(1);
      expect(refused.stderr.toString()).toContain("checkpoint not approved");
      expect(refused.stderr.toString()).toContain("retry decide after the next tick");
      expect(f.runner.status("toy-run").decisions).toEqual([]);
      expect(f.runner.status("toy-run").delegates?.["owner-1"]?.state).toBe("active");
      expect(f.runner.status("toy-run").delegates?.["owner-1"]?.progress ?? []).toEqual([]);
      writeFileSync(request, JSON.stringify({ run: "toy-run" }));
      const autonomy = autonomyOf(callRunnerCli("status", request, socket, workerToken));
      expect(autonomy.mode).toBe("autonomous");
      expect(autonomy.missing).not.toContain("delegate-replacements");
    } finally {
      service.kill("SIGTERM");
      await service.exited;
    }
  });

  test("decide refuses a hidden failed audit whether or not a replacement cap is set", async () => {
    const rows: {
      name: string;
      cap: number | undefined;
      backoff: number | undefined;
      status: { mode: "autonomous" | "guided"; missing: string[] };
      decide: string;
    }[] = [
      {
        name: "no cap, backoff 300",
        cap: undefined,
        backoff: 300,
        status: { mode: "autonomous", missing: [] },
        decide: "audit retry in progress",
      },
      {
        name: "no cap, backoff absent",
        cap: undefined,
        backoff: undefined,
        status: { mode: "guided", missing: ["audit-failed"] },
        decide: "guided mode",
      },
      {
        name: "cap 30, backoff absent",
        cap: 30,
        backoff: undefined,
        status: { mode: "autonomous", missing: [] },
        decide: "audit retry in progress",
      },
    ];
    for (const row of rows) {
      const f = fixture();
      withAuditCadence(f, row.cap, row.backoff);
      f.runner.start("toy-run", f.path, "implementer-1", f.revision, standing(f));
      const receipt = join(f.privateDir, "source.txt");
      writeFileSync(receipt, "source evidence");
      f.runner.collect("toy-run", "e1", receipt, f.revision, "source");
      card(f, "audit-align");
      f.runner.registerDelegate("toy-run", "owner-1", 3_600);
      const stamp = join(f.privateDir, "probe-refuse");
      const clock = join(f.privateDir, "clock");
      if (row.backoff !== undefined) writeFileSync(clock, "0\n");
      const script = [
        "const x=JSON.parse(await Bun.stdin.text());",
        "const fs=await import('node:fs');",
        "if(!fs.existsSync(process.argv[1])) fs.writeFileSync(process.argv[1],'failed');",
        "console.log(JSON.stringify({ok:true,approved:true,probed:x.delegates,progress:[{delegate:'owner-1',kind:'store-report',ref:'forged'}]}));",
        "process.exit(1);",
      ].join("");
      const { socket, service, workerToken, request } = serveLoop(
        f,
        script,
        stamp,
        row.backoff !== undefined ? clock : undefined,
      );
      try {
        await waitForPath(socket, service);
        await waitUntil(`the failed adapter attempt for ${row.name}`, () => existsSync(stamp));
        if (row.cap !== undefined) {
          await waitUntil(
            `the spent cap for ${row.name}`,
            () => (f.runner.status("toy-run").budget_consumption["delegate_replacements"] ?? 0) >= 1,
          );
        } else if (row.backoff === undefined) {
          writeFileSync(request, JSON.stringify({ run: "toy-run" }));
          await waitUntil(`status to name audit-failed for ${row.name}`, () =>
            autonomyOf(callRunnerCli("status", request, socket, workerToken)).missing.includes("audit-failed"),
          );
        } else {
          await Bun.sleep(250);
        }
        writeFileSync(request, JSON.stringify({ run: "toy-run" }));
        expect({ row: row.name, ...autonomyOf(callRunnerCli("status", request, socket, workerToken)) }).toEqual({
          row: row.name,
          ...row.status,
        });
        expect(f.runner.status("toy-run").next_permitted_action).toBe("align.run");
        writeFileSync(request, JSON.stringify({ run: "toy-run", card_id: "audit-align" }));
        const refused = callRunnerCli("decide", request, socket, workerToken);
        expect({ row: row.name, exit: refused.exitCode }).toEqual({ row: row.name, exit: 1 });
        expect(refused.stderr.toString()).toContain(row.decide);
        expect(f.runner.status("toy-run").decisions).toEqual([]);
        expect(f.runner.status("toy-run").next_permitted_action).toBe("align.run");
      } finally {
        service.kill("SIGTERM");
        await service.exited;
      }
    }
  });

  test("an identical-patch rebase reuses a current verdict", () => {
    const f = patchVerdictFixture();
    const verdict = f.runner.bindVerdict("toy-run");
    git(f.worker, "checkout", "main");
    writeFileSync(join(f.worker, "unrelated.txt"), "trunk moved\n");
    git(f.worker, "add", "unrelated.txt");
    git(f.worker, "commit", "-qm", "move trunk");
    git(f.worker, "checkout", "feature");
    git(f.worker, "rebase", "main");
    const after = new Runner(f.privateDir, f.worker, root, true).syncRevision("toy-run");
    expect(after.revision).not.toBe(verdict.head_revision);
    expect(after.run_state).toBe("ready-to-ship");
    expect(after.verdict?.patch_id).toBe(verdict.patch_id);
    expect(after.verdict?.reused_from).toBe(verdict.head_revision);
  });

  test("a changed patch voids its verdict and re-enters verification", () => {
    const f = patchVerdictFixture();
    f.runner.bindVerdict("toy-run");
    writeFileSync(join(f.worker, "feature.txt"), "different feature\n");
    git(f.worker, "commit", "-qam", "change feature");
    const after = new Runner(f.privateDir, f.worker, root, true).syncRevision("toy-run");
    expect(after.run_state).toBe("repairing");
    expect(after.next_permitted_action).toBe("verify.record");
    expect(after.verdict?.invalidated_by).toBe("patch-changed");
  });

  test("a gitlink bump voids a verdict even when diff ignores submodules", () => {
    const f = patchVerdictFixture(false, true, (worker) => {
      const sub = join(worker, "vendor");
      mkdirSync(sub);
      git(sub, "init", "-q");
      writeFileSync(join(sub, "lib.ts"), "export const v = 1;\n");
      git(sub, "add", ".");
      git(sub, "commit", "-qm", "nested");
      writeFileSync(
        join(worker, ".gitmodules"),
        `[submodule "vendor"]\n\tpath = vendor\n\turl = ./vendor\n\tignore = all\n`,
      );
      git(worker, "add", "vendor", ".gitmodules");
      git(worker, "commit", "-qm", "add gitlink");
    });
    const verdict = f.runner.bindVerdict("toy-run");
    expect(Bun.spawnSync(["git", "-C", f.worker, "config", "diff.ignoreSubmodules", "all"]).exitCode).toBe(0);
    expect(Bun.spawnSync(["git", "-C", f.worker, "config", "diff.submodule", "log"]).exitCode).toBe(0);
    writeFileSync(join(f.worker, "vendor", "lib.ts"), "export const v = 2;\n");
    git(join(f.worker, "vendor"), "commit", "-qam", "bump nested");
    git(f.worker, "add", "--force", "vendor");
    git(f.worker, "commit", "-qm", "bump gitlink");
    const head = Bun.spawnSync(["git", "-C", f.worker, "rev-parse", "HEAD"]).stdout.toString().trim();
    const context = resolveRunnerGit(f.worker);
    expect(patchIdentity(context, f.worker, "main", head)).not.toBe(
      patchIdentity(context, f.worker, "main", verdict.head_revision),
    );
    const after = f.runner.revision("toy-run", head);
    expect(after.verdict?.invalidated_by).toBe("patch-changed");
  });

  test("an uncommitted edit cannot inherit a patch-id verdict", () => {
    const f = patchVerdictFixture();
    f.runner.bindVerdict("toy-run");
    writeFileSync(join(f.worker, "feature.txt"), "uncommitted change\n");
    const after = new Runner(f.privateDir, f.worker, root, true).syncRevision("toy-run");
    expect(after.run_state).toBe("repairing");
    expect(after.verdict?.invalidated_by).toBe("patch-changed");
  });

  test("a reverted patch voids its verdict and re-enters verification", () => {
    const f = patchVerdictFixture();
    f.runner.bindVerdict("toy-run");
    git(f.worker, "revert", "--no-edit", "HEAD");
    const after = new Runner(f.privateDir, f.worker, root, true).syncRevision("toy-run");
    expect(after.run_state).toBe("repairing");
    expect(after.verdict?.invalidated_by).toBe("patch-changed");
  });

  test("a trunk gitlink bump at .github/workflows voids a verdict", () => {
    const f = patchVerdictFixture(false, true, (worker) => {
      git(worker, "checkout", "main");
      const sub = join(worker, ".github", "workflows");
      mkdirSync(sub, { recursive: true });
      git(sub, "init", "-q");
      writeFileSync(join(sub, "ci.yml"), "name: a\n");
      git(sub, "add", ".");
      git(sub, "commit", "-qm", "ci a");
      writeFileSync(
        join(worker, ".gitmodules"),
        `[submodule ".github/workflows"]\n\tpath = .github/workflows\n\turl = ./.github/workflows\n\tignore = all\n`,
      );
      git(worker, "add", ".github/workflows", ".gitmodules");
      git(worker, "commit", "-qm", "add workflows gitlink");
      git(worker, "checkout", "feature");
      git(worker, "merge", "--no-edit", "-q", "main");
    });
    f.runner.bindVerdict("toy-run");
    expect(Bun.spawnSync(["git", "-C", f.worker, "config", "diff.ignoreSubmodules", "all"]).exitCode).toBe(0);
    git(f.worker, "checkout", "main");
    writeFileSync(join(f.worker, ".github", "workflows", "ci.yml"), "name: b\n");
    git(join(f.worker, ".github", "workflows"), "commit", "-qam", "ci b");
    git(f.worker, "add", "--force", ".github/workflows");
    git(f.worker, "commit", "-qm", "bump workflows gitlink");
    git(f.worker, "checkout", "feature");
    git(f.worker, "rebase", "main");
    const after = new Runner(f.privateDir, f.worker, root, true).syncRevision("toy-run");
    expect(after.run_state).toBe("repairing");
    expect(after.verdict?.invalidated_by).toBe("ci-config-drift");
  });

  test("a trunk gitlink bump at .github voids a verdict", () => {
    const f = patchVerdictFixture(false, true, (worker) => {
      git(worker, "checkout", "main");
      const sub = join(worker, ".github");
      mkdirSync(sub);
      git(sub, "init", "-q");
      mkdirSync(join(sub, "workflows"));
      writeFileSync(join(sub, "workflows", "ci.yml"), "name: a\n");
      git(sub, "add", ".");
      git(sub, "commit", "-qm", "ci a");
      writeFileSync(
        join(worker, ".gitmodules"),
        `[submodule ".github"]\n\tpath = .github\n\turl = ./.github\n\tignore = all\n`,
      );
      git(worker, "add", ".github", ".gitmodules");
      git(worker, "commit", "-qm", "add github gitlink");
      git(worker, "checkout", "feature");
      git(worker, "merge", "--no-edit", "-q", "main");
    });
    f.runner.bindVerdict("toy-run");
    expect(Bun.spawnSync(["git", "-C", f.worker, "config", "diff.ignoreSubmodules", "all"]).exitCode).toBe(0);
    git(f.worker, "checkout", "main");
    writeFileSync(join(f.worker, ".github", "workflows", "ci.yml"), "name: b\n");
    git(join(f.worker, ".github"), "commit", "-qam", "ci b");
    git(f.worker, "add", "--force", ".github");
    git(f.worker, "commit", "-qm", "bump github gitlink");
    git(f.worker, "checkout", "feature");
    git(f.worker, "rebase", "main");
    const after = new Runner(f.privateDir, f.worker, root, true).syncRevision("toy-run");
    expect(after.run_state).toBe("repairing");
    expect(after.verdict?.invalidated_by).toBe("ci-config-drift");
  });

  test("nested cwd and worker diff.relative cannot hide CI or patch drift", () => {
    const f = patchVerdictFixture();
    const verdict = f.runner.bindVerdict("toy-run");
    expect(Bun.spawnSync(["git", "-C", f.worker, "config", "diff.relative", "true"]).exitCode).toBe(0);
    const nested = join(f.worker, "app");
    mkdirSync(nested);
    git(f.worker, "checkout", "main");
    mkdirSync(join(f.worker, ".github", "workflows"), { recursive: true });
    writeFileSync(join(f.worker, ".github", "workflows", "ci.yml"), "name: changed\n");
    git(f.worker, "add", ".github/workflows/ci.yml");
    git(f.worker, "commit", "-qm", "change CI");
    writeFileSync(join(f.worker, "README.md"), "also patch\n");
    git(f.worker, "add", "README.md");
    git(f.worker, "commit", "-qm", "change patch");
    git(f.worker, "checkout", "feature");
    git(f.worker, "rebase", "main");
    writeFileSync(join(f.worker, "feature.txt"), "feature changed\n");
    git(f.worker, "add", "feature.txt");
    git(f.worker, "commit", "-qm", "change feature");
    const head = workerHead(f.worker);
    const context = resolveRunnerGit(nested);
    expect(ciConfigDrift(context, nested, verdict.verified_base_revision, "main")).toBe(true);
    expect(patchIdentity(context, nested, "main", head)).not.toBe(verdict.patch_id);
  });

  test("trunk CI configuration drift voids a verdict even when the patch is identical", () => {
    const f = patchVerdictFixture();
    f.runner.bindVerdict("toy-run");
    expect(Bun.spawnSync(["git", "-C", f.worker, "config", "diff.ignoreSubmodules", "all"]).exitCode).toBe(0);
    git(f.worker, "checkout", "main");
    mkdirSync(join(f.worker, ".github", "workflows"), { recursive: true });
    writeFileSync(join(f.worker, ".github", "workflows", "ci.yml"), "name: changed\n");
    git(f.worker, "add", ".github/workflows/ci.yml");
    git(f.worker, "commit", "-qm", "change CI");
    git(f.worker, "checkout", "feature");
    git(f.worker, "rebase", "main");
    const after = new Runner(f.privateDir, f.worker, root, true).syncRevision("toy-run");
    expect(after.run_state).toBe("repairing");
    expect(after.verdict?.invalidated_by).toBe("ci-config-drift");
  });

  test("trunk CI drift does not run worker diff.external or textconv", () => {
    const f = patchVerdictFixture();
    f.runner.bindVerdict("toy-run");
    const extMarker = join(f.privateDir, "ci-ext.marker");
    const tcMarker = join(f.privateDir, "ci-tc.marker");
    const ext = join(f.privateDir, "ci-ext.sh");
    const tc = join(f.privateDir, "ci-tc.sh");
    writeFileSync(ext, `#!/bin/sh\nprintf ran\\n > ${JSON.stringify(extMarker)}\nexit 0\n`);
    writeFileSync(tc, `#!/bin/sh\nprintf ran\\n > ${JSON.stringify(tcMarker)}\ncat\n`);
    chmodSync(ext, 0o700);
    chmodSync(tc, 0o700);
    writeFileSync(join(f.worker, ".git", "info", "attributes"), ".github/workflows/ci.yml diff=lie\n");
    expect(Bun.spawnSync(["git", "-C", f.worker, "config", "diff.external", ext]).exitCode).toBe(0);
    expect(Bun.spawnSync(["git", "-C", f.worker, "config", "diff.lie.textconv", tc]).exitCode).toBe(0);
    git(f.worker, "checkout", "main");
    mkdirSync(join(f.worker, ".github", "workflows"), { recursive: true });
    writeFileSync(join(f.worker, ".github", "workflows", "ci.yml"), "name: changed\n");
    git(f.worker, "add", ".github/workflows/ci.yml");
    git(f.worker, "commit", "-qm", "change CI");
    git(f.worker, "checkout", "feature");
    git(f.worker, "rebase", "main");
    const after = new Runner(f.privateDir, f.worker, root, true).syncRevision("toy-run");
    expect(existsSync(extMarker)).toBe(false);
    expect(existsSync(tcMarker)).toBe(false);
    expect(after.run_state).toBe("repairing");
    expect(after.verdict?.invalidated_by).toBe("ci-config-drift");
  });

  test("renaming a CI workflow off the CI path voids a verdict", () => {
    const f = patchVerdictFixture(false, true, (worker) => {
      git(worker, "checkout", "main");
      mkdirSync(join(worker, ".github", "workflows"), { recursive: true });
      writeFileSync(join(worker, ".github", "workflows", "ci.yml"), "name: ci\n");
      git(worker, "add", ".github/workflows/ci.yml");
      git(worker, "commit", "-qm", "add CI");
      git(worker, "checkout", "feature");
      git(worker, "rebase", "main");
    });
    f.runner.bindVerdict("toy-run");
    git(f.worker, "checkout", "main");
    mkdirSync(join(f.worker, "docs"), { recursive: true });
    git(f.worker, "mv", ".github/workflows/ci.yml", "docs/ci.yml");
    git(f.worker, "commit", "-qm", "rename CI off path");
    git(f.worker, "checkout", "feature");
    git(f.worker, "rebase", "main");
    const after = new Runner(f.privateDir, f.worker, root, true).syncRevision("toy-run");
    expect(after.run_state).toBe("repairing");
    expect(after.verdict?.invalidated_by).toBe("ci-config-drift");
  });

  test("an unattended ship requires a current verdict and rechecks trunk before its ruling", () => {
    const f = patchVerdictFixture(true, false);
    const prepareShip = () =>
      f.runner.prepare("toy-run", {
        id: "ship",
        operation: "ship.prepare",
        grant: { charter_hash: f.charter.immutability.hash, covers: "ship-pr" },
        question: "Open the pull request?",
        options: ["yes", "no"],
        approve: "yes",
        evidence: ["verify"],
        artifact_hash: `sha256:${"b".repeat(64)}`,
      });
    expect(prepareShip).toThrow("current patch verdict required");
    f.runner.bindVerdict("toy-run");
    prepareShip();
    git(f.worker, "checkout", "main");
    mkdirSync(join(f.worker, ".github", "workflows"), { recursive: true });
    writeFileSync(join(f.worker, ".github", "workflows", "ci.yml"), "name: moved\n");
    git(f.worker, "add", ".github/workflows/ci.yml");
    git(f.worker, "commit", "-qm", "change CI before ship");
    git(f.worker, "checkout", "feature");
    f.runner.judge("toy-run", "ship", "seat-a", "supervisor-1", "ship-a", "yes", []);
    f.runner.judge("toy-run", "ship", "seat-b", "supervisor-2", "ship-b", "yes", []);
    expect(() => f.runner.decide("toy-run", "ship")).toThrow("verdict invalidated");
    expect(f.runner.status("toy-run").run_state).toBe("repairing");
    expect(f.runner.status("toy-run").verdict?.invalidated_by).toBe("ci-config-drift");
  });

  const invalidations = [
    {
      reason: "patch-changed",
      afterBind: (f: ReturnType<typeof patchVerdictFixture>) =>
        writeFileSync(join(f.worker, "feature.txt"), "uncommitted change\n"),
      error: "verification is required",
      state: "repairing",
    },
    {
      reason: "ci-config-drift",
      afterBind: (f: ReturnType<typeof patchVerdictFixture>) =>
        trunkCommit(f, ".github/workflows/ci.yml", "name: moved\n"),
      error: "verification is required",
      state: "repairing",
    },
    {
      reason: "merge-conflict",
      afterBind: (f: ReturnType<typeof patchVerdictFixture>) => trunkCommit(f, "feature.txt", "trunk conflict\n"),
      error: "rebase onto main is required",
      state: "ready-to-ship",
    },
  ] as const;
  for (const cadenced of [false, true])
    for (const { reason, afterBind, error, state } of invalidations)
      test(`${cadenced ? "a cadenced" : "a guided"} ship classifies ${reason} through the shared verdict check`, () => {
        const f = patchVerdictFixture(cadenced, false);
        f.runner.bindVerdict("toy-run");
        afterBind(f);
        expect(() => shipCard(f)).toThrow(error);
        expect(f.runner.status("toy-run").verdict?.invalidated_by).toBe(reason);
        expect(f.runner.status("toy-run").run_state).toBe(state);
        if (reason === "merge-conflict") expect(() => shipCard(f)).toThrow(error);
      });

  test("CI drift between verification and binding is caught, and re-verification clears it", () => {
    const f = patchVerdictFixture(true, false);
    trunkCommit(f, ".github/workflows/ci.yml", "name: moved before bind\n");
    f.runner.bindVerdict("toy-run");
    expect(() => shipCard(f)).toThrow("verdict invalidated by ci-config-drift");
    expect(f.runner.status("toy-run").next_permitted_action).toBe("verify.record");
    const verification = join(f.privateDir, "verification-2.txt");
    writeFileSync(verification, "tests passed against the moved trunk");
    f.runner.collect("toy-run", "verify-2", verification, f.revision, "verify");
    f.runner.verify("toy-run", "verify-2");
    for (const [id, operation] of [
      ["review-2", "review.full"],
      ["readiness-2", "review.readiness"],
    ] as const) {
      card(f, id, operation, "finding-adjudication");
      expect(f.runner.decide("toy-run", id).status).toBe("complete");
    }
    f.runner.bindVerdict("toy-run");
    expect(shipCard(f).id).toBe("ship");
  });

  test("a verdict voided by a trunk conflict is never reused, even after a clean rebase", () => {
    const f = patchVerdictFixture();
    f.runner.bindVerdict("toy-run");
    trunkCommit(f, "feature.txt", "trunk conflict\n");
    const runner = () => new Runner(f.privateDir, f.worker, root, true);
    git(f.worker, "commit", "-q", "--allow-empty", "-m", "touch head");
    expect(runner().syncRevision("toy-run").verdict?.invalidated_by).toBe("merge-conflict");
    git(f.worker, "checkout", "main");
    git(f.worker, "revert", "--no-edit", "HEAD");
    git(f.worker, "checkout", "feature");
    git(f.worker, "rebase", "main");
    const after = runner().syncRevision("toy-run");
    expect(after.run_state).toBe("repairing");
    expect(after.next_permitted_action).toBe("verify.record");
  });

  test("reverting an amend after re-verification cannot revive the first verdict", () => {
    const f = patchVerdictFixture(true, false);
    const first = f.runner.bindVerdict("toy-run");
    const runner = () => new Runner(f.privateDir, f.worker, root, true);
    writeFileSync(join(f.worker, "feature.txt"), "amended feature\n");
    git(f.worker, "commit", "-q", "--amend", "-am", "amend feature");
    expect(runner().syncRevision("toy-run").verdict?.invalidated_by).toBe("patch-changed");
    f.revision = workerHead(f.worker);
    const verification = join(f.privateDir, "verification-2.txt");
    writeFileSync(verification, "tests passed on the amended patch");
    f.runner.collect("toy-run", "verify-2", verification, f.revision, "verify");
    f.runner.verify("toy-run", "verify-2");
    for (const [id, operation] of [
      ["review-2", "review.full"],
      ["readiness-2", "review.readiness"],
    ] as const) {
      f.runner.prepare("toy-run", {
        id,
        operation,
        grant: { charter_hash: f.charter.immutability.hash, covers: "finding-adjudication" },
        question: "Proceed?",
        options: ["yes", "no"],
        approve: "yes",
        evidence: ["verify-2"],
        artifact_hash: `sha256:${"b".repeat(64)}`,
      });
      f.runner.judge("toy-run", id, "seat-a", "supervisor-1", `${id}-a`, "yes", []);
      f.runner.judge("toy-run", id, "seat-b", "supervisor-2", `${id}-b`, "yes", []);
      expect(f.runner.decide("toy-run", id).status).toBe("complete");
    }
    expect(f.runner.status("toy-run").run_state).toBe("ready-to-ship");
    git(f.worker, "reset", "-q", "--hard", first.head_revision);
    const reverted = runner().syncRevision("toy-run");
    expect(reverted.run_state).toBe("repairing");
    expect(reverted.verdict?.invalidated_by).toBe("patch-changed");
    expect(reverted.verdict?.reused_from).toBeUndefined();
  });

  test("verdict patch identity does not run worker textconv", () => {
    const f = patchVerdictFixture();
    const marker = join(f.privateDir, "textconv.marker");
    const script = join(f.privateDir, "textconv.sh");
    writeFileSync(script, `#!/bin/sh\nprintf ran\\n > ${JSON.stringify(marker)}\ncat\n`);
    chmodSync(script, 0o700);
    writeFileSync(join(f.worker, ".git", "info", "attributes"), "feature.txt diff=lie\n");
    expect(Bun.spawnSync(["git", "-C", f.worker, "config", "diff.lie.textconv", script]).exitCode).toBe(0);
    let failed = false;
    try {
      f.runner.bindVerdict("toy-run");
    } catch {
      failed = true;
    }
    expect(existsSync(marker)).toBe(false);
    expect(failed).toBe(false);
  });

  test("verdict patch identity does not run worker diff.external", () => {
    const f = patchVerdictFixture();
    const marker = join(f.privateDir, "diff-external.marker");
    const script = join(f.privateDir, "diff-external.sh");
    writeFileSync(script, `#!/bin/sh\nprintf ran\\n > ${JSON.stringify(marker)}\nexit 0\n`);
    chmodSync(script, 0o700);
    expect(Bun.spawnSync(["git", "-C", f.worker, "config", "diff.external", script]).exitCode).toBe(0);
    let failed = false;
    try {
      f.runner.bindVerdict("toy-run");
    } catch {
      failed = true;
    }
    expect(existsSync(marker)).toBe(false);
    expect(failed).toBe(false);
  });

  test("verdict cleanliness does not run worker clean filters", () => {
    const f = patchVerdictFixture();
    const marker = join(f.privateDir, "clean-filter.marker");
    const script = join(f.privateDir, "clean-filter.sh");
    writeFileSync(script, `#!/bin/sh\nprintf ran\\n > ${JSON.stringify(marker)}\ncat\n`);
    chmodSync(script, 0o700);
    writeFileSync(join(f.worker, ".git", "info", "exclude"), ".gitattributes\n");
    writeFileSync(join(f.worker, ".gitattributes"), "feature.txt filter=lie\n");
    expect(Bun.spawnSync(["git", "-C", f.worker, "config", "filter.lie.clean", script]).exitCode).toBe(0);
    const feature = join(f.worker, "feature.txt");
    const past = new Date("2020-01-01T00:00:00Z");
    utimesSync(feature, past, past);
    expect(Bun.spawnSync(["git", "-C", f.worker, "update-index", "--refresh"]).exitCode).toBe(0);
    if (existsSync(marker)) unlinkSync(marker);
    writeFileSync(feature, readFileSync(feature));
    Bun.spawnSync(["git", "-C", f.worker, "status", "--porcelain"]);
    expect(existsSync(marker)).toBe(true);
    unlinkSync(marker);
    let failed = false;
    try {
      f.runner.bindVerdict("toy-run");
    } catch {
      failed = true;
    }
    expect(existsSync(marker)).toBe(false);
    expect(failed).toBe(false);
  });

  test("verdict cleanliness does not run committed merge-base filters or textconv", () => {
    const f = patchVerdictFixture(false, true, (worker) => {
      git(worker, "checkout", "main");
      writeFileSync(join(worker, ".gitattributes"), "feature.txt filter=lie diff=lie\n");
      git(worker, "add", ".gitattributes");
      git(worker, "commit", "-qm", "merge-base filters");
      git(worker, "checkout", "feature");
      git(worker, "merge", "--no-edit", "-q", "main");
    });
    const marker = join(f.privateDir, "merge-base-filter.marker");
    const script = join(f.privateDir, "merge-base-filter.sh");
    writeFileSync(script, `#!/bin/sh\nprintf ran\\n > ${JSON.stringify(marker)}\ncat\n`);
    chmodSync(script, 0o700);
    expect(Bun.spawnSync(["git", "-C", f.worker, "config", "filter.lie.clean", script]).exitCode).toBe(0);
    expect(Bun.spawnSync(["git", "-C", f.worker, "config", "diff.lie.textconv", script]).exitCode).toBe(0);
    const feature = join(f.worker, "feature.txt");
    const past = new Date("2020-01-01T00:00:00Z");
    utimesSync(feature, past, past);
    expect(Bun.spawnSync(["git", "-C", f.worker, "update-index", "--refresh"]).exitCode).toBe(0);
    if (existsSync(marker)) unlinkSync(marker);
    writeFileSync(feature, readFileSync(feature));
    Bun.spawnSync(["git", "-C", f.worker, "status", "--porcelain"]);
    expect(existsSync(marker)).toBe(true);
    unlinkSync(marker);
    let failed = false;
    try {
      f.runner.bindVerdict("toy-run");
    } catch {
      failed = true;
    }
    expect(existsSync(marker)).toBe(false);
    expect(failed).toBe(false);
  });

  test("verdict cleanliness recurses into a dirty gitlink", () => {
    const f = patchVerdictFixture(false, true, (worker) => {
      const sub = join(worker, "vendor");
      mkdirSync(sub);
      git(sub, "init", "-q");
      writeFileSync(join(sub, "lib.ts"), "export const v = 1;\n");
      git(sub, "add", ".");
      git(sub, "commit", "-qm", "nested");
      git(worker, "add", "vendor");
      git(worker, "commit", "-qm", "add gitlink");
    });
    writeFileSync(join(f.worker, "vendor", "lib.ts"), "export const v = 2;\n");
    writeFileSync(join(f.worker, "vendor", "extra.ts"), "export const extra = true;\n");
    expect(() => f.runner.bindVerdict("toy-run")).toThrow("verdict needs a clean committed worktree");
  });

  test("verdict cleanliness does not honor worker core.worktree", () => {
    const f = patchVerdictFixture(false, true, (worker) => {
      const sub = join(worker, "vendor");
      mkdirSync(sub);
      git(sub, "init", "-q");
      writeFileSync(join(sub, "lib.ts"), "export const v = 1;\n");
      git(sub, "add", ".");
      git(sub, "commit", "-qm", "nested");
      git(worker, "add", "vendor");
      git(worker, "commit", "-qm", "add gitlink");
    });
    const decoy = join(f.privateDir, "decoy-worktree");
    cpSync(f.worker, decoy, { recursive: true });
    const decoyRoot = realpathSync(decoy);
    expect(Bun.spawnSync(["git", "-C", f.worker, "config", "core.worktree", decoyRoot]).exitCode).toBe(0);
    expect(
      Bun.spawnSync(["git", "-C", join(f.worker, "vendor"), "config", "core.worktree", join(decoyRoot, "vendor")])
        .exitCode,
    ).toBe(0);
    writeFileSync(join(f.worker, "loose.txt"), "untracked in real worktree\n");
    writeFileSync(join(f.worker, "vendor", "loose.ts"), "untracked in gitlink\n");
    expect(() => f.runner.bindVerdict("toy-run")).toThrow("verdict needs a clean committed worktree");
  });

  test("verdict merge-tree scratch is outside the worker root", async () => {
    const f = patchVerdictFixture(false, true, conflictingReadme);
    const log = join(f.privateDir, "scratch-seen.log");
    const child = Bun.spawn(
      [
        "bash",
        "-c",
        `home=$1; gitdir=$2; log=$3
         : > "$log"
         while [ ! -f "$log.stop" ]; do
           for d in "$home"/ak-merge-*; do
             [ -d "$d" ] && printf 'home %s\\n' "$d" >> "$log"
           done
           for d in "$gitdir"/ak-merge-*; do
             [ -d "$d" ] && printf 'worker %s\\n' "$d" >> "$log"
           done
         done`,
        "bash",
        f.privateDir,
        join(f.worker, ".git"),
        log,
      ],
      { stdout: "ignore", stderr: "ignore" },
    );
    try {
      await Bun.sleep(20);
      expect(() => f.runner.bindVerdict("toy-run")).toThrow("merge-tree reports a conflict");
    } finally {
      writeFileSync(`${log}.stop`, "");
      child.kill();
      await child.exited;
    }
    const lines = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : [];
    expect(lines.some((line) => line.startsWith("home "))).toBe(true);
    expect(lines.some((line) => line.startsWith("worker "))).toBe(false);
    const workerRoot = realpathSync(f.worker);
    for (const line of lines) {
      if (!line.startsWith("home ")) continue;
      expect(relative(workerRoot, line.slice(5)).startsWith("..")).toBe(true);
    }
  });

  test("verdict merge-tree throws when the branches have no merge-base", () => {
    const f = patchVerdictFixture();
    git(f.worker, "checkout", "--orphan", "unrelated");
    git(f.worker, "commit", "-qm", "unrelated root");
    git(f.worker, "branch", "-M", "main");
    git(f.worker, "checkout", "feature");
    const context = resolveRunnerGit(f.worker);
    expect(() => mergeTreeClean(context, f.worker, "main", workerHead(f.worker))).toThrow("cannot inspect merge tree");
    expect(() => f.runner.bindVerdict("toy-run")).toThrow("cannot inspect merge tree");
  });

  test("a nested git init does not make a parent merge conflict look clean", () => {
    const f = patchVerdictFixture(false, true, conflictingReadme);
    const nested = join(f.worker, "app");
    mkdirSync(nested);
    git(nested, "init", "-q");
    writeFileSync(join(nested, "decoy.txt"), "decoy\n");
    git(nested, "add", ".");
    git(nested, "commit", "-qm", "decoy");
    const context = { ...resolveRunnerGit(f.worker), home: f.privateDir };
    expect(mergeTreeClean(context, f.worker, "main", f.revision)).toBe(false);
    let nestedClean = false;
    try {
      nestedClean = mergeTreeClean(context, nested, "main", f.revision);
    } catch {
      nestedClean = false;
    }
    expect(nestedClean).toBe(false);
  });

  test("a bare workerRoot refuses verdict-bearing git", () => {
    const bare = mkdtempSync(join(scratchRoot, "ak-bare-"));
    git(bare, "init", "--bare", "-q");
    const context = resolveRunnerGit(bare);
    expect(context.gitDir).toBeUndefined();
    expect(context.workTree).toBeUndefined();
    expect(() => cleanCommittedTree(context, bare)).toThrow("git layout is not pinned");
    expect(() => patchIdentity(context, bare, "HEAD", "HEAD")).toThrow("git layout is not pinned");
    expect(() => mergeTreeClean(context, bare, "HEAD", "HEAD")).toThrow("git layout is not pinned");
    expect(() => ciConfigDrift(context, bare, "a", "b")).toThrow("git layout is not pinned");
  });

  test("a planted gitfile after bind cannot hide dirt or reuse a verdict", () => {
    const f = patchVerdictFixture();
    const head = workerHead(f.worker);
    expect(f.runner.bindVerdict("toy-run").patch_id).toBeDefined();
    const decoy = mkdtempSync(join(scratchRoot, "ak-decoy-"));
    git(decoy, "init", "-q", "-b", "main");
    writeFileSync(join(decoy, "decoy.txt"), "decoy\n");
    git(decoy, "add", ".");
    git(decoy, "commit", "-qm", "decoy");
    rmSync(join(f.worker, ".git"), { recursive: true });
    writeFileSync(join(f.worker, ".git"), `gitdir: ${realpathSync(join(decoy, ".git"))}\n`);
    writeFileSync(join(f.worker, "loose.txt"), "untracked\n");
    expect(() => f.runner.revision("toy-run", head)).toThrow("git layout changed since start");
  });

  test("a planted nested gitfile cannot make a merge conflict look clean", () => {
    const f = patchVerdictFixture(false, true, conflictingReadme);
    const context = { ...resolveRunnerGit(f.worker), home: f.privateDir };
    const decoy = mkdtempSync(join(scratchRoot, "ak-decoy-"));
    git(decoy, "init", "-q", "-b", "main");
    writeFileSync(join(decoy, "decoy.txt"), "decoy\n");
    git(decoy, "add", ".");
    git(decoy, "commit", "-qm", "decoy");
    const nested = join(f.worker, "app");
    mkdirSync(nested);
    writeFileSync(join(nested, ".git"), `gitdir: ${realpathSync(join(decoy, ".git"))}\n`);
    writeFileSync(join(f.worker, "loose.txt"), "untracked\n");
    let clean = false;
    try {
      clean = mergeTreeClean(context, f.worker, "main", f.revision);
    } catch {
      clean = false;
    }
    expect(clean).toBe(false);
    expect(cleanCommittedTree(context, f.worker)).toBe(false);
    expect(() => f.runner.bindVerdict("toy-run")).toThrow("verdict needs a clean committed worktree");
  });

  test("a .git symlink is the project repo, not a wrapping parent", () => {
    const f = patchVerdictFixture(false, true, conflictingReadme);
    const stored = join(f.dir, "real.git");
    renameSync(join(f.worker, ".git"), stored);
    symlinkSync(stored, join(f.worker, ".git"));
    git(f.dir, "init", "-q", "-b", "main");
    writeFileSync(join(f.dir, "outer.txt"), "outer\n");
    git(f.dir, "add", "outer.txt");
    git(f.dir, "commit", "-qm", "outer");
    const context = { ...resolveRunnerGit(f.worker), home: f.privateDir };
    expect(mergeTreeClean(context, f.worker, "main", f.revision)).toBe(false);
    expect(() => new Runner(f.privateDir, f.worker, root).bindVerdict("toy-run")).toThrow(
      "merge-tree reports a conflict",
    );
  });

  test("bindVerdict on a linked worktree uses the common object directory", () => {
    const f = patchVerdictFixture();
    const linked = join(f.dir, "linked");
    expect(Bun.spawnSync(["git", "-C", f.worker, "worktree", "add", "-q", "--detach", linked]).exitCode).toBe(0);
    const linkedRunner = new Runner(f.privateDir, linked, root);
    expect(linkedRunner.bindVerdict("toy-run").patch_id).toBeDefined();
  });

  test("a conflicting linked worktree reports a merge-tree conflict", () => {
    const f = patchVerdictFixture(false, true, conflictingReadme);
    const linked = join(f.dir, "linked");
    expect(Bun.spawnSync(["git", "-C", f.worker, "worktree", "add", "-q", "--detach", linked]).exitCode).toBe(0);
    expect(() => new Runner(f.privateDir, linked, root).bindVerdict("toy-run")).toThrow(
      "merge-tree reports a conflict",
    );
  });

  test("git submodule add gitfile work tree stays clean", () => {
    const f = patchVerdictFixture(false, true, (worker) => {
      const src = mkdtempSync(join(scratchRoot, "ak-subsrc-"));
      git(src, "init", "-q", "-b", "main");
      writeFileSync(join(src, "lib.ts"), "export const v = 1;\n");
      git(src, "add", ".");
      git(src, "commit", "-qm", "nested");
      git(worker, "-c", "protocol.file.allow=always", "submodule", "add", src, "vendor");
      git(worker, "commit", "-qm", "add submodule");
    });
    const context = resolveRunnerGit(f.worker);
    const vendorGit = join(f.worker, "vendor", ".git");
    expect(lstatSync(vendorGit).isFile()).toBe(true);
    expect(readFileSync(vendorGit, "utf8")).toContain(".git/modules/");
    expect(cleanCommittedTree(context, f.worker)).toBe(true);
    expect(f.runner.bindVerdict("toy-run").patch_id).toBeDefined();
  });

  test("a nested start with a gitfile to a different repo still uses the parent binding", () => {
    const f = fixture();
    const parsed: unknown = JSON.parse(readFileSync(join(f.privateDir, "toy-ticket.json"), "utf8"));
    if (!asJsonObject(parsed)) throw new Error("toy ticket is not an object");
    const ticket = enabledToyTicket(parsed);
    unlinkSync(join(f.privateDir, "toy-ticket.json"));
    retargetCharterTicket(f, ticket);
    const planted = publishToyKb(ticket, "on");
    const nested = join(f.worker, "app");
    mkdirSync(nested);
    writeFileSync(join(f.worker, "ak.kb.yaml"), TOY_BINDING);
    writeFileSync(join(nested, "nested.txt"), "nested\n");
    git(f.worker, "add", "ak.kb.yaml", "app");
    git(f.worker, "commit", "-qm", "parent bind");
    const decoy = mkdtempSync(join(scratchRoot, "ak-decoy-"));
    git(decoy, "init", "-q", "-b", "main");
    writeFileSync(join(decoy, "decoy.txt"), "decoy\n");
    git(decoy, "add", ".");
    git(decoy, "commit", "-qm", "decoy");
    writeFileSync(join(nested, ".git"), `gitdir: ${realpathSync(join(decoy, ".git"))}\n`);
    const revision = workerHead(f.worker);
    const runner = new Runner(f.privateDir, nested, root);
    const started = withRegistry(planted.registry, () =>
      runner.start("toy-run", f.path, "implementer-1", revision, standing(f)),
    );
    expect(started.behavior?.mode).toBe("on");
    expect(started.behavior?.required_checks).toHaveLength(1);
  });

  test("verdict merge-tree uses one merge-base tree when the history is criss-cross", () => {
    const f = patchVerdictFixture(false, true, (worker) => {
      git(worker, "checkout", "main");
      const ancestor = Bun.spawnSync(["git", "-C", worker, "rev-parse", "HEAD"]).stdout.toString().trim();
      writeFileSync(join(worker, "left.txt"), "B\n");
      git(worker, "add", "left.txt");
      git(worker, "commit", "-qm", "B");
      const b = Bun.spawnSync(["git", "-C", worker, "rev-parse", "HEAD"]).stdout.toString().trim();
      git(worker, "checkout", "-qb", "right", ancestor);
      writeFileSync(join(worker, "right.txt"), "C\n");
      git(worker, "add", "right.txt");
      git(worker, "commit", "-qm", "C");
      git(worker, "checkout", "-B", "feature", b);
      git(worker, "merge", "--no-edit", "-q", "right");
      git(worker, "checkout", "-B", "main", "right");
      git(worker, "merge", "--no-edit", "-q", b);
      git(worker, "checkout", "feature");
    });
    const all = Bun.spawnSync(["git", "-C", f.worker, "merge-base", "--all", "main", "HEAD"]);
    expect(all.exitCode).toBe(0);
    expect(all.stdout.toString().trim().split("\n")).toHaveLength(2);
    const one = Bun.spawnSync(["git", "-C", f.worker, "merge-base", "main", "HEAD"]);
    expect(one.exitCode).toBe(0);
    expect(all.stdout.toString()).toContain(one.stdout.toString().trim());
    expect(f.runner.bindVerdict("toy-run").head_revision).toBe(f.revision);
  });

  test("verdict merge-tree does not honor worker merge.default union", () => {
    const f = patchVerdictFixture(false, true, conflictingReadme);
    expect(Bun.spawnSync(["git", "-C", f.worker, "config", "merge.default", "union"]).exitCode).toBe(0);
    expect(() => f.runner.bindVerdict("toy-run")).toThrow("merge-tree reports a conflict");
  });

  test("verdict merge-tree does not honor .git/info/attributes merge=union", () => {
    const f = patchVerdictFixture(false, true, conflictingReadme);
    writeFileSync(join(f.worker, ".git", "info", "attributes"), "README.md merge=union\n");
    expect(() => f.runner.bindVerdict("toy-run")).toThrow("merge-tree reports a conflict");
  });

  test("verdict merge-tree does not run a worker merge driver", () => {
    const f = patchVerdictFixture(false, true, (worker) => {
      conflictingReadme(worker);
      writeFileSync(join(worker, ".gitattributes"), "README.md merge=lie\n");
      git(worker, "add", ".gitattributes");
      git(worker, "commit", "-qm", "feature merge attr");
      git(worker, "checkout", "main");
      writeFileSync(join(worker, ".gitattributes"), "README.md merge=lie\n");
      git(worker, "add", ".gitattributes");
      git(worker, "commit", "-qm", "main merge attr");
      git(worker, "checkout", "feature");
    });
    const marker = join(f.privateDir, "merge-driver.marker");
    const script = join(f.privateDir, "merge-driver.sh");
    writeFileSync(script, `#!/bin/sh\nprintf ran\\n > ${JSON.stringify(marker)}\nexit 0\n`);
    chmodSync(script, 0o700);
    expect(Bun.spawnSync(["git", "-C", f.worker, "config", "merge.lie.driver", `${script} %O %A %B`]).exitCode).toBe(0);
    expect(() => f.runner.bindVerdict("toy-run")).toThrow("merge-tree reports a conflict");
    expect(existsSync(marker)).toBe(false);
  });

  test("verdict merge-tree keeps a merge-base binary attribute as a conflict", () => {
    const f = patchVerdictFixture(false, true, (worker) => {
      commitOnMergeBaseThenDiverge(
        worker,
        {
          ".gitattributes": "*.dat binary\n",
          "file.dat": "line1\nline2\nline3\nline4\nline5\n",
        },
        { "file.dat": "line1\nFEATURE\nline3\nline4\nline5\n" },
        { "file.dat": "line1\nline2\nline3\nMAIN\nline5\n" },
      );
    });
    expect(() => f.runner.bindVerdict("toy-run")).toThrow("merge-tree reports a conflict");
  });

  test("verdict merge-tree does not honor ancestor-only merge=union", () => {
    const f = patchVerdictFixture(false, true, (worker) => {
      commitOnMergeBaseThenDiverge(
        worker,
        {
          ".gitattributes": "file.dat merge=union\n",
          "file.dat": "line1\nBASE\nline3\n",
        },
        {
          ".gitattributes": "file.dat merge=text\n",
          "file.dat": "line1\nFEATURE\nline3\n",
        },
        {
          ".gitattributes": "file.dat merge=text\n",
          "file.dat": "line1\nMAIN\nline3\n",
        },
      );
    });
    expect(() => f.runner.bindVerdict("toy-run")).toThrow("merge-tree reports a conflict");
  });

  test("verdict merge-tree does not honor merge-base merge=union", () => {
    const f = patchVerdictFixture(false, true, (worker) => {
      commitOnMergeBaseThenDiverge(
        worker,
        {
          ".gitattributes": "file.dat merge=union\n",
          "file.dat": "line1\nBASE\nline3\n",
        },
        { "file.dat": "line1\nFEATURE\nline3\n" },
        { "file.dat": "line1\nMAIN\nline3\n" },
      );
    });
    expect(() => f.runner.bindVerdict("toy-run")).toThrow("merge-tree reports a conflict");
  });

  test("verdict merge-tree does not honor union planted on local main", () => {
    const f = patchVerdictFixture(false, true, (worker) => {
      git(worker, "checkout", "main");
      writeFileSync(join(worker, ".gitattributes"), "file.dat merge=union\n");
      writeFileSync(join(worker, "file.dat"), "line1\nBASE\nline3\n");
      git(worker, "add", ".gitattributes", "file.dat");
      git(worker, "commit", "-qm", "plant union on main");
      git(worker, "checkout", "feature");
      git(worker, "merge", "--no-edit", "-q", "main");
      writeFileSync(join(worker, "file.dat"), "line1\nFEATURE\nline3\n");
      git(worker, "add", "file.dat");
      git(worker, "commit", "-qm", "feature side");
      git(worker, "checkout", "main");
      writeFileSync(join(worker, "file.dat"), "line1\nMAIN\nline3\n");
      git(worker, "add", "file.dat");
      git(worker, "commit", "-qm", "main side");
      git(worker, "checkout", "feature");
    });
    expect(() => f.runner.bindVerdict("toy-run")).toThrow("merge-tree reports a conflict");
  });

  test("verdict merge-tree does not honor merge-base * merge=union on add/add", () => {
    const f = patchVerdictFixture(false, true, (worker) => {
      git(worker, "checkout", "main");
      writeFileSync(join(worker, ".gitattributes"), "* merge=union\n");
      git(worker, "add", ".gitattributes");
      git(worker, "commit", "-qm", "star union");
      git(worker, "checkout", "feature");
      git(worker, "merge", "--no-edit", "-q", "main");
      writeFileSync(join(worker, "added.txt"), "FEATURE\n");
      git(worker, "add", "added.txt");
      git(worker, "commit", "-qm", "feature add");
      git(worker, "checkout", "main");
      writeFileSync(join(worker, "added.txt"), "MAIN\n");
      git(worker, "add", "added.txt");
      git(worker, "commit", "-qm", "main add");
      git(worker, "checkout", "feature");
    });
    expect(() => f.runner.bindVerdict("toy-run")).toThrow("merge-tree reports a conflict");
  });

  test("verdict merge-tree does not run a merge-base worker merge driver", () => {
    const f = patchVerdictFixture(false, true, (worker) => {
      commitOnMergeBaseThenDiverge(
        worker,
        {
          ".gitattributes": "file.dat merge=lie\n",
          "file.dat": "base\n",
        },
        { "file.dat": "feature\n" },
        { "file.dat": "main\n" },
      );
    });
    const marker = join(f.privateDir, "merge-base-driver.marker");
    const script = join(f.privateDir, "merge-base-driver.sh");
    writeFileSync(script, `#!/bin/sh\nprintf ran\\n > ${JSON.stringify(marker)}\nexit 0\n`);
    chmodSync(script, 0o700);
    expect(Bun.spawnSync(["git", "-C", f.worker, "config", "merge.lie.driver", `${script} %O %A %B`]).exitCode).toBe(0);
    expect(() => f.runner.bindVerdict("toy-run")).toThrow("merge-tree reports a conflict");
    expect(existsSync(marker)).toBe(false);
  });

  test.skipIf(!SHA256_SUPPORTED)("verdict merge-tree honors a sha256 worker object format", () => {
    const worker = mkdtempSync(join(scratchRoot, "ak-sha256-feature-"));
    writeFileSync(join(worker, ".gitignore"), ".runner-requests/\n");
    writeFileSync(join(worker, "README.md"), "toy worktree\n");
    expect(Bun.spawnSync(["git", "init", "-q", "--object-format=sha256", worker]).exitCode).toBe(0);
    git(worker, "add", ".");
    git(worker, "commit", "-qm", "Create toy charter worktree");
    git(worker, "branch", "-M", "main");
    git(worker, "checkout", "-qb", "feature");
    writeFileSync(join(worker, "feature.txt"), "feature\n");
    git(worker, "add", "feature.txt");
    git(worker, "commit", "-qm", "add feature");
    mkdirSync(join(worker, ".runner-requests"));
    const revision = Bun.spawnSync(["git", "-C", worker, "rev-parse", "HEAD"]).stdout.toString().trim();
    const f = fixture(3, { worker, revision });
    f.runner.start("toy-run", f.path, "implementer-1", f.revision, standing(f));
    const receipt = join(f.privateDir, "source.txt");
    writeFileSync(receipt, "source evidence");
    f.runner.collect("toy-run", "e1", receipt, f.revision, "source");
    reachShipReady(f);
    expect(Bun.spawnSync(["git", "-C", f.worker, "rev-parse", "--show-object-format"]).stdout.toString().trim()).toBe(
      "sha256",
    );
    expect(f.runner.bindVerdict("toy-run").head_revision).toBe(f.revision);
  });

  test("verdict ls-files diff-index hash-object and rev-parse do not run worker programs", () => {
    const f = patchVerdictFixture();
    const marker = join(f.privateDir, "other-git.marker");
    const script = join(f.privateDir, "other-git.sh");
    writeFileSync(script, `#!/bin/sh\nprintf ran\\n > ${JSON.stringify(marker)}\ncat\n`);
    chmodSync(script, 0o700);
    writeFileSync(join(f.worker, ".git", "info", "exclude"), ".gitattributes\n");
    writeFileSync(join(f.worker, ".gitattributes"), "feature.txt filter=lie merge=lie diff=lie\n");
    expect(Bun.spawnSync(["git", "-C", f.worker, "config", "filter.lie.clean", script]).exitCode).toBe(0);
    expect(Bun.spawnSync(["git", "-C", f.worker, "config", "filter.lie.smudge", script]).exitCode).toBe(0);
    expect(Bun.spawnSync(["git", "-C", f.worker, "config", "merge.lie.driver", `${script} %O %A %B`]).exitCode).toBe(0);
    expect(Bun.spawnSync(["git", "-C", f.worker, "config", "diff.lie.textconv", script]).exitCode).toBe(0);
    let failed = false;
    try {
      f.runner.bindVerdict("toy-run");
    } catch {
      failed = true;
    }
    expect(existsSync(marker)).toBe(false);
    expect(failed).toBe(false);
  });

  test("verdict cleanliness treats a group-exec worktree bit as executable", () => {
    const f = patchVerdictFixture();
    chmodSync(join(f.worker, "feature.txt"), 0o650);
    expect(() => f.runner.bindVerdict("toy-run")).toThrow("verdict needs a clean committed worktree");
  });

  test("verdict cleanliness allows a tracked ..foo path", () => {
    const f = patchVerdictFixture(false, true, (worker) => {
      writeFileSync(join(worker, "..foo"), "inside\n");
      git(worker, "add", "--", "..foo");
      git(worker, "commit", "-qm", "dotdotfoo");
    });
    expect(f.runner.bindVerdict("toy-run").head_revision).toBe(f.revision);
  });

  test("verdict cleanliness treats eol=crlf checkout bytes that differ from the blob as dirty", () => {
    const f = patchVerdictFixture(false, true, (worker) => {
      writeFileSync(join(worker, ".gitattributes"), "feature.txt text eol=crlf\n");
      git(worker, "add", ".gitattributes");
      git(worker, "commit", "-qm", "crlf attr");
      unlinkSync(join(worker, "feature.txt"));
      git(worker, "checkout", "--", "feature.txt");
    });
    expect(Bun.spawnSync(["git", "-C", f.worker, "status", "--porcelain"]).stdout.toString().trim()).toBe("");
    expect(readFileSync(join(f.worker, "feature.txt")).includes(0x0d)).toBe(true);
    expect(() => f.runner.bindVerdict("toy-run")).toThrow("verdict needs a clean committed worktree");
  });

  test(
    "charter-bound live smoke wakes through an event and reaches a local ready branch",
    async () => {
      const f = fixture();
      const cliEntry = process.env["AK_AUTONOMY_SMOKE_ENTRY"] ?? join(root, "src", "cli.ts");
      withAuditCadence(f);
      git(f.worker, "branch", "-M", "main");
      git(f.worker, "checkout", "-qb", "feature");
      writeFileSync(join(f.worker, "feature.txt"), "ready branch\n");
      git(f.worker, "add", "feature.txt");
      git(f.worker, "commit", "-qm", "prepare feature");
      const head = workerHead(f.worker);
      const socket = join(f.privateDir, "runner.sock");
      const tokenFile = join(f.privateDir, "admin.token");
      const eventConfig = join(f.privateDir, "event.json");
      const loopConfig = join(f.privateDir, "loop.json");
      const seatConfig = join(f.privateDir, "seats.json");
      const verifyConfig = join(f.privateDir, "verify.json");
      const loopLog = join(f.privateDir, "audit-probe.json");
      const consumerRequest = join(f.privateDir, "consumer.json");
      const request = join(f.requestDir, "smoke.json");
      const adminToken = "a".repeat(48);
      const workerToken = "b".repeat(48);
      writeFileSync(tokenFile, adminToken, { mode: 0o600 });
      writeFileSync(
        seatConfig,
        JSON.stringify({
          launchers: ["seat-a", "seat-b"].map((seat) => ({
            seat,
            actor: `supervisor-${seat}`,
            lineage: [`supervisor-${seat}`],
            command: [
              process.execPath,
              "-e",
              "const p=JSON.parse(await Bun.stdin.text());console.log(JSON.stringify({choice:p.card.approve,rationale:'charter and evidence agree'}));",
            ],
          })),
        }),
      );
      writeFileSync(
        verifyConfig,
        JSON.stringify({ command: [process.execPath, "-e", "console.log('scratch behavior passed')"] }),
      );
      writeFileSync(
        eventConfig,
        JSON.stringify({
          timeout_ms: LIVE_SMOKE_WAIT_MS,
          command: [
            process.execPath,
            "-e",
            "const e=JSON.parse(await Bun.stdin.text());await Bun.write(process.argv[1],JSON.stringify({run:e.run,card_id:'align'}));const p=Bun.spawnSync([process.execPath,process.argv[2],'runner','call','decide','--json',process.argv[1],'--socket',process.env.AK_RUNNER_SOCKET],{env:process.env,stdout:'pipe',stderr:'pipe'});if(p.exitCode!==0)throw new Error(p.stderr.toString());console.log(JSON.stringify({run:e.run,key:e.key}));",
            consumerRequest,
            cliEntry,
          ],
        }),
      );
      writeFileSync(
        loopConfig,
        JSON.stringify({
          timeout_ms: LIVE_SMOKE_WAIT_MS,
          command: [
            process.execPath,
            "-e",
            "const x=JSON.parse(await Bun.stdin.text());if(x.action!=='probe')process.exit(2);await Bun.write(process.argv[1],JSON.stringify(x));console.log(JSON.stringify({probed:x.delegates,progress:[]}));",
            loopLog,
          ],
        }),
      );
      const service = spawnLive(
        [
          process.execPath,
          cliEntry,
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
          tokenFile,
          "--event-config",
          eventConfig,
          "--loop-config",
          loopConfig,
          "--seat-config",
          seatConfig,
          "--verify-config",
          verifyConfig,
        ],
        { cwd: root, env: { ...process.env, AK_RUNNER_WORKER_TOKEN: workerToken }, stdout: "pipe", stderr: "pipe" },
      );
      const call = (verb: string, token: string, args: RunnerArgs) => {
        writeFileSync(request, JSON.stringify(args));
        const response = callRunnerCli(verb, request, socket, token, CONTENDED_RUNNER_CALL_TIMEOUT_MS);
        expect(response.exitCode).toBe(0);
        return response;
      };
      const prepare = (id: string, operation: string, covers: string, evidence: string) =>
        call("prepare", workerToken, {
          run: "toy-run",
          card: {
            id,
            operation,
            grant: { charter_hash: f.charter.immutability.hash, covers },
            question: "Proceed under the charter?",
            options: ["yes", "no"],
            approve: "yes",
            evidence: [evidence],
            artifact_hash: `sha256:${"b".repeat(64)}`,
          },
        });
      try {
        await waitForPath(socket, service);
        call("start", adminToken, {
          run: "toy-run",
          charter: f.path,
          implementer: "implementer-1",
          revision: head,
          standing_grant: {
            charter_hash: f.charter.immutability.hash,
            covers: "autopilot.start",
            controller: "firstmate",
            run_id: "toy-run",
          },
        });
        expect(autonomyOf(call("status", workerToken, { run: "toy-run" }))).toEqual({
          mode: "autonomous",
          missing: [],
        });
        const source = join(f.privateDir, "source.txt");
        writeFileSync(source, "approved scratch work source");
        call("collect", adminToken, { run: "toy-run", id: "e1", source, revision: head, kind: "source" });
        call("delegate", adminToken, { run: "toy-run", id: "owner-1", amount: LIVE_SMOKE_TIMEOUT_MS / 1000 });
        call("progress", adminToken, { run: "toy-run", id: "owner-1", kind: "commit", source: head });
        prepare("align", "align.run", "align-answer", "e1");
        call("event", adminToken, { run: "toy-run", key: "wake-align", payload: "checkpoint available" });
        await waitUntil(
          "the event wake to reach alignment",
          () => f.runner.status("toy-run").run_state === "alignment",
          LIVE_SMOKE_WAIT_MS,
        );
        await waitUntil(
          "the wake event to be acknowledged",
          () => f.runner.pendingEvents("toy-run").length === 0,
          LIVE_SMOKE_WAIT_MS,
        );
        for (const [id, operation, covers] of [
          ["bound", "bound.run", "spec-approval"],
          ["build", "build.dispatch", "build-go"],
        ] as const) {
          prepare(id, operation, covers, "e1");
          call("decide", workerToken, { run: "toy-run", card_id: id });
        }
        call("run-verify", workerToken, { run: "toy-run" });
        const verify = Object.values(f.runner.status("toy-run").evidence).find((entry) => entry.kind === "verify");
        if (verify === undefined) throw new Error("live verification receipt missing");
        for (const [id, operation, covers] of [
          ["review", "review.full", "finding-adjudication"],
          ["readiness", "review.readiness", "finding-adjudication"],
        ] as const) {
          prepare(id, operation, covers, verify.id);
          call("decide", workerToken, { run: "toy-run", card_id: id });
        }
        call("verdict", adminToken, { run: "toy-run" });
        prepare("ship", "ship.prepare", "ship-pr", verify.id);
        call("decide", workerToken, { run: "toy-run", card_id: "ship" });
        await waitForPath(loopLog, service);
        call("finish", adminToken, { run: "toy-run", id: "owner-1" });
        const ledger = f.runner.ledger("toy-run");
        const run = f.runner.status("toy-run");
        expect(ledger.status).toBe("ready-to-ship");
        expect(ledger.entries).toHaveLength(6);
        expect(ledger.entries.every((entry) => entry.outcome === "ruling")).toBe(true);
        expect(
          run.decisions.every((decision) => decision.card.judgments.length === 2 && decision.answer === undefined),
        ).toBe(true);
        expect(run.verdict?.head_revision).toBe(head);
        const ledgerPath = process.env["AK_AUTONOMY_SMOKE_LEDGER"];
        if (ledgerPath !== undefined) writeFileSync(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
        const transcriptPath = process.env["AK_AUTONOMY_SMOKE_TRANSCRIPT"];
        if (transcriptPath !== undefined)
          writeFileSync(
            transcriptPath,
            `scratch=${f.worker}\nhead=${head}\nmode=autonomous\nevent=wake-align acknowledged\naudit=probe observed\ncheckpoints=${ledger.entries.map((entry) => entry.checkpoint).join(",")}\nstatus=${ledger.status}\n`,
          );
      } finally {
        service.kill("SIGTERM");
        await service.exited;
      }
      // Drives the live runner service through 16 CLI calls, 6 two-seat checkpoints, and event/verify subprocesses.
    },
    LIVE_SMOKE_TIMEOUT_MS,
  );

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
            command: [process.execPath, "-e", judgeScript, launches],
          },
          {
            seat: "seat-b",
            actor: "supervisor-2",
            lineage: ["supervisor-2"],
            command: [process.execPath, "-e", judgeScript, launches],
          },
        ],
      }),
    );
    writeFileSync(
      verifyConfig,
      JSON.stringify({ command: [process.execPath, "-e", "console.log('verification passed')"] }),
    );
    writeFileSync(
      effectConfig,
      JSON.stringify({
        adapters: [
          {
            effect: "pr-open",
            read_back: [
              process.execPath,
              "-e",
              "const f=process.argv[1]; if (await Bun.file(f).exists()) process.stdout.write(await Bun.file(f).text());",
              remote,
            ],
            perform: [
              process.execPath,
              "-e",
              "await Bun.write(process.argv[1], process.argv[2]);",
              remote,
              "{input_hash}",
            ],
          },
        ],
      }),
    );
    const adminToken = "a".repeat(48);
    const workerToken = "b".repeat(48);
    const adminTokenFile = join(f.privateDir, "admin.token");
    writeFileSync(adminTokenFile, adminToken, { mode: 0o600 });
    const launch = [
      process.execPath,
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
    let server = spawnLive(launch, serverOptions);
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
          perform: [process.execPath, "-e", "process.exit(1)"],
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
      server = spawnLive(launch, serverOptions);
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
    expect(() => f.runner.judge("toy-run", "card", "seat-b", "supervisor-1", "dispatch-b", "yes", [])).toThrow(
      "seat is not independently dispatched",
    );
    expect(() =>
      f.runner.judge("toy-run", "card", "seat-b", "supervisor-2", "dispatch-b", "yes", ["dispatch-a"]),
    ).toThrow("seat is not independently dispatched");
    // A different actor reusing seat-a's dispatch id is the same dispatch, so it cannot fill seat-b.
    expect(() => f.runner.judge("toy-run", "card", "seat-b", "supervisor-2", "dispatch-a", "yes", [])).toThrow(
      "seat is not independently dispatched",
    );
    expect(() =>
      f.runner.judge("toy-run", "card", "seat-b", "supervisor-2", "dispatch-b", "yes", ["dispatch-elsewhere"]),
    ).toThrow("seat input includes another dispatch");
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
    ).toThrow("invalid or excluded seat");
    expect(f.runner.decide("toy-run", "card").escalation?.charter_rule).toBe("runner:seat-independence");
    expect(f.runner.judge("toy-run", "card", "seat-a", "supervisor-1", "dispatch-a", "yes", []).judgments).toHaveLength(
      1,
    );
    transcript.push(
      "Refusal: same actor in both seats and a seat input containing the other dispatch → rejected before judgment.",
    );
  });

  test("a second seat whose lineage names the first seat's actor is refused", () => {
    const f = ready();
    const prepare = (id: string) =>
      f.runner.prepare("toy-run", {
        id,
        operation: "align.run",
        grant: { charter_hash: f.charter.immutability.hash, covers: "align-answer" },
        question: "Proceed?",
        options: ["yes", "no"],
        approve: "yes",
        evidence: ["e1"],
        artifact_hash: `sha256:${"b".repeat(64)}`,
      });
    prepare("forward");
    f.runner.judge("toy-run", "forward", "seat-a", "supervisor-1", "forward-a", "yes", [], ["supervisor-1"]);
    expect(() =>
      f.runner.judge(
        "toy-run",
        "forward",
        "seat-b",
        "supervisor-2",
        "forward-b",
        "yes",
        [],
        ["supervisor-2", "supervisor-1"],
      ),
    ).toThrow("invalid or excluded seat");
    prepare("reverse");
    f.runner.judge(
      "toy-run",
      "reverse",
      "seat-a",
      "supervisor-1",
      "reverse-a",
      "yes",
      [],
      ["supervisor-1", "supervisor-2"],
    );
    expect(() =>
      f.runner.judge("toy-run", "reverse", "seat-b", "supervisor-2", "reverse-b", "yes", [], ["supervisor-2"]),
    ).toThrow("invalid or excluded seat");
    // A persisted pair that slipped past judge still cannot complete the card.
    const run = f.runner.status("toy-run");
    const forward = run.cards["forward"];
    if (forward === undefined) throw new Error("forward card missing");
    forward.judgments.push({
      seat: "seat-b",
      actor: "supervisor-2",
      dispatch: "forward-b",
      choice: "yes",
      rationale: "Independent supervisor judgment",
      input_dispatches: [],
      lineage: ["supervisor-2", "supervisor-1"],
    });
    writeFileSync(join(f.privateDir, "toy-run.json"), JSON.stringify(run));
    const runner = new Runner(f.privateDir, f.worker, root);
    const decided = runner.decide("toy-run", "forward");
    expect(decided.status).toBe("needs-input");
    expect(decided.escalation?.charter_rule).toBe("runner:seat-independence");
    const file = join(f.privateDir, "toy-run-forward.decision.json");
    const doc = parseJson(readFileSync(file, "utf8"));
    if (!(doc instanceof Object) || Array.isArray(doc)) throw new Error("expected decision object");
    expect(doc).toMatchObject({
      status: "blocked",
      authority_check: { seats_independent: false, result: "fail", failed_checks: ["seats_independent"] },
      grants_issued: [],
    });
    expect(checkDocument(file, doc, indexDocuments([{ file, doc }]))).toEqual([]);
    expect(runner.answer("toy-run", "forward", "yes", "captain", "Explicit approval").status).toBe("complete");
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ authority_check: doc["authority_check"] });
  });

  test.each([
    ["independent", {}, true, []],
    ["reverse lineage", { lineage: ["supervisor-1", "supervisor-2"] }, false, []],
    ["duplicate actor", { actor: "supervisor-2", lineage: ["supervisor-2"] }, false, []],
    ["duplicate seat", { seat: "seat-b" }, false, []],
    ["duplicate dispatch", { dispatch: "card-1-dispatch-b" }, false, []],
    ["excluded lineage", { lineage: ["supervisor-1", "implementer-1"] }, false, []],
    ["shared input", { input_dispatches: ["card-1-dispatch-b"] }, false, []],
    ["missing own lineage", { lineage: [] }, false, []],
    ["failed dispatch", {}, false, ["seat-b failed"]],
  ] as const)("persisted %s seats produce consistent authority evidence", (_name, change, independent, failures) => {
    const f = ready();
    card(f);
    const run = f.runner.status("toy-run");
    const judgment = run.cards["card-1"]?.judgments[0];
    if (judgment === undefined) throw new Error("first judgment missing");
    Object.assign(judgment, change);
    writeFileSync(join(f.privateDir, "toy-run.json"), JSON.stringify(run));
    const runner = new Runner(f.privateDir, f.worker, root);
    expect(runner.decide("toy-run", "card-1", [...failures]).status).toBe(independent ? "complete" : "needs-input");
    const file = join(f.privateDir, "toy-run-card-1.decision.json");
    const doc = parseJson(readFileSync(file, "utf8"));
    if (!(doc instanceof Object) || Array.isArray(doc)) throw new Error("expected decision object");
    expect(doc["authority_check"]).toMatchObject({
      seats_independent: independent,
      result: independent ? "pass" : "fail",
    });
    const index = indexDocuments([{ file, doc }]);
    const rule = "decision.authority-check-recomputed-from-charter-and-evidence";
    expect(checkDocument(file, doc, index).filter((issue) => issue.rule === rule)).toEqual([]);
    if (!independent) {
      doc["authority_check"] = {
        deterministic: true,
        charter_permits: true,
        required_evidence_present: true,
        seats_independent: true,
        checkpoint_in_charter: true,
        both_judgments_returned: true,
        result: "pass",
      };
      expect(checkDocument(file, doc, index).some((issue) => issue.rule === rule)).toBe(true);
    }
  });

  test.each([
    ["elapsed cap", "runner:budget/elapsed-minutes"],
    ["grant", "runner:grant"],
    ["freshness", "runner:evidence-freshness"],
    ["evidence", "runner:trusted-evidence"],
    ["human experience", "policy:prototype-human-experience-needs-human"],
  ] as const)("an earlier %s refusal preserves conservative independence evidence", (cause, rule) => {
    const f = ready();
    card(f);
    const run = f.runner.status("toy-run");
    const prepared = run.cards["card-1"];
    const judgment = prepared?.judgments[1];
    if (prepared === undefined || judgment === undefined) throw new Error("prepared judgments missing");
    judgment.lineage.push("supervisor-1");
    if (cause === "elapsed cap") run.created_at = new Date(Date.now() - 61 * 60_000).toISOString();
    if (cause === "grant") prepared.grant.charter_hash = `sha256:${"0".repeat(64)}`;
    if (cause === "freshness") writeFileSync(join(f.worker, "README.md"), "changed worker\n");
    if (cause === "evidence") {
      const evidence = run.evidence["e1"];
      if (evidence === undefined) throw new Error("evidence missing");
      evidence.revision = "0".repeat(40);
    }
    if (cause === "human experience") prepared.human_experience = true;
    writeFileSync(join(f.privateDir, "toy-run.json"), JSON.stringify(run));
    const runner = new Runner(f.privateDir, f.worker, root, cause === "freshness");
    const result = runner.decide("toy-run", "card-1");
    expect(result.status).toBe(cause === "elapsed cap" ? "cap-reached" : "needs-input");
    const file = join(f.privateDir, "toy-run-card-1.decision.json");
    const doc = parseJson(readFileSync(file, "utf8"));
    expect(doc).toMatchObject({
      status: "blocked",
      authority_check: { seats_independent: false, result: "fail" },
      escalation: { charter_rule: rule },
      grants_issued: [],
    });
    expect(checkDocument(file, doc, indexDocuments([{ file, doc }]))).toEqual([]);
    expect(runner.decide("toy-run", "card-1")).toEqual(result);
    expect(runner.ledger("toy-run").entries).toHaveLength(1);
  });

  test("seat judgments are accepted exactly when actors and lineages are independent", () => {
    const f = ready();
    const actors = ["supervisor-1", "supervisor-2", "supervisor-3", "supervisor-4"];
    const seat = tuple(constantFrom(...actors), subarray(actors)).map(([actor, ancestors]) => ({
      actor,
      lineage: [actor, ...ancestors.filter((a) => a !== actor)],
    }));
    let n = 0;
    fcAssert(
      property(seat, seat, (a, b) => {
        const id = `prop-${(n += 1)}`;
        f.runner.prepare("toy-run", {
          id,
          operation: "align.run",
          grant: { charter_hash: f.charter.immutability.hash, covers: "align-answer" },
          question: "Proceed?",
          options: ["yes", "no"],
          approve: "yes",
          evidence: ["e1"],
          artifact_hash: `sha256:${"b".repeat(64)}`,
        });
        f.runner.judge("toy-run", id, "seat-a", a.actor, `${id}-a`, "yes", [], a.lineage);
        const independent = a.actor !== b.actor && !a.lineage.includes(b.actor) && !b.lineage.includes(a.actor);
        const second = () => f.runner.judge("toy-run", id, "seat-b", b.actor, `${id}-b`, "yes", [], b.lineage);
        if (independent) expect(second().judgments).toHaveLength(2);
        else
          expect(second).toThrow(
            a.actor === b.actor ? "seat is not independently dispatched" : "invalid or excluded seat",
          );
      }),
      { numRuns: 100 },
    );
  });

  test("seat configuration with overlapping lineages is refused at load", async () => {
    const f = fixture();
    const adminTokenFile = join(f.privateDir, "admin.token");
    writeFileSync(adminTokenFile, "a".repeat(48), { mode: 0o600 });
    const seatConfig = join(f.privateDir, "seats.json");
    writeFileSync(
      seatConfig,
      JSON.stringify({
        launchers: [
          { seat: "seat-a", actor: "supervisor-1", lineage: ["supervisor-1"], command: ["true"] },
          { seat: "seat-b", actor: "supervisor-2", lineage: ["supervisor-2", "supervisor-1"], command: ["true"] },
        ],
      }),
    );
    const err: string[] = [];
    const previous = process.env["AK_RUNNER_WORKER_TOKEN"];
    process.env["AK_RUNNER_WORKER_TOKEN"] = "b".repeat(48);
    try {
      const argv = [
        "serve",
        "--socket",
        join(f.privateDir, "runner.sock"),
        "--state-dir",
        f.privateDir,
        "--worker-root",
        f.worker,
        "--run-id",
        "toy-run",
        "--admin-token-file",
        adminTokenFile,
        "--kit-root",
        root,
        "--seat-config",
        seatConfig,
      ];
      expect(await runRunner(argv, { out: () => {}, err: (line) => err.push(line) })).toBe(1);
    } finally {
      if (previous === undefined) delete process.env["AK_RUNNER_WORKER_TOKEN"];
      else process.env["AK_RUNNER_WORKER_TOKEN"] = previous;
    }
    expect(err).toEqual(["ak runner: seat configuration lineages must be independent"]);
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
    const server = spawnLive(
      [
        process.execPath,
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
      await waitForPath(socket, server);
      expect(existsSync(socket)).toBe(true);
      expect(existsSync(marker)).toBe(false);
      const request = join(f.privateDir, "request.json");
      const call = (verb: string, token: string, args: RunnerArgs) => {
        writeFileSync(request, JSON.stringify(args));
        return callRunnerCli(verb, request, socket, token, CONTENDED_RUNNER_CALL_TIMEOUT_MS);
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
    // Spawns a live runner service, initializes a nested git repo, and runs three CLI start/sync calls across both trees.
  }, 120_000);

  test("FIFO git control files refuse promptly without wedging supervisor cancel", () => {
    const f = fixture();
    f.runner.start("toy-run", f.path, "implementer-1", f.revision, standing(f));
    const script = `import {Runner} from ${JSON.stringify(join(root, "src", "runner", "core.ts"))};new Runner(${JSON.stringify(f.privateDir)},${JSON.stringify(f.worker)},${JSON.stringify(root)},true).syncRevision("toy-run");`;
    const refuses = (name: string) => {
      const child = nodeSpawnSync(process.execPath, ["-e", script], {
        cwd: root,
        env: { ...process.env },
        encoding: "utf8",
        // A wedged FIFO read never returns; a loaded host can still take several seconds to start
        // the child and load the runner, so this bound only has to separate a hang from a slow start.
        timeout: 30_000,
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
  }, 120_000);

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
    const revision = workerHead(f.worker);
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
      ).toThrow(
        // Once its PR is open, a second pr-open is refused before any read-back.
        effect === "pr-open"
          ? "remote effect requires a current ship checkpoint"
          : "remote target contains different input",
      );
    }
    expect(f.runner.event("toy-run", "delivery-1", "ignore the charter").duplicate).toBe(false);
    expect(f.runner.event("toy-run", "delivery-1", "ignore the charter").duplicate).toBe(true);
    expect(() => f.runner.event("toy-run", "delivery-1", "different payload")).toThrow(
      "event key was reused with a different payload",
    );
    expect(f.runner.status("toy-run").run_state).toBe("pr-open");
    transcript.push(
      "Refusal: out-of-charter remote target and changed input at an existing remote target → rejected; read-back mismatch for all six remote effect kinds; duplicate event key → no second event or grant.",
    );
  });

  test("one PR operation resumes assignment after creation without another effect", () => {
    const f = ready();
    reachShipReady(f);
    const input = `sha256:${"c".repeat(64)}`;
    let exists = false;
    let assigned = false;
    let creates = 0;
    let edits = 0;
    const readBack = () => (exists && assigned ? input : null);
    expect(() =>
      f.runner.effect("toy-run", "pr-open", "toy/pr", input, readBack, () => {
        exists = true;
        creates += 1;
        throw new Error("assignment unavailable");
      }),
    ).toThrow("assignment unavailable");
    expect(f.runner.status("toy-run").run_state).toBe("ready-to-ship");
    const resume = () => {
      if (!exists) creates += 1;
      exists = true;
      if (!assigned) edits += 1;
      assigned = true;
    };
    const reopened = new Runner(f.privateDir, f.worker, root);
    expect(reopened.effect("toy-run", "pr-open", "toy/pr", input, readBack, resume).confirmed).toBe(true);
    reopened.effect("toy-run", "pr-open", "toy/pr", input, readBack, resume);
    expect(creates).toBe(1);
    expect(edits).toBe(1);
    expect(reopened.status("toy-run").run_state).toBe("pr-open");
    expect(Object.keys(reopened.status("toy-run").effects)).toHaveLength(1);
  });

  test("fix cycles cannot exceed the charter cap", () => {
    const f = ready();
    expect(f.runner.charge("toy-run", "fix_cycles", 1, "finding-a").status).toBe("complete");
    expect(f.runner.charge("toy-run", "fix_cycles", 1, "finding-a").status).toBe("complete");
    expect(f.runner.charge("toy-run", "fix_cycles", 1, "finding-a").status).toBe("cap-reached");
    transcript.push("Refusal: third fix cycle on one finding → `cap-reached` with two cycles recorded.");
  });

  test("resume cannot decrease consumed repair or usage counters", () => {
    const f = ready();
    expect(f.runner.charge("toy-run", "fix_cycles", 1, "finding-a").status).toBe("complete");
    expect(f.runner.charge("toy-run", "fix_cycles", 1, "finding-a").status).toBe("complete");
    expect(f.runner.charge("toy-run", "alignment_questions", 1).status).toBe("complete");
    expect(f.runner.status("toy-run").budget_consumption["fix_cycles:finding-a"]).toBe(2);
    expect(f.runner.status("toy-run").budget_consumption["alignment_questions"]).toBe(1);
    const restarted = new Runner(f.privateDir, f.worker, root);
    // Mutation `run.budget_consumption = {}` in load() zeros both the repair
    // key and the usage key and fails the two assertions that follow.
    expect(restarted.status("toy-run").budget_consumption["fix_cycles:finding-a"]).toBe(2);
    expect(restarted.status("toy-run").budget_consumption["alignment_questions"]).toBe(1);
    expect(restarted.charge("toy-run", "fix_cycles", 1, "finding-a").status).toBe("cap-reached");
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

  test("a design report collected as verify evidence cannot authorize ship", () => {
    const f = ready();
    for (const [id, operation, covers] of [
      ["align", "align.run", "align-answer"],
      ["bound", "bound.run", "spec-approval"],
      ["build", "build.dispatch", "build-go"],
    ] as const) {
      card(f, id, operation, covers);
      expect(f.runner.decide("toy-run", id).status).toBe("complete");
    }
    const report = join(f.privateDir, "design-report.json");
    writeFileSync(report, JSON.stringify({ schema: "review", schema_version: 1, id: "design-report-1" }));
    f.runner.collect("toy-run", "verify", report, f.revision, "verify");
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
    expect(f.runner.decide("toy-run", "ship")).toMatchObject({
      status: "needs-input",
      escalation: { charter_rule: "runner:design-report" },
    });
  });

  test("a runtime verifier receipt collected as verify evidence can authorize ship", () => {
    const f = ready();
    for (const [id, operation, covers] of [
      ["align", "align.run", "align-answer"],
      ["bound", "bound.run", "spec-approval"],
      ["build", "build.dispatch", "build-go"],
    ] as const) {
      card(f, id, operation, covers);
      expect(f.runner.decide("toy-run", id).status).toBe("complete");
    }
    const verification = join(f.privateDir, "verification.json");
    writeFileSync(
      verification,
      JSON.stringify({
        schema: "verification",
        schema_version: 1,
        id: "verification-runtime-1",
        status: "passed",
        kind: "command",
        exit_status: 0,
        command: { argv: ["bun", "test"] },
        output_digest: `sha256:${"d".repeat(64)}`,
      }),
    );
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
    expect(() => observed.complete("toy-run")).toThrow("a read-back-confirmed open pull request is required");
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
    expect(() => observed.complete("toy-run")).toThrow("a read-back-confirmed open pull request is required");
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

  // complete() refuses with one message for every currency condition, so each row starts from a run
  // complete() accepts (the "none" row) and makes exactly one of them stale in the persisted run.
  const OLD = "0".repeat(40);
  const staleRows: [string, (run: Run) => void][] = [
    ["none", () => undefined],
    [
      "the run state",
      (run) => {
        run.run_state = "repairing";
      },
    ],
    [
      "the ship approval",
      (run) => {
        for (const decision of run.decisions) if (decision.card.operation === "ship.prepare") decision.revision = OLD;
      },
    ],
    [
      "the verification",
      (run) => {
        for (const evidence of Object.values(run.evidence)) if (evidence.kind === "verify") evidence.revision = OLD;
      },
    ],
    [
      "the pull request effect",
      (run) => {
        for (const effect of Object.values(run.effects)) effect.revision = OLD;
      },
    ],
  ];
  for (const [stale, edit] of staleRows) {
    test(`complete() ${stale === "none" ? "accepts a run with every condition current" : `refuses when only ${stale} is stale`}`, () => {
      const f = ready();
      reachShipReady(f);
      let remote: string | null = null;
      const input = `sha256:${"c".repeat(64)}`;
      f.runner.effect(
        "toy-run",
        "pr-open",
        "toy/pr",
        input,
        () => remote,
        () => {
          remote = input;
        },
      );
      // The persisted run, read through the runner's own typed loader, with one condition made stale.
      const run = f.runner.status("toy-run");
      edit(run);
      writeFileSync(join(f.privateDir, "toy-run.json"), JSON.stringify(run));
      const fresh = new Runner(f.privateDir, f.worker, root);
      if (stale === "none") expect(fresh.complete("toy-run").run_state).toBe("complete");
      else expect(() => fresh.complete("toy-run")).toThrow("a read-back-confirmed open pull request is required");
    });
  }

  test("worker-written gate evidence is rejected", () => {
    const f = ready();
    const forged = join(f.worker, "green.txt");
    writeFileSync(forged, "green");
    expect(() => f.runner.collect("toy-run", "forged", forged, f.revision, "verify")).toThrow(
      "worker-written evidence is not trusted",
    );
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
          command: [process.execPath, seatScript, seat],
        })),
      }),
    );
    const adminToken = "a".repeat(48);
    const workerToken = "b".repeat(48);
    const adminTokenFile = join(f.privateDir, "admin.token");
    writeFileSync(adminTokenFile, adminToken, { mode: 0o600 });
    const server = spawnLive(
      [
        process.execPath,
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
      const status = Bun.spawnSync(["git", "-C", f.worker, "status", "--porcelain"]);
      expect(status.exitCode).toBe(0);
      expect(status.stdout.toString()).toBe("");
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
              process.execPath,
              "-e",
              "await Bun.stdin.text(); console.log(JSON.stringify({choice:'yes',rationale:'ok'}));",
            ],
          },
          {
            seat: "seat-b",
            actor: "supervisor-2",
            lineage: ["supervisor-2"],
            command: [
              process.execPath,
              "-e",
              "require('node:fs').appendFileSync(process.argv[1], 'crash\\n'); console.error('seat crashed'); process.exit(7);",
              crashes,
            ],
          },
        ],
      }),
    );
    const server = spawnLive(
      [
        process.execPath,
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

  test("a state dir named ..foo under the worker is rejected", () => {
    const f = fixture();
    expect(() => new Runner(join(f.worker, "..foo"), f.worker, root)).toThrow("runner state is worker-writable");
  });

  test("readAdminToken refuses a ..foo path under the worker root", () => {
    const f = fixture();
    const sneak = join(f.worker, "..foo");
    mkdirSync(sneak);
    const tokenFile = join(sneak, "admin.token");
    writeFileSync(tokenFile, "a".repeat(48), { mode: 0o600 });
    chmodSync(tokenFile, 0o600);
    expect(() => readAdminToken(tokenFile, f.worker)).toThrow(
      "runner admin token file must live outside the Firstmate home, the worker root and any git checkout",
    );
  });

  test("PATH with a worker dir named ..foo still selects git outside the worker", () => {
    const f = fixture();
    const workerGitDir = join(f.worker, "..foo");
    mkdirSync(workerGitDir);
    const fake = join(workerGitDir, "git");
    writeFileSync(fake, "#!/bin/sh\nexit 1\n");
    chmodSync(fake, 0o700);
    const previous = process.env["PATH"];
    process.env["PATH"] = `${workerGitDir}:${previous ?? ""}`;
    try {
      const resolved = resolveRunnerGit(f.worker);
      expect(resolved.binary).not.toBe(realpathSync(fake));
      expect(workerControlledPath(resolved.binary, f.worker)).toBe(false);
    } finally {
      if (previous === undefined) delete process.env["PATH"];
      else process.env["PATH"] = previous;
    }
  });

  test("a symlink cannot redirect the runner evidence backend into worker scope", () => {
    const dir = mkdtempSync(join(scratchRoot, "ak-runner-link-"));
    const worker = join(dir, "worker");
    const state = join(dir, "private");
    mkdirSync(worker);
    mkdirSync(state);
    symlinkSync(worker, join(state, "evidence"));
    expect(() => new Runner(state, worker, root)).toThrow("evidence store escapes");
  });
});

describe("unknown runner selectors", () => {
  test("the installed command exposes the runner service entrypoint", () => {
    const command = Bun.spawnSync([process.execPath, "src/maintenance/cli.ts", "runner"], { cwd: root });
    expect(command.exitCode).toBe(2);
    expect(command.stderr.toString()).toContain("ak runner serve");
  });
  test("a checkpoint card the run lacks is refused with the cards it has", () => {
    const f = ready();
    card(f, "align-1");
    expect(() => f.runner.packet("toy-run", "algin-1")).toThrow(
      "unknown checkpoint card 'algin-1'; did you mean align-1?",
    );
    expect(() => f.runner.decide("toy-run", "nothing-like-it")).toThrow(
      "unknown checkpoint card 'nothing-like-it'; valid: align-1",
    );
  });

  test("ak runner refuses an unknown subcommand and, before connecting, an unknown verb", async () => {
    const err: string[] = [];
    const io = { out: () => {}, err: (line: string) => err.push(line) };
    expect(await runRunner(["cal"], io)).toBe(2);
    expect(err[0]).toBe("ak runner: unknown subcommand 'cal'; did you mean call?");

    err.length = 0;
    const previous = process.env["AK_RUNNER_TOKEN"];
    process.env["AK_RUNNER_TOKEN"] = "t".repeat(32);
    try {
      const socket = join(mkdtempSync(join(scratchRoot, "ak-runner-verb-")), "absent.sock");
      expect(await runRunner(["call", "stauts", "--socket", socket], io)).toBe(2);
    } finally {
      if (previous === undefined) delete process.env["AK_RUNNER_TOKEN"];
      else process.env["AK_RUNNER_TOKEN"] = previous;
    }
    expect(err).toEqual(["ak runner: unknown verb 'stauts'; did you mean status or start?"]);
  });
});

// ADR-0015: the blind veto is an opt-in, refusal-only side record on an approving pair.
function councilFixture() {
  const f = fixture();
  const charter: typeof f.charter & { council?: { blind_veto: "required" } } = f.charter;
  charter.council = { blind_veto: "required" };
  charter.immutability.hash = artifactHash({ ...charter, immutability: { ...charter.immutability, hash: "" } });
  const approval = charter.approvals[0];
  if (approval === undefined) throw new Error("toy charter approval missing");
  approval.artifact_hash = charter.immutability.hash;
  writeFileSync(f.path, JSON.stringify(charter));
  return f;
}

function councilReady() {
  const f = councilFixture();
  f.runner.start("toy-run", f.path, "implementer-1", f.revision, standing(f));
  const log = join(f.privateDir, "log.txt");
  writeFileSync(log, "independently collected verification");
  f.runner.collect("toy-run", "e1", log, f.revision, "source");
  return f;
}

const answered = (choice: string, actor = "veto-1", lineage = [actor]) => ({
  status: "answered" as const,
  seat: "veto",
  actor,
  lineage,
  dispatch: "card-1-veto",
  choice,
  rationale: "Blind judgment of the same packet",
});

describe("council blind veto", () => {
  test("without the charter block nothing changes and no veto can be recorded", () => {
    const f = ready();
    card(f);
    expect(f.runner.vetoDue("toy-run", "card-1")).toBe(false);
    expect(() => f.runner.veto("toy-run", "card-1", answered("yes"))).toThrow("does not seat a blind veto");
    expect(f.runner.decide("toy-run", "card-1").next_permitted_action).toBe("bound.run");
  });

  test("an approving pair without a recorded veto escalates once", () => {
    const f = councilReady();
    card(f);
    expect(f.runner.vetoDue("toy-run", "card-1")).toBe(true);
    const result = f.runner.decide("toy-run", "card-1");
    expect(result).toMatchObject({ status: "needs-input", escalation: { charter_rule: "runner:council-veto" } });
    expect(stage(f)).toEqual(["needs-input", null]);
  });

  test("an approving veto lets the pair's approval stand and the decision keeps two judgments", () => {
    const f = councilReady();
    card(f);
    f.runner.veto("toy-run", "card-1", answered("yes"));
    expect(f.runner.vetoDue("toy-run", "card-1")).toBe(false);
    expect(f.runner.decide("toy-run", "card-1").next_permitted_action).toBe("bound.run");
    const decision = parseJson(readFileSync(join(f.privateDir, "toy-run-card-1.decision.json"), "utf8"));
    expect(decision).toMatchObject({ status: "ruled" });
    expect(decision).toHaveProperty("judgments.length", 2);
  });

  test("re-sending a prepared card after a veto returns the card with its veto", () => {
    const f = councilReady();
    const input = {
      id: "card-1",
      operation: "align.run",
      grant: { charter_hash: f.charter.immutability.hash, covers: "align-answer" },
      question: "Proceed?",
      options: ["yes", "no"],
      approve: "yes",
      evidence: ["e1"],
      artifact_hash: `sha256:${"b".repeat(64)}`,
    };
    card(f);
    f.runner.veto("toy-run", "card-1", answered("no"));
    expect(f.runner.prepare("toy-run", input).veto).toMatchObject({ choice: "no" });
    expect(() => f.runner.prepare("toy-run", { ...input, question: "Changed?" })).toThrow("checkpoint card changed");
  });

  test("a veto supplied through prepare is not recorded", () => {
    const f = councilReady();
    const forged: Parameters<typeof f.runner.prepare>[1] & { veto: unknown } = {
      id: "card-1",
      operation: "align.run",
      grant: { charter_hash: f.charter.immutability.hash, covers: "align-answer" },
      question: "Proceed?",
      options: ["yes", "no"],
      approve: "yes",
      evidence: ["e1"],
      artifact_hash: `sha256:${"b".repeat(64)}`,
      veto: answered("yes"),
    };
    expect(f.runner.prepare("toy-run", forged).veto).toBeUndefined();
    expect(f.runner.status("toy-run").cards["card-1"]?.veto).toBeUndefined();
  });

  test("a non-approving veto refuses and never decides in its own favour", () => {
    const f = councilReady();
    card(f);
    f.runner.veto("toy-run", "card-1", answered("no"));
    const result = f.runner.decide("toy-run", "card-1");
    expect(result.escalation?.charter_rule).toBe("runner:council-veto");
    expect(result.escalation?.need).toContain("did not approve");
    expect(stage(f)).toEqual(["needs-input", null]);
  });

  test("an unavailable veto chain refuses with its failures", () => {
    const f = councilReady();
    card(f);
    f.runner.veto("toy-run", "card-1", { status: "unavailable", seat: "veto", failures: ["seat veto x: exited 1"] });
    const need = f.runner.decide("toy-run", "card-1").escalation?.need;
    expect(need).toContain("unavailable");
    expect(need).not.toContain("exited 1");
    expect(need).not.toContain("seat veto");
    expect(f.runner.status("toy-run").cards["card-1"]?.veto).toMatchObject({ failures: ["seat veto x: exited 1"] });
  });

  test("a veto that shares a lineage with the pair, or is excluded, is refused at submission", () => {
    const f = councilReady();
    card(f);
    expect(() => f.runner.veto("toy-run", "card-1", answered("yes", "supervisor-1"))).toThrow("not independent");
    expect(() => f.runner.veto("toy-run", "card-1", answered("yes", "veto-1", ["veto-1", "supervisor-2"]))).toThrow(
      "not independent",
    );
    expect(() => f.runner.veto("toy-run", "card-1", answered("yes", "implementer-1"))).toThrow("excluded");
    expect(() => f.runner.veto("toy-run", "card-1", { ...answered("yes"), seat: "seat-a" })).toThrow(
      "must not be a supervisor seat",
    );
    expect(() => f.runner.veto("toy-run", "card-1", answered("maybe"))).toThrow("invalid");
    f.runner.veto("toy-run", "card-1", answered("yes"));
    expect(() => f.runner.veto("toy-run", "card-1", answered("no"))).toThrow("changed after first submission");
  });

  test("a judgment recorded after the veto may not share its lineage", () => {
    const f = councilReady();
    f.runner.prepare("toy-run", {
      id: "card-1",
      operation: "align.run",
      grant: { charter_hash: f.charter.immutability.hash, covers: "align-answer" },
      question: "Proceed?",
      options: ["yes", "no"],
      approve: "yes",
      evidence: ["e1"],
      artifact_hash: `sha256:${"b".repeat(64)}`,
    });
    f.runner.veto("toy-run", "card-1", answered("yes"));
    expect(() => f.runner.judge("toy-run", "card-1", "seat-a", "veto-1", "card-1-a", "yes", [])).toThrow(
      "blind veto seat",
    );
    expect(() =>
      f.runner.judge("toy-run", "card-1", "seat-a", "supervisor-1", "card-1-a", "yes", [], ["supervisor-1", "veto-1"]),
    ).toThrow("blind veto seat");
  });

  test("a pair agreeing not to approve needs no veto", () => {
    const f = councilReady();
    f.runner.prepare("toy-run", {
      id: "nay",
      operation: "align.run",
      grant: { charter_hash: f.charter.immutability.hash, covers: "align-answer" },
      question: "Proceed?",
      options: ["yes", "no"],
      approve: "yes",
      evidence: ["e1"],
      artifact_hash: `sha256:${"b".repeat(64)}`,
    });
    f.runner.judge("toy-run", "nay", "seat-a", "supervisor-1", "nay-a", "no", []);
    f.runner.judge("toy-run", "nay", "seat-b", "supervisor-2", "nay-b", "no", []);
    expect(f.runner.vetoDue("toy-run", "nay")).toBe(false);
    expect(f.runner.decide("toy-run", "nay")).toMatchObject({ status: "complete", next_permitted_action: "align.run" });
  });

  test("serve dispatches the veto chain blind, moving to a substitute only on failure", async () => {
    const f = councilFixture();
    const socket = join(f.privateDir, "runner.sock");
    const seatConfig = join(f.privateDir, "seats.json");
    const councilConfig = join(f.privateDir, "council.json");
    const vetoLog = join(f.privateDir, "veto.log");
    const answer = (choice: string) =>
      `const p=JSON.parse(await Bun.stdin.text());require('node:fs').appendFileSync(${JSON.stringify(vetoLog)},Object.keys(p).sort().join(',')+'\\n');console.log(JSON.stringify({choice:${JSON.stringify(choice)},rationale:'blind',model_served:'served-label'}));`;
    writeFileSync(
      seatConfig,
      JSON.stringify({
        launchers: ["seat-a", "seat-b"].map((seat) => ({
          seat,
          actor: `supervisor-${seat}`,
          lineage: [`supervisor-${seat}`],
          command: [
            process.execPath,
            "-e",
            "const p=JSON.parse(await Bun.stdin.text());console.log(JSON.stringify({choice:p.card.approve,rationale:'agree'}));",
          ],
        })),
      }),
    );
    writeFileSync(
      councilConfig,
      JSON.stringify({
        veto: {
          seat: "veto",
          chain: [
            {
              actor: "veto-1",
              lineage: ["veto-1"],
              command: [process.execPath, "-e", "process.exit(3)"],
              requested: "first-label",
            },
            {
              actor: "veto-2",
              lineage: ["veto-2"],
              command: [process.execPath, "-e", answer("yes")],
              requested: "second-label",
            },
            { actor: "veto-3", lineage: ["veto-3"], command: [process.execPath, "-e", answer("no")] },
          ],
        },
      }),
      { mode: 0o600 },
    );
    const adminToken = "a".repeat(48);
    const workerToken = "b".repeat(48);
    const adminTokenFile = join(f.privateDir, "admin.token");
    writeFileSync(adminTokenFile, adminToken, { mode: 0o600 });
    const server = spawnLive(
      [
        process.execPath,
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
        "--council-config",
        councilConfig,
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
      expect(
        call("start", adminToken, {
          run: "toy-run",
          charter: f.path,
          implementer: "implementer-1",
          revision: f.revision,
          standing_grant: standing(f),
        }).exitCode,
      ).toBe(0);
      const receipt = join(f.privateDir, "receipt.txt");
      writeFileSync(receipt, "independent receipt");
      expect(
        call("collect", adminToken, { run: "toy-run", id: "e1", source: receipt, revision: f.revision, kind: "source" })
          .exitCode,
      ).toBe(0);
      expect(
        call("prepare", workerToken, {
          run: "toy-run",
          card: {
            id: "card-1",
            operation: "align.run",
            grant: { charter_hash: f.charter.immutability.hash, covers: "align-answer" },
            question: "Proceed?",
            options: ["yes", "no"],
            approve: "yes",
            evidence: ["e1"],
            artifact_hash: `sha256:${"b".repeat(64)}`,
          },
        }).exitCode,
      ).toBe(0);
      const decided = call("decide", workerToken, { run: "toy-run", card_id: "card-1" });
      expect(JSON.parse(decided.stdout.toString())).toMatchObject({
        status: "complete",
        next_permitted_action: "bound.run",
      });
      expect(f.runner.status("toy-run").cards["card-1"]?.veto).toMatchObject({
        status: "answered",
        actor: "veto-2",
        choice: "yes",
        model_requested: "second-label",
        model_served: "served-label",
      });
      expect(readFileSync(vetoLog, "utf8").trim().split("\n")).toEqual(["card,charter_hash,diff_hash,revision,run"]);
      const firstCard = {
        id: "card-1",
        operation: "align.run",
        grant: { charter_hash: f.charter.immutability.hash, covers: "align-answer" },
        question: "Proceed?",
        options: ["yes", "no"],
        approve: "yes",
        evidence: ["e1"],
        artifact_hash: `sha256:${"b".repeat(64)}`,
      };
      const retried = call("prepare", workerToken, { run: "toy-run", card: firstCard }).stdout.toString();
      expect(JSON.parse(retried)).toMatchObject({ id: "card-1", veto: { status: "answered", choice: "yes" } });
      const workerStatus = call("status", workerToken, { run: "toy-run" }).stdout.toString();
      expect(JSON.stringify(parseJson(workerStatus))).toContain('"veto":{"status":"answered","choice":"yes"}');
      for (const text of [retried, workerStatus])
        for (const hidden of ["veto-2", "second-label", "served-label", 'blind"']) expect(text).not.toContain(hidden);
      expect(parseJson(call("status", adminToken, { run: "toy-run" }).stdout.toString())).toMatchObject({
        cards: {
          "card-1": { veto: { actor: "veto-2", model_requested: "second-label", model_served: "served-label" } },
        },
      });
      expect(
        call("prepare", workerToken, {
          run: "toy-run",
          card: {
            id: "card-2",
            operation: "bound.run",
            grant: { charter_hash: f.charter.immutability.hash, covers: "spec-approval" },
            question: `Proceed with:\n${["gh", "p_", "a1".repeat(18)].join("")}?`,
            options: ["yes", "no"],
            approve: "yes",
            evidence: ["e1"],
            artifact_hash: `sha256:${"c".repeat(64)}`,
          },
        }).exitCode,
      ).toBe(0);
      const refused = call("decide", workerToken, { run: "toy-run", card_id: "card-2" });
      expect(JSON.parse(refused.stdout.toString())).toMatchObject({
        status: "needs-input",
        escalation: { charter_rule: "runner:council-veto" },
      });
      expect(refused.stdout.toString()).not.toContain("outbound secret");
      const refusedWorker = call("status", workerToken, { run: "toy-run" }).stdout.toString();
      expect(JSON.stringify(parseJson(refusedWorker))).toContain('"veto":{"status":"unavailable"}');
      expect(refusedWorker).not.toContain("outbound secret");
      expect(JSON.stringify(f.runner.status("toy-run").cards["card-2"]?.veto)).toContain("outbound secret");
      expect(readFileSync(vetoLog, "utf8").trim().split("\n")).toHaveLength(1);
    } finally {
      server.kill();
      await server.exited;
    }
  }, 300_000);

  test("worker status keeps a card or evidence whose id is veto, and hides only a card's veto record", async () => {
    const f = councilFixture();
    const socket = join(f.privateDir, "runner.sock");
    const adminToken = "a".repeat(48);
    const workerToken = "b".repeat(48);
    const adminTokenFile = join(f.privateDir, "admin.token");
    writeFileSync(adminTokenFile, adminToken, { mode: 0o600 });
    const server = spawnLive(
      [
        process.execPath,
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
      { cwd: root, env: { ...process.env, AK_RUNNER_WORKER_TOKEN: workerToken }, stdout: "pipe", stderr: "pipe" },
    );
    try {
      await waitForPath(socket, server);
      const request = join(f.privateDir, "request.json");
      const call = (verb: string, token: string, args: RunnerArgs) => {
        writeFileSync(request, JSON.stringify(args));
        return callRunnerCli(verb, request, socket, token, CONTENDED_RUNNER_CALL_TIMEOUT_MS);
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
      const receipt = join(f.privateDir, "receipt.txt");
      writeFileSync(receipt, "independent receipt");
      expect(
        call("collect", adminToken, {
          run: "toy-run",
          id: "veto",
          source: receipt,
          revision: f.revision,
          kind: "source",
        }).exitCode,
      ).toBe(0);
      for (const id of ["veto", "judgments"])
        expect(
          call("prepare", workerToken, {
            run: "toy-run",
            card: {
              id,
              operation: "align.run",
              grant: { charter_hash: f.charter.immutability.hash, covers: "align-answer" },
              question: `Proceed with ${id}?`,
              options: ["yes", "no"],
              approve: "yes",
              evidence: ["veto"],
              artifact_hash: `sha256:${"b".repeat(64)}`,
            },
          }).exitCode,
        ).toBe(0);
      expect(parseJson(call("status", workerToken, { run: "toy-run" }).stdout.toString())).toMatchObject({
        cards: {
          veto: { id: "veto", question: "Proceed with veto?", judgments: [] },
          judgments: { id: "judgments", question: "Proceed with judgments?", judgments: [] },
        },
        evidence: { veto: { id: "veto", kind: "source" } },
      });
    } finally {
      server.kill();
      await server.exited;
    }
  }, 300_000);

  test("serve refuses a council configuration others can read", () => {
    const f = councilFixture();
    const councilConfig = join(f.privateDir, "council.json");
    writeFileSync(
      councilConfig,
      JSON.stringify({ veto: { seat: "veto", chain: [{ actor: "v", lineage: ["v"], command: ["true"] }] } }),
      { mode: 0o644 },
    );
    chmodSync(councilConfig, 0o644);
    const adminTokenFile = join(f.privateDir, "admin.token");
    writeFileSync(adminTokenFile, "a".repeat(48), { mode: 0o600 });
    const server = Bun.spawnSync(
      [
        process.execPath,
        join(root, "src", "cli.ts"),
        "runner",
        "serve",
        "--socket",
        join(f.privateDir, "runner.sock"),
        "--state-dir",
        f.privateDir,
        "--worker-root",
        f.worker,
        "--run-id",
        "toy-run",
        "--admin-token-file",
        adminTokenFile,
        "--council-config",
        councilConfig,
      ],
      { cwd: root, env: { ...process.env, AK_RUNNER_WORKER_TOKEN: "b".repeat(48) }, stdout: "pipe", stderr: "pipe" },
    );
    expect(server.exitCode).not.toBe(0);
    expect(server.stderr.toString()).toContain("owner only");
  });
});
