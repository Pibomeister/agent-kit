/**
 * GS-017-01 round 5. Discriminating CLI probe of the worker-pointer premise.
 * Measured on the current working tree. Exit 1 when a case could not run.
 *
 * Usage, from the repository root:
 *   bun research/probes/gs017-t01-r5-authority.ts
 */
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
import { basename, dirname, join } from "node:path";

import { runCli } from "../../src/cli.ts";
import { bind } from "../../src/firstmate/bind.ts";
import {
  asJsonObject,
  bindBehaviorPolicy,
  projectHashOf,
  sealBinding,
  type JsonObject,
} from "../../src/lifecycle/behavior-policy.ts";
import { defaultEvidenceDir, openRun, readRecords, takeSnapshot } from "../../src/lifecycle/gate.ts";
import { Runner } from "../../src/runner/core.ts";
import type { StandingGrant } from "../../src/runner/types.ts";
import { artifactHash, canonicalJson } from "../../src/util/hash.ts";
import { checkDocument, indexDocuments } from "../../src/validation/docrules.ts";
import { processScratch } from "../../tests/helpers/process-tmp.ts";
import { makeTree } from "../../tests/helpers/tree.ts";
import { FIXED_NOW, makeBundle, makeDir, makeHome } from "../../tests/firstmate/fixture.ts";

const ROOT = join(import.meta.dir, "../..");
const HASH = `sha256:${"a".repeat(64)}`;

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

function parseObject(text: string): JsonObject {
  const value: unknown = JSON.parse(text);
  if (!asJsonObject(value)) throw new Error("not a JSON object");
  return value;
}

function writeJson(path: string, doc: JsonObject): void {
  writeFileSync(path, `${JSON.stringify(doc)}\n`);
}

function projectDoc(mode: "off" | "shadow" | "on", id = "example-project"): JsonObject {
  const base = parseObject(readFileSync(join(ROOT, "templates/project.example.json"), "utf8"));
  const identity = asJsonObject(base.identity) ? { ...base.identity, id } : { id };
  return { ...base, identity, review: { behavior: mode } };
}

function attachKb(cwd: string, mode: "off" | "shadow" | "on", id = "example-project") {
  const scratch = processScratch("ak-bv-r5-kb-");
  const kb = join(scratch, "kb");
  mkdirSync(join(kb, "projects", id, "runs"), { recursive: true });
  git(kb, "init", "-q", "-b", "main");
  git(kb, "config", "user.name", "t");
  git(kb, "config", "user.email", "t@example.invalid");
  git(kb, "config", "commit.gpgsign", "false");
  const project = projectDoc(mode, id);
  const hash = artifactHash(project);
  writeFileSync(
    join(kb, "projects", id, "runs", "artifacts.jsonl"),
    `${JSON.stringify({
      record: { ref: `run:bootstrap/project/${id}`, content_hash: hash, idempotency_key: hash, links: [] },
      artifact: project,
    })}\n`,
  );
  git(kb, "add", "-A");
  git(kb, "commit", "-q", "-m", "project");
  writeFileSync(join(cwd, "ak.kb.yaml"), `backend: local-git\nproject: ${id}\nlocator:\n  knowledgebase: fixture-kb\n`);
  const registry = join(scratch, "registry.json");
  writeJson(registry, { knowledgebases: { "fixture-kb": { path: kb } } });
  return { registry, kb, project };
}

function repo(): string {
  const template = makeTree({ "src/a.js": "export const a = 1;\n" });
  git(template, "init", "-q", "-b", "main");
  git(template, "add", "-A");
  git(template, "commit", "-q", "-m", "init");
  git(template, "checkout", "-q", "-b", "feature");
  writeFileSync(join(template, "src/a.js"), "export const a = 2;\n");
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "ak-bv-r5-")));
  cpSync(template, dir, { recursive: true });
  return dir;
}

function boundProjectId(dir: string): string {
  const k = basename(realpathSync(dir))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/, "");
  return k === "" ? "project" : k;
}

