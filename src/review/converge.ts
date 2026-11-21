/**
 * The review convergence engine (ADR-0018): a fold over ledger lines and the
 * verdict rule that reads the folded state.
 *
 * Everything here is a pure function of its arguments. No file, no clock, no
 * environment, no process and no model call. The same lines and the same
 * policy and context give the same decision on every run.
 *
 * - `step` admits one line into a state, or returns why it is refused.
 *   `ak review ledger add` refuses on that reason before it appends.
 * - `fold` replays every line. A line `step` refuses is recorded as a problem
 *   and skipped, and a ledger with a problem is never approved.
 * - `decide` returns one of three verdict words and the one next action.
 *
 * Only ledger rows block, and the rules below say which rows do. A seat's
 * BLOCK word alone never blocks. Approval needs at least one seat whose latest
 * verdict in the current scope approves.
 */

import {
  PIPELINE_SEAT,
  UNRESOLVED,
  type Action,
  type ClosureEvent,
  type ConvergencePolicy,
  type CouncilCard,
  type CouncilEvent,
  type DecideContext,
  type Decision,
  type DuplicateEvent,
  type EvidenceEvent,
  type FindingEvent,
  type LedgerEvent,
  type LedgerState,
  type OpenRound,
  type RepeatEvent,
  type RoundMode,
  type RoundOpenEvent,
  type Row,
  type Verdict,
} from "./types.ts";

export function initialState(policy: ConvergencePolicy): LedgerState {
  return {
    scope: 1,
    round: 0,
    max_rounds: policy.max_rounds,
    open: null,
    imported: false,
    covered_head: null,
    full_seats: [],
    approving: [],
    capped: false,
    extensions: 0,
    council: null,
    bounded: false,
    rows: [],
    theme_rounds: [],
    repeats: 0,
    flips: 0,
    problems: [],
  };
}

export function isUnresolved(row: Row): boolean {
  return UNRESOLVED.includes(row.status);
}

/**
 * A finding that is filed and never blocks: a severity outside the blocking
 * set, a pre-existing defect, or a convention finding that cites no project
 * rule. An always-block row is judged before this and is never a note.
 */
export function isNote(row: Row, policy: ConvergencePolicy): boolean {
  return (
    !policy.blocking_severities.includes(row.severity) ||
    row.origin === "pre-existing" ||
    (row.category === "convention" && row.rule === null)
  );
}

/**
 * Whether a row blocks. An unresolved row blocks when its class always
 * blocks, when it was raised under the full bar of round 1, or when a
 * reproduction is red at the head. `place` keeps a note and an out-of-scope
 * finding from ever being unresolved, and a round's close files every other
 * unresolved row. So a row the cap escalated is one of these three.
 */
export function blocks(row: Row): boolean {
  if (!isUnresolved(row)) return false;
  return row.always_block || row.bar === "full" || row.red.length > 0;
}

/** How many review rounds the current scope may hold: its cap plus a human-authorized extension. */
export function roundCap(state: LedgerState): number {
  return state.max_rounds + state.extensions;
}

function rowOf(state: LedgerState, id: string): Row | undefined {
  return state.rows.find((row) => row.id === id);
}

function ordinal(id: string): number {
  return Number(id.slice(1));
}

function reviewHeld(row: Row): boolean {
  return row.seats.some((seat) => seat !== PIPELINE_SEAT);
}

function awaitsBoundedRound(state: LedgerState): boolean {
  return state.rows.some((row) => isUnresolved(row) && (row.ruling === "fix" || row.ruling === "escalate"));
}

