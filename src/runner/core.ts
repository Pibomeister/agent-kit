/** Runner-owned state. Only the service process imports this module for mutations. */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import type { ValidateFunction } from "ajv";

import { artifactHash, sha256Hex } from "../util/hash.ts";
import { git, takeSnapshot, type Snapshot } from "../lifecycle/gate.ts";
import { compileSchemas } from "../validation/schemas.ts";
import { PrivateFileEvidenceStore } from "./evidence.ts";
import type {
  Card,
  CardInput,
  Charter,
  Decision,
  Effect,
  Evidence,
  InvocationPolicy,
  OperationResult,
  Run,
  RunLedger,
  StandingGrant,
} from "./types.ts";

interface StageStep {
  from: string[];
  to: string;
  next: string | null;
  budget?: string;
}
const STAGE = new Map<string, StageStep>([
  [
    "align.run",
    { from: ["created", "grounding", "alignment"], to: "alignment", next: "bound.run", budget: "alignment_questions" },
  ],
  ["bound.run", { from: ["alignment", "planning"], to: "planning", next: "build.dispatch", budget: "tickets" }],
  ["build.dispatch", { from: ["planning"], to: "building", next: "verify.record" }],
  [
    "review.full",
    { from: ["verifying", "repairing"], to: "reviewing", next: "review.readiness", budget: "review_rounds" },
  ],
  ["review.readiness", { from: ["reviewing"], to: "ready-to-ship", next: "ship.prepare" }],
  ["ship.prepare", { from: ["ready-to-ship"], to: "ready-to-ship", next: "pr-open" }],
]);
const LIMIT_NAME = new Map([
  ["alignment_questions", "alignment-questions"],
  ["tickets", "tickets"],
  ["review_rounds", "review-rounds"],
]);
const HASH = /^sha256:[a-f0-9]{64}$/;
const REVISION = /^[a-f0-9]{40}([a-f0-9]{24})?$/;
const ID = /^[a-z0-9][a-z0-9-]*$/;
const EFFECTS = new Set([
  "remote-push",
  "pr-open",
  "pr-comment",
  "pr-thread-resolve",
  "kb-publish",
  "tracker-write",
  "local-commit",
  "branch-create",
]);
const EFFECT_ACTION = new Map([
  ["remote-push", "push-branch"],
  ["pr-open", "open-pr"],
  ["pr-comment", "reply-pr-comment"],
  ["pr-thread-resolve", "resolve-pr-thread"],
  ["kb-publish", "publish-lesson"],
  ["tracker-write", "approve-ticket"],
  ["local-commit", "local-commit"],
  ["branch-create", "local-commit"],
]);
const STOPPED = new Set(["needs-input", "cap-reached", "failed", "cancelled", "complete"]);
const RUNTIME_SCRATCH_DIRS = [".omc", ".omx"] as const;
const ACTION_FOR = new Map([
  ["spec-approval", "approve-spec"],
  ["ticket-approval", "approve-ticket"],
  ["build-go", "start-implementation-ticket"],
  ["finding-adjudication", "adjudicate-finding"],
  ["ship-pr", "open-pr"],
]);
type DecisionDocument = { schema: string; id: string; checkpoint: string };

