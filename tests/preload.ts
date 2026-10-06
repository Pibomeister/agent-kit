/**
 * Loaded by `bun test` before the suite (`bunfig.toml` `[test] preload`). The
 * process drops the operator's learn settings (a scope, a judge command), and
 * every config root it would resolve from its environment points at scratch.
 * HOME is left alone: Bun reads it once at startup, so `homedir()` and a config
 * built from an env without `CLAUDE_CONFIG_DIR` (`loadConfig({})`) still name
 * the operator's real directories, so a test that writes a judge call or a span
 * passes a config built from the environment, never `loadConfig({})`.
 * It also makes every test that reaches no assertion fail (see the end of this file).
 */
import { beforeEach, expect } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

for (const key of Object.keys(process.env)) if (key.startsWith("AK_LEARN_")) Reflect.deleteProperty(process.env, key);
const root = realpathSync(mkdtempSync(join(tmpdir(), "ak-test-env-")));
process.env.CLAUDE_CONFIG_DIR = join(root, "claude");
process.env.CLAUDE_MEM_DATA_DIR = join(root, "claude-mem");
process.env.CODEX_HOME = join(root, "codex");
// The knowledgebase registry is the operator's, under their home; no test reads or writes the real one.
process.env.AK_KB_REGISTRY = join(root, "agent-kit-kb", "registry.json");

// Every test must reach at least one assertion. A loop over an empty list, an early return or a swallowed
// callback otherwise passes having checked nothing, which is how a test once ran green with zero assertions.
beforeEach(() => {
  expect.hasAssertions();
});
