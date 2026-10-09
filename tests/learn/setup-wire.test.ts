import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseLearnArgs } from "../../src/learn/core/context.ts";
import type { RunResult } from "../../src/learn/core/proc.ts";
import { createSetupArea } from "../../src/learn/setup/cli.ts";
import { uninstall } from "../../src/learn/setup/uninstall.ts";
import {
  countHook,
  dropHooks,
  ensureHook,
  type HookDoc,
  hookCommands,
  MEM_MODE,
  memPreviousPath,
  ourHookVerb,
  type SetupDeps,
  wire,
  writeJsonWithBackup,
} from "../../src/learn/setup/wire.ts";
import { scratch, type TestContext, testContext } from "./helpers.ts";

const MATCHER = "startup|resume|clear|compact";
const AK = "/opt/bun /pkg/src/cli.ts learn hook";

/** Deps that never leave scratch space: every command is recorded and succeeds. */
function fakeDeps(options: { platform?: NodeJS.Platform; bins?: string[] } = {}): SetupDeps & { calls: string[][] } {
  const home = scratch("ak-home-");
  const packageRoot = scratch("ak-pkg-");
  const mode = join(packageRoot, "adapters", "observation-source", "claude-mem");
  mkdirSync(mode, { recursive: true });
  writeFileSync(join(mode, `${MEM_MODE}.json`), '{"name": "review learning"}\n');
  const bins = new Set(options.bins ?? ["bun", "git"]);
  const calls: string[][] = [];
  return {
    home,
    platform: options.platform ?? "linux",
    uid: 501,
    run: (cmd): RunResult => {
      calls.push([...cmd]);
      return { code: 0, stdout: "worker restarted\n", stderr: "", timedOut: false };
    },
    which: (bin) => (bins.has(bin) ? `/usr/bin/${bin}` : null),
    ak: ["/opt/bun", "/pkg/src/cli.ts"],
    packageRoot,
    calls,
  };
}

function commands(doc: HookDoc, event: string): unknown[] {
  return (doc.hooks?.[event] ?? []).flatMap((entry) => (entry.hooks ?? []).map((hook) => hook.command));
}

function readDoc(path: string): HookDoc {
  return JSON.parse(readFileSync(path, "utf8")) as HookDoc;
}