/** Set a row's status for a report by a review seat in a round of `mode`. */
function place(row: Row, mode: RoundMode, policy: ConvergencePolicy): void {
  row.disposition = null;
  row.followup = null;
  if (row.always_block) {
    row.status = "open";
    row.bar = mode === "full" ? "full" : "closure";
    return;
  }
  if (mode === "bounded" || (mode === "closure" && !row.in_scope)) {
    row.status = "observation";
    row.disposition = "out-of-scope";
    return;
  }
  if (isNote(row, policy)) {
    row.status = "deferred";
    row.disposition = "note";
    return;
  }
  row.status = "open";
  row.bar = mode === "full" ? "full" : "closure";
}

/** Record that `theme` was reopened in a closure round. Round 1 raises a theme; it does not reopen one. */
function hitTheme(state: LedgerState, theme: string, open: OpenRound): void {
  if (open.mode !== "closure") return;
  if (state.theme_rounds.some((hit) => hit.theme === theme && hit.round === open.round)) return;
  state.theme_rounds.push({ theme, round: open.round });
}

function reopen(state: LedgerState, row: Row, open: OpenRound): void {
  row.status = "open";
  row.disposition = null;
  row.followup = null;
  row.claim = null;
  row.bar = open.mode === "full" ? "full" : "closure";
  row.reopened += 1;
  hitTheme(state, row.theme, open);
}

/**
 * Why a repeat reopens its row, or null when it does not (plan section 4.5).
 * The anchor's body changed since the row was closed and the report sits
 * inside the delta scope, or an always-block class is newly made concrete.
 * A red reproduction is the third reason, and `evidence` lines carry it.
 */
export function reopenReason(
  row: Row,
  event: RepeatEvent,
  policy: ConvergencePolicy,
): "anchor-changed" | "always-block" | null {
  if (event.risk !== undefined && !row.always_block && policy.always_block.includes(row.category))
    return "always-block";
  if (event.blob === undefined || event.blob === row.closed_blob || !event.in_scope) return null;
  // A note stays filed whatever its anchor does: it could not block when it was first seen.
  return row.always_block || !isNote(row, policy) ? "anchor-changed" : null;
}

function roundOpenRefusal(state: LedgerState, event: RoundOpenEvent): string | null {
  if (state.open !== null) return "a round is already open";
  if (event.scope !== state.scope) return `the current scope is ${state.scope}`;
  if (event.mode === "import")
    return event.round === 0 && state.scope === 1 && state.round === 0 && !state.imported
      ? null
      : "an import round is round 0, once, before round 1 of scope 1";
  if (event.round !== state.round + 1) return `the next round of scope ${state.scope} is ${state.round + 1}`;
  if (event.max_rounds !== undefined && event.mode !== "full") return "only round 1 of a scope sets its round cap";
  if (event.mode === "full") return event.round === 1 ? null : "a scope has one full round, and it is round 1";
  if (event.round === 1) return "round 1 of a scope is the full round";
  if (event.mode === "closure")
    return event.round <= roundCap(state) ? null : `the round cap of ${roundCap(state)} is reached`;
  if (!state.capped || state.council === null) return "a bounded round follows a council call at the cap";
  if (state.bounded) return "the one bounded round was already opened";
  return awaitsBoundedRound(state) ? null : "no row carries a council ruling of fix or escalate";
}

function findingRefusal(state: LedgerState, event: FindingEvent, open: OpenRound): string | null {
  if (event.id !== `F${state.rows.length + 1}`) return `the next finding id is F${state.rows.length + 1}`;
  if (state.rows.some((row) => row.fingerprint === event.fingerprint))
    return "the fingerprint is already in the ledger: report a seat or a repeat";
  if (
    event.first_seen_head !== open.head ||
    event.first_seen_scope !== open.scope ||
    event.first_seen_round !== open.round
  )
    return "first_seen does not name the open round";
  if (open.mode === "import") return event.seat === PIPELINE_SEAT ? null : "an import round takes pipeline findings";
  if (event.seat === PIPELINE_SEAT) return "a pipeline finding is imported in round 0";
  return event.status === undefined && event.disposition === undefined
    ? null
    : "only an imported finding states its status";
}

