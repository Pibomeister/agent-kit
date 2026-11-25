/**
 * A random review of one pull request, written as a convergence ledger.
 *
 * `drive` plays the gate, the seats, the author, the council and the owner. It
 * asks `decide` for the next action and takes it, and inside each round it does
 * whatever a list of numbers says: seats vote, reproductions turn red or green,
 * new findings arrive, old ones are repeated. A list of zeros is the shortest
 * review: one round, no finding, approved.
 *
 * The driver proposes any line and keeps the ones the engine admits, so its
 * ledger never holds a refused line. It follows `decide` and nothing else. If
 * the action `decide` names cannot be taken, the run is `stuck`, and that is
 * the deadlock the termination property looks for.
 *
 * `mustBlock` is the other half: what a ledger's raw lines say must block,
 * worked out without the engine's fold.
 */
import { decide, fold, initialState, isUnresolved, refusal, step } from "../../src/review/converge.ts";
import {
  CATEGORIES,
  PIPELINE_SEAT,
  SCOPE_TRIGGERS,
  type Category,
  type ConvergencePolicy,
  type CouncilChoice,
  type Decision,
  type DisputeClaim,
  type FindingEvent,
  type LedgerEvent,
  type LedgerState,
  type RoundMode,
  type Row,
  type Severity,
} from "../../src/review/types.ts";
import { RISK, digest, head } from "./script.ts";

type Unnumbered<T> = T extends LedgerEvent ? Omit<T, "v" | "seq"> : never;
export type Line = Unnumbered<LedgerEvent>;

const SEATS = ["a", "b", "c"];
const SEVERITY: Severity[] = ["P1", "P0", "P2", "P3"];
const CLAIMS: DisputeClaim[] = ["unsupported", "pre-existing", "out-of-scope", "follow-up"];
const RULINGS: CouncilChoice[] = ["follow-up", "fix", "escalate"];
const OWNER_STATUS = ["deferred", "closed", "dropped"] as const;
const MAX_STEPS = 80;

/** Reads the list of numbers. Past its end every answer is 0, the quiet choice. */
export class Picker {
  private at = 0;

  constructor(private readonly picks: readonly number[]) {}

  next(n: number): number {
    const value = this.picks[this.at] ?? 0;
    this.at += 1;
    return value % n;
  }

  /** True about once in `n`, and never past the end of the list. */
  rare(n: number): boolean {
    return this.next(n) === n - 1;
  }
}

export interface DriveOptions {
  policy: ConvergencePolicy;
  /** Review seats the tier requires. */
  seats: number;
  /** The owner rules at a hold: row rulings, one extension, a new scope. Without it a hold ends the run. */
  owner: boolean;
  /** A scope trigger may fire between rounds. */
  scopes: boolean;
}

export interface Run {
  events: LedgerEvent[];
  state: LedgerState;
  /** The number of the head the author last pushed. */
  head: number;
  final: Decision;
  /** The action the driver could not take, or null. */
  stuck: string | null;
  steps: number;
}

interface Driving {
  options: DriveOptions;
  picker: Picker;
  events: LedgerEvent[];
  state: LedgerState;
  head: number;
  findings: number;
}

function emit(driving: Driving, line: Line): boolean {
  // SAFETY: `line` is one member of the LedgerEvent union without `v` and `seq`, and both are added here.
  const event = { ...line, v: 1, seq: driving.events.length + 1 } as LedgerEvent;
  if (refusal(driving.state, event) !== null) return false;
  step(driving.state, event, driving.options.policy);
  driving.events.push(event);
  return true;
}

function reproLine(driving: Driving, id: string, exit: number, base: number, ref: string): Line {
  return {
    kind: "evidence",
    id,
    evidence: { kind: "repro", ref, head: head(driving.head), exit, base_exit: base, sha256: digest(3000) },
  };
}

