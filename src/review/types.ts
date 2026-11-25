/**
 * The vocabulary of the review convergence ledger (ADR-0018).
 *
 * `schemas/review-ledger.schema.json` is the wire form of a ledger line, and a
 * test holds the enums there equal to the constants here. Nothing in this file
 * reads a file, a clock or the environment.
 */

export const SEVERITIES = ["P0", "P1", "P2", "P3"] as const;
export type Severity = (typeof SEVERITIES)[number];

export const CATEGORIES = [
  "correctness",
  "security",
  "destructive",
  "data-loss",
  "convention",
  "reuse",
  "test-gap",
  "docs",
] as const;
export type Category = (typeof CATEGORIES)[number];

export const STATUSES = ["open", "disputed", "addressed", "closed", "deferred", "dropped", "observation"] as const;
export type Status = (typeof STATUSES)[number];

/** A row in one of these statuses still waits for a ruling. Every other status is terminal until a reopen. */
export const UNRESOLVED: readonly Status[] = ["open", "disputed", "addressed"];

export const ROUND_MODES = ["import", "full", "closure", "bounded"] as const;
export type RoundMode = (typeof ROUND_MODES)[number];

export const SCOPE_TRIGGERS = [
  "large-rebase",
  "risk-tier-rise",
  "surface-changed",
  "scope-growth",
  "requirement-change",
] as const;
export type ScopeTrigger = (typeof SCOPE_TRIGGERS)[number];

/** The seat id of the delivery pipeline's Review. Its findings are imported and it never rules. */
export const PIPELINE_SEAT = "pipeline";

export type Origin = "introduced" | "pre-existing";
export type TerminalStatus = "closed" | "deferred" | "dropped" | "observation";
export type DisputeClaim = "unsupported" | "pre-existing" | "out-of-scope" | "follow-up";
export type Vote = "addressed" | "not-addressed";
export type CouncilChoice = "follow-up" | "fix" | "escalate";

export interface Risk {
  asset: string;
  action: string;
}

export interface Anchor {
  file: string;
  symbol: string;
  line: number;
  blob: string;
}

export interface EvidenceItem {
  kind: "repro" | "red-green" | "reading" | "council";
  ref: string;
  head: string;
  exit?: number;
  base_exit?: number;
  sha256: string;
}

interface Line {
  v: 1;
  seq: number;
}

export interface ScopeOpenEvent extends Line {
  kind: "scope-open";
  scope: number;
  trigger: ScopeTrigger;
  head: string;
}

export interface RoundOpenEvent extends Line {
  kind: "round-open";
  scope: number;
  round: number;
  mode: RoundMode;
  head: string;
  /** Round 1 of a scope may lower the scope's round cap. */
  max_rounds?: number;
}

export interface VerdictEvent extends Line {
  kind: "verdict";
  seat: string;
  word: "approve" | "block";
}

export interface RoundCloseEvent extends Line {
  kind: "round-close";
  anchors?: { id: string; blob: string }[];
}

export interface CarryEvent extends Line {
  kind: "carry";
  head: string;
}

export interface FindingEvent extends Line {
  kind: "finding";
  id: string;
  fingerprint: string;
  theme: string;
  anchor: Anchor;
  severity: Severity;
  category: Category;
  origin: Origin;
  seat: string;
  first_seen_head: string;
  first_seen_scope: number;
  first_seen_round: number;
  cause_key: string;
  text: string;
  suggested_fix?: string;
  in_scope: boolean;
  risk?: Risk;
  rule?: string;
  candidates?: string[];
  status?: TerminalStatus;
  disposition?: string;
}

export interface SeatEvent extends Line {
  kind: "seat";
  id: string;
  seat: string;
}

export interface RepeatEvent extends Line {
  kind: "repeat";
  id: string;
  seat: string;
  blob?: string;
  in_scope: boolean;
  risk?: Risk;
}

export interface FlipEvent extends Line {
  kind: "flip";
  id: string;
  seat: string;
  reason: string;
}

export interface DuplicateEvent extends Line {
  kind: "duplicate";
  id: string;
  of: string;
}

export interface ResponseEvent extends Line {
  kind: "response";
  id: string;
  response: "fixed" | "dispute";
  claim?: DisputeClaim;
  reason?: string;
  evidence?: EvidenceItem[];
}

export interface EvidenceEvent extends Line {
  kind: "evidence";
  id: string;
  evidence: EvidenceItem;
}

export interface ClosureEvent extends Line {
  kind: "closure";
  id: string;
  seat: string;
  vote: Vote;
  location?: string;
}

export interface FollowupEvent extends Line {
  kind: "followup";
  id: string;
  ref: string;
}

export interface CouncilEvent extends Line {
  kind: "council";
  record: string;
  rulings: { id: string; choice: CouncilChoice }[];
}

export interface OwnerEvent extends Line {
  kind: "owner";
  order: string;
  id: string;
  status: "closed" | "deferred" | "dropped";
}

export interface ExtensionEvent extends Line {
  kind: "extension";
  order: string;
}

export type LedgerEvent =
  | ScopeOpenEvent
  | RoundOpenEvent
  | VerdictEvent
  | RoundCloseEvent
  | CarryEvent
  | FindingEvent
  | SeatEvent
  | RepeatEvent
  | FlipEvent
  | DuplicateEvent
  | ResponseEvent
  | EvidenceEvent
  | ClosureEvent
  | FollowupEvent
  | CouncilEvent
  | OwnerEvent
  | ExtensionEvent;