describe("hook merge", () => {
  test("adds once and is idempotent, with the exact entry shape", () => {
    const doc: HookDoc = {};
    expect(ensureHook(doc, "SessionStart", `${AK} session-start`, { matcher: MATCHER })).toBe(true);
    expect(ensureHook(doc, "SessionStart", `${AK} session-start`, { matcher: MATCHER })).toBe(false);
    expect(doc).toEqual({
      hooks: {
        SessionStart: [{ hooks: [{ type: "command", command: `${AK} session-start`, timeout: 10 }], matcher: MATCHER }],
      },
    });
  });

  test("leaves foreign entries alone", () => {
    const doc: HookDoc = { hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo other" }] }] } };
    ensureHook(doc, "SessionStart", `${AK} session-start`);
    expect(commands(doc, "SessionStart")).toEqual(["echo other", `${AK} session-start`]);
  });

  test("a duplicate pre-existing entry is not multiplied", () => {
    const doc: HookDoc = {
      hooks: {
        SessionStart: [
          { hooks: [{ type: "command", command: `${AK} session-start` }] },
          { hooks: [{ type: "command", command: `${AK} session-start` }] },
        ],
      },
    };
    expect(ensureHook(doc, "SessionStart", `${AK} session-start`)).toBe(false);
    expect(doc.hooks!.SessionStart).toHaveLength(2);
  });

  test("an entry of ours with an old command line is updated in place, not added beside", () => {
    const doc: HookDoc = {
      hooks: {
        Stop: [{ hooks: [{ type: "command", command: "bun /old/place/src/cli.ts learn hook stop", timeout: 5 }] }],
      },
    };
    expect(ensureHook(doc, "Stop", `${AK} stop`, { timeout: 120 })).toBe(true);
    expect(doc.hooks!.Stop).toEqual([{ hooks: [{ type: "command", command: `${AK} stop`, timeout: 120 }] }]);
    expect(ensureHook(doc, "Stop", `${AK} stop --source codex`)).toBe(true);
    expect(countHook(doc, "Stop", "stop")).toBe(1);
    expect(countHook(doc, "Stop", "stop --source codex")).toBe(1);
  });

  test("drop removes only ours and keeps shared entries", () => {
    const doc: HookDoc = {
      hooks: {
        SessionStart: [
          { hooks: [{ type: "command", command: `${AK} session-start` }] },
          {
            hooks: [
              { type: "command", command: "echo other" },
              { type: "command", command: `${AK} prompt` },
            ],
          },
        ],
        Stop: [{ hooks: [{ type: "command", command: `${AK} stop` }] }],
      },
    };
    expect(dropHooks(doc)).toBe(3);
    expect(commands(doc, "SessionStart")).toEqual(["echo other"]);
    expect(doc.hooks!.Stop).toBeUndefined();
  });

  test("the marker recognises our commands however the binary is spelled, and nothing else", () => {
    expect(ourHookVerb("ak learn hook stop")).toBe("stop");
    expect(ourHookVerb("'/a b/bun' '/a b/src/cli.ts' learn hook stop --source  codex")).toBe("stop --source codex");
    expect(ourHookVerb("python3 /s/learn hook stop")).toBeNull();
    expect(ourHookVerb("echo ak learn")).toBeNull();
    expect(ourHookVerb(42)).toBeNull();
  });

  test("writeJsonWithBackup keeps the user's original file, not the latest of ours", () => {
    const path = join(scratch(), "settings.json");
    writeFileSync(path, '{"a": 1}');
    writeJsonWithBackup(path, { a: 2 });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ a: 2 });
    expect(JSON.parse(readFileSync(`${path}.bak`, "utf8"))).toEqual({ a: 1 });
    writeJsonWithBackup(path, { a: 3 });
    expect(JSON.parse(readFileSync(`${path}.bak`, "utf8"))).toEqual({ a: 1 });
  });

  test("every hook command points at the one ak command line", () => {
    // Spread into a literal: an interface has no index signature, so Object.values on it is any[].
    const all = Object.values({ ...hookCommands(fakeDeps()) });
    expect(all).toHaveLength(9);
    expect(all.every((command) => command.startsWith(`${AK} `))).toBe(true);
  });
});

