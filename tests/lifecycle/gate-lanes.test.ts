import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  acquireLane,
  checkUnpublished,
  DEFAULT_LANES_WAIT_MINUTES,
  formatStatus,
  holdersDir,
  laneHolderToken,
  laneKey,
  laneStatus,
  publishLane,
  releaseLane,
  waitersDir,
  resolveLanesEnabled,
  resolveLanesWaitMs,
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
    expect(JSON.parse(out.join("\n"))).toMatchObject({ holders: [{ lane: laneA.lane }] });
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

  test("a matching live holder token re-enters; a token rebuilt from status JSON does not", () => {
    const dir = processScratch("ak-gate-lanes-");
    const clock = fakeClock();
    const first = acquireLane(dir, laneA, { now: clock.now, sleep: noSleep, pid: process.pid });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(statSync(join(holdersDir(dir), `${laneKey(laneA)}.json`)).mode & 0o777).toBe(0o600);
    const nested = acquireLane(dir, laneA, {
      now: clock.now,
      sleep: noSleep,
      pid: 424_242,
      inherited: laneHolderToken(first.holder),
      timeoutMs: 1_000,
    });
    expect(nested.ok).toBe(true);
    if (nested.ok) {
      expect(nested.waited_ms).toBe(0);
      nested.release();
    }
    const status = laneStatus(dir, clock.now());
    expect(status.holders).toHaveLength(1);
    const visible = status.holders[0];
    expect(visible).toBeDefined();
    if (visible === undefined) return;
    expect(visible.nonce).toBeUndefined();
    expect(JSON.stringify(status)).not.toContain("nonce");
    const rebuilt = `${visible.pid} ${visible.acquired_at} ${laneKey(visible)}`;
    const spoofed = acquireLane(dir, laneA, {
      now: clock.now,
      sleep: clock.sleep,
      pid: 424_242,
      inherited: rebuilt,
      timeoutMs: 1_000,
      pollMs: 250,
    });
    expect(spoofed.ok).toBe(false);
    if (!spoofed.ok) {
      expect(spoofed.reason).toContain(`pid ${process.pid}`);
      expect(spoofed.holder?.pid).toBe(process.pid);
      expect(spoofed.waited_ms).toBeGreaterThanOrEqual(1_000);
    }
    first.release();
  });

  test("pool and unpublished limits resolve flag over env over default", () => {
    expect(resolvePool(undefined, undefined)).toBeUndefined();
    expect(resolvePool(undefined, "3")).toBe(3);
    expect(resolvePool("2", "3")).toBe(2);
    expect(resolvePool("0", undefined)).toBeUndefined();
    expect(() => resolvePool("two", undefined)).toThrow("--pool");
    expect(() => resolvePool(undefined, "-1")).toThrow("AK_GATE_LANES_POOL");
    expect(resolveMaxAgeMinutes(undefined, undefined)).toBe(30);
    expect(resolveMaxAgeMinutes(undefined, "45")).toBe(45);
    expect(resolveMaxAgeMinutes("10", "45")).toBe(10);
    expect(resolveMaxAgeMinutes("0", undefined)).toBe(0);
    expect(() => resolveMaxAgeMinutes("5m", undefined)).toThrow("--max-age-minutes");
    expect(() => resolveMaxAgeMinutes(undefined, "-3")).toThrow("AK_GATE_UNPUBLISHED_MAX_AGE_MINUTES");
    expect(resolveLanesEnabled(false, undefined)).toBe(false);
    expect(resolveLanesEnabled(false, "")).toBe(false);
    expect(resolveLanesEnabled(false, "0")).toBe(false);
    expect(resolveLanesEnabled(false, "1")).toBe(true);
    expect(resolveLanesEnabled(true, "0")).toBe(true);
    expect(() => resolveLanesEnabled(false, "yes")).toThrow("AK_GATE_LANES");
    expect(resolveLanesWaitMs(undefined)).toBe(DEFAULT_LANES_WAIT_MINUTES * 60_000);
    expect(Number.isFinite(resolveLanesWaitMs(undefined))).toBe(true);
    expect(resolveLanesWaitMs("0")).toBe(0);
  });

  test("check/record --lanes with no --timeout-minutes uses DEFAULT_LANES_WAIT_MINUTES", () => {
    expect(resolveLanesWaitMs(undefined)).toBe(DEFAULT_LANES_WAIT_MINUTES * 60_000);
    expect(resolveLanesWaitMs(undefined)).not.toBe(Number.POSITIVE_INFINITY);
  });
});

const UNPUBLISHED_NOW = () => Date.parse("2026-01-03T00:00:00Z");