function newFinding(driving: Driving, sitting: readonly string[], imported: boolean): void {
  const { picker, state } = driving;
  const open = state.open;
  if (open === null) return;
  driving.findings += 1;
  const theme = 1 + picker.next(3);
  const category: Category = CATEGORIES[picker.next(CATEGORIES.length)] ?? "correctness";
  const line: Unnumbered<FindingEvent> = {
    kind: "finding",
    id: `F${state.rows.length + 1}`,
    fingerprint: digest(driving.findings),
    theme: digest(1000 + theme),
    anchor: { file: "src/a.ts", symbol: `fn${theme}`, line: 10, blob: digest(2000) },
    severity: SEVERITY[picker.next(SEVERITY.length)] ?? "P1",
    category,
    origin: picker.rare(4) ? "pre-existing" : "introduced",
    seat: imported ? PIPELINE_SEAT : (sitting[picker.next(sitting.length)] ?? "a"),
    first_seen_head: open.head,
    first_seen_scope: open.scope,
    first_seen_round: open.round,
    cause_key: `cause-${driving.findings}`,
    text: "The second caller reads the row before the write lands.",
    in_scope: !picker.rare(4),
  };
  if (picker.next(2) === 1) line.risk = RISK;
  if (picker.rare(3)) line.rule = "AUTHORING.md section 5";
  if (imported && picker.next(2) === 1)
    line.status = (["observation", "closed", "deferred", "dropped"] as const)[picker.next(4)];
  if (!emit(driving, line)) return;
  if (imported) return;
  const id = line.id;
  if (picker.rare(4)) emit(driving, { kind: "seat", id, seat: SEATS[picker.next(SEATS.length)] ?? "b" });
  const repro = picker.next(4);
  if (repro === 1) emit(driving, reproLine(driving, id, 1, 0, "tests/repro.test.ts"));
  if (repro === 2) emit(driving, reproLine(driving, id, 0, 0, "tests/repro.test.ts"));
  if (repro === 3) emit(driving, reproLine(driving, id, 1, 1, "tests/repro.test.ts"));
  if (picker.rare(6)) {
    const earlier = state.rows.find((row) => row.theme === line.theme && row.id !== id);
    if (earlier !== undefined) emit(driving, { kind: "duplicate", id, of: earlier.id });
  }
}

/** What the seats do with a row that was in the ledger when the round opened. */
function rowActivity(driving: Driving, row: Row, sitting: readonly string[]): void {
  const { picker } = driving;
  if (isUnresolved(row)) {
    for (const seat of sitting) {
      const vote = picker.next(3);
      if (vote !== 1)
        emit(driving, { kind: "closure", id: row.id, seat, vote: vote === 0 ? "addressed" : "not-addressed" });
    }
    const repro = picker.next(6);
    const ref = picker.rare(5) ? "tests/other.test.ts" : "tests/repro.test.ts";
    if (repro === 1 || repro === 5) emit(driving, reproLine(driving, row.id, 1, 0, ref));
    if (repro === 2) emit(driving, reproLine(driving, row.id, 0, 0, ref));
    if (repro === 3) emit(driving, reproLine(driving, row.id, 0, 1, ref));
    if (repro === 4) emit(driving, reproLine(driving, row.id, 1, 1, ref));
    return;
  }
  const seat = sitting[0] ?? "a";
  const what = picker.next(8);
  if (what === 1) {
    emit(driving, { kind: "repeat", id: row.id, seat, in_scope: true, blob: row.closed_blob });
    emit(driving, { kind: "flip", id: row.id, seat, reason: "no change in the anchor and no new evidence" });
  }
  if (what === 2)
    emit(driving, { kind: "repeat", id: row.id, seat, in_scope: !picker.rare(3), blob: digest(2001 + picker.next(3)) });
  if (what === 3) emit(driving, { kind: "repeat", id: row.id, seat, in_scope: false, risk: RISK });
  if (what === 4) emit(driving, reproLine(driving, row.id, 1, 0, "tests/repro.test.ts"));
  if (what === 5) emit(driving, { kind: "seat", id: row.id, seat: SEATS[picker.next(SEATS.length)] ?? "b" });
}