describe("setup wire", () => {
  function context(deps: SetupDeps, env: Record<string, string> = {}): TestContext {
    return testContext({ env: { CLAUDE_MEM_DATA_DIR: join(deps.home, ".claude-mem"), CODEX_HOME: "", ...env } });
  }

  test("a scope is never written into a hook command, and wiring claude-mem under one says it stays unscoped", () => {
    const deps = fakeDeps();
    const root = scratch();
    const scopedContext = () => {
      const ctx = context(deps, { AK_LEARN_REPOS: root });
      mkdirSync(ctx.config.runtimeDir, { recursive: true });
      writeFileSync(join(ctx.config.runtimeDir, "repos"), `${root}\n`);
      return ctx;
    };
    const scoped = scopedContext();
    expect(wire(scoped, deps, { host: "claude" })).toBe(0);
    const doc = readDoc(join(scoped.config.configDir, "settings.json"));
    expect([...commands(doc, "SessionStart"), ...commands(doc, "Stop")]).toEqual([
      hookCommands(deps).sessionStart,
      hookCommands(deps).claudeStop,
    ]);
    const note = "note: the repo scope covers agent-kit's hooks and tick only; claude-mem still observes every session";
    expect(scoped.out).toContain(note);
    const noMem = scopedContext();
    expect(wire(noMem, deps, { host: "claude", noMem: true })).toBe(0);
    expect(noMem.out).not.toContain(note);
    const unscoped = context(deps);
    wire(unscoped, deps, { host: "claude" });
    expect(unscoped.out).not.toContain(note);
  });

  test("wiring twice yields the same bytes, and foreign settings survive", () => {
    const deps = fakeDeps();
    const ctx = context(deps);
    const settings = join(ctx.config.configDir, "settings.json");
    mkdirSync(ctx.config.configDir, { recursive: true });
    writeFileSync(
      settings,
      JSON.stringify({ theme: "dark", hooks: { Stop: [{ hooks: [{ type: "command", command: "echo bye" }] }] } }),
    );
    expect(wire(ctx, deps)).toBe(0);
    const first = readFileSync(settings, "utf8");
    expect(wire(ctx, deps)).toBe(0);
    expect(readFileSync(settings, "utf8")).toBe(first);
    expect(ctx.out).toContain(`${settings}: already wired`);

    const doc = readDoc(settings);
    expect(doc.theme).toBe("dark");
    expect(commands(doc, "Stop")).toEqual(["echo bye", `${AK} stop`]);
    expect(doc.hooks!.SessionStart).toEqual([
      { hooks: [{ type: "command", command: `${AK} session-start`, timeout: 10 }], matcher: MATCHER },
    ]);
    expect(doc.hooks!.Stop![1]!.hooks![0]!.timeout).toBe(120);
    expect(JSON.parse(readFileSync(`${settings}.bak`, "utf8")).theme).toBe("dark");
  });

  test("a settings file that is not valid JSON is refused and left byte-identical, and nothing else is written", () => {
    const deps = fakeDeps();
    const ctx = context(deps);
    const settings = join(ctx.config.configDir, "settings.json");
    mkdirSync(ctx.config.configDir, { recursive: true });
    const broken = '{ "theme": "dark", }';
    writeFileSync(settings, broken);
    expect(wire(ctx, deps)).not.toBe(0);
    expect(readFileSync(settings, "utf8")).toBe(broken);
    expect(existsSync(`${settings}.bak`)).toBe(false);
    expect(existsSync(join(deps.home, ".claude-mem", "settings.json"))).toBe(false);
    expect(ctx.err).toEqual([`${settings} is not valid JSON; fix it or remove it, nothing written`]);
  });

  test("a JSON file that is not an object is refused too", () => {
    const deps = fakeDeps();
    const ctx = context(deps);
    const memSettings = join(deps.home, ".claude-mem", "settings.json");
    mkdirSync(join(deps.home, ".claude-mem"), { recursive: true });
    writeFileSync(memSettings, "[1, 2]");
    expect(wire(ctx, deps)).toBe(1);
    expect(existsSync(join(ctx.config.configDir, "settings.json"))).toBe(false);
    expect(readFileSync(memSettings, "utf8")).toBe("[1, 2]");
  });

  test("Codex is skipped when its home is absent, and created with --host codex", () => {
    const deps = fakeDeps();
    const ctx = context(deps);
    wire(ctx, deps);
    const codex = join(deps.home, ".codex", "hooks.json");
    expect(existsSync(codex)).toBe(false);
    expect(ctx.out.some((line) => line.includes("skipping Codex hooks"))).toBe(true);

    wire(ctx, deps, { host: "codex" });
    const doc = readDoc(codex);
    expect(commands(doc, "SessionStart")).toEqual([`${AK} session-start --source codex`]);
    expect(commands(doc, "UserPromptSubmit")).toEqual([`${AK} prompt`]);
    expect(commands(doc, "Stop")).toEqual([`${AK} stop --source codex`]);
  });

  test("a Codex SessionStart hook wired before it carried its source is updated in place", () => {
    const deps = fakeDeps();
    const ctx = context(deps);
    const codex = join(deps.home, ".codex", "hooks.json");
    mkdirSync(join(deps.home, ".codex"), { recursive: true });
    writeFileSync(
      codex,
      JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: `${AK} session-start` }] }] } }),
    );
    wire(ctx, deps);
    expect(commands(readDoc(codex), "SessionStart")).toEqual([`${AK} session-start --source codex`]);
    wire(ctx, deps);
    expect(commands(readDoc(codex), "SessionStart")).toEqual([`${AK} session-start --source codex`]);
  });

  test("CODEX_HOME is honoured", () => {
    const deps = fakeDeps();
    const elsewhere = scratch("ak-codex-");
    const ctx = context(deps, { CODEX_HOME: elsewhere });
    wire(ctx, deps);
    expect(countHook(readDoc(join(elsewhere, "hooks.json")), "UserPromptSubmit", "prompt")).toBe(1);
  });

  test("claude-mem gets the mode file and a budget of 25, and nothing is restarted without the flag", () => {
    const deps = fakeDeps();
    const ctx = context(deps);
    const memDir = join(deps.home, ".claude-mem");
    mkdirSync(memDir, { recursive: true });
    writeFileSync(
      join(memDir, "settings.json"),
      JSON.stringify({ CLAUDE_MEM_CONTEXT_OBSERVATIONS: "50", CLAUDE_MEM_PROVIDER: "keep-me" }),
    );
    wire(ctx, deps);
    const settings = JSON.parse(readFileSync(join(memDir, "settings.json"), "utf8")) as Record<string, string>;
    expect(settings).toEqual({
      CLAUDE_MEM_CONTEXT_OBSERVATIONS: "25",
      CLAUDE_MEM_PROVIDER: "keep-me",
      CLAUDE_MEM_MODE: MEM_MODE,
    });
    expect(readFileSync(join(memDir, "modes", `${MEM_MODE}.json`), "utf8")).toBe('{"name": "review learning"}\n');
    expect(deps.calls).toEqual([]);
    expect(ctx.out.at(-1)).toContain("--restart-worker");
  });

  test("the shipped and the embedded mode file are one install, so switching between them rewrites nothing", () => {
    const deps = fakeDeps();
    const shipped = join(deps.packageRoot, "adapters", "observation-source", "claude-mem", `${MEM_MODE}.json`);
    writeFileSync(
      shipped,
      readFileSync(join(import.meta.dir, "../../adapters/observation-source/claude-mem", `${MEM_MODE}.json`)),
    );
    const target = join(deps.home, ".claude-mem", "modes", `${MEM_MODE}.json`);
    wire(context(deps), deps);
    const installed = readFileSync(target, "utf8");
    rmSync(shipped);
    const ctx = context(deps);
    wire(ctx, deps);
    expect(readFileSync(target, "utf8")).toBe(installed);
    expect(existsSync(`${target}.bak`)).toBe(false);
    expect(ctx.out.some((line) => line.includes("mode installed"))).toBe(false);
  });

  test("an existing mode choice is kept", () => {
    const deps = fakeDeps();
    const ctx = context(deps);
    const memDir = join(deps.home, ".claude-mem");
    mkdirSync(memDir, { recursive: true });
    writeFileSync(join(memDir, "settings.json"), JSON.stringify({ CLAUDE_MEM_MODE: "someone-else" }));
    wire(ctx, deps);
    expect(JSON.parse(readFileSync(join(memDir, "settings.json"), "utf8")).CLAUDE_MEM_MODE).toBe("someone-else");
  });

  test("--restart-worker restarts through the injected runner only", () => {
    const deps = fakeDeps();
    const ctx = context(deps);
    const script = join(
      ctx.config.configDir,
      "plugins",
      "cache",
      "market",
      "claude-mem",
      "1.0.0",
      "scripts",
      "worker-service.cjs",
    );
    mkdirSync(join(script, ".."), { recursive: true });
    writeFileSync(script, "");
    wire(ctx, deps, { restartWorker: true });
    expect(deps.calls).toEqual([["/usr/bin/bun", script, "restart"]]);
    expect(ctx.out.at(-1)).toBe("claude-mem worker: worker restarted");
    wire(ctx, deps, { restartWorker: true });
    expect(deps.calls).toHaveLength(1);
  });

  test("the CLI refuses an unknown host", () => {
    const deps = fakeDeps();
    const ctx = context(deps);
    const area = createSetupArea(() => deps);
    expect(area.verbs.wire!.run(parseLearnArgs(["--host", "vim"]), ctx)).toBe(2);
    expect(ctx.err.at(-1)).toBe(
      "ak learn setup wire: --host: unknown host 'vim'; valid: claude, codex, droid, grok, kimi",
    );
    expect(area.verbs.wire!.run(parseLearnArgs(["--host", "claude", "--no-mem"]), ctx)).toBe(0);
    expect(existsSync(join(deps.home, ".claude-mem", "settings.json"))).toBe(false);
  });
});

