/**
 * `ak learn memory` verbs: run for one repo, status, show, projects, and a
 * rollback that restores the wiki layer while the raw layer stays.
 */
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runLearn } from "../../src/learn/cli.ts";
import { run } from "../../src/learn/core/proc.ts";
import { readJsonl } from "../../src/learn/core/store.ts";
import { rollbackWiki } from "../../src/learn/memory/cli.ts";
import { UNDONE_RUNS_FILE } from "../../src/learn/memory/episodes.ts";
import { appendRun, ensureMemoryLedger, memoryDir } from "../../src/learn/memory/ledger.ts";
import { gitRepo, inOutsideRepoAsync, MemFixture, scratch, testContext, type TestContext } from "./helpers.ts";

async function learn(ctx: TestContext, argv: string[], cwd = ctx.cwd): Promise<number> {
  return runLearn(argv, {
    cwd,
    io: { out: (line) => ctx.out.push(line), err: (line) => ctx.err.push(line) },
    env: ctx.env,
    judge: ctx.judge,
  });
}

function project() {
  const dir = scratch();
  const root = gitRepo(join(dir, "shop"));
  const dbPath = join(dir, "mem.db");
  const mem = new MemFixture(dbPath);
  const now = Date.now();
  mem.session({ sid: "dddd4444-0000", project: "shop", started: now - 3_600_000, completed: now - 3_000_000 });
  mem.observation({ sid: "dddd4444-0000", project: "shop", type: "discovery", title: "found it", at: now - 3_500_000 });
  mem.close();
  return { root, ctx: testContext({ cwd: root, env: { AK_LEARN_MEM_DB: dbPath } }) };
}

describe("memory cli", () => {
  test("run registers the repo and runs only the requested job", async () => {
    const { root, ctx } = project();
    expect(await learn(ctx, ["memory", "run", "--job", "weekly"])).toBe(0);
    const jobs = readJsonl<{ job: string }>(join(memoryDir(ctx.config, root), "runs.jsonl")).map((row) => row.job);
    expect(jobs).toEqual(["episodes", "weekly"]);
    ctx.out.length = 0;
    expect(await learn(ctx, ["memory", "projects"])).toBe(0);
    expect(ctx.out.length).toBe(1);
    expect(ctx.out[0]).toContain(`shop${" ".repeat(20)} ${root}`);
  });

  test("run in a bare repository prints the refusal and exits nonzero", async () => {
    const { ctx } = project();
    const bare = join(scratch(), "bare.git");
    mkdirSync(bare);
    run(["git", "init", "-q", "--bare"], { cwd: bare });
    expect(await learn(ctx, ["memory", "run", "--job", "weekly", "--repo", bare])).toBe(1);
    expect(ctx.err).toEqual([
      `ak learn memory: registry warning: ${bare} is a bare repository and cannot be registered`,
    ]);
    expect(existsSync(memoryDir(ctx.config, bare))).toBe(false);
    expect(await learn(ctx, ["memory", "projects"])).toBe(0);
    expect(ctx.out.join("\n")).not.toContain(bare);
  });

  test("an unknown job is refused", async () => {
    const { ctx } = project();
    expect(await learn(ctx, ["memory", "run", "--job", "hourly"])).toBe(2);
    expect(ctx.err[0]).toBe(
      "ak learn memory: --job: unknown job 'hourly'; valid: reflect, backfill, nightly, weekly, all",
    );
    ctx.err.length = 0;
    expect(await learn(ctx, ["memory", "run", "--job", "nigthly"])).toBe(2);
    expect(ctx.err[0]).toBe("ak learn memory: --job: unknown job 'nigthly'; did you mean nightly?");
  });

  test("status and show", async () => {
    const { ctx } = project();
    await learn(ctx, ["memory", "run", "--job", "weekly"]);
    ctx.out.length = 0;
    expect(await learn(ctx, ["memory", "status"])).toBe(0);
    const status = ctx.out.join("\n");
    expect(status).toContain("registry: claude-mem project shop");
    expect(status).toContain('"job":"weekly"');
    expect(status).toContain("shop: episodes +1");
    ctx.out.length = 0;
    expect(await learn(ctx, ["memory", "show"])).toBe(0);
    expect(ctx.out[0]).toBe("(no memory yet)");
    expect(ctx.out.join("\n")).toContain("# Lessons");
  });

  test("outside a repository the foreground verbs fail cleanly", async () => {
    const { ctx, code } = await inOutsideRepoAsync(async (cwd) => {
      const created = testContext({ cwd });
      return { ctx: created, code: await learn(created, ["memory", "show"]) };
    });
    expect(code).toBe(1);
    expect(ctx.err).toEqual(["ak learn memory: not inside a git repository"]);
  });

  test("a --repo that names no repository is refused with the registered roots nearest it", async () => {
    const { root, ctx } = project();
    expect(await learn(ctx, ["memory", "run", "--job", "weekly"])).toBe(0);
    ctx.err.length = 0;
    expect(await learn(ctx, ["memory", "show", "--repo", `${root}x`])).toBe(1);
    expect(ctx.err).toEqual([
      `ak learn memory: not inside a git repository: unknown repository '${root}x'; did you mean ${root}?`,
    ]);
    ctx.err.length = 0;
    expect(await learn(ctx, ["memory", "run", "--repo", `${root}x`])).toBe(1);
    expect(ctx.err[0]).toContain(`did you mean ${root}?`);
  });
});

