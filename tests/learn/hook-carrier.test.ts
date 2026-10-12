/**
 * `ak learn hook session-start --host grok|kimi`: the session-start block on a
 * host whose SessionStart output never reaches the model. The payloads are the
 * ones each host documents (`tests/fixtures/learn-hosts/README.md`), with the
 * working directory pointed at a scratch project.
 */
import { describe, expect, test } from "bun:test";
import Ajv from "ajv";
import { existsSync, mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runLearn } from "../../src/learn/cli.ts";
import { parseLearnArgs } from "../../src/learn/core/context.ts";
import { run } from "../../src/learn/core/proc.ts";
import { sessionKey, spanRows } from "../../src/learn/core/trace.ts";
import { GROK_CONTEXT_CHARS, hookArea } from "../../src/learn/hooks.ts";
import { claim, MARK_MAX_AGE_MS, markPath } from "../../src/learn/memory/delivery.ts";
import { ensureMemoryLedger, memoryDir, SECTIONS, writeLesson } from "../../src/learn/memory/ledger.ts";
import { readRegistry } from "../../src/learn/memory/registry.ts";
import { sessionStartBlock, sessionStartBlockWithin } from "../../src/learn/memory/session-context.ts";
import { reviewLedger } from "../../src/learn/review/ledger.ts";
import { rosterSection } from "../../src/learn/skills/roster.ts";
import { gitRepo, scratch, type TestContext, testContext } from "./helpers.ts";

const CLI = join(import.meta.dir, "..", "..", "src", "cli.ts");
const FIXTURES = join(import.meta.dir, "..", "fixtures", "learn-hosts");
/** The one subprocess test starts the CLI four times at once, which under a loaded full run outlasts the default 5s. */
const TIMEOUT_MS = 300_000;

/** A documented payload with its `cwd` set, and any other field replaced. */
function payload(name: string, cwd: string, replace: Record<string, string> = {}): string {
  const documented: unknown = JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));
  return JSON.stringify({ ...Object(documented), cwd, ...replace });
}

/** A project with working memory, a confirmed lesson and a guardrail; `bullets` sizes the memory. */
function seeded(bullets = 3, env: Record<string, string> = {}) {
  const root = gitRepo(join(scratch(), "shop"));
  const ctx = testContext({ cwd: root, env });
  const ledger = ensureMemoryLedger(memoryDir(ctx.config, root));
  const done = Array.from(
    { length: bullets },
    (_, i) => `- shipped change number ${i} of the refund flow [obs:${100 + i}]`,
  );
  writeFileSync(
    ledger.path("memory.md"),
    [SECTIONS[0], "- the api moved to v2 [obs:11]", SECTIONS[5], ...done, ""].join("\n"),
  );
  writeLesson(
    ledger.path("lessons", "ls-001.md"),
    { id: "ls-001", statement: "never hand-edit dist/", status: "confirmed", confidence: "0.9" },
    "\n",
  );
  writeFileSync(
    reviewLedger(ctx.config, root).path("guardrails.md"),
    "# Guardrails\n\n- [rp-001] check the diff against the PR body\n",
  );
  return { ctx, root };
}

interface GrokOutput {
  hookSpecificOutput: { hookEventName: string; additionalContext: string };
}

/** Exactly the object Grok's PostToolUse reads a note from; any other key fails. */
const isGrokOutput = new Ajv({ strict: false }).compile<GrokOutput>({
  type: "object",
  required: ["hookSpecificOutput"],
  additionalProperties: false,
  properties: {
    hookSpecificOutput: {
      type: "object",
      required: ["hookEventName", "additionalContext"],
      additionalProperties: false,
      properties: { hookEventName: { const: "PostToolUse" }, additionalContext: { type: "string" } },
    },
  },
});

/** The context one printed Grok hook line carries. */
function carried(lines: string[]): string {
  expect(lines).toHaveLength(1);
  const parsed: unknown = JSON.parse(lines[0] ?? "");
  if (!isGrokOutput(parsed)) throw new Error(`not the output Grok's PostToolUse reads: ${lines[0]}`);
  return parsed.hookSpecificOutput.additionalContext;
}

/** Run the whole `ak learn` command line in process and return what it printed. */
async function cli(ctx: TestContext, argv: string[], stdin: string): Promise<string[]> {
  const before = ctx.out.length;
  expect(await runLearn(["hook", "session-start", ...argv], { cwd: scratch(), io: ctx.io, env: ctx.env, stdin })).toBe(
    0,
  );
  return ctx.out.slice(before);
}