function duplicateRefusal(state: LedgerState, event: DuplicateEvent): string | null {
  const later = rowOf(state, event.id);
  const earlier = rowOf(state, event.of);
  if (later === undefined || earlier === undefined) return "both rows must exist";
  if (ordinal(event.of) >= ordinal(event.id)) return "a row is a duplicate of an earlier row";
  if (later.disposition?.startsWith("duplicate:") === true) return `${later.id} is already a duplicate`;
  if (!isUnresolved(earlier) && (later.always_block || later.red.length > 0))
    return `${later.id} carries evidence the closed row ${earlier.id} does not: it stays a row`;
  // Folding it into an ordinary row would take it out of the always-block class.
  if (later.always_block && !earlier.always_block)
    return `${later.id} always blocks and ${earlier.id} does not: it stays a row`;
  return null;
}

function councilRefusal(state: LedgerState, event: CouncilEvent): string | null {
  if (state.open !== null) return "a council ruling is recorded between rounds";
  if (!state.capped || state.round < roundCap(state)) return "the council is called at the round cap";
  if (state.council !== null) return "the one council call of this pull request was already recorded";
  const ids = event.rulings.map((ruling) => ruling.id);
  if (new Set(ids).size !== ids.length) return "a row has one ruling";
  const refused = ids.find((id) => {
    const row = rowOf(state, id);
    return row === undefined || !isUnresolved(row) || row.escalate === null || row.always_block;
  });
  return refused === undefined ? null : `${refused} is not an escalated row the council may rule on`;
}

/** The lines that can only be written while a review round is open. */
function inRoundRefusal(state: LedgerState, event: LedgerEvent, open: OpenRound): string | null {
  if (event.kind === "finding") return findingRefusal(state, event, open);
  if (event.kind === "round-close") {
    if (open.mode !== "import" && open.seats.length === 0) return "no seat delivered a verdict in this round";
    const missing = event.anchors?.find((anchor) => rowOf(state, anchor.id) === undefined);
    return missing === undefined ? null : `no row ${missing.id}`;
  }
  if (open.mode === "import") return "an import round takes pipeline findings only";
  if (event.kind === "verdict") {
    if (event.seat === PIPELINE_SEAT) return "the pipeline delivers no verdict";
    return open.seats.includes(event.seat) ? `${event.seat} already delivered a verdict in this round` : null;
  }
  if (event.kind === "duplicate") return duplicateRefusal(state, event);
  if (
    event.kind !== "seat" &&
    event.kind !== "repeat" &&
    event.kind !== "flip" &&
    event.kind !== "evidence" &&
    event.kind !== "closure"
  )
    return null;
  const row = rowOf(state, event.id);
  if (row === undefined) return `no row ${event.id}`;
  if (event.kind === "evidence")
    return event.evidence.kind === "repro" && event.evidence.head !== open.head
      ? "a reproduction counts at the head of the open round"
      : null;
  if (event.seat === PIPELINE_SEAT) return "the pipeline never rules";
  if (event.kind === "flip") return null;
  if (event.kind === "repeat") return isUnresolved(row) ? `${row.id} is unresolved: report a seat` : null;
  if (event.kind === "closure") {
    if (!isUnresolved(row)) return `${row.id} is ${row.status}: there is nothing to close`;
    return row.votes.some((vote) => vote.seat === event.seat) ? `${event.seat} already ruled on ${row.id}` : null;
  }
  if (row.seats.includes(event.seat)) return `${event.seat} already holds ${row.id}`;
  return isUnresolved(row) || (row.status === "observation" && !reviewHeld(row))
    ? null
    : `${row.id} is ${row.status}: report a repeat`;
}

const IN_ROUND: readonly LedgerEvent["kind"][] = [
  "verdict",
  "round-close",
  "finding",
  "seat",
  "repeat",
  "flip",
  "duplicate",
  "evidence",
  "closure",
];

