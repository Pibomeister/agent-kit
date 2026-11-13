/**
 * Append-only observation for the named suite seams.
 *
 * Armed only by those tests. Each raw `spawnSync` attempt is written from
 * `callGit` before git retry reads it, and `execFileSync` / `Bun.spawnSync`
 * are recorded at their own APIs. The child result is returned unchanged.
 * Nothing here retries, rewrites the environment, or coerces a status.
 */
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import type { ExecFileSyncOptions, SpawnSyncOptions, SpawnSyncReturns } from "node:child_process";
import { appendFileSync, existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";

const JOURNAL =
  "/Users/eduardopicazo/orca/workspaces/firstmate/agent-kit-mate/data/ak-suite-load-tolerance/spawn-journal.jsonl";
const ROOT = join(import.meta.dir, "../..");
const TEXT_LIMIT = 4096;
const SAFE_ENV = ["AK_REQUIRE_DONORS", "AK_TEST_PARALLEL", "AK_GIT_SHIM"];
const TRACE_FILES = ["judge-calls.1.jsonl", "judge-calls.jsonl"];

type JournalJson = null | string | number | boolean | JournalJson[] | { [key: string]: JournalJson };

interface JournalEntry {
  kind: string;
  [key: string]: JournalJson | undefined;
}

interface ExecThrown extends NodeJS.ErrnoException {
  status?: number | null;
  signal?: NodeJS.Signals | null;
  stdout?: string | Buffer | null;
  stderr?: string | Buffer | null;
}

let armed: string | null = null;
let bindingWritten = false;
let seq = 0;
let invocation = 0;
const open: number[] = [];
const startedAt = new Map<number, number>();

function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function write(entry: JournalEntry): void {
  seq += 1;
  const line = JSON.stringify({ seq, at: new Date().toISOString(), ...entry });
  appendFileSync(JOURNAL, `${line}\n`);
}

function quietly(emit: () => void): void {
  try {
    emit();
  } catch {
    // A journal failure must not change the child result the caller returns.
  }
}

function payload(value: string | Buffer | null | undefined) {
  if (value === undefined || value === null) return { bytes: 0, sha256: null, text: null, truncated: false };
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  const digest = sha256(bytes);
  if (bytes.length > TEXT_LIMIT) return { bytes: bytes.length, sha256: digest, text: null, truncated: true };
  return { bytes: bytes.length, sha256: digest, text: bytes.toString("utf8"), truncated: false };
}

function isErrno(error: Error): error is NodeJS.ErrnoException {
  return "code" in error || "errno" in error || "syscall" in error;
}

function isExecThrown(error: Error): error is ExecThrown {
  return "status" in error || "stdout" in error || "code" in error;
}

function errnoFields(error: NodeJS.ErrnoException) {
  return {
    name: error.name,
    message: error.message,
    code: error.code ?? null,
    errno: error.errno ?? null,
    syscall: error.syscall ?? null,
  };
}

function cwdText(cwd: SpawnSyncOptions["cwd"]): string | null {
  if (cwd === undefined) return null;
  if (cwd instanceof URL) return cwd.href;
  return cwd;
}

function encodingText(encoding: SpawnSyncOptions["encoding"]): string | null {
  if (encoding === undefined || encoding === null) return null;
  return encoding;
}

function inputBytes(input: SpawnSyncOptions["input"]): number | null {
  if (input === undefined) return null;
  if (Buffer.isBuffer(input)) return input.length;
  if (ArrayBuffer.isView(input)) return input.byteLength;
  return Buffer.byteLength(input);
}

function safeFields(env: NodeJS.ProcessEnv | undefined) {
  const fields: { [key: string]: string } = {};
  if (env === undefined) return { replaced: false, fields };
  for (const key of SAFE_ENV) {
    const value = env[key];
    if (value === undefined) continue;
    fields[key] = /^[0-9A-Za-z._:-]{0,80}$/.test(value) ? value : "set";
  }
  return { replaced: true, fields };
}

function spawnContext(options: SpawnSyncOptions | undefined) {
  return {
    case: armed,
    invocation: open.at(-1) ?? null,
    cwd: cwdText(options?.cwd),
    timeoutMs: options?.timeout ?? null,
    encoding: encodingText(options?.encoding),
    inputBytes: inputBytes(options?.input),
    env: safeFields(options?.env),
  };
}

function fileHash(relative: string) {
  const full = join(ROOT, relative);
  if (!existsSync(full)) return { path: relative, sha256: null };
  return { path: relative, sha256: sha256(readFileSync(full)) };
}

function gitHead(dir: string): string | null {
  // Call through the builtin so this module's load does not bind `spawnSync` before the retry wrapper.
  const result = process.getBuiltinModule("node:child_process").spawnSync("git", ["-C", dir, "rev-parse", "HEAD"], {
    encoding: "utf8",
    timeout: 15_000,
  });
  const text = (result.stdout ?? "").trim();
  return /^[0-9a-f]{40}$/.test(text) ? text : null;
}

function donorPins() {
  const dir = join(ROOT, ".donors");
  if (!existsSync(dir)) return { realpath: null, symlink: false, pins: [] };
  const link = lstatSync(dir).isSymbolicLink();
  let resolved: string | null = null;
  try {
    resolved = realpathSync(dir);
  } catch {
    resolved = null;
  }
  const pins: { name: string; head: string | null }[] = [];
  if (resolved !== null) {
    for (const name of readdirSync(resolved)) {
      if (pins.length >= 30) break;
      const child = join(resolved, name);
      if (!lstatSync(child).isDirectory()) continue;
      pins.push({ name, head: gitHead(child) });
    }
  }
  return { realpath: resolved, symlink: link, pins };
}

function lockDigest() {
  const dir = join(ROOT, "node_modules");
  let resolved: string | null = null;
  try {
    if (existsSync(dir)) resolved = realpathSync(dir);
  } catch {
    resolved = null;
  }
  const lock = join(ROOT, "bun.lock");
  return { realpath: resolved, lockSha256: existsSync(lock) ? sha256(readFileSync(lock)) : null };
}

function writeBinding(): void {
  bindingWritten = true;
  const env: { [key: string]: string } = {};
  for (const key of SAFE_ENV) {
    const value = process.env[key];
    if (value === undefined) continue;
    env[key] = /^[0-9A-Za-z._:-]{0,80}$/.test(value) ? value : "set";
  }
  quietly(() =>
    write({
      kind: "binding",
      head: gitHead(ROOT),
      git: Bun.which("git"),
      execPath: process.execPath.split("/").at(-1) ?? "",
      files: [
        "tests/helpers/spawn-journal.ts",
        "tests/helpers/git-spawn.ts",
        "tests/preload.ts",
        "src/learn/core/proc.ts",
        "src/learn/core/judge.ts",
        "src/packaging/plan.ts",
        "src/validation/provenance.ts",
        "src/validation/donor-snapshots.ts",
        "tests/receipt-donors.test.ts",
        "tests/constitution-registry.test.ts",
        "tests/learn/core.test.ts",
      ].map(fileHash),
      donors: donorPins(),
      nodeModules: lockDigest(),
      env,
      untapped: ["child_process.spawn", "child_process.exec", "child_process.execSync", "child_process.fork"],
      nested: "a child of a spawned shell is not its own entry; the shell status and output are the entry",
    }),
  );
}

/** Start observing. The binding is written once, while recording is still off. */
export function armSpawnJournal(caseName: string): void {
  if (!bindingWritten) writeBinding();
  armed = caseName;
  quietly(() => write({ kind: "arm", case: caseName }));
}

export function disarmSpawnJournal(): void {
  const caseName = armed;
  armed = null;
  if (caseName === null) return;
  quietly(() => write({ kind: "disarm", case: caseName }));
}

/** Opens a span that later child entries cite. Returns 0 while the journal is off. */
export function beginInvocation(kind: string, argv: readonly string[], cwd: string): number {
  if (armed === null) return 0;
  const id = invocation + 1;
  invocation = id;
  open.push(id);
  startedAt.set(id, Date.now());
  quietly(() =>
    write({ kind: "invocation-start", invocation: id, case: armed, invocationKind: kind, argv: [...argv], cwd }),
  );
  return id;
}

/** Every out and err line, plus the status `runCli` returned. Nothing is filtered. */
export function finishInvocation(id: number, status: number | null, lines: readonly string[], returned = true): void {
  if (id === 0) return;
  if (open.at(-1) === id) open.pop();
  const began = startedAt.get(id);
  startedAt.delete(id);
  quietly(() =>
    write({
      kind: "invocation-end",
      invocation: id,
      case: armed,
      returned,
      status,
      elapsedMs: began === undefined ? null : Date.now() - began,
      lines: [...lines],
    }),
  );
}

/** The raw Node `spawnSync` return, before retry or `proc.run` normalization. */
export function recordNodeSpawn(
  command: string,
  argv: readonly string[],
  options: SpawnSyncOptions | undefined,
  result: SpawnSyncReturns<string | Buffer>,
  elapsedMs: number,
): void {
  if (armed === null) return;
  const error = result.error;
  quietly(() =>
    write({
      kind: "spawn",
      api: "node",
      command,
      argv: argv.slice(0, 32),
      argc: argv.length,
      elapsedMs,
      pid: result.pid,
      status: result.status,
      signal: result.signal,
      error:
        error === undefined ? null : isErrno(error) ? errnoFields(error) : { name: error.name, message: error.message },
      stdout: payload(result.stdout),
      stderr: payload(result.stderr),
      ...spawnContext(options),
    }),
  );
}

function observeExec(
  file: string,
  argv: readonly string[],
  options: ExecFileSyncOptions | undefined,
  elapsedMs: number,
  body: JournalEntry,
): void {
  if (armed === null) return;
  quietly(() =>
    write({
      kind: "spawn",
      api: "node-execFile",
      command: file,
      argv: argv.slice(0, 32),
      elapsedMs,
      ...spawnContext(options),
      ...body,
    }),
  );
}

/** `execFileSync` does not go through `spawnSync`. Same observation, no retry. */
function installExecFile(): void {
  const childProcess = process.getBuiltinModule("node:child_process");
  const original = childProcess.execFileSync;
  function wrapped(file: string, args?: readonly string[] | ExecFileSyncOptions, options?: ExecFileSyncOptions) {
    const started = Date.now();
    const argv = Array.isArray(args) ? args : [];
    const opts = Array.isArray(args) ? options : args;
    try {
      const result = Array.isArray(args)
        ? original(file, args, options)
        : args === undefined
          ? original(file)
          : original(file, args);
      observeExec(file, argv, opts, Date.now() - started, {
        kind: "spawn",
        threw: false,
        stdout: payload(result),
        stderrCaptured: false,
      });
      return result;
    } catch (caught) {
      const failure = caught instanceof Error && isExecThrown(caught) ? caught : undefined;
      observeExec(file, argv, opts, Date.now() - started, {
        kind: "spawn",
        threw: true,
        error:
          failure === undefined
            ? { message: caught instanceof Error ? caught.message : "non-error throw" }
            : {
                ...errnoFields(failure),
                status: failure.status ?? null,
                signal: failure.signal ?? null,
              },
        stdout: payload(failure?.stdout),
        stderr: payload(failure?.stderr),
      });
      throw caught;
    }
  }
  Reflect.set(childProcess, "execFileSync", wrapped);
}

function bunTimeout(options: { timeout?: number } | undefined): number | null {
  if (options === undefined || options.timeout === undefined) return null;
  return options.timeout;
}

function installBun(): void {
  const original = Bun.spawnSync;
  function wrapped(command: string[], options?: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number }) {
    const started = Date.now();
    const result = options === undefined ? original(command) : original(command, options);
    if (armed !== null) {
      quietly(() =>
        write({
          kind: "spawn",
          api: "bun",
          command: command[0] ?? "",
          argv: command.slice(1, 33),
          argc: command.length,
          elapsedMs: Date.now() - started,
          pid: result.pid,
          exitCode: result.exitCode,
          signalCode: result.signalCode,
          success: result.success,
          stdout: payload(result.stdout),
          stderr: payload(result.stderr),
          invocation: open.at(-1) ?? null,
          case: armed,
          timeoutMs: bunTimeout(options),
        }),
      );
    }
    return result;
  }
  Reflect.set(Bun, "spawnSync", wrapped);
}

