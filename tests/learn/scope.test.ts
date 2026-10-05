/**
 * Repo scope: with a scope set, the hooks and the scheduled tick act only on
 * the listed main repo roots (their linked worktrees included). Everything
 * else is a strict no-op: no printed block, no detach, no capture, no span row,
 * no registry entry and no ledger. Unscoped behaviour is unchanged.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type LearnConfig, loadConfig, repoAllowed, scopeFile } from "../../src/learn/core/config.ts";
import { parseLearnArgs } from "../../src/learn/core/context.ts";
import { projectLedgerRoot, registryPath, tickLogPath } from "../../src/learn/core/paths.ts";
import { run } from "../../src/learn/core/proc.ts";
import { readJsonl } from "../../src/learn/core/store.ts";
import { SPAN_FILE, type SpanRow } from "../../src/learn/core/trace.ts";
import { runLearn } from "../../src/learn/cli.ts";
import type { HookPayload } from "../../src/learn/hooks.ts";
import { memoryArea } from "../../src/learn/memory/cli.ts";
import { memoryDir } from "../../src/learn/memory/ledger.ts";
import { readRegistry, registerRoot } from "../../src/learn/memory/registry.ts";
import { tick } from "../../src/learn/memory/tick.ts";
import { loadEvents } from "../../src/learn/review/events.ts";
import { reviewLedger } from "../../src/learn/review/ledger.ts";
import { gitRepo, MemFixture, projectScratch, removeProjectScratch, scratch, testContext } from "./helpers.ts";

afterAll(removeProjectScratch);

const CORRECTION = "no, use bun test not npm test";

interface Fixture {
  env: NodeJS.ProcessEnv;
  config: LearnConfig;
  inside: string;
  outside: string;
}

/** Two repositories and a scratch config; `scope` is `AK_LEARN_REPOS` when given (absent otherwise). */
function fixture(scope?: (inside: string, outside: string) => string): Fixture {
  const base = scratch();
  const inside = gitRepo(join(base, "shop"));
  const outside = gitRepo(join(base, "cafe"));
  const env: NodeJS.ProcessEnv = { ...testContext().env };
  if (scope !== undefined) env.AK_LEARN_REPOS = scope(inside, outside);
  const config = loadConfig(env);
  // A guardrail in the in-scope repo, so session-start has a block to print there.
  writeFileSync(reviewLedger(config, inside).path("guardrails.md"), "# Guardrails\n\n- [rp-001] read the diff\n");
  return { env, config, inside, outside };
}

/** Write the scope file directly, as an operator's own tooling might. */
function writeScope(config: LearnConfig, text: string): void {
  mkdirSync(config.runtimeDir, { recursive: true });
  writeFileSync(scopeFile(config.runtimeDir), text);
}

