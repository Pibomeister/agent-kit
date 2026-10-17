export interface Grant {
  charter_hash: string;
  covers: string;
  decision?: string;
}

export interface StandingGrant {
  charter_hash: string;
  covers: "autopilot.start";
  controller: "firstmate";
  run_id: string;
}

export interface CardInput {
  id: string;
  operation: string;
  grant: Grant;
  additional_grants?: Grant[];
  emits_tickets?: boolean;
  question: string;
  options: string[];
  approve: string;
  evidence: string[];
  artifact_hash: string;
  human_experience?: boolean;
}

export interface Judgment {
  seat: string;
  actor: string;
  dispatch: string;
  choice: string;
  rationale: string;
  input_dispatches: string[];
  lineage: string[];
}

export interface Card extends CardInput {
  judgments: Judgment[];
}

export interface Evidence {
  id: string;
  hash: string;
  revision: string;
  diff_hash: string;
  kind: string;
  ref: string;
}

export interface Charter {
  id: string;
  run_id: string;
  status: string;
  project: { id: string; repo?: string };
  immutability: { hash: string; location: string; immutable: true; worker_writable: false };
  repos: { repo: string; base_branch: string }[];
  allowed_capabilities: string[];
  audit_cadence_seconds?: number;
  approvals: { artifact_hash: string; by: string; authority: string }[];
  standing_grants?: { covers: "autopilot.start"; controller: "firstmate" }[];
  sensitive_grants?: { approval: { artifact_hash: string; by: string; authority: string } }[];
  supervisors: { seats: { id: string; filled_by: string }[] };
  checkpoints: string[];
  default_grants: string[];
  denied_actions: string[];
  limits: {
    elapsed_minutes: number;
    alignment_questions: number;
    tickets: number;
    review_rounds?: number;
    fix_cycles: number;
    ci_repair_attempts: number;
    resource_units?: number;
  };
}

export interface Escalation {
  need: string;
  options: { id: string; summary: string }[];
  tried: { ref: string; kind: "receipt" }[];
  default: string;
  operation?: string;
  approve?: string;
  charter_rule: string;
  blocked: string[];
}

export interface OperationResult {
  operation: string;
  status: "complete" | "needs-input" | "cap-reached" | "failed";
  next_permitted_action: string | null;
  escalation?: Escalation;
  cap?: { limit: string; value: number };
  error?: string;
}

export interface Decision {
  card: Card;
  result: OperationResult;
  at: string;
  revision: string;
  diff_hash: string;
  answer?: { by: string; choice: string; rationale: string; at: string; refusal: OperationResult };
}

export interface Effect {
  key: string;
  effect: string;
  target: string;
  input_hash: string;
  revision: string;
  diff_hash: string;
  confirmed: boolean;
  observed?: string;
}

export interface Delegate {
  id: string;
  parent?: string;
  started_at: string;
  expected_runtime_seconds: number;
  state: "active" | "replaced" | "finished";
  replacement?: string;
  progress: { kind: "commit" | "push" | "pr" | "check" | "store-report"; ref: string; at: string }[];
}

export type VerdictInvalidation = "patch-changed" | "ci-config-drift" | "merge-conflict";
export interface PatchVerdict {
  head_revision: string;
  patch_id: string;
  reused_from?: string;
  invalidated_by?: VerdictInvalidation;
}
export interface ProcedureIdentity {
  bundle_version: string;
  hash: string;
}

export interface Run {
  id: string;
  charter_path: string;
  charter_hash: string;
  charter: Charter;
  start_authority: { kind: "standing-grant"; grant: StandingGrant };
  implementer: string;
  excluded_actors: string[];
  revision: string;
  diff_hash: string;
  created_at: string;
  run_state: string;
  next_permitted_action: string | null;
  cards: Record<string, Card>;
  evidence: Record<string, Evidence>;
  decisions: Decision[];
  budget_consumption: Record<string, number>;
  effects: Record<string, Effect>;
  events: Record<
    string,
    { payload_hash: string; payload?: string; received_at: string; acted: boolean; terminal?: boolean }
  >;
  delegates?: Record<string, Delegate>;
  procedure?: ProcedureIdentity;
  verified_base_revision?: string;
  verdict?: PatchVerdict;
  open_escalation: Escalation | null;
  cancellation?: { by: string; rationale: string; at: string };
  resume?: { run_state: string; next_permitted_action: string | null };
}

export interface RunLedger {
  schema: "run-ledger";
  entries: { checkpoint: string; decision: { id: string; hash: string }; outcome: "ruling" | "escalation" }[];
  status: string;
  cancellation?: { by: string; rationale: string; at: string } | null;
}

export interface InvocationPolicy {
  operations: { id: string; authority: string; grant?: { covers: string } }[];
}