describe("rollback", () => {
  function ledgerWithHistory() {
    const ledger = ensureMemoryLedger(join(scratch(), "memory"));
    writeFileSync(ledger.path("memory.md"), "first\n");
    ledger.commit("reflect one");
    const first = ledger.head()!;
    writeFileSync(ledger.path("memory.md"), "second\n");
    writeFileSync(ledger.path("lessons", "ls-001.md"), "---\nid: ls-001\n---\n");
    appendRun(ledger, { job: "reflect", status: "ok" });
    ledger.commit("reflect two");
    return { ledger, first };
  }

  test("the default restores the wiki to before its last change and keeps the raw layer", () => {
    const { ledger } = ledgerWithHistory();
    expect(rollbackWiki(ledger)).toMatch(/^rolled back 2 files to [0-9a-f]{12}$/);
    expect(readFileSync(ledger.path("memory.md"), "utf8")).toBe("first\n");
    expect(existsSync(ledger.path("lessons", "ls-001.md"))).toBe(false);
    expect(readJsonl(ledger.path("runs.jsonl")).length).toBe(1);
    expect(ledger.git(["status", "--porcelain"]).stdout.trim()).toBe("");
  });

  test("--to restores an explicit revision, and an unknown one is refused", () => {
    const { ledger, first } = ledgerWithHistory();
    writeFileSync(ledger.path("memory.md"), "third\n");
    ledger.commit("reflect three");
    expect(rollbackWiki(ledger, first)).toStartWith("rolled back");
    expect(readFileSync(ledger.path("memory.md"), "utf8")).toBe("first\n");
    expect(rollbackWiki(ledger, "0000000")).toMatch(/^unknown revision 0000000; latest: [0-9a-f]{7,} /);
  });

  test("a target that is not a commit, or not an ancestor of HEAD, is refused", () => {
    const { ledger, first } = ledgerWithHistory();
    const head = ledger.head();
    expect(rollbackWiki(ledger, `${first}^{tree}`)).toStartWith(`unknown revision ${first}^{tree}; latest: `);
    const tree = ledger.git(["rev-parse", `${first}^{tree}`]).stdout.trim();
    const side = ledger.git(["commit-tree", tree, "-m", "side"]).stdout.trim();
    expect(side).toMatch(/^[0-9a-f]{40}$/);
    expect(rollbackWiki(ledger, side)).toBe(`${side} is not an ancestor of the ledger's HEAD`);
    expect(ledger.head()).toBe(head);
    expect(readFileSync(ledger.path("memory.md"), "utf8")).toBe("second\n");
  });

  test("uncommitted changes under the wiki paths are refused and kept", () => {
    const { ledger } = ledgerWithHistory();
    const head = ledger.head();
    writeFileSync(ledger.path("memory.md"), "hand edit\n");
    expect(rollbackWiki(ledger)).toBe("the wiki has uncommitted changes (memory.md); nothing was changed");
    expect(readFileSync(ledger.path("memory.md"), "utf8")).toBe("hand edit\n");
    expect(ledger.head()).toBe(head);
  });

  test("a path that fails partway puts every path back to HEAD and commits nothing", () => {
    const ledger = ensureMemoryLedger(join(scratch(), "memory"));
    writeFileSync(ledger.path("lessons.md"), "index one\n");
    writeFileSync(ledger.path("lessons", "ls-001.md"), "lesson one\n");
    ledger.commit("nightly nightly-2026-09-20-1: +1 lessons");
    const first = ledger.head()!;
    writeFileSync(ledger.path("lessons.md"), "index two\n");
    writeFileSync(ledger.path("lessons", "ls-001.md"), "lesson two\n");
    ledger.commit("nightly nightly-2026-09-21-2: +0 lessons");
    const head = ledger.head();
    // lessons.md restores first; lessons/ls-001.md then cannot be written into a read-only directory.
    chmodSync(ledger.path("lessons"), 0o555);
    try {
      expect(rollbackWiki(ledger, first)).toBe("rollback failed on lessons/ls-001.md; nothing was changed");
    } finally {
      chmodSync(ledger.path("lessons"), 0o755);
    }
    expect(ledger.head()).toBe(head);
    expect(readFileSync(ledger.path("lessons.md"), "utf8")).toBe("index two\n");
    expect(readFileSync(ledger.path("lessons", "ls-001.md"), "utf8")).toBe("lesson two\n");
    expect(existsSync(ledger.path(UNDONE_RUNS_FILE))).toBe(false);
    expect(ledger.git(["status", "--porcelain"]).stdout.trim()).toBe("");
  });

  test("a successful rollback is one commit carrying the undone runs", () => {
    const ledger = ensureMemoryLedger(join(scratch(), "memory"));
    const first = ledger.head()!;
    writeFileSync(ledger.path("lessons.md"), "index two\n");
    ledger.commit("nightly nightly-2026-09-21-2: +0 lessons");
    expect(rollbackWiki(ledger, first)).toStartWith("rolled back 1 file");
    expect(ledger.git(["rev-list", "--count", `${first}..HEAD`]).stdout.trim()).toBe("2");
    expect(ledger.git(["show", "--name-only", "--format=", "HEAD"]).stdout.trim().split("\n").sort()).toEqual([
      "lessons.md",
      UNDONE_RUNS_FILE,
    ]);
    expect(readJsonl<{ run: string }>(ledger.path(UNDONE_RUNS_FILE)).map((row) => row.run)).toEqual([
      "nightly-2026-09-21-2",
    ]);
    expect(ledger.git(["status", "--porcelain"]).stdout.trim()).toBe("");
  });

  test("a fresh ledger has nothing to roll back", () => {
    const ledger = ensureMemoryLedger(join(scratch(), "memory"));
    expect(rollbackWiki(ledger)).toBe("nothing to roll back");
  });

  test("the verb runs under the ledger lock", async () => {
    const { root, ctx } = project();
    const ledger = ensureMemoryLedger(memoryDir(ctx.config, root));
    writeFileSync(ledger.path("memory.md"), "changed\n");
    ledger.commit("reflect");
    expect(await learn(ctx, ["memory", "rollback"])).toBe(0);
    expect(ctx.out.at(-1)).toMatch(/^rolled back 1 file to /);
    expect(readFileSync(ledger.path("memory.md"), "utf8")).toBe("");
  });
});
