/**
 * Repeats and resemblances: a restated lesson or pattern is counted on the
 * record it repeats instead of written twice, matched on normalized content
 * plus scope and never on a title; a new lesson, pattern or guardrail draft
 * lists the existing records it resembles, and leaves them untouched.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Ledger } from "../../src/learn/core/ledger.ts";
import { contentKey, normalizeContent, similarTo, terms } from "../../src/learn/core/similar.ts";
import { readJson } from "../../src/learn/core/store.ts";
import { applyConsolidation } from "../../src/learn/memory/consolidate.ts";
import { ensureMemoryLedger, loadLessons } from "../../src/learn/memory/ledger.ts";
import { appendEvents, makeEvent, type ReviewEvent } from "../../src/learn/review/events.ts";
import { reviewLedger } from "../../src/learn/review/ledger.ts";
import { maintain } from "../../src/learn/review/maintain.ts";
import { loadPatterns, num, str } from "../../src/learn/review/patterns.ts";
import { promoteById } from "../../src/learn/review/propose.ts";
import { scratch, testContext } from "./helpers.ts";

const OBS_SESSION = new Map([
  ["obs:1", "sa"],
  ["obs:2", "sa"],
  ["obs:3", "sc"],
  ["obs:4", "sd"],
]);
const VALID = new Set(OBS_SESSION.keys());

/** Invented subjects: a billing service, its database and its port. */
const POSTGRES = "Use Postgres, not MySQL, for the billing service database";
const MYSQL = "Billing service database: use MySQL 8 instead of Postgres";
const PORT = "Billing service reads its port from the BILLING_PORT environment variable";

/** The value, or a thrown error naming what was missing. */
function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`missing ${what}`);
  return value;
}

function lesson(ledger: Ledger, id: string) {
  return must(loadLessons(ledger).get(id), id);
}

function lessons(...items: Array<{ statement: string; evidence: string[]; scope?: string; supersedes?: string[] }>) {
  return { lessons: items.map((item) => ({ scope: "repo", supersedes: [], tags: [], ...item })) };
}

describe("normalized content", () => {
  test("case, Unicode form, punctuation and spacing do not make a new statement; scope does", () => {
    expect(normalizeContent("  Run API tests — from the ＭＡＩＮ worktree!! ")).toBe(
      "run api tests from the main worktree",
    );
    expect(contentKey("Run api tests from the main worktree", "repo")).toBe(
      contentKey("run API tests, from the main worktree.", "repo"),
    );
    expect(contentKey("Run api tests from the main worktree", "repo")).not.toBe(
      contentKey("Run api tests from the main worktree", "technology"),
    );
  });

  test("terms drop stopwords and a plural s, so negation and filler words do not hide a shared subject", () => {
    expect(terms(POSTGRES)).toEqual(terms("billing SERVICES database: MySQL; Postgres"));
    expect([...terms("Never run the tests without the fixtures")].toSorted()).toEqual(["fixture", "run", "test"]);
    expect([...terms("class")]).toEqual(["class"]);
  });

  test("candidates need half the terms and two shared terms, best first, at most three", () => {
    const pool = [
      { id: "a", status: "confirmed", text: POSTGRES },
      { id: "b", status: "confirmed", text: PORT },
      { id: "c", status: "hypothesis", text: "billing" },
    ];
    expect(similarTo(MYSQL, pool)).toEqual([{ id: "a", status: "confirmed", score: 1 }]);
    const many = ["d", "e", "f", "g"].map((id) => ({ id, status: "hypothesis", text: POSTGRES }));
    expect(similarTo(MYSQL, many).map((candidate) => candidate.id)).toEqual(["d", "e", "f"]);
  });
});