/**
 * Why `event` may not follow the lines already folded into `state`, or null.
 * Every line that can make a verdict stricter is admitted only inside an open
 * round, and an open round is never approved. So dropping the last line of a
 * ledger cannot turn `blocked` into `approved`.
 */
export function refusal(state: LedgerState, event: LedgerEvent): string | null {
  if (IN_ROUND.includes(event.kind))
    return state.open === null ? "no round is open" : inRoundRefusal(state, event, state.open);
  switch (event.kind) {
    case "scope-open":
      if (state.open !== null) return "a round is open";
      return event.scope === state.scope + 1 ? null : `the next scope is ${state.scope + 1}`;
    case "round-open":
      return roundOpenRefusal(state, event);
    case "carry":
      if (state.open !== null) return "a round is open";
      return state.covered_head === null ? "no round of this scope has closed: there is no review to carry" : null;
    case "response": {
      const row = rowOf(state, event.id);
      if (row === undefined) return `no row ${event.id}`;
      return isUnresolved(row) ? null : `${row.id} is ${row.status}: the author answers an unresolved row`;
    }
    case "followup":
    case "owner":
      return rowOf(state, event.id) === undefined ? `no row ${event.id}` : null;
    case "council":
      return councilRefusal(state, event);
    case "extension":
      if (state.open !== null) return "a round is open";
      if (!state.capped || state.bounded) return "an extension adds one closure round at the cap";
      return state.extensions === 0 ? null : "this scope already has its one extension";
    default:
      return null;
  }
}

function applyFinding(state: LedgerState, event: FindingEvent, open: OpenRound, policy: ConvergencePolicy): void {
  const concrete = policy.always_block.includes(event.category);
  const row: Row = {
    id: event.id,
    fingerprint: event.fingerprint,
    theme: event.theme,
    anchor: event.anchor,
    severity: event.severity,
    category: event.category,
    origin: event.origin,
    cause_key: event.cause_key,
    text: event.text,
    suggested_fix: event.suggested_fix ?? null,
    rule: event.rule ?? null,
    risk: event.risk ?? null,
    first_seen: { head: event.first_seen_head, scope: event.first_seen_scope, round: event.first_seen_round },
    seats: [event.seat],
    status: "observation",
    disposition: event.disposition ?? null,
    followup: null,
    evidence: [],
    red: [],
    repro: "none",
    always_block: concrete && event.risk !== undefined,
    form_error: concrete && event.risk === undefined,
    // Round 1 reviews the whole change, so nothing it finds is outside the scope.
    in_scope: open.mode === "full" || event.in_scope,
    bar: "closure",
    closed_blob: event.anchor.blob,
    escalate: null,
    ruling: null,
    claim: null,
    reopened: 0,
    votes: [],
  };
  state.rows.push(row);
  if (open.mode === "import") {
    row.status = event.status ?? "observation";
    return;
  }
  place(row, open.mode, policy);
  if (row.status === "open") hitTheme(state, row.theme, open);
}

function applyEvidence(state: LedgerState, event: EvidenceEvent, open: OpenRound, policy: ConvergencePolicy): void {
  const row = rowOf(state, event.id);
  if (row === undefined) return;
  const item = event.evidence;
  row.evidence.push(item);
  if (item.kind !== "repro") return;
  if (item.exit === undefined || item.exit === 0) {
    // Green at the head. It closes a row only when this reproduction was red before.
    if (!row.red.includes(item.ref)) return;
    row.red = row.red.filter((ref) => ref !== item.ref);
    if (row.red.length > 0) return;
    row.repro = "green";
    if (!isUnresolved(row)) return;
    row.status = "closed";
    row.disposition = "fixed";
    row.escalate = null;
    return;
  }
  if (item.base_exit === undefined) return;
  if (item.base_exit !== 0) {
    // Red at the head and at the merge base: the defect was there before this change.
    // A reproduction that is red only at the head already showed otherwise.
    if (row.red.length > 0) return;
    row.origin = "pre-existing";
    if (row.always_block || !isUnresolved(row)) return;
    row.status = "deferred";
    row.disposition = "pre-existing";
    row.escalate = null;
    return;
  }
  row.origin = "introduced";
  // A note stays filed. An observation is promoted by a seat's report, never by evidence alone:
  // it is a pipeline finding no seat holds, or a finding its round could not take.
  if (!row.always_block && (isNote(row, policy) || row.status === "observation")) return;
  if (!row.red.includes(item.ref)) row.red.push(item.ref);
  row.repro = "red";
  if (!isUnresolved(row)) reopen(state, row, open);
}

