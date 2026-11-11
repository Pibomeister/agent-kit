/**
 * Drive the real runner and validators with the same events the reference model sees.
 *
 * Real runner paths: charge, ledger (resume), status through a second Runner
 * instance over the same state directory (restart), copy-run-to-new-id
 * (rename / move-line), cancel, effect (publish), judge, decide.
 *
 * Real validator paths: review/finding/ticket documents through checkDocument,
 * checkArtifacts, and the review schema validator.
 *
 * Limits (no product API, not claimed):
 * - There is no Runner operation for cover-lane, skip-lane, unavailable-lane,
 *   set-verdict, record-extension, force-full-mode, synthesize, claim-isolation,
 *   fill-seat-with-author, apply-patch, resolve-finding, change-bytes, or
 *   move-line-as-a-line-edit. Those events are applied to documents and checked
 *   with the validators above. move-line also rehomes the run under a new id so
 *   the budget comparison still goes through Runner state.
 * - checkDocument does not inspect a covered lane's prior timeout reason. The
 *   rewriteTimeoutLanes probe is checked separately from the shared rules list;
 *   when that probe covering a timeout lane raises no rule, evaluate emits
 *   'probe covering a timeout lane raised no rule' (a knownFailure). Timeout as
 *   coverage is still enforced on the honest document by leaving the lane
 *   `unavailable` (review.unavailable-required-lane-blocks-approval) and by the
 *   schema pin that approved ⇒ every required lane is covered.
 * - There is no docrule for `context_isolated: false`. Author-claimed isolation
 *   is encoded as `context_isolated: false` and `independent_of_author: false`;
 *   the firing rules are review.seat-filled-by-someone-other-than-the-author
 *   and the schema const on independent_of_author.
 * - A verifier-closed finding with independent: false is schema-invalid
 *   (`closure_receipt.independent` const true). Applied≠resolved is asserted
 *   via finding.self-closed and finding.closed-without-receipt only.
 * - Synthesize does not rewrite lane execution state in the product. The honest
 *   document still carries `unavailable` and must block approval.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { loadCatalog } from "../../src/catalog/load.ts";
import { Runner } from "../../src/runner/core.ts";
import type { Run, StandingGrant } from "../../src/runner/types.ts";
import { sealBinding } from "../../src/lifecycle/behavior-policy.ts";
import { artifactHash } from "../../src/util/hash.ts";
import { checkArtifacts } from "../../src/validation/artifacts.ts";
import type { CheckContext } from "../../src/validation/context.ts";
import { checkDocument, indexDocuments } from "../../src/validation/docrules.ts";
import { compileSchemas, type SchemaSet } from "../../src/validation/schemas.ts";
import { processScratch } from "../helpers/process-tmp.ts";
import { HASH_A, HASH_B, isTimeoutReason } from "./model.ts";
import { isFiniteNumber } from "./parse.ts";
import {
  AUTHOR_ROLE,
  IMPLEMENTER,
  type BudgetEntry,
  type Event,
  type Finding,
  type Lane,
  type Model,
} from "./types.ts";

const ROOT = join(import.meta.dir, "..", "..");
const CATALOG_TEXT = `schema_version: 1
package:
  id: ak
  name: agent-kit
  version: 0.1.0
  namespace: "/ak:"
  default_profile: core
`;
const AT = "2026-09-19T10:00:00Z";
const REVISION = "a".repeat(40);

/** Rehomed by rename-run / move-line; sequence length is at most 8, so these are every path. */
const REHOMED_RUN_FILES = [
  "toy-run-r1.json",
  "toy-run-r2.json",
  "toy-run-r3.json",
  "toy-run-r4.json",
  "toy-run-r5.json",
  "toy-run-r6.json",
  "toy-run-r7.json",
  "toy-run-r8.json",
  "toy-run-finding-a-l1.json",
  "toy-run-finding-a-l2.json",
  "toy-run-finding-a-l3.json",
  "toy-run-finding-a-l4.json",
  "toy-run-finding-a-l5.json",
  "toy-run-finding-a-l6.json",
  "toy-run-finding-a-l7.json",
  "toy-run-finding-a-l8.json",
  "toy-run-finding-b-l1.json",
  "toy-run-finding-b-l2.json",
  "toy-run-finding-b-l3.json",
  "toy-run-finding-b-l4.json",
  "toy-run-finding-b-l5.json",
  "toy-run-finding-b-l6.json",
  "toy-run-finding-b-l7.json",
  "toy-run-finding-b-l8.json",
] as const;