function gitEnv(project: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    HOME: project,
    ...extra,
  };
}

function git(project: string, args: string[], env: Record<string, string> = {}): string {
  const result = spawnSync("git", ["-C", project, ...args], {
    encoding: "utf8",
    env: gitEnv(project, env),
  });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (line: string) => out.push(line), err: (line: string) => err.push(line) } };
}

function scratchRepo(prefix: string, branch = "fm/run") {
  const dir = processScratch(prefix);
  const repo = join(dir, "repo");
  spawnSync("git", ["init", "-b", branch, repo], { encoding: "utf8", env: gitEnv(repo) });
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
  }, 30_000);

  test("an invalid --pool or --max-age-minutes is a named usage error", () => {
    const { dir, repo } = scratchRepo("ak-gate-lanes-run-");
    const pool = capture();
    expect(
      main(
        ["lanes", "run", "--pool", "two", "--dir", join(dir, "evidence"), "--project", repo, "--", "true"],
        pool.io,
        repo,
      ),
    ).toBe(2);
    expect(pool.err.join("\n")).toContain("--pool");
    const age = capture();
    expect(main(["lanes", "unpublished", "--max-age-minutes", "5m", "--project", repo], age.io, repo)).toBe(2);
    expect(age.err.join("\n")).toContain("--max-age-minutes");
  }, 30_000);

  test("a child check --lanes under lanes run completes", () => {
    const { dir, repo } = scratchRepo("ak-gate-lanes-child-check-");
    const store = join(dir, "evidence");
    const log = join(dir, "child.err");
    const helper = join(dir, "gate-main.ts");
    writeFileSync(
      helper,
      `import { writeFileSync } from "node:fs";
import { main } from ${JSON.stringify(join(import.meta.dir, "../../src/lifecycle/gate.ts"))};
const err: string[] = [];
const code = main(process.argv.slice(2), {
  out: (line) => console.log(line),
  err: (line) => { err.push(line); console.error(line); },
}, process.cwd());
writeFileSync(${JSON.stringify(log)}, err.join("\\n"));
process.exit(code);
`,
    );
    const ran = capture();
    const code = main(
      [
        "lanes",
        "run",
        "--dir",
        store,
        "--project",
        repo,
        "--",
        process.execPath,
        helper,
        "check",
        "--lanes",
        "--dir",
        store,
        "--project",
        repo,
        "--gates",
        "build-checks",
      ],
      ran.io,
      repo,
    );
    expect(code).toBe(1);
    expect(ran.err.join("\n")).not.toContain("refused: lane");
    const childErr = existsSync(log) ? readFileSync(log, "utf8") : "";
    expect(childErr).not.toContain("refused: lane");
    expect(childErr).not.toContain("queued:");
    expect(childErr).toContain("no current evidence");
    expect(laneStatus(join(store, "gate-lanes"), Date.now())).toEqual({ holders: [], waiters: [] });
  }, 30_000);

  test("an AK_GATE_LANES=1 child under lanes run completes", () => {
    const { dir, repo } = scratchRepo("ak-gate-lanes-child-env-");
    const store = join(dir, "evidence");
    const log = join(dir, "child.err");
    const helper = join(dir, "gate-main.ts");
    writeFileSync(
      helper,
      `import { writeFileSync } from "node:fs";
import { main } from ${JSON.stringify(join(import.meta.dir, "../../src/lifecycle/gate.ts"))};
const err: string[] = [];
const code = main(process.argv.slice(2), {
  out: (line) => console.log(line),
  err: (line) => { err.push(line); console.error(line); },
}, process.cwd());
writeFileSync(${JSON.stringify(log)}, err.join("\\n"));
process.exit(code);
`,
    );
    const ran = capture();
    const code = main(
      [
        "lanes",
        "run",
        "--dir",
        store,
        "--project",
        repo,
        "--",
        "env",
        "AK_GATE_LANES=1",
        process.execPath,
        helper,
        "check",
        "--dir",
        store,
        "--project",
        repo,
        "--gates",
        "build-checks",
      ],
      ran.io,
      repo,
    );
    expect(code).toBe(1);
    expect(ran.err.join("\n")).not.toContain("refused: lane");
    const childErr = existsSync(log) ? readFileSync(log, "utf8") : "";
    expect(childErr).not.toContain("refused: lane");
    expect(childErr).not.toContain("queued:");
    expect(childErr).toContain("no current evidence");
    expect(laneStatus(join(store, "gate-lanes"), Date.now())).toEqual({ holders: [], waiters: [] });
  }, 30_000);

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
  }, 30_000);
});