describe("lessons", () => {
  test("an exact repeat counts on the existing lesson and refreshes last_seen; nothing is overwritten", () => {
    const ledger = ensureMemoryLedger(join(scratch(), "memory"));
    applyConsolidation(
      ledger,
      lessons({ statement: "Run api tests from the main worktree", evidence: ["obs:1"] }),
      VALID,
      OBS_SESSION,
      { today: "2026-09-01" },
    );
    expect(readFileSync(ledger.path("lessons/ls-001.md"), "utf8")).toContain("count: 1");
    ledger.commit("first night");

    // The second night is shown only obs:3; the older obs:1 reaches its session through `sessionOf`.
    const summary = applyConsolidation(
      ledger,
      lessons({ statement: "run API tests, from the main worktree.", evidence: ["obs:3", "obs:1"] }),
      VALID,
      new Map([["obs:3", "sc"]]),
      { today: "2026-10-01", sessionOf: new Map([["obs:1", "sa"]]) },
    );
    expect([summary.created, summary.repeated, summary.confirmed, summary.similar]).toEqual([
      [],
      ["ls-001"],
      ["ls-001"],
      [],
    ]);
    expect(readdirSync(ledger.path("lessons"))).toEqual(["ls-001.md"]);
    const meta = lesson(ledger, "ls-001").meta;
    expect(meta).toMatchObject({
      statement: "Run api tests from the main worktree",
      count: 2,
      first_seen: "2026-09-01",
      last_seen: "2026-10-01",
      evidence: ["obs:1", "obs:3"],
      sessions: 2,
      status: "confirmed",
    });
    const body = lesson(ledger, "ls-001").body;
    expect(body).toContain("## Statement\nRun api tests from the main worktree\n");
    expect(body.match(/^- obs:\d+$/gm)).toEqual(["- obs:1", "- obs:3"]);
    // The earlier version is still in the ledger's history, not rewritten in place.
    ledger.commit("second night");
    expect(ledger.git(["log", "--format=%s", "--", "lessons/ls-001.md"]).stdout.trim().split("\n")).toHaveLength(2);
  });

  test("the same statement in another scope is not a repeat; it is created and listed as a candidate", () => {
    const ledger = ensureMemoryLedger(join(scratch(), "memory"));
    const summary = applyConsolidation(
      ledger,
      lessons(
        { statement: "Run api tests from the main worktree", evidence: ["obs:1"] },
        { statement: "Run api tests from the main worktree", evidence: ["obs:3"], scope: "technology" },
      ),
      VALID,
      OBS_SESSION,
    );
    expect([summary.created, summary.repeated]).toEqual([["ls-001", "ls-002"], []]);
    expect(summary.similar).toEqual([{ id: "ls-002", candidates: [{ id: "ls-001", status: "hypothesis", score: 1 }] }]);
  });

  test("restating a superseded lesson makes a new one; the superseded page keeps its history", () => {
    const ledger = ensureMemoryLedger(join(scratch(), "memory"));
    applyConsolidation(
      ledger,
      lessons(
        { statement: "Deploy on Fridays", evidence: ["obs:1"] },
        { statement: "Deploy only Monday to Thursday", evidence: ["obs:2"], supersedes: ["ls-001"] },
      ),
      VALID,
      OBS_SESSION,
    );
    const summary = applyConsolidation(
      ledger,
      lessons({ statement: "Deploy on Fridays", evidence: ["obs:3"] }),
      VALID,
      OBS_SESSION,
    );
    expect([summary.created, summary.repeated]).toEqual([["ls-003"], []]);
    const superseded = lesson(ledger, "ls-001").meta;
    expect([superseded.status, superseded.superseded_by]).toEqual(["superseded", "ls-002"]);
  });

  test("a real contradiction is surfaced and an unrelated note sharing a word is not; neither is changed", () => {
    const ledger = ensureMemoryLedger(join(scratch(), "memory"));
    applyConsolidation(
      ledger,
      lessons({ statement: POSTGRES, evidence: ["obs:1", "obs:3"] }, { statement: PORT, evidence: ["obs:2"] }),
      VALID,
      OBS_SESSION,
    );
    const files = () =>
      readdirSync(ledger.path("lessons"))
        .toSorted()
        .map((name) => readFileSync(ledger.path("lessons", name), "utf8"));
    const before = files();

    const summary = applyConsolidation(ledger, lessons({ statement: MYSQL, evidence: ["obs:4"] }), VALID, OBS_SESSION);
    expect(summary.created).toEqual(["ls-003"]);
    expect(summary.similar).toEqual([{ id: "ls-003", candidates: [{ id: "ls-001", status: "confirmed", score: 1 }] }]);
    // Advisory only: the candidates are listed, not marked, merged or put in conflict.
    expect(files().slice(0, 2)).toEqual(before);
    expect(lesson(ledger, "ls-003").meta.status).toBe("hypothesis");
  });
});

function event(hash: string, text: string): ReviewEvent {
  return {
    ...makeEvent({
      source: "github",
      kind: "finding",
      project: "app",
      pr: 7,
      sha: null,
      author: "carol",
      severity: "P2",
      path: null,
      line: null,
      text,
      url: `https://example.test/${hash}`,
      ts: "2026-09-20T00:00:00Z",
    }),
    hash,
  };
}

const EXISTING = `---
id: rp-001
title: Chose Postgres over MySQL
status: candidate
count: 1
first_seen: 2026-09-01
last_seen: 2026-09-01
sources: [github]
prs: [3]
reviewers: [alice]
promoted_to: guardrails
promoted_count: 1
team_target:
---

## Problem
The billing service database was moved to MySQL.

## Root cause
Postgres was the agreed engine for billing.

## Fix
Keep the billing service database on Postgres.

## Evidence
- https://example.test/old (alice P2 pr 3 2026-09-01)
`;