export interface World {
  runner: Runner;
  restartRunner: () => Runner;
  privateDir: string;
  workerRoot: string;
  kitRoot: string;
  runId: string;
  isolationClaim: "runner-attested" | "host-unattested" | "self-attested" | null;
  renameSeq: number;
  restore: () => void;
  ctx: CheckContext;
  schemas: SchemaSet;
  lastSeatError: string | null;
  lastPublishError: string | null;
  lastChargeStatus: string | null;
  cancelled: boolean;
  publishedAfterCancel: boolean;
  /** Harness injector: restore() must not clear these. */
  submitTimeoutAsCovered: boolean;
  zeroBudgetAfterRestart: boolean;
  allowPublishAfterCancel: boolean;
  grantOnApprovedReview: boolean;
  artifactRuleCache: Map<string, string[]>;
}

export interface LaneRecord {
  role: string;
  required: true;
  state: string;
  seat: { filled_by: string; independent_of_author: boolean; context_isolated: boolean };
  verdict?: string;
  reason?: string;
  raw_output?: { id: string; hash: string };
}

interface FindingDocument {
  schema: string;
  schema_version: number;
  id: string;
  project: { id: string };
  run_id: null;
  created_by: { role: string };
  inputs: never[];
  source_revision: null;
  created_at: string;
  status: string;
  title: string;
  lane: string;
  fingerprint: { value: string; inputs: { rule: string; symbol_or_path: string; evidence_digest: string } };
  severity: string;
  confidence_anchor: number;
  spec_quality: string;
  difficulty: string;
  autofix_class: string;
  evidence: Array<{
    location: { repo: string; revision: string; path: string; line_range: { start: number; end: number } };
    observation: string;
  }>;
  verification: Array<{ check: string }>;
  authorization_ref?: { kind: string; approval: { artifact_hash: string; by: string; authority: string; at: string } };
  closure_receipt?: {
    verification: { id: string; schema: string; hash: string };
    closed_by: string;
    independent: boolean;
    at: string;
  };
  synthesis?: {
    of: { id: string; hash: string };
    changes: Array<{ field: string; from: string; to: string }>;
    rationale: string;
  };
}

interface CycleExtension {
  authorized_by: string;
  authorized_at?: string;
}

interface FixCycles {
  allowed: number;
  used: number;
  extensions?: CycleExtension[];
  exhausted_action?: string;
}

interface ReviewDocument {
  schema: string;
  schema_version: number;
  id: string;
  project: { id: string };
  run_id: null;
  created_by: { role: string };
  inputs: never[];
  source_revision: { repo: string; revision: string };
  created_at: string;
  status: string;
  mode: string;
  comparison_base: { repo: string; revision: string };
  reviewed_head: { repo: string; revision: string };
  snapshot: { hash: string; immutable: boolean; reviewers_may_edit_source: boolean };
  authorship: { implementer: string; spec_approver: string };
  lanes: LaneRecord[];
  fix_cycles: FixCycles;
  verdict: string;
  last_head_verified?: { repo: string; revision: string };
  delta_scope?: { boundary: string; affected_behavior: string[] };
  packet?: {
    prior_review: { id: string; hash: string };
    original_findings: Array<{ id: string; hash: string }>;
    fix_diff: string;
  };
  continuity?: { mode: string; independent_of_author: boolean };
}