describe("unpublished-commit age check (issue #194)", () => {
  test("the answer follows local origin refs: stale until the caller fetches, then refreshed", () => {
    const { dir, repo } = scratchRepo("ak-gate-unpublished-fresh-");
    const origin = join(dir, "origin.git");
    spawnSync("git", ["init", "--bare", origin], { encoding: "utf8" });
    git(repo, ["remote", "add", "origin", origin]);
    git(repo, ["fetch", "origin"]);
    const gate = join(dir, "gate.git");
    spawnSync("git", ["clone", "--bare", repo, gate], { encoding: "utf8" });
    git(gate, ["push", origin, "fm/run"]);
    const stale = capture();
    expect(main(["lanes", "unpublished", "--project", repo], stale.io, repo)).toBe(0);
    expect(stale.out.join("\n")).toContain("unpublished: 1 commit(s) on fm/run");
    expect(stale.out.join("\n")).toContain("basis: local origin-tracking refs");
    expect(stale.out.join("\n")).toContain("git fetch origin");
    git(repo, ["fetch", "origin"]);
    const fresh = capture();
    expect(main(["lanes", "unpublished", "--project", repo, "--json"], fresh.io, repo)).toBe(0);
    expect(JSON.parse(fresh.out.join("\n"))).toMatchObject({ unpublished: 0, overdue: false });
  }, 30_000);

  test("a git failure is an error, never a clean 'none unpublished'", () => {
    const outside = processScratch("ak-gate-unpublished-nogit-");
    expect(() => checkUnpublished(outside, 30, { now: UNPUBLISHED_NOW })).toThrow();
    const result = capture();
    expect(main(["lanes", "unpublished", "--project", outside], result.io, outside)).toBe(1);
    expect(result.out).toEqual([]);
    expect(result.err.join("\n")).toContain("no readable HEAD");
  }, 30_000);

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
  }, 30_000);

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
  }, 30_000);
});

