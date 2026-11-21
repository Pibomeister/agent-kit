/**
 * The convergence ledger on disk (ADR-0018): what `ak review ledger add` turns
 * a report into, and what the reader accepts.
 *
 * - identity: a finding's fingerprint survives moved lines and changes with
 *   its symbol; two seats' identical finding is one row.
 * - repeats: a report of a terminal row reopens it when its symbol body
 *   changed, and is a counted flip when it did not.
 * - the file: append-only, numbered, owner-only, and readable after an
 *   interrupted write.
 */
import { mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { describe, expect, test } from "bun:test";

import { fold } from "../../src/review/converge.ts";
import {
  addEvents,
  anchorAt,
  appendLedger,
  blobOf,
  fingerprint,
  isLedgerEvent,
  parseInput,
  readLedger,
  sha256,
  symbolsOf,
  themeOf,
  type AddOutcome,
  type FindingReport,
  type InputItem,
} from "../../src/review/ledger.ts";
import { DEFAULT_POLICY, type LedgerEvent, type LedgerState } from "../../src/review/types.ts";
import type { JsonValue } from "../helpers/json.ts";
import { processScratch } from "../helpers/process-tmp.ts";
import { digest, head, RISK } from "./script.ts";

const FILE = "src/store.ts";

const SOURCE = `// The row store.

export function load(path: string) {
  return read(path);
}

export function save(path: string, text: string) {
  write(path, text);
}
`;

/** A report of one defect in `load`, at the line it has in `SOURCE`. */
function report(overrides: Partial<FindingReport> = {}): FindingReport {
  return {
    kind: "finding",
    seat: "a",
    severity: "P1",
    category: "correctness",
    origin: "introduced",
    file: FILE,
    line: 4,
    cause_key: "stale-read",
    text: "The second caller reads the row before the write lands.",
    ...overrides,
  };
}

/** An input written out in a test: a kind and that kind's fields. */
interface LooseItem {
  kind: string;
  [field: string]: JsonValue;
}

type Item = InputItem | LooseItem;

/** Inputs for a direct `addEvents` call. */
function inputs(...items: Item[]): Item[] {
  return items;
}

/** A ledger in memory and the tree its findings are anchored in. */
class Book {
  readonly events: LedgerEvent[] = [];
  readonly snapshot = processScratch("review-snapshot-");
  maxRounds: number | undefined;

  constructor(source: string | null = SOURCE) {
    if (source !== null) this.write(FILE, source);
  }

  write(file: string, text: string): this {
    mkdirSync(dirname(join(this.snapshot, file)), { recursive: true });
    writeFileSync(join(this.snapshot, file), text);
    return this;
  }

  /** Add inputs as one call of `ak review ledger add --snapshot` does. */
  add(...items: Item[]): AddOutcome[] {
    const options = { policy: DEFAULT_POLICY, snapshot: this.snapshot, maxRounds: this.maxRounds };
    const result = addEvents(this.events, items, options);
    this.events.push(...result.appended);
    return result.outcomes;
  }

  one(item: Item): AddOutcome {
    const outcome = this.add(item)[0];
    if (outcome === undefined) throw new Error("no outcome");
    return outcome;
  }

  /** A round with seat `a`'s verdict and `items` in it. */
  round(n: number, ...items: Item[]): AddOutcome[] {
    return this.add({ kind: "round-open", head: head(n) }, { kind: "verdict", seat: "a", word: "approve" }, ...items, {
      kind: "round-close",
    });
  }

  state(): LedgerState {
    return fold(this.events, DEFAULT_POLICY);
  }

  kinds(): string[] {
    return this.events.map((event) => event.kind);
  }
}

/** A reproduction of F1 that is red at head `n` and green at the merge base. */
function red(n: number): Item {
  return {
    kind: "evidence",
    id: "F1",
    evidence: {
      kind: "repro",
      ref: "tests/store.test.ts",
      head: head(n),
      exit: 1,
      base_exit: 0,
      sha256: digest(n),
    },
  };
}

/** A ledger file holding round 1 with F1 in it, and the events it was written from. */
function written() {
  const book = new Book();
  book.round(1, report());
  const path = join(processScratch("review-ledger-"), "ledger.jsonl");
  appendLedger(path, book.events, false);
  return { path, events: book.events };
}

/** F1 reported in round 1 and closed in round 2 after the author changed `load`. Round 3 is open. */
function closedRow(): Book {
  const book = new Book();
  book.round(1, report());
  book.write(FILE, SOURCE.replace("return read(path);", "return readLocked(path);"));
  book.add({ kind: "response", id: "F1", response: "fixed" });
  book.round(2, { kind: "closure", id: "F1", seat: "a", vote: "addressed" });
  book.add({ kind: "round-open", head: head(3) }, { kind: "verdict", seat: "a", word: "approve" });
  return book;
}

describe("the anchor of a finding", () => {
  test("a symbol opens at a line that starts in column one with a letter", () => {
    expect(symbolsOf(FILE, SOURCE).map((span) => span.name)).toEqual(["", "load", "save"]);
  });

  test("the enclosing symbol of a line is the last one opened at or before it", () => {
    expect(anchorAt(FILE, SOURCE, 4).symbol).toBe("load");
    expect(anchorAt(FILE, SOURCE, 8).symbol).toBe("save");
    expect(anchorAt(FILE, SOURCE, 1).symbol).toBe("");
  });

  test("the digest is of the symbol's body and of nothing else in the file", () => {
    const edited = SOURCE.replace("write(path, text);", "writeLocked(path, text);");
    expect(anchorAt(FILE, edited, 4).blob).toBe(anchorAt(FILE, SOURCE, 4).blob);
    expect(anchorAt(FILE, edited, 8).blob).not.toBe(anchorAt(FILE, SOURCE, 8).blob);
    expect(blobOf(FILE, SOURCE, "load")).toBe(anchorAt(FILE, SOURCE, 4).blob);
    expect(blobOf(FILE, SOURCE, "gone")).toBeNull();
  });

  test("in Markdown a heading opens a symbol and a line of prose does not", () => {
    const text = "# Review\n\nRounds are counted.\n\n## The cap\n\nThree rounds.\n";
    expect(symbolsOf("docs/review.md", text).map((span) => span.name)).toEqual(["", "Review", "The cap"]);
    expect(anchorAt("docs/review.md", text, 7).symbol).toBe("The cap");
  });

  test("declaration keywords are not the name", () => {
    const text = "export default async function main() {}\nexport const LIMIT = 3;\nclass Store {}\n";
    expect(symbolsOf("src/a.ts", text).map((span) => span.name)).toEqual(["", "main", "LIMIT", "Store"]);
  });
});

describe("the identity of a finding", () => {
  test("no line number is in the fingerprint", () => {
    expect(fingerprint("correctness", FILE, "load", "stale-read")).toBe(
      sha256(JSON.stringify(["correctness", FILE, "load", "stale-read"])),
    );
    expect(themeOf("correctness", FILE, "load")).toBe(sha256(JSON.stringify(["correctness", FILE, "load"])));
  });

  test("moved lines keep the fingerprint: the same defect lower in the file is the same row", () => {
    const book = new Book();
    book.add({ kind: "round-open", head: head(1) });
    expect(book.one(report())).toMatchObject({ id: "F1", lines: ["finding"], status: "open" });
    book.write(FILE, `// One.\n// Two.\n// Three.\n${SOURCE}`);
    expect(book.one(report({ line: 7 }))).toEqual({
      input: 1,
      kind: "finding",
      lines: [],
      id: "F1",
      status: "open",
      note: "already reported by this seat",
    });
    expect(book.state().rows).toHaveLength(1);
  });

  test("a renamed symbol changes the fingerprint: the report is a new row", () => {
    const book = new Book();
    book.add({ kind: "round-open", head: head(1) });
    book.add(report());
    book.write(FILE, SOURCE.replace("function load(", "function loadRow("));
    expect(book.one(report())).toMatchObject({ id: "F2", lines: ["finding"] });
    const [first, second] = book.state().rows;
    expect(first?.anchor.symbol).toBe("load");
    expect(second?.anchor.symbol).toBe("loadRow");
    expect(second?.fingerprint).not.toBe(first?.fingerprint);
  });

  test("two seats' identical finding gets one id and both seats", () => {
    const book = new Book();
    book.add({ kind: "round-open", head: head(1) });
    book.add(report());
    expect(book.one(report({ seat: "b", line: 3, text: "load returns the old row." }))).toEqual({
      input: 1,
      kind: "finding",
      lines: ["seat"],
      id: "F1",
      status: "open",
    });
    expect(book.state().rows.map((row) => [row.id, row.seats])).toEqual([["F1", ["a", "b"]]]);
  });

  test("another cause in the same symbol is a new row that names the earlier one as a candidate duplicate", () => {
    const book = new Book();
    book.add({ kind: "round-open", head: head(1) });
    book.add(report());
    expect(book.one(report({ seat: "b", cause_key: "missing-lock" }))).toMatchObject({
      id: "F2",
      lines: ["finding"],
      candidates: ["F1"],
    });
    expect(book.events.at(-1)).toMatchObject({ kind: "finding", id: "F2", candidates: ["F1"] });
  });

  test("the line records where and when the finding was first seen", () => {
    const book = new Book();
    book.add({ kind: "round-open", head: head(1) }, report({ risk: RISK, category: "security" }));
    expect(book.events.at(-1)).toMatchObject({
      kind: "finding",
      id: "F1",
      anchor: { file: FILE, symbol: "load", line: 4, blob: anchorAt(FILE, SOURCE, 4).blob },
      first_seen_head: head(1),
      first_seen_scope: 1,
      first_seen_round: 1,
      risk: RISK,
    });
  });

  test("without a snapshot the report's own symbol and digest are the anchor", () => {
    const given = report({ symbol: "load", blob: digest(7) });
    const { appended } = addEvents([], inputs({ kind: "round-open", head: head(1) }, given), {
      policy: DEFAULT_POLICY,
    });
    expect(appended.at(-1)).toMatchObject({
      fingerprint: fingerprint("correctness", FILE, "load", "stale-read"),
      anchor: { symbol: "load", blob: digest(7) },
    });
  });

  test("a file absent from the snapshot anchors to the empty symbol", () => {
    const book = new Book(null);
    book.add({ kind: "round-open", head: head(1) }, report());
    expect(book.events.at(-1)).toMatchObject({ anchor: { symbol: "", blob: sha256("") } });
  });

  test("a path that leaves the snapshot is refused", () => {
    const book = new Book();
    book.add({ kind: "round-open", head: head(1) });
    expect(() => book.add(report({ file: "../outside.ts" }))).toThrow("input 1 (finding): /file must match pattern");
    const outside = join(processScratch("review-outside-"), "secret.ts");
    writeFileSync(outside, "export const token = 1;\n");
    symlinkSync(outside, join(book.snapshot, "src", "link.ts"));
    expect(() => book.add(report({ file: "src/link.ts" }))).toThrow("src/link.ts resolves outside the snapshot");
    expect(book.state().rows).toHaveLength(0);
  });
});

describe("a report of a terminal row", () => {
  test("with the symbol body unchanged it is a repeat and a counted flip, and the row stays closed", () => {
    const book = closedRow();
    expect(book.state().rows[0]).toMatchObject({ status: "closed", reopened: 0 });
    expect(book.one(report())).toEqual({
      input: 1,
      kind: "finding",
      lines: ["repeat", "flip"],
      id: "F1",
      status: "closed",
      note: "repeat of a terminal row: not shown to the author",
    });
    expect(book.state()).toMatchObject({ repeats: 1, flips: 1 });
    expect(book.state().rows[0]).toMatchObject({ status: "closed", reopened: 0 });
  });

  test("with the symbol body changed since it closed it reopens", () => {
    const book = closedRow();
    book.write(FILE, SOURCE.replace("return read(path);", "return readCached(path);"));
    expect(book.one(report({ seat: "b" }))).toEqual({
      input: 1,
      kind: "finding",
      lines: ["repeat"],
      id: "F1",
      status: "open",
      note: "reopened",
    });
    expect(book.state()).toMatchObject({ repeats: 1, flips: 0 });
    expect(book.state().rows).toHaveLength(1);
  });

  test("with no snapshot and no digest there is no body to compare, so it cannot show a change", () => {
    const book = closedRow();
    const given = report({ symbol: "load" });
    const { appended, outcomes } = addEvents(book.events, [given], { policy: DEFAULT_POLICY });
    expect(appended.map((event) => event.kind)).toEqual(["repeat", "flip"]);
    expect(appended[0]).not.toHaveProperty("blob");
    expect(outcomes[0]?.status).toBe("closed");
  });

  test("the round close records each row's symbol digest at that head", () => {
    const book = closedRow();
    const fixed = SOURCE.replace("return read(path);", "return readLocked(path);");
    const closes = book.events.filter((event) => event.kind === "round-close");
    expect(closes.map((event) => event.anchors)).toEqual([
      [{ id: "F1", blob: anchorAt(FILE, SOURCE, 4).blob }],
      [{ id: "F1", blob: anchorAt(FILE, fixed, 4).blob }],
    ]);
  });
});

describe("what the tool decides and an input may not", () => {
  test("the tool numbers the rounds and picks the mode", () => {
    const book = new Book();
    book.round(1, report());
    book.round(2);
    expect(book.events.filter((event) => event.kind === "round-open")).toMatchObject([
      { scope: 1, round: 1, mode: "full", head: head(1) },
      { scope: 1, round: 2, mode: "closure", head: head(2) },
    ]);
  });

  test("after the cap and the council call the next round is the bounded one", () => {
    const book = new Book();
    book.round(1, report(), red(1));
    book.round(2, red(2));
    book.round(3, red(3));
    expect(() => book.add({ kind: "round-open", head: head(4) })).toThrow(
      "input 1 (round-open): the round cap of 3 is reached",
    );
    book.add({ kind: "council", record: digest(9), rulings: [{ id: "F1", choice: "fix" }] });
    book.add({ kind: "round-open", head: head(4) });
    expect(book.events.at(-1)).toMatchObject({ kind: "round-open", round: 4, mode: "bounded" });
  });

  test("a lowered cap is recorded on round 1 of a scope and on no other round", () => {
    const book = new Book();
    book.maxRounds = 2;
    book.round(1);
    book.round(2);
    const opens = book.events.filter((event) => event.kind === "round-open");
    expect(opens[0]).toMatchObject({ round: 1, max_rounds: 2 });
    expect(opens[1]).not.toHaveProperty("max_rounds");
    expect(book.state().max_rounds).toBe(2);
    expect(() => book.add({ kind: "round-open", head: head(3) })).toThrow("the round cap of 2 is reached");
  });

  test("the tool numbers a new scope", () => {
    const book = new Book();
    book.round(1);
    book.add({ kind: "scope-open", trigger: "scope-growth", head: head(2) });
    expect(book.events.at(-1)).toMatchObject({ kind: "scope-open", scope: 2 });
    book.add({ kind: "round-open", head: head(2) });
    expect(book.events.at(-1)).toMatchObject({ scope: 2, round: 1, mode: "full" });
  });

  test.each(["seat", "repeat", "flip"])("an input may not state a %s line", (kind) => {
    const book = new Book();
    book.add({ kind: "round-open", head: head(1) }, report());
    expect(() => book.add({ kind, id: "F1", seat: "b" })).toThrow(
      `input 1 (${kind}): the tool writes this line from a finding report`,
    );
  });

  test("an input carries no line number", () => {
    expect(() => parseInput(JSON.stringify({ kind: "verdict", seat: "a", word: "approve", seq: 9 }))).toThrow(
      "input 1: the tool numbers the lines",
    );
    expect(() => parseInput(JSON.stringify([{ kind: "round-close" }, { kind: "round-close", v: 1 }]))).toThrow(
      "input 2: the tool numbers the lines",
    );
  });

  test("the input is one object with a kind, or an array of them", () => {
    expect(parseInput('{"kind":"round-close"}')).toEqual([{ kind: "round-close" }]);
    expect(parseInput('[{"kind":"round-close"},{"kind":"carry"}]')).toHaveLength(2);
    expect(() => parseInput("[1]")).toThrow("input 1: an object with a kind is expected");
    expect(() => parseInput('{"seat":"a"}')).toThrow("input 1: an object with a kind is expected");
  });
});

describe("a refused input", () => {
  test("names the input and the field", () => {
    const book = new Book();
    book.add({ kind: "round-open", head: head(1) });
    expect(() => book.add({ kind: "verdict", seat: "a", word: "maybe" })).toThrow(
      "input 1 (verdict): /word must be equal to one of the allowed values",
    );
    expect(() => book.add({ kind: "nope" })).toThrow('input 1 (nope): no ledger line has kind "nope"');
    expect(() => book.add(report({ severity: undefined }))).toThrow(
      "input 1 (finding): the line must have required property 'severity'",
    );
    expect(() => book.add({ kind: "round-open", head: head(1), round: 7 })).toThrow(
      "input 1 (round-open): the line must NOT have additional properties",
    );
  });

  test("a line the engine refuses is refused with the engine's reason", () => {
    const book = new Book();
    expect(() => book.add({ kind: "verdict", seat: "a", word: "approve" })).toThrow(
      "input 1 (verdict): no round is open",
    );
    expect(() => book.add(report())).toThrow("input 1 (finding): no round is open");
  });

  test("refuses the whole call: a batch lands complete or not at all", () => {
    const book = new Book();
    const batch: Item[] = [
      { kind: "round-open", head: head(1) },
      { kind: "verdict", seat: "a", word: "approve" },
      report(),
      { kind: "round-close" },
      { kind: "verdict", seat: "b", word: "approve" },
    ];
    expect(() => book.add(...batch)).toThrow("input 5 (verdict): no round is open");
    expect(book.events).toEqual([]);
  });

  test("nothing is added to a ledger that already holds a refused line", () => {
    const stray: LedgerEvent = { v: 1, seq: 1, kind: "verdict", seat: "a", word: "approve" };
    expect(() => addEvents([stray], inputs({ kind: "round-open", head: head(1) }), { policy: DEFAULT_POLICY })).toThrow(
      "the ledger has refused lines: line 1 (verdict): no round is open",
    );
  });
});

describe("the ledger file", () => {
  test("a missing file is an empty ledger", () => {
    const path = join(processScratch("review-ledger-"), "absent.jsonl");
    expect(readLedger(path)).toEqual({ events: [], torn: 0, unterminated: false, sha256: sha256("") });
  });

  test("what was appended is what is read, one JSON line per event, in an owner-only file", () => {
    const { path, events } = written();
    const text = readFileSync(path, "utf8");
    expect(text.endsWith("\n")).toBe(true);
    expect(text.trimEnd().split("\n")).toEqual(events.map((event) => JSON.stringify(event)));
    expect(readLedger(path)).toEqual({ events, torn: 0, unterminated: false, sha256: sha256(text) });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(events.map((event) => event.seq)).toEqual([1, 2, 3, 4]);
    expect(events.every((event) => isLedgerEvent(event))).toBe(true);
  });

  test("appending never rewrites an earlier line", () => {
    const { path, events } = written();
    const before = readFileSync(path, "utf8");
    const next = addEvents(events, inputs({ kind: "response", id: "F1", response: "fixed" }), {
      policy: DEFAULT_POLICY,
    });
    appendLedger(path, next.appended, false);
    const after = readFileSync(path, "utf8");
    expect(after.startsWith(before)).toBe(true);
    expect(readLedger(path).events).toHaveLength(5);
    appendLedger(path, [], false);
    expect(readFileSync(path, "utf8")).toBe(after);
  });

  test("an interrupted write leaves a torn line: it is counted and skipped, and the next append starts a new line", () => {
    const { path, events } = written();
    writeFileSync(path, `${readFileSync(path, "utf8")}{"v":1,"seq":5,"kind":"resp`);
    const torn = readLedger(path);
    expect(torn).toMatchObject({ events, torn: 1, unterminated: true });
    const next = addEvents(torn.events, inputs({ kind: "response", id: "F1", response: "fixed" }), {
      policy: DEFAULT_POLICY,
    });
    appendLedger(path, next.appended, torn.unterminated);
    const again = readLedger(path);
    expect(again).toMatchObject({ torn: 1, unterminated: false });
    expect(again.events.map((event) => [event.seq, event.kind])).toEqual([
      [1, "round-open"],
      [2, "verdict"],
      [3, "finding"],
      [4, "round-close"],
      [5, "response"],
    ]);
  });

  test("a removed or reordered line is an error, not a shorter ledger", () => {
    const { path, events } = written();
    const lines = events.map((event) => JSON.stringify(event));
    writeFileSync(path, `${[lines[0], lines[2], lines[3]].join("\n")}\n`);
    expect(() => readLedger(path)).toThrow(`${path}:2: seq is 3 and the next line is 2`);
    writeFileSync(path, `${[lines[1], lines[0]].join("\n")}\n`);
    expect(() => readLedger(path)).toThrow(`${path}:1: seq is 2 and the next line is 1`);
  });

  test("a line that is JSON and not a ledger line is an error", () => {
    const { path } = written();
    writeFileSync(path, `${readFileSync(path, "utf8")}{"v":1,"seq":5,"kind":"approve"}\n`);
    expect(() => readLedger(path)).toThrow(`${path}:5: not a ledger line`);
  });
});