export interface ImplView {
  rules: string[];
  probeRules: string[];
  lanes: LaneRecord[];
  findingsSoftened: boolean;
}

function unlinkIfPresent(path: string): void {
  if (existsSync(path)) unlinkSync(path);
}

function standingGrant(hash: string, runId: string): StandingGrant {
  return { charter_hash: hash, covers: "autopilot.start", controller: "firstmate", run_id: runId };
}

function writeCharter(privateDir: string, limit: number) {
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
  charter.immutability.hash = artifactHash({ ...charter, immutability: { ...charter.immutability, hash: "" } });
  const approval = charter.approvals[0];
  if (approval === undefined) throw new Error("toy charter approval missing");
  approval.artifact_hash = charter.immutability.hash;
  writeFileSync(path, JSON.stringify(charter));
  return { path, hash: charter.immutability.hash };
}

function git(cwd: string, args: readonly string[]): string {
  const result = Bun.spawnSync(["git", "-c", "commit.gpgsign=false", ...args], { cwd });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

const ROOT_SCHEMAS = compileSchemas(ROOT);

const WORKER_TEMPLATE = (() => {
  const worker = processScratch("ak-event-seq-worker-");
  writeFileSync(join(worker, ".gitignore"), ".runner-requests/\n");
  writeFileSync(join(worker, "README.md"), "toy worktree\n");
  git(worker, ["init", "-q", "-b", "main"]);
  git(worker, ["add", "."]);
  git(worker, [
    "-c",
    "user.name=Toy",
    "-c",
    "user.email=toy@example.invalid",
    "commit",
    "-qm",
    "Create toy charter worktree",
  ]);
  const revision = git(worker, ["rev-parse", "HEAD"]);
  mkdirSync(join(worker, ".runner-requests"));
  return { worker, revision };
})();

export function createWorld(): World {
  const dir = processScratch("ak-event-seq-");
  const worker = join(dir, "worker");
  const privateDir = join(dir, "private");
  cpSync(WORKER_TEMPLATE.worker, worker, { recursive: true });
  mkdirSync(privateDir);
  const { revision } = WORKER_TEMPLATE;
  const charter = writeCharter(privateDir, 3);
  const runner = new Runner(privateDir, worker, ROOT);
  let restartedRunner: Runner | null = null;
  runner.start("toy-run", charter.path, IMPLEMENTER, revision, standingGrant(charter.hash, "toy-run"));
  const log = join(privateDir, "log.txt");
  writeFileSync(log, "independently collected verification");
  runner.collect("toy-run", "e1", log, revision, "source");
  runner.prepare("toy-run", {
    id: "card-1",
    operation: "align.run",
    grant: { charter_hash: charter.hash, covers: "align-answer" },
    question: "Proceed?",
    options: ["yes", "no"],
    approve: "yes",
    evidence: ["e1"],
    artifact_hash: HASH_A,
  });
  const runPath = join(privateDir, "toy-run.json");
  const ledgerPath = join(privateDir, "toy-run.ledger.json");
  const decisionPath = join(privateDir, "toy-run-card-1.decision.json");
  const runSnap = readFileSync(runPath);
  const ledgerSnap = existsSync(ledgerPath) ? readFileSync(ledgerPath) : null;
  const artifactRoot = processScratch("ak-event-seq-docs-");
  writeFileSync(join(artifactRoot, "catalog.yaml"), CATALOG_TEXT);
  mkdirSync(join(artifactRoot, "templates"));
  writeFileSync(join(artifactRoot, "templates", "finding.json"), "{}");
  const loaded = loadCatalog(artifactRoot);
  if (loaded.catalog === null) throw new Error("event-sequence artifact tree has no catalog");
  const world: World = {
    runner,
    restartRunner() {
      restartedRunner ??= new Runner(privateDir, worker, ROOT);
      return restartedRunner;
    },
    privateDir,
    workerRoot: worker,
    kitRoot: ROOT,
    runId: "toy-run",
    isolationClaim: null,
    renameSeq: 0,
    ctx: { root: artifactRoot, catalog: loaded.catalog },
    schemas: ROOT_SCHEMAS,
    lastSeatError: null,
    lastPublishError: null,
    lastChargeStatus: null,
    cancelled: false,
    publishedAfterCancel: false,
    submitTimeoutAsCovered: false,
    zeroBudgetAfterRestart: false,
    allowPublishAfterCancel: false,
    grantOnApprovedReview: false,
    artifactRuleCache: new Map(),
    restore() {
      writeFileSync(runPath, runSnap);
      if (ledgerSnap !== null) writeFileSync(ledgerPath, ledgerSnap);
      else unlinkIfPresent(ledgerPath);
      unlinkIfPresent(decisionPath);
      for (const file of REHOMED_RUN_FILES) {
        unlinkIfPresent(join(privateDir, file));
        unlinkIfPresent(join(privateDir, `${file.slice(0, -".json".length)}.ledger.json`));
      }
      const templates = join(this.ctx.root, "templates");
      unlinkIfPresent(join(templates, "finding-a.json"));
      unlinkIfPresent(join(templates, "finding-b.json"));
      unlinkIfPresent(join(templates, "finding.json"));
      unlinkIfPresent(join(templates, "review-probe.json"));
      this.runner = runner;
      this.runId = "toy-run";
      this.isolationClaim = null;
      this.renameSeq = 0;
      this.lastSeatError = null;
      this.lastPublishError = null;
      this.lastChargeStatus = null;
      this.cancelled = false;
      this.publishedAfterCancel = false;
      this.artifactRuleCache.clear();
    },
  };
  return world;
}

export function caughtMessage(run: () => void): string | null {
  try {
    run();
    return null;
  } catch (cause) {
    return cause instanceof Error ? cause.message : "failed";
  }
}

export function liveBudget(world: World): BudgetEntry[] {
  const run = world.runner.status(world.runId);
  const entries: BudgetEntry[] = [];
  for (const [key, used] of Object.entries(run.budget_consumption)) {
    if (isFiniteNumber(used)) entries.push({ key, used });
  }
  return entries;
}

function rehomeRun(world: World, nextId: string): void {
  const current: Run = structuredClone(world.runner.status(world.runId));
  current.id = nextId;
  if (current.behavior !== undefined) {
    const { binding_hash: _hash, ...unsigned } = current.behavior;
    current.behavior = sealBinding({ ...unsigned, run_id: nextId });
  }
  writeFileSync(join(world.privateDir, `${nextId}.json`), `${JSON.stringify(current, null, 2)}\n`);
  world.runId = nextId;
  world.runner.status(nextId);
}

export function applyImpl(world: World, event: Event): void {
  switch (event.kind) {
    case "charge-fix-cycle": {
      const err = caughtMessage(() => {
        world.lastChargeStatus = world.runner.charge(world.runId, "fix_cycles", 1, event.findingId).status;
      });
      if (err !== null) world.lastChargeStatus = err;
      return;
    }
    case "resume":
      world.runner.ledger(world.runId);
      return;
    case "restart": {
      world.runner = world.restartRunner();
      const run = world.runner.status(world.runId);
      if (world.zeroBudgetAfterRestart) {
        const consumption = run.budget_consumption;
        for (const key of Object.keys(consumption)) {
          if (key === "fix_cycles" || key.startsWith("fix_cycles:")) consumption[key] = 0;
        }
        writeFileSync(join(world.privateDir, `${world.runId}.json`), `${JSON.stringify(run, null, 2)}\n`);
      }
      return;
    }
    case "rename-run":
      world.renameSeq += 1;
      rehomeRun(world, `toy-run-r${world.renameSeq}`);
      return;
    case "move-line":
      world.renameSeq += 1;
      rehomeRun(world, `toy-run-${event.findingId}-l${world.renameSeq}`);
      return;
    case "cancel": {
      const err = caughtMessage(() => {
        world.runner.cancel(world.runId, "supervisor-1", "stop the run");
      });
      if (err === null) world.cancelled = true;
      return;
    }
    case "publish": {
      if (world.allowPublishAfterCancel && world.cancelled && !world.publishedAfterCancel) {
        const path = join(world.privateDir, `${world.runId}.json`);
        const run = world.runner.status(world.runId);
        run.run_state = "building";
        delete run.cancellation;
        writeFileSync(path, `${JSON.stringify(run, null, 2)}\n`);
      }
      const input = HASH_A;
      const err = caughtMessage(() => {
        world.runner.effect(
          world.runId,
          "kb-publish",
          "toy",
          input,
          () => input,
          () => undefined,
        );
      });
      world.lastPublishError = err;
      if (world.cancelled && err === null) world.publishedAfterCancel = true;
      return;
    }
    case "complete-seat": {
      const dispatch = `dispatch-${event.seat}`;
      world.lastSeatError = caughtMessage(() => {
        world.runner.judge(world.runId, "card-1", event.seat, event.actor, dispatch, "yes", [], event.lineage);
      });
      return;
    }
    case "decide":
      caughtMessage(() => {
        world.runner.decide(world.runId, "card-1");
      });
      return;
    case "claim-isolation":
      world.isolationClaim = event.isolation;
      return;
    default:
      return;
  }
}

function laneRecord(lane: Lane): LaneRecord {
  const seat = {
    filled_by: lane.filledBy ?? "reviewer-a",
    independent_of_author: lane.independentOfAuthor,
    context_isolated: lane.contextIsolated,
  };
  if (lane.state === "covered") {
    return {
      role: lane.role,
      required: true,
      state: "covered",
      seat,
      verdict: lane.verdict ?? "approve",
      raw_output: { id: `raw-${lane.role.replaceAll("/", "-")}`, hash: HASH_A },
    };
  }
  if (lane.state === "skipped") {
    const record: LaneRecord = { role: lane.role, required: true, state: "skipped", seat, verdict: "no-opinion" };
    if (lane.reason !== null) record.reason = lane.reason;
    return record;
  }
  if (lane.state === "unavailable") {
    const record: LaneRecord = { role: lane.role, required: true, state: "unavailable", seat, verdict: "no-opinion" };
    if (lane.reason !== null) record.reason = lane.reason;
    return record;
  }
  return { role: lane.role, required: true, state: "skipped", seat, verdict: "no-opinion", reason: "not yet run" };
}

function findingDoc(finding: Finding): FindingDocument {
  const location = {
    repo: "demo",
    revision: REVISION,
    path: "src/p.ts",
    line_range: { start: finding.line, end: finding.line },
  };
  const doc: FindingDocument = {
    schema: "finding",
    schema_version: 1,
    id: finding.id,
    project: { id: "demo" },
    run_id: null,
    created_by: { role: finding.author },
    inputs: [],
    source_revision: null,
    created_at: AT,
    status: finding.status,
    title: "A caller dereferences a value the callee may return null for",
    lane: "code-review/correctness",
    fingerprint: {
      value: HASH_A,
      inputs: { rule: "null-deref", symbol_or_path: "src/p.ts", evidence_digest: HASH_B },
    },
    severity: finding.synthesisSoftened ? "P2" : "P1",
    confidence_anchor: 50,
    spec_quality: "patch",
    difficulty: "mechanical",
    autofix_class: "manual",
    evidence: [{ location, observation: "the return value is used without a null check" }],
    verification: [{ check: "bun test" }],
  };
  if (finding.status === "resolved" || finding.status === "awaiting-verification") {
    doc.authorization_ref = {
      kind: "explicit",
      approval: { artifact_hash: HASH_A, by: "human", authority: "explicit", at: AT },
    };
  }
  if (finding.status === "resolved") {
    const authorClosed = finding.closer === "implementer" || finding.closer === finding.author;
    if (authorClosed || finding.independentReceipt) {
      doc.closure_receipt = {
        verification: { id: "verification-1", schema: "verification", hash: HASH_B },
        closed_by: finding.closer ?? AUTHOR_ROLE,
        independent: true,
        at: AT,
      };
    }
  }
  if (finding.synthesisSoftened) {
    doc.synthesis = {
      of: { id: "finding-0", hash: HASH_A },
      changes: [{ field: "severity", from: "P0", to: "P2" }],
      rationale: "seemed minor",
    };
  }
  return doc;
}

function reviewDoc(model: Model): ReviewDocument {
  const extensions = model.extensions.map((ext) => {
    if (ext.authorizedAt === null) return { authorized_by: ext.authorizedBy };
    return { authorized_by: ext.authorizedBy, authorized_at: ext.authorizedAt };
  });
  const cycles: FixCycles = { allowed: 2, used: model.fixUsed };
  if (extensions.length > 0) cycles.extensions = extensions;
  if (model.fixUsed >= 2) cycles.exhausted_action = "replan";
  const doc: ReviewDocument = {
    schema: "review",
    schema_version: 1,
    id: "review-1",
    project: { id: "demo" },
    run_id: null,
    created_by: { role: "runner" },
    inputs: [],
    source_revision: { repo: "app", revision: REVISION },
    created_at: "2026-09-19T00:00:00Z",
    status: "complete",
    mode: model.mode,
    comparison_base: { repo: "app", revision: REVISION },
    reviewed_head: { repo: "app", revision: "b".repeat(40) },
    snapshot: { hash: model.snapshotHash, immutable: true, reviewers_may_edit_source: false },
    authorship: { implementer: "builder", spec_approver: "planner" },
    lanes: model.lanes.map(laneRecord),
    fix_cycles: cycles,
    verdict: model.verdict,
  };
  if (model.mode === "delta") {
    doc.last_head_verified = { repo: "app", revision: "c".repeat(40) };
    doc.delta_scope = { boundary: "affected-behavior", affected_behavior: ["login"] };
    doc.packet = {
      prior_review: { id: "review-0", hash: HASH_A },
      original_findings: [{ id: "finding-a", hash: HASH_B }],
      fix_diff: HASH_A,
    };
    doc.continuity = { mode: "same-seat", independent_of_author: true };
  }
  return doc;
}

interface TicketDoc {
  schema: string;
  schema_version: number;
  id: string;
  project: { id: string };
  run_id: null;
  created_by: { role: string };
  inputs: never[];
  source_revision: null;
  created_at: string;
  status: string;
  type: string;
  goal: string;
  approvals: Array<{ artifact_hash: string; by: string; authority: string; at: string }>;
}

function ticketDoc(approvalCurrent: boolean): TicketDoc {
  const base = {
    schema: "ticket",
    schema_version: 1,
    id: "ticket-1",
    project: { id: "demo" },
    run_id: null,
    created_by: { role: "implementer" },
    inputs: [],
    source_revision: null,
    created_at: AT,
    status: "draft",
    type: "decision",
    goal: "the goal it was approved with",
  };
  const current = approvalCurrent ? base : { ...base, goal: "a different goal added after approval" };
  return {
    ...current,
    approvals: [{ artifact_hash: artifactHash(base), by: "human", authority: "explicit", at: "2026-09-19T11:00:00Z" }],
  };
}

function rewriteTimeoutLanes(doc: ReviewDocument): ReviewDocument {
  const rewritten = structuredClone(doc);
  rewritten.lanes = rewritten.lanes.map((lane) => {
    if (lane.state !== "unavailable" || lane.reason === undefined || !isTimeoutReason(lane.reason)) return lane;
    return {
      role: lane.role,
      required: true as const,
      state: "covered",
      seat: lane.seat,
      verdict: "approve",
      raw_output: { id: `raw-${lane.role.replaceAll("/", "-")}`, hash: HASH_A },
    };
  });
  return rewritten;
}

function pushRules(into: string[], issues: readonly { rule: string }[]): void {
  for (const issue of issues) into.push(issue.rule);
}

type ReviewForArtifacts = ReviewDocument & { artifact_probe?: { charter_hash: string } };

function artifactRules(
  world: World,
  model: Model,
  review: ReviewForArtifacts,
  findings: readonly FindingDocument[],
  ticket: TicketDoc,
): string[] {
  const resolved = findings.some((doc) => doc.status === "resolved");
  const stale = model.approvalHash !== model.currentHash;
  // Open findings and a current ticket approval cannot fire approval.stale,
  // finding.self-closed, finding.closed-without-receipt, grant.charter-hash-unknown,
  // or ticket.decision-dispatched-as-implementation on these templates.
  if (!resolved && !stale) return [];
  const key = artifactHash({ review, findings, ticket });
  const cached = world.artifactRuleCache.get(key);
  if (cached !== undefined) return cached;
  const rules: string[] = [];
  pushRules(rules, checkArtifacts(world.ctx));
  world.artifactRuleCache.set(key, rules);
  return rules;
}

export function inspectImpl(world: World, model: Model): ImplView {
  const templates = join(world.ctx.root, "templates");
  unlinkIfPresent(join(templates, "finding.json"));
  unlinkIfPresent(join(templates, "review-probe.json"));
  unlinkIfPresent(join(templates, "finding-a.json"));
  unlinkIfPresent(join(templates, "finding-b.json"));
  const submitted = world.submitTimeoutAsCovered ? rewriteTimeoutLanes(reviewDoc(model)) : reviewDoc(model);
  const review =
    world.grantOnApprovedReview && model.verdict === "approved"
      ? { ...submitted, artifact_probe: { charter_hash: HASH_A } }
      : submitted;
  const findings = model.findings.map(findingDoc);
  const ticket = ticketDoc(model.approvalHash === model.currentHash);
  writeFileSync(join(templates, "review.json"), JSON.stringify(review));
  for (const finding of findings) {
    writeFileSync(join(templates, `${finding.id}.json`), JSON.stringify(finding));
  }
  writeFileSync(join(templates, "ticket.json"), JSON.stringify(ticket));

  const rules: string[] = [];
  const indexed = indexDocuments([
    { file: "templates/review.json", doc: submitted },
    ...findings.map((doc) => ({ file: `templates/${doc.id}.json`, doc })),
  ]);
  pushRules(rules, checkDocument("templates/review.json", submitted, indexed));
  const validateReview = world.schemas.validatorFor("review");
  if (validateReview !== undefined && !validateReview(submitted)) rules.push("schemas.document-invalid");
  rules.push(...artifactRules(world, model, review, findings, ticket));
  for (const finding of findings) {
    pushRules(rules, checkDocument(`templates/${finding.id}.json`, finding, indexed));
  }
  const probeRules: string[] = [];
  if (model.attemptedLaneRewrite) {
    const probe = rewriteTimeoutLanes(submitted);
    writeFileSync(join(templates, "review-probe.json"), JSON.stringify(probe));
    pushRules(probeRules, checkDocument("templates/review-probe.json", probe, indexed));
  }
  return {
    rules,
    probeRules,
    lanes: submitted.lanes,
    findingsSoftened: findings.some((doc) => doc.synthesis !== undefined),
  };
}

export function timeoutStillBlocks(model: Model, rules: readonly string[]): boolean {
  const timeout = model.lanes.some(
    (lane) => lane.required && lane.state === "unavailable" && lane.reason !== null && isTimeoutReason(lane.reason),
  );
  if (!timeout || model.verdict !== "approved") return true;
  return rules.includes("review.unavailable-required-lane-blocks-approval");
}
