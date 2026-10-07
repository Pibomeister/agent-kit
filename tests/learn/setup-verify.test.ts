import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadConfig } from "../../src/learn/core/config.ts";
import { loopDir, projectFolderName, registryPath } from "../../src/learn/core/paths.ts";
import { run, type RunResult } from "../../src/learn/core/proc.ts";
import { readRegistry } from "../../src/learn/memory/registry.ts";
import { createSetupArea } from "../../src/learn/setup/cli.ts";
import { doctor, doctorChecks } from "../../src/learn/setup/doctor.ts";
import { seed } from "../../src/learn/setup/seed.ts";
import { verify, verifyChecks } from "../../src/learn/setup/verify.ts";
import { MEM_MODE, type SetupDeps, wire } from "../../src/learn/setup/wire.ts";
import { schedule } from "../../src/learn/setup/schedule.ts";
import { parseLearnArgs } from "../../src/learn/core/context.ts";
import { gitRepo, inOutsideRepo, MemFixture, scratch, type TestContext, testContext } from "./helpers.ts";

function fakeDeps(
  bins: string[],
  stdout = "",
): SetupDeps & { calls: string[][]; envs: Array<NodeJS.ProcessEnv | undefined> } {
  const home = scratch("ak-home-");
  const packageRoot = scratch("ak-pkg-");
  const mode = join(packageRoot, "adapters", "observation-source", "claude-mem");
  mkdirSync(mode, { recursive: true });
  writeFileSync(join(mode, `${MEM_MODE}.json`), "{}\n");
  // The entry a wired hook and the unit run must exist for verify to pass.
  const entry = join(packageRoot, "src", "cli.ts");
  mkdirSync(dirname(entry), { recursive: true });
  writeFileSync(entry, "");
  const have = new Set(bins);
  const calls: string[][] = [];
  const envs: Array<NodeJS.ProcessEnv | undefined> = [];
  return {
    home,
    platform: "darwin",
    uid: 501,
    run: (cmd, options): RunResult => {
      calls.push([...cmd]);
      envs.push(options?.env);
      return { code: 0, stdout, stderr: "", timedOut: false };
    },
    which: (bin) => (have.has(bin) ? `/usr/bin/${bin}` : null),
    ak: ["/opt/bun", entry],
    packageRoot,
    calls,
    envs,
  };
}

/** One hook entry running `command`. */
function hook(command: string) {
  return { hooks: [{ type: "command", command }] };
}

/** A context whose judge command is `judge`, and whose claude-mem lives under the fake home. */
function context(deps: SetupDeps, extra: Record<string, string> = {}): TestContext {
  return testContext({
    env: { AK_LEARN_JUDGE: "judge", CLAUDE_MEM_DATA_DIR: join(deps.home, ".claude-mem"), CODEX_HOME: "", ...extra },
  });
}