describe("lanes publish (issue #194)", () => {
  test("pushes HEAD to origin while the lane lock is held", () => {
    const { dir, repo } = scratchRepo("ak-gate-lanes-publish-");
    const origin = join(dir, "origin.git");
    spawnSync("git", ["init", "--bare", origin], { encoding: "utf8", env: gitEnv(dir) });
    git(repo, ["remote", "add", "origin", origin]);
    git(repo, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
    writeFileSync(join(repo, "next.txt"), "land while queued\n");
    git(repo, ["add", "next.txt"]);
    git(repo, ["commit", "-m", "land while queued"]);
    const sha = git(repo, ["rev-parse", "HEAD"]);
    const store = join(dir, "evidence");
    const held = acquireLane(
      join(store, "gate-lanes"),
      { lane: "fm/run", branch: "fm/run", worktree: git(repo, ["rev-parse", "--show-toplevel"]) },
      { sleep: noSleep },
    );
    expect(held.ok).toBe(true);
    const published = capture();
    expect(main(["lanes", "publish", "--project", repo], published.io, repo)).toBe(0);
    expect(published.out.join("\n")).toContain("gate lock not taken");
    expect(git(origin, ["rev-parse", "fm/run"])).toBe(sha);
    expect(laneStatus(join(store, "gate-lanes"), Date.now()).holders).toHaveLength(1);
    if (held.ok) held.release();
    expect(publishLane(repo)).toMatchObject({ branch: "fm/run", sha });
  }, 30_000);

  test("refuses main, master, and origin's default branch", () => {
    const mainRepo = scratchRepo("ak-gate-lanes-publish-main-", "main");
    const originMain = join(mainRepo.dir, "origin.git");
    spawnSync("git", ["init", "--bare", originMain], { encoding: "utf8", env: gitEnv(mainRepo.dir) });
    git(mainRepo.repo, ["remote", "add", "origin", originMain]);
    const onMain = capture();
    expect(main(["lanes", "publish", "--project", mainRepo.repo], onMain.io, mainRepo.repo)).toBe(1);
    expect(onMain.err.join("\n")).toContain("origin's default branch");

    const masterRepo = scratchRepo("ak-gate-lanes-publish-master-", "master");
    const originMaster = join(masterRepo.dir, "origin.git");
    spawnSync("git", ["init", "--bare", originMaster], { encoding: "utf8", env: gitEnv(masterRepo.dir) });
    git(masterRepo.repo, ["remote", "add", "origin", originMaster]);
    const onMaster = capture();
    expect(main(["lanes", "publish", "--project", masterRepo.repo], onMaster.io, masterRepo.repo)).toBe(1);
    expect(onMaster.err.join("\n")).toContain("origin's default branch");

    const { dir, repo } = scratchRepo("ak-gate-lanes-publish-default-", "develop");
    const origin = join(dir, "origin.git");
    spawnSync("git", ["init", "--bare", origin], { encoding: "utf8", env: gitEnv(dir) });
    git(repo, ["remote", "add", "origin", origin]);
    git(repo, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/develop"]);
    const onDefault = capture();
    expect(main(["lanes", "publish", "--project", repo], onDefault.io, repo)).toBe(1);
    expect(onDefault.err.join("\n")).toContain("origin's default branch");
    expect(onDefault.err.join("\n")).toContain("develop");
  }, 30_000);

  test("refuses MAIN, Main, MASTER, and a refs/ branch name", () => {
    for (const branch of ["MAIN", "Main", "MASTER"]) {
      const { dir, repo } = scratchRepo(`ak-gate-lanes-publish-${branch}-`, branch);
      const origin = join(dir, "origin.git");
      spawnSync("git", ["init", "--bare", origin], { encoding: "utf8", env: gitEnv(dir) });
      git(repo, ["remote", "add", "origin", origin]);
      const refused = capture();
      expect(main(["lanes", "publish", "--project", repo], refused.io, repo)).toBe(1);
      expect(refused.err.join("\n")).toContain("refusing to publish");
    }
    const { dir, repo } = scratchRepo("ak-gate-lanes-publish-refs-");
    const origin = join(dir, "origin.git");
    spawnSync("git", ["init", "--bare", origin], { encoding: "utf8", env: gitEnv(dir) });
    git(repo, ["remote", "add", "origin", origin]);
    git(repo, ["branch", "-m", "refs/heads/main"]);
    const onRefs = capture();
    expect(main(["lanes", "publish", "--project", repo], onRefs.io, repo)).toBe(1);
    expect(onRefs.err.join("\n")).toContain("refs/");
  }, 30_000);

  test("refuses when origin/HEAD is unset and the remote default matches, or when the default is unknown", () => {
    const { dir, repo } = scratchRepo("ak-gate-lanes-publish-lsremote-", "develop");
    const origin = join(dir, "origin.git");
    spawnSync("git", ["init", "--bare", origin], { encoding: "utf8", env: gitEnv(dir) });
    git(origin, ["symbolic-ref", "HEAD", "refs/heads/develop"]);
    git(repo, ["remote", "add", "origin", origin]);
    const onRemoteDefault = capture();
    expect(main(["lanes", "publish", "--project", repo], onRemoteDefault.io, repo)).toBe(1);
    expect(onRemoteDefault.err.join("\n")).toContain("origin's default branch");
    expect(onRemoteDefault.err.join("\n")).toContain("develop");

    const unknown = scratchRepo("ak-gate-lanes-publish-unknown-");
    const bogus = join(unknown.dir, "not-a-git");
    mkdirSync(bogus);
    git(unknown.repo, ["remote", "add", "origin", bogus]);
    const onUnknown = capture();
    expect(main(["lanes", "publish", "--project", unknown.repo], onUnknown.io, unknown.repo)).toBe(1);
    expect(onUnknown.err.join("\n")).toContain("set origin/HEAD");
    expect(onUnknown.err.join("\n")).toContain("git remote set-head origin -a");
  }, 30_000);

  test("refuses a non-fast-forward push to origin", () => {
    const { dir, repo } = scratchRepo("ak-gate-lanes-publish-nff-");
    const origin = join(dir, "origin.git");
    spawnSync("git", ["init", "--bare", origin], { encoding: "utf8", env: gitEnv(dir) });
    git(repo, ["remote", "add", "origin", origin]);
    git(repo, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
    writeFileSync(join(repo, "next.txt"), "first\n");
    git(repo, ["add", "next.txt"]);
    git(repo, ["commit", "-m", "first"]);
    const first = capture();
    expect(main(["lanes", "publish", "--project", repo], first.io, repo)).toBe(0);
    const originSha = git(origin, ["rev-parse", "fm/run"]);
    git(repo, ["reset", "--hard", "HEAD~1"]);
    writeFileSync(join(repo, "other.txt"), "diverged\n");
    git(repo, ["add", "other.txt"]);
    git(repo, ["commit", "-m", "diverged"]);
    const refused = capture();
    expect(main(["lanes", "publish", "--project", repo], refused.io, repo)).toBe(1);
    expect(refused.err.join("\n")).toContain("non-fast-forward");
    expect(git(origin, ["rev-parse", "fm/run"])).toBe(originSha);
  }, 30_000);

  test("refuses a checkout with no origin and a detached HEAD", () => {
    const { dir, repo } = scratchRepo("ak-gate-lanes-publish-err-");
    const missing = capture();
    expect(main(["lanes", "publish", "--project", repo], missing.io, repo)).toBe(1);
    expect(missing.err.join("\n")).toContain("origin");
    const origin = join(dir, "origin.git");
    spawnSync("git", ["init", "--bare", origin], { encoding: "utf8", env: gitEnv(dir) });
    git(repo, ["remote", "add", "origin", origin]);
    git(repo, ["checkout", "--detach", "HEAD"]);
    const detached = capture();
    expect(main(["lanes", "publish", "--project", repo], detached.io, repo)).toBe(1);
    expect(detached.err.join("\n")).toContain("named branch");
  }, 30_000);
});

describe("check and record through lanes (issue #194)", () => {
  test("check --lanes refuses a held lane; check without --lanes does not wait", () => {
    const { dir, repo } = scratchRepo("ak-gate-lanes-check-");
    const store = join(dir, "evidence");
    const identity = {
      lane: "fm/run",
      branch: "fm/run",
      worktree: git(repo, ["rev-parse", "--show-toplevel"]),
    };
    const held = acquireLane(join(store, "gate-lanes"), identity, { sleep: noSleep });
    expect(held.ok).toBe(true);
    const unlocked = capture();
    const unlockedCode = main(
      ["check", "--dir", store, "--project", repo, "--gates", "build-checks"],
      unlocked.io,
      repo,
    );
    expect(unlockedCode).toBe(1);
    expect(unlocked.err.join("\n")).not.toContain("queued:");
    expect(unlocked.err.join("\n")).not.toContain("refused: lane");
    const locked = capture();
    const lockedCode = main(
      ["check", "--lanes", "--timeout-minutes", "0", "--dir", store, "--project", repo, "--gates", "build-checks"],
      locked.io,
      repo,
    );
    expect(lockedCode).toBe(1);
    expect(locked.err.join("\n")).toContain("refused:");
    expect(locked.err.join("\n")).toContain(`pid ${process.pid}`);
    if (held.ok) held.release();
    const after = capture();
    expect(
      main(
        ["check", "--lanes", "--timeout-minutes", "0", "--dir", store, "--project", repo, "--gates", "build-checks"],
        after.io,
        repo,
      ),
    ).toBe(1);
    expect(after.err.join("\n")).not.toContain("refused: lane");
    expect(laneStatus(join(store, "gate-lanes"), Date.now())).toEqual({ holders: [], waiters: [] });
  }, 30_000);

  test("two sequential record --lanes on the same run: the second refuses as closed", () => {
    const { dir, repo } = scratchRepo("ak-gate-lanes-record-closed-");
    const store = join(dir, "evidence");
    const ticket = join(dir, "ticket.json");
    writeFileSync(
      ticket,
      `${JSON.stringify({
        schema: "ticket",
        schema_version: 1,
        id: "T-lanes-closed",
        acceptance_criteria: [],
        verification: [],
        approvals: [{ role: "human", approved_at: "2026-09-29T00:00:00Z" }],
      })}\n`,
    );
    const opened = capture();
    expect(main(["open", "--ticket", ticket, "--dir", store, "--project", repo], opened.io, repo)).toBe(0);
    const first = capture();
    expect(
      main(["record", "--lanes", "--gate", "ship-preflight", "--dir", store, "--project", repo], first.io, repo),
    ).toBe(0);
    const second = capture();
    expect(
      main(["record", "--lanes", "--gate", "build-checks", "--dir", store, "--project", repo], second.io, repo),
    ).toBe(1);
    expect(second.err.join("\n")).toContain("run closed");
  }, 30_000);

  test("record --lanes refuses a held lane", () => {
    const { dir, repo } = scratchRepo("ak-gate-lanes-record-");
    const store = join(dir, "evidence");
    const held = acquireLane(
      join(store, "gate-lanes"),
      { lane: "fm/run", branch: "fm/run", worktree: git(repo, ["rev-parse", "--show-toplevel"]) },
      { sleep: noSleep },
    );
    expect(held.ok).toBe(true);
    const locked = capture();
    expect(
      main(
        ["record", "--lanes", "--timeout-minutes", "0", "--gate", "build-checks", "--dir", store, "--project", repo],
        locked.io,
        repo,
      ),
    ).toBe(1);
    expect(locked.err.join("\n")).toContain("refused:");
    if (held.ok) held.release();
  }, 30_000);
});