function applyRepeat(state: LedgerState, event: RepeatEvent, open: OpenRound, policy: ConvergencePolicy): void {
  state.repeats += 1;
  const row = rowOf(state, event.id);
  if (row === undefined) return;
  const reason = reopenReason(row, event, policy);
  if (reason === null) return;
  if (reason === "always-block") {
    row.risk = event.risk ?? null;
    row.always_block = true;
    row.form_error = false;
  }
  if (!row.seats.includes(event.seat)) row.seats.push(event.seat);
  row.in_scope = event.in_scope;
  row.red = [];
  row.repro = "none";
  reopen(state, row, open);
}

function applyClosure(state: LedgerState, event: ClosureEvent, open: OpenRound): void {
  const row = rowOf(state, event.id);
  if (row === undefined) return;
  row.votes.push({ seat: event.seat, vote: event.vote });
  if (event.vote === "not-addressed") hitTheme(state, row.theme, open);
}

function defer(row: Row, disposition: string): void {
  row.status = "deferred";
  row.disposition = disposition;
  row.escalate = null;
}

/** The closure rules of plan section 4.4, for one unresolved row at the close of a review round. */
function resolveRow(row: Row, open: OpenRound, seats: number): void {
  const agree = row.votes.filter((vote) => vote.vote === "addressed").length;
  const disagree = row.votes.length - agree;
  // A red reproduction decides alone. No seat vote is needed or counted.
  if (row.red.length > 0) {
    row.status = "open";
    return;
  }
  if (row.always_block) {
    // Leaves the blocking set only when every seat that reviewed this head calls it addressed.
    const every = open.seats.every((seat) => row.votes.some((vote) => vote.seat === seat && vote.vote === "addressed"));
    if (every) {
      row.disposition = row.status === "disputed" ? (row.claim ?? "unsupported") : "fixed";
      row.status = row.status === "disputed" ? "dropped" : "closed";
      row.escalate = null;
    } else if (disagree > 0) row.status = "open";
    return;
  }
  if (row.status === "disputed") {
    // A split without a red reproduction is decided by the evidence bar: the row is filed.
    if (disagree > 0) defer(row, "split");
    else if (agree >= Math.min(2, Math.max(1, seats))) {
      if (row.claim === "pre-existing" || row.claim === "follow-up") defer(row, row.claim);
      else {
        row.status = "dropped";
        row.disposition = row.claim ?? "unsupported";
        row.escalate = null;
      }
    }
    return;
  }
  if (disagree === 0 && agree > 0) {
    row.status = "closed";
    row.disposition = "fixed";
    row.escalate = null;
    return;
  }
  // The author says fixed and a seat disagrees with no reproduction: an unreproduced claim does not block.
  if (row.status === "addressed" && disagree > 0) defer(row, "unreproduced");
  // A finding first raised after round 1 needs a red reproduction to stay open.
  else if (row.bar === "closure") defer(row, "unreproduced");
}

/**
 * The cap outcomes of plan section 5.4. Every row still unresolved gets a
 * terminal state or an escalation, by rule, so no further automatic round can
 * start from here.
 */