describe("setup doctor", () => {
  test("all hard requirements present: exit 0 and nothing changes", () => {
    const deps = fakeDeps(["bun", "git", "judge", "gh"]);
    const ctx = context(deps);
    expect(doctor(ctx, deps)).toBe(0);
    expect(ctx.out.at(-1)).toBe("\nAll hard requirements present.");
    expect(deps.calls).toEqual([["/usr/bin/gh", "auth", "status"]]);
    expect(existsSync(ctx.config.configDir)).toBe(false);
  });

  test("a missing judge blocks; a missing claude-mem only narrows", () => {
    const deps = fakeDeps(["bun", "git"]);
    const ctx = context(deps);
    const checks = doctorChecks(ctx, deps);
    expect(checks.filter((c) => !c.ok).map((c) => [c.name, c.hard])).toEqual([
      ["judge (judge)", true],
      ["claude-mem db", false],
      ["claude-mem worker script", false],
      ["gh authenticated", false],
    ]);
    expect(doctor(ctx, deps)).toBe(1);
    expect(ctx.out.at(-1)).toBe("\nBLOCKED: judge (judge)");
  });

  test("a missing bun or git blocks, and a gh that is installed but logged out only narrows", () => {
    for (const [bins, failed, blocked] of [
      [["git", "judge", "gh"], ["bun"], true],
      [["bun", "judge", "gh"], ["git"], true],
    ] as const) {
      const deps = fakeDeps([...bins]);
      const checks = doctorChecks(context(deps), deps);
      expect(checks.filter((c) => !c.ok && c.hard).map((c) => c.name)).toEqual([...failed]);
      expect(doctor(context(deps), deps)).toBe(blocked ? 1 : 0);
    }
    const loggedOut = {
      ...fakeDeps(["bun", "git", "judge", "gh"]),
      run: (): RunResult => ({ code: 1, stdout: "", stderr: "", timedOut: false }),
    };
    const gh = doctorChecks(context(loggedOut), loggedOut).find((c) => c.name === "gh authenticated");
    expect(gh).toMatchObject({ ok: false, hard: false });
    expect(doctor(context(loggedOut), loggedOut)).toBe(0);
  });

  test("a judge given as a path must exist", () => {
    const deps = fakeDeps(["bun", "git"]);
    const judge = join(scratch(), "judge.sh");
    writeFileSync(judge, "");
    expect(doctor(context(deps, { AK_LEARN_JUDGE: judge }), deps)).toBe(0);
    expect(doctor(context(deps, { AK_LEARN_JUDGE: `${judge}.missing` }), deps)).toBe(1);
  });

  test("reports judge calls, failures and cost from the last 24 hours across rotation", () => {
    const deps = fakeDeps(["bun", "git", "judge"]);
    const ctx = context(deps);
    mkdirSync(ctx.config.runtimeDir, { recursive: true });
    const recent = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    const call = { run_id: null, loop: "review", role: "pattern-maintainer", duration_ms: 1 };
    writeFileSync(
      join(ctx.config.runtimeDir, "judge-calls.1.jsonl"),
      `${JSON.stringify({ ...call, at: recent, call_id: randomUUID(), outcome: "ok", total_cost_usd: 0.25 })}\n`,
    );
    writeFileSync(
      join(ctx.config.runtimeDir, "judge-calls.jsonl"),
      `${JSON.stringify({ ...call, at: recent, call_id: randomUUID(), outcome: "error", total_cost_usd: 0.5 })}\n${JSON.stringify({ ...call, at: old, call_id: randomUUID(), outcome: "error", total_cost_usd: 99 })}\n`,
    );

    const span = {
      v: 1,
      trace_id: "4bf92f3577b34da6a3ce929d0e0e4736",
      span_id: "00f067aa0ba902b7",
      parent_span_id: null,
      name: "review.run",
      loop: "review",
      project_key: null,
      trigger: "cli",
      start: recent,
      duration_ms: 5,
      status: "ok",
      reason: null,
      judge: { calls: 0, failures: 0, cost_usd: 0, cost_known: true, input_tokens: 0, output_tokens: 0 },
      attrs: {},
      commit: null,
    };
    writeFileSync(
      join(ctx.config.runtimeDir, "spans.jsonl"),
      `${JSON.stringify(span)}\n${JSON.stringify({ ...span, span_id: "00f067aa0ba902b8", start: old })}\n`,
    );

    expect(doctor(ctx, deps)).toBe(0);
    expect(ctx.out).toContain("  judge calls (24h)  2 calls, 1 failure, $0.750000 total cost");
    expect(ctx.out).toContain("  runs (24h)         1 span: review ok 1");
  });

  test("flags roots that share one claude-mem project", () => {
    const deps = fakeDeps(["bun", "git", "judge"]);
    const ctx = context(deps);
    const first = gitRepo(join(scratch(), "first", "shop"));
    const second = gitRepo(join(scratch(), "second", "shop"));
    mkdirSync(ctx.config.runtimeDir, { recursive: true });
    writeFileSync(
      registryPath(ctx.config),
      `${JSON.stringify({
        [projectFolderName(first)]: { root: first, mem_project: "shop", last_seen: 1 },
        [projectFolderName(second)]: { root: second, mem_project: "shop", last_seen: 2 },
      })}\n`,
    );

    const check = doctorChecks(ctx, deps).find((candidate) => candidate.name === "registry hygiene");
    expect(check).toMatchObject({ ok: false, hard: false });
    expect(check?.why).toBe(
      `registry warning: claude-mem project 'shop' has multiple roots; ${second} owns it and ${first} is not kept in the registry`,
    );
    expect(Object.keys(readRegistry(ctx.config))).toHaveLength(2);
  });

  test("checks the scheduled default judge's auth without making a judge call", () => {
    const deps = fakeDeps(["bun", "git", "claude"], '{"loggedIn":true}\n');
    const ctx = testContext({
      env: { CLAUDE_CONFIG_DIR: "", HOME: deps.home, PATH: "/bin", ANTHROPIC_API_KEY: "operator-only" },
    });
    expect(doctor(ctx, deps)).toBe(0);
    expect(ctx.out).toContain("  scheduled judge auth      OK       soft  logged in");
    expect(ctx.prompts).toEqual([]);
    const probe = deps.calls.findIndex((call) => call.join(" ") === "/usr/bin/claude auth status");
    expect(probe).toBeGreaterThanOrEqual(0);
    expect(deps.envs[probe]).toBeDefined();
    expect(deps.envs[probe]).not.toHaveProperty("CLAUDE_CONFIG_DIR");
    expect(deps.envs[probe]).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(deps.envs[probe]?.HOME).toBe(deps.home);
    expect(deps.envs[probe]?.PATH).toBe("/bin");
    expect(deps.envs[probe]?.AK_LEARN_MEM_DB).toBe(ctx.env.AK_LEARN_MEM_DB);
  });

  test("the scheduled auth check keeps the config dir the operator's environment sets", () => {
    const deps = fakeDeps(["bun", "git", "claude"], '{"loggedIn":true}\n');
    for (const configDir of [join(deps.home, ".claude"), join(deps.home, "elsewhere")]) {
      const ctx = testContext({ env: { CLAUDE_CONFIG_DIR: configDir, HOME: deps.home } });
      expect(doctor(ctx, deps)).toBe(0);
      const probe = deps.calls.findLastIndex((call) => call.join(" ") === "/usr/bin/claude auth status");
      expect(deps.envs[probe]?.CLAUDE_CONFIG_DIR).toBe(configDir);
    }
  });
});