let tapsInstalled = false;

/** Install the Bun and execFile taps. `spawnSync` is already wrapped by git retry. */
export function installSpawnJournal(): void {
  if (tapsInstalled) return;
  tapsInstalled = true;
  installExecFile();
  installBun();
}

interface TraceRow {
  call_id: string;
  attempt: number;
  outcome: string;
  exit_code: number;
  timed_out: boolean;
  duration_ms: number;
  prompt_sha256: string;
  prompt_chars: number;
  stderr_tail: string;
}

function isTraceRow(value: unknown): value is TraceRow {
  return value instanceof Object && "call_id" in value && "outcome" in value;
}

function slimTrace(row: TraceRow) {
  return {
    call_id: row.call_id,
    attempt: row.attempt,
    outcome: row.outcome,
    exit_code: row.exit_code,
    timed_out: row.timed_out,
    duration_ms: row.duration_ms,
    prompt_sha256: row.prompt_sha256,
    prompt_chars: row.prompt_chars,
    stderr_tail: row.stderr_tail,
  };
}

function readTraces(file: string): TraceRow[] {
  const rows: TraceRow[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (line === "") continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isTraceRow(parsed)) rows.push(parsed);
    } catch {
      // A torn line stays out of the row list; the spawn entries are the raw record.
    }
  }
  return rows;
}

