import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RunResult } from "../../src/learn/core/proc.ts";
import { reflectFolderName } from "../../src/learn/core/paths.ts";
import { readJson, readJsonl } from "../../src/learn/core/store.ts";
import { GitHubReviewSource, paginatedArray, type ReviewComment } from "../../src/learn/sources/github.ts";
import { appendEvents, eventHash, loadEvents, makeEvent, parseSeverity } from "../../src/learn/review/events.ts";
import {
  correctionEvent,
  deferredObservationIds,
  githubCommentEvent,
  ingest,
  observationEvent,
  reportEvent,
} from "../../src/learn/review/ingest.ts";
import { reviewLedger } from "../../src/learn/review/ledger.ts";
import {
  appendRun,
  ensureMemoryLedger,
  memoryDir,
  quarantinedObservationIds,
  readState,
} from "../../src/learn/memory/ledger.ts";
import { readyEpisodes } from "../../src/learn/memory/consolidate.ts";
import { buildEpisodes, unconsolidatedEpisodes } from "../../src/learn/memory/episodes.ts";
import { backfill, reflect, unscreenedIds } from "../../src/learn/memory/reflect.ts";
import { ClaudeMemSource } from "../../src/learn/sources/claude-mem.ts";
import { gitRepo, MemFixture, reflectorReply, scratch, testContext } from "./helpers.ts";

// Shapes as `gh api repos/<owner>/<name>/pulls/<n>/comments` returns them; names and text are generic.
const FINDING: ReviewComment = {
  id: 1001,
  in_reply_to_id: null,
  path: "src/orders/settle.ts",
  line: null,
  original_line: 262,
  created_at: "2026-09-16T22:10:00Z",
  user: { login: "review-bot[bot]" },
  html_url: "https://github.com/acme/app/pull/42#discussion_r1001",
  body:
    '<a href="#"><img alt="P1" src="https://example.test/badges/p1.svg" align="top"></a> **Escalation can ' +
    "overwrite settlement**\n\nThe check reads `stillOpen`",
};
const REPLY: ReviewComment = {
  id: 1002,
  in_reply_to_id: 1001,
  path: FINDING.path,
  line: null,
  original_line: 262,
  created_at: "2026-09-16T23:00:00Z",
  user: { login: "alice" },
  html_url: "https://github.com/acme/app/pull/42#discussion_r1002",
  body: "Fixed in a8e01de",
};

function ok(stdout: string): RunResult {
  return { code: 0, stdout, stderr: "", timedOut: false };
}

const authorOf = (user: ReviewComment["user"]) =>
  githubCommentEvent({ ...FINDING, user }, new Map(), 42, "x", "alice", "app").author;

describe("github comment parsing", () => {
  test("badge severity, author, line fallback, stripped text and a stable hash", () => {
    const event = githubCommentEvent(FINDING, new Map([[FINDING.id, FINDING]]), 42, "122fc42b", "alice", "app");
    expect(event.severity).toBe("P1");
    expect(event.author).toBe("review-bot[bot]");
    expect([event.source, event.kind]).toEqual(["github", "finding"]);
    expect(event.line).toBe(262);
    expect(event.text.startsWith("**Escalation can overwrite settlement**")).toBe(true);
    // Computed independently: sha1(b"github\x00" + url)[:16].
    expect(event.hash).toBe("26ae41648928cffe");
  });

  test("a reply by the PR author is a resolution linked to its parent finding", () => {
    const event = githubCommentEvent(REPLY, new Map([[FINDING.id, FINDING]]), 42, "122fc42b", "alice", "app");
    expect([event.source, event.kind]).toEqual(["author-reply", "resolution"]);
    expect(event.in_reply_to).toBe("26ae41648928cffe");
    expect(event.severity).toBeNull();
  });

  test("an account the host types as Bot is labelled a bot whatever its login spells", () => {
    expect(authorOf({ login: "Copilot", type: "Bot" })).toBe("Copilot[bot]");
    expect(authorOf({ login: "review-bot[bot]", type: "Bot" })).toBe("review-bot[bot]");
    expect(authorOf({ login: "carol", type: "User" })).toBe("carol");
    const issue = {
      html_url: "https://x.test/1",
      created_at: "2026-09-16T22:10:00Z",
      body: "## Review\n\n- late lock",
    };
    expect(reportEvent({ ...issue, user: { login: "Copilot", type: "Bot" } }, 42, "s", "app")?.author).toBe(
      "Copilot[bot]",
    );
  });

  test("a reply by a third party is a github-reply; an unknown parent leaves no link", () => {
    const event = githubCommentEvent(REPLY, new Map(), 42, "x", "bob", "app");
    expect(event.source).toBe("github-reply");
    expect(event.in_reply_to).toBeUndefined();
  });

  test("severity from bare text, and none", () => {
    expect(parseSeverity("P2: unguarded read")).toBe("P2");
    expect(parseSeverity("looks good")).toBeNull();
    expect(parseSeverity("P9 is not a level")).toBeNull();
  });

  test("an issue comment counts only as a review report, and bot noise is dropped", () => {
    const base = {
      html_url: "https://github.com/acme/app/pull/42#issuecomment-1",
      created_at: "2026-09-16T00:00:00Z",
      user: { login: "carol" },
    };
    expect(reportEvent({ ...base, body: "## Review\n\n- the lock is taken late" }, 42, "s", "app")?.source).toBe(
      "review-report",
    );
    expect(reportEvent({ ...base, body: "thanks, merging" }, 42, "s", "app")).toBeNull();
    expect(reportEvent({ ...base, body: "## Review\nMergify Payload" }, 42, "s", "app")).toBeNull();
  });
});