function applyCap(state: LedgerState, open: OpenRound): void {
  const themes = state.theme_rounds.filter((hit) => hit.round === open.round).map((hit) => hit.theme);
  const twice = themes.filter((theme) =>
    state.theme_rounds.some((hit) => hit.theme === theme && hit.round === open.round - 1),
  );
  for (const row of state.rows) {
    if (!isUnresolved(row)) continue;
    if (row.always_block || row.red.length > 0) row.escalate = "evidence";
    else if (open.mode === "closure" && twice.includes(row.theme)) row.escalate = "design";
    else if (row.escalate === null) defer(row, "cap");
  }
  state.capped = true;
}

function applyRoundClose(state: LedgerState, open: OpenRound): void {
  state.open = null;
  if (open.mode === "import") return;
  for (const row of state.rows) if (isUnresolved(row)) resolveRow(row, open, state.full_seats.length);
  if (open.mode === "bounded" || open.round >= state.max_rounds) applyCap(state, open);
  state.covered_head = open.head;
}

function applyInRound(state: LedgerState, event: LedgerEvent, open: OpenRound, policy: ConvergencePolicy): void {
  switch (event.kind) {
    case "verdict":
      open.seats.push(event.seat);
      if (open.mode === "full") state.full_seats.push(event.seat);
      state.approving = state.approving.filter((seat) => seat !== event.seat);
      if (event.word === "approve") state.approving.push(event.seat);
      return;
    case "round-close":
      applyRoundClose(state, open);
      for (const anchor of event.anchors ?? []) {
        const row = rowOf(state, anchor.id);
        if (row !== undefined) row.closed_blob = anchor.blob;
      }
      return;
    case "finding":
      applyFinding(state, event, open, policy);
      return;
    case "seat": {
      const row = rowOf(state, event.id);
      if (row === undefined) return;
      const promoted = !isUnresolved(row);
      row.seats.push(event.seat);
      if (!promoted) return;
      place(row, open.mode, policy);
      if (row.status === "open") hitTheme(state, row.theme, open);
      return;
    }
    case "repeat":
      applyRepeat(state, event, open, policy);
      return;
    case "flip":
      state.flips += 1;
      return;
    case "duplicate": {
      const later = rowOf(state, event.id);
      const earlier = rowOf(state, event.of);
      if (later === undefined || earlier === undefined) return;
      if (isUnresolved(earlier)) {
        for (const seat of later.seats) if (!earlier.seats.includes(seat)) earlier.seats.push(seat);
        // The evidence follows the defect: a red reproduction on the later row keeps the earlier one open.
        for (const ref of later.red) if (!earlier.red.includes(ref)) earlier.red.push(ref);
        earlier.evidence.push(...later.evidence);
        if (earlier.red.length > 0) earlier.repro = "red";
      } else state.repeats += 1;
      later.status = "dropped";
      later.disposition = `duplicate:${earlier.id}`;
      later.escalate = null;
      return;
    }
    case "evidence":
      applyEvidence(state, event, open, policy);
      return;
    case "closure":
      applyClosure(state, event, open);
      return;
    default:
  }
}