function tracesOf(runtimeDir: string) {
  const traces: { [key: string]: JournalJson } = {};
  for (const name of TRACE_FILES) {
    const file = join(runtimeDir, name);
    traces[name] = existsSync(file) ? readTraces(file).map(slimTrace) : [];
  }
  return traces;
}

function bodyDigests(runtimeDir: string) {
  const file = join(runtimeDir, "trace.sqlite");
  if (!existsSync(file)) return { present: false };
  const db = new Database(file, { readonly: true });
  try {
    const rows = db
      .query<{ call_id: string; prompt: string | null; reply: string | null }, []>(
        "SELECT call_id, prompt, reply FROM judge_bodies",
      )
      .all();
    return {
      present: true,
      rows: rows.map((row) => ({
        call_id: row.call_id,
        prompt_sha256: row.prompt === null ? null : sha256(row.prompt),
        reply_sha256: row.reply === null ? null : sha256(row.reply),
        prompt_bytes: row.prompt === null ? null : Buffer.byteLength(row.prompt),
        reply_bytes: row.reply === null ? null : Buffer.byteLength(row.reply),
      })),
    };
  } catch (caught) {
    return { present: true, error: caught instanceof Error ? caught.message : "read failed" };
  } finally {
    db.close();
  }
}

/**
 * Synthetic judge only. A command other than `sh` stops the test: this journal
 * does not call a provider. The prompt is stored as a digest. `parsedText` is
 * the judge return value, already serialized by the test.
 */