const UNRELATED = `---
id: rp-002
title: Billing port
status: candidate
count: 1
first_seen: 2026-09-01
last_seen: 2026-09-01
sources: [github]
prs: [4]
reviewers: [bob]
promoted_to: guardrails
promoted_count: 1
team_target:
---

## Problem
The billing port is hard-coded.

## Root cause
Nobody read the environment.

## Fix
Read the port from the environment variable.

## Evidence
- https://example.test/port (bob P2 pr 4 2026-09-01)
`;

function reviewSetup(replies: MaintainerReply[]) {
  const ctx = testContext({ replies });
  const root = scratch();
  const ledger = reviewLedger(ctx.config, root);
  mkdirSync(ledger.path("patterns"), { recursive: true });
  writeFileSync(ledger.path("patterns", "rp-001.md"), EXISTING);
  writeFileSync(ledger.path("patterns", "rp-002.md"), UNRELATED);
  return { ctx, ledger, root };
}

function create(title: string, problem: string, root_cause: string, fix: string, hash: string) {
  return { tmp_id: "new-1", title, problem, root_cause, fix, team_target: null, event_hashes: [hash] };
}

type MaintainerReply = { create_patterns: Array<ReturnType<typeof create>>; event_matches: string[] };

describe("review patterns and guardrail drafts", () => {
  test("a create restating a pattern under a different title counts on it; no second page", () => {
    const { ctx, ledger } = reviewSetup([
      {
        create_patterns: [
          create(
            "Wrong engine for billing",
            "The billing service database was moved to MySQL!",
            "postgres was the agreed engine for billing",
            "Keep the billing-service database on Postgres.",
            "h1",
          ),
        ],
        event_matches: [],
      },
    ]);
    appendEvents(ledger, [event("h1", "billing moved to MySQL again")]);
    expect(maintain(ctx, ledger, "app")).toBe(
      "processed 1 events; 0 new patterns; 1 restated (rp-001); repeat rate 100%",
    );
    const patterns = loadPatterns(ledger);
    expect([...patterns.keys()]).toEqual(["rp-001", "rp-002"]);
    const page = must(patterns.get("rp-001"), "rp-001");
    expect([num(page.meta, "count"), str(page.meta, "last_seen"), str(page.meta, "title")]).toEqual([
      2,
      "2026-09-20",
      "Chose Postgres over MySQL",
    ]);
    expect(page.body).toContain("- https://example.test/h1 (carol P2 pr 7 2026-09-20)");
    expect(readFileSync(ledger.path("log.md"), "utf8")).toContain(
      "a create restated rp-001; counted there, no new page",
    );
  });

  test("a new pattern contradicting an existing one is listed against it, though their titles share no word", () => {
    const { ctx, ledger } = reviewSetup([
      {
        create_patterns: [
          create(
            "Database choice for billing service",
            "Billing service database should use MySQL 8.",
            "MySQL was agreed for the billing service.",
            "Move the billing service database to MySQL.",
            "h1",
          ),
        ],
        event_matches: [],
      },
    ]);
    appendEvents(ledger, [event("h1", "use MySQL 8 for billing")]);
    const before = must(loadPatterns(ledger).get("rp-001"), "rp-001");
    const result = maintain(ctx, ledger, "app");
    expect(result).toContain("1 new patterns");
    expect(result).toMatch(/; similar rp-003 ~ rp-001 \(0\.\d+ candidate\)$/);
    expect(result).not.toContain("rp-002");
    const after = must(loadPatterns(ledger).get("rp-001"), "rp-001");
    expect([after.meta, after.body]).toEqual([before.meta, before.body]);
  });

  test("a guardrail draft records the guardrails it resembles beside the draft, never inside it", () => {
    const { ctx, ledger, root } = reviewSetup([]);
    writeFileSync(
      ledger.path("patterns", "rp-003.md"),
      EXISTING.replace("id: rp-001", "id: rp-003")
        .replace("promoted_to: guardrails\npromoted_count: 1\n", "promoted_to: \n")
        .replace("Keep the billing service database on Postgres.", "Move the billing service database to MySQL 8."),
    );
    expect(promoteById(ctx, ledger, root, "rp-003")).toMatch(
      /^promoted rp-003 to guardrails; similar rp-003 ~ rp-001 \(/,
    );
    const [name] = readdirSync(ledger.path("proposals"));
    const record = readJson<{ draft: object; similar?: Array<{ id: string }> }>(
      ledger.path("proposals", must(name, "a proposal")),
      { draft: {} },
    );
    expect(record.similar?.map((candidate) => candidate.id)).toEqual(["rp-001"]);
    expect("similar" in record.draft).toBe(false);
  });
});