/** One whole round. Returns false when the engine did not admit its opening line. */
function round(driving: Driving, mode: RoundMode): boolean {
  const { picker, state, options } = driving;
  const opening: Line = {
    kind: "round-open",
    scope: state.scope,
    round: mode === "import" ? 0 : state.round + 1,
    mode,
    head: head(driving.head),
  };
  if (mode === "full" && picker.rare(5)) opening.max_rounds = 2;
  if (!emit(driving, opening)) return false;
  if (mode === "import") {
    for (let i = picker.next(3); i > 0; i -= 1) newFinding(driving, [], true);
    return emit(driving, { kind: "round-close" });
  }
  const sitting = mode === "full" ? SEATS.slice(0, options.seats) : SEATS.slice(0, 1 + picker.next(options.seats));
  for (const seat of sitting) emit(driving, { kind: "verdict", seat, word: picker.rare(3) ? "block" : "approve" });
  for (const id of state.rows.map((row) => row.id)) {
    const row = state.rows.find((candidate) => candidate.id === id);
    if (row !== undefined) rowActivity(driving, row, sitting);
  }
  for (let i = picker.next(3); i > 0; i -= 1) newFinding(driving, sitting, false);
  const anchors = picker.rare(3)
    ? state.rows.slice(0, 2).map((row) => ({ id: row.id, blob: digest(2001 + picker.next(3)) }))
    : [];
  return emit(driving, anchors.length === 0 ? { kind: "round-close" } : { kind: "round-close", anchors });
}

function authorAnswers(driving: Driving): void {
  const { picker, state } = driving;
  for (const row of state.rows.filter(isUnresolved)) {
    const answer = picker.next(3);
    if (answer === 0) emit(driving, { kind: "response", id: row.id, response: "fixed" });
    if (answer === 1)
      emit(driving, {
        kind: "response",
        id: row.id,
        response: "dispute",
        claim: CLAIMS[picker.next(CLAIMS.length)] ?? "unsupported",
        reason: "The merge base behaves the same.",
      });
  }
  driving.head += 1;
}

/** The owner at a hold. Returns false when the owner leaves the hold standing. */
function ownerActs(driving: Driving, decision: Decision): boolean {
  const { picker, state } = driving;
  if (picker.rare(4)) return false;
  if (picker.rare(3) && emit(driving, { kind: "extension", order: "order-2" })) return true;
  if (decision.blocking.length > 0) {
    for (const id of decision.blocking)
      emit(driving, { kind: "owner", order: "order-1", id, status: OWNER_STATUS[picker.next(3)] ?? "deferred" });
    return true;
  }
  if (emit(driving, { kind: "extension", order: "order-2" })) return true;
  return emit(driving, {
    kind: "scope-open",
    scope: state.scope + 1,
    trigger: "large-rebase",
    head: head(driving.head),
  });
}

/** Take the action `decision` names. Returns why the run ends, or null to go on. */
function act(driving: Driving, decision: Decision): "done" | "stuck" | null {
  const { picker, state, options } = driving;
  switch (decision.action) {
    case "none":
    case "captain-hold":
      return "done";
    case "owner-hold":
      return options.owner && ownerActs(driving, decision) ? null : "done";
    case "review-round":
      if (state.scope === 1 && state.round === 0 && !state.imported && picker.rare(3)) round(driving, "import");
      return round(driving, "full") ? null : "stuck";
    case "fix":
      authorAnswers(driving);
      return round(driving, "closure") ? null : "stuck";
    case "closure-round":
      return round(driving, "closure") ? null : "stuck";
    case "bounded-closure":
      authorAnswers(driving);
      return round(driving, "bounded") ? null : "stuck";
    case "council": {
      const rulings = decision.cards.map((card) => ({ id: card.row, choice: RULINGS[picker.next(3)] ?? "follow-up" }));
      return emit(driving, { kind: "council", record: digest(4000), rulings }) ? null : "stuck";
    }
    case "file-follow-ups":
      for (const id of decision.followups_needed) emit(driving, { kind: "followup", id, ref: `issue-${id}` });
      return null;
    default:
      // `repair`, `close-round` and `supply-evidence` never follow from a ledger this driver wrote.
      return "stuck";
  }
}