export function recordJudge(input: {
  invocation: number;
  prompt: string;
  classification: "absent" | "null" | "object";
  parsedText: string | null;
  runtimeDir: string;
  timeoutMs: number;
  command: readonly string[];
}): void {
  if (armed === null) return;
  if (open.at(-1) === input.invocation) open.pop();
  const bin = input.command[0] ?? "";
  if (bin !== "sh" && !bin.endsWith("/sh")) {
    startedAt.delete(input.invocation);
    quietly(() => write({ kind: "stop", case: armed, reason: "unexpected-judge-command" }));
    throw new Error("spawn journal stopped: judge command is not the synthetic shell");
  }
  const began = startedAt.get(input.invocation);
  startedAt.delete(input.invocation);
  const parsed = input.parsedText;
  const parsedBytes = parsed === null ? 0 : Buffer.byteLength(parsed);
  quietly(() =>
    write({
      kind: "judge",
      case: armed,
      invocation: input.invocation,
      elapsedMs: began === undefined ? null : Date.now() - began,
      timeoutMs: input.timeoutMs,
      command: "sh",
      prompt_sha256: sha256(input.prompt),
      prompt_bytes: Buffer.byteLength(input.prompt),
      classification: input.classification,
      parsed: parsed === null || parsedBytes > 500 ? null : parsed,
      parsed_sha256: parsed === null ? null : sha256(parsed),
      parsed_bytes: parsedBytes,
      parsed_truncated: parsed !== null && parsedBytes > 500,
      traces: tracesOf(input.runtimeDir),
      bodies: bodyDigests(input.runtimeDir),
    }),
  );
}