/** The rules `decide` reads. Nothing here is a judgment: each value is compared, never interpreted. */
export interface ConvergencePolicy {
  /** Review rounds per scope: one full and the rest closure. */
  max_rounds: number;
  /** Review scopes per pull request. One past this holds the pull request for a split-or-replan decision. */
  max_scopes: number;
  /** Categories that block in any round without a reproduction, once a risk sentence makes them concrete. */
  always_block: readonly Category[];
  /** Severities that can block. A finding of any other severity is filed. */
  blocking_severities: readonly Severity[];
}

export const DEFAULT_POLICY: ConvergencePolicy = {
  max_rounds: 3,
  max_scopes: 2,
  always_block: ["security", "destructive", "data-loss"],
  blocking_severities: ["P0", "P1"],
};

/** What the caller knows and the ledger does not. The engine reads these; it does not check them. */
export interface DecideContext {
  /** The exact head the verdict is asked for. */
  head: string;
  /** Review seats the tier requires in round 1 of a scope. */
  seats_required: number;
  /** Evidence items the tier requires that are absent at the head. */
  evidence_missing: readonly string[];
  /** Integrity checks of the caller that failed: digests, exact head, merge base, complete batch, active run. */
  integrity_failures: readonly string[];
}

export interface Row {
  id: string;
  fingerprint: string;
  theme: string;
  anchor: Anchor;
  severity: Severity;
  category: Category;
  origin: Origin;
  cause_key: string;
  text: string;
  suggested_fix: string | null;
  rule: string | null;
  risk: Risk | null;
  first_seen: { head: string; scope: number; round: number };
  /** Every seat that reported this fingerprint, in order of first report. */
  seats: string[];
  status: Status;
  /** Why the row left `open`, or null while it has not. */
  disposition: string | null;
  followup: string | null;
  evidence: EvidenceItem[];
  /** Refs of reproductions that are red at the head and not yet green. */
  red: string[];
  /** `green` once every red reproduction turned green, or when the only reproduction never failed. */
  repro: "none" | "red" | "green";
  always_block: boolean;
  /** An always-block category reported without a risk sentence. The row is then an ordinary one. */
  form_error: boolean;
  in_scope: boolean;
  /** `full`: raised in the one open-ended pass, so reading evidence is enough to block. `closure`: needs a red reproduction. */
  bar: "full" | "closure";
  /** The digest of the anchor symbol's body when the row was last closed, or first seen. */
  closed_blob: string;
  /** Set at the cap. `evidence`: a red reproduction or an always-block class. `design`: the same-theme rule. */
  escalate: "evidence" | "design" | null;
  ruling: CouncilChoice | null;
  claim: DisputeClaim | null;
  reopened: number;
  /** Closure answers in the open round. Emptied when a round opens. */
  votes: { seat: string; vote: Vote }[];
}

export interface OpenRound {
  scope: number;
  round: number;
  mode: RoundMode;
  head: string;
  /** Seats that delivered a verdict in this round. */
  seats: string[];
}

export interface LedgerState {
  scope: number;
  /** The last review round opened in the current scope, or 0. */
  round: number;
  /** The current scope's round cap: the policy's, or the lower one its round 1 recorded. */
  max_rounds: number;
  open: OpenRound | null;
  imported: boolean;
  /** The head the last closed round or carry of the current scope covers. */
  covered_head: string | null;
  /** Seats that delivered a verdict in round 1 of the current scope. */
  full_seats: string[];
  /** Seats whose latest verdict in the current scope is approve. */
  approving: string[];
  /** Whether the current scope's cap rules ran: its last allowed round closed. */
  capped: boolean;
  extensions: number;
  council: string | null;
  bounded: boolean;
  rows: Row[];
  /** Per theme, the rounds of the current scope in which it was reopened. */
  theme_rounds: { theme: string; round: number }[];
  repeats: number;
  flips: number;
  /** Lines the fold refused. A ledger with any is never approved. */
  problems: string[];
}

export const ACTIONS = [
  "none",
  "repair",
  "close-round",
  "review-round",
  "fix",
  "closure-round",
  "file-follow-ups",
  "supply-evidence",
  "council",
  "bounded-closure",
  "owner-hold",
  "captain-hold",
] as const;
export type Action = (typeof ACTIONS)[number];

export type Verdict = "approved" | "blocked" | "incomplete";

/** A card in the form `ak council run --card` takes, plus the row it asks about. */
export interface CouncilCard {
  id: string;
  row: string;
  /** Set when the same-theme rule escalated the row as a design decision. */
  theme: string | null;
  question: string;
  options: ["follow-up", "fix"];
  approve: "follow-up";
}

export interface Decision {
  verdict: Verdict;
  action: Action;
  reasons: string[];
  scope: number;
  round: number;
  cap: number;
  covered_head: string | null;
  /** Ids of rows that block at this head. */
  blocking: string[];
  /** Ids of blocking rows the cap escalated. */
  escalate: string[];
  /** One card per row the council may be asked about. Empty unless the action is `council`. */
  cards: CouncilCard[];
  /** Ids of deferred rows with no follow-up reference. */
  followups_needed: string[];
  /** Seats whose review carries to the head. */
  seats: string[];
}
