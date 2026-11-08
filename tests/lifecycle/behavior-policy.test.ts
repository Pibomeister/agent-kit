/**
 * BV-T01: real `ak lifecycle open|record|check` against frozen behavior policy snapshots.
 */
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadCatalog } from "../../src/catalog/load.ts";
import { runCli } from "../../src/cli.ts";
import { bind } from "../../src/firstmate/bind.ts";
import { checkRunArtifact } from "../../src/kb/artifacts.ts";
import {
  asJsonObject,
  bindBehaviorPolicy,
  classifyRun,
  parseBehaviorBinding,
  projectHashOf,
  sealBinding,
  RUN_SCHEMA_VERSION,
  type Json,
  type JsonObject,
} from "../../src/lifecycle/behavior-policy.ts";
import { defaultEvidenceDir, openRun, readRecords, takeSnapshot, type Snapshot } from "../../src/lifecycle/gate.ts";
import { persistFrozenRun } from "../../src/lifecycle/persist-run.ts";
import { GATE_FILE, planBundle } from "../../src/packaging/plan.ts";
import { Runner } from "../../src/runner/core.ts";
import { artifactHash, canonicalJson } from "../../src/util/hash.ts";
import { FIXED_NOW, makeBundle, makeDir, makeHome } from "../firstmate/fixture.ts";
import { makeTree } from "../helpers/tree.ts";
import { processScratch } from "../helpers/process-tmp.ts";

setDefaultTimeout(60_000);

const ROOT = join(import.meta.dir, "..", "..");
const HASH = `sha256:${"a".repeat(64)}`;
const evidenceByRun = new Map<string, string>();
const latestEvidenceByCwd = new Map<string, string>();

function storeFor(cwd: string, run?: string): string {
  const byRun = run === undefined ? undefined : evidenceByRun.get(run);
  if (byRun !== undefined) return byRun;
  return latestEvidenceByCwd.get(cwd) ?? defaultEvidenceDir(cwd);
}

function gitEnv(cwd: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@example.invalid",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.invalid",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "maintenance.auto",
    GIT_CONFIG_VALUE_0: "false",
    HOME: cwd,
  };
}

