/**
 * The unattended lifecycle policy (docs/decisions/0014-unattended-lifecycle-policy.md and its amendment of
 * 2026-11-11): opt-in selection, the declared run supervisor, the phase start check, command evidence, the
 * pre-ticket import, the pre-ship check, and the attested final ship.
 *
 * One seam. The command runs through `runCli` in temporary git repositories that have no remote at all. A
 * `gh` shim on the search path logs every call, and every test fails if it was ever called: nothing on the
 * unattended path reads a forge. Declarations, attestations and bodies live in temporary directories outside
 * the repository, as the contract requires.
 */
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "../../src/cli.ts";
import { defaultEvidenceDir, readRecords, takeSnapshot, type Gate, type Snapshot } from "../../src/lifecycle/gate.ts";
import * as unattended from "../../src/lifecycle/unattended.ts";
import {
  type Json,
  type JsonObject,
  parseJson,
  resolvePolicy,
  unattendedDisclosure,
} from "../../src/lifecycle/unattended.ts";
import { artifactHash } from "../../src/util/hash.ts";
import { makeTree } from "../helpers/tree.ts";

setDefaultTimeout(60_000);

const ROOT = join(import.meta.dir, "../..");
const CONTRACT = "agent-kit/supervisor-contract@1";
const OBLIGATION_KEYS = [
  "launch-and-watch",
  "validation-gate",
  "independent-review",
  "seat-separation",
  "head-bound-evidence",
  "disclosure",
] as const;
const RECOVERY =
  "recovery: open a new run with open --ticket under the declaration in force and record the gates again";
const sha = (text: string | Uint8Array) => `sha256:${createHash("sha256").update(text).digest("hex")}`;
const DIGEST = /^sha256:[0-9a-f]{64}$/;

// ── the command seam ─────────────────────────────────────────────────────────

function git(cwd: string, ...args: string[]): string {
  const p = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], { cwd });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`);
  return p.stdout.toString().trim();
}

/** A repository with one commit on main and a feature branch checked out. It has no remote. */
function repo(): string {
  const dir = realpathSync(makeTree({ "src/a.js": "export const a = 1;\n" }));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  git(dir, "checkout", "-q", "-b", "feature");
  return dir;
}

function ak(cwd: string, ...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = runCli(["lifecycle", ...argv], { cwd, io: { out: (l) => out.push(l), err: (l) => err.push(l) } });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

const saved = new Map<string, string | undefined>();
function setEnv(vars: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(vars)) {
    if (!saved.has(key)) saved.set(key, process.env[key]);
    if (value === undefined) Reflect.deleteProperty(process.env, key);
    else process.env[key] = value;
  }
}

/** The log of the `gh` shim of the running test. */
let ghLog = "";
beforeEach(() => {
  setEnv({
    AK_LIFECYCLE_POLICY: undefined,
    AK_LIFECYCLE_SUPERVISOR: undefined,
    AK_LIFECYCLE_SUPERVISOR_DECLARATION: undefined,
  });
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "ak-shim-")));
  ghLog = join(dir, "calls.log");
  writeFileSync(join(dir, "gh"), `#!/bin/sh\necho "$@" >> '${ghLog}'\nexit 1\n`);
  chmodSync(join(dir, "gh"), 0o755);
  setEnv({ PATH: `${dir}:${process.env.PATH ?? ""}` });
});
afterEach(() => {
  const calls = existsSync(ghLog) ? readFileSync(ghLog, "utf8") : "";
  for (const [key, value] of saved) {
    if (value === undefined) Reflect.deleteProperty(process.env, key);
    else process.env[key] = value;
  }
  saved.clear();
  expect(calls).toBe("");
});

const outsideDir = () => realpathSync(mkdtempSync(join(tmpdir(), "ak-outside-")));
const obligationsOf = (): Record<string, string> =>
  Object.fromEntries(OBLIGATION_KEYS.map((key) => [key, `how the supervisor meets ${key}`]));
const declarationOf = (name: string, over: JsonObject = {}): JsonObject => ({
  contract: CONTRACT,
  supervisor: name,
  obligations: obligationsOf(),
  ...over,
});

/**
 * Writes a declaration for `name` outside every checkout and names it in the environment. `value` replaces the
 * declaration object and `text` replaces its bytes, for the cases that need an invalid one.
 */
function declareSupervisor(name = "firstmate", value?: Json, text?: string): string {
  const file = join(outsideDir(), "declaration.json");
  writeFileSync(file, text ?? `${JSON.stringify(value ?? declarationOf(name), null, 2)}\n`);
  setEnv({ AK_LIFECYCLE_SUPERVISOR: name, AK_LIFECYCLE_SUPERVISOR_DECLARATION: file });
  return file;
}

function ticketFile(cwd: string): string {
  const path = join(cwd, "ticket.json");
  const ticket = {
    schema: "ticket",
    schema_version: 1,
    id: "demo-ticket",
    acceptance_criteria: [{ id: "AC-1", text: "The behavior is verified." }],
    verification: [{ id: "project-check", check: "Run the project check.", kind: "command", supports: ["AC-1"] }],
  };
  writeFileSync(path, `${JSON.stringify(ticket)}\n`);
  return path;
}

const isSnapshot = (s: Snapshot | string): s is Snapshot => Object(s) === s;
function snapshotOf(cwd: string): Snapshot {
  const s = takeSnapshot(cwd);
  if (!isSnapshot(s)) throw new Error(s);
  return s;
}

function receiptFile(cwd: string, run: string, ticketPath: string, extra: JsonObject = {}): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "ak-receipt-")));
  writeFileSync(join(dir, "out.log"), "1 pass\n");
  const digest = sha("1 pass\n");
  const ticket: unknown = JSON.parse(readFileSync(ticketPath, "utf8"));
  const doc = {
    schema: "verification",
    schema_version: 1,
    id: `verification-${Math.random().toString(16).slice(2)}`,
    project: { id: "demo" },
    run_id: run,
    created_by: { role: "runner" },
    inputs: [],
    source_revision: snapshotOf(cwd),
    created_at: "2026-10-29T00:00:00Z",
    status: "passed",
    kind: "command",
    command: { argv: ["bun", "test"] },
    exit_status: 0,
    output_digest: digest,
    artifacts: [{ path: "out.log", digest, kind: "log" }],
    environment: { id: "test", isolated: true, secrets_policy: "none" },
    supports: ["AC-1"],
    check: "project-check",
    ticket: { id: "demo-ticket", schema: "ticket", hash: artifactHash(ticket) },
    ...extra,
  };
  const path = join(dir, "receipt.json");
  writeFileSync(path, JSON.stringify(doc));
  return path;
}

const ok = ["sh", "-c", "echo ok"];
const store = (cwd: string) => defaultEvidenceDir(cwd);
const recordsOf = (cwd: string, run: string, gate: Gate) => readRecords(store(cwd), run, gate);
function runId(out: string): string {
  const id = /opened run (\S+)/.exec(out)?.[1];
  if (id === undefined) throw new Error(`open printed no run: ${out}`);
  return id;
}

/** An opened unattended run with every phase gate before ship recorded with a passing command. */
function fullRun(cwd: string): string {
  for (const g of ["align", "bound", "scout"]) expect(ak(cwd, "record", "--gate", g, "--", ...ok).code).toBe(0);
  const ticketPath = ticketFile(cwd);
  const opened = ak(cwd, "open", "--ticket", ticketPath);
  expect(opened.code).toBe(0);
  const run = runId(opened.out);
  for (const g of ["build-checks", "review-full", "review-readiness"])
    expect(ak(cwd, "record", "--gate", g, "--", ...ok).code).toBe(0);
  expect(ak(cwd, "record", "--gate", "verify", "--receipt", receiptFile(cwd, run, ticketPath), "--", ...ok).code).toBe(
    0,
  );
  return run;
}

/** An opened unattended run whose full review requested changes, current through a review-delta running `delta`. */
function deltaRun(cwd: string, delta: string[]) {
  const ticketPath = ticketFile(cwd);
  for (const g of ["align", "bound", "scout"]) expect(ak(cwd, "record", "--gate", g, "--", ...ok).code).toBe(0);
  const run = runId(ak(cwd, "open", "--ticket", ticketPath).out);
  expect(ak(cwd, "record", "--gate", "build-checks", "--", ...ok).code).toBe(0);
  expect(ak(cwd, "record", "--gate", "review-full", "--verdict", "changes-requested", "--", ...ok).code).toBe(0);
  const code = ak(cwd, "record", "--gate", "review-delta", "--", ...delta).code;
  expect(ak(cwd, "record", "--gate", "review-readiness", "--", ...ok).code).toBe(0);
  expect(ak(cwd, "record", "--gate", "verify", "--receipt", receiptFile(cwd, run, ticketPath), "--", ...ok).code).toBe(
    0,
  );
  return { run, code };
}

/** The one record file of a gate in a run. */
function recordFile(cwd: string, run: string, gate: Gate): string {
  const dir = join(store(cwd), run, gate);
  const [name] = readdirSync(dir).filter((file) => file.endsWith(".json"));
  if (name === undefined) throw new Error(`no ${gate} record in ${dir}`);
  return join(dir, name);
}