describe("setup uninstall", () => {
  test("removes only our entries and units, restores claude-mem, and keeps the ledgers", () => {
    const deps = fakeDeps({ bins: ["bun", "git", "systemctl"] });
    const ctx = testContext({
      env: { CLAUDE_MEM_DATA_DIR: join(deps.home, ".claude-mem"), CODEX_HOME: join(deps.home, ".codex") },
    });
    const settings = join(ctx.config.configDir, "settings.json");
    mkdirSync(ctx.config.configDir, { recursive: true });
    writeFileSync(
      settings,
      JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "echo bye" }] }] } }),
    );
    wire(ctx, deps, {});
    wire(ctx, deps, { host: "codex" });
    const unitDir = join(deps.home, ".config", "systemd", "user");
    mkdirSync(unitDir, { recursive: true });
    writeFileSync(join(unitDir, "dev.agent-kit.learn.service"), "");
    writeFileSync(join(unitDir, "dev.agent-kit.learn.timer"), "");
    const ledger = join(ctx.config.configDir, "projects", "-repo", "agent-kit", "memory");
    mkdirSync(ledger, { recursive: true });

    expect(uninstall(ctx, deps)).toBe(0);
    expect(readDoc(settings)).toEqual({ hooks: { Stop: [{ hooks: [{ type: "command", command: "echo bye" }] }] } });
    expect(readDoc(join(deps.home, ".codex", "hooks.json"))).toEqual({ hooks: {} });
    expect(existsSync(join(unitDir, "dev.agent-kit.learn.timer"))).toBe(false);
    expect(deps.calls).toEqual([
      ["systemctl", "--user", "disable", "--now", "dev.agent-kit.learn.timer"],
      ["systemctl", "--user", "daemon-reload"],
    ]);
    expect(JSON.parse(readFileSync(join(deps.home, ".claude-mem", "settings.json"), "utf8"))).toEqual({});
    expect(existsSync(ledger)).toBe(true);
    expect(existsSync(`${settings}.bak`)).toBe(true);
    expect(JSON.parse(readFileSync(`${settings}.bak`, "utf8"))).toEqual({
      hooks: { Stop: [{ hooks: [{ type: "command", command: "echo bye" }] }] },
    });

    expect(uninstall(ctx, deps, { purge: true })).toBe(0);
    expect(existsSync(join(ctx.config.configDir, "projects", "-repo", "agent-kit"))).toBe(false);
    expect(existsSync(ctx.config.runtimeDir)).toBe(false);
  });
});