function git(cwd: string, ...args: string[]): string {
  const p = Bun.spawnSync(["git", ...args], { cwd, env: gitEnv(cwd) });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`);
  return p.stdout.toString().trim();
}

function buildRepo(): string {
  const dir = makeTree({ "src/a.js": "export const a = 1;\n" });
  git(dir, "init", "-q", "-b", "main");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  git(dir, "checkout", "-q", "-b", "feature");
  writeFileSync(join(dir, "src/a.js"), "export const a = 2;\n");
  return dir;
}

const REPO_TEMPLATE = buildRepo();

function repo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "ak-bv-policy-")));
  cpSync(REPO_TEMPLATE, dir, { recursive: true });
  return dir;
}

function ak(cwd: string, ...argv: string[]) {
  const boundDir = latestEvidenceByCwd.get(cwd);
  const extra = argv.includes("--dir") || boundDir === undefined ? [] : ["--dir", boundDir];
  const out: string[] = [];
  const err: string[] = [];
  const code = runCli(["lifecycle", ...argv, ...extra], {
    cwd,
    io: { out: (l) => out.push(l), err: (l) => err.push(l) },
  });
  return { code, out, err: err.join("\n") };
}

function parseObject(text: string): JsonObject {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("not json");
  }
  if (!asJsonObject(value)) throw new Error("not a JSON object");
  return value;
}

function isSnapshot(value: Snapshot | string): value is Snapshot {
  return Object(value) === value;
}

function headSnapshot(cwd: string): Snapshot {
  const snapshot = takeSnapshot(cwd);
  if (isSnapshot(snapshot)) return snapshot;
  throw new Error(snapshot);
}

function isText(value: Json | undefined): value is string {
  return Object.prototype.toString.call(value) === "[object String]";
}

function textField(value: Json | undefined): string | undefined {
  return isText(value) ? value : undefined;
}

function writeJson(path: string, doc: JsonObject): void {
  writeFileSync(path, `${JSON.stringify(doc)}\n`);
}

function projectDoc(mode: "off" | "shadow" | "on", id = "example-project"): JsonObject {
  const base = parseObject(readFileSync(join(ROOT, "templates/project.example.json"), "utf8"));
  const identity = asJsonObject(base.identity) ? { ...base.identity, id } : { id };
  return { ...base, identity, review: { behavior: mode } };
}

function projectRecord(cwd: string, mode: "off" | "shadow" | "on", id = "example-project"): string {
  const path = join(cwd, `${id}.project.json`);
  writeJson(path, projectDoc(mode, id));
  return path;
}

interface BoundProject {
  registry: string;
  kb: string;
  project: JsonObject;
}

function attachKb(cwd: string, mode: "off" | "shadow" | "on", id = "example-project"): BoundProject {
  const scratch = processScratch("ak-bv-kb-");
  const kb = join(scratch, "kb");
  mkdirSync(join(kb, "projects", id, "runs"), { recursive: true });
  git(kb, "init", "-q", "-b", "main");
  git(kb, "config", "user.name", "t");
  git(kb, "config", "user.email", "t@example.invalid");
  git(kb, "config", "commit.gpgsign", "false");
  const project = projectDoc(mode, id);
  const hash = artifactHash(project);
  const stored = {
    record: {
      ref: `run:bootstrap/project/${id}`,
      content_hash: hash,
      idempotency_key: hash,
      links: [],
    },
    artifact: project,
  };
  writeFileSync(join(kb, "projects", id, "runs", "artifacts.jsonl"), `${JSON.stringify(stored)}\n`);
  git(kb, "add", "-A");
  git(kb, "commit", "-q", "-m", "project");
  writeFileSync(join(cwd, "ak.kb.yaml"), `backend: local-git\nproject: ${id}\nlocator:\n  knowledgebase: fixture-kb\n`);
  const registry = join(scratch, "registry.json");
  writeJson(registry, { knowledgebases: { "fixture-kb": { path: kb } } });
  return { registry, kb, project };
}

function attachEmptyKb(cwd: string, id = "example-project") {
  const scratch = processScratch("ak-bv-kb-");
  const kb = join(scratch, "kb");
  mkdirSync(join(kb, "projects", id, "runs"), { recursive: true });
  git(kb, "init", "-q", "-b", "main");
  git(kb, "config", "user.name", "t");
  git(kb, "config", "user.email", "t@example.invalid");
  git(kb, "config", "commit.gpgsign", "false");
  writeFileSync(join(kb, "projects", id, "runs", "artifacts.jsonl"), "");
  git(kb, "add", "-A");
  git(kb, "commit", "-q", "-m", "empty");
  writeFileSync(join(cwd, "ak.kb.yaml"), `backend: local-git\nproject: ${id}\nlocator:\n  knowledgebase: fixture-kb\n`);
  const registry = join(scratch, "registry.json");
  writeJson(registry, { knowledgebases: { "fixture-kb": { path: kb } } });
  return { registry };
}

function publishProject(bound: BoundProject, mode: "off" | "shadow" | "on", id = "example-project"): JsonObject {
  const project = projectDoc(mode, id);
  const hash = artifactHash(project);
  const stored = {
    record: {
      ref: `run:bootstrap/project/${id}`,
      content_hash: hash,
      idempotency_key: hash,
      links: [],
    },
    artifact: project,
  };
  const path = join(bound.kb, "projects", id, "runs", "artifacts.jsonl");
  writeFileSync(path, `${readFileSync(path, "utf8")}${JSON.stringify(stored)}\n`);
  git(bound.kb, "add", "-A");
  git(bound.kb, "commit", "-q", "-m", "policy-update");
  return project;
}

function behaviorTicket(cwd: string, id: string, layer: "model" | "implementation" = "implementation"): JsonObject {
  const doc: JsonObject = {
    schema: "ticket",
    schema_version: 1,
    id,
    project: { id: "example-project" },
    acceptance_criteria: [{ id: "AC-1", text: "The behavior is verified.", surface: "none" }],
    verification: [
      {
        id: "project-check",
        check: "Run the project check.",
        kind: "command",
        supports: ["AC-1"],
        behavior: {
          evidence_layer: layer,
          property_ids: ["every-configured-directory-is-read"],
          property_types: { "every-configured-directory-is-read": "safety" },
          contract: { id: "example-behavior-contract-1", schema: "behavior-contract", hash: HASH },
        },
      },
    ],
    approvals: [{ role: "human", approved_at: "2026-09-29T00:00:00Z" }],
  };
  writeJson(join(cwd, `${id}.json`), doc);
  return doc;
}

function plainTicket(cwd: string, id: string): JsonObject {
  const doc: JsonObject = {
    schema: "ticket",
    schema_version: 1,
    id,
    acceptance_criteria: [{ id: "AC-1", text: "The behavior is verified." }],
    verification: [{ id: "project-check", check: "Run the project check.", kind: "command", supports: ["AC-1"] }],
    approvals: [{ role: "human", approved_at: "2026-09-29T00:00:00Z" }],
  };
  writeJson(join(cwd, `${id}.json`), doc);
  return doc;
}

function ticketPath(cwd: string, id: string): string {
  return join(cwd, `${id}.json`);
}

function receipt(cwd: string, run: string, ticket: JsonObject, extra: JsonObject = {}): string {
  const snapshot = headSnapshot(cwd);
  const receiptDir = mkdtempSync(join(tmpdir(), "ak-bv-receipt-"));
  const outputPath = join(receiptDir, "verification-output.log");
  writeFileSync(outputPath, "1 pass, 0 fail\n");
  const outputDigest = `sha256:${createHash("sha256").update(readFileSync(outputPath)).digest("hex")}`;
  const id = `verification-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const ticketId = textField(ticket.id);
  if (ticketId === undefined) throw new Error("ticket has no id");
  const doc: JsonObject = {
    schema: "verification",
    schema_version: 1,
    id,
    project: { id: "demo" },
    run_id: run,
    created_by: { role: "runner" },
    inputs: [],
    source_revision: { repo: snapshot.repo, revision: snapshot.revision, diff_hash: snapshot.diff_hash },
    created_at: "2026-09-29T00:00:00Z",
    status: "passed",
    kind: "command",
    command: { argv: ["bun", "test"] },
    exit_status: 0,
    output_digest: outputDigest,
    artifacts: [{ path: "verification-output.log", digest: outputDigest, kind: "log" }],
    environment: { id: "test", isolated: true, secrets_policy: "none" },
    supports: ["AC-1"],
    check: "project-check",
    ticket: { id: ticketId, schema: "ticket", hash: artifactHash(ticket) },
    ...extra,
  };
  const path = join(receiptDir, `${id}.json`);
  writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`);
  return path;
}

function recordPhases(cwd: string): void {
  const boundDir = latestEvidenceByCwd.get(cwd);
  const extra = boundDir === undefined ? [] : ["--dir", boundDir];
  for (const gate of ["build-checks", "review-full", "review-readiness"] as const) {
    expect(ak(cwd, "record", "--gate", gate, ...extra).code).toBe(0);
  }
}

function runFile(cwd: string, run: string): string {
  return join(storeFor(cwd, run), "runs", run, "run.json");
}

function readRun(cwd: string, run: string): JsonObject {
  return parseObject(readFileSync(runFile(cwd, run), "utf8"));
}

function bindingOf(run: JsonObject) {
  return parseBehaviorBinding(run.behavior);
}

function frozenTicket(run: JsonObject): JsonObject {
  const ticket = asJsonObject(run.ticket) ? run.ticket : undefined;
  const id = ticket === undefined ? undefined : textField(ticket.id);
  const hash = ticket === undefined ? undefined : textField(ticket.hash);
  if (id === undefined || hash === undefined) throw new Error("run has no ticket");
  return { id, schema: "ticket", hash };
}

function opened(cwd: string, ticketFile: string, registry?: string): string {
  if (registry === undefined) {
    const r = ak(cwd, "open", "--ticket", ticketFile);
    expect(r.code, r.err).toBe(0);
    const line = r.out[0];
    const match = line === undefined ? undefined : /^opened run (.+)$/.exec(line);
    const run = match === undefined || match === null ? undefined : match[1];
    if (run === undefined) throw new Error(`open did not return a run id: ${String(line)}`);
    return run;
  }
  const result = openRun({
    dir: defaultEvidenceDir(cwd),
    project: cwd,
    ticket: ticketFile,
    registry,
  });
  expect(result.ok, result.ok ? "" : result.reason).toBe(true);
  if (!result.ok) throw new Error(result.reason);
  return result.run.run_id;
}

function ensureTrustedNoMistakes(cwd: string): void {
  const shown = Bun.spawnSync(["git", "show", "main:.no-mistakes.yaml"], { cwd, env: gitEnv(cwd) });
  if (shown.exitCode === 0) return;
  const branch = git(cwd, "rev-parse", "--abbrev-ref", "HEAD");
  git(cwd, "checkout", "-q", "main");
  writeFileSync(
    join(cwd, ".no-mistakes.yaml"),
    "commands:\n  test: bun test\nauto_fix:\n  test: 0\n  lint: 0\n  ci: 0\n",
  );
  git(cwd, "add", ".no-mistakes.yaml");
  git(cwd, "commit", "-q", "-m", "no-mistakes");
  git(cwd, "checkout", "-q", branch);
}

function openedMandatory(cwd: string, ticketFile: string, bound: BoundProject): string {
  ensureTrustedNoMistakes(cwd);
  const ticket = parseObject(readFileSync(ticketFile, "utf8"));
  const privateDir = realpathSync(mkdtempSync(join(tmpdir(), "ak-bv-runner-")));
  const evidence = join(privateDir, "evidence");
  mkdirSync(evidence);
  const { home, upstream } = makeHome({ patched: true });
  const ledger = makeDir();
  const bindingPath = join(home, "data", "T-BV", "binding.json");
  mkdirSync(join(home, "data", "T-BV"), { recursive: true });
  const boundFm = bind(
    {
      fmHome: home,
      taskId: "T-BV",
      project: cwd,
      mode: "agent-kit",
      bindingOut: bindingPath,
      host: "claude-code",
      evidence: { store: "mock", location: evidence },
    },
    {
      akRoot: ROOT,
      bundleDir: makeBundle(),
      pinsDir: makeDir(),
      ledgerDir: ledger,
      upstream,
      now: FIXED_NOW,
    },
  );
  expect(boundFm.ok, boundFm.errors.join("\n")).toBe(true);
  if (!boundFm.ok || boundFm.binding === undefined) throw new Error(boundFm.errors.join("\n"));
  const runId = boundFm.binding.run_id;
  writeFileSync(join(privateDir, `${textField(ticket.id)}.json`), `${JSON.stringify(ticket)}\n`);
  const charterPath = join(privateDir, "charter.json");
  const initial = {
    schema: "charter",
    schema_version: 1,
    id: "bv-charter",
    run_id: runId,
    project: { id: "example-project", repo: "example" },
    created_by: { role: "human" },
    inputs: [],
    source_revision: null,
    created_at: "2026-10-01T00:00:00Z",
    status: "active",
    immutability: { immutable: true, worker_writable: false, hash: "", location: charterPath },
    work_source: { kind: "ticket", ref: { id: ticket.id, schema: "ticket", hash: artifactHash(ticket) } },
    repos: [{ repo: "example", base_branch: "main", paths: ["src/**"] }],
    artifact_destinations: { kb_root: "example", runs_path: "runs" },
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
    ],
    standing_grants: [{ covers: "autopilot.start", controller: "firstmate" }],
    denied_actions: ["merge", "deploy"],
    sensitive_grants: [],
    checkpoints: ["align-answer", "spec-approval", "build-go", "finding-adjudication", "ship-pr"],
    limits: {
      fix_cycles: 2,
      ci_repair_attempts: 2,
      alignment_questions: 3,
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
  const hash = artifactHash({ ...initial, immutability: { ...initial.immutability, hash: "" } });
  const approval = initial.approvals[0];
  if (approval === undefined) throw new Error("charter approval missing");
  approval.artifact_hash = hash;
  initial.immutability.hash = hash;
  writeFileSync(charterPath, JSON.stringify(initial));
  const previousRegistry = process.env.AK_KB_REGISTRY;
  process.env.AK_KB_REGISTRY = bound.registry;
  try {
    new Runner(privateDir, cwd, ROOT).start(runId, charterPath, "implementer-1", git(cwd, "rev-parse", "HEAD"), {
      charter_hash: hash,
      covers: "autopilot.start",
      controller: "firstmate",
      run_id: runId,
    });
  } finally {
    if (previousRegistry === undefined) delete process.env.AK_KB_REGISTRY;
    else process.env.AK_KB_REGISTRY = previousRegistry;
  }
  const result = openRun({
    dir: evidence,
    project: cwd,
    ticket: ticketFile,
    registry: bound.registry,
    binding: bindingPath,
    ledger,
  });
  expect(result.ok, result.ok ? "" : result.reason).toBe(true);
  if (!result.ok) throw new Error(result.reason);
  evidenceByRun.set(result.run.run_id, evidence);
  latestEvidenceByCwd.set(cwd, evidence);
  return result.run.run_id;
}

function bundledGate(): string {
  const { catalog } = loadCatalog(ROOT);
  if (catalog === null) throw new Error("no catalog");
  const file = planBundle({ root: ROOT, catalog }, "claude-code", {}).files.get(GATE_FILE);
  if (file === undefined) throw new Error("planned gate missing");
  const script = join(mkdtempSync(join(tmpdir(), "ak-bv-gate-")), "ak-gate.mjs");
  writeFileSync(script, file.contents);
  return script;
}

function nodeGate(script: string, cwd: string, registry: string | undefined, ...argv: string[]) {
  const result = Bun.spawnSync(["node", script, ...argv], {
    cwd,
    env: registry === undefined ? gitEnv(cwd) : { ...gitEnv(cwd), AK_KB_REGISTRY: registry },
  });
  return {
    code: result.exitCode,
    out: result.stdout.toString().trim().split("\n"),
    err: result.stderr.toString(),
  };
}

function sourceCli(cwd: string, registry: string | undefined, ...argv: string[]) {
  const result = Bun.spawnSync(["bun", join(ROOT, "src/cli.ts"), "lifecycle", ...argv], {
    cwd,
    env: registry === undefined ? gitEnv(cwd) : { ...gitEnv(cwd), AK_KB_REGISTRY: registry },
  });
  return {
    code: result.exitCode,
    out: result.stdout.toString().trim().split("\n"),
    err: result.stderr.toString(),
  };
}

function openedLine(out: string[]): string {
  const line = out[0];
  const match = line === undefined ? undefined : /^opened run (.+)$/.exec(line);
  const run = match === undefined || match === null ? undefined : match[1];
  if (run === undefined) throw new Error(`open did not return a run id: ${String(line)}`);
  return run;
}

function checkLayer(ticket: JsonObject): string | undefined {
  const verification = Array.isArray(ticket.verification) ? ticket.verification : [];
  const check = asJsonObject(verification[0]) ? verification[0] : undefined;
  const behavior = check !== undefined && asJsonObject(check.behavior) ? check.behavior : undefined;
  return behavior === undefined ? undefined : textField(behavior.evidence_layer);
}

describe("BV-T01 policy binding at open, resume and check", () => {
  test("legacy-shaped records without schema_version stay unclassified as off-feature", () => {
    expect(
      classifyRun({ run_id: "old", ticket: { id: "t", hash: HASH }, opened_at: "t", branch: "b", base: "c" }, "old"),
    ).toEqual({ kind: "legacy" });
  });

  test("an ordinary off open keeps current completion and records mode off", () => {
    const dir = repo();
    const ticket = plainTicket(dir, "plain-off");
    const run = opened(dir, ticketPath(dir, "plain-off"));
    const record = readRun(dir, run);
    expect(record.schema_version).toBe(RUN_SCHEMA_VERSION);
    expect(record.behavior).toMatchObject({ run_id: run, mode: "off", required_checks: [] });
    recordPhases(dir);
    expect(ak(dir, "record", "--gate", "verify", "--receipt", receipt(dir, run, ticket)).code).toBe(0);
    expect(ak(dir, "check").code).toBe(0);
  });

  test("an enabled on open freezes complete check definitions and still accepts a valid witness", () => {
    const dir = repo();
    const ticket = behaviorTicket(dir, "enabled-on");
    const bound = attachKb(dir, "on");
    const run = openedMandatory(dir, ticketPath(dir, "enabled-on"), bound);
    const binding = bindingOf(readRun(dir, run));
    expect(binding?.mode).toBe("on");
    expect(binding?.required_checks).toEqual([
      expect.objectContaining({
        id: "project-check",
        evidence_layer: "implementation",
        property_ids: ["every-configured-directory-is-read"],
        property_types: { "every-configured-directory-is-read": "safety" },
        contract: { id: "example-behavior-contract-1", schema: "behavior-contract", hash: HASH },
        surfaces: { "AC-1": "none" },
      }),
    ]);
    recordPhases(dir);
    expect(ak(dir, "record", "--gate", "verify", "--receipt", receipt(dir, run, ticket)).code).toBe(0);
    const checked = ak(dir, "check", "--json");
    expect(checked.code, checked.err).toBe(0);
    expect(parseObject(checked.out.join("\n")).outcome).toBe("allowed");
  });

  test("resume uses the snapshot after the project file is removed", () => {
    const dir = repo();
    const ticket = behaviorTicket(dir, "kept-on");
    const bound = attachKb(dir, "on");
    const run = openedMandatory(dir, ticketPath(dir, "kept-on"), bound);
    writeFileSync(join(dir, "ak.kb.yaml"), "");
    recordPhases(dir);
    expect(ak(dir, "record", "--gate", "verify", "--receipt", receipt(dir, run, ticket)).code).toBe(0);
    expect(ak(dir, "check").code).toBe(0);
    expect(bindingOf(readRun(dir, run))?.mode).toBe("on");
  });

  test("moving the ticket onto another project cannot turn a required run off", () => {
    const dir = repo();
    const ticket = behaviorTicket(dir, "stay-on");
    const bound = attachKb(dir, "on");
    const run = openedMandatory(dir, ticketPath(dir, "stay-on"), bound);
    const frozen = frozenTicket(readRun(dir, run));
    writeJson(ticketPath(dir, "stay-on"), { ...ticket, project: { id: "other-project" } });
    publishProject(bound, "off");
    expect(bindingOf(readRun(dir, run))?.mode).toBe("on");
    recordPhases(dir);
    expect(ak(dir, "record", "--gate", "verify", "--receipt", receipt(dir, run, ticket, { ticket: frozen })).code).toBe(
      0,
    );
    expect(ak(dir, "check").code).toBe(0);
  });

  test("editing a live check's layer while keeping its id cannot weaken the frozen obligation", () => {
    const dir = repo();
    const ticket = behaviorTicket(dir, "same-id", "implementation");
    const run = openedMandatory(dir, ticketPath(dir, "same-id"), attachKb(dir, "on"));
    const frozen = frozenTicket(readRun(dir, run));
    expect(bindingOf(readRun(dir, run))?.required_checks[0]?.evidence_layer).toBe("implementation");
    const weaker = behaviorTicket(dir, "same-id", "model");
    expect(checkLayer(weaker)).toBe("model");
    expect(bindingOf(readRun(dir, run))?.required_checks[0]?.evidence_layer).toBe("implementation");
    recordPhases(dir);
    expect(ak(dir, "record", "--gate", "verify", "--receipt", receipt(dir, run, ticket, { ticket: frozen })).code).toBe(
      0,
    );
    expect(ak(dir, "check").code).toBe(0);
  });

  test("substituting a weaker ticket under the same id is incomplete, not a weaker obligation", () => {
    const dir = repo();
    const original = behaviorTicket(dir, "swap-id", "implementation");
    const run = openedMandatory(dir, ticketPath(dir, "swap-id"), attachKb(dir, "on"));
    const weaker = behaviorTicket(dir, "swap-id", "model");
    const weakerHash = artifactHash(weaker);
    const runDoc = readRun(dir, run);
    runDoc.ticket = { id: "swap-id", hash: weakerHash };
    writeFileSync(runFile(dir, run), `${JSON.stringify(runDoc, null, 2)}\n`);
    const subject = Object.fromEntries(Object.entries(weaker).filter(([key]) => key !== "approvals"));
    writeFileSync(
      join(storeFor(dir, run), run, "artifacts", weakerHash.slice("sha256:".length)),
      canonicalJson(subject),
    );
    expect(classifyRun(readRun(dir, run), run).kind).toBe("incomplete");
    recordPhases(dir);
    expect(ak(dir, "record", "--gate", "verify", "--receipt", receipt(dir, run, original)).code).toBe(0);
    const checked = ak(dir, "check");
    expect(checked.code).toBe(1);
    expect(checked.err).toContain("behavior snapshot is for ticket");
  });

  test("mutating a frozen check without resealing the binding hash is incomplete", () => {
    const dir = repo();
    const ticket = behaviorTicket(dir, "tamper-check");
    const run = openedMandatory(dir, ticketPath(dir, "tamper-check"), attachKb(dir, "on"));
    const doc = readRun(dir, run);
    const behavior = asJsonObject(doc.behavior) ? doc.behavior : undefined;
    const checks = behavior !== undefined && Array.isArray(behavior.required_checks) ? behavior.required_checks : [];
    const first = asJsonObject(checks[0]) ? checks[0] : undefined;
    if (first === undefined) throw new Error("snapshot has no frozen check");
    first.evidence_layer = "model";
    writeFileSync(runFile(dir, run), `${JSON.stringify(doc, null, 2)}\n`);
    expect(classifyRun(readRun(dir, run), run).kind).toBe("incomplete");
    recordPhases(dir);
    expect(ak(dir, "record", "--gate", "verify", "--receipt", receipt(dir, run, ticket)).code).toBe(0);
    expect(ak(dir, "check").code).toBe(0);
  });

  test("a snapshot copied from another run is a wrong-run refusal", () => {
    const dir = repo();
    const firstTicket = behaviorTicket(dir, "first-run");
    const secondTicket = behaviorTicket(dir, "second-run");
    const bound = attachKb(dir, "on");
    const first = openedMandatory(dir, ticketPath(dir, "first-run"), bound);
    git(dir, "checkout", "-q", "-b", "other");
    const second = openedMandatory(dir, ticketPath(dir, "second-run"), bound);
    const secondDoc = readRun(dir, second);
    const copied = readRun(dir, first).behavior;
    if (copied === undefined) throw new Error("first run has no snapshot");
    secondDoc.behavior = copied;
    writeFileSync(runFile(dir, second), `${JSON.stringify(secondDoc, null, 2)}\n`);
    recordPhases(dir);
    expect(ak(dir, "record", "--gate", "verify", "--receipt", receipt(dir, second, secondTicket)).code).toBe(0);
    const checked = ak(dir, "check");
    expect(checked.code, checked.err).toBe(0);
    expect(classifyRun(readRun(dir, second), second).kind).toBe("incomplete");
    expect(firstTicket.schema).toBe("ticket");
  });

  test("a new enabled run missing its snapshot is incomplete, not legacy", () => {
    const dir = repo();
    const ticket = behaviorTicket(dir, "stripped");
    const run = openedMandatory(dir, ticketPath(dir, "stripped"), attachKb(dir, "on"));
    const doc = readRun(dir, run);
    delete doc.behavior;
    writeFileSync(runFile(dir, run), `${JSON.stringify(doc, null, 2)}\n`);
    recordPhases(dir);
    expect(ak(dir, "record", "--gate", "verify", "--receipt", receipt(dir, run, ticket)).code).toBe(0);
    const checked = ak(dir, "check");
    expect(checked.code, checked.err).toBe(0);
    expect(checked.err).not.toContain("legacy");
    expect(classifyRun(readRun(dir, run), run, ticket).kind).toBe("incomplete");
  });

  test("stripping schema_version and behavior and replacing the ticket is incomplete, not legacy", () => {
    const dir = repo();
    const original = behaviorTicket(dir, "strip-replace");
    const run = openedMandatory(dir, ticketPath(dir, "strip-replace"), attachKb(dir, "on"));
    const plain = plainTicket(dir, "strip-replace");
    const subject = Object.fromEntries(Object.entries(plain).filter(([key]) => key !== "approvals"));
    const hash = artifactHash(plain);
    writeFileSync(join(storeFor(dir, run), run, "artifacts", hash.slice("sha256:".length)), canonicalJson(subject));
    const doc = readRun(dir, run);
    delete doc.behavior;
    delete doc.schema_version;
    doc.ticket = { id: "strip-replace", hash };
    writeFileSync(runFile(dir, run), `${JSON.stringify(doc, null, 2)}\n`);
    expect(classifyRun(readRun(dir, run), run, original).kind).toBe("incomplete");
    recordPhases(dir);
    expect(ak(dir, "record", "--gate", "verify", "--receipt", receipt(dir, run, plain)).code).toBe(0);
    const checked = ak(dir, "check");
    expect(checked.code).toBe(1);
    expect(checked.err).toContain("behavior snapshot is for ticket");
    expect(checked.err).not.toContain("legacy");
    expect(original.schema).toBe("ticket");
  });

  test("resealing a weakened binding and replacing the ticket is incomplete", () => {
    const dir = repo();
    const original = behaviorTicket(dir, "reseal");
    const run = openedMandatory(dir, ticketPath(dir, "reseal"), attachKb(dir, "on"));
    const plain = plainTicket(dir, "reseal");
    const subject = Object.fromEntries(Object.entries(plain).filter(([key]) => key !== "approvals"));
    const hash = artifactHash(plain);
    writeFileSync(join(storeFor(dir, run), run, "artifacts", hash.slice("sha256:".length)), canonicalJson(subject));
    const weakened = sealBinding({
      run_id: run,
      ticket_hash: hash,
      mode: "off",
      policy_id: null,
      policy_hash: null,
      required_checks: [],
      captured_at: "2026-09-29T00:00:00Z",
    });
    const sealed: unknown = JSON.parse(JSON.stringify(weakened));
    if (!asJsonObject(sealed)) throw new Error("resealed binding is not an object");
    const doc = readRun(dir, run);
    doc.behavior = sealed;
    doc.ticket = { id: "reseal", hash };
    writeFileSync(runFile(dir, run), `${JSON.stringify(doc, null, 2)}\n`);
    recordPhases(dir);
    expect(ak(dir, "record", "--gate", "verify", "--receipt", receipt(dir, run, plain)).code).toBe(0);
    const checked = ak(dir, "check");
    expect(checked.code).toBe(1);
    expect(checked.err).toMatch(/mandatory behavior checks|behavior snapshot is for ticket/);
    expect(original.schema).toBe("ticket");
  });

  test("stripping schema_version and behavior from a new enabled run is incomplete, not legacy", () => {
    const dir = repo();
    const ticket = behaviorTicket(dir, "strip-both");
    const run = openedMandatory(dir, ticketPath(dir, "strip-both"), attachKb(dir, "on"));
    const doc = readRun(dir, run);
    delete doc.behavior;
    delete doc.schema_version;
    writeFileSync(runFile(dir, run), `${JSON.stringify(doc, null, 2)}\n`);
    expect(classifyRun(readRun(dir, run), run, ticket).kind).toBe("incomplete");
    recordPhases(dir);
    expect(ak(dir, "record", "--gate", "verify", "--receipt", receipt(dir, run, ticket)).code).toBe(0);
    const checked = ak(dir, "check");
    expect(checked.code, checked.err).toBe(0);
    expect(checked.err).not.toContain("legacy");
  });

  test("a worker legacy flag does not downgrade an enabled snapshot", () => {
    const dir = repo();
    const ticket = behaviorTicket(dir, "no-legacy");
    const run = openedMandatory(dir, ticketPath(dir, "no-legacy"), attachKb(dir, "on"));
    const doc = readRun(dir, run);
    const behavior = asJsonObject(doc.behavior) ? doc.behavior : undefined;
    if (behavior === undefined) throw new Error("enabled run has no snapshot");
    behavior.legacy = true;
    writeFileSync(runFile(dir, run), `${JSON.stringify(doc, null, 2)}\n`);
    expect(bindingOf(readRun(dir, run))?.mode).toBe("on");
    recordPhases(dir);
    expect(ak(dir, "record", "--gate", "verify", "--receipt", receipt(dir, run, ticket)).code).toBe(0);
    expect(ak(dir, "check").code).toBe(0);
  });

  test("missing project record cannot open an enabled ticket as off", () => {
    const dir = repo();
    behaviorTicket(dir, "need-project");
    const r = ak(dir, "open", "--ticket", ticketPath(dir, "need-project"));
    expect(r.code).toBe(1);
    expect(r.err).toContain("authoritative project record");
    expect(r.err).toContain("cannot turn this run off");
  });

  test("off plus mandatory behavior checks is a configuration conflict", () => {
    const dir = repo();
    behaviorTicket(dir, "conflict-off");
    const bound = attachKb(dir, "off");
    const r = openRun({
      dir: defaultEvidenceDir(dir),
      project: dir,
      ticket: ticketPath(dir, "conflict-off"),
      registry: bound.registry,
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected conflict");
    expect(r.reason).toContain("cannot cancel those checks");
  });

  test("shadow plus mandatory behavior checks is a configuration conflict", () => {
    const dir = repo();
    behaviorTicket(dir, "conflict-shadow");
    const bound = attachKb(dir, "shadow");
    const r = openRun({
      dir: defaultEvidenceDir(dir),
      project: dir,
      ticket: ticketPath(dir, "conflict-shadow"),
      registry: bound.registry,
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected conflict");
    expect(r.reason).toContain("authorized resolution path");
  });

  test("shadow mode retains current completion and a shadow receipt cannot satisfy a missing check", () => {
    const dir = repo();
    const ticket = plainTicket(dir, "shadow-plain");
    const run = opened(dir, ticketPath(dir, "shadow-plain"), attachKb(dir, "shadow").registry);
    expect(bindingOf(readRun(dir, run))?.mode).toBe("shadow");
    recordPhases(dir);
    const shadowOnly = receipt(dir, run, ticket, { behavior: { mode: "shadow", gate_eligible: false } });
    expect(ak(dir, "record", "--gate", "verify", "--receipt", shadowOnly, "--retain-only").code).toBe(0);
    const recorded = readRecords(defaultEvidenceDir(dir), run, "verify");
    expect(recorded.flatMap((row) => row.evidence ?? []).map((ref) => ref.id)).not.toContain(
      parseObject(readFileSync(shadowOnly, "utf8")).id,
    );
    const missing = ak(dir, "check");
    expect(missing.code).toBe(1);
    expect(missing.err).toContain("no passed evidence");
    expect(ak(dir, "record", "--gate", "verify", "--receipt", receipt(dir, run, ticket)).code).toBe(0);
    const allowed = ak(dir, "check");
    expect(allowed.code).toBe(0);
  });

  test("shadow pass, fail and incomplete stay retained and do not change an allowed gate", () => {
    const dir = repo();
    const ticket = plainTicket(dir, "shadow-keep");
    const run = opened(dir, ticketPath(dir, "shadow-keep"), attachKb(dir, "shadow").registry);
    recordPhases(dir);
    expect(ak(dir, "record", "--gate", "verify", "--receipt", receipt(dir, run, ticket)).code).toBe(0);
    expect(ak(dir, "check").code).toBe(0);
    const shadowPass = receipt(dir, run, ticket, { behavior: { mode: "shadow", gate_eligible: false } });
    const shadowFail = receipt(dir, run, ticket, {
      status: "failed",
      exit_status: 1,
      behavior: { mode: "shadow", gate_eligible: false },
    });
    const shadowIncomplete = receipt(dir, run, ticket, {
      status: "inconclusive",
      behavior: { mode: "shadow", gate_eligible: false },
    });
    expect(ak(dir, "record", "--gate", "verify", "--receipt", shadowPass, "--retain-only").code).toBe(0);
    expect(ak(dir, "record", "--gate", "verify", "--receipt", shadowFail, "--retain-only").code).toBe(0);
    expect(ak(dir, "record", "--gate", "verify", "--receipt", shadowIncomplete, "--retain-only").code).toBe(0);
    const ids = [shadowPass, shadowFail, shadowIncomplete].map((path) => parseObject(readFileSync(path, "utf8")).id);
    const refs = readRecords(defaultEvidenceDir(dir), run, "verify").flatMap((row) => row.evidence ?? []);
    expect(refs.map((ref) => ref.id).filter((id) => ids.includes(id))).toEqual([]);
    const allowed = ak(dir, "check");
    expect(allowed.code, allowed.err).toBe(0);
  });

  test("a shadow marker cannot hide a failed receipt from gate accounting", () => {
    const dir = repo();
    const ticket = plainTicket(dir, "shadow-fail");
    const run = opened(dir, ticketPath(dir, "shadow-fail"), attachKb(dir, "shadow").registry);
    recordPhases(dir);
    const failed = receipt(dir, run, ticket, { status: "failed", exit_status: 1 });
    expect(ak(dir, "record", "--gate", "verify", "--receipt", failed).code).toBe(0);
    const failedId = textField(parseObject(readFileSync(failed, "utf8")).id);
    if (failedId === undefined) throw new Error("failed receipt has no id");
    expect(
      readRecords(defaultEvidenceDir(dir), run, "verify")
        .flatMap((row) => row.evidence ?? [])
        .map((ref) => ref.id),
    ).toContain(failedId);
    const before = ak(dir, "check");
    expect(before.code).toBe(1);
    expect(before.err).toContain("failed evidence");
    const shadowPass = receipt(dir, run, ticket, { behavior: { mode: "shadow", gate_eligible: false } });
    expect(ak(dir, "record", "--gate", "verify", "--receipt", shadowPass, "--retain-only").code).toBe(0);
    const after = ak(dir, "check");
    expect(after.code).toBe(1);
    expect(after.err).toContain("failed evidence");
    expect(
      readRecords(defaultEvidenceDir(dir), run, "verify")
        .flatMap((row) => row.evidence ?? [])
        .map((ref) => ref.id),
    ).toContain(failedId);
  });

  test("an authorized new run invalidates old evidence at the gate", () => {
    const dir = repo();
    const firstTicket = behaviorTicket(dir, "policy-v1");
    const bound = attachKb(dir, "on");
    const first = openedMandatory(dir, ticketPath(dir, "policy-v1"), bound);
    const firstHash = bindingOf(readRun(dir, first))?.binding_hash;
    recordPhases(dir);
    const firstReceipt = receipt(dir, first, firstTicket);
    expect(ak(dir, "record", "--gate", "verify", "--receipt", firstReceipt).code).toBe(0);
    const firstCheck = ak(dir, "check", "--json");
    expect(firstCheck.code, firstCheck.err).toBe(0);
    expect(parseObject(firstCheck.out.join("\n")).outcome).toBe("allowed");
    git(dir, "checkout", "-q", "-b", "policy-update");
    publishProject(bound, "on");
    const secondTicket = behaviorTicket(dir, "policy-v2", "model");
    const second = openedMandatory(dir, ticketPath(dir, "policy-v2"), bound);
    expect(bindingOf(readRun(dir, first))?.mode).toBe("on");
    expect(bindingOf(readRun(dir, first))?.binding_hash).toBe(firstHash);
    expect(bindingOf(readRun(dir, second))?.required_checks[0]?.evidence_layer).toBe("model");
    recordPhases(dir);
    expect(ak(dir, "record", "--gate", "verify", "--receipt", firstReceipt).code).toBe(0);
    const stale = ak(dir, "check");
    expect(stale.code).toBe(1);
    expect(stale.err).toMatch(/wrong-run|wrong-task|no passed evidence/);
    const fresh = receipt(dir, second, secondTicket);
    expect(ak(dir, "record", "--gate", "verify", "--receipt", fresh).code).toBe(0);
    const current = ak(dir, "check", "--json");
    expect(current.code, current.err).toBe(0);
    expect(parseObject(current.out.join("\n")).outcome).toBe("allowed");
    expect(bindingOf(readRun(dir, first))?.binding_hash).toBe(firstHash);
    const firstReceiptId = textField(parseObject(readFileSync(firstReceipt, "utf8")).id);
    if (firstReceiptId === undefined) throw new Error("first receipt has no id");
    expect(
      readRecords(storeFor(dir, first), first, "verify")
        .flatMap((row) => row.evidence ?? [])
        .map((ref) => ref.id),
    ).toContain(firstReceiptId);
  });

  test("an unreadable project record named at open fails closed", () => {
    const dir = repo();
    plainTicket(dir, "bad-project");
    const r = ak(
      dir,
      "open",
      "--ticket",
      ticketPath(dir, "bad-project"),
      "--project-record",
      join(dir, "missing.json"),
    );
    expect(r.code).toBe(1);
    expect(r.err).toContain("cannot read project record");
  });

  test("a caller-supplied project file is not authority on an unbound checkout", () => {
    const dir = repo();
    behaviorTicket(dir, "caller-file");
    const r = ak(dir, "open", "--ticket", ticketPath(dir, "caller-file"), "--project-record", projectRecord(dir, "on"));
    expect(r.code).toBe(1);
    expect(r.err).toContain("not the authoritative KB or runner binding");
  });

  test("a substitute project file with a matching identity is refused", () => {
    const dir = repo();
    behaviorTicket(dir, "substitute");
    const bound = attachKb(dir, "on");
    const substitute = projectRecord(dir, "off");
    const r = openRun({
      dir: defaultEvidenceDir(dir),
      project: dir,
      ticket: ticketPath(dir, "substitute"),
      registry: bound.registry,
      projectRecord: substitute,
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected substitute refusal");
    expect(r.reason).toContain("does not match the authoritative binding");
  });

  test("an ordinary ticket on an enabled bound project freezes on without mandatory checks", () => {
    const dir = repo();
    const ticket = plainTicket(dir, "plain-on");
    const run = opened(dir, ticketPath(dir, "plain-on"), attachKb(dir, "on").registry);
    expect(bindingOf(readRun(dir, run))?.mode).toBe("on");
    expect(bindingOf(readRun(dir, run))?.required_checks).toEqual([]);
    recordPhases(dir);
    expect(ak(dir, "record", "--gate", "verify", "--receipt", receipt(dir, run, ticket)).code).toBe(0);
    expect(ak(dir, "check").code).toBe(0);
  });

  test("source CLI and bundled gate share the freeze matrix", () => {
    const script = bundledGate();
    const dir = repo();
    const bound = attachKb(dir, "on");
    behaviorTicket(dir, "src-on");
    const sourceOpen = sourceCli(dir, bound.registry, "open", "--ticket", ticketPath(dir, "src-on"));
    expect(sourceOpen.code).toBe(1);
    expect(sourceOpen.err).toContain("protected runner creation record");
    plainTicket(dir, "src-on-plain");
    const sourcePlain = sourceCli(dir, bound.registry, "open", "--ticket", ticketPath(dir, "src-on-plain"));
    expect(sourcePlain.code, sourcePlain.err).toBe(0);
    const sourceRun = openedLine(sourcePlain.out);
    expect(bindingOf(readRun(dir, sourceRun))?.mode).toBe("on");
    recordPhases(dir);
    const srcReceipt = receipt(dir, sourceRun, parseObject(readFileSync(ticketPath(dir, "src-on-plain"), "utf8")));
    expect(sourceCli(dir, bound.registry, "record", "--gate", "verify", "--receipt", srcReceipt).code).toBe(0);
    expect(sourceCli(dir, bound.registry, "check").code).toBe(0);

    git(dir, "checkout", "-q", "-b", "bundled-on");
    behaviorTicket(dir, "bundled-on");
    const bundledOpen = nodeGate(script, dir, bound.registry, "open", "--ticket", ticketPath(dir, "bundled-on"));
    expect(bundledOpen.code).toBe(1);
    expect(bundledOpen.err).toContain("protected runner creation record");
    plainTicket(dir, "bundled-on-plain");
    const bundledPlain = nodeGate(script, dir, bound.registry, "open", "--ticket", ticketPath(dir, "bundled-on-plain"));
    expect(bundledPlain.code, bundledPlain.err).toBe(0);
    const bundledRun = openedLine(bundledPlain.out);
    expect(bindingOf(readRun(dir, bundledRun))?.mode).toBe("on");

    const missing = repo();
    behaviorTicket(missing, "need-project");
    const sourceMissing = sourceCli(missing, undefined, "open", "--ticket", ticketPath(missing, "need-project"));
    expect(sourceMissing.code).toBe(1);
    expect(sourceMissing.err).toContain("authoritative project record");
    const bundledMissing = nodeGate(
      script,
      missing,
      undefined,
      "open",
      "--ticket",
      ticketPath(missing, "need-project"),
    );
    expect(bundledMissing.code).toBe(1);
    expect(bundledMissing.err).toContain("authoritative project record");

    const offDir = repo();
    plainTicket(offDir, "src-off");
    const sourceOff = sourceCli(offDir, undefined, "open", "--ticket", ticketPath(offDir, "src-off"));
    expect(sourceOff.code, sourceOff.err).toBe(0);
    expect(bindingOf(readRun(offDir, openedLine(sourceOff.out)))?.mode).toBe("off");
    const bundledOffDir = repo();
    plainTicket(bundledOffDir, "bundled-off");
    const bundledOff = nodeGate(
      script,
      bundledOffDir,
      undefined,
      "open",
      "--ticket",
      ticketPath(bundledOffDir, "bundled-off"),
    );
    expect(bundledOff.code, bundledOff.err).toBe(0);
    expect(bindingOf(readRun(bundledOffDir, openedLine(bundledOff.out)))?.mode).toBe("off");

    const conflict = repo();
    behaviorTicket(conflict, "conflict-off");
    const conflictKb = attachKb(conflict, "off");
    const sourceConflict = sourceCli(
      conflict,
      conflictKb.registry,
      "open",
      "--ticket",
      ticketPath(conflict, "conflict-off"),
    );
    expect(sourceConflict.code).toBe(1);
    expect(sourceConflict.err).toContain("cannot cancel those checks");
    const bundledConflict = nodeGate(
      script,
      conflict,
      conflictKb.registry,
      "open",
      "--ticket",
      ticketPath(conflict, "conflict-off"),
    );
    expect(bundledConflict.code).toBe(1);
    expect(bundledConflict.err).toContain("cannot cancel those checks");
  });

  test("a runner-persisted enabled run missing its snapshot is incomplete, not legacy", () => {
    const dir = repo();
    const ticket = behaviorTicket(dir, "runner-strip");
    const bound = attachKb(dir, "on");
    const frozen = bindBehaviorPolicy({
      runId: "toy-run",
      ticket,
      ticketHash: artifactHash(ticket),
      project: bound.project,
      projectHash: projectHashOf(bound.project),
      lookup: "resolved",
      capturedAt: "2026-09-29T00:00:00Z",
    });
    if (!frozen.ok) throw new Error(frozen.reason);
    const bytes = new TextEncoder().encode(
      canonicalJson(Object.fromEntries(Object.entries(ticket).filter(([key]) => key !== "approvals"))),
    );
    persistFrozenRun(
      defaultEvidenceDir(dir),
      {
        run_id: "toy-run",
        ticket: { id: "runner-strip", hash: artifactHash(ticket) },
        opened_at: "2026-09-29T00:00:00Z",
        branch: "feature",
        base: "c",
        schema_version: RUN_SCHEMA_VERSION,
        behavior: frozen.binding,
      },
      bytes,
    );
    const doc = readRun(dir, "toy-run");
    delete doc.behavior;
    delete doc.schema_version;
    writeFileSync(runFile(dir, "toy-run"), `${JSON.stringify(doc, null, 2)}\n`);
    for (const gate of ["build-checks", "review-full", "review-readiness"] as const) {
      expect(ak(dir, "record", "--gate", gate, "--run", "toy-run").code).toBe(0);
    }
    expect(
      ak(dir, "record", "--gate", "verify", "--run", "toy-run", "--receipt", receipt(dir, "toy-run", ticket)).code,
    ).toBe(0);
    const checked = ak(dir, "check", "--run", "toy-run");
    expect(checked.code).toBe(1);
    expect(checked.err).toContain("new enabled run");
    expect(checked.err).not.toContain("legacy");
  });

  test("standalone mandatory open refuses without a protected runner creation record", () => {
    const dir = repo();
    behaviorTicket(dir, "standalone-on");
    const bound = attachKb(dir, "on");
    const r = openRun({
      dir: defaultEvidenceDir(dir),
      project: dir,
      ticket: ticketPath(dir, "standalone-on"),
      registry: bound.registry,
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected standalone refusal");
    expect(r.reason).toContain("protected runner creation record");
  });

  test("deleting the original ticket and substituting a plain one is incomplete, not legacy", () => {
    const dir = repo();
    const original = behaviorTicket(dir, "strip-delete");
    const run = openedMandatory(dir, ticketPath(dir, "strip-delete"), attachKb(dir, "on"));
    const originalHash = textField(frozenTicket(readRun(dir, run)).hash);
    if (originalHash === undefined) throw new Error("ticket hash missing");
    const originalPath = join(storeFor(dir, run), run, "artifacts", originalHash.slice("sha256:".length));
    if (existsSync(originalPath)) unlinkSync(originalPath);
    const plain = plainTicket(dir, "strip-delete");
    const subject = Object.fromEntries(Object.entries(plain).filter(([key]) => key !== "approvals"));
    const hash = artifactHash(plain);
    writeFileSync(join(storeFor(dir, run), run, "artifacts", hash.slice("sha256:".length)), canonicalJson(subject));
    const doc = readRun(dir, run);
    delete doc.behavior;
    delete doc.schema_version;
    doc.ticket = { id: "strip-delete", hash };
    writeFileSync(runFile(dir, run), `${JSON.stringify(doc, null, 2)}\n`);
    recordPhases(dir);
    expect(ak(dir, "record", "--gate", "verify", "--receipt", receipt(dir, run, plain)).code).toBe(0);
    const checked = ak(dir, "check");
    expect(checked.code).toBe(1);
    expect(checked.err).toContain("behavior snapshot is for ticket");
    expect(checked.err).not.toContain("legacy");
    expect(original.schema).toBe("ticket");
  });

  test("a forged shadow marker on the first ordinary failure stays in gate refs", () => {
    const dir = repo();
    const ticket = plainTicket(dir, "shadow-forge");
    const run = opened(dir, ticketPath(dir, "shadow-forge"), attachKb(dir, "shadow").registry);
    recordPhases(dir);
    const failed = receipt(dir, run, ticket, {
      status: "failed",
      exit_status: 1,
      behavior: { mode: "shadow", gate_eligible: false },
    });
    expect(ak(dir, "record", "--gate", "verify", "--receipt", failed).code).toBe(0);
    const failedId = textField(parseObject(readFileSync(failed, "utf8")).id);
    if (failedId === undefined) throw new Error("failed receipt has no id");
    expect(
      readRecords(defaultEvidenceDir(dir), run, "verify")
        .flatMap((row) => row.evidence ?? [])
        .map((ref) => ref.id),
    ).toContain(failedId);
    const checked = ak(dir, "check");
    expect(checked.code).toBe(1);
    expect(checked.err).toContain("failed evidence");
  });

  test("opening from a nested cwd resolves the root project binding", () => {
    const dir = repo();
    const nested = join(dir, "src");
    mkdirSync(nested, { recursive: true });
    const ticket = plainTicket(dir, "nested-open");
    const bound = attachKb(dir, "on");
    const nestedOpen = openRun({
      dir: defaultEvidenceDir(dir),
      project: nested,
      ticket: ticketPath(dir, "nested-open"),
      registry: bound.registry,
    });
    expect(nestedOpen.ok, nestedOpen.ok ? "" : nestedOpen.reason).toBe(true);
    if (!nestedOpen.ok) throw new Error(nestedOpen.reason);
    expect(nestedOpen.run.behavior?.mode).toBe("on");
    expect(ticket.schema).toBe("ticket");
  });

  test("checkRunArtifact refuses proposed-only and unknown-requirement contracts", () => {
    const example = parseObject(readFileSync(join(ROOT, "templates/behavior-contract.example.json"), "utf8"));
    const ticket = parseObject(readFileSync(join(ROOT, "templates/ticket.example.json"), "utf8"));
    const lookup = (id: string) =>
      id === "example-ticket-1" ? { schema: "ticket" as const, id, doc: ticket } : undefined;
    expect(checkRunArtifact(JSON.stringify(example)).problem).toContain("not resolved at admission");
    expect(checkRunArtifact(JSON.stringify(example), lookup).problem).toBe("");
    const proposed = {
      ...example,
      properties: [
        {
          id: "retry-is-required",
          statement: "Retries twice.",
          kind: "safety",
          requirement_ids: ["retry-twice"],
        },
      ],
    };
    expect(checkRunArtifact(JSON.stringify(proposed), lookup).problem).toContain(
      "behavior-contract.proposed-intent-cannot-discharge-accepted",
    );
    const missing = {
      ...example,
      properties: [
        {
          id: "ghost-property",
          statement: "Cites a requirement this contract does not carry.",
          kind: "safety",
          requirement_ids: ["not-a-requirement"],
        },
      ],
    };
    expect(checkRunArtifact(JSON.stringify(missing), lookup).problem).toContain("not on this contract");
  });

  test("a forged parent with only id and behavior is not a runner creation record", () => {
    const dir = repo();
    behaviorTicket(dir, "forged-parent");
    const bound = attachKb(dir, "on");
    const parentDir = mkdtempSync(join(tmpdir(), "ak-bv-forged-"));
    const evidence = join(parentDir, "evidence");
    mkdirSync(evidence);
    const frozen = bindBehaviorPolicy({
      runId: "parent-run",
      ticket: parseObject(readFileSync(ticketPath(dir, "forged-parent"), "utf8")),
      ticketHash: HASH,
      project: bound.project,
      projectHash: projectHashOf(bound.project),
      lookup: "resolved",
      capturedAt: "2026-09-29T00:00:00Z",
    });
    if (!frozen.ok) throw new Error(frozen.reason);
    writeFileSync(
      join(parentDir, "parent-run.json"),
      `${JSON.stringify({ id: "parent-run", behavior: frozen.binding })}\n`,
    );
    const bindingPath = join(parentDir, "binding.json");
    writeJson(bindingPath, { schema: "firstmate-binding", run_id: "parent-run", evidence: { location: evidence } });
    const r = openRun({
      dir: evidence,
      project: dir,
      ticket: ticketPath(dir, "forged-parent"),
      registry: bound.registry,
      binding: bindingPath,
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected forged parent refusal");
    expect(r.reason).toContain("protected runner creation record");
  });

  test("dropping pointers and resealing off on a runner evidence store stays incomplete", () => {
    const dir = repo();
    const original = behaviorTicket(dir, "drop-pointers");
    const run = openedMandatory(dir, ticketPath(dir, "drop-pointers"), attachKb(dir, "on"));
    const plain = plainTicket(dir, "drop-pointers");
    const subject = Object.fromEntries(Object.entries(plain).filter(([key]) => key !== "approvals"));
    const hash = artifactHash(plain);
    writeFileSync(join(storeFor(dir, run), run, "artifacts", hash.slice("sha256:".length)), canonicalJson(subject));
    const doc = readRun(dir, run);
    delete doc.binding_run_id;
    delete doc.binding_evidence_location;
    delete doc.behavior;
    delete doc.schema_version;
    doc.ticket = { id: "drop-pointers", hash };
    writeFileSync(runFile(dir, run), `${JSON.stringify(doc, null, 2)}\n`);
    recordPhases(dir);
    expect(ak(dir, "record", "--gate", "verify", "--receipt", receipt(dir, run, plain)).code).toBe(0);
    const checked = ak(dir, "check");
    expect(checked.code).toBe(1);
    expect(checked.err).toMatch(/protected runner creation record|new enabled run/);
    expect(original.schema).toBe("ticket");
  });

  test("a pre-feature run without schema_version stays legacy at check", () => {
    const dir = repo();
    const ticket = plainTicket(dir, "pre-feature");
    const run = opened(dir, ticketPath(dir, "pre-feature"));
    const doc = readRun(dir, run);
    delete doc.behavior;
    delete doc.schema_version;
    writeFileSync(runFile(dir, run), `${JSON.stringify(doc, null, 2)}\n`);
    expect(classifyRun(readRun(dir, run), run, ticket).kind).toBe("legacy");
    recordPhases(dir);
    expect(ak(dir, "record", "--gate", "verify", "--receipt", receipt(dir, run, ticket)).code).toBe(0);
    const checked = ak(dir, "check");
    expect(checked.code, checked.err).toBe(0);
    expect(checked.err).not.toContain("new enabled run");
  });

  test("retain-only cannot hide a named failed project-check", () => {
    const dir = repo();
    const ticket = plainTicket(dir, "retain-named");
    const run = opened(dir, ticketPath(dir, "retain-named"), attachKb(dir, "shadow").registry);
    recordPhases(dir);
    const failed = receipt(dir, run, ticket, { status: "failed", exit_status: 1 });
    expect(ak(dir, "record", "--gate", "verify", "--receipt", failed, "--retain-only").code).toBe(0);
    const failedId = textField(parseObject(readFileSync(failed, "utf8")).id);
    if (failedId === undefined) throw new Error("failed receipt has no id");
    expect(
      readRecords(defaultEvidenceDir(dir), run, "verify")
        .flatMap((row) => row.evidence ?? [])
        .map((ref) => ref.id),
    ).toContain(failedId);
    const checked = ak(dir, "check");
    expect(checked.code).toBe(1);
    expect(checked.err).toContain("failed evidence");
  });

  test("confirmed absent project config opens ordinary work off", () => {
    const dir = repo();
    const ticket = plainTicket(dir, "absent-project");
    const empty = attachEmptyKb(dir);
    const r = openRun({
      dir: defaultEvidenceDir(dir),
      project: dir,
      ticket: ticketPath(dir, "absent-project"),
      registry: empty.registry,
    });
    expect(r.ok, r.ok ? "" : r.reason).toBe(true);
    if (!r.ok) throw new Error(r.reason);
    expect(r.run.behavior?.mode).toBe("off");
    expect(ticket.schema).toBe("ticket");
  });
});