function behaviorTicket(id: string, projectId = "example-project"): JsonObject {
  return {
    schema: "ticket",
    schema_version: 1,
    id,
    project: { id: projectId },
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
    approvals: [{ role: "human", approved_at: "2026-09-29T00:00:00Z" }],
  };
}

function plainTicket(id: string): JsonObject {
  return {
    schema: "ticket",
    schema_version: 1,
    id,
    acceptance_criteria: [{ id: "AC-1", text: "The behavior is verified." }],
    verification: [{ id: "project-check", check: "Run the project check.", kind: "command", supports: ["AC-1"] }],
    approvals: [{ role: "human", approved_at: "2026-09-29T00:00:00Z" }],
  };
}

function ak(cwd: string, registry: string | undefined, ...argv: string[]) {
  const previous = process.env.AK_KB_REGISTRY;
  if (registry !== undefined) process.env.AK_KB_REGISTRY = registry;
  const out: string[] = [];
  const err: string[] = [];
  const code = runCli(["lifecycle", ...argv], { cwd, io: { out: (l) => out.push(l), err: (l) => err.push(l) } });
  if (previous === undefined) delete process.env.AK_KB_REGISTRY;
  else process.env.AK_KB_REGISTRY = previous;
  return { code, out, err: err.join("\n") };
}

function spawnCli(cwd: string, registry: string | undefined, ...argv: string[]) {
  const result = Bun.spawnSync(["bun", join(ROOT, "src/cli.ts"), "lifecycle", ...argv], {
    cwd,
    env: registry === undefined ? gitEnv(cwd) : { ...gitEnv(cwd), AK_KB_REGISTRY: registry },
  });
  return {
    code: result.exitCode ?? 1,
    out: result.stdout.toString().trim().split("\n"),
    err: result.stderr.toString(),
  };
}

function openedLine(out: string[]): string | undefined {
  const line = out[0];
  const match = line === undefined ? undefined : /^opened run (.+)$/.exec(line);
  return match?.[1];
}

function recordPhases(cwd: string, registry?: string, dir?: string, run?: string): void {
  const extra = [...(dir === undefined ? [] : ["--dir", dir]), ...(run === undefined ? [] : ["--run", run])];
  for (const gate of ["build-checks", "review-full", "review-readiness"] as const) {
    ak(cwd, registry, "record", "--gate", gate, ...extra);
  }
}