function hook(f: Fixture, verb: string, payload: HookPayload, cwd = String(payload.cwd)) {
  const out: string[] = [];
  const err: string[] = [];
  const io = { out: (line: string) => out.push(line), err: (line: string) => err.push(line) };
  const code = runLearn(["hook", verb], { cwd, io, env: f.env, stdin: JSON.stringify(payload) });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

function spansNamed(config: LearnConfig, name: string): SpanRow[] {
  return readJsonl<SpanRow>(join(config.runtimeDir, SPAN_FILE)).filter((row) => row.name === name);
}

/** A strict no-op left no trace of the session for this root. */
function untouched(f: Fixture, root: string, name: string): void {
  expect(spansNamed(f.config, name)).toEqual([]);
  expect(existsSync(registryPath(f.config))).toBe(false);
  expect(existsSync(projectLedgerRoot(f.config, root))).toBe(false);
}

describe("scope resolution", () => {
  test("absent everywhere is unscoped; a scope file is read; the variable overrides it both ways", () => {
    const f = fixture();
    expect(f.config.repos).toBeNull();
    expect(f.config.reposSource).toBe("none");
    expect(repoAllowed(f.config, f.outside)).toBe(true);

    writeScope(f.config, `${f.inside}\n`);
    const file = loadConfig(f.env);
    expect(file.reposSource).toBe("file");
    expect(repoAllowed(file, f.inside)).toBe(true);
    expect(repoAllowed(file, f.outside)).toBe(false);

    const widened = loadConfig({ ...f.env, AK_LEARN_REPOS: `${f.inside}:${f.outside}` });
    expect(widened.reposSource).toBe("env");
    expect(repoAllowed(widened, f.outside)).toBe(true);
    const narrowed = loadConfig({ ...f.env, AK_LEARN_REPOS: f.outside });
    expect(repoAllowed(narrowed, f.inside)).toBe(false);
  });

  test("blank, ':', relative and missing entries allow nothing, from the variable or the file", () => {
    const f = fixture();
    // "." exists from any working directory, so only the absolute-path rule refuses it.
    for (const value of ["", "  ", ":", "::", ".", "shop", "./shop", join(f.inside, "missing")]) {
      const env = loadConfig({ ...f.env, AK_LEARN_REPOS: value });
      expect([value, env.repos]).toEqual([value, []]);
      expect(repoAllowed(env, f.inside)).toBe(false);
    }
    for (const text of ["", ":", "shop", join(f.inside, "missing")]) {
      writeScope(f.config, `${text}\n`);
      expect([text, loadConfig(f.env).repos]).toEqual([text, []]);
      expect(repoAllowed(loadConfig(f.env), f.inside)).toBe(false);
    }
  });

  test("a scope file that cannot be read allows nothing, and --clear still removes it", () => {
    const f = fixture();
    mkdirSync(scopeFile(f.config.runtimeDir), { recursive: true });
    const config = loadConfig(f.env);
    expect([config.reposSource, config.repos]).toEqual(["file", []]);
    const { out, io } = collect();
    expect(runLearn(["setup", "scope", "--clear"], { cwd: f.inside, io, env: f.env })).toBe(0);
    expect(existsSync(scopeFile(f.config.runtimeDir))).toBe(false);
    expect(out.at(-1)).toBe("scope: unscoped (every repository)");
  });

  test("a root only stat can reach (no read permission) is still matched, by stat alone", () => {
    const f = fixture();
    chmodSync(f.inside, 0o311);
    try {
      const config = loadConfig({ ...f.env, AK_LEARN_REPOS: f.inside });
      expect(config.repos).toEqual([f.inside]);
      expect(repoAllowed(config, f.inside)).toBe(true);
    } finally {
      chmodSync(f.inside, 0o755);
    }
  });

  test("entries and candidates compare after resolving symlinks; a null root is never in scope", () => {
    const f = fixture();
    const link = join(scratch(), "link");
    symlinkSync(f.inside, link);
    const config = loadConfig({ ...f.env, AK_LEARN_REPOS: `${link}/` });
    expect(repoAllowed(config, f.inside)).toBe(true);
    expect(repoAllowed(config, link)).toBe(true);
    expect(repoAllowed(config, null)).toBe(false);
    expect(repoAllowed(loadConfig(f.env), null)).toBe(true);
  });
});

describe("session-start", () => {
  test("in scope prints the block and writes its span", () => {
    const f = fixture((inside) => inside);
    const result = hook(f, "session-start", { cwd: f.inside });
    expect(result.out).toContain("[rp-001] read the diff");
    expect(spansNamed(f.config, "hook.session-start").length).toBe(1);
    expect(Object.values(readRegistry(f.config)).map((entry) => entry.root)).toEqual([f.inside]);
  });

  test("out of scope, or outside any repository, prints nothing and leaves no span, registry or ledger", () => {
    const f = fixture((inside) => inside);
    expect(hook(f, "session-start", { cwd: f.outside })).toEqual({ code: 0, out: "", err: "" });
    expect(hook(f, "session-start", { cwd: scratch() })).toEqual({ code: 0, out: "", err: "" });
    untouched(f, f.outside, "hook.session-start");
  });

  test("a linked worktree of an in-scope repo counts as in", () => {
    const f = fixture((inside) => inside);
    const wt = join(scratch(), "wt");
    run(["git", "worktree", "add", "-q", "-b", "feature-x", wt], { cwd: f.inside });
    expect(hook(f, "session-start", { cwd: wt }).out).toContain("[rp-001] read the diff");
    expect(spansNamed(f.config, "hook.session-start").length).toBe(1);
  });
});

describe("stop", () => {
  test("in scope reaches the detach (dry run), a worktree included; out of scope does nothing at all", () => {
    const f = fixture((inside) => inside);
    f.env.AK_LEARN_DRY_RUN = "1";
    expect(hook(f, "stop", { cwd: f.inside }).err).toContain(`would detach the review pipeline for ${f.inside}`);
    const wt = join(scratch(), "wt");
    run(["git", "worktree", "add", "-q", "-b", "feature-y", wt], { cwd: f.inside });
    expect(hook(f, "stop", { cwd: wt }).err).toContain(`would detach the review pipeline for ${f.inside}`);
    expect(spansNamed(f.config, "hook.stop").map((row) => row.status)).toEqual(["dry-run", "dry-run"]);

    expect(hook(f, "stop", { cwd: f.outside })).toEqual({ code: 0, out: "", err: "" });
    expect(spansNamed(f.config, "hook.stop").length).toBe(2);
    expect(existsSync(projectLedgerRoot(f.config, f.outside))).toBe(false);
  });
});

describe("prompt", () => {
  test("a correction is captured in scope and records nothing out of scope", () => {
    const f = fixture((inside) => inside);
    hook(f, "prompt", { cwd: f.outside, prompt: CORRECTION });
    untouched(f, f.outside, "hook.prompt");
    hook(f, "prompt", { cwd: f.inside, prompt: CORRECTION });
    expect(loadEvents(reviewLedger(f.config, f.inside)).length).toBe(1);
    expect(spansNamed(f.config, "hook.prompt").length).toBe(1);
  });
});

/** Two projects claude-mem saw yesterday, both discoverable by the scheduled tick. */
function discovered() {
  const now = Date.now();
  const db = join(scratch(), "mem.db");
  const mem = new MemFixture(db);
  const seen = (name: string, sid: string): string => {
    const root = gitRepo(join(projectScratch(), name));
    mem.session({ sid, project: name, started: now - 86_400_000, completed: now - 86_400_000 + 1000 });
    mem.observation({ sid, project: name, type: "discovery", title: "found it", at: now - 86_400_000 + 500 });
    mem.toolUse({ sid, project: name, tool: "Bash", cwd: root, at: now - 86_400_000 + 500 });
    return root;
  };
  const shop = seen("shop", "aaaa1111-0000");
  const cafe = seen("cafe", "bbbb2222-0000");
  mem.close();
  return { shop, cafe, db };
}

/** The last `memory.tick` span's attributes. */
function lastTickAttrs(config: LearnConfig): SpanRow["attrs"] | undefined {
  return spansNamed(config, "memory.tick").at(-1)?.attrs;
}

/** An io that collects both streams into one list. */
function collect() {
  const out: string[] = [];
  return { out, io: { out: (line: string) => out.push(line), err: (line: string) => out.push(line) } };
}

describe("tick", () => {
  test("only in-scope projects are registered and run; memory run --repo stays ungated", () => {
    const { shop, cafe, db } = discovered();
    const ctx = testContext({ cwd: shop, env: { AK_LEARN_MEM_DB: db, AK_LEARN_REPOS: shop } });
    expect(tick(ctx)).toBe(0);
    expect(Object.values(readRegistry(ctx.config)).map((entry) => entry.root)).toEqual([shop]);
    expect(existsSync(memoryDir(ctx.config, cafe))).toBe(false);
    expect(existsSync(projectLedgerRoot(ctx.config, cafe))).toBe(false);
    const log = readFileSync(tickLogPath(ctx.config), "utf8");
    expect(log).toContain("shop: ");
    expect(log).not.toContain("cafe: ");
    expect(lastTickAttrs(ctx.config)).toMatchObject({ projects: 1 });

    expect(memoryArea.verbs.run?.run(parseLearnArgs(["--repo", cafe, "--job", "backfill"]), ctx)).toBe(0);
    expect(existsSync(memoryDir(ctx.config, cafe))).toBe(true);
  });

  test("a project registered before the scope was set is skipped, not run", () => {
    const { shop, cafe, db } = discovered();
    const ctx = testContext({ cwd: shop, env: { AK_LEARN_MEM_DB: db, AK_LEARN_REPOS: shop } });
    registerRoot(ctx.config, cafe);
    expect(tick(ctx)).toBe(0);
    expect(existsSync(memoryDir(ctx.config, cafe))).toBe(false);
    expect(readFileSync(tickLogPath(ctx.config), "utf8")).not.toContain("cafe: ");
    expect(lastTickAttrs(ctx.config)).toMatchObject({ projects: 1 });
  });

  test("unscoped, the tick still registers and runs every discovered project", () => {
    const { shop, cafe, db } = discovered();
    const ctx = testContext({ cwd: shop, env: { AK_LEARN_MEM_DB: db } });
    expect(tick(ctx)).toBe(0);
    expect(new Set(Object.values(readRegistry(ctx.config)).map((entry) => entry.root))).toEqual(new Set([shop, cafe]));
  });
});

describe("scope file verbs", () => {
  test("setup scope --set, show and --clear round-trip the file", () => {
    const f = fixture();
    const set = collect();
    expect(
      runLearn(["setup", "scope", "--set", `${f.inside}:${f.outside}`], { cwd: f.inside, io: set.io, env: f.env }),
    ).toBe(0);
    expect(readFileSync(scopeFile(f.config.runtimeDir), "utf8")).toBe(`${f.inside}:${f.outside}\n`);
    const show = collect();
    expect(runLearn(["setup", "scope"], { cwd: f.inside, io: show.io, env: f.env })).toBe(0);
    expect(show.out.join("\n")).toContain(`scope: ${f.inside}:${f.outside} (scope file)`);
    expect(runLearn(["setup", "scope", "--clear"], { cwd: f.inside, io: collect().io, env: f.env })).toBe(0);
    expect(existsSync(scopeFile(f.config.runtimeDir))).toBe(false);
    const after = collect();
    runLearn(["setup", "scope"], { cwd: f.inside, io: after.io, env: f.env });
    expect(after.out.join("\n")).toContain("scope: unscoped");
  });

  test("setup scope names what it ignored, says when the variable wins, and refuses a bad flag set", () => {
    const f = fixture();
    const set = collect();
    runLearn(["setup", "scope", "--set", `${f.inside}:shop:/no/such/dir`], { cwd: f.inside, io: set.io, env: f.env });
    expect(set.out).toContain("  ignored: shop (not a repository root or a linked worktree)");
    expect(set.out).toContain("  ignored: /no/such/dir (not a repository root or a linked worktree)");
    expect(set.out.at(-1)).toBe(`scope: ${f.inside} (scope file)`);
    const env = { ...f.env, AK_LEARN_REPOS: f.outside };
    const show = collect();
    runLearn(["setup", "scope"], { cwd: f.inside, io: show.io, env });
    expect(show.out).toEqual([
      `scope: ${f.outside} (AK_LEARN_REPOS)`,
      `  (AK_LEARN_REPOS overrides ${scopeFile(f.config.runtimeDir)})`,
    ]);
    const clear = collect();
    runLearn(["setup", "scope", "--clear"], { cwd: f.inside, io: clear.io, env: f.env });
    runLearn(["setup", "scope", "--clear"], { cwd: f.inside, io: clear.io, env: f.env });
    expect(clear.out).toContain(`${scopeFile(f.config.runtimeDir)}: no scope file`);
    for (const argv of [["--set"], ["--set", f.inside, "--clear"]]) {
      const bad = collect();
      expect(runLearn(["setup", "scope", ...argv], { cwd: f.inside, io: bad.io, env: f.env })).toBe(2);
      expect(bad.out).toEqual(["ak learn setup scope: --set takes ROOT[:ROOT], and --set and --clear are exclusive"]);
    }
  });
});

describe("review round fixes", () => {
  test("each hook gates on the payload's cwd, not the process's", () => {
    const f = fixture((inside) => inside);
    f.env.AK_LEARN_DRY_RUN = "1";
    // Run from inside the scope, about a session outside it: nothing.
    expect(hook(f, "session-start", { cwd: f.outside }, f.inside).out).toBe("");
    expect(hook(f, "stop", { cwd: f.outside }, f.inside).err).toBe("");
    hook(f, "prompt", { cwd: f.outside, prompt: CORRECTION }, f.inside);
    expect(readJsonl<SpanRow>(join(f.config.runtimeDir, SPAN_FILE))).toEqual([]);
    // Run from outside, about a session inside: each acts.
    expect(hook(f, "session-start", { cwd: f.inside }, f.outside).out).toContain("[rp-001] read the diff");
    expect(hook(f, "stop", { cwd: f.inside }, f.outside).err).toContain("would detach");
    expect(spansNamed(f.config, "hook.stop").length).toBe(1);
  });

  test("setup scope --set works on a machine with no runtime directory yet, and writes no temp file behind", () => {
    const f = fixture();
    expect(existsSync(f.config.runtimeDir)).toBe(false);
    const { out, io } = collect();
    expect(runLearn(["setup", "scope", "--set", f.inside], { cwd: f.inside, io, env: f.env })).toBe(0);
    expect(readFileSync(scopeFile(f.config.runtimeDir), "utf8")).toBe(`${f.inside}\n`);
    expect(existsSync(`${scopeFile(f.config.runtimeDir)}.tmp`)).toBe(false);
    expect(out.at(-1)).toBe(`scope: ${f.inside} (scope file)`);
  });

  test("setup scope --set stores a linked worktree as its main root and refuses any directory below a root", () => {
    const f = fixture();
    const wt = join(scratch(), "wt");
    run(["git", "worktree", "add", "-q", "-b", "feature-z", wt], { cwd: f.inside });
    // A plain folder under a repository (a dotfiles-tracked home) must not widen the scope to that repository.
    const sub = join(f.inside, "notes");
    mkdirSync(sub);
    const { out, io } = collect();
    runLearn(["setup", "scope", "--set", `${wt}:${sub}`], { cwd: f.inside, io, env: f.env });
    expect(out).toContain(`  ${wt}: stored as its main repository root ${f.inside}`);
    expect(out).toContain(`  ignored: ${sub} (not a repository root or a linked worktree)`);
    expect(readFileSync(scopeFile(f.config.runtimeDir), "utf8")).toBe(`${f.inside}\n`);
    expect(hook(f, "session-start", { cwd: wt }).out).toContain("[rp-001] read the diff");
  });

  test("a dangling-symlink scope file allows nothing instead of reading as no scope", () => {
    const f = fixture();
    mkdirSync(f.config.runtimeDir, { recursive: true });
    symlinkSync(join(f.config.runtimeDir, "gone"), scopeFile(f.config.runtimeDir));
    const config = loadConfig(f.env);
    expect([config.reposSource, config.repos]).toEqual(["file", []]);
  });
});