describe("setup seed", () => {
  test("registers the repo, creates three ledgers, calls no judge and writes nothing in the repo", () => {
    const ctx = testContext();
    const repo = gitRepo(join(scratch(), "repo"));
    mkdirSync(join(repo, "sub"));
    expect(seed(ctx, join(repo, "sub"), { skipGithub: true })).toBe(0);
    for (const loop of ["review", "memory", "skills"] as const)
      expect(existsSync(join(loopDir(ctx.config, repo, loop), ".git"))).toBe(true);
    expect(Object.values(readRegistry(ctx.config)).map((entry) => entry.root)).toEqual([repo]);
    expect(ctx.prompts).toEqual([]);
    expect(ctx.out.some((line) => line.startsWith("dry ingest: "))).toBe(true);
    expect(run(["git", "status", "--porcelain"], { cwd: repo }).stdout).toBe("");
  });

  test("the dry ingest counts review observations the memory loop has not screened yet", () => {
    const base = scratch();
    const memDb = join(base, "mem.db");
    const mem = new MemFixture(memDb);
    mem.observation({ sid: "s1", project: "repo", type: "review-finding", title: "Reviewer: late lock", at: 1000 });
    mem.close();
    const ctx = testContext({ env: { AK_LEARN_MEM_DB: memDb } });
    expect(seed(ctx, gitRepo(join(base, "repo")), { skipGithub: true })).toBe(0);
    expect(ctx.out).toContain(
      "dry ingest: 0 events visible; 1 claude-mem review observation(s) wait for the memory loop to screen them; nothing written",
    );
  });

  test("outside a repository it refuses", () => {
    const ctx = testContext();
    expect(inOutsideRepo((cwd) => seed(ctx, cwd, { skipGithub: true }))).toBe(1);
    expect(ctx.err[0]).toContain("is not inside a git repository");
  });

  test("a bare repository is refused before any ledger is created", () => {
    const ctx = testContext();
    const bare = join(scratch(), "bare.git");
    mkdirSync(bare);
    run(["git", "init", "-q", "--bare"], { cwd: bare });
    expect(seed(ctx, bare, { skipGithub: true })).toBe(1);
    expect(ctx.err).toEqual([
      `ak learn setup seed: registry warning: ${bare} is a bare repository and cannot be registered`,
    ]);
    expect(ctx.out).toEqual([]);
    for (const loop of ["review", "memory", "skills"] as const)
      expect(existsSync(loopDir(ctx.config, bare, loop))).toBe(false);
    expect(readRegistry(ctx.config)).toEqual({});
  });

  test("the CLI requires --repo", () => {
    const ctx = testContext();
    expect(createSetupArea(() => fakeDeps([])).verbs.seed!.run(parseLearnArgs([]), ctx)).toBe(2);
  });
});

