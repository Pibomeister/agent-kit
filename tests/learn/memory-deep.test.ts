/**
 * The weekly job: evidence compaction on an rp-003-shaped page (older lines
 * roll up per month; recent lines, prose, frontmatter untouched), 90-day
 * staleness, and merge / contradiction pairs.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Ledger } from "../../src/learn/core/ledger.ts";
import { readJson, readJsonl } from "../../src/learn/core/store.ts";
import { applyConsolidation } from "../../src/learn/memory/consolidate.ts";
import { applyPairs, compactEvidence, compactReviewLedger, decayLessons, deep } from "../../src/learn/memory/deep.ts";
import { ensureMemoryLedger, loadLessons, writeLesson } from "../../src/learn/memory/ledger.ts";
import { lessonsBlock } from "../../src/learn/memory/session-context.ts";
import { reviewLedger } from "../../src/learn/review/ledger.ts";
import { type CapturedSession, WorkerSessionSource } from "../../src/learn/sources/worker-sessions.ts";
import { gitRepo, MemFixture, scratch, testContext } from "./helpers.ts";

function workerSession(nativeId: string, at: number, modified = Date.now()): CapturedSession {
  return {
    native_id: nativeId,
    memory_session_id: nativeId.repeat(32),
    platform: "codex",
    cwd: "/fixture/worktree",
    started_at_epoch: at,
    completed_at_epoch: at,
    modified_at_epoch: modified,
    prompt_count: 0,
    request: null,
    completed: null,
    next_steps: null,
    files_modified: [],
    observations: [{ type: "turn", title: "worker turn", text: `${nativeId} step`, at, files_modified: [] }],
  };
}

const PAGE = `---
id: rp-003
title: Prose claims not verified against code
status: active
count: 32
---

## Problem
Prose claims code it does not match.

## Evidence
- https://github.com/x/y/pull/1882#discussion_r4031162378 (greptile-apps[bot] P2 pr 1882 2026-09-16)
- obs:1452 (observer:discovery 2026-07-28)
Prose block kept in place.
- obs:2675 (observer:discovery 2026-07-30)
- obs:5237 (observer:discovery pr 1401 2026-08-05)
**Event c44c74e6b80092b7 (2026-08-07):** Migration plan contains unsupported claims.
- obs:6409 (observer:discovery pr 1422 2026-08-07)
- obs:10781 (observer:discovery 2026-08-19)
- fc15f9ff2f305781 (user 2026-08-10)
- obs:19664 (observer:discovery 2026-09-16)

## Notes
- obs:1 (observer:discovery 2026-01-01)
`;
const EXPECTED = `---
id: rp-003
title: Prose claims not verified against code
status: active
count: 32
---

## Problem
Prose claims code it does not match.

## Evidence
- https://github.com/x/y/pull/1882#discussion_r4031162378 (greptile-apps[bot] P2 pr 1882 2026-09-16)
- 2026-07: 2 events (obs 1452…2675)
Prose block kept in place.
- 2026-08: 3 events (obs 5237…6409; prs 1401, 1422)
**Event c44c74e6b80092b7 (2026-08-07):** Migration plan contains unsupported claims.
- obs:10781 (observer:discovery 2026-08-19)
- obs:19664 (observer:discovery 2026-09-16)

## Notes
- obs:1 (observer:discovery 2026-01-01)
`;

describe("evidence compaction", () => {
  test("golden", () => expect(compactEvidence(PAGE, "2026-09-18")).toBe(EXPECTED));

  test("idempotent", () => expect(compactEvidence(EXPECTED, "2026-09-18")).toBe(EXPECTED));

  test("a single-event month is singular", () => {
    const page = "---\nid: rp-x\n---\n\n## Evidence\n- obs:5 (observer:discovery pr 1401 2026-01-05)\n";
    expect(compactEvidence(page, "2026-09-18")).toBe(
      "---\nid: rp-x\n---\n\n## Evidence\n- 2026-01: 1 event (obs 5; prs 1401)\n",
    );
  });

  test("a second pass merges into the existing month line", () => {
    const page = "---\nid: x\n---\n\n## Evidence\n- obs:10 (u 2026-08-01)\n- obs:11 (u 2026-08-25)\n";
    const week1 = compactEvidence(page, "2026-09-05");
    expect(week1).toBe("---\nid: x\n---\n\n## Evidence\n- 2026-08: 1 event (obs 10)\n- obs:11 (u 2026-08-25)\n");
    const week2 = compactEvidence(week1, "2026-09-30");
    expect(week2).toBe("---\nid: x\n---\n\n## Evidence\n- 2026-08: 2 events (obs 10…11)\n");
    expect(compactEvidence(week2, "2026-10-30")).toBe(week2);
  });

  test("a page without an Evidence section is unchanged", () => {
    const page = "---\nid: x\n---\n## Problem\n- obs:1 (u 2020-01-01)\n";
    expect(compactEvidence(page, "2026-09-18")).toBe(page);
  });

  test("the review ledger's pattern pages are compacted under its lock and committed", () => {
    const review = reviewLedger(testContext().config, gitRepo(join(scratch(), "repo")));
    mkdirSync(review.path("patterns"), { recursive: true });
    writeFileSync(review.path("patterns", "rp-003.md"), PAGE);
    expect(compactReviewLedger(review, "2026-09-18")).toBe(1);
    expect(readFileSync(review.path("patterns", "rp-003.md"), "utf8")).toBe(EXPECTED);
    expect(review.git(["status", "--porcelain"]).stdout.trim()).toBe("");
    const release = review.tryLock()!;
    try {
      expect(compactReviewLedger(review, "2026-09-18")).toBe(-1);
    } finally {
      release();
    }
  });
});

function twoLessons(): Ledger {
  const ledger = ensureMemoryLedger(join(scratch(), "memory"));
  applyConsolidation(
    ledger,
    {
      lessons: [
        {
          statement: "keeper about subagent reports",
          scope: "repo",
          evidence: ["Sa"],
          confidence: 0.7,
          tags: ["preference"],
        },
        {
          statement: "dropped about extraction grounding",
          scope: "repo",
          evidence: ["Sb", "Sc"],
          confidence: 0.8,
          tags: ["security"],
        },
      ],
    },
    new Set(["Sa", "Sb", "Sc"]),
    new Map(),
  );
  return ledger;
}

describe("merge and contradiction", () => {
  test("a merge unions tags and evidence and recomputes status", () => {
    const ledger = twoLessons();
    const result = applyPairs(ledger, { merge: [["ls-001", "ls-002"]] }, "2026-09-18");
    expect([result.merged, result.conflicts, result.confirmed]).toEqual([[["ls-001", "ls-002"]], [], ["ls-001"]]);
    const lessons = loadLessons(ledger);
    const keep = lessons.get("ls-001")!.meta;
    const drop = lessons.get("ls-002")!.meta;
    expect(keep.tags).toEqual(["preference", "security"]);
    expect(keep.evidence).toEqual(["Sa", "Sb", "Sc"]);
    expect([keep.sessions, keep.status]).toEqual([3, "confirmed"]);
    expect([drop.status, drop.superseded_by]).toEqual(["superseded", "ls-001"]);
    expect(readFileSync(ledger.path("lessons", "ls-001.md"), "utf8")).toContain("dropped about extraction grounding");
  });

  test("a merge adds the merged lesson's repeat count to the kept one", () => {
    const ledger = twoLessons();
    const dropped = loadLessons(ledger).get("ls-002")!;
    writeLesson(dropped.path, { ...dropped.meta, count: 4 }, dropped.body);
    applyPairs(ledger, { merge: [["ls-001", "ls-002"]] }, "2026-09-18");
    expect(loadLessons(ledger).get("ls-001")!.meta.count).toBe(5);
  });

  test("a contradiction marks both sides conflict", () => {
    const ledger = twoLessons();
    applyPairs(ledger, { contradict: [["ls-001", "ls-002"]] }, "2026-09-18");
    expect([...loadLessons(ledger).values()].map(({ meta }) => meta.status)).toEqual(["conflict", "conflict"]);
  });

  test("pairs naming an unknown id are ignored", () => {
    const ledger = twoLessons();
    expect(
      applyPairs(ledger, { merge: [["ls-001", "ls-404"]], contradict: [["ls-002"]] }, "2026-09-18").merged,
    ).toEqual([]);
  });
});

describe("staleness", () => {
  test("confirmed lessons unseen for 90 days go stale unless global or protected", () => {
    const ledger = ensureMemoryLedger(join(scratch(), "memory"));
    const page = (id: string, extra: Record<string, string | string[]>) =>
      writeLesson(
        ledger.path("lessons", `${id}.md`),
        { id, statement: id, status: "confirmed", scope: "repo", tags: [], last_seen: "2026-01-01", ...extra },
        "\n",
      );
    page("ls-001", {});
    page("ls-002", { scope: "global" });
    page("ls-003", { tags: ["security"] });
    page("ls-004", { last_seen: "2026-09-01" });
    page("ls-005", { status: "hypothesis" });
    expect(decayLessons(ledger, "2026-09-18")).toEqual(["ls-001"]);
    expect(loadLessons(ledger).get("ls-001")!.meta.status).toBe("stale");
  });

  test("the 90 days are a boundary: unseen for 89 or exactly 90 days stays confirmed, 91 days goes stale", () => {
    const ledger = ensureMemoryLedger(join(scratch(), "memory"));
    const boundary: [string, string][] = [
      ["ls-089", "2026-06-21"],
      ["ls-090", "2026-06-20"],
      ["ls-091", "2026-06-19"],
    ];
    for (const [id, lastSeen] of boundary)
      writeLesson(
        ledger.path("lessons", `${id}.md`),
        { id, statement: id, status: "confirmed", scope: "repo", tags: [], last_seen: lastSeen },
        "\n",
      );
    expect(decayLessons(ledger, "2026-09-18")).toEqual(["ls-091"]);
  });
});

describe("the session-start lessons block", () => {
  test("holds at most eight confirmed lessons, most confident first, then most recently seen", () => {
    const ledger = ensureMemoryLedger(join(scratch(), "memory"));
    // Ten confirmed lessons: confidence 0.1..1.0, two of them tied at 0.5 and split by last_seen.
    const lessons: [string, string, string][] = [
      ["ls-101", "0.1", "2026-09-10"],
      ["ls-102", "0.2", "2026-09-10"],
      ["ls-103", "0.3", "2026-09-10"],
      ["ls-104", "0.5", "2026-09-01"],
      ["ls-105", "0.5", "2026-09-15"],
      ["ls-106", "0.6", "2026-09-10"],
      ["ls-107", "0.7", "2026-09-10"],
      ["ls-108", "0.8", "2026-09-10"],
      ["ls-109", "0.9", "2026-09-10"],
      ["ls-110", "1", "2026-09-10"],
    ];
    for (const [id, confidence, lastSeen] of lessons)
      writeLesson(
        ledger.path("lessons", `${id}.md`),
        { id, statement: id, status: "confirmed", scope: "repo", tags: [], confidence, last_seen: lastSeen },
        "\n",
      );
    writeLesson(
      ledger.path("lessons", "ls-111.md"),
      { id: "ls-111", statement: "ls-111", status: "hypothesis", scope: "repo", tags: [], confidence: "1" },
      "\n",
    );
    const block = lessonsBlock(ledger);
    expect(block.confirmed).toBe(10);
    expect(block.total).toBe(11);
    expect(block.text.trim().split("\n").slice(1)).toEqual(
      ["ls-110", "ls-109", "ls-108", "ls-107", "ls-106", "ls-105", "ls-104", "ls-103"].map((id) => `- ${id} [${id}]`),
    );
  });
});

describe("weekly", () => {
  test("a merge that confirms a lesson drafts a knowledgebase proposal from the lesson merger", () => {
    const root = gitRepo(join(scratch(), "shop"));
    const ledger = ensureMemoryLedger(join(scratch(), "memory"));
    applyConsolidation(
      ledger,
      {
        lessons: [
          { statement: "state the invariant before the fix", evidence: ["Sa"], confidence: 0.7 },
          { statement: "state the invariant first", evidence: ["Sb"], confidence: 0.6 },
        ],
      },
      new Set(["Sa", "Sb"]),
      new Map(),
    );
    const ctx = testContext({ cwd: root, replies: [{ merge: [["ls-001", "ls-002"]], contradict: [] }] });
    expect(deep(ctx, ledger, root, null)).toBe(
      "weekly: 0 review pattern pages compacted, 0 stale, 1 merged, 0 conflicts",
    );
    const weeklyRun = readJsonl<{ job: string; id: string }>(ledger.path("runs.jsonl")).find(
      (row) => row.job === "weekly",
    );
    expect(ctx.judgeContexts.map((context) => context?.runId)).toEqual([weeklyRun?.id]);
    expect(weeklyRun?.id).toStartWith("weekly-");
    const files = readdirSync(ledger.path("proposals"));
    expect(files).toEqual(["learn-shop-ls-001.json"]);
    const record = readJson<{ draft: Record<string, unknown> }>(ledger.path("proposals", files[0]!), { draft: {} });
    expect(record.draft.created_by).toEqual({ role: "learn/lesson-merger" });
    expect(record.draft.status).toBe("candidate");
    expect((record.draft.trigger as { kind: string }).kind).toBe("failure");
    expect(existsSync(join(root, ".claude"))).toBe(false);
    expect(ledger.git(["status", "--porcelain"]).stdout.trim()).toBe("");
  });

  test("obs evidence counts its sessions through claude-mem: a merge never demotes a confirmed lesson and can confirm two hypotheses", () => {
    const root = gitRepo(join(scratch(), "shop"));
    const memDb = join(scratch(), "mem.db");
    const mem = new MemFixture(memDb);
    const obs = ["aaaaaaaa-1", "bbbbbbbb-2", "cccccccc-3", "dddddddd-4", "eeeeeeee-5"].map((sid) =>
      mem.observation({ sid, project: "shop", type: "bugfix", at: Date.now() }),
    );
    mem.close();
    const ledger = ensureMemoryLedger(join(scratch(), "memory"));
    const ids = obs.map((n) => `obs:${n}`);
    applyConsolidation(
      ledger,
      {
        lessons: [
          { statement: "confirmed across two sessions", evidence: [ids[0], ids[1]], confidence: 0.8 },
          { statement: "same lesson seen once", evidence: [ids[2]], confidence: 0.6 },
          { statement: "a hypothesis about fixtures", evidence: [ids[3]], confidence: 0.6 },
          { statement: "the same hypothesis about fixtures", evidence: [ids[4]], confidence: 0.6 },
        ],
      },
      new Set(ids),
      new Map(ids.map((id, i) => [id, ["aaaaaaaa", "bbbbbbbb", "cccccccc", "dddddddd", "eeeeeeee"][i]!])),
    );
    expect([...loadLessons(ledger).values()].map(({ meta }) => meta.status)).toEqual([
      "confirmed",
      "hypothesis",
      "hypothesis",
      "hypothesis",
    ]);
    const ctx = testContext({
      cwd: root,
      env: { AK_LEARN_MEM_DB: memDb },
      replies: [
        {
          merge: [
            ["ls-001", "ls-002"],
            ["ls-003", "ls-004"],
          ],
          contradict: [],
        },
      ],
    });
    expect(deep(ctx, ledger, root, null)).toBe(
      "weekly: 0 review pattern pages compacted, 0 stale, 2 merged, 0 conflicts",
    );
    const lessons = loadLessons(ledger);
    expect([lessons.get("ls-001")!.meta.sessions, lessons.get("ls-001")!.meta.status]).toEqual([3, "confirmed"]);
    expect([lessons.get("ls-003")!.meta.sessions, lessons.get("ls-003")!.meta.status]).toEqual([2, "confirmed"]);
    expect(readdirSync(ledger.path("proposals"))).toEqual(["learn-shop-ls-003.json"]);
  });

  test("captured worker evidence counts its sessions with no claude-mem database: a merge confirms two hypotheses", () => {
    const root = gitRepo(join(scratch(), "shop"));
    const ledger = ensureMemoryLedger(join(scratch(), "memory"));
    const workers = WorkerSessionSource.open(ledger);
    workers.capture(["a", "b"].map((nativeId, index) => workerSession(nativeId, 100 + index)));
    const rows = workers.observationsSince("", 0);
    const ids = rows.map((row) => `obs:${row.id}`);
    applyConsolidation(
      ledger,
      {
        lessons: [
          { statement: "fix the code the rule flags", evidence: [ids[0]], confidence: 0.6 },
          { statement: "fix what the rule flags, not the token", evidence: [ids[1]], confidence: 0.6 },
        ],
      },
      new Set(ids),
      new Map(rows.map((row) => [`obs:${row.id}`, row.memory_session_id.slice(0, 8)])),
    );
    expect([...loadLessons(ledger).values()].map(({ meta }) => meta.status)).toEqual(["hypothesis", "hypothesis"]);
    const ctx = testContext({
      cwd: root,
      env: { AK_LEARN_MEM_DB: join(scratch(), "missing.db") },
      replies: [{ merge: [["ls-001", "ls-002"]], contradict: [] }],
    });
    expect(deep(ctx, ledger, root, null)).toBe(
      "weekly: 0 review pattern pages compacted, 0 stale, 1 merged, 0 conflicts",
    );
    const kept = loadLessons(ledger).get("ls-001")?.meta;
    expect([kept?.sessions, kept?.status]).toEqual([2, "confirmed"]);
    expect(readdirSync(ledger.path("proposals"))).toEqual(["learn-shop-ls-001.json"]);
  });

  test("a merged draft names the store each evidence id came from", () => {
    const root = gitRepo(join(scratch(), "shop"));
    const memDb = join(scratch(), "mem.db");
    const mem = new MemFixture(memDb);
    mem.session({ sid: "bbbb2222-1", project: "shop", started: 100, completed: 200 });
    const native = `obs:${mem.observation({ sid: "bbbb2222-1", project: "shop", type: "bugfix", at: 150 })}`;
    mem.close();
    const ledger = ensureMemoryLedger(join(scratch(), "memory"));
    const workers = WorkerSessionSource.open(ledger);
    workers.capture([workerSession("a", 100)]);
    const row = workers.observationsSince("", 0)[0];
    const captured = `obs:${row?.id}`;
    const sid = (row?.memory_session_id ?? "").slice(0, 8);
    const second = [native, "Sbbbb2222", "obs:999", "Scccc3333"];
    applyConsolidation(
      ledger,
      {
        lessons: [
          { statement: "fix the code the rule flags", evidence: [captured], confidence: 0.6 },
          { statement: "fix what the rule flags, not the token", evidence: second, confidence: 0.6 },
        ],
      },
      new Set([captured, ...second]),
      new Map([
        [captured, sid],
        [native, "bbbb2222"],
      ]),
    );
    const ctx = testContext({
      cwd: root,
      env: { AK_LEARN_MEM_DB: memDb },
      replies: [{ merge: [["ls-001", "ls-002"]], contradict: [] }],
    });
    deep(ctx, ledger, root, null);
    const { draft } = readJson<{ draft: { evidence?: Array<{ ref: string }> } }>(
      ledger.path("proposals", "learn-shop-ls-001.json"),
      { draft: {} },
    );
    expect(draft.evidence?.map(({ ref }) => ref).toSorted((x, y) => x.localeCompare(y))).toEqual([
      `claude-mem:${native}`,
      "claude-mem:Sbbbb2222",
      "unresolved:obs:999",
      "unresolved:Scccc3333",
      `worker:${captured}`,
      `worker:S${sid}`,
    ]);
  });

  test("a lesson keeps its worker session after the captured row is dropped, so a recurrence a month later still confirms it", () => {
    const root = gitRepo(join(scratch(), "shop"));
    const ledger = ensureMemoryLedger(join(scratch(), "memory"));
    const day = 86_400_000;
    const day0 = Date.now() - 36 * day;
    const nightly = (statement: string) => {
      const row = WorkerSessionSource.open(ledger).observationsSince("", 0).at(-1);
      const id = `obs:${row?.id}`;
      applyConsolidation(
        ledger,
        { lessons: [{ statement, evidence: [id], confidence: 0.6 }] },
        new Set([id]),
        new Map([[id, (row?.memory_session_id ?? "").slice(0, 8)]]),
      );
      return id;
    };
    WorkerSessionSource.open(ledger).capture([workerSession("a", day0, day0)]);
    const early = nightly("fix the code the rule flags");
    WorkerSessionSource.open(ledger).capture([], { sinceMs: day0 + day });
    WorkerSessionSource.open(ledger).capture([workerSession("b", day0 + 36 * day)], { sinceMs: day0 + 6 * day });
    const late = nightly("fix what the rule flags, not the token");
    const held = WorkerSessionSource.open(ledger).observationsSince("", 0);
    expect(held.map((row) => `obs:${row.id}`)).toEqual([late]);
    expect(early).not.toBe(late);
    expect([...loadLessons(ledger).values()].map(({ meta }) => meta.status)).toEqual(["hypothesis", "hypothesis"]);

    const ctx = testContext({ cwd: root, replies: [{ merge: [["ls-001", "ls-002"]], contradict: [] }] });
    expect(deep(ctx, ledger, root, null)).toBe(
      "weekly: 0 review pattern pages compacted, 0 stale, 1 merged, 0 conflicts",
    );
    const kept = loadLessons(ledger).get("ls-001")?.meta;
    expect([kept?.sessions, kept?.status]).toEqual([2, "confirmed"]);
    const { draft } = readJson<{ draft: { evidence?: Array<{ ref: string }> } }>(
      ledger.path("proposals", "learn-shop-ls-001.json"),
      { draft: {} },
    );
    expect(draft.evidence?.map(({ ref }) => ref).toSorted((x, y) => x.localeCompare(y))).toEqual([
      `unresolved:S${"a".repeat(8)}`,
      `worker:${early}`,
      `worker:${late}`,
      `worker:S${"b".repeat(8)}`,
    ]);
  });
});
