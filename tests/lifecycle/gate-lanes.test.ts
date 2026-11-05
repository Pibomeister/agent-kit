import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  acquireLane,
  checkUnpublished,
  formatStatus,
  holdersDir,
  laneKey,
  laneStatus,
  releaseLane,
  waitersDir,
  resolveMaxAgeMinutes,
  resolvePool,
  type LaneIdentity,
} from "../../src/lifecycle/gate-lanes.ts";
import { main } from "../../src/lifecycle/gate.ts";
import { processScratch } from "../helpers/process-tmp.ts";

const laneA: LaneIdentity = { lane: "lane-a", branch: "fm/a", worktree: "/tmp/worktree-a" };
const laneB: LaneIdentity = { lane: "lane-b", branch: "fm/b", worktree: "/tmp/worktree-b" };
const noSleep = () => undefined;
/** A fake clock whose sleep advances it, so waiting is deterministic. */
function fakeClock(start = 1_700_000_000_000) {
  let at = start;
  return {
    now: () => at,
    sleep: (ms: number) => {
      at += ms;
    },
    advance: (ms: number) => {
      at += ms;
    },
  };
}

describe("gate lanes (issue #194)", () => {
  test("distinct lanes hold at once; the same lane excludes a second holder and names it", () => {
    const dir = processScratch("ak-gate-lanes-");
    const clock = fakeClock();
    const first = acquireLane(dir, laneA, { now: clock.now, sleep: noSleep, pid: process.pid });
    expect(first.ok).toBe(true);
    // Counterfactual to the global lock: another lane is not serialized behind lane A.
    const other = acquireLane(dir, laneB, { now: clock.now, sleep: noSleep, pid: process.pid });
    expect(other.ok).toBe(true);
    if (other.ok) other.release();
    const second = acquireLane(dir, laneA, {
      now: clock.now,
      sleep: clock.sleep,
      pid: 424_242,
      timeoutMs: 1_000,
      pollMs: 250,
    });
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.reason).toContain(`pid ${process.pid}`);
      expect(second.holder?.branch).toBe("fm/a");
      expect(second.waited_ms).toBeGreaterThanOrEqual(1_000);
    }
    if (first.ok) first.release();
    const after = acquireLane(dir, laneA, { now: clock.now, sleep: noSleep, pid: process.pid });
    expect(after.ok).toBe(true);
    if (after.ok) after.release();
  });

  test("a bounded pool caps concurrent lanes and frees on release", () => {
    const dir = processScratch("ak-gate-lanes-");
    const clock = fakeClock();
    const first = acquireLane(dir, laneA, { pool: 1, now: clock.now, sleep: noSleep, pid: process.pid });
    expect(first.ok).toBe(true);
    const blocked = acquireLane(dir, laneB, {
      pool: 1,
      now: clock.now,
      sleep: clock.sleep,
      pid: 424_242,
      timeoutMs: 500,
      pollMs: 250,
    });
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.reason).toContain("pool is full");
    if (first.ok) first.release();
    const admitted = acquireLane(dir, laneB, { pool: 1, now: clock.now, sleep: noSleep, pid: process.pid });
    expect(admitted.ok).toBe(true);
    if (admitted.ok) admitted.release();
  });

  test("status names holder and waiter with held and waiting durations", async () => {
    const dir = processScratch("ak-gate-lanes-");
    const helper = join(dir, "hold.ts");
    writeFileSync(
      helper,
      `import { acquireLane } from ${JSON.stringify(join(import.meta.dir, "../../src/lifecycle/gate-lanes.ts"))};
const [dir, branch, holdMs, timeoutMs] = process.argv.slice(2);
const got = acquireLane(dir!, { lane: branch!, branch: branch!, worktree: "/tmp/" + branch }, { timeoutMs: Number(timeoutMs), pollMs: 25 });
if (!got.ok) { console.log("refused: " + got.reason); process.exit(1); }
console.log("acquired");
await new Promise((resolve) => setTimeout(resolve, Number(holdMs)));
got.release();
`,
    );
    const holder = Bun.spawn(["bun", helper, dir, "fm/a", "3000", "0"], { stdout: "pipe", stderr: "pipe" });
    // Poll the store (the visibility surface itself) until the holder appears.
    for (let i = 0; i < 100 && laneStatus(dir, Date.now()).holders.length === 0; i += 1)
      await new Promise((resolve) => setTimeout(resolve, 25));
    expect(laneStatus(dir, Date.now()).holders).toHaveLength(1);
    const waiter = Bun.spawn(["bun", helper, dir, "fm/a", "10", "8000"], { stdout: "pipe", stderr: "pipe" });
    // The waiter registers visibly while it queues behind the holder.
    let status = laneStatus(dir, Date.now());
    for (let i = 0; i < 100 && status.waiters.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      status = laneStatus(dir, Date.now());
    }
    expect(status.holders.map((holderRow) => holderRow.branch)).toEqual(["fm/a"]);
    expect(status.waiters).toHaveLength(1);
    expect(status.waiters[0]?.branch).toBe("fm/a");
    expect(status.waiters[0]?.waiting_ms).toBeGreaterThanOrEqual(0);
    const lines = formatStatus(status);
    expect(lines.some((line) => line.startsWith("holder:") && line.includes("held="))).toBe(true);
    expect(lines.some((line) => line.startsWith("waiter:") && line.includes("waiting="))).toBe(true);
    expect(await waiter.exited).toBe(0);
    expect(await holder.exited).toBe(0);
    // Both gone: the queue drains and no record is left behind.
    expect(laneStatus(dir, Date.now())).toEqual({ holders: [], waiters: [] });
  }, 30_000);

  test("a dead holder's lock is reclaimed and a live foreign holder is not released", () => {
    const dir = processScratch("ak-gate-lanes-");
    const deadPid = 999_999;
    // The crash the pid check exists for: a holder record naming a pid that is
    // not alive, left behind and never released.
    const stale = acquireLane(dir, laneA, { pid: deadPid, sleep: noSleep });
    expect(stale.ok).toBe(true);
    expect(existsSync(join(holdersDir(dir), `${laneKey(laneA)}.json`))).toBe(true);
    const reclaimed = acquireLane(dir, laneA, { pid: process.pid, sleep: noSleep });
    expect(reclaimed.ok).toBe(true);
    const refused = releaseLane(dir, laneA, { pid: 424_242 });
    expect(refused.ok).toBe(false);
    expect(refused.reason).toContain("live pid");
    if (reclaimed.ok) reclaimed.release();
    expect(laneStatus(dir, Date.now()).holders).toEqual([]);
  });

  test("status hides same-host holders and waiters whose pid is dead", () => {
    const dir = processScratch("ak-gate-lanes-");
    const deadPid = 999_999;
    const host = "lane-host";
    mkdirSync(waitersDir(dir), { recursive: true });
    const stale = acquireLane(dir, laneA, { pid: deadPid, host, sleep: noSleep });
    expect(stale.ok).toBe(true);
    const enqueued = new Date().toISOString();
    writeFileSync(
      join(waitersDir(dir), `${laneKey(laneB)}-${deadPid}.json`),
      JSON.stringify({ ...laneB, pid: deadPid, host, enqueued_at: enqueued }),
    );
    expect(laneStatus(dir, Date.now(), host)).toEqual({ holders: [], waiters: [] });
    const elsewhere = laneStatus(dir, Date.now(), "other-host");
    expect(elsewhere.holders).toHaveLength(1);
    expect(elsewhere.waiters).toHaveLength(1);
  });

  test("an unreadable holder record still honours the wait timeout", () => {
    const dir = processScratch("ak-gate-lanes-");
    mkdirSync(holdersDir(dir), { recursive: true });
    writeFileSync(join(holdersDir(dir), `${laneKey(laneA)}.json`), "{ truncated");
    const clock = fakeClock();
    const waits: string[] = [];
    const got = acquireLane(dir, laneA, {
      now: clock.now,
      sleep: clock.sleep,
      pollMs: 100,
      timeoutMs: 1_000,
      onWait: (reason) => waits.push(reason),
    });
    expect(waits.length).toBeGreaterThan(0);
    expect(waits[0]).toContain("unreadable holder record");
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.reason).toContain("unreadable holder record");
  });

  test("lanes status lists the queue from an explicit --dir outside a git checkout", () => {
    const outside = processScratch("ak-gate-lanes-nogit-");
    const dir = join(outside, "evidence");
    const held = acquireLane(join(dir, "gate-lanes"), laneA, { sleep: noSleep });
    expect(held.ok).toBe(true);
    const out: string[] = [];
    const err: string[] = [];
    const code = main(
      ["lanes", "status", "--dir", dir, "--json"],
      { out: (l) => out.push(l), err: (l) => err.push(l) },
      outside,
    );
    expect(err).toEqual([]);
    expect(code).toBe(0);
    const status = JSON.parse(out.join("\n")) as { holders: { lane: string }[] };
    expect(status.holders.map((holder) => holder.lane)).toEqual([laneA.lane]);
    if (held.ok) held.release();
  });

  test("a lane name only labels the holder: the same worktree and branch still exclude", () => {
    const dir = processScratch("ak-gate-lanes-");
    const first = acquireLane(dir, { ...laneA, lane: "review" }, { sleep: noSleep });
    expect(first.ok).toBe(true);
    const second = acquireLane(dir, laneA, { sleep: noSleep });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.holder?.lane).toBe("review");
    expect(releaseLane(dir, laneA).ok).toBe(true);
    if (first.ok) first.release();
  });

  test("pool and unpublished limits resolve flag over env over default", () => {
    expect(resolvePool(undefined, undefined)).toBeUndefined();
    expect(resolvePool(undefined, "3")).toBe(3);
    expect(resolvePool("2", "3")).toBe(2);
    expect(resolvePool("0", undefined)).toBeUndefined();
    expect(resolveMaxAgeMinutes(undefined, undefined)).toBe(30);
    expect(resolveMaxAgeMinutes(undefined, "45")).toBe(45);
    expect(resolveMaxAgeMinutes("10", "45")).toBe(10);
  });
});

