import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseLearnArgs } from "../../src/learn/core/context.ts";
import { run } from "../../src/learn/core/proc.ts";
import { PACKAGE_ROOT } from "../../src/learn/core/roles.ts";
import { loadEvents } from "../../src/learn/review/events.ts";
import {
  detectPatterns,
  LAST_RUN_FILE,
  PIPELINE_LOG,
  pipelineCommand,
  promptHook,
  type Spawner,
  stopHook,
} from "../../src/learn/review/hooks.ts";
import { reviewLedger, reviewLedgerDir } from "../../src/learn/review/ledger.ts";
import { reviewArea } from "../../src/learn/review/cli.ts";
import { gitRepo, inOutsideRepo, scratch, testContext } from "./helpers.ts";

function recorder(): { spawner: Spawner; calls: Array<{ argv: readonly string[]; cwd: string }> } {
  const calls: Array<{ argv: readonly string[]; cwd: string }> = [];
  return { calls, spawner: (argv, options) => calls.push({ argv, cwd: options.cwd }) };
}

describe("stop hook", () => {
  test("plugin cache, a nested stop and a non-git directory skip without detaching", () => {
    const repo = gitRepo(join(scratch(), "app"));
    const ctx = testContext();
    const { spawner, calls } = recorder();
    // A real repository inside a plugin cache, so the cache skip and not the non-git exit decides.
    const cached = gitRepo(join(scratch(), "plugins", "cache", "y"));
    stopHook(ctx, { cwd: cached }, parseLearnArgs([]), spawner);
    stopHook(ctx, { cwd: repo, stop_hook_active: true }, parseLearnArgs([]), spawner);
    inOutsideRepo((cwd) => stopHook(ctx, { cwd }, parseLearnArgs([]), spawner));
    expect(calls).toHaveLength(0);
    expect(existsSync(reviewLedgerDir(ctx.config, repo))).toBe(false);
    expect(existsSync(reviewLedgerDir(ctx.config, cached))).toBe(false);
  });

  test("detaches once, debounces for ten minutes, then detaches again with the codex source", () => {
    const repo = gitRepo(join(scratch(), "app"));
    const ctx = testContext();
    const { spawner, calls } = recorder();
    stopHook(ctx, { cwd: repo }, parseLearnArgs([]), spawner);
    expect(calls).toHaveLength(1);
    const { argv, cwd } = calls[0]!;
    expect(cwd).toBe(repo);
    expect(argv.slice(0, 2)).toEqual(["sh", "-c"]);
    const script = argv[2]!;
    const cli = `'${join(PACKAGE_ROOT, "src", "cli.ts")}'`;
    expect(argv.slice(3)).toEqual(["sh", repo, "claude", join(reviewLedgerDir(ctx.config, repo), PIPELINE_LOG), repo]);
    expect(script).toContain(`${cli} 'learn' 'review' 'run' '--repo' "$1" '--cwd' "$4" '--source' "$2" >> "$3" 2>&1`);
    expect(script).toContain(`${cli} 'learn' 'skills' 'run' '--repo' "$1" >> "$3" 2>&1`);
    expect(script.indexOf("'review' 'run'")).toBeLessThan(script.indexOf("'skills' 'run'"));
    expect(script).not.toContain(repo);
    const mark = join(reviewLedgerDir(ctx.config, repo), LAST_RUN_FILE);
    expect(existsSync(mark)).toBe(true);

    stopHook(ctx, { cwd: repo }, parseLearnArgs([]), spawner);
    expect(calls).toHaveLength(1);

    const old = new Date(Date.now() - 601_000);
    utimesSync(mark, old, old);
    stopHook(ctx, { cwd: repo }, parseLearnArgs(["--source", "codex"]), spawner);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.argv[5]).toBe("codex");
  });

  test("an unknown --source is reported and read as claude: a hook never fails its session", () => {
    const repo = gitRepo(join(scratch(), "app"));
    const ctx = testContext();
    const { spawner, calls } = recorder();
    stopHook(ctx, { cwd: repo }, parseLearnArgs(["--source", "codx"]), spawner);
    expect(ctx.err).toEqual(["ak learn hook: --source: unknown source 'codx'; did you mean codex?; read as claude"]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.argv[5]).toBe("claude");
  });

  test("a root full of shell syntax reaches the pipeline as one literal argument and runs nothing", () => {
    const base = scratch();
    const marks = join(base, "marks");
    mkdirSync(marks);
    const root = `${base}/x$(touch ${marks}/dollar)y\`touch ${marks}/tick\`"q'z; touch ${marks}/semi`;
    const log = join(base, "pipeline.log");
    const argv = pipelineCommand(root, `${root}/wt`, "claude", log, ["printf", "[%s]"]);
    const result = run(argv, { cwd: base });
    expect(result.code).toBe(0);
    expect(readdirSync(marks)).toEqual([]);
    const lines = readFileSync(log, "utf8").split("\n");
    expect(lines[0]).toMatch(/^== \d{4}-\d{2}-\d{2}T\S+Z claude /);
    expect(lines[0]!.endsWith(` ${root}`)).toBe(true);
    expect(lines[1]).toBe(
      `[learn][review][run][--repo][${root}][--cwd][${root}/wt][--source][claude][learn][skills][run][--repo][${root}]`,
    );
  });

  test("a session in a linked worktree hands the pipeline its worktree, and the PR is looked up there", () => {
    const base = scratch();
    const repo = gitRepo(join(base, "app"));
    const wt = join(base, "wt");
    run(["git", "worktree", "add", "-q", "-b", "feature-x", wt], { cwd: repo });
    const ctx = testContext();
    const { spawner, calls } = recorder();
    stopHook(ctx, { cwd: wt }, parseLearnArgs([]), spawner);
    const argv = calls[0]!.argv;
    expect(argv.slice(3)).toEqual(["sh", repo, "claude", join(reviewLedgerDir(ctx.config, repo), PIPELINE_LOG), wt]);

    const bin = join(base, "bin");
    mkdirSync(bin);
    const seen = join(base, "gh-cwd");
    writeFileSync(
      join(bin, "gh"),
      `#!/bin/sh\nif [ "$1" = repo ]; then echo acme/app; exit 0; fi\nif [ "$1" = pr ]; then pwd -P >> '${seen}'; git branch --show-current >> '${seen}'; fi\nexit 1\n`,
    );
    chmodSync(join(bin, "gh"), 0o755);
    const path = process.env.PATH;
    process.env.PATH = `${bin}:${path}`;
    try {
      const args = parseLearnArgs(["--repo", repo, "--cwd", wt, "--source", "codex", "--no-mem"]);
      expect(reviewArea.verbs.ingest!.run(args, testContext({ cwd: base }))).toBe(0);
    } finally {
      process.env.PATH = path;
    }
    expect(readFileSync(seen, "utf8").split("\n").slice(0, 2)).toEqual([wt, "feature-x"]);
  });

  test("the mark and the log are ignored by the ledger, so a debounce never makes a commit", () => {
    const repo = gitRepo(join(scratch(), "app"));
    const ctx = testContext();
    stopHook(ctx, { cwd: repo }, parseLearnArgs([]), recorder().spawner);
    expect(reviewLedger(ctx.config, repo).git(["status", "--porcelain"]).stdout.trim()).toBe("");
  });

  test("a dry run reports and neither creates the ledger nor spawns", () => {
    const repo = gitRepo(join(scratch(), "app"));
    const ctx = testContext({ env: { AK_LEARN_DRY_RUN: "1" } });
    const { spawner, calls } = recorder();
    stopHook(ctx, { cwd: repo }, parseLearnArgs([]), spawner);
    expect(calls).toHaveLength(0);
    expect(ctx.err.join("\n")).toContain("dry run");
    expect(existsSync(reviewLedgerDir(ctx.config, repo))).toBe(false);
  });

  test("the lock blocks a concurrent run; the loser exits quietly with status 0", () => {
    const repo = gitRepo(join(scratch(), "app"));
    const ctx = testContext({ cwd: repo });
    const ledger = reviewLedger(ctx.config, repo);
    const held = ledger.tryLock();
    expect(held).not.toBeNull();
    expect(ledger.tryLock()).toBeNull();
    expect(reviewArea.verbs.maintain!.run(parseLearnArgs([]), ctx)).toBe(0);
    expect(ctx.err.join("\n")).toContain("another run holds the ledger lock");
    held!();
    const again = ledger.tryLock();
    expect(again).not.toBeNull();
    again!();
  });
});