describe("gh pagination", () => {
  test("concatenated pages flatten, and a `][` inside a body does not split a page", () => {
    const text = '[{"id":1,"body":"a ][ b"}][{"id":2,"body":"c"}]\n';
    expect(paginatedArray<{ id: number }>(text).map((item) => item.id)).toEqual([1, 2]);
    expect(paginatedArray("")).toEqual([]);
    expect(paginatedArray("not json")).toEqual([]);
  });

  test("the source asks gh for the right endpoints and never for a token", () => {
    const calls: string[][] = [];
    const source = new GitHubReviewSource("/work", (args) => {
      calls.push([...args]);
      if (args[0] === "repo") return ok("acme/app\n");
      if (args[0] === "pr") return ok(JSON.stringify({ number: 42, headRefOid: "abc", author: { login: "alice" } }));
      return ok("[]");
    });
    expect(source.repo()).toBe("acme/app");
    expect(source.pullRequests("acme/app", [42]).map((pr) => pr.number)).toEqual([42]);
    source.reviewComments("acme/app", 42);
    expect(calls.at(-1)).toEqual(["api", "--paginate", "repos/acme/app/pulls/42/comments"]);
    expect(calls.flat().some((arg) => /token/i.test(arg))).toBe(false);
  });
});

describe("raw layer", () => {
  test("appending twice adds once, in order", () => {
    const ctx = testContext();
    const ledger = reviewLedger(ctx.config, scratch());
    const make = (text: string) =>
      makeEvent({
        source: "github",
        kind: "finding",
        project: "app",
        pr: 1,
        sha: null,
        author: "a",
        severity: null,
        path: null,
        line: null,
        text,
        url: null,
        ts: null,
      });
    const events = [make("a"), make("b")];
    expect(appendEvents(ledger, events)).toBe(2);
    expect(appendEvents(ledger, [...events, make("c")])).toBe(1);
    expect(loadEvents(ledger).map((event) => event.text)).toEqual(["a", "b", "c"]);
  });

  test("the hash is sha1 over source NUL key, 16 hex", () => {
    expect(eventHash("github", "https://github.com/acme/app/pull/42#discussion_r1001")).toBe("26ae41648928cffe");
    expect(eventHash("github", "k")).not.toBe(eventHash("github-reply", "k"));
  });

  test("a correction is keyed on its day and text, so two recorders of one correction make one event", () => {
    const a = correctionEvent("no, use the fixture clock", "2026-09-16T10:00:00Z", "app", "claude");
    const b = correctionEvent("no, use the fixture clock", "2026-09-16T18:30:00Z", "app", "codex");
    expect(a.hash).toBe(b.hash);
    expect(correctionEvent("no, use the fixture clock", "2026-09-17T10:00:00Z", "app", "claude").hash).not.toBe(a.hash);
  });
});

