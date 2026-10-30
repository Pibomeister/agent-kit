import { timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, readFileSync, realpathSync, unlinkSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import { unknownSelector } from "../util/suggest.ts";
import { sha256Hex } from "../util/hash.ts";
import { Runner } from "./core.ts";
import { sharesLineage } from "./lineage.ts";
import { DEFAULT_TIMEOUT_MS, readCouncilConfig, rosterProblems, type CouncilConfig } from "../council/config.ts";
import { checkOutbound, describeRefusals, outboundLimits } from "../council/outbound.ts";
import { chainFailures, launchSeat, UNSPECIFIED, UNVERIFIED } from "../council/seat.ts";
import { workerControlledPath, workerFreePath } from "./path.ts";
import { readAdminToken } from "./token.ts";
import {
  isArgs,
  isEffectConfig,
  isEventConfig,
  isEventAck,
  isAuditProbeReply,
  isAuditReplacementReply,
  isRequest,
  isResponse,
  isSeatAnswer,
  isSeatConfig,
  isVerifyConfig,
  type Request,
  type EffectAdapter,
  type RunnerArgs,
  type SeatLauncher,
} from "./wire.ts";

type Io = { out: (line: string) => void; err: (line: string) => void };
type KillableChild = { kill(signal?: number | NodeJS.Signals): void };
const ADMIN = new Set([
  "start",
  "collect",
  "revision",
  "judge",
  "answer",
  "verify",
  "event",
  "effect",
  "complete",
  "cancel",
  "charge",
  "delegate",
  "progress",
  "finish",
  "verdict",
]);
const WORKER = new Set(["status", "ledger", "packet", "prepare", "decide", "sync", "run-verify"]);
type StringKey =
  | "run"
  | "charter"
  | "implementer"
  | "revision"
  | "id"
  | "source"
  | "kind"
  | "card_id"
  | "seat"
  | "actor"
  | "dispatch"
  | "choice"
  | "rationale"
  | "evidence"
  | "key"
  | "payload"
  | "effect"
  | "target"
  | "input_hash"
  | "limit"
  | "parent";
type ArrayKey = "excluded_actors" | "input_dispatches" | "lineage";

function equal(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function str(args: RunnerArgs, name: StringKey): string {
  const value = args[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} must be a nonempty string`);
  return value;
}

function strings(args: RunnerArgs, name: ArrayKey): string[] {
  const value = args[name];
  if (value === undefined) throw new Error(`${name} must be a string array`);
  return value;
}

function effectCommand(template: string[], target: string, inputHash: string): string[] {
  return template.map((part) => part.replaceAll("{target}", target).replaceAll("{input_hash}", inputHash));
}

function runCommand(argv: string[], runner: Runner): string {
  const result = Bun.spawnSync(argv, {
    cwd: runner.stateDir,
    env: privateChildEnv(runner),
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) throw new Error(`trusted adapter command failed: ${result.stderr.toString().trim()}`);
  return result.stdout.toString().trim();
}

function childEnv() {
  const env = { ...process.env };
  delete env["AK_RUNNER_ADMIN_TOKEN"];
  delete env["AK_RUNNER_WORKER_TOKEN"];
  delete env["AK_RUNNER_TOKEN"];
  delete env["AK_RUNNER_SOCKET"];
  return env;
}

function privateChildEnv(runner: Runner) {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(childEnv())) {
    if (
      !/^(BUN_|NODE_OPTIONS$|NODE_PATH$|NPM_CONFIG_|NPM_LIFECYCLE_|YARN_|PNPM_|COREPACK_|GIT_CONFIG_|PYTHONPATH$|PYTHONHOME$|RUBYOPT$|RUBYLIB$|PERL5LIB$|PERL5OPT$|INIT_CWD$|PWD$|OLDPWD$)/i.test(
        key,
      )
    )
      env[key] = value;
  }
  for (const key of ["HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "TMPDIR", "TMP", "TEMP"]) {
    const value = env[key];
    if (value !== undefined && workerControlledPath(value, runner.workerRoot)) env[key] = runner.stateDir;
  }
  env["PATH"] = workerFreePath(env["PATH"], runner.workerRoot);
  return env;
}

async function spawnPiped(
  argv: string[],
  cwd: string,
  stdin?: string,
  env = childEnv(),
  activeChildren?: Set<KillableChild>,
  timeoutMs?: number,
) {
  const child = Bun.spawn(argv, {
    cwd,
    env,
    stdin: stdin === undefined ? "ignore" : Buffer.from(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  activeChildren?.add(child);
  let timedOut = false;
  const timer =
    timeoutMs === undefined
      ? null
      : setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, timeoutMs);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).arrayBuffer(),
      new Response(child.stderr).arrayBuffer(),
      child.exited,
    ]);
    if (timedOut) throw new Error(`adapter command timed out after ${timeoutMs}ms`);
    return { exitCode, stdout: Buffer.from(stdout), stderr: Buffer.from(stderr) };
  } finally {
    if (timer !== null) clearTimeout(timer);
    activeChildren?.delete(child);
  }
}

async function dispatchSeat(
  runner: Runner,
  runId: string,
  cardId: string,
  launcher: SeatLauncher,
  activeChildren: Set<KillableChild>,
): Promise<void> {
  const card = runner.status(runId).cards[cardId];
  if (card === undefined || card.judgments.some((judgment) => judgment.seat === launcher.seat)) return;
  const packet = runner.packet(runId, cardId);
  const child = await spawnPiped(
    launcher.command,
    runner.stateDir,
    JSON.stringify(packet),
    privateChildEnv(runner),
    activeChildren,
  );
  if (child.exitCode !== 0) throw new Error(`launcher exited ${child.exitCode}: ${child.stderr.toString().trim()}`);
  const answerValue: unknown = JSON.parse(child.stdout.toString());
  if (!isSeatAnswer(answerValue)) throw new Error("launcher returned an invalid judgment");
  runner.judge(
    runId,
    cardId,
    launcher.seat,
    launcher.actor,
    `${cardId}-${launcher.seat}`,
    answerValue.choice,
    [],
    launcher.lineage,
    answerValue.rationale,
  );
}

// ADR-0015: after an approving pair and before decide accepts it, the blind veto judges the same packet.
async function dispatchVeto(
  runner: Runner,
  runId: string,
  cardId: string,
  council: CouncilConfig | null,
  activeChildren: Set<KillableChild>,
): Promise<void> {
  if (council === null) {
    runner.veto(runId, cardId, { status: "unavailable", seat: "veto", failures: ["no council configuration"] });
    return;
  }
  const packet = JSON.stringify(runner.packet(runId, cardId));
  const refusals = checkOutbound([{ label: "packet", text: packet }], outboundLimits(council));
  if (refusals.length > 0) {
    runner.veto(runId, cardId, {
      status: "unavailable",
      seat: council.veto.seat,
      failures: describeRefusals(refusals),
    });
    return;
  }
  const options = runner.status(runId).cards[cardId]?.options ?? [];
  const result = await launchSeat(council.veto, packet, options, (argv, stdin) =>
    spawnPiped(
      argv,
      runner.stateDir,
      stdin,
      privateChildEnv(runner),
      activeChildren,
      council.limits?.timeout_ms ?? DEFAULT_TIMEOUT_MS,
    ),
  );
  if (!result.ok) {
    runner.veto(runId, cardId, {
      status: "unavailable",
      seat: council.veto.seat,
      failures: chainFailures(council.veto.seat, result.attempts),
    });
    return;
  }
  runner.veto(runId, cardId, {
    status: "answered",
    seat: council.veto.seat,
    actor: result.launcher.actor,
    lineage: result.launcher.lineage,
    dispatch: `${cardId}-${council.veto.seat}`,
    choice: result.answer.choice,
    rationale: result.answer.rationale,
    model_requested: result.launcher.model ?? UNSPECIFIED,
    model_served: result.answer.model_served ?? UNVERIFIED,
  });
}

async function decideCard(
  runner: Runner,
  runId: string,
  cardId: string,
  launchers: SeatLauncher[],
  council: CouncilConfig | null,
  activeChildren: Set<KillableChild>,
) {
  const early = runner.authorize(runId, cardId);
  if (early !== null) return early;
  const failures: string[] = [];
  for (const launcher of launchers) {
    try {
      await dispatchSeat(runner, runId, cardId, launcher, activeChildren);
    } catch (cause) {
      failures.push(`seat ${launcher.seat}: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }
  if (failures.length === 0 && runner.vetoDue(runId, cardId)) {
    try {
      await dispatchVeto(runner, runId, cardId, council, activeChildren);
    } catch {
      // A veto the runner could not record leaves the card without one, and decide refuses it.
    }
  }
  return runner.decide(runId, cardId, failures);
}

async function execute(
  runner: Runner,
  request: Request,
  adminToken: string,
  workerToken: string,
  allowedRun: string,
  launchers: SeatLauncher[],
  council: CouncilConfig | null,
  verifyCommand: string[] | null,
  effectAdapters: Map<string, EffectAdapter>,
  decisions: Map<string, Promise<unknown>>,
  activeChildren: Set<KillableChild>,
  autonomousAvailable: boolean,
) {
  const admin = equal(request.token, adminToken);
  if (!admin && !equal(request.token, workerToken)) throw new Error("unauthorized runner request");
  if (!WORKER.has(request.verb) && !(admin && ADMIN.has(request.verb)))
    throw new Error("runner verb unavailable to this token");
  const a = request.args;
  if (a.run !== allowedRun) throw new Error("run is outside this runner endpoint");
  switch (request.verb) {
    case "start":
      if (a.standing_grant === undefined)
        throw new Error("a runner-validated standing grant is required to start autopilot");
      return runner.start(
        str(a, "run"),
        str(a, "charter"),
        str(a, "implementer"),
        str(a, "revision"),
        a.standing_grant,
        a.excluded_actors ?? [],
      );
    case "collect":
      return runner.collect(str(a, "run"), str(a, "id"), str(a, "source"), str(a, "revision"), str(a, "kind"));
    case "revision":
      return runner.revision(str(a, "run"), str(a, "revision"));
    case "judge":
      return runner.judge(
        str(a, "run"),
        str(a, "card_id"),
        str(a, "seat"),
        str(a, "actor"),
        str(a, "dispatch"),
        str(a, "choice"),
        strings(a, "input_dispatches"),
        strings(a, "lineage"),
        str(a, "rationale"),
      );
    case "answer":
      return runner.answer(str(a, "run"), str(a, "card_id"), str(a, "choice"), str(a, "actor"), str(a, "rationale"));
    case "verify":
      return runner.verify(str(a, "run"), str(a, "evidence"));
    case "event":
      return runner.event(str(a, "run"), str(a, "key"), str(a, "payload"));
    case "delegate":
      if (a.amount === undefined) throw new Error("delegate needs expected runtime in seconds");
      return runner.registerDelegate(str(a, "run"), str(a, "id"), a.amount, a.parent);
    case "progress":
      runner.recordProgress(str(a, "run"), str(a, "id"), str(a, "kind"), str(a, "source"));
      return runner.status(str(a, "run")).delegates?.[str(a, "id")];
    case "finish":
      runner.finishDelegate(str(a, "run"), str(a, "id"));
      return runner.status(str(a, "run")).delegates?.[str(a, "id")];
    case "verdict":
      return runner.bindVerdict(str(a, "run"));
    case "charge": {
      if (a.amount === undefined) throw new Error("amount is required");
      return runner.charge(str(a, "run"), str(a, "limit"), a.amount, a.subject);
    }
    case "effect": {
      const effect = str(a, "effect");
      const target = str(a, "target");
      const inputHash = str(a, "input_hash");
      const adapter = effectAdapters.get(effect);
      if (adapter === undefined) throw new Error(`no supervisor-owned adapter for ${effect}`);
      return runner.effect(
        str(a, "run"),
        effect,
        target,
        inputHash,
        () => runCommand(effectCommand(adapter.read_back, target, inputHash), runner) || null,
        () => {
          runCommand(effectCommand(adapter.perform, target, inputHash), runner);
        },
      );
    }
    case "complete":
      return runner.complete(str(a, "run"));
    case "cancel":
      return runner.cancel(str(a, "run"), str(a, "actor"), str(a, "rationale"));
    case "status":
      return runner.status(str(a, "run"));
    case "sync":
      return runner.syncRevision(str(a, "run"));
    case "run-verify": {
      if (verifyCommand === null) throw new Error("runner verification command is unconfigured");
      const runId = str(a, "run");
      const before = runner.syncRevision(runId);
      if (before.next_permitted_action !== "verify.record")
        throw new Error("verification is not the next permitted action");
      const result = await spawnPiped(verifyCommand, runner.workerRoot, undefined, childEnv(), activeChildren);
      const after = runner.syncRevision(runId);
      if (before.revision !== after.revision || before.diff_hash !== after.diff_hash)
        throw new Error("verification changed the worker snapshot");
      if (result.exitCode !== 0)
        throw new Error(`verification failed (${result.exitCode}): ${result.stderr.toString().slice(0, 4000)}`);
      const evidenceId = `verify-${after.revision.slice(0, 8)}-${after.diff_hash.slice(7, 15)}`;
      runner.recordOutput(runId, evidenceId, Buffer.concat([result.stdout, result.stderr]), "verify");
      return runner.verify(runId, evidenceId);
    }
    case "ledger":
      return runner.ledger(str(a, "run"));
    case "packet":
      return runner.packet(str(a, "run"), str(a, "card_id"));
    case "prepare": {
      if (a.card === undefined) throw new Error("card is required");
      return runner.prepare(str(a, "run"), a.card);
    }
    case "decide": {
      const charter = runner.status(str(a, "run")).charter;
      if (
        charter.audit_cadence_seconds !== undefined &&
        (!autonomousAvailable || !charter.allowed_capabilities.includes("event-delivery"))
      )
        throw new Error("guided mode: event delivery or supervisor loop is unavailable; use explicit invocation");
      const cardId = str(a, "card_id");
      const pending =
        decisions.get(cardId) ??
        decideCard(runner, str(a, "run"), cardId, launchers, council, activeChildren).finally(() =>
          decisions.delete(cardId),
        );
      decisions.set(cardId, pending);
      return pending;
    }
    default:
      throw new Error("unknown runner verb");
  }
}

function flag(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  return index < 0 ? undefined : argv[index + 1];
}

async function serve(argv: readonly string[], io: Io): Promise<number> {
  const socket = flag(argv, "socket");
  const state = flag(argv, "state-dir");
  const worker = flag(argv, "worker-root");
  const runId = flag(argv, "run-id");
  const mode = flag(argv, "socket-mode") ?? "600";
  const seatConfigPath = flag(argv, "seat-config");
  const councilConfigPath = flag(argv, "council-config");
  const verifyConfigPath = flag(argv, "verify-config");
  const effectConfigPath = flag(argv, "effect-config");
  const eventConfigPath = flag(argv, "event-config");
  const loopConfigPath = flag(argv, "loop-config");
  const adminTokenFile = flag(argv, "admin-token-file");
  const kitRootFlag = flag(argv, "kit-root");
  const workerToken = process.env["AK_RUNNER_WORKER_TOKEN"] ?? "";
  if (!socket || !state || !worker || !runId || !adminTokenFile || workerToken.length < 32 || !/^(600|660)$/.test(mode))
    throw new Error(
      "serve needs --socket, --state-dir, --worker-root, --run-id, --admin-token-file, a 32+ character AK_RUNNER_WORKER_TOKEN, and socket mode 600 or 660",
    );
  const workerRoot = realpathSync(worker);
  const socketPath = resolve(socket);
  const relativeSocket = relative(workerRoot, socketPath);
  if (relativeSocket === "" || (!relativeSocket.startsWith("..") && !isAbsolute(relativeSocket)))
    throw new Error("runner socket is inside worker root");
  if (existsSync(socketPath)) {
    const live = await new Promise<boolean>((done, fail) => {
      const probe = createConnection(socketPath);
      probe.once("connect", () => {
        probe.end();
        done(true);
      });
      probe.once("error", (cause: NodeJS.ErrnoException) => {
        if (cause.code === "ECONNREFUSED" || cause.code === "ENOENT") done(false);
        else fail(cause);
      });
    });
    if (live) throw new Error("runner socket already has a live service");
    if (existsSync(socketPath)) unlinkSync(socketPath);
  }
  const socketParent = realpathSync(dirname(socketPath));
  const relativeParent = relative(workerRoot, socketParent);
  if (relativeParent === "" || (!relativeParent.startsWith("..") && !isAbsolute(relativeParent)))
    throw new Error("runner socket parent resolves inside worker root");
  const entry = process.argv[1];
  const kitRoot =
    kitRootFlag ??
    (entry === undefined ? resolve(import.meta.dir, "..", "..") : resolve(realpathSync(entry), "..", ".."));
  const runner = new Runner(state, workerRoot, kitRoot, true);
  runner.assertPrivatePath(socketPath);
  runner.assertPrivatePath(adminTokenFile);
  const adminToken = readAdminToken(adminTokenFile, workerRoot);
  if (adminToken === workerToken) throw new Error("admin and worker tokens must differ");
  let launchers: SeatLauncher[] = [];
  if (seatConfigPath !== undefined) {
    const configPath = realpathSync(seatConfigPath);
    runner.assertPrivatePath(configPath);
    const configValue: unknown = JSON.parse(readFileSync(configPath, "utf8"));
    if (!isSeatConfig(configValue))
      throw new Error(`invalid seat configuration: ${JSON.stringify(isSeatConfig.errors)}`);
    launchers = configValue.launchers;
    if (
      new Set(launchers.map((launcher) => launcher.seat)).size !== 2 ||
      new Set(launchers.map((launcher) => launcher.actor)).size !== 2
    )
      throw new Error("seat configuration must name two distinct seats and actors");
    if (launchers.some((launcher, i) => launchers.slice(i + 1).some((other) => sharesLineage(launcher, other))))
      throw new Error("seat configuration lineages must be independent");
  }
  let council: CouncilConfig | null = null;
  if (councilConfigPath !== undefined) {
    runner.assertPrivatePath(realpathSync(councilConfigPath));
    council = readCouncilConfig(councilConfigPath);
    if (council.pair !== undefined)
      throw new Error(
        "the runner's supervisor pair comes from --seat-config; a council configuration names the veto only",
      );
    const pairSeats = launchers.map((launcher) => ({ seat: launcher.seat, chain: [launcher] }));
    const problems = rosterProblems([...pairSeats, council.veto]);
    if (problems.length > 0) throw new Error(`invalid council configuration: ${problems.join("; ")}`);
  }
  let verifyCommand: string[] | null = null;
  if (verifyConfigPath !== undefined) {
    const configPath = realpathSync(verifyConfigPath);
    runner.assertPrivatePath(configPath);
    const configValue: unknown = JSON.parse(readFileSync(configPath, "utf8"));
    if (!isVerifyConfig(configValue))
      throw new Error(`invalid verification configuration: ${JSON.stringify(isVerifyConfig.errors)}`);
    verifyCommand = configValue.command;
  }
  let eventCommand: string[] | null = null;
  let eventTimeoutMs: number | null = null;
  if (eventConfigPath !== undefined) {
    const configPath = realpathSync(eventConfigPath);
    runner.assertPrivatePath(configPath);
    const configValue: unknown = JSON.parse(readFileSync(configPath, "utf8"));
    if (!isEventConfig(configValue))
      throw new Error(`invalid event configuration: ${JSON.stringify(isEventConfig.errors)}`);
    eventCommand = configValue.command;
    eventTimeoutMs = configValue.timeout_ms;
  }
  let loopCommand: string[] | null = null;
  let loopTimeoutMs: number | null = null;
  if (loopConfigPath !== undefined) {
    const configPath = realpathSync(loopConfigPath);
    runner.assertPrivatePath(configPath);
    const configValue: unknown = JSON.parse(readFileSync(configPath, "utf8"));
    if (!isEventConfig(configValue))
      throw new Error(`invalid loop configuration: ${JSON.stringify(isEventConfig.errors)}`);
    loopCommand = configValue.command;
    loopTimeoutMs = configValue.timeout_ms;
  }
  const effectAdapters = new Map<string, EffectAdapter>();
  if (effectConfigPath !== undefined) {
    const configPath = realpathSync(effectConfigPath);
    runner.assertPrivatePath(configPath);
    const configValue: unknown = JSON.parse(readFileSync(configPath, "utf8"));
    if (!isEffectConfig(configValue))
      throw new Error(`invalid effect configuration: ${JSON.stringify(isEffectConfig.errors)}`);
    for (const adapter of configValue.adapters) {
      if (effectAdapters.has(adapter.effect)) throw new Error(`duplicate effect adapter ${adapter.effect}`);
      effectAdapters.set(adapter.effect, adapter);
    }
  }
  const decisions = new Map<string, Promise<unknown>>();
  const activeChildren = new Set<KillableChild>();
  let delivering = false;
  let rescanEvents = false;
  let deliveryHealthy = true;
  const wakeEvents = () => {
    if (eventCommand === null) return;
    if (delivering) {
      rescanEvents = true;
      return;
    }
    delivering = true;
    void (async () => {
      do {
        rescanEvents = false;
        for (const event of runner.pendingEvents(runId)) {
          try {
            const delivered = await spawnPiped(
              eventCommand,
              runner.stateDir,
              JSON.stringify({ run: runId, ...event }),
              { ...privateChildEnv(runner), AK_RUNNER_SOCKET: socketPath, AK_RUNNER_TOKEN: workerToken },
              activeChildren,
              eventTimeoutMs ?? undefined,
            );
            if (delivered.exitCode !== 0) throw new Error(`consumer exited ${delivered.exitCode}`);
            const answer: unknown = JSON.parse(delivered.stdout.toString());
            if (!isEventAck(answer) || answer.run !== runId || answer.key !== event.key)
              throw new Error("consumer acknowledgement did not match the event");
            runner.ackEvent(runId, event.key);
          } catch (cause) {
            deliveryHealthy = false;
            io.err(
              `ak runner: event ${event.key} remains pending: ${cause instanceof Error ? cause.message : String(cause)}`,
            );
          }
        }
      } while (rescanEvents);
      if (runner.pendingEvents(runId).length === 0) deliveryHealthy = true;
    })()
      .catch((cause) => {
        if (!(cause instanceof Error && "code" in cause && cause.code === "ENOENT")) {
          deliveryHealthy = false;
          io.err(`ak runner: event delivery stopped: ${cause instanceof Error ? cause.message : String(cause)}`);
        }
      })
      .finally(() => {
        delivering = false;
      });
  };
  let auditTimer: ReturnType<typeof setInterval> | null = null;
  let auditRunning = false;
  let auditHealthy = true;
  const runAudit = async () => {
    if (loopCommand === null || auditRunning) return;
    auditRunning = true;
    try {
      const before = runner.auditTick(runId);
      if (before.drained) {
        if (auditTimer !== null) clearInterval(auditTimer);
        auditTimer = null;
        return;
      }
      const probe = await spawnPiped(
        loopCommand,
        runner.stateDir,
        JSON.stringify({ action: "probe", run: runId, delegates: before.active, procedure: before.procedure }),
        privateChildEnv(runner),
        activeChildren,
        loopTimeoutMs ?? undefined,
      );
      if (probe.exitCode !== 0) throw new Error(`audit probe exited ${probe.exitCode}`);
      const observed: unknown = JSON.parse(probe.stdout.toString());
      if (!isAuditProbeReply(observed) || JSON.stringify(observed.probed) !== JSON.stringify(before.active))
        throw new Error("audit probe did not cover every active delegate");
      for (const progress of observed.progress) {
        runner.recordProgress(runId, progress.delegate, progress.kind, progress.ref);
      }
      const tick = runner.auditTick(runId);
      for (const delegate of tick.replace) {
        const key = sha256Hex(`${runId}\0replace\0${delegate}`);
        const replaced = await spawnPiped(
          loopCommand,
          runner.stateDir,
          JSON.stringify({ action: "stand-down-replace", run: runId, delegate, key }),
          privateChildEnv(runner),
          activeChildren,
          loopTimeoutMs ?? undefined,
        );
        if (replaced.exitCode !== 0) throw new Error(`replacement adapter exited ${replaced.exitCode}`);
        const value: unknown = JSON.parse(replaced.stdout.toString());
        if (!isAuditReplacementReply(value) || value.key !== key)
          throw new Error("replacement lacked matching read-back");
        runner.replaceDelegate(runId, delegate, value.replacement, value.expected_runtime_seconds);
      }
      auditHealthy = true;
    } catch (cause) {
      auditHealthy = false;
      io.err(`ak runner: audit tick failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      auditRunning = false;
    }
  };
  const armAudit = () => {
    if (loopCommand === null || auditTimer !== null) return;
    try {
      const run = runner.status(runId);
      if (
        run.charter.audit_cadence_seconds === undefined ||
        !Object.values(run.delegates ?? {}).some((delegate) => delegate.state === "active")
      )
        return;
      auditTimer = setInterval(() => {
        void runAudit();
      }, run.charter.audit_cadence_seconds * 1000);
    } catch (cause) {
      if (!(cause instanceof Error && "code" in cause && cause.code === "ENOENT"))
        io.err(`ak runner: cannot arm audit: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  };
  const server = createServer((connection) => {
    let body = "";
    let handled = false;
    connection.setEncoding("utf8");
    const respond = async (line: string) => {
      try {
        const requestValue: unknown = JSON.parse(line);
        if (!isRequest(requestValue)) throw new Error(`invalid request: ${JSON.stringify(isRequest.errors)}`);
        const request = requestValue;
        const result = await execute(
          runner,
          request,
          adminToken,
          workerToken,
          runId,
          launchers,
          council,
          verifyCommand,
          effectAdapters,
          decisions,
          activeChildren,
          eventCommand !== null && loopCommand !== null && deliveryHealthy && auditHealthy,
        );
        const missing = [
          eventCommand === null ? "event-adapter" : null,
          !deliveryHealthy ? "event-delivery-failed" : null,
          loopCommand === null ? "loop-adapter" : null,
          !runner.status(runId).charter.allowed_capabilities.includes("event-delivery")
            ? "charter-event-delivery"
            : null,
          loopCommand !== null && runner.status(runId).charter.audit_cadence_seconds === undefined
            ? "charter-cadence"
            : null,
          !auditHealthy ? "audit-failed" : null,
        ].filter((part): part is string => part !== null);
        const presented =
          request.verb === "status"
            ? { ...runner.status(runId), autonomy: { mode: missing.length === 0 ? "autonomous" : "guided", missing } }
            : result;
        connection.end(`${JSON.stringify({ ok: true, result: presented })}\n`);
        if (request.verb === "event" || request.verb === "start") wakeEvents();
        if (request.verb === "delegate" || request.verb === "start") armAudit();
      } catch (cause) {
        connection.end(
          `${JSON.stringify({ ok: false, error: cause instanceof Error ? cause.message : String(cause) })}\n`,
        );
      }
    };
    connection.on("data", (chunk: string) => {
      if (handled) return;
      body += chunk;
      if (body.length > 1_000_000) connection.destroy(new Error("runner request too large"));
      const newline = body.indexOf("\n");
      if (newline < 0) return;
      handled = true;
      void respond(body.slice(0, newline));
    });
  });
  server.listen(socketPath, () => {
    chmodSync(socketPath, Number.parseInt(mode, 8));
    io.out(`ak runner: listening on ${socketPath}`);
    wakeEvents();
    armAudit();
  });
  const close = () => {
    if (auditTimer !== null) clearInterval(auditTimer);
    for (const child of activeChildren) child.kill("SIGKILL");
    if (existsSync(socketPath)) unlinkSync(socketPath);
    process.exit(0);
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
  return 0;
}

async function call(argv: readonly string[], io: Io): Promise<number> {
  const socket = flag(argv, "socket") ?? process.env["AK_RUNNER_SOCKET"];
  const token = process.env["AK_RUNNER_TOKEN"];
  const verb = argv[0];
  if (!socket || !token || !verb || verb.startsWith("--"))
    throw new Error("call needs a verb, --socket or AK_RUNNER_SOCKET, and AK_RUNNER_TOKEN");
  // Refused before connecting: the service answers an unknown verb only as one this token may not use.
  if (!WORKER.has(verb) && !ADMIN.has(verb)) {
    io.err(`ak runner: ${unknownSelector("verb", verb, [...WORKER, ...ADMIN])}`);
    return 2;
  }
  const source = flag(argv, "json");
  if (source === undefined) throw new Error("call needs --json <request-file>");
  const argsValue: unknown = await Bun.file(source).json();
  if (!isArgs(argsValue)) throw new Error(`invalid request arguments: ${JSON.stringify(isArgs.errors)}`);
  const args = argsValue;
  return new Promise<number>((resolveCode) => {
    const connection = createConnection(socket);
    let response = "";
    connection.on("connect", () => connection.write(`${JSON.stringify({ token, verb, args })}\n`));
    connection.on("data", (chunk: Buffer) => {
      response += chunk.toString();
    });
    connection.on("end", () => {
      try {
        const resultValue: unknown = JSON.parse(response);
        if (!isResponse(resultValue)) throw new Error("invalid response envelope");
        const result = resultValue;
        if (!result.ok) {
          io.err(`ak runner: ${result.error}`);
          resolveCode(1);
          return;
        }
        io.out(JSON.stringify(result.result, null, 2));
        resolveCode(0);
      } catch {
        io.err("ak runner: invalid service response");
        resolveCode(1);
      }
    });
    connection.on("error", (cause) => {
      io.err(`ak runner: ${cause.message}`);
      resolveCode(1);
    });
  });
}

export async function runRunner(argv: readonly string[], io: Io): Promise<number> {
  try {
    if (argv[0] === "serve") return await serve(argv.slice(1), io);
    if (argv[0] === "call") return call(argv.slice(1), io);
    if (argv[0] !== undefined) io.err(`ak runner: ${unknownSelector("subcommand", argv[0], ["serve", "call"])}`);
    io.err(
      "usage: ak runner serve --socket <path> --state-dir <path> --worker-root <path> --run-id <id> --admin-token-file <path> [--kit-root <bundle>] [--seat-config <path>] [--council-config <path>] [--verify-config <path>] [--effect-config <path>] [--event-config <path>] [--loop-config <path>] [--socket-mode 600|660]",
    );
    io.err("       ak runner call <verb> --json <request-file> [--socket <path>]");
    return 2;
  } catch (cause) {
    io.err(`ak runner: ${cause instanceof Error ? cause.message : String(cause)}`);
    return 1;
  }
}