function applyBetweenRounds(state: LedgerState, event: LedgerEvent, policy: ConvergencePolicy): void {
  switch (event.kind) {
    case "scope-open":
      state.scope = event.scope;
      state.round = 0;
      state.max_rounds = policy.max_rounds;
      state.covered_head = null;
      state.full_seats = [];
      state.approving = [];
      state.capped = false;
      state.extensions = 0;
      state.theme_rounds = [];
      for (const row of state.rows) {
        row.escalate = null;
        row.ruling = null;
      }
      return;
    case "round-open":
      state.open = { scope: event.scope, round: event.round, mode: event.mode, head: event.head, seats: [] };
      if (event.mode === "import") {
        state.imported = true;
        return;
      }
      state.round = event.round;
      // A scope may lower its cap when it opens. Nothing raises it past the policy.
      if (event.max_rounds !== undefined) state.max_rounds = Math.min(policy.max_rounds, event.max_rounds);
      if (event.mode === "bounded") state.bounded = true;
      for (const row of state.rows) row.votes = [];
      return;
    case "carry":
      state.covered_head = event.head;
      return;
    case "response": {
      const row = rowOf(state, event.id);
      if (row === undefined) return;
      row.status = event.response === "fixed" ? "addressed" : "disputed";
      row.claim = event.response === "dispute" ? (event.claim ?? null) : null;
      row.evidence.push(...(event.evidence ?? []));
      return;
    }
    case "followup": {
      const row = rowOf(state, event.id);
      if (row !== undefined) row.followup = event.ref;
      return;
    }
    case "council":
      state.council = event.record;
      for (const ruling of event.rulings) {
        const row = rowOf(state, ruling.id);
        if (row === undefined) continue;
        row.ruling = ruling.choice;
        if (ruling.choice === "follow-up") defer(row, `council:${event.record}`);
      }
      return;
    case "owner": {
      const row = rowOf(state, event.id);
      if (row === undefined) return;
      row.status = event.status;
      row.disposition = `owner:${event.order}`;
      row.escalate = null;
      return;
    }
    case "extension":
      state.extensions += 1;
      return;
    default:
  }
}

/**
 * Admit one line into `state`. Returns the refusal and leaves the state as it
 * was, or returns null after the state took the line.
 */
export function step(state: LedgerState, event: LedgerEvent, policy: ConvergencePolicy): string | null {
  const refused = refusal(state, event);
  if (refused !== null) return refused;
  if (state.open !== null && IN_ROUND.includes(event.kind)) applyInRound(state, event, state.open, policy);
  else applyBetweenRounds(state, event, policy);
  return null;
}

/** The state after every line. Refused lines and gaps in `seq` are listed in `problems`. */
export function fold(events: readonly LedgerEvent[], policy: ConvergencePolicy): LedgerState {
  const state = initialState(policy);
  events.forEach((event, index) => {
    if (event.seq !== index + 1) state.problems.push(`line ${index + 1}: seq is ${event.seq}`);
    const refused = step(state, event, policy);
    if (refused !== null) state.problems.push(`line ${index + 1} (${event.kind}): ${refused}`);
  });
  return state;
}

function card(row: Row): CouncilCard {
  const where = row.anchor.symbol === "" ? row.anchor.file : `${row.anchor.file} ${row.anchor.symbol}`;
  const what =
    row.escalate === "design"
      ? `The theme of row ${row.id} (${row.category} in ${where}) was reopened in two consecutive rounds. Is the open finding a design decision for a follow-up, or a fix this pull request owes?`
      : `Row ${row.id} is still open at the round cap with a red reproduction. Does it go to a follow-up, or does this pull request owe the fix?`;
  return {
    id: row.id.toLowerCase(),
    row: row.id,
    theme: row.escalate === "design" ? row.theme : null,
    question: `${what} Finding (${row.severity}, ${row.category}): ${row.text}`,
    options: ["follow-up", "fix"],
    approve: "follow-up",
  };
}

interface NextStep {
  action: Action;
  reason: string;
  cards: CouncilCard[];
}

/** The next action while rows block, and why. */
function blockedAction(state: LedgerState, blocking: readonly Row[], cap: number): NextStep {
  const ids = blocking.map((row) => row.id).join(", ");
  if (state.round < cap) {
    const unanswered = blocking.some((row) => row.status === "open");
    return unanswered
      ? { action: "fix", reason: `${ids} block and wait for the author's answer`, cards: [] }
      : { action: "closure-round", reason: `${ids} wait for a closure round`, cards: [] };
  }
  const eligible = blocking.filter((row) => row.escalate !== null && !row.always_block);
  if (state.council === null && eligible.length > 0)
    return {
      action: "council",
      reason: `${eligible.map((row) => row.id).join(", ")} block at the round cap: one council call`,
      cards: eligible.map(card),
    };
  if (state.council !== null && !state.bounded && awaitsBoundedRound(state))
    return { action: "bounded-closure", reason: `${ids} block after the council ruling: one bounded round`, cards: [] };
  return { action: "owner-hold", reason: `${ids} block and no automatic step is left: the owner rules`, cards: [] };
}