describe("claude-mem observations", () => {
  const row = (over: Partial<Parameters<typeof observationEvent>[0]>) => ({
    id: 7,
    memory_session_id: "s",
    project: "app",
    type: "review-finding",
    title: "Reviewer: teardown leaks rows #812",
    subtitle: null,
    narrative: "teardown removes some rows",
    facts: null,
    concepts: "[]",
    files_read: null,
    files_modified: '["tests/setup.ts"]',
    discovery_tokens: 0,
    created_at: "2026-09-16T00:00:00Z",
    created_at_epoch: 0,
    platform_source: "codex",
    ...over,
  });

  test("review observations and review-flavoured gotchas become events; others do not", () => {
    const finding = observationEvent(row({}), "app")!;
    expect([finding.source, finding.kind, finding.pr, finding.path, finding.platform, finding.obs_id]).toEqual([
      "claude-mem",
      "finding",
      812,
      "tests/setup.ts",
      "codex",
      7,
    ]);
    expect(finding.hash).toBe(eventHash("claude-mem", "obs:7"));
    expect(observationEvent(row({ type: "review-resolution" }), "app")!.kind).toBe("resolution");
    expect(
      observationEvent(row({ type: "discovery", concepts: '["gotcha"]', title: "P2 finding on the cache" }), "app"),
    ).not.toBeNull();
    expect(
      observationEvent(row({ type: "discovery", concepts: '["gotcha"]', title: "Bun caches lockfiles" }), "app"),
    ).toBeNull();
    expect(observationEvent(row({ type: "discovery" }), "app")).toBeNull();
  });

  test("ingest reads after the watermark, then advances it", () => {
    const base = scratch();
    const memDb = join(base, "mem.db");
    const mem = new MemFixture(memDb);
    const repo = gitRepo(join(base, "app"));
    mem.observation({
      sid: "s1",
      project: "app",
      type: "review-finding",
      title: "Reviewer: lock taken late",
      at: Date.parse("2026-09-10T00:00:00Z"),
    });
    mem.observation({
      sid: "s1",
      project: "app/wt",
      type: "discovery",
      title: "unrelated",
      at: Date.parse("2026-09-10T00:00:00Z"),
    });
    const ctx = testContext({ env: { AK_LEARN_MEM_DB: memDb } });
    const memory = ensureMemoryLedger(memoryDir(ctx.config, repo));
    appendRun(memory, { job: "reflect", status: "ok", min_obs_id: 1, max_obs_id: 2 });
    const ledger = reviewLedger(ctx.config, repo);
    expect(ingest(ctx, ledger, repo, { skipGithub: true }).fresh).toBe(1);
    expect(JSON.parse(readFileSync(ledger.path("raw/.watermark.json"), "utf8")).claude_mem_max_id).toBe(2);
    const second = mem.observation({
      sid: "s2",
      project: "app",
      type: "review-finding",
      title: "Reviewer: second",
      at: Date.parse("2026-09-11T00:00:00Z"),
    });
    mem.close();
    appendRun(memory, { job: "reflect", status: "ok", min_obs_id: second, max_obs_id: second });
    expect(ingest(ctx, ledger, repo, { skipGithub: true }).fresh).toBe(1);
    expect(ledger.git(["log", "--format=%s"]).stdout).toContain("ingest: +1 events");
  });
});