describe("setup verify", () => {
  test("a fresh machine fails every check it can make", () => {
    const deps = fakeDeps(["bun", "git"]);
    const ctx = context(deps);
    const failed = verifyChecks(ctx, deps)
      .filter((r) => !r.ok)
      .map((r) => r.label);
    expect(failed).toEqual([
      "claude SessionStart hook",
      "claude Stop hook",
      "launchd unit written",
      "launchd job loaded",
      "seeded projects",
      "judge command resolvable",
    ]);
    expect(verify(ctx, deps)).toBe(1);
    expect(ctx.out.at(-1)).toBe("\n6 checks failed");
  });

  test("after wire, schedule and seed everything passes", () => {
    const deps = fakeDeps(["bun", "git", "judge"], "123\t0\tdev.agent-kit.learn\n");
    const memDb = join(deps.home, ".claude-mem", "claude-mem.db");
    mkdirSync(join(deps.home, ".claude-mem"), { recursive: true });
    new MemFixture(memDb).close();
    const ctx = context(deps, { AK_LEARN_MEM_DB: memDb });
    const repo = gitRepo(join(scratch(), "repo"));
    wire(ctx, deps);
    schedule(ctx, deps);
    seed(ctx, repo, { skipGithub: true });
    ctx.out.length = 0;

    const results = verifyChecks(ctx, deps);
    expect(results.filter((r) => !r.ok)).toEqual([]);
    expect(results.map((r) => r.label)).toContain("claude-mem observation budget");
    expect(results.map((r) => r.label)).toContain(`skills ledger (${repo})`);
    expect(verify(ctx, deps, repo)).toBe(0);
    expect(ctx.out.at(-1)).toBe("\nall checks passed");
    expect(deps.calls.every((call) => call[0] === "launchctl" && call[1] === "list")).toBe(true);
  });

  // Each row starts from the passing setup above and breaks exactly one thing verify claims to check.
  for (const [label, breakIt] of [
    [
      "claude-mem observation budget",
      (deps: SetupDeps) => {
        const settings = join(deps.home, ".claude-mem", "settings.json");
        writeFileSync(
          settings,
          JSON.stringify({ ...JSON.parse(readFileSync(settings, "utf8")), CLAUDE_MEM_CONTEXT_OBSERVATIONS: "50" }),
        );
      },
    ],
    ["claude-mem mode file", (deps: SetupDeps) => rmSync(join(deps.home, ".claude-mem", "modes", `${MEM_MODE}.json`))],
    [
      "codex Stop hook",
      (deps: SetupDeps) => {
        const stop = hook("ak learn hook stop --source codex");
        mkdirSync(join(deps.home, ".codex"), { recursive: true });
        writeFileSync(
          join(deps.home, ".codex", "hooks.json"),
          JSON.stringify({
            hooks: {
              SessionStart: [hook("ak learn hook session-start")],
              UserPromptSubmit: [hook("ak learn hook prompt")],
              Stop: [stop, stop],
            },
          }),
        );
      },
    ],
    [
      "launchd unit written",
      (deps: SetupDeps) => rmSync(join(deps.home, "Library", "LaunchAgents", "dev.agent-kit.learn.plist")),
    ],
  ] as const) {
    test(`verify fails "${label}" when only that is broken`, () => {
      const deps = fakeDeps(["bun", "git", "judge"], "123\t0\tdev.agent-kit.learn\n");
      const memDb = join(deps.home, ".claude-mem", "claude-mem.db");
      mkdirSync(join(deps.home, ".claude-mem"), { recursive: true });
      new MemFixture(memDb).close();
      const ctx = context(deps, { AK_LEARN_MEM_DB: memDb });
      const repo = gitRepo(join(scratch(), "repo"));
      wire(ctx, deps);
      schedule(ctx, deps);
      seed(ctx, repo, { skipGithub: true });
      expect(verifyChecks(ctx, deps).filter((r) => !r.ok)).toEqual([]);
      breakIt(deps);
      expect(
        verifyChecks(ctx, deps)
          .filter((r) => !r.ok)
          .map((r) => r.label),
      ).toEqual([label]);
    });
  }

  test("a seeded project whose ledger is gone fails that ledger's check alone", () => {
    const deps = fakeDeps(["bun", "git", "judge"], "123\t0\tdev.agent-kit.learn\n");
    const ctx = context(deps);
    const repo = gitRepo(join(scratch(), "repo"));
    seed(ctx, repo, { skipGithub: true });
    const ledgers = (results: ReturnType<typeof verifyChecks>) =>
      results.filter((r) => r.label.endsWith(`ledger (${repo})`)).map((r) => [r.label, r.ok]);
    expect(ledgers(verifyChecks(ctx, deps, repo))).toEqual([
      [`review ledger (${repo})`, true],
      [`memory ledger (${repo})`, true],
      [`skills ledger (${repo})`, true],
    ]);
    rmSync(join(loopDir(ctx.config, repo, "memory"), ".git"), { recursive: true, force: true });
    expect(ledgers(verifyChecks(ctx, deps, repo))).toEqual([
      [`review ledger (${repo})`, true],
      [`memory ledger (${repo})`, false],
      [`skills ledger (${repo})`, true],
    ]);
  });

  test("under cron, a crontab without the tick line fails and one with it passes", () => {
    for (const [stdout, ok] of [
      ["", false],
      ["*/15 * * * * /opt/bun ak learn memory tick\n", true],
    ] as const) {
      const deps = { ...fakeDeps(["bun", "git", "judge", "crontab"], stdout), platform: "linux" as const };
      expect(verifyChecks(context(deps), deps).find((r) => r.label === "crontab line")?.ok).toBe(ok);
    }
  });

  test("an ak entry that a wired hook or the unit names but no longer exists fails verify", () => {
    for (const platform of ["darwin", "linux"] as const) {
      const deps = { ...fakeDeps(["bun", "git", "judge", "systemctl"]), platform };
      const ctx = context(deps);
      wire(ctx, deps);
      schedule(ctx, deps);
      const entry = deps.ak[1] ?? "";
      expect(verifyChecks(ctx, deps).find((check) => check.label === "ak entry exists")).toEqual({
        label: "ak entry exists",
        ok: true,
        detail: entry,
      });
      rmSync(entry);
      expect(verifyChecks(ctx, deps).find((check) => check.label === "ak entry exists")).toEqual({
        label: "ak entry exists",
        ok: false,
        detail: `missing: ${entry}`,
      });
      // The unit alone still names it.
      writeFileSync(join(ctx.config.configDir, "settings.json"), "{}\n");
      expect(verifyChecks(ctx, deps).find((check) => check.label === "ak entry exists")?.ok).toBe(false);
    }
  });

  test("an ak entry that only a Droid, Grok or Kimi hook names fails verify once it is gone", () => {
    for (const [host, folder] of [
      ["droid", ".factory"],
      ["grok", ".grok"],
      ["kimi", ".kimi-code"],
    ] as const) {
      const deps = fakeDeps(["bun", "git", "judge"]);
      const ctx = context(deps);
      mkdirSync(join(deps.home, folder));
      expect(wire(ctx, deps, { host })).toBe(0);
      const entry = deps.ak[1] ?? "";
      const found = () => verifyChecks(ctx, deps).find((check) => check.label === "ak entry exists");
      expect(found()).toEqual({ label: "ak entry exists", ok: true, detail: entry });
      rmSync(entry);
      expect(found()).toEqual({ label: "ak entry exists", ok: false, detail: `missing: ${entry}` });
    }
  });

  test("a scope only in AK_LEARN_REPOS is refused by wire and schedule and flagged by verify, since neither carries it", () => {
    const deps = fakeDeps(["bun", "git", "judge"]);
    const root = gitRepo(join(scratch(), "shop"));
    const ctx = context(deps, { AK_LEARN_REPOS: root });
    const tick = () => verifyChecks(ctx, deps).find((check) => check.label === "hooks and scheduled tick scope");
    expect(schedule(ctx, deps)).toBe(1);
    expect(ctx.err.join("\n")).toContain("AK_LEARN_REPOS is not carried into the unit");
    expect(existsSync(join(deps.home, "Library", "LaunchAgents", "dev.agent-kit.learn.plist"))).toBe(false);
    expect(wire(ctx, deps)).toBe(1);
    expect(ctx.err.join("\n")).toContain("AK_LEARN_REPOS is not carried into the hook commands");
    expect(existsSync(join(ctx.config.configDir, "settings.json"))).toBe(false);
    expect(tick()).toEqual({
      label: "hooks and scheduled tick scope",
      ok: false,
      detail: "unscoped (every repository)",
    });
    mkdirSync(ctx.config.runtimeDir, { recursive: true });
    writeFileSync(join(ctx.config.runtimeDir, "repos"), `${root}\n`);
    expect(schedule(ctx, deps)).toBe(0);
    expect(wire(ctx, deps)).toBe(0);
    expect(tick()).toEqual({ label: "hooks and scheduled tick scope", ok: true, detail: `${root} (scope file)` });
    // The same repositories in another spelling or order are the same scope.
    const other = gitRepo(join(scratch(), "cafe"));
    const link = join(scratch(), "link");
    symlinkSync(root, link);
    writeFileSync(join(ctx.config.runtimeDir, "repos"), `${other}:${root}\n`);
    const env = { ...ctx.env, AK_LEARN_REPOS: `${link}:${other}` };
    expect(schedule({ ...ctx, env, config: loadConfig(env) }, deps)).toBe(0);
  });

  test("an unreadable unit is reported by the unit checks, never thrown", () => {
    const deps = fakeDeps(["bun", "git", "judge"]);
    const ctx = context(deps);
    mkdirSync(join(deps.home, "Library", "LaunchAgents", "dev.agent-kit.learn.plist"), { recursive: true });
    expect(verifyChecks(ctx, deps).find((check) => check.label === "launchd unit written")?.ok).toBe(true);
  });

  test("a hook that runs a bare `ak` from PATH is not checked as a missing path", () => {
    const deps = fakeDeps(["bun", "git", "judge"]);
    const ctx = context(deps);
    mkdirSync(ctx.config.configDir, { recursive: true });
    writeFileSync(
      join(ctx.config.configDir, "settings.json"),
      JSON.stringify({
        hooks: { SessionStart: [hook("ak learn hook session-start")], Stop: [hook("ak learn hook stop")] },
      }),
    );
    const results = verifyChecks(ctx, deps);
    expect(results.find((check) => check.label === "claude SessionStart hook")?.ok).toBe(true);
    expect(results.map((check) => check.label)).not.toContain("ak entry exists");
  });

  test("verify and doctor report the effective repo scope and where it came from", () => {
    const deps = fakeDeps(["bun", "git", "judge"]);
    const scope = (ctx: TestContext) => verifyChecks(ctx, deps).find((check) => check.label === "repo scope");
    expect(scope(context(deps))).toEqual({
      label: "repo scope",
      ok: true,
      detail: "unscoped (every repository)",
    });
    const root = gitRepo(join(scratch(), "shop"));
    const env = context(deps, { AK_LEARN_REPOS: root });
    expect(scope(env)?.detail).toBe(`${root} (AK_LEARN_REPOS)`);
    doctor(env, deps);
    expect(env.out).toContain(`  repo scope          ${root} (AK_LEARN_REPOS)`);
    const file = context(deps);
    mkdirSync(file.config.runtimeDir, { recursive: true });
    writeFileSync(join(file.config.runtimeDir, "repos"), ":\n");
    const reread = { ...file, config: loadConfig(file.env) };
    expect(scope(reread)?.detail).toBe("nothing allowed (scope file)");
    doctor(reread, deps);
    expect(reread.out).toContain("  repo scope          nothing allowed (scope file)");
  });

  test("a hook wired twice by hand is reported, not accepted", () => {
    const deps = fakeDeps(["bun", "git", "judge"]);
    const ctx = context(deps);
    mkdirSync(ctx.config.configDir, { recursive: true });
    const stop = { hooks: [{ type: "command", command: "ak learn hook stop" }] };
    writeFileSync(join(ctx.config.configDir, "settings.json"), JSON.stringify({ hooks: { Stop: [stop, stop] } }));
    const result = verifyChecks(ctx, deps).find((r) => r.label === "claude Stop hook")!;
    expect(result).toEqual({ label: "claude Stop hook", ok: false, detail: "2 entries" });
  });
});
