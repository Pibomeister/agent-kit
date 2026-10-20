/**
 * Loaded by `bun test` before the suite (`bunfig.toml` `[test] preload`). The
 * process drops the operator's learn settings (a scope, a judge command), and
 * every config root it would resolve from its environment points at scratch
 * inside the process temporary directory (`helpers/process-tmp.ts`), which is
 * removed when the run exits.
 * HOME is left alone: Bun reads it once at startup, so `homedir()` and a config
 * built from an env without `CLAUDE_CONFIG_DIR` (`loadConfig({})`) still name
 * the operator's real directories, so a test that writes a judge call or a span
 * passes a config built from the environment, never `loadConfig({})`.
 * It also makes every test that reaches no assertion fail (see the end of this file).
 */
import { beforeEach, expect } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { processScratch } from "./helpers/process-tmp.ts";

for (const key of Object.keys(process.env)) if (key.startsWith("AK_LEARN_")) Reflect.deleteProperty(process.env, key);
const root = processScratch("ak-test-env-");
// /usr/bin/git on macOS launches the selected developer tool on every call. Resolve
// that same tool once; thousands of fixture calls otherwise pay for the launcher.
// A private PATH entry changes only git, and tests can still prepend their stubs.
if (process.platform === "darwin" && Bun.which("git") === "/usr/bin/git") {
  const selected = Bun.spawnSync(["/usr/bin/xcrun", "--find", "git"]);
  const executable = selected.stdout.toString().trim();
  if (selected.exitCode === 0 && executable !== "/usr/bin/git" && executable.startsWith("/")) {
    const bin = join(root, "bin");
    mkdirSync(bin);
    // A symlink inside bin changes Git's runtime prefix and loses its templates and helpers.
    const quoted = `'${executable.replaceAll("'", "'\\''")}'`;
    writeFileSync(join(bin, "git"), `#!/bin/sh\nexec ${quoted} "$@"\n`, { mode: 0o755 });
    process.env.PATH = `${bin}:${process.env.PATH ?? ""}`;
  }
}
process.env.CLAUDE_CONFIG_DIR = join(root, "claude");
process.env.CLAUDE_MEM_DATA_DIR = join(root, "claude-mem");
process.env.CODEX_HOME = join(root, "codex");
// The knowledgebase registry is the operator's, under their home; no test reads or writes the real one.
process.env.AK_KB_REGISTRY = join(root, "agent-kit-kb", "registry.json");

// Every test must reach at least one assertion. A loop over an empty list, an early return or a swallowed
// callback otherwise passes having checked nothing, which is how a test once ran green with zero assertions.
// Limits: an expect() in a beforeEach hook counts for every test under it, and running `bun test` from
// inside tests/ skips this file, because bunfig.toml is read from the repository root only.
beforeEach(() => {
  expect.hasAssertions();
});