const UNPUBLISHED_NOW = () => Date.parse("2026-01-03T00:00:00Z");

function git(project: string, args: string[], env: Record<string, string> = {}): string {
  const result = spawnSync("git", ["-C", project, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: project, ...env },
  });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (line: string) => out.push(line), err: (line: string) => err.push(line) } };
}

function scratchRepo(prefix: string): { dir: string; repo: string } {
  const dir = processScratch(prefix);
  const repo = join(dir, "repo");
  spawnSync("git", ["init", "-b", "fm/run", repo], { encoding: "utf8" });
  git(repo, ["config", "user.email", "lane@example.invalid"]);
  git(repo, ["config", "user.name", "Lane"]);
  writeFileSync(join(repo, "base.txt"), "base\n");
  git(repo, ["add", "base.txt"]);
  git(repo, ["commit", "-m", "base"]);
  return { dir, repo };
}

describe("lanes run entry point (issue #194)", () => {
  test("runs the command under the lane lock, releases it, and refuses a held lane", () => {
    const { dir, repo } = scratchRepo("ak-gate-lanes-run-");
    const store = join(dir, "evidence");
    const ran = capture();
    expect(main(["lanes", "run", "--dir", store, "--project", repo, "--", "true"], ran.io, repo)).toBe(0);
    expect(laneStatus(join(store, "gate-lanes"), Date.now())).toEqual({ holders: [], waiters: [] });
    const failing = capture();
    expect(main(["lanes", "run", "--dir", store, "--project", repo, "--", "false"], failing.io, repo)).toBe(1);
    const held = acquireLane(
      join(store, "gate-lanes"),
      { lane: "other", branch: "fm/run", worktree: git(repo, ["rev-parse", "--show-toplevel"]) },
      { sleep: noSleep },
    );
    expect(held.ok).toBe(true);
    const refused = capture();
    const code = main(
      ["lanes", "run", "--lane", "mine", "--timeout-minutes", "0", "--dir", store, "--project", repo, "--", "true"],
      refused.io,
      repo,
    );
    expect(code).toBe(1);
    expect(refused.err.join("\n")).toContain("refused");
    if (held.ok) held.release();
  });

  test("an invalid --timeout-minutes is a usage error, not an unbounded wait", () => {
    const { dir, repo } = scratchRepo("ak-gate-lanes-run-");
    const bad = capture();
    const code = main(
      ["lanes", "run", "--timeout-minutes", "abc", "--dir", join(dir, "evidence"), "--project", repo, "--", "true"],
      bad.io,
      repo,
    );
    expect(code).toBe(2);
    expect(bad.err.join("\n")).toContain("--timeout-minutes");
  });
});