/** Run the hook in process and return what it printed. */
function hook(ctx: TestContext, args: string[], stdin: string): string[] {
  const verb = hookArea.verbs["session-start"];
  if (verb === undefined) throw new Error("no session-start verb");
  const before = ctx.out.length;
  expect(verb.run(parseLearnArgs(args), { ...ctx, stdin })).toBe(0);
  return ctx.out.slice(before);
}

function marks(ctx: TestContext, host: string): string[] {
  const dir = join(ctx.config.runtimeDir, "delivered", host);
  return existsSync(dir) ? readdirSync(dir) : [];
}

describe("session-start --host kimi", () => {
  const KIMI = ["--host", "kimi"];

  test("the first submitted prompt of a session gets the whole block as plain text, and later ones get nothing", () => {
    const { ctx, root } = seeded();
    const prompt = payload("kimi/user-prompt-submit.stdin.json", root);
    const block = sessionStartBlock(ctx);
    expect(block).toContain("- [rp-001] check the diff against the PR body");
    expect(block).toContain("- the api moved to v2 [obs:11]");
    expect(block).toContain("- never hand-edit dist/ [ls-001]");
    expect(hook(ctx, KIMI, prompt)).toEqual([block.trimEnd()]);
    expect(hook(ctx, KIMI, prompt)).toEqual([]);
    expect(hook(ctx, KIMI, prompt)).toEqual([]);
    expect(ctx.err).toEqual([]);
  });

  test("each session is delivered once, on its own", () => {
    const { ctx, root } = seeded();
    const first = payload("kimi/user-prompt-submit.stdin.json", root);
    const second = payload("kimi/user-prompt-submit.stdin.json", root, { session_id: "session_other" });
    expect(hook(ctx, KIMI, first)).toHaveLength(1);
    expect(hook(ctx, KIMI, second)).toHaveLength(1);
    expect(hook(ctx, KIMI, first)).toEqual([]);
    expect(hook(ctx, KIMI, second)).toEqual([]);
    expect(marks(ctx, "kimi")).toHaveLength(2);
  });

  test("a resumed or compacted session is armed again: --arm prints nothing and the next prompt delivers", () => {
    const { ctx, root } = seeded();
    const prompt = payload("kimi/user-prompt-submit.stdin.json", root);
    for (const event of ["kimi/session-start.stdin.json", "kimi/post-compact.stdin.json"]) {
      expect(hook(ctx, KIMI, prompt)).toHaveLength(1);
      expect(hook(ctx, KIMI, prompt)).toEqual([]);
      expect(hook(ctx, [...KIMI, "--arm"], payload(event, root))).toEqual([]);
      expect(marks(ctx, "kimi")).toEqual([]);
    }
    expect(hook(ctx, KIMI, prompt)).toHaveLength(1);
  });

  test("arming one session leaves another's delivery standing", () => {
    const { ctx, root } = seeded();
    const other = payload("kimi/user-prompt-submit.stdin.json", root, { session_id: "session_other" });
    expect(hook(ctx, KIMI, other)).toHaveLength(1);
    expect(hook(ctx, [...KIMI, "--arm"], payload("kimi/session-start.stdin.json", root))).toEqual([]);
    expect(hook(ctx, KIMI, other)).toEqual([]);
  });

  test("a payload that names no session prints nothing and marks nothing", () => {
    const { ctx, root } = seeded();
    for (const stdin of [
      "",
      "not json",
      "[]",
      JSON.stringify({ cwd: root }),
      JSON.stringify({ cwd: root, session_id: 7 }),
    ]) {
      expect(hook(ctx, KIMI, stdin)).toEqual([]);
    }
    expect(marks(ctx, "kimi")).toEqual([]);
    expect(ctx.err).toEqual([]);
  });

  test("outside any repository the skill roster alone is printed once, and the session is still settled", () => {
    const ctx = testContext();
    const stdin = payload("kimi/user-prompt-submit.stdin.json", scratch());
    const block = sessionStartBlock({ ...ctx, cwd: scratch() });
    expect(block).toStartWith("## Skill roster");
    expect(hook(ctx, KIMI, stdin)).toEqual([block.trimEnd()]);
    expect(hook(ctx, KIMI, stdin)).toEqual([]);
  });

  test("the session id never becomes a path", () => {
    const { ctx, root } = seeded();
    const stdin = payload("kimi/user-prompt-submit.stdin.json", root, { session_id: "../../../escape" });
    expect(hook(ctx, KIMI, stdin)).toHaveLength(1);
    expect(marks(ctx, "kimi")).toHaveLength(1);
    expect(marks(ctx, "kimi")[0]).toMatch(/^[0-9a-f]{32}$/);
    expect(hook(ctx, KIMI, stdin)).toEqual([]);
  });
});