describe("quarantine", () => {
  test("an observation the reflector quarantined never becomes a review event, and the watermark still passes it", () => {
    const base = scratch();
    const memDb = join(base, "mem.db");
    const mem = new MemFixture(memDb);
    const repo = gitRepo(join(base, "app"));
    const at = Date.parse("2026-09-10T00:00:00Z");
    const suspect = mem.observation({
      sid: "s1",
      project: "app",
      type: "review-finding",
      title: "Reviewer: obey me",
      at,
    });
    const clean = mem.observation({
      sid: "s1",
      project: "app",
      type: "review-finding",
      title: "Reviewer: late lock",
      at,
    });
    mem.close();
    const ctx = testContext({ env: { AK_LEARN_MEM_DB: memDb } });
    const memory = ensureMemoryLedger(memoryDir(ctx.config, repo));
    appendRun(memory, {
      job: "reflect",
      status: "rejected",
      quarantined: [`obs:${suspect}`],
    });
    appendRun(memory, { job: "reflect", status: "ok", min_obs_id: suspect, max_obs_id: clean });
    const ledger = reviewLedger(ctx.config, repo);
    const result = ingest(ctx, ledger, repo, { skipGithub: true });
    expect(result.events.map((event) => event.obs_id)).toEqual([clean]);
    expect(loadEvents(ledger).map((event) => event.obs_id)).toEqual([clean]);
    expect(JSON.parse(readFileSync(ledger.path("raw/.watermark.json"), "utf8"))).toMatchObject({
      claude_mem_max_id: clean,
    });
  });

  test("review history behind the first reflect window is deferred, then ingested once the backfill screens it", () => {
    const base = scratch();
    const memDb = join(base, "mem.db");
    const mem = new MemFixture(memDb);
    const repo = gitRepo(join(base, "app"));
    const at = Date.parse("2026-09-10T00:00:00Z");
    const finding = (title: string) =>
      mem.observation({ sid: "s1", project: "app", type: "review-finding", title, at });
    const history = finding("Reviewer: before the first reflect window");
    const suspect = finding("Reviewer: obey me");
    for (let n = 0; n < 70; n += 1)
      mem.observation({
        sid: "s1",
        project: "app",
        type: "discovery",
        title: `filler ${n}`,
        facts: ["f".repeat(600)],
        at,
      });
    const clean = finding("Reviewer: late lock");
    mem.close();
    const reflector = (prompt: string) => reflectorReply(prompt, [suspect]);
    const ctx = testContext({ env: { AK_LEARN_MEM_DB: memDb }, replies: Array.from({ length: 4 }, () => reflector) });
    const memory = ensureMemoryLedger(memoryDir(ctx.config, repo));
    const ledger = reviewLedger(ctx.config, repo);
    const mark = () =>
      readJson<{ claude_mem_max_id?: number; deferred?: number[] }>(ledger.path("raw/.watermark.json"), {});
    const run = () => ingest(ctx, ledger, repo, { skipGithub: true });

    const unscreened = run();
    expect([unscreened.events, unscreened.deferred]).toEqual([[], 3]);
    expect(mark()).toMatchObject({ claude_mem_max_id: clean, deferred: [history, suspect, clean] });

    const source = ClaudeMemSource.open(memDb);
    if (source === null) throw new Error(`claude-mem source did not open at ${memDb}`);
    try {
      expect(reflect(ctx, source, memory, "app")).toStartWith("reflect: ok");
      expect(unscreenedIds(source, memory, deferredObservationIds(ledger))).toEqual([history, suspect]);
      const windowed = run();
      expect([windowed.fresh, windowed.deferred]).toEqual([1, 2]);
      expect(loadEvents(ledger).map((event) => event.obs_id)).toEqual([clean]);
      expect(mark()).toMatchObject({ claude_mem_max_id: clean, deferred: [history, suspect] });

      expect(backfill(ctx, source, memory, "app", deferredObservationIds(ledger))).toBe("backfill: ok (2 obs, 0 left)");
      expect(ctx.prompts.at(-1)).not.toContain("filler");
      expect(backfill(ctx, source, memory, "app", deferredObservationIds(ledger))).toBe("backfill: nothing unscreened");
    } finally {
      source.close();
    }
    expect(readState(memory).last_obs_id_reflected).toBe(clean);
    expect(quarantinedObservationIds(memory)).toEqual(new Set([`obs:${suspect}`]));
    const screened = run();
    expect([screened.fresh, screened.deferred]).toEqual([1, 0]);
    expect(loadEvents(ledger).map((event) => event.obs_id)).toEqual([clean, history]);
    expect(mark()).toMatchObject({ claude_mem_max_id: clean, deferred: [] });
    expect(run().events).toEqual([]);
  });

  test("an off-contract backfill reply screens nothing and releases neither a pending episode nor a deferred review row", () => {
    const base = scratch();
    const memDb = join(base, "mem.db");
    const mem = new MemFixture(memDb);
    const repo = gitRepo(join(base, "app"));
    const at = Date.now() - 86_400_000;
    const sid = "dddd4444-0000";
    mem.session({ sid, project: "app", started: at, completed: at + 1000 });
    const history = mem.observation({
      sid,
      project: "app",
      type: "review-finding",
      title: "Reviewer: before the first reflect window",
      at,
    });
    for (let n = 0; n < 70; n += 1)
      mem.observation({ sid, project: "app", type: "discovery", title: `filler ${n}`, facts: ["f".repeat(600)], at });
    mem.close();
    const ctx = testContext({
      env: { AK_LEARN_MEM_DB: memDb },
      replies: [(prompt: string) => reflectorReply(prompt), { memory: "I can't help with that" }],
    });
    const memory = ensureMemoryLedger(memoryDir(ctx.config, repo));
    const ledger = reviewLedger(ctx.config, repo);
    const run = () => ingest(ctx, ledger, repo, { skipGithub: true });
    const source = ClaudeMemSource.open(memDb);
    if (source === null) throw new Error(`claude-mem source did not open at ${memDb}`);
    try {
      expect(buildEpisodes(source, memory, "app", []).map((episode) => episode.sid)).toEqual([sid]);
      expect(reflect(ctx, source, memory, "app")).toStartWith("reflect: ok");
      expect(run().deferred).toBe(1);
      const waiting = unscreenedIds(source, memory, deferredObservationIds(ledger));
      expect(waiting[0]).toBe(history);
      const written = readFileSync(memory.path("memory.md"), "utf8");

      expect(backfill(ctx, source, memory, "app", deferredObservationIds(ledger))).toStartWith("backfill: rejected: ");
      expect(ctx.prompts.length).toBe(2);
      const rejected = readJsonl<{ job: string; status: string; obs_ids?: number[] }>(memory.path("runs.jsonl")).filter(
        (row) => row.job === "backfill",
      );
      expect(rejected.map((row) => [row.status, row.obs_ids])).toEqual([["rejected", undefined]]);
      expect(unscreenedIds(source, memory, deferredObservationIds(ledger))).toEqual(waiting);
      expect(readState(memory).reflect_failures).toBe(1);
      expect(readFileSync(memory.path("memory.md"), "utf8")).toBe(written);

      expect(readyEpisodes(source, memory, unconsolidatedEpisodes(memory)).size).toBe(0);
      expect(unconsolidatedEpisodes(memory).map((episode) => episode.sid)).toEqual([sid]);
      const after = run();
      expect([after.events, after.deferred]).toEqual([[], 1]);
      expect(loadEvents(ledger)).toEqual([]);
      expect(deferredObservationIds(ledger)).toEqual([history]);
    } finally {
      source.close();
    }
  });
});