describe("unpublished-commit age check (issue #194)", () => {
  test("a git failure is an error, never a clean 'none unpublished'", () => {
    const outside = processScratch("ak-gate-unpublished-nogit-");
    expect(() => checkUnpublished(outside, 30, { now: UNPUBLISHED_NOW })).toThrow();
    const result = capture();
    expect(main(["lanes", "unpublished", "--project", outside], result.io, outside)).toBe(1);
    expect(result.out).toEqual([]);
    expect(result.err.join("\n")).toContain("no readable HEAD");
  });

  test("an old commit no remote holds is overdue; a generous limit and a pushed branch are not", () => {
    const dir = processScratch("ak-gate-unpublished-");
    const repo = join(dir, "repo");
    spawnSync("git", ["init", "-b", "main", repo], { encoding: "utf8" });
    git(repo, ["config", "user.email", "lane@example.invalid"]);
    git(repo, ["config", "user.name", "Lane"]);
    writeFileSync(join(repo, "work.txt"), "committed but never published\n");
    git(repo, ["add", "work.txt"]);
    const old = {
      GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
      GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
    };
    git(repo, ["commit", "-m", "old unpublished work"], old);
    expect(() => checkUnpublished(repo, 30, { now: UNPUBLISHED_NOW })).toThrow("`origin` remote");
    const remote = join(dir, "remote.git");
    spawnSync("git", ["init", "--bare", remote], { encoding: "utf8" });
    git(repo, ["remote", "add", "origin", remote]);
    const overdue = checkUnpublished(repo, 30, { now: UNPUBLISHED_NOW });
    expect(overdue).toMatchObject({ branch: "main", unpublished: 1, age_minutes: 2_880, overdue: true });
    expect(checkUnpublished(repo, 10_000, { now: UNPUBLISHED_NOW }).overdue).toBe(false);
    // A gate remote holding the commit does not publish it: only origin does.
    const gate = join(dir, "gate.git");
    spawnSync("git", ["init", "--bare", gate], { encoding: "utf8" });
    git(repo, ["remote", "add", "no-mistakes", gate]);
    git(repo, ["push", "no-mistakes", "main"]);
    expect(git(repo, ["rev-parse", "refs/remotes/no-mistakes/main"])).toBe(git(repo, ["rev-parse", "HEAD"]));
    expect(checkUnpublished(repo, 30, { now: UNPUBLISHED_NOW })).toMatchObject({ unpublished: 1, overdue: true });
    // Publish to origin: the same commit stops counting as unpublished.
    git(repo, ["push", "origin", "main"]);
    expect(checkUnpublished(repo, 30, { now: UNPUBLISHED_NOW })).toMatchObject({ unpublished: 0, overdue: false });
    // A fresh local commit after the push is unpublished but not yet overdue.
    writeFileSync(join(repo, "work.txt"), "fresh\n");
    git(repo, ["add", "work.txt"]);
    git(repo, ["commit", "-m", "fresh work"], {
      GIT_AUTHOR_DATE: "2026-01-02T23:50:00Z",
      GIT_COMMITTER_DATE: "2026-01-02T23:50:00Z",
    });
    expect(checkUnpublished(repo, 30, { now: UNPUBLISHED_NOW })).toMatchObject({
      unpublished: 1,
      age_minutes: 10,
      overdue: false,
    });
  });

  test("a lane branch tracking origin/main counts as published once pushed under its own name", () => {
    const dir = processScratch("ak-gate-unpublished-");
    const repo = join(dir, "repo");
    spawnSync("git", ["init", "-b", "main", repo], { encoding: "utf8" });
    git(repo, ["config", "user.email", "lane@example.invalid"]);
    git(repo, ["config", "user.name", "Lane"]);
    writeFileSync(join(repo, "base.txt"), "base\n");
    git(repo, ["add", "base.txt"]);
    git(repo, ["commit", "-m", "base"]);
    const remote = join(dir, "remote.git");
    spawnSync("git", ["init", "--bare", remote], { encoding: "utf8" });
    git(repo, ["remote", "add", "origin", remote]);
    git(repo, ["push", "origin", "main"]);
    git(repo, ["fetch", "origin"]);
    git(repo, ["switch", "--track", "-c", "fm/x", "origin/main"]);
    writeFileSync(join(repo, "work.txt"), "lane work\n");
    git(repo, ["add", "work.txt"]);
    git(repo, ["commit", "-m", "lane work"], {
      GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
      GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
    });
    expect(checkUnpublished(repo, 30, { now: UNPUBLISHED_NOW })).toMatchObject({ unpublished: 1, overdue: true });
    git(repo, ["push", "origin", "fm/x"]);
    expect(git(repo, ["rev-parse", "--abbrev-ref", "@{upstream}"])).toBe("origin/main");
    expect(checkUnpublished(repo, 30, { now: UNPUBLISHED_NOW })).toMatchObject({
      branch: "fm/x",
      unpublished: 0,
      overdue: false,
    });
  });
});