function inside(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function canonicalFuturePath(path: string): string {
  let existing = resolve(path);
  const missing: string[] = [];
  while (!existsSync(existing)) {
    missing.unshift(basename(existing));
    existing = dirname(existing);
  }
  return join(realpathSync(existing), ...missing);
}

function digest(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function approved(decision: Decision): boolean {
  const choice = decision.answer?.choice ?? decision.card.judgments[0]?.choice;
  return decision.result.status === "complete" && choice === decision.card.approve;
}

function charterDigest(charter: Charter): string {
  const blanked = structuredClone(charter);
  blanked.immutability.hash = "";
  return artifactHash(blanked);
}

export class Runner {
  readonly stateDir: string;
  readonly workerRoot: string;
  private readonly covers: Map<string, { authority: string; covers: string }>;
  private readonly decisionSchema: ValidateFunction<object>;
  private readonly ledgerSchema: ValidateFunction<RunLedger>;
  private readonly runSchema: ValidateFunction<Run>;
  private readonly validateCharter: ValidateFunction<Charter>;
  private readonly enforceSnapshot: boolean;
  private readonly sharedGitDir: string | null;
  private readonly evidenceStore: PrivateFileEvidenceStore;

  constructor(stateDir: string, workerRoot: string, kitRoot: string, enforceSnapshot = false) {
    const requestedStateDir = canonicalFuturePath(stateDir);
    this.workerRoot = realpathSync(workerRoot);
    this.enforceSnapshot = enforceSnapshot;
    if (inside(requestedStateDir, this.workerRoot)) throw new Error("runner state is worker-writable");
    const commonDir = git(this.workerRoot, ["rev-parse", "--git-common-dir"]);
    this.sharedGitDir =
      commonDir.code === 0
        ? realpathSync(isAbsolute(commonDir.text) ? commonDir.text : join(this.workerRoot, commonDir.text))
        : null;
    if (this.sharedGitDir !== null && inside(requestedStateDir, this.sharedGitDir))
      throw new Error("runner state cannot use the shared git common directory");
    mkdirSync(requestedStateDir, { recursive: true, mode: 0o700 });
    this.stateDir = realpathSync(requestedStateDir);
    if (inside(this.stateDir, this.workerRoot)) throw new Error("runner state resolves into worker root");
    if (this.sharedGitDir !== null && inside(this.stateDir, this.sharedGitDir))
      throw new Error("runner state resolves into the shared git common directory");
    this.evidenceStore = new PrivateFileEvidenceStore(this.stateDir);
    const schemas = compileSchemas(kitRoot);
    if (schemas.issues.some((issue) => issue.severity === "error"))
      throw new Error("runner cannot compile charter schema");
    const charterSchema = schemas.ajv.getSchema<Charter>("https://agent-kit.local/schemas/charter.schema.json");
    const decisionSchema = schemas.ajv.getSchema<object>("https://agent-kit.local/schemas/decision.schema.json");
    const ledgerSchema = schemas.ajv.getSchema<RunLedger>("https://agent-kit.local/schemas/run-ledger.schema.json");
    if (charterSchema === undefined || decisionSchema === undefined || ledgerSchema === undefined)
      throw new Error("runner cannot compile ledger schemas");
    this.validateCharter = charterSchema;
    this.decisionSchema = decisionSchema;
    this.ledgerSchema = ledgerSchema;
    this.runSchema = schemas.ajv.compile<Run>({
      type: "object",
      required: [
        "id",
        "charter_path",
        "charter_hash",
        "charter",
        "start_authority",
        "implementer",
        "excluded_actors",
        "revision",
        "diff_hash",
        "created_at",
        "run_state",
        "next_permitted_action",
        "cards",
        "evidence",
        "decisions",
        "budget_consumption",
        "effects",
        "events",
        "open_escalation",
      ],
      properties: {
        id: { type: "string" },
        charter_path: { type: "string" },
        charter_hash: { type: "string" },
        charter: { $ref: "https://agent-kit.local/schemas/charter.schema.json" },
        start_authority: { type: "object", required: ["kind", "grant"] },
        implementer: { type: "string" },
        excluded_actors: { type: "array", items: { type: "string" } },
        revision: { type: "string" },
        diff_hash: { type: "string" },
        created_at: { type: "string" },
        run_state: { type: "string" },
        next_permitted_action: { type: ["string", "null"] },
        cards: { type: "object" },
        evidence: { type: "object" },
        decisions: { type: "array" },
        budget_consumption: { type: "object" },
        effects: { type: "object" },
        events: { type: "object" },
        open_escalation: { type: ["object", "null"] },
      },
    });
    const policySchema = schemas.ajv.compile<InvocationPolicy>({
      type: "object",
      required: ["operations"],
      properties: {
        operations: {
          type: "array",
          items: {
            type: "object",
            required: ["id", "authority"],
            properties: {
              id: { type: "string" },
              authority: { type: "string" },
              grant: { type: "object", required: ["covers"], properties: { covers: { type: "string" } } },
            },
          },
        },
      },
    });
    const policyValue: unknown = parseYaml(readFileSync(join(kitRoot, "policies", "invocation.yaml"), "utf8"));
    if (!policySchema(policyValue)) throw new Error("runner cannot parse invocation policy");
    this.covers = new Map();
    for (const operation of policyValue.operations) {
      if (operation.grant === undefined) continue;
      this.covers.set(operation.id, { authority: operation.authority, covers: operation.grant.covers });
    }
    this.covers.set("build.dispatch", { authority: "delegated-grant", covers: "build-go" });
  }

  private path(id: string): string {
    if (!ID.test(id)) throw new Error("invalid run id");
    return join(this.stateDir, `${id}.json`);
  }

  assertPrivatePath(path: string): void {
    const canonical = canonicalFuturePath(path);
    if (inside(canonical, this.workerRoot)) throw new Error("path is inside the worker root");
    if (this.sharedGitDir !== null && inside(canonical, this.sharedGitDir))
      throw new Error("path is inside the shared git common directory");
  }

  private observedSnapshot(): Snapshot | null {
    if (!this.enforceSnapshot) return null;
    const snapshot = takeSnapshot(this.workerRoot, { ignoreUntrackedDirs: RUNTIME_SCRATCH_DIRS });
    if (snapshot instanceof Object) return snapshot;
    throw new Error(`runner cannot observe worker revision: ${snapshot}`);
  }

  private current(run: Run): boolean {
    const observed = this.observedSnapshot();
    return observed === null || (observed.revision === run.revision && observed.diff_hash === run.diff_hash);
  }

  private load(id: string): Run {
    const runValue: unknown = JSON.parse(readFileSync(this.path(id), "utf8"));
    if (!this.runSchema(runValue)) throw new Error(`runner state is invalid: ${JSON.stringify(this.runSchema.errors)}`);
    const run = runValue;
    const charterValue: unknown = JSON.parse(readFileSync(run.charter_path, "utf8"));
    if (!this.validateCharter(charterValue)) throw new Error("charter no longer validates");
    const charter = charterValue;
    if (charterDigest(charter) !== run.charter_hash || JSON.stringify(charter) !== JSON.stringify(run.charter))
      throw new Error("charter changed; this run cannot resume");
    return run;
  }

  private save(run: Run): void {
    const entries = run.decisions.map((decision) => {
      const doc = this.decisionArtifact(run, decision);
      if (!this.decisionSchema(doc))
        throw new Error(`runner decision artifact invalid: ${JSON.stringify(this.decisionSchema.errors)}`);
      this.atomic(join(this.stateDir, `${run.id}-${decision.card.id}.decision.json`), doc);
      const outcome: "ruling" | "escalation" =
        (decision.answer?.refusal ?? decision.result).status === "complete" ? "ruling" : "escalation";
      const entry = {
        checkpoint: this.covers.get(decision.card.operation)?.covers ?? "align-answer",
        decision: { id: decision.card.id, schema: "decision", hash: artifactHash(doc) },
        outcome,
        ruling: {
          what: decision.card.judgments[0]?.choice ?? "unavailable",
          why: "Independent seats agreed under a validated grant",
          cost_if_wrong: "The approved artifact would need correction",
        },
        answered: decision.answer !== undefined,
      };
      if (outcome === "ruling")
        return { checkpoint: entry.checkpoint, decision: entry.decision, outcome: entry.outcome, ruling: entry.ruling };
      const answer = decision.answer;
      return {
        checkpoint: entry.checkpoint,
        decision: entry.decision,
        outcome: entry.outcome,
        answered: entry.answered,
        ...(answer === undefined
          ? {}
          : { answer: { choice: answer.choice, by: answer.by, rationale: answer.rationale, at: answer.at } }),
      };
    });
    const ledger = {
      schema: "run-ledger" as const,
      schema_version: 1,
      id: `${run.id}-ledger`,
      project: run.charter.project,
      run_id: run.id,
      created_by: { role: "runner" },
      inputs: [{ id: run.charter.id, hash: run.charter_hash }],
      source_revision: {
        repo: run.charter.repos[0]?.repo ?? "unavailable",
        revision: run.revision,
        diff_hash: run.diff_hash,
      },
      created_at: run.created_at,
      status: run.run_state,
      charter: { hash: run.charter_hash },
      entries,
    };
    if (!this.ledgerSchema(ledger))
      throw new Error(`runner ledger invalid: ${JSON.stringify(this.ledgerSchema.errors)}`);
    this.atomic(join(this.stateDir, `${run.id}.ledger.json`), ledger);
    const target = this.path(run.id);
    this.atomic(target, run);
  }

  private atomic(target: string, value: Run | RunLedger | DecisionDocument): void {
    const partial = `${target}.partial-${process.pid}`;
    writeFileSync(partial, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    renameSync(partial, target);
  }

  private decisionArtifact(run: Run, decision: Decision) {
    const { card, at } = decision;
    const result = decision.answer?.refusal ?? decision.result;
    const charterSeats = run.charter.supervisors.seats;
    const evidence = card.evidence.flatMap((id) => {
      const found = run.evidence[id];
      return found === undefined ? [] : [{ ref: id, kind: "receipt", hash: found.hash }];
    });
    const charterPermits =
      this.covers.get(card.operation)?.covers === card.grant.covers && card.grant.charter_hash === run.charter_hash;
    const declaredCheckpoint = this.covers.get(card.operation)?.covers ?? "align-answer";
    const checkpointInCharter = run.charter.checkpoints.includes(declaredCheckpoint);
    const evidencePresent = evidence.length === card.evidence.length && card.evidence.length > 0;
    const seatsIndependent = card.judgments.length === 2 && new Set(card.judgments.map((j) => j.actor)).size === 2;
    const checks = {
      charter_permits: charterPermits,
      required_evidence_present: evidencePresent,
      seats_independent: seatsIndependent,
      checkpoint_in_charter: checkpointInCharter,
    };
    const failedChecks = Object.entries(checks)
      .filter(([, value]) => !value)
      .map(([key]) => key);
    const decided = result.status === "complete";
    const escalation = result.escalation ?? {
      need: "Runner cap was reached",
      options: card.options.map((option) => ({ id: option, summary: option })),
      tried: [{ ref: card.evidence[0] ?? run.charter_hash, kind: "receipt" as const }],
      default: card.options[0] ?? "stop",
      charter_rule: `runner:budget/${result.cap?.limit ?? "unknown"}`,
      blocked: [card.id],
    };
    const document = {
      schema: "decision",
      schema_version: 1,
      id: card.id,
      project: run.charter.project,
      run_id: run.id,
      created_by: { role: "runner" },
      inputs: [{ id: run.charter.id, hash: run.charter_hash }],
      source_revision: {
        repo: run.charter.repos[0]?.repo ?? "unavailable",
        revision: decision.revision,
        diff_hash: decision.diff_hash,
      },
      created_at: at,
      status: decided ? "ruled" : "blocked",
      checkpoint: declaredCheckpoint,
      question: card.question,
      options: card.options.map((option) => ({ id: option, summary: option })),
      evidence,
      required_evidence: card.evidence,
      affected_artifacts: [{ id: `${card.id}-subject`, hash: card.artifact_hash }],
      charter: { hash: run.charter_hash, rule: `charter:checkpoints/${declaredCheckpoint}`, grant: card.grant },
      seats: charterSeats.map((seat) => ({
        id: seat.id,
        filled_by: seat.filled_by,
        independent: true,
        may_implement: false,
      })),
      judgments:
        card.judgments.length === 0
          ? undefined
          : card.judgments.map((j) => ({
              seat: j.seat,
              by: j.actor,
              choice: j.choice,
              rationale: j.rationale,
              unresolved_assumptions: [],
              escalate: false,
              saw_other_judgment: false,
            })),
      agreement: card.judgments.length === 2 && card.judgments[0]?.choice === card.judgments[1]?.choice,
      authority_check: {
        deterministic: true,
        ...checks,
        both_judgments_returned: card.judgments.length === 2,
        result: failedChecks.length === 0 ? "pass" : "fail",
        failed_checks: failedChecks.length === 0 ? undefined : failedChecks,
      },
      ruling: {
        outcome: decided ? "decided" : "blocked",
        chosen_option: decided ? card.judgments[0]?.choice : null,
        at,
        recorded_by: "runner",
        note: result.status,
      },
      grants_issued: decided && card.judgments[0]?.choice === card.approve ? [card.grant] : [],
      escalation: decided ? undefined : escalation,
      result,
    };
    return document;
  }

  ledger(id: string): RunLedger {
    // The restart record is authoritative if a crash interrupted a multi-file artifact write.
    this.save(this.load(id));
    const value: unknown = JSON.parse(readFileSync(join(this.stateDir, `${id}.ledger.json`), "utf8"));
    if (!this.ledgerSchema(value)) throw new Error("runner ledger no longer validates");
    return value;
  }

  packet(id: string, cardId: string) {
    const run = this.load(id);
    const card = run.cards[cardId];
    if (card === undefined) throw new Error("unknown checkpoint card");
    return {
      run: run.id,
      charter_hash: run.charter_hash,
      revision: run.revision,
      diff_hash: run.diff_hash,
      card: {
        id: card.id,
        question: card.question,
        options: card.options,
        artifact_hash: card.artifact_hash,
        evidence: card.evidence.map((evidenceId) => ({ id: evidenceId, hash: run.evidence[evidenceId]?.hash ?? null })),
      },
    };
  }

  start(
    id: string,
    charterPath: string,
    implementer: string,
    revision: string,
    standingGrant: StandingGrant,
    excludedActors: string[] = [],
  ): Run {
    if (!REVISION.test(revision)) throw new Error("revision must be a full version-control object id");
    const observed = this.observedSnapshot();
    if (observed !== null && observed.revision !== revision)
      throw new Error("start revision differs from worker checkout");
    const source = realpathSync(charterPath);
    this.assertPrivatePath(source);
    const charterValue: unknown = JSON.parse(readFileSync(source, "utf8"));
    if (!this.validateCharter(charterValue))
      throw new Error(`invalid charter: ${JSON.stringify(this.validateCharter.errors)}`);
    const charter = charterValue;
    const immutable = charter.immutability;
    const hash = charterDigest(charter);
    if (charter.status !== "active" || immutable.hash !== hash || realpathSync(immutable.location) !== source)
      throw new Error("charter is inactive, moved or has a mismatched hash");
    if (!charter.approvals.some((a) => a.by === "human" && a.authority === "explicit" && a.artifact_hash === hash))
      throw new Error("active charter lacks a human approval bound to its hash");
    for (const sensitive of charter.sensitive_grants ?? []) {
      const approval = sensitive.approval;
      if (approval.artifact_hash !== hash || approval.by !== "human" || approval.authority !== "explicit")
        throw new Error("sensitive grant lacks human approval bound to this charter");
    }
    if (charter.run_id !== id) throw new Error("run id does not match charter");
    if (
      !["runner-grants", "trusted-evidence", "independent-context", "event-delivery"].every((capability) =>
        charter.allowed_capabilities.includes(capability),
      )
    )
      throw new Error(
        "standing start requires charter-approved runner grants, trusted evidence, independent context and event delivery",
      );
    if (
      standingGrant.charter_hash !== hash ||
      standingGrant.run_id !== id ||
      standingGrant.covers !== "autopilot.start" ||
      standingGrant.controller !== "firstmate" ||
      !charter.standing_grants?.some(
        (entry) => entry.covers === standingGrant.covers && entry.controller === standingGrant.controller,
      )
    )
      throw new Error("standing grant is absent, forged or unbound to the approved charter");
    try {
      this.load(id);
      throw new Error("run already exists");
    } catch (cause) {
      if (!(cause instanceof Error && "code" in cause && cause.code === "ENOENT")) throw cause;
    }
    const run: Run = {
      id,
      charter_path: source,
      charter_hash: hash,
      charter,
      start_authority: { kind: "standing-grant", grant: standingGrant },
      implementer,
      excluded_actors: [...new Set([implementer, ...excludedActors])],
      revision,
      diff_hash: observed?.diff_hash ?? `sha256:${sha256Hex("")}`,
      created_at: new Date().toISOString(),
      run_state: "created",
      next_permitted_action: "align.run",
      cards: {},
      evidence: {},
      decisions: [],
      budget_consumption: {},
      effects: {},
      events: {},
      open_escalation: null,
    };
    this.save(run);
    return run;
  }

  status(id: string): Run {
    return this.load(id);
  }

  collect(id: string, evidenceId: string, sourcePath: string, revision: string, kind: string): Evidence {
    const run = this.load(id);
    if (STOPPED.has(run.run_state)) throw new Error("run is stopped; no new gate evidence can be collected");
    if (!ID.test(evidenceId)) throw new Error("invalid evidence id");
    const source = realpathSync(sourcePath);
    try {
      this.assertPrivatePath(source);
    } catch {
      throw new Error("worker-written evidence is not trusted");
    }
    if (revision !== run.revision || !this.current(run)) throw new Error("evidence is stale for current revision");
    const bytes = readFileSync(source);
    const ref = this.evidenceStore.put(id, evidenceId, bytes);
    const hash = digest(bytes);
    if (digest(this.evidenceStore.read(ref)) !== hash) throw new Error("evidence store read-back did not match");
    const evidence = { id: evidenceId, hash, revision, diff_hash: run.diff_hash, kind, ref };
    run.evidence[evidenceId] = evidence;
    this.save(run);
    return evidence;
  }

  revision(id: string, revision: string): Run {
    if (!REVISION.test(revision)) throw new Error("revision must be a full version-control object id");
    const run = this.load(id);
    if (STOPPED.has(run.run_state)) throw new Error("run is stopped; revision cannot advance");
    const observed = this.observedSnapshot();
    if (observed !== null && observed.revision !== revision) throw new Error("revision differs from worker checkout");
    const diffHash = observed?.diff_hash ?? run.diff_hash;
    const changed = run.revision !== revision || run.diff_hash !== diffHash;
    run.revision = revision;
    run.diff_hash = diffHash;
    if (changed && ["verifying", "reviewing", "ready-to-ship", "pr-open"].includes(run.run_state)) {
      run.run_state = "repairing";
      run.next_permitted_action = "verify.record";
    }
    this.save(run);
    return run;
  }

  syncRevision(id: string): Run {
    const observed = this.observedSnapshot();
    if (observed === null) throw new Error("runner checkout observation is unavailable");
    return this.revision(id, observed.revision);
  }

  recordOutput(id: string, evidenceId: string, output: Buffer, kind: string): Evidence {
    const run = this.load(id);
    if (STOPPED.has(run.run_state)) throw new Error("run is stopped; no new gate evidence can be recorded");
    if (!ID.test(evidenceId) || !this.current(run))
      throw new Error("runner output cannot be recorded for a stale snapshot");
    const hash = digest(output);
    const existing = run.evidence[evidenceId];
    if (existing !== undefined) {
      if (existing.hash !== hash || existing.revision !== run.revision || existing.diff_hash !== run.diff_hash)
        throw new Error("evidence id was reused for different output");
      return existing;
    }
    const ref = this.evidenceStore.put(id, evidenceId, output);
    if (digest(this.evidenceStore.read(ref)) !== hash) throw new Error("evidence store read-back did not match");
    const evidence = { id: evidenceId, hash, revision: run.revision, diff_hash: run.diff_hash, kind, ref };
    run.evidence[evidenceId] = evidence;
    this.save(run);
    return evidence;
  }

  prepare(id: string, card: CardInput): Card {
    const run = this.load(id);
    if (STOPPED.has(run.run_state)) throw new Error("run is stopped; no new checkpoint can be prepared");
    if (
      !ID.test(card.id) ||
      !HASH.test(card.artifact_hash) ||
      !card.question ||
      card.options.length < 2 ||
      card.options.length > 6 ||
      card.options.some((option) => !ID.test(option)) ||
      new Set(card.options).size !== card.options.length ||
      !card.options.includes(card.approve)
    )
      throw new Error("invalid checkpoint card: options must be unique ids and include the approving option");
    const existing = run.cards[card.id];
    if (existing !== undefined) {
      if (JSON.stringify({ ...existing, judgments: [] }) !== JSON.stringify({ ...card, judgments: [] }))
        throw new Error("checkpoint card changed");
      return existing;
    }
    if (
      run.decisions.some(
        (d) =>
          d.answer !== undefined &&
          d.answer.choice !== "retry" &&
          d.card.operation === card.operation &&
          d.card.artifact_hash === card.artifact_hash &&
          d.revision === run.revision &&
          d.diff_hash === run.diff_hash,
      )
    )
      throw new Error(
        "a human ruling settled this card at this revision; revise its artifact before preparing another",
      );
    const prepared = { ...card, judgments: [] };
    run.cards[card.id] = prepared;
    this.save(run);
    return prepared;
  }

  judge(
    id: string,
    cardId: string,
    seat: string,
    actor: string,
    dispatch: string,
    choice: string,
    inputDispatches: string[],
    lineage: string[] = [actor],
    rationale = "Independent supervisor judgment",
  ): Card {
    const run = this.load(id);
    const card = run.cards[cardId];
    if (card === undefined) throw new Error("unknown checkpoint card");
    const prior = card.judgments.find((judgment) => judgment.seat === seat);
    if (prior !== undefined) {
      if (
        prior.actor === actor &&
        prior.dispatch === dispatch &&
        prior.choice === choice &&
        prior.rationale === rationale &&
        JSON.stringify(prior.lineage) === JSON.stringify(lineage) &&
        JSON.stringify(prior.input_dispatches) === JSON.stringify(inputDispatches)
      )
        return card;
      throw new Error("seat judgment changed after first submission");
    }
    if (STOPPED.has(run.run_state)) throw new Error("run is stopped; no new judgment can be submitted");
    const seats = run.charter.supervisors.seats.map((s) => s.id);
    if (
      !seats.includes(seat) ||
      !card.options.includes(choice) ||
      run.excluded_actors.some((excluded) => actor === excluded || lineage.includes(excluded)) ||
      !ID.test(dispatch) ||
      !lineage.includes(actor)
    )
      throw new Error("invalid or excluded seat");
    if (
      card.judgments.some(
        (j) => j.seat === seat || j.actor === actor || j.dispatch === dispatch || inputDispatches.includes(j.dispatch),
      )
    )
      throw new Error("seat is not independently dispatched");
    if (inputDispatches.length > 0) throw new Error("seat input includes another dispatch");
    card.judgments.push({ seat, actor, dispatch, choice, rationale, input_dispatches: inputDispatches, lineage });
    this.save(run);
    return card;
  }

  private refuse(run: Run, card: Card, rule: string, reason: string): OperationResult {
    const defaultOption = card.options[0];
    if (defaultOption === undefined) throw new Error("checkpoint has no default option");
    const escalation = {
      need: reason,
      options: card.options.map((option) => ({ id: option, summary: option })),
      tried: [{ ref: card.evidence[0] ?? run.charter_hash, kind: "receipt" as const }],
      default: defaultOption,
      charter_rule: rule,
      blocked: [card.id],
    };
    const result: OperationResult = {
      operation: card.operation,
      status: "needs-input",
      next_permitted_action: null,
      escalation,
    };
    run.resume = { run_state: run.run_state, next_permitted_action: run.next_permitted_action };
    run.run_state = "needs-input";
    run.next_permitted_action = null;
    run.open_escalation = escalation;
    run.decisions.push({
      card,
      result,
      at: new Date().toISOString(),
      revision: run.revision,
      diff_hash: run.diff_hash,
    });
    this.save(run);
    return result;
  }

  authorize(id: string, cardId: string): OperationResult | null {
    const run = this.load(id);
    const prior = run.decisions.find((d) => d.card.id === cardId);
    if (prior !== undefined) return prior.result;
    const card = run.cards[cardId];
    if (card === undefined) throw new Error("unknown checkpoint card");
    if (STOPPED.has(run.run_state)) throw new Error("run is stopped; no new checkpoint can be decided");
    const step = STAGE.get(card.operation);
    const policy = this.covers.get(card.operation);
    if (
      step === undefined ||
      policy === undefined ||
      policy.authority === "explicit" ||
      policy.authority === "model" ||
      policy.covers !== card.grant.covers ||
      card.grant.charter_hash !== run.charter_hash ||
      (card.grant.decision !== undefined && card.grant.decision !== card.id)
    )
      return this.refuse(run, card, "runner:grant", "Grant does not cover this delegated operation or charter");
    const charter = run.charter;
    if (
      !charter.allowed_capabilities.includes("runner-grants") ||
      !charter.allowed_capabilities.includes("trusted-evidence")
    )
      return this.refuse(
        run,
        card,
        "charter:allowed_capabilities",
        "Charter does not allow runner grants and trusted evidence",
      );
    const checkpoints = charter.checkpoints;
    const action = ACTION_FOR.get(card.grant.covers);
    if (
      !checkpoints.includes(card.grant.covers) ||
      charter.denied_actions.includes(card.grant.covers) ||
      (action !== undefined && !charter.default_grants.includes(action))
    )
      return this.refuse(run, card, "charter:checkpoints", "Checkpoint is outside the approved charter");
    if (
      card.operation === "bound.run" &&
      card.emits_tickets &&
      (!checkpoints.includes("ticket-approval") ||
        !charter.default_grants.includes("approve-ticket") ||
        !card.additional_grants?.some(
          (grant) => grant.charter_hash === run.charter_hash && grant.covers === "ticket-approval",
        ))
    )
      return this.refuse(
        run,
        card,
        "policy:invocation/bound.run",
        "Emitting tickets requires a separate ticket-approval grant",
      );
    if (card.human_experience)
      return this.refuse(
        run,
        card,
        "policy:prototype-human-experience-needs-human",
        "A named human must judge the experience",
      );
    if (!step.from.includes(run.run_state) || run.next_permitted_action !== card.operation)
      return this.refuse(run, card, "runner:state", "Phase is not the next permitted action");
    if (!this.current(run))
      return this.refuse(
        run,
        card,
        "runner:evidence-freshness",
        "Worker revision or diff changed; sync and collect new evidence",
      );
    if (
      card.evidence.length === 0 ||
      card.evidence.some((e) => {
        const found = run.evidence[e];
        return (
          found === undefined ||
          found.revision !== run.revision ||
          found.diff_hash !== run.diff_hash ||
          digest(this.evidenceStore.read(found.ref)) !== found.hash
        );
      })
    )
      return this.refuse(run, card, "runner:trusted-evidence", "Required trusted evidence is missing or stale");
    if (card.operation === "ship.prepare" && !card.evidence.some((e) => run.evidence[e]?.kind === "verify"))
      return this.refuse(run, card, "runner:trusted-evidence", "Ship requires runner-collected verification evidence");
    const elapsed = (Date.now() - Date.parse(run.created_at)) / 60_000;
    const limits = charter.limits;
    if (elapsed >= limits.elapsed_minutes) return this.cap(run, card, "elapsed-minutes", limits.elapsed_minutes);
    if (step.budget !== undefined) {
      const used = run.budget_consumption[step.budget] ?? 0;
      const cap =
        step.budget === "alignment_questions"
          ? limits.alignment_questions
          : step.budget === "tickets"
            ? limits.tickets
            : limits.review_rounds;
      if (cap !== undefined && used >= cap) return this.cap(run, card, LIMIT_NAME.get(step.budget) ?? step.budget, cap);
    }
    return null;
  }

  decide(id: string, cardId: string, seatFailures: string[] = []): OperationResult {
    const early = this.authorize(id, cardId);
    if (early !== null) return early;
    const run = this.load(id);
    const card = run.cards[cardId];
    if (card === undefined) throw new Error("unknown checkpoint card");
    const step = STAGE.get(card.operation);
    if (step === undefined) throw new Error("phase is not declared");
    if (seatFailures.length > 0)
      return this.refuse(
        run,
        card,
        "runner:seat-independence",
        `Supervisor seat dispatch failed: ${seatFailures.join("; ")}`.slice(0, 2000),
      );
    const charter = run.charter;
    const seats = charter.supervisors.seats.map((s) => s.id);
    if (
      card.judgments.length !== 2 ||
      new Set(card.judgments.map((j) => j.actor)).size !== 2 ||
      new Set(card.judgments.map((j) => j.dispatch)).size !== 2 ||
      card.judgments.some(
        (j) =>
          !seats.includes(j.seat) ||
          run.excluded_actors.some((excluded) => j.actor === excluded || j.lineage.includes(excluded)) ||
          j.input_dispatches.length > 0,
      )
    )
      return this.refuse(run, card, "runner:seat-independence", "Two independent supervisor dispatches are required");
    if (card.judgments[0]?.choice !== card.judgments[1]?.choice)
      return this.refuse(run, card, "runner:supervisor-disagreement", "Supervisor seats disagreed");
    const approve = card.judgments[0]?.choice === card.approve;
    const result: OperationResult = {
      operation: card.operation,
      status: "complete",
      next_permitted_action: approve ? step.next : card.operation,
    };
    run.decisions.push({
      card,
      result,
      at: new Date().toISOString(),
      revision: run.revision,
      diff_hash: run.diff_hash,
    });
    if (approve) this.advance(run, step);
    this.save(run);
    return result;
  }

  answer(id: string, cardId: string, choice: string, by: string, rationale: string): OperationResult {
    const run = this.load(id);
    const decision = run.decisions.find((d) => d.card.id === cardId);
    const resume = run.resume;
    if (
      run.run_state !== "needs-input" ||
      !run.open_escalation?.blocked.includes(cardId) ||
      decision?.result.status !== "needs-input" ||
      resume === undefined
    )
      throw new Error("card has no open escalation to answer");
    const card = decision.card;
    if (!card.options.includes(choice) || !ID.test(by) || !rationale.trim())
      throw new Error("answer must name one of the card's options, who answered and why");
    if (run.excluded_actors.includes(by)) throw new Error("an excluded actor cannot answer the escalation");
    run.run_state = resume.run_state;
    run.next_permitted_action = resume.next_permitted_action;
    const step = STAGE.get(card.operation);
    if (
      choice === card.approve &&
      step !== undefined &&
      step.from.includes(resume.run_state) &&
      resume.next_permitted_action === card.operation
    )
      this.advance(run, step);
    const result: OperationResult = {
      operation: card.operation,
      status: "complete",
      next_permitted_action: run.next_permitted_action,
    };
    decision.answer = { by, choice, rationale, at: new Date().toISOString(), refusal: decision.result };
    decision.result = result;
    run.open_escalation = null;
    delete run.resume;
    this.save(run);
    return result;
  }

  private advance(run: Run, step: StageStep): void {
    if (step.budget !== undefined) {
      const used = run.budget_consumption[step.budget] ?? 0;
      const limits = run.charter.limits;
      const cap =
        step.budget === "alignment_questions"
          ? limits.alignment_questions
          : step.budget === "tickets"
            ? limits.tickets
            : limits.review_rounds;
      if (cap !== undefined) run.budget_consumption[step.budget] = used + 1;
    }
    run.run_state = step.to;
    run.next_permitted_action = step.next;
  }

  private cap(run: Run, card: Card, limit: string, value: number): OperationResult {
    const result: OperationResult = {
      operation: card.operation,
      status: "cap-reached",
      next_permitted_action: null,
      cap: { limit, value },
    };
    run.run_state = "cap-reached";
    run.next_permitted_action = null;
    run.decisions.push({
      card,
      result,
      at: new Date().toISOString(),
      revision: run.revision,
      diff_hash: run.diff_hash,
    });
    this.save(run);
    return result;
  }

  charge(id: string, limit: string, amount: number, subject?: string): OperationResult {
    const run = this.load(id);
    if (STOPPED.has(run.run_state)) throw new Error("run is stopped; no new budget charge is allowed");
    if (!Number.isInteger(amount) || amount < 1) throw new Error("budget charge must be a positive integer");
    const caps = run.charter.limits;
    const cap =
      limit === "fix_cycles"
        ? caps.fix_cycles
        : limit === "ci_repair_attempts"
          ? caps.ci_repair_attempts
          : limit === "alignment_questions"
            ? caps.alignment_questions
            : limit === "tickets"
              ? caps.tickets
              : limit === "review_rounds"
                ? caps.review_rounds
                : limit === "resource_units"
                  ? caps.resource_units
                  : undefined;
    if (cap === undefined) throw new Error("runner was not given this budget cap");
    if (limit === "fix_cycles" && !subject) throw new Error("fix-cycle charge needs a finding id");
    const key = subject === undefined ? limit : `${limit}:${subject}`;
    const used = run.budget_consumption[key] ?? 0;
    if (used + amount > cap) {
      run.run_state = "cap-reached";
      run.next_permitted_action = null;
      this.save(run);
      return {
        operation: "runner.charge",
        status: "cap-reached",
        next_permitted_action: null,
        cap: { limit: LIMIT_NAME.get(limit) ?? limit.replaceAll("_", "-"), value: cap },
      };
    }
    run.budget_consumption[key] = used + amount;
    this.save(run);
    return { operation: "runner.charge", status: "complete", next_permitted_action: run.next_permitted_action };
  }

  verify(id: string, evidenceId: string): Run {
    const run = this.load(id);
    const evidence = run.evidence[evidenceId];
    if (
      !["building", "repairing"].includes(run.run_state) ||
      run.next_permitted_action !== "verify.record" ||
      evidence?.kind !== "verify" ||
      evidence.revision !== run.revision ||
      evidence.diff_hash !== run.diff_hash ||
      !this.current(run) ||
      digest(this.evidenceStore.read(evidence.ref)) !== evidence.hash
    )
      throw new Error("current runner-collected verification receipt required");
    run.run_state = "verifying";
    run.next_permitted_action = "review.full";
    this.save(run);
    return run;
  }

  event(id: string, key: string, payload: string) {
    const run = this.load(id);
    const duplicate = run.events[key] !== undefined;
    const payloadHash = `sha256:${sha256Hex(payload)}`;
    if (duplicate && run.events[key]?.payload_hash !== payloadHash)
      throw new Error("event key was reused with a different payload");
    const terminal = ["complete", "cancelled", "failed", "cap-reached"].includes(run.run_state);
    if (!duplicate)
      run.events[key] = {
        payload_hash: payloadHash,
        received_at: new Date().toISOString(),
        acted: false,
      };
    this.save(run);
    return { duplicate, terminal };
  }

  /** The callbacks belong to the trusted remote adapter, never to a worker request. */
  effect(
    id: string,
    operation: string,
    target: string,
    inputHash: string,
    readBack: () => string | null,
    perform: () => void,
  ): Effect {
    if (!HASH.test(inputHash) || !EFFECTS.has(operation) || !target) throw new Error("invalid remote effect request");
    const run = this.load(id);
    const key = sha256Hex(`${id}\0${operation}\0${target}\0${inputHash}`);
    const old = run.effects[key];
    const action = EFFECT_ACTION.get(operation);
    if (action === undefined || !run.charter.default_grants.includes(action) || !this.current(run))
      throw new Error("effect lacks a charter grant or current revision");
    const repoEffect = ["remote-push", "pr-open", "pr-comment", "pr-thread-resolve"].includes(operation);
    if (repoEffect) {
      if (
        !run.charter.repos.some(
          (repo) =>
            target === repo.repo ||
            target.startsWith(`${repo.repo}/`) ||
            target.startsWith(`${repo.repo}#`) ||
            target.startsWith(`${repo.repo}:`),
        )
      )
        throw new Error("remote target is outside charter repositories");
    }
    if (old?.confirmed) return old;
    if (repoEffect) {
      const ship = run.decisions.findLast(
        (decision) => decision.card.operation === "ship.prepare" && approved(decision),
      );
      const permitted =
        operation === "pr-open"
          ? run.run_state === "ready-to-ship" && run.next_permitted_action === "pr-open"
          : operation === "remote-push"
            ? ["ready-to-ship", "pr-open"].includes(run.run_state)
            : ["pr-open", "complete"].includes(run.run_state);
      if (!permitted || ship?.revision !== run.revision || ship.diff_hash !== run.diff_hash)
        throw new Error("remote effect requires a current ship checkpoint");
    }
    if (["local-commit", "branch-create"].includes(operation) && !["building", "repairing"].includes(run.run_state))
      throw new Error("local history effect requires an active build or repair");
    if (
      ["kb-publish", "tracker-write"].includes(operation) &&
      ["needs-input", "cap-reached", "failed", "cancelled"].includes(run.run_state)
    )
      throw new Error("new writes stop while the run is blocked");
    const observed = readBack();
    if (observed !== null && observed !== inputHash) throw new Error("remote target contains different input");
    if (observed === null) {
      run.effects[key] = {
        key,
        effect: operation,
        target,
        input_hash: inputHash,
        revision: run.revision,
        diff_hash: run.diff_hash,
        confirmed: false,
      };
      this.save(run);
      perform();
    }
    const after = readBack();
    if (after !== inputHash) throw new Error("remote read-back did not confirm effect");
    const effect = {
      key,
      effect: operation,
      target,
      input_hash: inputHash,
      revision: run.revision,
      diff_hash: run.diff_hash,
      confirmed: true,
      observed: after,
    };
    run.effects[key] = effect;
    if (operation === "pr-open") {
      run.run_state = "pr-open";
      run.next_permitted_action = null;
    }
    this.save(run);
    return effect;
  }

  complete(id: string): Run {
    const run = this.load(id);
    const ship = run.decisions.findLast((decision) => decision.card.operation === "ship.prepare" && approved(decision));
    const verification = Object.values(run.evidence).find(
      (evidence) =>
        evidence.kind === "verify" && evidence.revision === run.revision && evidence.diff_hash === run.diff_hash,
    );
    if (
      run.run_state !== "pr-open" ||
      !this.current(run) ||
      ship?.revision !== run.revision ||
      ship.diff_hash !== run.diff_hash ||
      verification === undefined ||
      digest(this.evidenceStore.read(verification.ref)) !== verification.hash ||
      !Object.values(run.effects).some(
        (effect) =>
          ["pr-open", "remote-push"].includes(effect.effect) &&
          effect.confirmed &&
          effect.revision === run.revision &&
          effect.diff_hash === run.diff_hash,
      )
    )
      throw new Error("a read-back-confirmed open pull request is required");
    run.run_state = "complete";
    run.next_permitted_action = null;
    this.save(run);
    return run;
  }
}
