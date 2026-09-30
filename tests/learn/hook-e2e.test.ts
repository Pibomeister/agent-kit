/**
 * Hook equivalence: `ak learn hook session-start`, run as the real CLI in a
 * subprocess against a seeded scratch `CLAUDE_CONFIG_DIR`, prints exactly the
 * block `sessionStartBlock` returns in process. The live influence eval builds
 * its injected context through the subprocess, so this is what lets its
 * numbers speak for the in-process function the rest of the suite tests.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "../../src/learn/core/proc.ts";
import { ensureMemoryLedger, memoryDir, readState, saveState, SECTIONS, writeLesson } from "../../src/learn/memory/ledger.ts";
import { applyReflection } from "../../src/learn/memory/reflect.ts";
import { sessionStartBlock } from "../../src/learn/memory/session-context.ts";
import { reviewLedger } from "../../src/learn/review/ledger.ts";
import { gitRepo, scratch, testContext, type TestContext } from "./helpers.ts";

const CLI = join(import.meta.dir, "..", "..", "src", "cli.ts");
/** Each test starts the CLI as a subprocess, which under a loaded full run takes longer than the default 5s. */
const TIMEOUT_MS = 60_000;

/** `bun test` renders in UTC without setting TZ, so the subprocess is handed this process's zone: "next nightly" is a local date. */
function hook(ctx: TestContext, cwd: string, stdin: string): { code: number; stdout: string } {
  const env = { ...ctx.env, TZ: Intl.DateTimeFormat().resolvedOptions().timeZone };
  const result = run([process.execPath, CLI, "learn", "hook", "session-start"], { cwd, input: stdin, env, timeoutMs: TIMEOUT_MS });
  return { code: result.code, stdout: result.stdout };
}

/** Memory through the reflect gate, a confirmed lesson and a guardrail; `last_reflect` pinned days back so both calls print the same age. */
function seeded(env: Record<string, string> = {}): { ctx: TestContext; root: string } {
  const root = gitRepo(join(scratch(), "shop"));
  const ctx = testContext({ cwd: root, env });
  const ledger = ensureMemoryLedger(memoryDir(ctx.config, root));
  const memory = [
    SECTIONS[0],
    "- the api moved to v2 [obs:11]",
    SECTIONS[1],
    SECTIONS[2],
    SECTIONS[3],
    "- run tests with bun test --preload ./setup.ts [obs:12]",
    SECTIONS[4],
    "- scripts/docs.sh build needs --rebuild-index [obs:13]",
    SECTIONS[5],
    ...Array.from({ length: 40 }, (_, i) => `- shipped change number ${i} of the refund flow [obs:${100 + i}]`),
  ].join("\n");
  const valid = new Set(["obs:11", "obs:12", "obs:13", ...Array.from({ length: 40 }, (_, i) => `obs:${100 + i}`)]);
  expect(applyReflection(ledger, `${memory}\n`, valid, 20_000, 139, 2500).ok).toBe(true);
  saveState(ledger, { ...readState(ledger), last_reflect: Date.now() - 3 * 86_400_000 });
  writeLesson(ledger.path("lessons", "ls-001.md"), { id: "ls-001", statement: "never hand-edit dist/", status: "confirmed", confidence: "0.9" }, "\n");
  writeFileSync(reviewLedger(ctx.config, root).path("guardrails.md"), "# Guardrails\n\n- [rp-001] check the diff against the PR body\n");
  return { ctx, root };
}

describe("ak learn hook session-start as a subprocess", () => {
  test("prints the in-process block byte for byte", () => {
    const { ctx, root } = seeded();
    const out = hook(ctx, root, JSON.stringify({ cwd: root }));
    expect(out.code).toBe(0);
    const block = sessionStartBlock(ctx);
    expect(block).toContain("- run tests with bun test --preload ./setup.ts [obs:12]");
    expect(block).toContain("- never hand-edit dist/ [ls-001]");
    expect(block).toContain("memory: reflected 3d ago");
    expect(out.stdout).toBe(`${block.trimEnd()}\n`);
  }, TIMEOUT_MS);

  test("at a small cap the trimmed block is the same both ways", () => {
    const { ctx, root } = seeded({ AK_LEARN_MEMORY_TOKENS: "150" });
    const out = hook(ctx, root, JSON.stringify({ cwd: root }));
    const block = sessionStartBlock(ctx);
    expect(block).not.toContain("shipped change number 39");
    expect(out.stdout).toBe(`${block.trimEnd()}\n`);
  }, TIMEOUT_MS);

  test("the payload's cwd wins over the process cwd, as the host sends it", () => {
    const { ctx, root } = seeded();
    mkdirSync(join(root, "src"));
    const out = hook(ctx, scratch(), JSON.stringify({ cwd: join(root, "src") }));
    expect(out.stdout).toBe(`${sessionStartBlock({ ...ctx, cwd: join(root, "src") }).trimEnd()}\n`);
    expect(out.stdout).toContain("Working memory for this repo");
  }, TIMEOUT_MS);

  test("a malformed payload falls back to the process cwd and still exits 0", () => {
    const { ctx, root } = seeded();
    const out = hook(ctx, root, "{not json");
    expect(out.code).toBe(0);
    expect(out.stdout).toBe(`${sessionStartBlock(ctx).trimEnd()}\n`);
  }, TIMEOUT_MS);
});