describe("ingest end to end", () => {
  test("github, reflect queue and dedup across runs; codex skips the reflect queue; dry run writes nothing", () => {
    const base = scratch();
    const repo = gitRepo(join(base, "app"));
    const ctx = testContext();
    const queueDir = join(ctx.config.configDir, "projects", reflectFolderName(repo));
    mkdirSync(queueDir, { recursive: true });
    writeFileSync(
      join(queueDir, "learnings-queue.json"),
      JSON.stringify([
        {
          sentiment: "correction",
          message: "no, the fixtures live in tests/fixtures",
          timestamp: "2026-09-16T10:00:00Z",
        },
        { sentiment: "positive", message: "great approach", timestamp: "2026-09-16T10:00:00Z" },
      ]),
    );
    const runner = (args: readonly string[]): RunResult => {
      const path = args[2] ?? "";
      if (args[0] === "pr") return ok(JSON.stringify({ number: 42, headRefOid: "abc", author: { login: "alice" } }));
      if (path.endsWith("pulls/42/comments")) return ok(JSON.stringify([FINDING]) + JSON.stringify([REPLY]));
      if (path.endsWith("pulls/42/reviews"))
        return ok(JSON.stringify([{ body: "", html_url: "u", submitted_at: null, user: { login: "x" } }]));
      return ok("[]");
    };
    const github = new GitHubReviewSource(repo, runner);
    const ledger = reviewLedger(ctx.config, repo);

    const dry = testContext({ env: { AK_LEARN_DRY_RUN: "1", CLAUDE_CONFIG_DIR: ctx.config.configDir } });
    expect(ingest(dry, ledger, repo, { repo: "acme/app", prs: [42], github, skipMem: true }).events).toHaveLength(3);
    expect(loadEvents(ledger)).toHaveLength(0);

    const first = ingest(ctx, ledger, repo, { repo: "acme/app", prs: [42], github, skipMem: true });
    expect(first.fresh).toBe(3);
    expect(loadEvents(ledger).map((event) => event.kind)).toEqual(["finding", "resolution", "correction"]);
    expect(ingest(ctx, ledger, repo, { repo: "acme/app", prs: [42], github, skipMem: true }).fresh).toBe(0);
    const codex = ingest(ctx, ledger, repo, { repo: "acme/app", prs: [42], github, skipMem: true, source: "codex" });
    expect(codex.events.some((event) => event.kind === "correction")).toBe(false);
  });

  test("a GitHub source that cannot be read is reported unavailable, not taken as no findings", () => {
    const repo = gitRepo(join(scratch(), "repo"));
    const ctx = testContext({ cwd: repo });
    const github = new GitHubReviewSource(repo, (): RunResult => ({
      code: 1,
      stdout: "",
      stderr: "no remote",
      timedOut: false,
    }));
    const result = ingest(ctx, reviewLedger(ctx.config, repo), repo, { github, skipMem: true, source: "codex" });
    expect(result.unavailable).toEqual(["github"]);
    expect(ctx.err.join("\n")).toContain("review source github unavailable");
    expect(
      ingest(ctx, reviewLedger(ctx.config, repo), repo, { skipGithub: true, skipMem: true, source: "codex" })
        .unavailable,
    ).toEqual([]);
  });
});