describe("correction detection (ported from claude-reflect)", () => {
  const cases: Array<[string, string | null, string?]> = [
    ["remember: always pin the fixture clock", "explicit", "remember:"],
    ["no, use Python instead", "auto", "no,"],
    ["don't use that library", "auto", "don't"],
    ["stop using that approach", "auto", "stop/never"],
    ["never use global variables", "auto", "stop/never"],
    ["that's wrong, the API returns JSON", "auto", "that's-wrong"],
    ["I told you to use async", "auto", "I-told-you"],
    ["don't add docstrings unless I explicitly ask", "guardrail", "dont-unless-asked"],
    ["only change what I asked you to change", "guardrail", "only-what-asked"],
    ["stop refactoring unrelated code", "guardrail", "stop-unrelated"],
    ["don't over-engineer this solution", "guardrail", "dont-over-engineer"],
    ["leave the existing code alone", "guardrail", "leave-alone"],
    ["only make minimal changes please", "guardrail", "minimal-changes"],
    ["Hello, how are you?", null],
    ["can you figure out how to make this fit?", null],
    ["please help me fix this issue", null],
    ["the error is: could not connect to database", null],
    ["it just opens and closes, is not working", null],
    ["no dialog appeared", null],
    ["no idea", null],
    ["no problem", null],
    ["no worries", null],
    ["no rush on this", null],
    ["no results came back", null],
    ["no it should use the other endpoint", "auto"],
    ["no don't touch that file", "auto"],
    ["no I meant the second one", "auto"],
    ["no, use the v2 client not the v1 client", "auto", "no,"],
    ["i love it", null],
    ["perfect!", null],
    ["OK", null],
    ["好", null],
    ["うん", null],
    ["やめて", "auto", "yamete"],
    ["何ですか？", null],
    ["你在做什麼呢", null],
    ["이것은 뭐입니까", null],
    ["No problem, 次に進もう", null],
    ["Never mind、別の方法でやろう", null],
    ["いや、そっちじゃなくてこっちを修正して", "auto", "iya"],
    ["違う、useStateじゃなくてuseRefを使って", "auto", "chigau"],
    ["それ間違ってる、型が違う", "auto", "machigatte"],
    ["mapじゃなくてforEachにして", "auto", "janakute-nishite"],
    ["TypeScriptにしてって言ったのに", "auto", "tte-itta"],
    ["不是，应该用另一个方法", "auto", "bushi"],
    ["错了，这个逻辑有问题", "auto", "cuole"],
    ["아니, 그게 아니라 이거를 수정해", "auto", "ani"],
    ["actually, use the other method", "auto", "actually"],
    ["how do I install this?", null],
    ["/loop Keep polling the build status; use the artifact URL not the run URL when reporting.", null],
    ["\n  /reflect --dry-run perfect! check whether the queue is clean", null],
    ["/loop remember: this should not be captured because it's inside a slash-command body", null],
  ];

  for (const [text, type, pattern] of cases) {
    test(`${JSON.stringify(text.slice(0, 50))} -> ${type ?? "none"}`, () => {
      const result = detectPatterns(text);
      expect(result.type).toBe(type as never);
      if (pattern !== undefined) expect(result.patterns.split(" ")).toContain(pattern);
      if (type === null) expect(result.patterns).toBe("");
    });
  }

  test("confidence and decay follow the donor's arithmetic", () => {
    expect(detectPatterns("remember: always pin the fixture clock")).toMatchObject({ confidence: 0.9, decayDays: 120 });
    expect(detectPatterns("I told you to use async")).toMatchObject({ confidence: 0.9, decayDays: 120 });
    expect(detectPatterns("no, don't use that, you should use Python").confidence).toBeGreaterThanOrEqual(0.75);
    expect(detectPatterns("no, use the v2 client").confidence).toBeGreaterThanOrEqual(0.75);
    const long = detectPatterns(`no, ${"this is a very long explanation ".repeat(15)}`);
    expect(long.type).toBe("auto");
    expect(long.confidence).toBeLessThanOrEqual(0.65);
  });

  test("praise that names its referent is positive, not a correction; a forward pivot drops it", () => {
    expect(detectPatterns("love it, keep the tables compact like that in future reports")).toMatchObject({
      type: "positive",
      sentiment: "positive",
    });
    expect(detectPatterns("perfect, that works well. now let's add the export step").type).toBeNull();
  });
});

