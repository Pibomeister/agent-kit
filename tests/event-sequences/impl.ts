/**
 * Drive the real runner and validators with the same events the reference model sees.
 */
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { loadCatalog } from "../../src/catalog/load.ts";
import { Runner } from "../../src/runner/core.ts";
import type { StandingGrant } from "../../src/runner/types.ts";
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

export interface World {
  runner: Runner;
  twin: Runner;
  runId: string;
  restore: () => void;
  ctx: CheckContext;
  schemas: SchemaSet;
  lastSeatError: string | null;
  lastPublishError: string | null;
  lastChargeStatus: string | null;
}

interface LaneRecord {
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
  project: string;
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
}

function standingGrant(hash: string, runId: string): StandingGrant {
  return { charter_hash: hash, covers: "autopilot.start", controller: "firstmate", run_id: runId };
}

function writeCharter(privateDir: string, limit: number) {
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
    work_source: { kind: "ticket", ref: { id: "toy-ticket", hash: HASH_A } },
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
  const result = Bun.spawnSync(["git", ...args], { cwd });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

export function createWorld(): World {
  const dir = processScratch("ak-event-seq-");
  const worker = join(dir, "worker");
  const privateDir = join(dir, "private");
  mkdirSync(worker);
  mkdirSync(privateDir);
  writeFileSync(join(worker, ".gitignore"), ".runner-requests/\n");
  writeFileSync(join(worker, "README.md"), "toy worktree\n");
  git(worker, ["init", "-q"]);
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
  const charter = writeCharter(privateDir, 3);
  const runner = new Runner(privateDir, worker, ROOT);
  const twin = new Runner(privateDir, worker, ROOT);
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
  return {
    runner,
    twin,
    runId: "toy-run",
    ctx: { root: artifactRoot, catalog: loaded.catalog },
    schemas: compileSchemas(ROOT),
    lastSeatError: null,
    lastPublishError: null,
    lastChargeStatus: null,
    restore: () => {
      writeFileSync(runPath, runSnap);
      if (ledgerSnap !== null) writeFileSync(ledgerPath, ledgerSnap);
      if (existsSync(decisionPath)) unlinkSync(decisionPath);
    },
  };
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
  const run = world.twin.status(world.runId);
  const entries: BudgetEntry[] = [];
  for (const [key, used] of Object.entries(run.budget_consumption)) {
    if (isFiniteNumber(used)) entries.push({ key, used });
  }
  return entries;
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
    case "restart":
    case "rename-run":
      world.twin.status(world.runId);
      return;
    case "cancel":
      caughtMessage(() => {
        world.runner.cancel(world.runId, "supervisor-1", "stop the run");
      });
      return;
    case "publish": {
      const input = HASH_A;
      world.lastPublishError = caughtMessage(() => {
        world.runner.effect(
          world.runId,
          "kb-publish",
          "toy",
          input,
          () => input,
          () => undefined,
        );
      });
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
    default:
      return;
  }
}

function laneRecord(lane: Lane): LaneRecord {
  const seat = {
    filled_by: lane.filledBy ?? "reviewer-a",
    independent_of_author: lane.independentOfAuthor,
    context_isolated: true,
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
  const at = "2026-09-19T10:00:00Z";
  const location = {
    repo: "demo",
    revision: "a".repeat(40),
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
    created_at: at,
    status: finding.status,
    title: "A caller dereferences a value the callee may return null for",
    lane: "correctness",
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
      approval: { artifact_hash: HASH_A, by: "human", authority: "explicit", at },
    };
  }
  if (finding.status === "resolved") {
    doc.closure_receipt = {
      verification: { id: "verification-1", schema: "verification", hash: HASH_B },
      closed_by: finding.closer ?? AUTHOR_ROLE,
      independent: finding.independentReceipt,
      at,
    };
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
    project: "demo",
    run_id: null,
    created_by: { role: "runner" },
    inputs: [],
    source_revision: { repo: "app", revision: "a".repeat(40) },
    created_at: "2026-09-19T00:00:00Z",
    status: "complete",
    mode: model.mode,
    comparison_base: { repo: "app", revision: "a".repeat(40) },
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
  }
  return doc;
}

export function reviewRules(model: Model): string[] {
  const doc = reviewDoc(model);
  const findings = model.findings.map((item, i) => ({
    file: `templates/finding-${i}.json`,
    doc: findingDoc(item),
  }));
  return checkDocument(
    "templates/review.json",
    doc,
    indexDocuments([{ file: "templates/review.json", doc }, ...findings]),
  ).map((issue) => issue.rule);
}

export function findingRules(world: World, model: Model): string[] {
  const rules: string[] = [];
  for (const finding of model.findings) {
    const doc = findingDoc(finding);
    writeFileSync(join(world.ctx.root, "templates", "finding.json"), JSON.stringify(doc));
    const ticketPath = join(world.ctx.root, "templates", "ticket.json");
    if (existsSync(ticketPath)) unlinkSync(ticketPath);
    for (const issue of checkArtifacts(world.ctx)) {
      if (issue.file === "templates/finding.json") rules.push(issue.rule);
    }
    for (const issue of checkDocument(
      "templates/finding.json",
      doc,
      indexDocuments([{ file: "templates/finding.json", doc }]),
    )) {
      rules.push(issue.rule);
    }
    const validate = world.schemas.validatorFor("finding");
    if (validate !== undefined && !validate(doc)) rules.push("schemas.document-invalid");
  }
  if (model.approvalHash !== model.currentHash) {
    const artifact = {
      schema: "ticket",
      schema_version: 1,
      id: "ticket-1",
      project: { id: "demo" },
      run_id: null,
      created_by: { role: "implementer" },
      inputs: [],
      source_revision: null,
      created_at: "2026-09-19T10:00:00Z",
      status: "draft",
      type: "decision",
      goal: "the goal it was approved with",
    };
    const changed = {
      ...artifact,
      goal: "a different goal added after approval",
      approvals: [
        { artifact_hash: artifactHash(artifact), by: "human", authority: "explicit", at: "2026-09-19T11:00:00Z" },
      ],
    };
    writeFileSync(join(world.ctx.root, "templates", "ticket.json"), JSON.stringify(changed));
    for (const issue of checkArtifacts(world.ctx)) {
      if (issue.rule === "approval.stale") rules.push(issue.rule);
    }
  }
  return rules;
}

export function timeoutStillBlocks(model: Model, rules: readonly string[]): boolean {
  const timeout = model.lanes.some(
    (lane) => lane.required && lane.state === "unavailable" && lane.reason !== null && isTimeoutReason(lane.reason),
  );
  if (!timeout || model.verdict !== "approved") return true;
  return rules.includes("review.unavailable-required-lane-blocks-approval");
}