export function contextAt(n: number, seats: number) {
  return { head: head(n), seats_required: seats, evidence_missing: [], integrity_failures: [] };
}

export function drive(picks: readonly number[], options: DriveOptions): Run {
  const driving: Driving = {
    options,
    picker: new Picker(picks),
    events: [],
    state: initialState(options.policy),
    head: 1,
    findings: 0,
  };
  for (let steps = 1; steps <= MAX_STEPS; steps += 1) {
    const { picker, state } = driving;
    // The head may move for a reason no review asked for: a rebase, a late push.
    if (state.covered_head !== null && picker.rare(9)) {
      driving.head += 1;
      if (picker.next(2) === 1) emit(driving, { kind: "carry", head: head(driving.head) });
    }
    if (options.scopes && state.covered_head !== null && picker.rare(11))
      emit(driving, {
        kind: "scope-open",
        scope: state.scope + 1,
        trigger: SCOPE_TRIGGERS[picker.next(SCOPE_TRIGGERS.length)] ?? "scope-growth",
        head: head(driving.head),
      });
    const decision = decide(driving.events, options.policy, contextAt(driving.head, options.seats));
    const end = act(driving, decision);
    if (end !== null) {
      const stuck = end === "stuck" ? decision.action : null;
      const final = decide(driving.events, options.policy, contextAt(driving.head, options.seats));
      return { events: driving.events, state: driving.state, head: driving.head, final, stuck, steps };
    }
  }
  const final = decide(driving.events, options.policy, contextAt(driving.head, options.seats));
  return { events: driving.events, state: driving.state, head: driving.head, final, stuck: "steps", steps: MAX_STEPS };
}

/** `fold` over the first `count` lines. */
export function prefixState(events: readonly LedgerEvent[], count: number, policy: ConvergencePolicy): LedgerState {
  return fold(events.slice(0, count), policy);
}

interface Watched {
  /** A concrete always-block finding nothing has ruled on since. */
  always: boolean;
  /** Reproductions whose last run was red at the head and green at the merge base. */
  red: Set<string>;
  /** Whether a red reproduction can make this row block: a blocking-class finding of a full round. */
  eligible: boolean;
}

/**
 * The ids a ledger's lines say must block, read without the engine's fold.
 * It is a lower bound: it names a row only where no rule could have released it.
 *
 * - A concrete always-block finding blocks until a line rules on it: an owner
 *   ruling, a duplicate line, a green reproduction, or a round in which every
 *   seat that delivered a verdict called it addressed.
 * - A blocking-class finding of a full round blocks while the last run of one
 *   of its reproductions is red at the head and green at the merge base, until
 *   an owner ruling, a council ruling or a duplicate line names it.
 */