describe("prompt hook", () => {
  test("a correction becomes one review event with source `correction`; the hook prints nothing", () => {
    const repo = gitRepo(join(scratch(), "app"));
    const ctx = testContext();
    promptHook(ctx, { cwd: repo, prompt: "no, use the fixture clock" }, parseLearnArgs([]));
    promptHook(ctx, { cwd: repo, prompt: "no, use the fixture clock" }, parseLearnArgs([]));
    const events = loadEvents(reviewLedger(ctx.config, repo));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      source: "correction",
      kind: "correction",
      project: "app",
      platform: "claude",
      text: "no, use the fixture clock",
      patterns: "no,",
    });
    expect(ctx.out).toEqual([]);
  });

  test("codex prompts are recorded with their platform, from `user_prompt` too", () => {
    const repo = gitRepo(join(scratch(), "app"));
    const ctx = testContext();
    promptHook(ctx, { cwd: repo, user_prompt: "don't use that library" }, parseLearnArgs(["--source", "codex"]));
    expect(loadEvents(reviewLedger(ctx.config, repo))[0]!.platform).toBe("codex");
  });

  test("non-corrections, praise, pasted content, tags, the plugin cache, non-git directories and dry runs record nothing", () => {
    const repo = gitRepo(join(scratch(), "app"));
    const cached = gitRepo(join(scratch(), "plugins", "cache", "y"));
    const ctx = testContext();
    const skipped = [
      { cwd: repo, prompt: "please fix this bug" },
      { cwd: repo, prompt: "love it, keep the tables compact like that in future reports" },
      { cwd: repo, prompt: `no, ${"x".repeat(600)}` },
      { cwd: repo, prompt: "<command-message>no, use the other one</command-message>" },
      { cwd: cached, prompt: "no, use the other one" },
      { cwd: repo },
    ];
    for (const payload of skipped) promptHook(ctx, payload, parseLearnArgs([]));
    const outside = inOutsideRepo((cwd) => {
      promptHook(ctx, { cwd, prompt: "no, use the other one" }, parseLearnArgs([]));
      return cwd;
    });
    expect(existsSync(reviewLedgerDir(ctx.config, outside))).toBe(false);
    promptHook(
      testContext({ env: { AK_LEARN_DRY_RUN: "1" } }),
      { cwd: repo, prompt: "no, use the other one" },
      parseLearnArgs([]),
    );
    expect(existsSync(reviewLedgerDir(ctx.config, repo))).toBe(false);
    expect(existsSync(reviewLedgerDir(ctx.config, cached))).toBe(false);
  });

  test("a long `remember:` prompt is still captured", () => {
    const repo = gitRepo(join(scratch(), "app"));
    const ctx = testContext();
    promptHook(
      ctx,
      { cwd: repo, prompt: `remember: ${"keep the fixture clock pinned ".repeat(30)}` },
      parseLearnArgs([]),
    );
    expect(loadEvents(reviewLedger(ctx.config, repo))).toHaveLength(1);
  });
});

describe("review report", () => {
  test("reads a repo with no review ledger without creating one", () => {
    const root = gitRepo(join(scratch(), "shop"));
    const ctx = testContext({ cwd: root });
    expect(reviewArea.verbs.report?.run(parseLearnArgs(["--repo", root]), ctx)).toBe(0);
    expect(existsSync(reviewLedgerDir(ctx.config, root))).toBe(false);
    expect(ctx.out).toContain("(none)");
  });
});