describe("selection and start (command seam)", () => {
  test("legacy by default: a human-started phase needs its typed command, a model-started one starts, nothing names the opt-in", () => {
    const cwd = repo();
    const align = ak(cwd, "unattended", "check", "--phase", "super-align");
    expect(align.code).toBe(1);
    expect(align.err).toContain("typed command");
    expect(align.err).not.toContain("AK_LIFECYCLE_POLICY");
    expect(align.err).not.toContain("ak.lifecycle.json");
    expect(ak(cwd, "unattended", "check", "--phase", "super-scout").code).toBe(0);
    expect(ak(cwd, "unattended", "check", "--phase", "super-merge").code).toBe(2);
  });

  test("the environment selects it; another value is refused with exit 2", () => {
    const cwd = repo();
    declareSupervisor();
    setEnv({ AK_LIFECYCLE_POLICY: "unattended" });
    const r = ak(cwd, "unattended", "check", "--phase", "super-ship");
    expect(r.code).toBe(0);
    const printed: unknown = JSON.parse(r.out);
    expect(printed).toMatchObject({ policy: "unattended", source: "environment", phase: "super-ship" });
    setEnv({ AK_LIFECYCLE_POLICY: "unatended" });
    expect(ak(cwd, "unattended", "check", "--phase", "super-ship").code).toBe(2);
  });

  test("the default-branch configuration selects it; the same file only on the task branch does not", () => {
    const cwd = repo();
    writeFileSync(join(cwd, "ak.lifecycle.json"), JSON.stringify({ policy: "unattended" }));
    expect(ak(cwd, "unattended", "check", "--phase", "super-align").code).toBe(1);
    git(cwd, "checkout", "-q", "main");
    git(cwd, "add", "ak.lifecycle.json");
    git(cwd, "commit", "-q", "-m", "opt in");
    const tip = git(cwd, "rev-parse", "HEAD");
    git(cwd, "update-ref", "refs/remotes/origin/main", tip);
    git(cwd, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
    git(cwd, "checkout", "-q", "feature");
    declareSupervisor();
    const r = ak(cwd, "unattended", "check", "--phase", "super-align");
    expect(r.code).toBe(0);
    const printed: unknown = JSON.parse(r.out);
    expect(printed).toMatchObject({ source: `default-branch:${tip}` });
  });

  test("a bypass grant is refused under the policy", () => {
    const cwd = repo();
    setEnv({ AK_LIFECYCLE_POLICY: "unattended" });
    const r = ak(cwd, "bypass", "check", "--grant", join(cwd, "g.json"), "--task", "t", "--phase", "super-align");
    expect(r.code).toBe(1);
    expect(r.err).toContain("unattended");
    const recorded = ak(cwd, "record", "--gate", "align", "--bypass", join(cwd, "g.json"), "--task", "t", "--", ...ok);
    expect(recorded.code).toBe(1);
    expect(recorded.err).toContain("a bypass grant does not apply under the unattended policy");
    expect(recordsOf(cwd, "feature", "align")).toEqual([]);
  });

  test("the declared supervisor is recorded on phase starts, runs, gate records, decisions and the ship disclosure", () => {
    const cwd = repo();
    const file = declareSupervisor("firstmate");
    setEnv({ AK_LIFECYCLE_POLICY: "unattended" });
    const digest = sha(readFileSync(file));
    for (const phase of ["super-align", "super-bound", "super-ship"]) {
      const checked = ak(cwd, "unattended", "check", "--phase", phase);
      expect(checked.code).toBe(0);
      expect(JSON.parse(checked.out)).toEqual({
        policy: "unattended",
        source: "environment",
        supervisor: "firstmate",
        declaration_digest: digest,
        phase,
      });
    }
    const modelPhase = ak(cwd, "unattended", "check", "--phase", "super-scout");
    expect(modelPhase.code).toBe(0);
    expect(JSON.parse(modelPhase.out)).toEqual({
      policy: "unattended",
      supervisor: "firstmate",
      declaration_digest: digest,
      phase: "super-scout",
      start: "model-started",
    });

    const run = fullRun(cwd);
    const runRecord: unknown = JSON.parse(readFileSync(join(store(cwd), "runs", run, "run.json"), "utf8"));
    expect(runRecord).toMatchObject({
      policy: { name: "unattended", source: "environment", supervisor: "firstmate" },
      supervisor: {
        name: "firstmate",
        contract: "agent-kit/supervisor-contract@1",
        declaration_path: realpathSync(file),
        declaration_digest: digest,
      },
    });
    for (const gate of [
      "align",
      "bound",
      "scout",
      "build-checks",
      "verify",
      "review-full",
      "review-readiness",
    ] as const)
      expect(recordsOf(cwd, run, gate)[0]?.policy).toEqual({
        name: "unattended",
        source: "environment",
        supervisor: "firstmate",
      });

    const decisionCheck = ak(cwd, "check", "--json");
    expect(decisionCheck.code).toBe(0);
    expect(JSON.parse(decisionCheck.out)).toMatchObject({
      outcome: "allowed",
      policy: { name: "unattended", source: "environment", supervisor: "firstmate" },
    });

    const preflight = ak(cwd, "record", "--gate", "ship-preflight");
    expect(preflight.code).toBe(0);
    expect(preflight.out).toContain(unattendedDisclosure("firstmate"));
    expect(recordsOf(cwd, run, "ship-preflight")[0]?.policy).toEqual({
      name: "unattended",
      source: "environment",
      supervisor: "firstmate",
    });
  }, 180_000);

  test("resolvePolicy refuses an AK_LIFECYCLE_SUPERVISOR containing LF, CR, ESC or DEL after trimming, and a non-string or control-character supervisor in run.json is omitted", () => {
    const cwd = repo();
    declareSupervisor("firstmate");
    setEnv({ AK_LIFECYCLE_POLICY: "unattended", AK_LIFECYCLE_SUPERVISOR: "\n firstmate \r\n" });
    const trimmed = ak(cwd, "unattended", "check", "--phase", "super-align");
    expect(trimmed.code).toBe(0);
    expect(JSON.parse(trimmed.out)).toMatchObject({ supervisor: "firstmate" });

    for (const bad of ["firstmate\ncrew", "firstmate\rcrew", "firstmate\x1b[31mcrew", "firstmate\x7fcrew"]) {
      expect(resolvePolicy(cwd, { AK_LIFECYCLE_POLICY: "unattended", AK_LIFECYCLE_SUPERVISOR: bad })).toEqual({
        ok: false,
        reason: "AK_LIFECYCLE_SUPERVISOR must not contain control characters",
      });
      setEnv({ AK_LIFECYCLE_POLICY: "unattended", AK_LIFECYCLE_SUPERVISOR: bad });
      const checked = ak(cwd, "unattended", "check", "--phase", "super-align");
      expect(checked.code).toBe(2);
      expect(checked.err).toContain("AK_LIFECYCLE_SUPERVISOR");
      expect(checked.err).toContain("must not contain control characters");
      expect(checked.err).not.toContain("crew");
      expect(checked.out).toBe("");
      const recorded = ak(cwd, "record", "--gate", "align", "--", ...ok);
      expect(recorded.code).toBe(2);
      expect(recorded.err).toContain("AK_LIFECYCLE_SUPERVISOR must not contain control characters");
      expect(recorded.err).not.toContain("crew");
      expect(recordsOf(cwd, "feature", "align")).toEqual([]);
    }

    // With no declaration the run opens unstamped, and a stored supervisor that is not a clean string is left out.
    setEnv({
      AK_LIFECYCLE_POLICY: "unattended",
      AK_LIFECYCLE_SUPERVISOR: "firstmate",
      AK_LIFECYCLE_SUPERVISOR_DECLARATION: undefined,
    });
    const run = fullRun(cwd);
    setEnv({ AK_LIFECYCLE_SUPERVISOR: undefined });
    const runPath = join(store(cwd), "runs", run, "run.json");
    const originalRunText = readFileSync(runPath, "utf8");
    for (const storedSupervisor of [42, ["firstmate"], "firstmate\ncrew", "firstmate\rcrew", "firstmate\x1b[31m"]) {
      writeFileSync(
        runPath,
        originalRunText.replace('"supervisor": "firstmate"', `"supervisor": ${JSON.stringify(storedSupervisor)}`),
      );
      expect(ak(cwd, "record", "--gate", "build-checks", "--", ...ok).code).toBe(0);
      expect(recordsOf(cwd, run, "build-checks").at(-1)?.policy).toEqual({
        name: "unattended",
        source: "environment",
      });
      const checked = ak(cwd, "check", "--json");
      expect(checked.code).toBe(0);
      expect(JSON.parse(checked.out)).toMatchObject({
        outcome: "allowed",
        policy: { name: "unattended", source: "environment" },
      });
      expect(checked.out).not.toContain('"supervisor"');
      const preflight = ak(cwd, "record", "--gate", "ship-preflight");
      expect(preflight.code).toBe(1);
      expect(preflight.err).toContain("AK_LIFECYCLE_SUPERVISOR_DECLARATION is not set");
      expect(recordsOf(cwd, run, "ship-preflight")).toEqual([]);
    }
  });

  test("the repository's committed minimal ak.lifecycle.json selects unattended on the default branch with no AK_LIFECYCLE_POLICY, records the declared supervisor across phases, and ships under the declaration", () => {
    const rootConfig = readFileSync(join(import.meta.dir, "../../ak.lifecycle.json"), "utf8");
    expect(JSON.parse(rootConfig)).toEqual({ policy: "unattended" });

    const cwd = repo();
    git(cwd, "checkout", "-q", "main");
    writeFileSync(join(cwd, "ak.lifecycle.json"), rootConfig);
    git(cwd, "add", "ak.lifecycle.json");
    git(cwd, "commit", "-q", "-m", "opt in");
    const tip = git(cwd, "rev-parse", "HEAD");
    git(cwd, "update-ref", "refs/remotes/origin/main", tip);
    git(cwd, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
    git(cwd, "checkout", "-q", "feature");

    const file = declareSupervisor("firstmate");
    setEnv({ AK_LIFECYCLE_POLICY: undefined });
    for (const phase of ["super-align", "super-bound"]) {
      const checked = ak(cwd, "unattended", "check", "--phase", phase);
      expect(checked.code).toBe(0);
      expect(JSON.parse(checked.out)).toEqual({
        policy: "unattended",
        source: `default-branch:${tip}`,
        supervisor: "firstmate",
        declaration_digest: sha(readFileSync(file)),
        phase,
      });
    }

    const run = fullRun(cwd);
    expect(ak(cwd, "check").code).toBe(0);
    expect(recordsOf(cwd, run, "align")[0]?.policy).toEqual({
      name: "unattended",
      source: `default-branch:${tip}`,
      supervisor: "firstmate",
    });
    const preflight = ak(cwd, "record", "--gate", "ship-preflight");
    expect(preflight.code).toBe(0);
    expect(preflight.out).toContain(unattendedDisclosure("firstmate"));
    expect(recordsOf(cwd, run, "ship-preflight")[0]?.policy).toEqual({
      name: "unattended",
      source: `default-branch:${tip}`,
      supervisor: "firstmate",
    });
  }, 180_000);

  test("a legacy run refuses an unattended record and an unattended check", () => {
    const cwd = repo();
    expect(ak(cwd, "open", "--ticket", ticketFile(cwd)).code).toBe(0);
    setEnv({ AK_LIFECYCLE_POLICY: "unattended" });
    const recorded = ak(cwd, "record", "--gate", "build-checks", "--", ...ok);
    expect(recorded.code).toBe(1);
    expect(recorded.err).toContain(
      "was opened under the legacy policy, and this record resolves the unattended policy",
    );
    const checked = ak(cwd, "check");
    expect(checked.code).toBe(1);
    expect(checked.err).toContain("was opened under the legacy policy, and this check resolves the unattended policy");
  });
});

/** A ticket bound could not give criteria or named verification. */
const BARE = { acceptance_criteria: [], verification: [] };

/** A ticket file with `fields` over the demo-bare identity. */
function bareTicketFile(cwd: string, fields: JsonObject = BARE): string {
  const path = join(cwd, "bare-ticket.json");
  writeFileSync(path, `${JSON.stringify({ schema: "ticket", schema_version: 1, id: "demo-bare", ...fields })}\n`);
  return path;
}

/** An independent verifier seat, the seat a fallback verify declares unless a test names another. */
const VERIFIER_SEAT = ["--author-kind", "agent", "--host", "claude-code", "--seat-id", "verifier-1"];

/**
 * An unattended run on a ticket of `fields` whose verify gate records `verify` as its only evidence command,
 * build-checks and verify each declaring the given seat flags (verify defaults to VERIFIER_SEAT), then check.
 */
function bareTicketRun(
  cwd: string,
  verify: string[] | undefined,
  fields: JsonObject = BARE,
  seats: { build?: string[]; verify?: string[] } = {},
) {
  setEnv({ AK_LIFECYCLE_POLICY: "unattended" });
  for (const g of ["align", "bound", "scout"]) expect(ak(cwd, "record", "--gate", g, "--", ...ok).code).toBe(0);
  const run = runId(ak(cwd, "open", "--ticket", bareTicketFile(cwd, fields)).out);
  expect(ak(cwd, "record", "--gate", "build-checks", ...(seats.build ?? []), "--", ...ok).code).toBe(0);
  for (const g of ["review-full", "review-readiness"]) expect(ak(cwd, "record", "--gate", g, "--", ...ok).code).toBe(0);
  if (verify !== undefined) ak(cwd, "record", "--gate", "verify", ...(seats.verify ?? VERIFIER_SEAT), "--", ...verify);
  return { ...ak(cwd, "check"), run };
}

/** Tickets that declare criteria or verification the gate cannot use: each is judged, never the fallback. */
const HALF_DECLARED: [string, JsonObject][] = [
  [
    "criteria with no verification",
    { acceptance_criteria: [{ id: "AC-1", text: "It works.", surface: "none" }], verification: [] },
  ],
  [
    "a non-AC criterion id with a real check",
    {
      acceptance_criteria: [{ id: "AK9-1", text: "It works.", surface: "none" }],
      verification: [{ id: "unit", kind: "command", check: "bun test", supports: ["AK9-1"] }],
    },
  ],
  [
    "a non-kebab check id",
    {
      acceptance_criteria: [{ id: "AC-1", text: "It works.", surface: "none" }],
      verification: [{ id: "Unit Tests", kind: "command", check: "bun test", supports: ["AC-1"] }],
    },
  ],
  ["criteria given as a string", { acceptance_criteria: "AC-1", verification: [] }],
  ["verification given as an object", { acceptance_criteria: [], verification: { id: "unit", check: "bun test" } }],
  ["criteria given as null", { acceptance_criteria: null, verification: [] }],
];

/** An unscored ticket's run: build-checks recorded with `seat` flags and no class, then verify with `receipt`. */
function unscoredRun(cwd: string, seat: string[], receipt: JsonObject) {
  setEnv({ AK_LIFECYCLE_POLICY: "unattended" });
  for (const g of ["align", "bound", "scout"]) expect(ak(cwd, "record", "--gate", g, "--", ...ok).code).toBe(0);
  const ticketPath = ticketFile(cwd);
  const run = runId(ak(cwd, "open", "--ticket", ticketPath).out);
  expect(ak(cwd, "record", "--gate", "build-checks", ...seat, "--", ...ok).code).toBe(0);
  for (const g of ["review-full", "review-readiness"]) expect(ak(cwd, "record", "--gate", g, "--", ...ok).code).toBe(0);
  const path = receiptFile(cwd, run, ticketPath, receipt);
  expect(ak(cwd, "record", "--gate", "verify", "--receipt", path, "--", ...ok).code).toBe(0);
  return run;
}
/** The argv of every command the run's verify records hold, in order. */
const verifyArgv = (cwd: string, run: string) =>
  recordsOf(cwd, run, "verify").flatMap((record) => (record.commands ?? []).map((command) => command.argv));
const UNSCORED_SEAT = ["--author-kind", "agent", "--host", "claude-code", "--seat-id", "impl-1"];
const IMPLEMENTER_RECEIPT = { created_by: { role: "implementer" } };

describe("command evidence, import and the pre-ship check (command seam)", () => {
  test("phase gates are refused without the policy; under it the tool runs and records the command", () => {
    const cwd = repo();
    expect(ak(cwd, "record", "--gate", "align", "--", ...ok).code).toBe(1);
    setEnv({ AK_LIFECYCLE_POLICY: "unattended" });
    expect(ak(cwd, "record", "--gate", "align").code).toBe(2);
    expect(ak(cwd, "record", "--gate", "align", "--", ...ok).code).toBe(0);
    const [first] = recordsOf(cwd, "feature", "align");
    expect(first?.policy).toEqual({ name: "unattended", source: "environment" });
    expect(first?.commands?.[0]).toMatchObject({ argv: ok, exit_status: 0, output: sha("ok\n") });
    expect(ak(cwd, "record", "--gate", "align", "--", "sh", "-c", "exit 3").code).toBe(1);
    expect(recordsOf(cwd, "feature", "align")[0]?.commands).toHaveLength(2);
    expect(ak(cwd, "record", "--gate", "align", "--", "sh", "-c", "echo x > src/b.js").code).toBe(1);
  });

  test("open imports pre-ticket records at the opening revision with their original times", () => {
    const cwd = repo();
    setEnv({ AK_LIFECYCLE_POLICY: "unattended" });
    expect(ak(cwd, "record", "--gate", "bound", "--", ...ok).code).toBe(0);
    const [before] = recordsOf(cwd, "feature", "bound");
    const opened = ak(cwd, "open", "--ticket", ticketFile(cwd));
    expect(opened.code).toBe(0);
    const run = runId(opened.out);
    const [imported] = recordsOf(cwd, run, "bound");
    expect(imported?.commands).toEqual(before?.commands);
    expect(imported?.imported_from?.run).toBe("feature");
    expect((imported?.recorded_at ?? "") >= (before?.recorded_at ?? "~")).toBe(true);
    const runRecord: unknown = JSON.parse(readFileSync(join(store(cwd), "runs", run, "run.json"), "utf8"));
    expect(runRecord).toMatchObject({ policy: { name: "unattended", source: "environment" } });
    const output = before?.commands?.[0]?.output ?? "";
    expect(existsSync(join(store(cwd), run, "artifacts", output.slice(7)))).toBe(true);
  });

  test("the pre-ship check needs all six phases with passing commands; a failing latest entry refuses", () => {
    const cwd = repo();
    setEnv({ AK_LIFECYCLE_POLICY: "unattended" });
    fullRun(cwd);
    const pass = ak(cwd, "check", "--json");
    expect(pass.code).toBe(0);
    const decision: unknown = JSON.parse(pass.out);
    expect(decision).toMatchObject({ outcome: "allowed", policy: { name: "unattended" }, trust: "worker-attested" });
    expect(ak(cwd, "record", "--gate", "review-readiness", "--", "sh", "-c", "exit 1").code).toBe(1);
    const failed = ak(cwd, "check");
    expect(failed.code).toBe(1);
    expect(failed.err).toContain("failed evidence");
  });

  test("a missing scout refuses, and a mismatched policy is refused in both directions", () => {
    const cwd = repo();
    setEnv({ AK_LIFECYCLE_POLICY: "unattended" });
    expect(ak(cwd, "open", "--ticket", ticketFile(cwd)).code).toBe(0);
    const check = ak(cwd, "check");
    expect(check.code).toBe(1);
    expect(check.err).toContain("scout");
    setEnv({ AK_LIFECYCLE_POLICY: undefined });
    const recorded = ak(cwd, "record", "--gate", "build-checks");
    expect(recorded.code).toBe(1);
    expect(recorded.err).toContain(
      "was opened under the unattended policy, and this record resolves the legacy policy",
    );
    const checked = ak(cwd, "check");
    expect(checked.code).toBe(1);
    expect(checked.err).toContain("was opened under the unattended policy, and this check resolves the legacy policy");
  });

  test("a covering review-delta's command entries count like the full review's: tampered output refuses", () => {
    const cwd = repo();
    setEnv({ AK_LIFECYCLE_POLICY: "unattended" });
    const { run, code } = deltaRun(cwd, ["sh", "-c", "echo delta"]);
    expect(code).toBe(0);
    expect(ak(cwd, "check").code).toBe(0);
    writeFileSync(join(store(cwd), run, "artifacts", sha("delta\n").slice(7)), "forged\n");
    const tampered = ak(cwd, "check");
    expect(tampered.code).toBe(1);
    expect(tampered.err).toContain(`gate review-delta evidence output ${sha("delta\n")} is absent or changed`);
  });

  test("a failed covering review-delta refuses as failed evidence", () => {
    const cwd = repo();
    setEnv({ AK_LIFECYCLE_POLICY: "unattended" });
    expect(deltaRun(cwd, ["sh", "-c", "echo bad; exit 1"]).code).toBe(1);
    const r = ak(cwd, "check");
    expect(r.code).toBe(1);
    expect(r.err).toContain('gate review-delta failed evidence: ["sh","-c","echo bad; exit 1"] exited 1');
  });

  test("a covering review-delta without command entries refuses as missing evidence", () => {
    const cwd = repo();
    setEnv({ AK_LIFECYCLE_POLICY: "unattended" });
    const { run } = deltaRun(cwd, ["sh", "-c", "echo delta"]);
    const [delta] = recordsOf(cwd, run, "review-delta");
    writeFileSync(recordFile(cwd, run, "review-delta"), JSON.stringify({ ...delta, commands: undefined }));
    expect(recordsOf(cwd, run, "review-delta")[0]?.commands).toBeUndefined();
    const r = ak(cwd, "check");
    expect(r.code).toBe(1);
    expect(r.err).toContain("gate review-delta has no evidence command (missing evidence)");
  });

  test("a tampered stored output of a counted record refuses at check", () => {
    const cwd = repo();
    setEnv({ AK_LIFECYCLE_POLICY: "unattended" });
    const run = fullRun(cwd);
    expect(ak(cwd, "record", "--gate", "build-checks", "--", "sh", "-c", "echo built").code).toBe(0);
    expect(ak(cwd, "check").code).toBe(0);
    writeFileSync(join(store(cwd), run, "artifacts", sha("built\n").slice(7)), "forged\n");
    const r = ak(cwd, "check");
    expect(r.code).toBe(1);
    expect(r.err).toContain(`gate build-checks evidence output ${sha("built\n")} is absent or changed`);
  });

  test("a reused branch imports only the command entries recorded after its earlier run opened", () => {
    const cwd = repo();
    setEnv({ AK_LIFECYCLE_POLICY: "unattended" });
    const ticketPath = ticketFile(cwd);
    const argvs = (run: string) => recordsOf(cwd, run, "align")[0]?.commands?.map((entry) => entry.argv.join(" "));
    expect(ak(cwd, "record", "--gate", "align", "--", "sh", "-c", "echo first").code).toBe(0);
    const first = runId(ak(cwd, "open", "--ticket", ticketPath).out);
    expect(argvs(first)).toEqual(["sh -c echo first"]);
    // The first task ships: its run closes, and the next task's phases land in the branch-named run again.
    const runJson = join(store(cwd), "runs", first, "run.json");
    const closedAt = `,\n  "closed_at": "${new Date().toISOString()}"\n}\n`;
    writeFileSync(runJson, readFileSync(runJson, "utf8").replace(/\n}\n$/, closedAt));
    expect(readFileSync(runJson, "utf8")).toContain('"closed_at"');
    expect(ak(cwd, "record", "--gate", "align", "--", "sh", "-c", "echo second").code).toBe(0);
    expect(argvs("feature")).toEqual(["sh -c echo first", "sh -c echo second"]);
    const second = runId(ak(cwd, "open", "--ticket", ticketPath).out);
    expect(argvs(second)).toEqual(["sh -c echo second"]);
    expect(recordsOf(cwd, second, "align")[0]?.imported_from?.run).toBe("feature");
  });

  test("an imported record whose every entry predates an earlier run's opening is not imported", () => {
    const cwd = repo();
    setEnv({ AK_LIFECYCLE_POLICY: "unattended" });
    const ticketPath = ticketFile(cwd);
    expect(ak(cwd, "record", "--gate", "bound", "--", ...ok).code).toBe(0);
    const first = runId(ak(cwd, "open", "--ticket", ticketPath).out);
    expect(recordsOf(cwd, first, "bound")).toHaveLength(1);
    const second = runId(ak(cwd, "open", "--ticket", ticketPath).out);
    expect(recordsOf(cwd, second, "bound")).toEqual([]);
  });

  test("a host-unattested verifier is a note under the policy, with the implementer seat recorded", () => {
    const cwd = repo();
    setEnv({ AK_LIFECYCLE_POLICY: "unattended" });
    for (const g of ["align", "bound", "scout"]) expect(ak(cwd, "record", "--gate", g, "--", ...ok).code).toBe(0);
    const ticketPath = ticketFile(cwd);
    const run = runId(ak(cwd, "open", "--ticket", ticketPath).out);
    const seatFlags = ["--class", "red", "--author-kind", "agent", "--host", "claude-code", "--seat-id", "impl-1"];
    expect(ak(cwd, "record", "--gate", "build-checks", ...seatFlags, "--", ...ok).code).toBe(0);
    for (const g of ["review-full", "review-readiness"])
      expect(ak(cwd, "record", "--gate", g, "--", ...ok).code).toBe(0);
    const seat = {
      created_by: { role: "verifier" },
      verifier_seat: { id: "verifier-1", implementer_seat: "impl-1", isolation: "host-unattested", attestation: null },
    };
    expect(
      ak(cwd, "record", "--gate", "verify", "--receipt", receiptFile(cwd, run, ticketPath, seat), "--", ...ok).code,
    ).toBe(0);
    const r = ak(cwd, "check");
    expect(r.err).toContain("host-unattested");
    expect(r.err).toContain("whose boundary is the declared run supervisor");
    expect(r.code).toBe(0);
  });

  test("an unscored ticket records its implementer seat without a class, and a receipt the implementer wrote is refused", () => {
    const cwd = repo();
    const run = unscoredRun(cwd, UNSCORED_SEAT, IMPLEMENTER_RECEIPT);
    const [build] = recordsOf(cwd, run, "build-checks");
    expect(build?.class).toBeUndefined();
    expect(build?.implementer).toEqual({ author_kind: "agent", host: "claude-code", seat_id: "impl-1" });
    const r = ak(cwd, "check");
    expect(r.code).toBe(1);
    expect(r.err).toContain("was created by implementer; an independent verifier seat is required");
  });

  test("an unscored ticket's seat passes check with an independent verifier's receipt", () => {
    const cwd = repo();
    unscoredRun(cwd, UNSCORED_SEAT, {
      created_by: { role: "verifier" },
      verifier_seat: { id: "verifier-1", implementer_seat: "impl-1", isolation: "host-unattested", attestation: null },
    });
    const r = ak(cwd, "check");
    expect(r.err).not.toContain("an independent verifier seat is required");
    expect(r.code).toBe(0);
  });

  test("without the seat recorded, the same implementer receipt is not refused: the seat is what refuses it", () => {
    const cwd = repo();
    unscoredRun(cwd, [], IMPLEMENTER_RECEIPT);
    expect(ak(cwd, "check").code).toBe(0);
  });

  test("an unscored ticket whose criteria and verification bound derived from the work source verifies like any other", () => {
    const cwd = repo();
    setEnv({ AK_LIFECYCLE_POLICY: "unattended" });
    const run = fullRun(cwd);
    const stored: unknown = JSON.parse(readFileSync(join(cwd, "ticket.json"), "utf8"));
    expect(stored).not.toHaveProperty("delegation");
    const r = ak(cwd, "check");
    expect(r.err).not.toContain("has no acceptance criteria or named verification");
    expect(r.code).toBe(0);
    expect(recordsOf(cwd, run, "verify")).toHaveLength(1);
  });

  test("with no criteria or named verification, verify falls back to the recorded repository checks as a coverage limit", () => {
    const cwd = repo();
    const r = bareTicketRun(cwd, ["sh", "-c", "echo 3 pass"]);
    expect(r.code).toBe(0);
    expect(r.err).toContain(
      "note: coverage limit: ticket demo-bare has no acceptance criteria or named verification; under the unattended policy verify counts the recorded repository checks, each with its argv, exit status and output digest",
    );
  });

  test("the fallback counts nothing but the recorded checks: a failing one refuses, and none at all refuses", () => {
    const failing = repo();
    const r = bareTicketRun(failing, ["sh", "-c", "echo 1 fail; exit 1"]);
    expect(r.code).toBe(1);
    expect(r.err).not.toContain("note: coverage limit");
    const none = repo();
    const n = bareTicketRun(none, undefined);
    expect(n.code).toBe(1);
  });

  test.each(HALF_DECLARED)("a ticket with %s is judged, not the fallback, and is refused", (_name, fields) => {
    const r = bareTicketRun(repo(), ["true"], fields);
    expect(r.code).toBe(1);
    expect(r.err).not.toContain("note: coverage limit");
  });

  test("the fallback still refuses a verify recorded by the build's implementer seat", () => {
    const self = bareTicketRun(repo(), ok, BARE, { build: UNSCORED_SEAT, verify: UNSCORED_SEAT });
    expect(self.code).toBe(1);
    expect(self.err).toContain(
      "verify was recorded by implementer seat impl-1; an independent verifier seat is required",
    );
    expect(bareTicketRun(repo(), ok, BARE, { build: UNSCORED_SEAT, verify: VERIFIER_SEAT }).code).toBe(0);
  });

  test("the fallback refuses a verify that declares no seat, whether or not the build recorded one", () => {
    for (const build of [UNSCORED_SEAT, []]) {
      const unseated = bareTicketRun(repo(), ok, BARE, { build, verify: [] });
      expect(unseated.code).toBe(1);
      expect(unseated.err).toContain("verify names no verifier seat; an independent verifier seat is required");
    }
  });

  test("a verify re-recorded at the same head under another seat keeps only that seat's commands", () => {
    const mine = ["sh", "-c", "echo verifier"];
    // An implementer-seat verify is refused; a verifier re-recording at the same head is judged on its own commands.
    for (const first of [UNSCORED_SEAT, []]) {
      const cwd = repo();
      const { run, code } = bareTicketRun(cwd, ok, BARE, { build: UNSCORED_SEAT, verify: first });
      expect(code).toBe(1);
      expect(ak(cwd, "record", "--gate", "verify", ...VERIFIER_SEAT, "--", ...mine).code).toBe(0);
      expect(verifyArgv(cwd, run)).toEqual([mine]);
      expect(ak(cwd, "check").code).toBe(0);
    }
    // An unseated command after a verifier's record is not credited to the verifier.
    const cwd = repo();
    const { run, code } = bareTicketRun(cwd, mine, BARE, { build: UNSCORED_SEAT });
    expect(code).toBe(0);
    expect(ak(cwd, "record", "--gate", "verify", "--", ...ok).code).toBe(0);
    expect(verifyArgv(cwd, run)).toEqual([ok]);
    const unseated = ak(cwd, "check");
    expect(unseated.code).toBe(1);
    expect(unseated.err).toContain("verify names no verifier seat; an independent verifier seat is required");
    // The same seat re-recording keeps accumulating its commands.
    expect(ak(cwd, "record", "--gate", "verify", ...VERIFIER_SEAT, "--", ...mine).code).toBe(0);
    expect(ak(cwd, "record", "--gate", "verify", ...VERIFIER_SEAT, "--", ...ok).code).toBe(0);
    expect(verifyArgv(cwd, run)).toEqual([mine, ok]);
  });

  test("a failing verify command stays on the record when another seat re-records, until that command passes", () => {
    const fails = ["sh", "-c", "exit 1"];
    const other = ["--author-kind", "agent", "--host", "claude-code", "--seat-id", "verifier-2"];
    for (const first of [VERIFIER_SEAT, []]) {
      const cwd = repo();
      const { run, code } = bareTicketRun(cwd, fails, BARE, { build: UNSCORED_SEAT, verify: first });
      expect(code).toBe(1);
      expect(ak(cwd, "record", "--gate", "verify", ...other, "--", ...ok).code).toBe(0);
      expect(verifyArgv(cwd, run)).toEqual([fails, ok]);
      const laundered = ak(cwd, "check");
      expect(laundered.code).toBe(1);
      expect(laundered.err).toContain(`failed evidence: ${JSON.stringify(fails)} exited 1`);
    }
  });

  test("the fallback's coverage limit is recorded on the ship decision and printed in the ship disclosure", () => {
    const cwd = repo();
    declareSupervisor();
    const { run, code } = bareTicketRun(cwd, ok);
    expect(code).toBe(0);
    const closed = ak(cwd, "record", "--gate", "ship-preflight");
    expect(closed.code).toBe(0);
    const limit = "ticket demo-bare has no acceptance criteria or named verification";
    expect(closed.out).toContain(`coverage limit: ${limit}`);
    const decisions = join(store(cwd), run, "decisions");
    const decision: unknown = JSON.parse(readFileSync(join(decisions, readdirSync(decisions).at(-1) ?? ""), "utf8"));
    expect(decision).toMatchObject({ outcome: "allowed", reasons: [{ code: "coverage-limit" }] });
    expect(JSON.stringify(decision)).toContain(limit);
  });

  test("outside the unattended policy a ticket with no criteria or named verification is still unavailable", () => {
    const cwd = repo();
    runId(ak(cwd, "open", "--ticket", bareTicketFile(cwd)).out);
    for (const g of ["build-checks", "review-full", "review-readiness", "verify"])
      expect(ak(cwd, "record", "--gate", g).code).toBe(0);
    const r = ak(cwd, "check");
    expect(r.code).toBe(1);
    expect(r.err).toContain("ticket demo-bare has no acceptance criteria or named verification");
    expect(r.err).not.toContain("note: coverage limit");
  });

  test("the classless seat form takes --author-kind, --host and --seat-id together, and the class form is unchanged", () => {
    const cwd = repo();
    for (const partial of [
      ["--author-kind", "agent", "--host", "claude-code"],
      ["--seat-id", "impl-1"],
      ["--author-kind", "agent", "--seat-id", "impl-1"],
    ]) {
      const r = ak(cwd, "record", "--gate", "build-checks", ...partial);
      expect(r.code).toBe(2);
      expect(r.err).toContain("--author-kind, --host and --seat-id must be supplied together");
    }
    const classOnly = ak(cwd, "record", "--gate", "build-checks", "--class", "green");
    expect(classOnly.code).toBe(2);
    expect(classOnly.err).toContain("--class, --author-kind, and --host must be supplied together");
    const badKind = ak(
      cwd,
      "record",
      "--gate",
      "build-checks",
      "--author-kind",
      "bot",
      "--host",
      "codex",
      "--seat-id",
      "s",
    );
    expect(badKind.code).toBe(2);
    expect(badKind.err).toContain("--author-kind must be one of");
    expect(recordsOf(cwd, "feature", "build-checks")).toEqual([]);
  });

  test("a legacy record keeps exactly its members", () => {
    const cwd = repo();
    expect(ak(cwd, "record", "--gate", "build-checks").code).toBe(0);
    const [legacy] = recordsOf(cwd, "feature", "build-checks");
    expect(Object.keys(legacy ?? {}).toSorted()).toEqual([
      "gate",
      "recorded_at",
      "run_id",
      "schema",
      "schema_version",
      "snapshot",
    ]);
  });
});

// ── the declared supervisor ─────────────────────────────────────────────────

const runsOf = (cwd: string) => (existsSync(join(store(cwd), "runs")) ? readdirSync(join(store(cwd), "runs")) : []);
const without = (value: JsonObject, key: string): JsonObject => {
  const copy = { ...value };
  Reflect.deleteProperty(copy, key);
  return copy;
};
const withObligation = (key: string, text: Json | undefined): JsonObject => {
  const obligations: JsonObject = { ...obligationsOf() };
  if (text === undefined) Reflect.deleteProperty(obligations, key);
  else obligations[key] = text;
  return { ...declarationOf("firstmate"), obligations };
};

/** One way a declaration is refused: how the environment is set up and the item the refusal names. */
interface Refusal {
  name: string;
  setup: (cwd: string) => void;
  item: string;
  /** The declaration is not set at all, so `open` opens the run unstamped instead of refusing. */
  absent?: boolean;
}

function inCheckout(cwd: string, path: string, value: Json = declarationOf("firstmate")): void {
  mkdirSync(join(cwd, path, ".."), { recursive: true });
  writeFileSync(join(cwd, path), JSON.stringify(value));
  setEnv({ AK_LIFECYCLE_SUPERVISOR: "firstmate", AK_LIFECYCLE_SUPERVISOR_DECLARATION: join(cwd, path) });
}

const REFUSALS: Refusal[] = [
  {
    name: "the supervisor name is unset",
    setup: () => {
      declareSupervisor();
      setEnv({ AK_LIFECYCLE_SUPERVISOR: undefined });
    },
    item: "AK_LIFECYCLE_SUPERVISOR is not set",
  },
  {
    name: "the declaration path is unset",
    setup: () => {
      declareSupervisor();
      setEnv({ AK_LIFECYCLE_SUPERVISOR_DECLARATION: undefined });
    },
    item: "AK_LIFECYCLE_SUPERVISOR_DECLARATION is not set",
    absent: true,
  },
  {
    name: "the declaration path is empty",
    setup: () => {
      declareSupervisor();
      setEnv({ AK_LIFECYCLE_SUPERVISOR_DECLARATION: "" });
    },
    item: "AK_LIFECYCLE_SUPERVISOR_DECLARATION is not set",
    absent: true,
  },
  {
    name: "the declaration path is relative",
    setup: () => {
      declareSupervisor();
      setEnv({ AK_LIFECYCLE_SUPERVISOR_DECLARATION: "declaration.json" });
    },
    item: "absolute",
  },
  {
    name: "the declaration file does not exist",
    setup: () => {
      declareSupervisor();
      setEnv({ AK_LIFECYCLE_SUPERVISOR_DECLARATION: join(outsideDir(), "missing.json") });
    },
    item: "cannot be read",
  },
  {
    name: "the declaration is invalid JSON",
    setup: () => void declareSupervisor("firstmate", undefined, "{not json"),
    item: "not valid JSON",
  },
  {
    name: "the declaration is not an object",
    setup: () => void declareSupervisor("firstmate", ["firstmate"]),
    item: "must be a JSON object",
  },
  {
    name: "the real path lies inside the checkout",
    setup: (cwd) => inCheckout(cwd, "declaration.json"),
    item: "outside the repository",
  },
  {
    name: "the real path lies inside the git directory",
    setup: (cwd) => inCheckout(cwd, ".git/declaration.json"),
    item: "outside the repository",
  },
  {
    name: "the real path lies inside another worktree",
    setup: (cwd) => {
      const other = join(outsideDir(), "other");
      git(cwd, "worktree", "add", "-q", "-b", "other", other);
      const file = join(other, "declaration.json");
      writeFileSync(file, JSON.stringify(declarationOf("firstmate")));
      setEnv({ AK_LIFECYCLE_SUPERVISOR: "firstmate", AK_LIFECYCLE_SUPERVISOR_DECLARATION: file });
    },
    item: "outside the repository",
  },
  {
    name: "a symlink outside whose target lies inside the checkout",
    setup: (cwd) => {
      writeFileSync(join(cwd, "target.json"), JSON.stringify(declarationOf("firstmate")));
      const link = join(outsideDir(), "declaration.json");
      symlinkSync(join(cwd, "target.json"), link);
      setEnv({ AK_LIFECYCLE_SUPERVISOR: "firstmate", AK_LIFECYCLE_SUPERVISOR_DECLARATION: link });
    },
    item: "outside the repository",
  },
  {
    name: "the contract is wrong",
    setup: () => void declareSupervisor("firstmate", declarationOf("firstmate", { contract: `${CONTRACT}0` })),
    item: "contract",
  },
  {
    name: "the contract is missing",
    setup: () => void declareSupervisor("firstmate", without(declarationOf("firstmate"), "contract")),
    item: "contract",
  },
  {
    name: "the declared supervisor differs from the name in the environment",
    setup: () => void declareSupervisor("firstmate", declarationOf("other-crew")),
    item: "other-crew",
  },
  ...OBLIGATION_KEYS.map((key) => ({
    name: `the obligation ${key} is missing`,
    setup: () => void declareSupervisor("firstmate", withObligation(key, undefined)),
    item: key,
  })),
  {
    name: "an obligation is unknown",
    setup: () => void declareSupervisor("firstmate", withObligation("deploys-for-you", "yes")),
    item: "deploys-for-you",
  },
  {
    name: "a top-level key is unknown",
    setup: () => void declareSupervisor("firstmate", declarationOf("firstmate", { extra: "x" })),
    item: "extra",
  },
  {
    name: "an obligation text is empty",
    setup: () => void declareSupervisor("firstmate", withObligation("disclosure", "")),
    item: "disclosure",
  },
  {
    name: "an obligation text spans lines",
    setup: () => void declareSupervisor("firstmate", withObligation("seat-separation", "one\ntwo")),
    item: "seat-separation",
  },
];

describe("the declaration (AC-2)", () => {
  test.each(REFUSALS)("is refused at the start check when $name", ({ setup, item }) => {
    const cwd = repo();
    setEnv({ AK_LIFECYCLE_POLICY: "unattended" });
    setup(cwd);
    for (const phase of ["super-align", "super-bound", "super-ship"]) {
      const r = ak(cwd, "unattended", "check", "--phase", phase);
      expect(r.code).toBe(1);
      expect(r.err).toContain(item);
      expect(r.out).toBe("");
    }
  });

  test.each(REFUSALS)("is refused at open, or opens an unstamped run, when $name", ({ setup, item, absent }) => {
    const cwd = repo();
    setEnv({ AK_LIFECYCLE_POLICY: "unattended" });
    setup(cwd);
    const opened = ak(cwd, "open", "--ticket", ticketFile(cwd));
    if (absent === true) {
      expect(opened.code).toBe(0);
      expect(opened.err).toContain(
        "note: no supervisor declaration; this run cannot pass ship-preflight under the unattended policy",
      );
      const stored: unknown = JSON.parse(readFileSync(join(store(cwd), "runs", runId(opened.out), "run.json"), "utf8"));
      expect(stored).not.toHaveProperty("supervisor");
    } else {
      expect(opened.code).toBe(1);
      expect(opened.err).toContain(item);
      expect(runsOf(cwd)).toEqual([]);
    }
  });

  test("an unreadable declaration file is refused naming the read", () => {
    if (process.getuid?.() === 0) return;
    const cwd = repo();
    setEnv({ AK_LIFECYCLE_POLICY: "unattended" });
    const file = declareSupervisor();
    chmodSync(file, 0o000);
    try {
      const r = ak(cwd, "unattended", "check", "--phase", "super-ship");
      expect(r.code).toBe(1);
      expect(r.err).toContain("cannot be read");
    } finally {
      chmodSync(file, 0o644);
    }
  });

  test("a project that is not a git repository is refused naming that", () => {
    const dir = outsideDir();
    setEnv({ AK_LIFECYCLE_POLICY: "unattended" });
    declareSupervisor();
    const r = ak(dir, "unattended", "check", "--phase", "super-ship");
    expect(r.code).toBe(1);
    expect(r.err).toContain("not a git repository");
  });

  test("a valid declaration outside a linked worktree passes for the worktree and for the main checkout", () => {
    const cwd = repo();
    setEnv({ AK_LIFECYCLE_POLICY: "unattended" });
    declareSupervisor();
    const linked = join(outsideDir(), "linked");
    git(cwd, "worktree", "add", "-q", "-b", "linked", linked);
    for (const dir of [cwd, linked]) expect(ak(dir, "unattended", "check", "--phase", "super-ship").code).toBe(0);
  });

  test("a declaration is accepted only by its own name: the digest is of the file's raw bytes", () => {
    const cwd = repo();
    setEnv({ AK_LIFECYCLE_POLICY: "unattended" });
    const file = declareSupervisor("firstmate", undefined, `${JSON.stringify(declarationOf("firstmate"))}\n\n`);
    const r = ak(cwd, "unattended", "check", "--phase", "super-ship");
    expect(r.code).toBe(0);
    const digest = sha(readFileSync(file));
    expect(digest).toMatch(DIGEST);
    expect(JSON.parse(r.out)).toMatchObject({ declaration_digest: digest });
  });
});

describe("the start check (AC-3)", () => {
  test("without the policy the human-started phases keep their refusal and the declaration changes nothing", () => {
    const cwd = repo();
    declareSupervisor();
    for (const phase of ["super-align", "super-bound", "super-ship"]) {
      const r = ak(cwd, "unattended", "check", "--phase", phase);
      expect(r.code).toBe(1);
      expect(r.err).toContain("is human-started and needs its typed command or a grant to start");
      expect(r.err).not.toContain("DECLARATION");
    }
  });

  test("the model-started phases start with or without a declaration, naming it only when it is valid", () => {
    const cwd = repo();
    setEnv({ AK_LIFECYCLE_POLICY: "unattended" });
    const phases = ["super-scout", "super-review", "super-verify", "super-build"];
    for (const phase of phases) {
      const bare = ak(cwd, "unattended", "check", "--phase", phase);
      expect(bare.code).toBe(0);
      expect(bare.out).not.toContain("declaration_digest");
    }
    const file = declareSupervisor();
    for (const phase of phases) {
      const r = ak(cwd, "unattended", "check", "--phase", phase);
      expect(r.code).toBe(0);
      expect(JSON.parse(r.out)).toMatchObject({
        supervisor: "firstmate",
        declaration_digest: sha(readFileSync(file)),
        start: "model-started",
      });
    }
    setEnv({ AK_LIFECYCLE_SUPERVISOR_DECLARATION: join(outsideDir(), "missing.json") });
    for (const phase of phases) {
      const r = ak(cwd, "unattended", "check", "--phase", phase);
      expect(r.code).toBe(0);
      expect(r.out).not.toContain("declaration_digest");
      expect(r.out).not.toContain("supervisor");
    }
  });
});

/** An unattended run with every gate recorded, ready for ship-preflight under the declaration `declare` wrote. */
function ready(name = "firstmate") {
  const cwd = repo();
  const file = declareSupervisor(name);
  setEnv({ AK_LIFECYCLE_POLICY: "unattended" });
  const run = fullRun(cwd);
  return { cwd, file, run };
}
const runFiles = (cwd: string, run: string) => {
  const dir = join(store(cwd), run);
  return readdirSync(dir, { recursive: true }).map(String).toSorted();
};

describe("binding at open and ship-preflight (AC-4)", () => {
  test("open stamps the run with the supervisor, the declaration's real path and its digest", () => {
    const cwd = repo();
    setEnv({ AK_LIFECYCLE_POLICY: "unattended" });
    const file = declareSupervisor();
    const opened = ak(cwd, "open", "--ticket", ticketFile(cwd));
    expect(opened.code).toBe(0);
    expect(opened.err).not.toContain("no supervisor declaration");
    const stored: unknown = JSON.parse(readFileSync(join(store(cwd), "runs", runId(opened.out), "run.json"), "utf8"));
    const digest = sha(readFileSync(file));
    expect(digest).toMatch(DIGEST);
    expect(stored).toEqual(
      expect.objectContaining({
        supervisor: {
          name: "firstmate",
          contract: CONTRACT,
          declaration_path: realpathSync(file),
          declaration_digest: digest,
        },
      }),
    );
  });

  test("a legacy run carries no supervisor stamp", () => {
    const cwd = repo();
    declareSupervisor();
    const opened = ak(cwd, "open", "--ticket", ticketFile(cwd));
    expect(opened.code).toBe(0);
    const stored: unknown = JSON.parse(readFileSync(join(store(cwd), "runs", runId(opened.out), "run.json"), "utf8"));
    expect(stored).not.toHaveProperty("supervisor");
  });

  const PREFLIGHT_REFUSALS: [string, (ctx: ReturnType<typeof ready>) => void, string][] = [
    ["no declaration is set", () => setEnv({ AK_LIFECYCLE_SUPERVISOR_DECLARATION: undefined }), "is not set"],
    [
      "the declaration is invalid",
      ({ file }) => writeFileSync(file, `${JSON.stringify(withObligation("disclosure", undefined))}\n`),
      "disclosure",
    ],
    [
      "the declaration's digest differs from the run's stamp",
      ({ file }) => writeFileSync(file, `${JSON.stringify(withObligation("disclosure", "changed text"), null, 1)}\n`),
      "differs from the run's stamp",
    ],
    [
      "the declaration file moved inside the checkout",
      ({ cwd }) => inCheckout(cwd, "declaration.json"),
      "outside the repository",
    ],
  ];

  test.each(PREFLIGHT_REFUSALS)(
    "ship-preflight refuses with exit 1 and writes nothing when %s",
    (_name, change, item) => {
      const ctx = ready();
      const before = {
        files: runFiles(ctx.cwd, ctx.run),
        run: readFileSync(join(store(ctx.cwd), "runs", ctx.run, "run.json"), "utf8"),
      };
      change(ctx);
      const r = ak(ctx.cwd, "record", "--gate", "ship-preflight");
      expect(r.code).toBe(1);
      expect(r.err).toContain(item);
      expect(r.err).toContain(RECOVERY);
      expect(runFiles(ctx.cwd, ctx.run)).toEqual(before.files);
      expect(readFileSync(join(store(ctx.cwd), "runs", ctx.run, "run.json"), "utf8")).toBe(before.run);
      expect(recordsOf(ctx.cwd, ctx.run, "ship-preflight")).toEqual([]);
    },
  );

  test("ship-preflight refuses a run that carries no stamped digest", () => {
    const cwd = repo();
    setEnv({ AK_LIFECYCLE_POLICY: "unattended" });
    const run = fullRun(cwd);
    declareSupervisor();
    const r = ak(cwd, "record", "--gate", "ship-preflight");
    expect(r.code).toBe(1);
    expect(r.err).toContain("carries no supervisor stamp");
    expect(r.err).toContain(RECOVERY);
    expect(recordsOf(cwd, run, "ship-preflight")).toEqual([]);
  });

  test("ship-preflight refuses a counted gate record that names a different supervisor", () => {
    const { cwd, run, file } = ready();
    setEnv({ AK_LIFECYCLE_SUPERVISOR: "other-crew", AK_LIFECYCLE_SUPERVISOR_DECLARATION: undefined });
    expect(ak(cwd, "record", "--gate", "build-checks", "--", ...ok).code).toBe(0);
    setEnv({ AK_LIFECYCLE_SUPERVISOR: "firstmate", AK_LIFECYCLE_SUPERVISOR_DECLARATION: file });
    const r = ak(cwd, "record", "--gate", "ship-preflight");
    expect(r.code).toBe(1);
    expect(r.err).toContain("build-checks");
    expect(r.err).toContain("other-crew");
    expect(r.err).toContain(RECOVERY);
    expect(recordsOf(cwd, run, "ship-preflight")).toEqual([]);
  });

  test("a valid matching declaration records the supervisor entry, closes the run and prints the evidence", () => {
    const { cwd, run, file } = ready();
    const r = ak(cwd, "record", "--gate", "ship-preflight");
    expect(r.code).toBe(0);
    expect(r.out).toContain(`recorded ship-preflight for run ${run} at ${snapshotOf(cwd).revision.slice(0, 12)}`);
    expect(r.out).toContain(unattendedDisclosure("firstmate"));
    expect(r.out).toContain("phase evidence (worker-attested, gate: command -> exit):");
    expect(r.out).toContain("align: sh -c echo ok -> exit 0");
    expect(readdirSync(join(store(cwd), run, "decisions"))).toHaveLength(1);
    expect(readFileSync(join(store(cwd), "runs", run, "run.json"), "utf8")).toContain('"closed_at"');
    const [entry] = recordsOf(cwd, run, "ship-preflight")[0]?.commands ?? [];
    expect(entry?.builtin).toBe("supervisor");
    const stored: unknown = JSON.parse(
      readFileSync(join(store(cwd), run, "artifacts", (entry?.output ?? "").slice(7)), "utf8"),
    );
    expect(stored).toEqual({
      supervisor: "firstmate",
      contract: CONTRACT,
      declaration_path: realpathSync(file),
      declaration_digest: sha(readFileSync(file)),
    });
  });

  test("a run the preflight closed refuses a fresh ship-preflight and keeps its record as it was", () => {
    const { cwd, run } = ready();
    expect(ak(cwd, "record", "--gate", "ship-preflight").code).toBe(0);
    const runJson = join(store(cwd), "runs", run, "run.json");
    const before = { run: readFileSync(runJson, "utf8"), records: recordsOf(cwd, run, "ship-preflight") };
    const again = ak(cwd, "record", "--gate", "ship-preflight");
    expect(again.code).toBe(1);
    expect(again.err).toContain("run closed; open a new run");
    expect(readFileSync(runJson, "utf8")).toBe(before.run);
    expect(recordsOf(cwd, run, "ship-preflight")).toEqual(before.records);
  });
});

interface Shipped {
  cwd: string;
  run: string;
  file: string;
  head: string;
}
/** A run shipped by its preflight on a feature branch with a second commit, so ancestry can fail either way. */
function shipped(): Shipped {
  const cwd = repo();
  git(cwd, "commit", "--allow-empty", "-q", "-m", "second");
  const file = declareSupervisor();
  setEnv({ AK_LIFECYCLE_POLICY: "unattended" });
  const run = fullRun(cwd);
  expect(ak(cwd, "record", "--gate", "ship-preflight").code).toBe(0);
  return { cwd, run, file, head: git(cwd, "rev-parse", "HEAD") };
}
const isObj = (v: Json | undefined): v is JsonObject => Object.prototype.toString.call(v) === "[object Object]";
const REVIEW: JsonObject = {
  result: "approve",
  reviewer: "vendor-b/model-x",
  authors: ["vendor-a/model-y"],
  ref: "review report 12 in the supervisor's store",
};
const attestationOf = (head: string, over: JsonObject = {}): JsonObject => ({
  contract: CONTRACT,
  supervisor: "firstmate",
  head,
  pull_request: "https://example.invalid/acme/widget/pull/7",
  validation: { result: "pass", ref: "validation run 41 on the supervisor's runner" },
  review: REVIEW,
  ...over,
});
const reviewOf = (head: string, over: JsonObject): JsonObject =>
  attestationOf(head, { review: { ...REVIEW, ...over } });
const bodyOf = (name = "firstmate") => `Change.\n\n${unattendedDisclosure(name)}\n`;
/** Writes an attestation and a body outside the repository and returns the two flags. */
function files(value: Json, body: string = bodyOf(), text?: string) {
  const dir = outsideDir();
  const attestation = join(dir, "attestation.json");
  const bodyFile = join(dir, "body.md");
  writeFileSync(attestation, text ?? `${JSON.stringify(value, null, 2)}\n`);
  writeFileSync(bodyFile, body);
  return { attestation, bodyFile, flags: ["--attestation", attestation, "--body-file", bodyFile] };
}
const finalShip = (cwd: string, flags: string[]) => ak(cwd, "record", "--gate", "ship-preflight", ...flags);
const entriesOf = (s: Shipped) =>
  (recordsOf(s.cwd, s.run, "ship-preflight")[0]?.commands ?? []).map((entry) => entry.builtin);
const outputOf = (s: Shipped, index: number): JsonObject => {
  const entry = recordsOf(s.cwd, s.run, "ship-preflight")[0]?.commands?.[index];
  const parsed = parseJson(
    readFileSync(join(store(s.cwd), s.run, "artifacts", (entry?.output ?? "").slice(7)), "utf8"),
  );
  return isObj(parsed) ? parsed : {};
};

describe("final ship (AC-5)", () => {
  test("appends a final-ship entry naming the head, the pull request, both digests and the commits after", () => {
    const s = shipped();
    const record = recordsOf(s.cwd, s.run, "ship-preflight")[0];
    const runJson = join(store(s.cwd), "runs", s.run, "run.json");
    const runBefore = readFileSync(runJson, "utf8");
    git(s.cwd, "commit", "--allow-empty", "-q", "-m", "third commit");
    const head = git(s.cwd, "rev-parse", "HEAD");
    const f = files(attestationOf(head), bodyOf());
    const r = finalShip(s.cwd, f.flags);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(r.out).toContain(head);
    expect(r.out).toContain(`  ${head.slice(0, 12)} third commit`);
    expect(entriesOf(s)).toEqual(["supervisor", "final-ship"]);
    const after = recordsOf(s.cwd, s.run, "ship-preflight")[0];
    expect(after?.snapshot).toEqual(record?.snapshot);
    expect(after?.commands?.[0]).toEqual(record?.commands?.[0]);
    expect(readFileSync(runJson, "utf8")).toBe(runBefore);
    const output = outputOf(s, 1);
    expect(output).toEqual({
      head,
      pull_request: "https://example.invalid/acme/widget/pull/7",
      attestation_path: realpathSync(f.attestation),
      attestation_digest: sha(readFileSync(f.attestation)),
      body_digest: sha(readFileSync(f.bodyFile)),
      commits_after: [{ sha: head, subject: "third commit" }],
    });
    expect(output.attestation_digest).toMatch(DIGEST);
    expect(output.body_digest).toMatch(DIGEST);
  });

  test("a head equal to the shipped revision passes with no commits after, and the pull request is optional", () => {
    const s = shipped();
    const f = files(without(attestationOf(s.head), "pull_request"));
    const r = finalShip(s.cwd, f.flags);
    expect(r.code).toBe(0);
    expect(r.out).toContain("0 commit(s) after the shipped revision");
    const output = outputOf(s, 1);
    expect(output).not.toHaveProperty("pull_request");
    expect(output.commits_after).toEqual([]);
  });

  test("a later valid attestation for a descendant head appends a further entry", () => {
    const s = shipped();
    expect(finalShip(s.cwd, files(attestationOf(s.head)).flags).code).toBe(0);
    git(s.cwd, "commit", "--allow-empty", "-q", "-m", "after review");
    const next = git(s.cwd, "rev-parse", "HEAD");
    const r = finalShip(s.cwd, files(attestationOf(next)).flags);
    expect(r.code).toBe(0);
    expect(entriesOf(s)).toEqual(["supervisor", "final-ship", "final-ship"]);
    expect(outputOf(s, 2).head).toBe(next);
    expect(recordsOf(s.cwd, s.run, "ship-preflight")).toHaveLength(1);
  });

  test("a run with no ship-preflight record refuses, and so does a run whose declaration changed", () => {
    const cwd = repo();
    declareSupervisor();
    setEnv({ AK_LIFECYCLE_POLICY: "unattended" });
    const open = fullRun(cwd);
    const head = git(cwd, "rev-parse", "HEAD");
    const none = finalShip(cwd, files(attestationOf(head)).flags);
    expect(none.code).toBe(1);
    expect(none.err).toContain("ship-preflight");
    expect(recordsOf(cwd, open, "ship-preflight")).toEqual([]);

    const s = shipped();
    writeFileSync(s.file, `${JSON.stringify(withObligation("disclosure", "changed text"), null, 1)}\n`);
    const moved = finalShip(s.cwd, files(attestationOf(s.head)).flags);
    expect(moved.code).toBe(1);
    expect(moved.err).toContain("differs from the run's stamp");
    expect(entriesOf(s)).toEqual(["supervisor"]);
  });

  const MALFORMED_REFUSALS: [string, (head: string) => JsonObject, string][] = [
    ["a wrong contract", (h) => attestationOf(h, { contract: `${CONTRACT}0` }), "contract"],
    ["a supervisor other than the run's", (h) => attestationOf(h, { supervisor: "other-crew" }), "other-crew"],
    ["a head that is not 40 lower-case hex", (h) => attestationOf(h, { head: h.toUpperCase() }), "head"],
    ["a failed validation", (h) => attestationOf(h, { validation: { result: "fail", ref: "r" } }), "validation.result"],
    ["a rejected review", (h) => reviewOf(h, { result: "reject" }), "review.result"],
    ["an unknown top-level key", (h) => attestationOf(h, { merged: true }), "merged"],
    ["an unknown review key", (h) => reviewOf(h, { model: "x" }), "model"],
    ["an empty pull request reference", (h) => attestationOf(h, { pull_request: "" }), "pull_request"],
    ["a multi-line review ref", (h) => reviewOf(h, { ref: "a\nb" }), "review.ref"],
    ["a non-canonical reviewer", (h) => reviewOf(h, { reviewer: " Vendor-B/Model-X" }), " Vendor-B/Model-X"],
    ["a non-canonical author", (h) => reviewOf(h, { authors: ["Vendor-A/Model-Y"] }), "Vendor-A/Model-Y"],
    ["no authors", (h) => reviewOf(h, { authors: [] }), "review.authors"],
    [
      "a reviewer that is also an author",
      (h) => reviewOf(h, { authors: ["vendor-a/model-y", "vendor-b/model-x"] }),
      "vendor-b/model-x",
    ],
  ];

  test.each(MALFORMED_REFUSALS)("refuses %s, naming it, and appends nothing", (_name, make, item) => {
    const s = shipped();
    const r = finalShip(s.cwd, files(make(s.head)).flags);
    expect(r.code).toBe(1);
    expect(r.err).toContain(item);
    expect(entriesOf(s)).toEqual(["supervisor"]);
  });

  test("refuses an attestation that is not JSON or does not exist, naming the file", () => {
    const s = shipped();
    const bad = files(null, bodyOf(), "{not json");
    const notJson = finalShip(s.cwd, bad.flags);
    expect(notJson.code).toBe(1);
    expect(notJson.err).toContain("not valid JSON");
    const gone = finalShip(s.cwd, ["--attestation", join(outsideDir(), "none.json"), "--body-file", bad.bodyFile]);
    expect(gone.code).toBe(1);
    expect(gone.err).toContain("cannot be read");
    expect(entriesOf(s)).toEqual(["supervisor"]);
  });

  test("refuses an attestation inside the checkout, inside the git directory, inside another worktree or behind a symlink", () => {
    const s = shipped();
    const body = files(null).bodyFile;
    const text = `${JSON.stringify(attestationOf(s.head))}\n`;
    const place = (path: string) => {
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, text);
      return path;
    };
    const other = join(outsideDir(), "other");
    git(s.cwd, "worktree", "add", "-q", "-b", "other", other);
    const link = join(outsideDir(), "attestation.json");
    symlinkSync(place(join(s.cwd, "attestation.json")), link);
    for (const path of [
      place(join(s.cwd, "attestation.json")),
      place(join(s.cwd, ".git", "attestation.json")),
      place(join(other, "attestation.json")),
      link,
    ]) {
      const r = finalShip(s.cwd, ["--attestation", path, "--body-file", body]);
      expect(r.code).toBe(1);
      expect(r.err).toContain("outside the repository");
    }
    expect(entriesOf(s)).toEqual(["supervisor"]);
  });

  test("refuses a head the local repository does not have, naming the commit to fetch", () => {
    const s = shipped();
    const missing = "c".repeat(40);
    const r = finalShip(s.cwd, files(attestationOf(missing)).flags);
    expect(r.code).toBe(1);
    expect(r.err).toContain(missing);
    expect(r.err).toContain("fetch");
    expect(entriesOf(s)).toEqual(["supervisor"]);
  });

  test("refuses a head that does not descend from the shipped revision", () => {
    const s = shipped();
    const older = git(s.cwd, "rev-parse", "HEAD~1");
    const sibling = git(s.cwd, "commit-tree", `${s.head}^{tree}`, "-p", older, "-m", "elsewhere");
    for (const head of [older, sibling]) {
      const r = finalShip(s.cwd, files(attestationOf(head)).flags);
      expect(r.code).toBe(1);
      expect(r.err).toContain("does not descend from the shipped revision");
      expect(r.err).toContain(head);
    }
    expect(entriesOf(s)).toEqual(["supervisor"]);
  });

  const SENTENCE = unattendedDisclosure("firstmate");
  const BODY_REFUSALS: [string, string][] = [
    ["the sentence is absent", "Change."],
    ["the sentence is only inside an HTML comment", `<!--\n${SENTENCE}\n-->\n`],
    ["the sentence is only inside a backtick fence", `\`\`\`\n${SENTENCE}\n\`\`\`\n`],
    ["the sentence is only inside a tilde fence", `~~~\n${SENTENCE}\n~~~\n`],
    ["the sentence names a longer supervisor", `Change.\n\n${unattendedDisclosure("firstmate-two")}\n`],
    ["the sentence names another supervisor", `Change.\n\n${unattendedDisclosure("other-crew")}\n`],
    ["the sentence is wrapped across lines", SENTENCE.replace("in place of", "in place\nof")],
    ["the sentence has its spacing changed", SENTENCE.replace("no human", "no  human")],
  ];

  test.each(BODY_REFUSALS)("refuses the body when %s", (_name, body) => {
    const s = shipped();
    const r = finalShip(s.cwd, files(attestationOf(s.head), body).flags);
    expect(r.code).toBe(1);
    expect(r.err).toContain("disclosure");
    expect(entriesOf(s)).toEqual(["supervisor"]);
  });

  test("accepts the sentence after a closed fence, a comment and inside a longer paragraph", () => {
    const s = shipped();
    const body = `<!-- note -->\n\`\`\`\ncode\n\`\`\`\nChange. ${SENTENCE} More text.\n`;
    expect(finalShip(s.cwd, files(attestationOf(s.head), body).flags).code).toBe(0);
  });

  test("a body file that cannot be read refuses naming it", () => {
    const s = shipped();
    const f = files(attestationOf(s.head));
    const r = finalShip(s.cwd, ["--attestation", f.attestation, "--body-file", join(outsideDir(), "none.md")]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("body");
    expect(entriesOf(s)).toEqual(["supervisor"]);
  });

  test("a relative body file is resolved against the working directory of the command", () => {
    const s = shipped();
    const f = files(attestationOf(s.head));
    const relative = join(s.cwd, "body.md");
    writeFileSync(relative, bodyOf());
    expect(finalShip(s.cwd, ["--attestation", f.attestation, "--body-file", "body.md"]).code).toBe(0);
  });

  test("the flags are a usage error alone, without the policy, on another gate, and --pr is unknown", () => {
    const s = shipped();
    const f = files(attestationOf(s.head));
    const ship = ["--gate", "ship-preflight"];
    expect(ak(s.cwd, "record", ...ship, "--attestation", f.attestation).code).toBe(2);
    expect(ak(s.cwd, "record", ...ship, "--body-file", f.bodyFile).code).toBe(2);
    const other = ak(s.cwd, "record", "--gate", "build-checks", ...f.flags, "--", ...ok);
    expect(other.code).toBe(2);
    const pr = ak(s.cwd, "record", ...ship, "--pr", "7");
    expect(pr.code).toBe(2);
    expect(pr.err).toContain("--pr");
    setEnv({ AK_LIFECYCLE_POLICY: undefined });
    const legacy = finalShip(s.cwd, f.flags);
    expect(legacy.code).toBe(2);
    expect(entriesOf(s)).toEqual(["supervisor"]);
  });
});

// ── the forge-free path and the rules the gate keeps (AC-1, AC-6) ───────────

describe("the forge-free path (AC-1)", () => {
  test("a repository with no remote ships end to end with no forge client run", () => {
    const cwd = repo();
    expect(git(cwd, "remote")).toBe("");
    const file = declareSupervisor();
    setEnv({ AK_LIFECYCLE_POLICY: "unattended" });
    for (const phase of ["super-align", "super-bound", "super-ship"]) {
      const r = ak(cwd, "unattended", "check", "--phase", phase);
      expect(r.code).toBe(0);
      expect(JSON.parse(r.out)).toMatchObject({
        phase,
        supervisor: "firstmate",
        declaration_digest: sha(readFileSync(file)),
      });
    }
    const run = fullRun(cwd);
    const pre = ak(cwd, "record", "--gate", "ship-preflight");
    expect(pre.code).toBe(0);
    const head = git(cwd, "rev-parse", "HEAD");
    const dir = outsideDir();
    writeFileSync(
      join(dir, "attestation.json"),
      JSON.stringify({
        contract: CONTRACT,
        supervisor: "firstmate",
        head,
        validation: { result: "pass", ref: "validation run 41" },
        review: { result: "approve", reviewer: "vendor-b/model-x", authors: ["vendor-a/model-y"], ref: "review 12" },
      }),
    );
    writeFileSync(join(dir, "body.md"), `Change.\n\n${unattendedDisclosure("firstmate")}\n`);
    const final = ak(
      cwd,
      "record",
      "--gate",
      "ship-preflight",
      "--attestation",
      join(dir, "attestation.json"),
      "--body-file",
      join(dir, "body.md"),
    );
    expect(final.code).toBe(0);
    expect(recordsOf(cwd, run, "ship-preflight")[0]?.commands?.map((entry) => entry.builtin)).toEqual([
      "supervisor",
      "final-ship",
    ]);
    expect(existsSync(ghLog)).toBe(false);
  }, 180_000);

  test("the forge-side surfaces no longer exist", () => {
    const removed = [
      "READ_TOKEN_ENV",
      "ACTIONS_APP_ID",
      "ghForge",
      "ghAccounts",
      "resolveRepo",
      "checkMergeGate",
      "checkReviewStatus",
      "compareShipped",
      "visibleText",
      "carriesDisclosure",
      "canonicalModel",
      "DISCLOSURE",
      "DISCLOSURE_TAIL",
      "RESIDUAL_ASSUMPTIONS",
    ];
    for (const name of removed) expect(unattended).not.toHaveProperty(name);
    const cwd = repo();
    const gone = ak(cwd, "unattended", "review-status", "--pr", "7");
    expect(gone.code).toBe(2);
    expect(existsSync(join(ROOT, "skills/super-ship/assets/independent-review.yml"))).toBe(false);
    for (const file of ["src/lifecycle/unattended.ts", "src/lifecycle/gate.ts"]) {
      const text = readFileSync(join(ROOT, file), "utf8");
      for (const name of ["AK_UNATTENDED_READ_TOKEN", "ghForge", "review-status", "forgeIo", "gh api"])
        expect(text).not.toContain(name);
    }
  });

  test("the library spawns no process but local git", () => {
    const text = readFileSync(join(ROOT, "src/lifecycle/unattended.ts"), "utf8");
    // One process helper, `exec(command, args)`, and every use of it names git.
    expect(text.match(/\b(?:spawnSync|execFileSync|execSync|spawn)\(/g)).toHaveLength(1);
    const uses = [...text.matchAll(/\bexec\(\s*"([^"]*)"/g)].map((match) => match[1]);
    expect(uses.length).toBeGreaterThan(0);
    for (const command of uses) expect(command).toBe("git");
    expect(text).not.toMatch(/\bfetch\(|node:https?|node:net/);
  });
});

describe("the rules the gate keeps (AC-6)", () => {
  test("evidence binds to the revision and diff it ran at: a change after the gates refuses the check", () => {
    const cwd = repo();
    setEnv({ AK_LIFECYCLE_POLICY: "unattended" });
    fullRun(cwd);
    expect(ak(cwd, "check").code).toBe(0);
    writeFileSync(join(cwd, "src/a.js"), "export const a = 2;\n");
    expect(ak(cwd, "check").code).toBe(1);
  });

  test("the reviewer-author comparison is string distinctness only: a similar identity passes, the same one does not", () => {
    const cwd = repo();
    declareSupervisor();
    setEnv({ AK_LIFECYCLE_POLICY: "unattended" });
    fullRun(cwd);
    expect(ak(cwd, "record", "--gate", "ship-preflight").code).toBe(0);
    const head = git(cwd, "rev-parse", "HEAD");
    const make = (authors: string[]) => {
      const dir = outsideDir();
      writeFileSync(
        join(dir, "a.json"),
        JSON.stringify({
          contract: CONTRACT,
          supervisor: "firstmate",
          head,
          validation: { result: "pass", ref: "v" },
          review: { result: "approve", reviewer: "vendor-b/model-x", authors, ref: "r" },
        }),
      );
      writeFileSync(join(dir, "b.md"), `${unattendedDisclosure("firstmate")}\n`);
      return ["--attestation", join(dir, "a.json"), "--body-file", join(dir, "b.md")];
    };
    const same = ak(cwd, "record", "--gate", "ship-preflight", ...make(["vendor-b/model-x"]));
    expect(same.code).toBe(1);
    const similar = ak(cwd, "record", "--gate", "ship-preflight", ...make(["vendor-b/model-x-latest"]));
    expect(similar.code).toBe(0);
  });
});