describe("claude-mem settings round trip", () => {
  test("uninstall restores the user's previous budget instead of deleting it, and keeps a value changed since", () => {
    const deps = fakeDeps();
    const ctx = testContext({ env: { CLAUDE_MEM_DATA_DIR: join(deps.home, ".claude-mem"), CODEX_HOME: "" } });
    const memSettings = join(deps.home, ".claude-mem", "settings.json");
    mkdirSync(join(deps.home, ".claude-mem"), { recursive: true });
    writeFileSync(
      memSettings,
      JSON.stringify({ CLAUDE_MEM_CONTEXT_OBSERVATIONS: "40", CLAUDE_MEM_PROVIDER: "keep-me" }),
    );
    wire(ctx, deps);
    expect(JSON.parse(readFileSync(memSettings, "utf8")).CLAUDE_MEM_CONTEXT_OBSERVATIONS).toBe("25");
    uninstall(ctx, deps);
    expect(JSON.parse(readFileSync(memSettings, "utf8"))).toEqual({
      CLAUDE_MEM_CONTEXT_OBSERVATIONS: "40",
      CLAUDE_MEM_PROVIDER: "keep-me",
    });

    wire(ctx, deps);
    const edited = JSON.parse(readFileSync(memSettings, "utf8")) as Record<string, string>;
    edited.CLAUDE_MEM_CONTEXT_OBSERVATIONS = "30";
    writeFileSync(memSettings, JSON.stringify(edited));
    uninstall(ctx, deps);
    expect(JSON.parse(readFileSync(memSettings, "utf8"))).toEqual({
      CLAUDE_MEM_CONTEXT_OBSERVATIONS: "30",
      CLAUDE_MEM_PROVIDER: "keep-me",
    });
  });

  test("uninstall drops the record even when nothing matched, so a rewire records the current values", () => {
    const deps = fakeDeps();
    const ctx = testContext({ env: { CLAUDE_MEM_DATA_DIR: join(deps.home, ".claude-mem"), CODEX_HOME: "" } });
    const memSettings = join(deps.home, ".claude-mem", "settings.json");
    mkdirSync(join(deps.home, ".claude-mem"), { recursive: true });
    writeFileSync(memSettings, JSON.stringify({ CLAUDE_MEM_CONTEXT_OBSERVATIONS: "40" }));
    wire(ctx, deps);
    writeFileSync(memSettings, JSON.stringify({ CLAUDE_MEM_CONTEXT_OBSERVATIONS: "30", CLAUDE_MEM_MODE: "user-mode" }));
    uninstall(ctx, deps);
    expect(JSON.parse(readFileSync(memSettings, "utf8"))).toEqual({
      CLAUDE_MEM_CONTEXT_OBSERVATIONS: "30",
      CLAUDE_MEM_MODE: "user-mode",
    });
    expect(existsSync(memPreviousPath(ctx))).toBe(false);

    wire(ctx, deps);
    expect(JSON.parse(readFileSync(memSettings, "utf8")).CLAUDE_MEM_CONTEXT_OBSERVATIONS).toBe("25");
    uninstall(ctx, deps);
    expect(JSON.parse(readFileSync(memSettings, "utf8"))).toEqual({
      CLAUDE_MEM_CONTEXT_OBSERVATIONS: "30",
      CLAUDE_MEM_MODE: "user-mode",
    });
  });

  test("uninstall leaves an unparseable hooks file untouched", () => {
    const deps = fakeDeps();
    const ctx = testContext({ env: { CLAUDE_MEM_DATA_DIR: join(deps.home, ".claude-mem"), CODEX_HOME: "" } });
    const settings = join(ctx.config.configDir, "settings.json");
    mkdirSync(ctx.config.configDir, { recursive: true });
    writeFileSync(settings, "{ nope");
    expect(uninstall(ctx, deps)).toBe(0);
    expect(readFileSync(settings, "utf8")).toBe("{ nope");
    expect(ctx.err).toEqual([]);
    expect(ctx.out).toContain(`${settings}: cannot be read and names no agent-kit hook; left as it is`);

    const wired = `{ "hooks": { "Stop": [{ "hooks": [{ "command": "/opt/bun /pkg/src/cli.ts learn hook stop" }] }] }, }`;
    writeFileSync(settings, wired);
    expect(uninstall(ctx, deps)).toBe(0);
    expect(readFileSync(settings, "utf8")).toBe(wired);
    expect(ctx.err).toEqual([`${settings} is not valid JSON; fix it or remove it, nothing written`]);
  });

  test("uninstall carries on past a hooks file it cannot read at all", () => {
    const deps = fakeDeps();
    const ctx = testContext({ env: { CLAUDE_MEM_DATA_DIR: join(deps.home, ".claude-mem"), CODEX_HOME: "" } });
    const settings = join(ctx.config.configDir, "settings.json");
    mkdirSync(settings, { recursive: true });
    expect(uninstall(ctx, deps)).toBe(0);
    expect(ctx.err).toEqual([]);
    expect(ctx.out).toContain(`${settings}: cannot be read and names no agent-kit hook; left as it is`);
    expect(ctx.out.at(-1)).toContain("ledgers under");
  });
});