describe("session-start --host grok", () => {
  const GROK = ["--host", "grok"];

  test("the first tool result of a session carries the block as additionalContext, and later ones carry nothing", () => {
    const { ctx, root } = seeded();
    const tool = payload("grok/post-tool-use.stdin.json", root);
    expect(carried(hook(ctx, GROK, tool))).toBe(sessionStartBlock(ctx).trimEnd());
    expect(hook(ctx, GROK, tool)).toEqual([]);
    expect(hook(ctx, [...GROK, "--arm"], payload("grok/session-start.stdin.json", root))).toEqual([]);
    expect(carried(hook(ctx, GROK, tool))).toBe(sessionStartBlock(ctx).trimEnd());
    expect(hook(ctx, [...GROK, "--arm"], payload("grok/post-compact.stdin.json", root))).toEqual([]);
    expect(carried(hook(ctx, GROK, tool))).toBe(sessionStartBlock(ctx).trimEnd());
    expect(ctx.err).toEqual([]);
  });

  test("a block longer than Grok's clip gives up memory bullets, not guardrails or lessons, to fit", () => {
    const { ctx, root } = seeded(400, { AK_LEARN_MEMORY_TOKENS: "6000" });
    const whole = sessionStartBlock(ctx);
    expect(whole.length).toBeGreaterThan(GROK_CONTEXT_CHARS);
    const fitted = carried(hook(ctx, GROK, payload("grok/post-tool-use.stdin.json", root)));
    expect(fitted.length).toBeLessThanOrEqual(GROK_CONTEXT_CHARS);
    expect(fitted.length).toBeGreaterThan(GROK_CONTEXT_CHARS * 0.8);
    expect(fitted).toContain("- [rp-001] check the diff against the PR body");
    expect(fitted).toContain("- the api moved to v2 [obs:11]");
    expect(fitted).toContain("- never hand-edit dist/ [ls-001]");
    expect(fitted).toContain("- shipped change number 0 of the refund flow [obs:100]");
    expect(fitted).not.toContain("shipped change number 399");
    expect(fitted).toContain("memory: reflected");
  });

  test("a roster that fits whole once memory gave way is not called shortened", () => {
    const { ctx, root } = seeded(3, { AK_LEARN_MEMORY_TOKENS: "6000" });
    const ledger = ensureMemoryLedger(memoryDir(ctx.config, root));
    writeFileSync(
      ledger.path("memory.md"),
      [SECTIONS[0], "- the api moved to v2 [obs:11]", SECTIONS[5], `- ${"long ".repeat(2000)}[obs:100]`, ""].join("\n"),
    );
    expect(sessionStartBlock(ctx).length).toBeGreaterThan(GROK_CONTEXT_CHARS);
    const fitted = carried(hook(ctx, GROK, payload("grok/post-tool-use.stdin.json", root)));
    expect(fitted).toContain("- the api moved to v2 [obs:11]");
    expect(fitted).not.toContain("long long");
    expect(fitted).toEndWith(rosterSection(ctx, root).trim());
    expect(fitted).not.toContain("roster shortened");
  });

  test("text no cap can shrink is cut on a line under the clip", () => {
    const { ctx, root } = seeded();
    writeFileSync(
      reviewLedger(ctx.config, root).path("guardrails.md"),
      `# Guardrails\n\n${Array.from({ length: 30 }, (_, i) => `- [rp-${i}] ${"x".repeat(60)}`).join("\n")}\n`,
    );
    const small = sessionStartBlockWithin(ctx, 600);
    expect(small.length).toBeLessThanOrEqual(600);
    expect(small).toContain("- [rp-0] ");
    expect(small).toEndWith(
      "(truncated at the memory token cap)\n\n(skill roster shortened to fit this host's context limit)\n",
    );
    expect(sessionStartBlockWithin(ctx, 1_000_000)).toBe(sessionStartBlock(ctx));
  });

  test("a roster longer than Grok's clip is the part cut: guardrails, memory and lessons arrive whole", () => {
    const { ctx, root } = seeded();
    const before = sessionStartBlock(ctx);
    const ahead = before.slice(0, before.indexOf(rosterSection(ctx, root).trim()));
    const skills = join(ctx.config.configDir, "skills");
    for (let i = 0; i < 150; i += 1) {
      const name = `local-skill-${String(i).padStart(3, "0")}`;
      mkdirSync(join(skills, name), { recursive: true });
      writeFileSync(
        join(skills, name, "SKILL.md"),
        `---\nname: ${name}\ndescription: ${"does one narrow thing ".repeat(6)}\n---\n`,
      );
    }
    expect(rosterSection(ctx, root).length).toBeGreaterThanOrEqual(11_955);
    const fitted = carried(hook(ctx, GROK, payload("grok/post-tool-use.stdin.json", root)));
    expect(fitted.length).toBeLessThanOrEqual(GROK_CONTEXT_CHARS);
    expect(fitted.length).toBeGreaterThan(GROK_CONTEXT_CHARS * 0.95);
    expect(ahead).toContain("- [rp-001] check the diff against the PR body");
    expect(ahead).toContain("- never hand-edit dist/ [ls-001]");
    expect(ahead).toContain("- shipped change number 2 of the refund flow [obs:102]");
    expect(fitted).toStartWith(ahead);
    expect(fitted).not.toContain("(truncated at the memory token cap)");
    expect(fitted).toContain("- local-skill-000:");
    expect(fitted).toEndWith("(skill roster shortened to fit this host's context limit)");
    expect(fitted.split("\n").at(-2)).toMatch(/^- local-skill-\d{3}: .*\S$/);
  });

  test("a session whose payload names no id receives nothing", () => {
    const { ctx, root } = seeded();
    expect(hook(ctx, GROK, JSON.stringify({ cwd: root }))).toEqual([]);
    expect(marks(ctx, "grok")).toEqual([]);
  });

  test("each host's span carries the key of the session its payload names, in that host's spelling", () => {
    const { ctx, root } = seeded();
    hook(ctx, GROK, payload("grok/post-tool-use.stdin.json", root, { sessionId: "grok-one" }));
    hook(ctx, ["--host", "kimi"], payload("kimi/user-prompt-submit.stdin.json", root, { session_id: "kimi-one" }));
    const starts = spanRows(ctx.config).filter((row) => row.name === "hook.session-start");
    expect(starts.map((row) => row.attrs.session)).toEqual([
      sessionKey(ctx.config, "grok-one") ?? "",
      sessionKey(ctx.config, "kimi-one") ?? "",
    ]);
    for (const row of starts) expect(row.attrs.shown).toEqual(["rp-001", "ls-001"]);
    expect(JSON.stringify(starts)).not.toContain("-one");
  });

  test("Grok's and Kimi's marks are separate", () => {
    const { ctx, root } = seeded();
    const same = { session_id: "one", sessionId: "one" };
    expect(hook(ctx, GROK, payload("grok/post-tool-use.stdin.json", root, same))).toHaveLength(1);
    expect(hook(ctx, ["--host", "kimi"], payload("kimi/user-prompt-submit.stdin.json", root, same))).toHaveLength(1);
  });
});