/**
 * The verdict for `context.head` (plan sections 5.2 to 5.4).
 *
 * `blocked` when a row blocks. `approved` when no row blocks, the ledger and
 * the caller's integrity checks are clean, no round is open, round 1 of the
 * current scope sat the required seats, the review carries to the exact head,
 * at least one seat's latest verdict in the scope approves, every deferred
 * row has a follow-up reference and no required evidence is missing.
 * `incomplete` otherwise. The action names the one next step.
 */
export function decide(events: readonly LedgerEvent[], policy: ConvergencePolicy, context: DecideContext): Decision {
  const state = fold(events, policy);
  const cap = roundCap(state);
  const blocking = state.rows.filter(blocks);
  const escalated = blocking.filter((row) => row.escalate !== null);
  const unfiled = state.rows.filter((row) => row.status === "deferred" && row.followup === null);
  const covered = state.covered_head !== null && state.covered_head === context.head;
  const held: Verdict = blocking.length > 0 ? "blocked" : "incomplete";
  const result = (verdict: Verdict, action: Action, reasons: string[], cards: CouncilCard[] = []): Decision => ({
    verdict,
    action,
    reasons,
    scope: state.scope,
    round: state.round,
    cap,
    covered_head: state.covered_head,
    blocking: blocking.map((row) => row.id),
    escalate: escalated.map((row) => row.id),
    cards,
    followups_needed: unfiled.map((row) => row.id),
    seats: covered ? [...state.full_seats] : [],
  });

  if (state.scope > policy.max_scopes)
    return result(held, "captain-hold", [
      `scope ${state.scope} is past the ${policy.max_scopes} a pull request may open: split or replan`,
    ]);
  if (state.problems.length > 0 || context.integrity_failures.length > 0)
    return result(held, "repair", [...state.problems, ...context.integrity_failures]);
  if (state.open !== null)
    return result(held, "close-round", [`round ${state.open.round} of scope ${state.open.scope} is open`]);
  if (state.covered_head === null)
    return result(held, "review-round", [`no review round of scope ${state.scope} has closed`]);
  if (blocking.length > 0) {
    const next = blockedAction(state, blocking, cap);
    return result("blocked", next.action, [next.reason], next.cards);
  }
  if (!covered) {
    return state.round < cap
      ? result("incomplete", "closure-round", [
          `the review covers ${state.covered_head}, not ${context.head}: the delta needs a closure pass or a carry`,
        ])
      : result("incomplete", "owner-hold", [
          `the head moved to ${context.head} after the last round this scope may hold: an extension or a new scope is the owner's call`,
        ]);
  }
  const required = Math.max(1, context.seats_required);
  if (state.full_seats.length < required)
    return result("incomplete", "repair", [
      `round 1 of scope ${state.scope} sat ${state.full_seats.length} of ${required} required seats`,
    ]);
  if (state.approving.length === 0)
    return result("incomplete", state.round < cap ? "closure-round" : "owner-hold", [
      `no seat's latest verdict in scope ${state.scope} approves`,
    ]);
  if (unfiled.length > 0)
    return result("incomplete", "file-follow-ups", [
      `${unfiled.map((row) => row.id).join(", ")} are deferred with no follow-up reference`,
    ]);
  if (context.evidence_missing.length > 0)
    return result("incomplete", "supply-evidence", [`missing at the head: ${context.evidence_missing.join(", ")}`]);
  return result("approved", "none", []);
}
