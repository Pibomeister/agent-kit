import { timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, readFileSync, realpathSync, unlinkSync } from "node:fs";
import { createConnection, createServer, type Socket } from "node:net";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import { Runner } from "./core.ts";
import { workerControlledPath, workerFreePath } from "./path.ts";
import { readAdminToken } from "./token.ts";
import {
  isArgs,
  isEffectConfig,
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
  | "limit";
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
) {
  const child = Bun.spawn(argv, {
    cwd,
    env,
    stdin: stdin === undefined ? "ignore" : Buffer.from(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  activeChildren?.add(child);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).arrayBuffer(),
      new Response(child.stderr).arrayBuffer(),
      child.exited,
    ]);
    return { exitCode, stdout: Buffer.from(stdout), stderr: Buffer.from(stderr) };
  } finally {
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

async function decideCard(
  runner: Runner,
  runId: string,
  cardId: string,
  launchers: SeatLauncher[],
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
  return runner.decide(runId, cardId, failures);
}

async function execute(
  runner: Runner,
  request: Request,
  adminToken: string,
  workerToken: string,
  allowedRun: string,
  launchers: SeatLauncher[],
  verifyCommand: string[] | null,
  effectAdapters: Map<string, EffectAdapter>,
  decisions: Map<string, Promise<unknown>>,
  activeChildren: Set<KillableChild>,
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
      const cardId = str(a, "card_id");
      const pending =
        decisions.get(cardId) ??
        decideCard(runner, str(a, "run"), cardId, launchers, activeChildren).finally(() => decisions.delete(cardId));
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
  const verifyConfigPath = flag(argv, "verify-config");
  const effectConfigPath = flag(argv, "effect-config");
  const adminTokenFile = flag(argv, "admin-token-file");
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
  const runner = new Runner(state, workerRoot, resolve(import.meta.dir, "..", ".."), true);
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
  const connections = new Set<Socket>();
  const server = createServer((connection) => {
    connections.add(connection);
    connection.once("close", () => connections.delete(connection));
    let body = "";
    let handled = false;
    connection.setEncoding("utf8");
    const respond = async (line: string) => {
      try {
        const requestValue: unknown = JSON.parse(line);
        if (!isRequest(requestValue)) throw new Error(`invalid request: ${JSON.stringify(isRequest.errors)}`);
        const request = requestValue;
        connection.end(
          `${JSON.stringify({ ok: true, result: await execute(runner, request, adminToken, workerToken, runId, launchers, verifyCommand, effectAdapters, decisions, activeChildren) })}\n`,
        );
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
  });
  const close = () => {
    server.close();
    for (const child of activeChildren) child.kill("SIGKILL");
    for (const connection of connections) connection.destroy();
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
    io.err(
      "usage: ak runner serve --socket <path> --state-dir <path> --worker-root <path> --run-id <id> --admin-token-file <path> [--seat-config <path>] [--verify-config <path>] [--effect-config <path>] [--socket-mode 600|660]",
    );
    io.err("       ak runner call <verb> --json <request-file> [--socket <path>]");
    return 2;
  } catch (cause) {
    io.err(`ak runner: ${cause instanceof Error ? cause.message : String(cause)}`);
    return 1;
  }
}