describe("session-start for every host", () => {
  test("an unknown --host prints nothing to the model, says why on stderr, and still exits 0", () => {
    const { ctx, root } = seeded();
    expect(hook(ctx, ["--host", "vim"], JSON.stringify({ cwd: root, session_id: "s" }))).toEqual([]);
    expect(ctx.err).toEqual(["ak learn session-start: --host is grok or kimi"]);
  });

  test("Droid's SessionStart payload gets the plain block every time, as Claude's does", () => {
    const { ctx, root } = seeded();
    const stdin = payload("droid/session-start.stdin.json", root);
    expect(hook(ctx, [], stdin)).toEqual([sessionStartBlock(ctx).trimEnd()]);
    expect(hook(ctx, [], stdin)).toEqual([sessionStartBlock(ctx).trimEnd()]);
    expect(existsSync(join(ctx.config.runtimeDir, "delivered"))).toBe(false);
  });

  test("a carrier session leaves one span, for the call that delivered: repeat and --arm calls leave none", () => {
    for (const [host, stdin] of [
      ["kimi", "kimi/user-prompt-submit.stdin.json"],
      ["grok", "grok/post-tool-use.stdin.json"],
    ] as const) {
      const { ctx, root } = seeded();
      const rows = () => spanRows(ctx.config).filter((row) => row.name === "hook.session-start");
      hook(ctx, ["--host", host], payload(stdin, root));
      hook(ctx, ["--host", host], payload(stdin, root));
      hook(ctx, ["--host", host], payload(stdin, root));
      expect(rows().map((row) => row.status)).toEqual(["ok"]);
      expect(rows().map((row) => row.attrs.shown)).toEqual([["rp-001", "ls-001"]]);
      hook(ctx, ["--host", host, "--arm"], payload(stdin, root));
      expect(rows()).toHaveLength(1);
      hook(ctx, ["--host", host], payload(stdin, root));
      expect(rows().map((row) => row.status)).toEqual(["ok", "ok"]);
    }
  });

  test("a session in a linked worktree reads and registers the main repository, on every host's path", () => {
    const { ctx, root } = seeded();
    const linked = join(scratch(), "wt");
    expect(run(["git", "worktree", "add", "-q", "-b", "feature-x", linked], { cwd: root }).code).toBe(0);
    const block = sessionStartBlock(ctx).trimEnd();
    expect(hook(ctx, [], payload("droid/session-start.stdin.json", linked))).toEqual([block]);
    expect(hook(ctx, ["--host", "kimi"], payload("kimi/user-prompt-submit.stdin.json", linked))).toEqual([block]);
    const grok = hook(ctx, ["--host", "grok"], payload("grok/post-tool-use.stdin.json", linked));
    expect(carried(grok)).toBe(block);
    expect(Object.values(readRegistry(ctx.config)).map((entry) => entry.root)).toEqual([root]);
    expect(readdirSync(join(ctx.config.configDir, "projects"))).toHaveLength(1);
  });

  test("a claim sweeps marks of sessions long over and keeps recent ones", () => {
    const { ctx } = seeded();
    const now = Date.now();
    expect(claim(ctx.config, "kimi", "old", now)).toBe(true);
    expect(claim(ctx.config, "kimi", "recent", now)).toBe(true);
    const stale = (now - MARK_MAX_AGE_MS - 60_000) / 1000;
    utimesSync(markPath(ctx.config, "kimi", "old"), stale, stale);
    expect(claim(ctx.config, "kimi", "recent", now)).toBe(false);
    expect(existsSync(markPath(ctx.config, "kimi", "old"))).toBe(true);
    expect(claim(ctx.config, "kimi", "new", now)).toBe(true);
    expect(existsSync(markPath(ctx.config, "kimi", "old"))).toBe(false);
    expect(existsSync(markPath(ctx.config, "kimi", "recent"))).toBe(true);
  });
});