export function mustBlock(events: readonly LedgerEvent[], policy: ConvergencePolicy): string[] {
  const rows = new Map<string, Watched>();
  let mode: RoundMode | null = null;
  let seats: string[] = [];
  let addressed = new Map<string, Set<string>>();
  for (const event of events) {
    switch (event.kind) {
      case "round-open":
        mode = event.mode;
        seats = [];
        addressed = new Map();
        break;
      case "verdict":
        seats.push(event.seat);
        break;
      case "finding": {
        const concrete = policy.always_block.includes(event.category) && event.risk !== undefined;
        const note =
          !policy.blocking_severities.includes(event.severity) ||
          event.origin === "pre-existing" ||
          (event.category === "convention" && event.rule === undefined);
        rows.set(event.id, {
          always: concrete && mode !== "import",
          red: new Set(),
          eligible: mode === "full" && !note,
        });
        break;
      }
      case "closure":
        if (event.vote === "addressed") addressed.set(event.id, (addressed.get(event.id) ?? new Set()).add(event.seat));
        break;
      case "round-close":
        for (const [id, row] of rows)
          if (seats.length > 0 && seats.every((seat) => addressed.get(id)?.has(seat) === true)) row.always = false;
        mode = null;
        break;
      case "evidence": {
        const row = rows.get(event.id);
        const item = event.evidence;
        if (row === undefined || item.kind !== "repro") break;
        if (item.exit === 0 || item.exit === undefined) {
          row.red.delete(item.ref);
          row.always = false;
        } else if (item.base_exit === 0) row.red.add(item.ref);
        // A run that is red at the merge base may refile the row: stop watching it.
        else if (item.base_exit !== undefined) row.eligible = false;
        break;
      }
      case "repeat": {
        const row = rows.get(event.id);
        if (row !== undefined) row.eligible = false;
        break;
      }
      case "owner":
      case "duplicate":
        rows.delete(event.id);
        break;
      case "council":
        for (const ruling of event.rulings) rows.delete(ruling.id);
        break;
      default:
    }
  }
  return [...rows].flatMap(([id, row]) => (row.always || (row.eligible && row.red.size > 0) ? [id] : []));
}

/**
 * Lines of every kind, for every row, as a careless writer could append them
 * after the lines `state` folds. Most are refused wherever they land.
 */
export function wildLines(state: LedgerState, at: number): Line[] {
  const lines: Line[] = [
    { kind: "scope-open", scope: state.scope + 1, trigger: "scope-growth", head: head(at) },
    { kind: "scope-open", scope: state.scope + 2, trigger: "scope-growth", head: head(at) },
    { kind: "round-open", scope: state.scope, round: state.round + 1, mode: "closure", head: head(at) },
    { kind: "round-open", scope: state.scope, round: state.round, mode: "closure", head: head(at) },
    { kind: "round-open", scope: state.scope, round: state.round + 1, mode: "bounded", head: head(at) },
    { kind: "round-open", scope: state.scope, round: 1, mode: "full", head: head(at) },
    { kind: "verdict", seat: "a", word: "block" },
    { kind: "round-close" },
    { kind: "carry", head: head(at) },
    { kind: "carry", head: head(at + 1) },
    { kind: "extension", order: "order-4" },
  ];
  for (const id of [...state.rows.map((row) => row.id), `F${state.rows.length + 1}`]) {
    lines.push(
      { kind: "seat", id, seat: "c" },
      { kind: "repeat", id, seat: "a", in_scope: true, blob: digest(2009), risk: RISK },
      { kind: "flip", id, seat: "a", reason: "no change in the anchor and no new evidence" },
      { kind: "duplicate", id, of: "F1" },
      { kind: "response", id, response: "fixed" },
      { kind: "response", id, response: "dispute", claim: "unsupported", reason: "The merge base behaves the same." },
      {
        kind: "evidence",
        id,
        evidence: {
          kind: "repro",
          ref: "tests/repro.test.ts",
          head: head(at),
          exit: 1,
          base_exit: 0,
          sha256: digest(3000),
        },
      },
      { kind: "closure", id, seat: "a", vote: "not-addressed" },
      { kind: "closure", id, seat: PIPELINE_SEAT, vote: "addressed" },
      { kind: "followup", id, ref: "issue-9" },
      { kind: "council", record: digest(4001), rulings: [{ id, choice: "fix" }] },
      { kind: "owner", order: "order-3", id, status: "deferred" },
      { kind: "owner", order: "order-3", id, status: "closed" },
    );
  }
  return lines;
}