function ensureMainNoMistakes(cwd: string): void {
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

function writeCharter(charterPath: string, runId: string, ticket: JsonObject, projectId: string) {
  const initial = {
    schema: "charter",
    schema_version: 1,
    id: "bv-charter",
    run_id: runId,
    project: { id: projectId, repo: projectId },
    created_by: { role: "human" },
    inputs: [],
    source_revision: null,
    created_at: "2026-10-01T00:00:00Z",
    status: "active",
    immutability: { immutable: true, worker_writable: false, hash: "", location: charterPath },
    work_source: { kind: "ticket", ref: { id: ticket.id, schema: "ticket", hash: artifactHash(ticket) } },
    repos: [{ repo: projectId, base_branch: "main", paths: ["src/**"] }],
    artifact_destinations: { kb_root: projectId, runs_path: "runs" },
    allowed_capabilities: [
      "repository-read",
      "independent-context",
      "artifact-write",
      "runner-grants",
      "trusted-evidence",
      "event-delivery",
    ],
    default_grants: ["approve-spec", "approve-ticket", "start-implementation-ticket"],
    standing_grants: [{ covers: "autopilot.start", controller: "firstmate" }],
    denied_actions: ["merge", "deploy"],
    sensitive_grants: [],
    checkpoints: ["align-answer", "spec-approval", "build-go"],
    limits: {
      fix_cycles: 2,
      ci_repair_attempts: 2,
      alignment_questions: 3,
      tickets: 3,
      elapsed_minutes: 60,
      review_rounds: 2,
    },
    budgets: { provided_by: "runner", enforces: ["alignment-questions", "tickets"], on_exhaustion: "cap-reached" },
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
  if (approval === undefined) throw new Error("missing approval");
  approval.artifact_hash = hash;
  initial.immutability.hash = hash;
  writeFileSync(charterPath, JSON.stringify(initial));
  return hash;
}

function firstmateThenRunner(cwd: string, ticketFile: string, registry: string, projectId: string) {
  ensureMainNoMistakes(cwd);
  const ticket = parseObject(readFileSync(ticketFile, "utf8"));
  const privateDir = realpathSync(mkdtempSync(join(tmpdir(), "ak-bv-r5-runner-")));
  const evidence = join(privateDir, "evidence");
  mkdirSync(evidence);
  const { home, upstream } = makeHome({ patched: true });
  const ledger = makeDir();
  const bindingPath = join(home, "data", "T-r5", "binding.json");
  mkdirSync(join(home, "data", "T-r5"), { recursive: true });
  const boundFm = bind(
    {
      fmHome: home,
      taskId: "T-r5",
      project: cwd,
      mode: "agent-kit",
      bindingOut: bindingPath,
      host: "claude-code",
      evidence: { store: "mock", location: evidence },
    },
    { akRoot: ROOT, bundleDir: makeBundle(), pinsDir: makeDir(), ledgerDir: ledger, upstream, now: FIXED_NOW },
  );
  if (!boundFm.ok || boundFm.binding === undefined) {
    return { ok: false as const, errors: boundFm.errors };
  }
  const runId = boundFm.binding.run_id;
  writeFileSync(join(privateDir, `${String(ticket.id)}.json`), `${JSON.stringify(ticket)}\n`);
  const charterPath = join(privateDir, "charter.json");
  const hash = writeCharter(charterPath, runId, ticket, projectId);
  const previous = process.env.AK_KB_REGISTRY;
  process.env.AK_KB_REGISTRY = registry;
  try {
    new Runner(privateDir, cwd, ROOT).start(runId, charterPath, "implementer-1", git(cwd, "rev-parse", "HEAD"), {
      charter_hash: hash,
      covers: "autopilot.start",
      controller: "firstmate",
      run_id: runId,
    });
  } finally {
    if (previous === undefined) delete process.env.AK_KB_REGISTRY;
    else process.env.AK_KB_REGISTRY = previous;
  }
  return {
    ok: true as const,
    runId,
    evidence,
    bindingPath,
    ledger,
    privateDir,
    ticket,
    parentPath: join(privateDir, `${runId}.json`),
  };
}

function receipt(cwd: string, run: string, ticket: JsonObject, extra: JsonObject = {}): string {
  const snapshot = takeSnapshot(cwd);
  if (typeof snapshot === "string") throw new Error(snapshot);
  const receiptDir = mkdtempSync(join(tmpdir(), "ak-bv-r5-receipt-"));
  const outputPath = join(receiptDir, "verification-output.log");
  writeFileSync(outputPath, "1 pass, 0 fail\n");
  const outputDigest = `sha256:${createHash("sha256").update(readFileSync(outputPath)).digest("hex")}`;
  const id = `verification-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const ticketId = typeof ticket.id === "string" ? ticket.id : "unknown";
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

function forgedParentBinding(
  ticket: JsonObject,
  project: JsonObject,
): { bindingPath: string; parentDir: string; ledger: string } {
  const parentDir = mkdtempSync(join(tmpdir(), "ak-bv-r5-parent-"));
  const evidence = join(parentDir, "evidence");
  mkdirSync(evidence);
  const frozen = bindBehaviorPolicy({
    runId: "parent-run",
    ticket,
    ticketHash: artifactHash(ticket),
    project,
    projectHash: projectHashOf(project),
    lookup: "resolved",
    capturedAt: "2026-09-29T00:00:00Z",
  });
  if (!frozen.ok) throw new Error(frozen.reason);
  writeFileSync(
    join(parentDir, "parent-run.json"),
    `${JSON.stringify({
      id: "parent-run",
      charter_path: join(parentDir, "charter.json"),
      behavior: frozen.binding,
    })}\n`,
  );
  writeJson(join(parentDir, "charter.json"), { schema: "charter", run_id: "parent-run" });
  const bindingPath = join(parentDir, "binding.json");
  writeJson(bindingPath, { schema: "firstmate-binding", run_id: "parent-run", evidence: { location: evidence } });
  const ledger = mkdtempSync(join(tmpdir(), "ak-bv-r5-ledger-"));
  const at = realpathSync(bindingPath);
  const sha = `sha256:${createHash("sha256").update(readFileSync(bindingPath)).digest("hex")}`;
  writeJson(join(ledger, "parent-run.json"), { binding_path: at, binding_sha256: sha });
  return { bindingPath, parentDir, ledger };
}

function e1a_forgedParentCliOpen() {
  const dir = repo();
  const ticket = behaviorTicket("forged-parent");
  writeJson(join(dir, "forged-parent.json"), ticket);
  const bound = attachKb(dir, "on");
  const { bindingPath, parentDir } = forgedParentBinding(ticket, bound.project);
  const evidence = join(parentDir, "evidence");
  const spawned = spawnCli(
    dir,
    bound.registry,
    "open",
    "--ticket",
    join(dir, "forged-parent.json"),
    "--binding",
    bindingPath,
    "--project",
    dir,
    "--dir",
    evidence,
  );
  if (spawned.code === 0) throw new Error("e1a expected CLI open of a forged /tmp parent to refuse");
  return {
    cli: "bun src/cli.ts lifecycle open --binding (home ledger only)",
    code: spawned.code,
    err: spawned.err,
    opened: false,
    parent_was_two_handwritten_files: true,
    charter_path: true,
    refused: true,
    premise_holds_if_opened: false,
  };
}

function e1b_pointerRemovalReseal() {
  const dir = repo();
  const projectId = boundProjectId(dir);
  const ticket = behaviorTicket("reseal", projectId);
  writeJson(join(dir, "reseal.json"), ticket);
  const bound = attachKb(dir, "on", projectId);
  const started = firstmateThenRunner(dir, join(dir, "reseal.json"), bound.registry, projectId);
  if (!started.ok) return { opened: false, reason: started.errors.join("\n") };
  const spawned = openRun({
    dir: started.evidence,
    project: dir,
    ticket: join(dir, "reseal.json"),
    binding: started.bindingPath,
    registry: bound.registry,
    ledger: started.ledger,
  });
  if (!spawned.ok) return { opened: false, reason: spawned.reason };
  const run = spawned.run.run_id;
  const runPath = join(started.evidence, "runs", run, "run.json");
  const doc = parseObject(readFileSync(runPath, "utf8"));
  const plain = plainTicket("reseal");
  const bytes = new TextEncoder().encode(
    canonicalJson(Object.fromEntries(Object.entries(plain).filter(([key]) => key !== "approvals"))),
  );
  const hash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const art = join(started.evidence, run, "artifacts", hash.slice("sha256:".length));
  mkdirSync(dirname(art), { recursive: true });
  writeFileSync(art, bytes);
  const original = asJsonObject(doc.ticket) && typeof doc.ticket.hash === "string" ? doc.ticket.hash : undefined;
  if (original !== undefined) {
    const originalArt = join(started.evidence, run, "artifacts", original.slice("sha256:".length));
    if (existsSync(originalArt)) unlinkSync(originalArt);
  }
  delete doc.binding_run_id;
  delete doc.binding_evidence_location;
  doc.ticket = { id: "reseal", hash };
  doc.behavior = sealBinding({
    run_id: run,
    ticket_hash: hash,
    mode: "off",
    policy_id: null,
    policy_hash: null,
    required_checks: [],
    captured_at: "2026-09-29T00:00:00Z",
  });
  writeFileSync(runPath, `${JSON.stringify(doc, null, 2)}\n`);
  recordPhases(dir, bound.registry, started.evidence);
  const recorded = ak(
    dir,
    bound.registry,
    "record",
    "--gate",
    "verify",
    "--receipt",
    receipt(dir, run, plain),
    "--dir",
    started.evidence,
    "--run",
    run,
  );
  const checked = ak(dir, bound.registry, "check", "--dir", started.evidence, "--run", run);
  return {
    opened: true,
    run,
    firstmate_run_id: started.runId,
    parent_exists: existsSync(started.parentPath),
    record_code: recorded.code,
    check_code: checked.code,
    check_err: checked.err,
    bypass: checked.code === 0,
    dropped_binding_pointers: true,
    resealed_off: true,
    deleted_original_ticket_artifact: original !== undefined,
    on_runner_evidence: true,
  };
}

function e1c_realFirstmateBind() {
  const dir = repo();
  ensureMainNoMistakes(dir);
  const projectId = boundProjectId(dir);
  const ticket = behaviorTicket("fm-real", projectId);
  writeJson(join(dir, "fm-real.json"), ticket);
  const bound = attachKb(dir, "on", projectId);
  const { home, upstream } = makeHome({ patched: true });
  const evidence = makeDir();
  const ledgerDir = makeDir();
  const out = join(home, "data/T-r5/agent-kit-binding.json");
  mkdirSync(join(home, "data/T-r5"), { recursive: true });
  const result = bind(
    {
      fmHome: home,
      taskId: "T-r5",
      project: dir,
      mode: "agent-kit",
      bindingOut: out,
      host: "claude-code",
      evidence: { store: "mock", location: evidence },
    },
    { akRoot: ROOT, bundleDir: makeBundle(), pinsDir: makeDir(), ledgerDir, upstream, now: FIXED_NOW },
  );
  if (!result.ok || result.binding === undefined) {
    return { bind_ok: false, errors: result.errors, opened: false };
  }
  const spawned = openRun({
    dir: evidence,
    project: dir,
    ticket: join(dir, "fm-real.json"),
    binding: out,
    registry: bound.registry,
    ledger: ledgerDir,
  });
  const parentGuess = [
    join(dirname(evidence), `${result.binding.run_id}.json`),
    join(evidence, `${result.binding.run_id}.json`),
  ];
  return {
    bind_ok: true,
    firstmate_run_id: result.binding.run_id,
    evidence_location: evidence,
    parent_files_exist: parentGuess.map((path) => ({ path, exists: existsSync(path) })),
    ledger_record: existsSync(join(ledgerDir, `${result.binding.run_id}.json`)),
    runner_start: false,
    cli: "openRun with injected firstmate ledger, no Runner.start",
    code: spawned.ok ? 0 : 1,
    err: spawned.ok ? "" : spawned.reason,
    opened: spawned.ok,
    refused_protected_record: !spawned.ok && spawned.reason.includes("protected runner"),
  };
}

function e1_authenticFirstmateRunnerCli() {
  const dir = repo();
  const projectId = boundProjectId(dir);
  const ticket = behaviorTicket("fm-auth", projectId);
  writeJson(join(dir, "fm-auth.json"), ticket);
  const bound = attachKb(dir, "on", projectId);
  const started = firstmateThenRunner(dir, join(dir, "fm-auth.json"), bound.registry, projectId);
  if (!started.ok) return { bind_ok: false, errors: started.errors, opened: false };
  const spawned = openRun({
    dir: started.evidence,
    project: dir,
    ticket: join(dir, "fm-auth.json"),
    binding: started.bindingPath,
    registry: bound.registry,
    ledger: started.ledger,
  });
  const run = spawned.ok ? spawned.run.run_id : undefined;
  const record =
    run === undefined ? undefined : parseObject(readFileSync(join(started.evidence, "runs", run, "run.json"), "utf8"));
  return {
    bind_ok: true,
    runner_start: true,
    firstmate_run_id: started.runId,
    parent_exists: existsSync(started.parentPath),
    cli: "openRun with injected firstmate ledger after Runner.start",
    code: spawned.ok ? 0 : 1,
    err: spawned.ok ? "" : spawned.reason,
    opened: spawned.ok,
    run,
    mode: asJsonObject(record?.behavior) ? record.behavior.mode : undefined,
    required_checks:
      asJsonObject(record?.behavior) && Array.isArray(record.behavior.required_checks)
        ? record.behavior.required_checks.length
        : undefined,
    handwritten_parent: false,
  };
}

function e1_runnerStartThenToyBinding() {
  const dir = mkdtempSync(join(tmpdir(), "ak-bv-r5-runner-"));
  const worker = join(dir, "worker");
  const privateDir = join(dir, "private");
  mkdirSync(worker);
  mkdirSync(privateDir);
  writeFileSync(join(worker, ".gitignore"), ".runner-requests/\n");
  writeFileSync(join(worker, "README.md"), "toy\n");
  git(worker, "init", "-q", "-b", "main");
  git(worker, "add", "-A");
  git(worker, "commit", "-q", "-m", "init");
  const revision = git(worker, "rev-parse", "HEAD");
  mkdirSync(join(worker, ".runner-requests"));
  const bound = attachKb(worker, "on", "toy");
  const ticket = behaviorTicket("toy-ticket", "toy");
  writeJson(join(privateDir, "toy-ticket.json"), ticket);
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
    work_source: { kind: "ticket", ref: { id: "toy-ticket", schema: "ticket", hash: artifactHash(ticket) } },
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
  charter.immutability.hash = artifactHash({ ...charter, immutability: { ...charter.immutability, hash: "" } });
  const approval = charter.approvals[0];
  if (approval === undefined) throw new Error("missing approval");
  approval.artifact_hash = charter.immutability.hash;
  writeFileSync(path, JSON.stringify(charter));
  const previous = process.env.AK_KB_REGISTRY;
  process.env.AK_KB_REGISTRY = bound.registry;
  try {
    const runner = new Runner(privateDir, worker, ROOT);
    const started = runner.start("toy-run", path, "implementer-1", revision, {
      charter_hash: charter.immutability.hash,
      covers: "autopilot.start",
      controller: "firstmate",
      run_id: "toy-run",
    } satisfies StandingGrant);
    const evidence = join(privateDir, "evidence");
    const bindingPath = join(privateDir, "binding.json");
    writeJson(bindingPath, {
      schema: "firstmate-binding",
      run_id: "toy-run",
      evidence: { location: evidence },
      project: { id: "toy" },
    });
    writeJson(join(worker, "delegated.json"), ticket);
    const spawned = spawnCli(
      worker,
      bound.registry,
      "open",
      "--ticket",
      join(worker, "delegated.json"),
      "--binding",
      bindingPath,
      "--project",
      worker,
      "--dir",
      evidence,
    );
    return {
      runner_started: true,
      runner_mode: started.behavior?.mode,
      runner_checks: started.behavior?.required_checks.length,
      private_run_exists: existsSync(join(privateDir, "toy-run.json")),
      binding_handwritten_aiming_at_statedir_evidence: true,
      code: spawned.code,
      err: spawned.err,
      opened: spawned.code === 0,
      note: "Runner.start is a real caller. The binding file is still hand-written at stateDir/evidence.",
    };
  } catch (cause) {
    return { runner_started: false, error: cause instanceof Error ? cause.message : String(cause) };
  } finally {
    if (previous === undefined) delete process.env.AK_KB_REGISTRY;
    else process.env.AK_KB_REGISTRY = previous;
  }
}

function e2_prefeatureCliCheck() {
  const dir = repo();
  const ticket = plainTicket("legacy-plain");
  writeJson(join(dir, "legacy-plain.json"), ticket);
  const evidence = defaultEvidenceDir(dir);
  const run = "legacy-plain-run";
  mkdirSync(join(evidence, "runs", run), { recursive: true });
  const bytes = new TextEncoder().encode(
    canonicalJson(Object.fromEntries(Object.entries(ticket).filter(([key]) => key !== "approvals"))),
  );
  const hash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  mkdirSync(join(evidence, run, "artifacts"), { recursive: true });
  writeFileSync(join(evidence, run, "artifacts", hash.slice("sha256:".length)), bytes);
  writeJson(join(evidence, "runs", run, "run.json"), {
    run_id: run,
    ticket: { id: "legacy-plain", hash },
    opened_at: "2026-01-01T00:00:00Z",
    branch: "feature",
    base: git(dir, "rev-parse", "HEAD"),
  });
  recordPhases(dir, undefined, undefined, run);
  const recorded = ak(
    dir,
    undefined,
    "record",
    "--gate",
    "verify",
    "--receipt",
    receipt(dir, run, ticket),
    "--run",
    run,
  );
  const checked = ak(dir, undefined, "check", "--run", run);
  return {
    no_schema_version: true,
    no_behavior: true,
    no_binding_pointer: true,
    record_code: recorded.code,
    check_code: checked.code,
    check_err: checked.err,
    treated_as_incomplete: checked.err.includes("new enabled run with no behavior policy snapshot"),
    allowed: checked.code === 0,
  };
}

function e3_ticketKindWithoutPrivateCopy() {
  const dir = mkdtempSync(join(tmpdir(), "ak-bv-r5-e3-"));
  const worker = join(dir, "worker");
  const privateDir = join(dir, "private");
  mkdirSync(worker);
  mkdirSync(privateDir);
  writeFileSync(join(worker, ".gitignore"), ".runner-requests/\n");
  writeFileSync(join(worker, "README.md"), "toy\n");
  git(worker, "init", "-q", "-b", "main");
  git(worker, "add", "-A");
  git(worker, "commit", "-q", "-m", "init");
  const revision = git(worker, "rev-parse", "HEAD");
  mkdirSync(join(worker, ".runner-requests"));
  const ticket = plainTicket("toy-ticket");
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
    work_source: { kind: "ticket", ref: { id: "toy-ticket", schema: "ticket", hash: artifactHash(ticket) } },
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
    default_grants: ["approve-spec", "approve-ticket", "start-implementation-ticket"],
    standing_grants: [{ covers: "autopilot.start", controller: "firstmate" }],
    denied_actions: ["merge", "deploy"],
    sensitive_grants: [],
    checkpoints: ["align-answer", "spec-approval", "build-go"],
    limits: {
      fix_cycles: 2,
      ci_repair_attempts: 2,
      alignment_questions: 3,
      tickets: 3,
      elapsed_minutes: 60,
      review_rounds: 2,
    },
    budgets: { provided_by: "runner", enforces: ["alignment-questions", "tickets"], on_exhaustion: "cap-reached" },
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
  if (approval === undefined) throw new Error("missing approval");
  approval.artifact_hash = charter.immutability.hash;
  writeFileSync(path, JSON.stringify(charter));
  try {
    const runner = new Runner(privateDir, worker, ROOT);
    runner.start("toy-run", path, "implementer-1", revision, {
      charter_hash: charter.immutability.hash,
      covers: "autopilot.start",
      controller: "firstmate",
      run_id: "toy-run",
    });
    return { started: true, private_ticket_present: existsSync(join(privateDir, "toy-ticket.json")) };
  } catch (cause) {
    return {
      started: false,
      private_ticket_present: existsSync(join(privateDir, "toy-ticket.json")),
      error: cause instanceof Error ? cause.message : String(cause),
    };
  }
}

function e4_requirementsSelfCite() {
  const example = parseObject(readFileSync(join(ROOT, "templates/behavior-contract.example.json"), "utf8"));
  const proposed = {
    id: "retry-twice",
    statement: "The loader retries a missing directory twice.",
    intent: "proposed",
    sources: [{ kind: "requirements", ref: "example-behavior-contract-1" }],
  };
  const accepted = {
    id: "load-every-configured-directory",
    statement: "The loader returns a document from every configured directory, not only the first.",
    intent: "accepted",
    acceptance_criteria: ["AC-1"],
    sources: [{ kind: "requirements", ref: "example-behavior-contract-1" }],
  };
  const doc = { ...example, requirements: [accepted, proposed] };
  const issues = checkDocument("self.json", doc, indexDocuments([{ file: "self.json", doc }])).map(
    (issue) => `${issue.rule}: ${issue.message}`,
  );
  return {
    admitted: issues.length === 0,
    issues,
    cited_self: true,
    cited_requirement_intent: "the contract is active; the cited requirement is proposed",
  };
}

function w1_retainOnlyHidesOrdinaryFail() {
  const dir = repo();
  const ticket = plainTicket("retain-fail");
  writeJson(join(dir, "retain-fail.json"), ticket);
  const bound = attachKb(dir, "shadow");
  const opened = ak(dir, bound.registry, "open", "--ticket", join(dir, "retain-fail.json"));
  const run = openedLine(opened.out);
  if (run === undefined) return { opened: false, err: opened.err };
  recordPhases(dir, bound.registry);
  const pass = receipt(dir, run, ticket);
  ak(dir, bound.registry, "record", "--gate", "verify", "--receipt", pass);
  const failed = receipt(dir, run, ticket, { status: "failed", exit_status: 1 });
  const failedId = parseObject(readFileSync(failed, "utf8")).id;
  const retained = ak(dir, bound.registry, "record", "--gate", "verify", "--receipt", failed, "--retain-only");
  const checked = ak(dir, bound.registry, "check");
  const refs = readRecords(defaultEvidenceDir(dir), run, "verify").flatMap((row) => row.evidence ?? []);
  return {
    opened: true,
    run,
    retain_code: retained.code,
    check_code: checked.code,
    check_err: checked.err,
    failed_in_refs: refs.some((ref) => ref.id === failedId),
    hidden: checked.code === 0 && !refs.some((ref) => ref.id === failedId),
    ordinary_named_check: "project-check",
  };
}

function w3_missingProjectRecord() {
  const dir = repo();
  const ticket = plainTicket("no-project");
  writeJson(join(dir, "no-project.json"), ticket);
  const scratch = processScratch("ak-bv-r5-empty-kb-");
  const kb = join(scratch, "kb");
  mkdirSync(join(kb, "projects", "example-project", "runs"), { recursive: true });
  git(kb, "init", "-q", "-b", "main");
  git(kb, "config", "user.name", "t");
  git(kb, "config", "user.email", "t@example.invalid");
  git(kb, "config", "commit.gpgsign", "false");
  writeFileSync(join(kb, "projects", "example-project", "runs", "artifacts.jsonl"), "");
  git(kb, "add", "-A");
  git(kb, "commit", "-q", "-m", "empty");
  writeFileSync(
    join(dir, "ak.kb.yaml"),
    "backend: local-git\nproject: example-project\nlocator:\n  knowledgebase: fixture-kb\n",
  );
  const registry = join(scratch, "registry.json");
  writeJson(registry, { knowledgebases: { "fixture-kb": { path: kb } } });
  const spawned = spawnCli(dir, registry, "open", "--ticket", join(dir, "no-project.json"), "--project", dir);
  return {
    kb_reachable: true,
    project_record_present: false,
    ordinary_ticket: true,
    code: spawned.code,
    err: spawned.err,
    refused_as_unavailable: spawned.err.includes("unavailable") || spawned.err.includes("missing"),
  };
}

function runCase(fn: () => object) {
  try {
    return { ran: true as const, ...fn() };
  } catch (cause) {
    return { ran: false as const, ok: false as const, error: cause instanceof Error ? cause.message : String(cause) };
  }
}

const head = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: ROOT }).stdout.toString().trim();

const report = {
  head,
  premise: "Worker-selected pointers and a self-recomputed binding hash establish protected Runner creation lineage.",
  cases: {
    e1a_forged_parent_cli_open: runCase(e1a_forgedParentCliOpen),
    e1b_pointer_removal_reseal: runCase(e1b_pointerRemovalReseal),
    e1c_real_firstmate_bind: runCase(e1c_realFirstmateBind),
    e1_authentic_firstmate_runner_cli: runCase(e1_authenticFirstmateRunnerCli),
    e1_runner_start_then_toy_binding: runCase(e1_runnerStartThenToyBinding),
    e2_prefeature_cli_check: runCase(e2_prefeatureCliCheck),
    e3_ticket_kind_without_private_copy: runCase(e3_ticketKindWithoutPrivateCopy),
    e4_requirements_self_cite: runCase(e4_requirementsSelfCite),
    w1_retain_only_hides_ordinary_fail: runCase(w1_retainOnlyHidesOrdinaryFail),
    w3_missing_project_record_ordinary_open: runCase(w3_missingProjectRecord),
  },
};

process.exitCode = Object.values(report.cases).some((value) => value.ran === false) ? 1 : 0;
const reportPath = join(mkdtempSync(join(tmpdir(), "ak-bv-r5-report-")), "gs017-t01-r5-exploit-after.json");
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ ...report, report_path: reportPath }, null, 2));