describe("ak learn hook session-start --host through the CLI", () => {
  test("the command lines `setup wire` writes do what their hooks are wired for", async () => {
    const { ctx, root } = seeded();
    const block = sessionStartBlock(ctx).trimEnd();
    const prompt = payload("kimi/user-prompt-submit.stdin.json", root);
    expect(await cli(ctx, ["--host", "kimi"], prompt)).toEqual([block]);
    expect(await cli(ctx, ["--host", "kimi"], prompt)).toEqual([]);
    expect(await cli(ctx, ["--host", "kimi", "--arm"], payload("kimi/session-start.stdin.json", root))).toEqual([]);
    expect(await cli(ctx, ["--host", "kimi"], prompt)).toEqual([block]);

    const tool = await cli(ctx, ["--host", "grok"], payload("grok/post-tool-use.stdin.json", root));
    expect(tool[0]?.split("\n")).toHaveLength(1);
    expect(carried(tool)).toBe(block);
    expect(await cli(ctx, ["--host", "grok", "--arm"], payload("grok/post-compact.stdin.json", root))).toEqual([]);
    expect(await cli(ctx, ["--host", "grok"], payload("grok/post-tool-use.stdin.json", root))).toHaveLength(1);
    expect(ctx.err).toEqual([]);
  });

  test(
    "tool calls finishing together, each its own process, deliver the block exactly once",
    async () => {
      const { ctx, root } = seeded();
      const stdin = payload("grok/post-tool-use.stdin.json", root);
      const outputs = await Promise.all(
        Array.from({ length: 4 }, async () => {
          const child = Bun.spawn([process.execPath, CLI, "learn", "hook", "session-start", "--host", "grok"], {
            cwd: root,
            env: ctx.env,
            stdin: new Blob([stdin]),
            stdout: "pipe",
            stderr: "pipe",
          });
          const stdout = await new Response(child.stdout).text();
          expect(await child.exited).toBe(0);
          return stdout;
        }),
      );
      expect(outputs.filter((stdout) => stdout !== "")).toHaveLength(1);
      expect(marks(ctx, "grok")).toHaveLength(1);
    },
    TIMEOUT_MS,
  );
});
