/**
 * A ledger written line by line for the convergence engine's tests.
 *
 * `Script` numbers the lines and the findings and fills each finding's
 * `first_seen` from the open round, which is what `ak review ledger add` does
 * from a file. It reads no file: the engine under test is pure, and the
 * mutation check copies this helper beside a mutated engine. So it imports
 * only the engine and its types.
 */
import { decide, fold } from "../../src/review/converge.ts";
import {
  DEFAULT_POLICY,
  type Category,
  type CouncilChoice,
  type ConvergencePolicy,
  type Decision,
  type DisputeClaim,
  type EvidenceItem,
  type FindingEvent,
  type LedgerEvent,
  type LedgerState,
  type Origin,
  type RepeatEvent,
  type Risk,
  type RoundCloseEvent,
  type RoundMode,
  type RoundOpenEvent,
  type ScopeTrigger,
  type Severity,
  type TerminalStatus,
  type Vote,
} from "../../src/review/types.ts";

/** A full commit id that differs per `n`. */
export function head(n: number): string {
  return n.toString(16).padStart(40, "0");
}

export function digest(n: number): string {
  return `sha256:${n.toString(16).padStart(64, "0")}`;
}

export interface FindingOptions {
  seat?: string;
  severity?: Severity;
  category?: Category;
  origin?: Origin;
  /** Findings with the same number here share a theme. */
  theme?: number;
  in_scope?: boolean;
  risk?: Risk;
  rule?: string;
  status?: TerminalStatus;
}

export interface RepeatOptions {
  seat?: string;
  blob?: string;
  in_scope?: boolean;
  risk?: Risk;
}

export const RISK: Risk = { asset: "the operator's token", action: "the log line prints it" };

type Unnumbered<T> = T extends LedgerEvent ? Omit<T, "v" | "seq"> : never;

export class Script {
  readonly events: LedgerEvent[] = [];
  private scope = 1;
  private round = 0;
  private at = head(1);
  private rows = 0;
  private opened = { round: 0, head: head(1) };

  constructor(readonly policy: ConvergencePolicy = DEFAULT_POLICY) {}

  /** Append a line as it is, with the next `seq`. For lines the helpers below would not build. */
  line(event: Unnumbered<LedgerEvent>): this {
    this.events.push({ ...event, v: 1, seq: this.events.length + 1 });
    return this;
  }

  /** Open the next round. The mode follows from the round number unless it is given. */
  open(n: number, mode?: RoundMode, maxRounds?: number): this {
    const round = mode === "import" ? 0 : this.round + 1;
    const chosen = mode ?? (round === 1 ? "full" : "closure");
    this.at = head(n);
    if (chosen !== "import") this.round = round;
    this.opened = { round, head: this.at };
    const line: Unnumbered<RoundOpenEvent> = {
      kind: "round-open",
      scope: this.scope,
      round,
      mode: chosen,
      head: this.at,
    };
    if (maxRounds !== undefined) line.max_rounds = maxRounds;
    return this.line(line);
  }

  verdict(seat = "a", word: "approve" | "block" = "approve"): this {
    return this.line({ kind: "verdict", seat, word });
  }

  close(anchors?: { id: string; blob: string }[]): this {
    const line: Unnumbered<RoundCloseEvent> = { kind: "round-close" };
    if (anchors !== undefined) line.anchors = anchors;
    return this.line(line);
  }

  /** A whole round with one verdict per seat and nothing else. */
  pass(n: number, ...seats: string[]): this {
    this.open(n);
    for (const seat of seats.length === 0 ? ["a"] : seats) this.verdict(seat);
    return this.close();
  }

  /** Report a new finding in the open round. Returns its id. */
  finding(options: FindingOptions = {}): string {
    this.rows += 1;
    const id = `F${this.rows}`;
    const line: Unnumbered<FindingEvent> = {
      kind: "finding",
      id,
      fingerprint: digest(this.rows),
      theme: digest(1000 + (options.theme ?? this.rows)),
      anchor: { file: "src/a.ts", symbol: `fn${options.theme ?? this.rows}`, line: 10, blob: digest(2000) },
      severity: options.severity ?? "P1",
      category: options.category ?? "correctness",
      origin: options.origin ?? "introduced",
      seat: options.seat ?? "a",
      first_seen_head: this.opened.head,
      first_seen_scope: this.scope,
      first_seen_round: this.opened.round,
      cause_key: `cause-${this.rows}`,
      text: "The second caller reads the row before the write lands.",
      in_scope: options.in_scope ?? true,
    };
    if (options.risk !== undefined) line.risk = options.risk;
    if (options.rule !== undefined) line.rule = options.rule;
    if (options.status !== undefined) line.status = options.status;
    this.line(line);
    return id;
  }

  seat(id: string, seat: string): this {
    return this.line({ kind: "seat", id, seat });
  }

  repeat(id: string, options: RepeatOptions = {}): this {
    const line: Unnumbered<RepeatEvent> = {
      kind: "repeat",
      id,
      seat: options.seat ?? "a",
      in_scope: options.in_scope ?? true,
    };
    if (options.blob !== undefined) line.blob = options.blob;
    if (options.risk !== undefined) line.risk = options.risk;
    return this.line(line);
  }

  fixed(id: string): this {
    return this.line({ kind: "response", id, response: "fixed" });
  }

  dispute(id: string, claim: DisputeClaim = "unsupported"): this {
    return this.line({ kind: "response", id, response: "dispute", claim, reason: "The merge base behaves the same." });
  }

  /** A reproduction run at the open round's head. `exit` 1 is red. `base` is the exit status at the merge base. */
  repro(id: string, exit: number, base = 0, ref = "tests/repro.test.ts"): this {
    const evidence: EvidenceItem = { kind: "repro", ref, head: this.at, exit, base_exit: base, sha256: digest(3000) };
    return this.line({ kind: "evidence", id, evidence });
  }

  vote(id: string, vote: Vote, seat = "a"): this {
    return this.line({ kind: "closure", id, seat, vote });
  }

  followup(id: string): this {
    return this.line({ kind: "followup", id, ref: `issue-${id}` });
  }

  council(rulings: { id: string; choice: CouncilChoice }[]): this {
    return this.line({ kind: "council", record: digest(4000), rulings });
  }

  owner(id: string, status: "closed" | "deferred" | "dropped"): this {
    return this.line({ kind: "owner", order: "order-1", id, status });
  }

  extension(): this {
    return this.line({ kind: "extension", order: "order-2" });
  }

  carry(n: number): this {
    this.at = head(n);
    return this.line({ kind: "carry", head: this.at });
  }

  newScope(n: number, trigger: ScopeTrigger = "scope-growth"): this {
    this.scope += 1;
    this.round = 0;
    return this.line({ kind: "scope-open", scope: this.scope, trigger, head: head(n) });
  }

  state(): LedgerState {
    return fold(this.events, this.policy);
  }

  row(id: string) {
    const row = this.state().rows.find((candidate) => candidate.id === id);
    if (row === undefined) throw new Error(`no row ${id}`);
    return row;
  }

  /** The decision at head `n`, for a tier that needs `seats` seats in round 1. */
  decide(n: number, seats = 1, missing: string[] = [], integrity: string[] = []): Decision {
    return decide(this.events, this.policy, {
      head: head(n),
      seats_required: seats,
      evidence_missing: missing,
      integrity_failures: integrity,
    });
  }
}
