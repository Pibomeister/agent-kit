/**
 * Runs before every test file (`bunfig.toml` `[test] preload`). A test process
 * never inherits the operator's learn settings (a scope, a judge command) and
 * never resolves a config root to the operator's real one, so no test reads or
 * appends to the live trace, registry or ledgers.
 */
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

for (const key of Object.keys(process.env)) if (key.startsWith("AK_LEARN_")) delete process.env[key];
const root = realpathSync(mkdtempSync(join(tmpdir(), "ak-test-env-")));
process.env.CLAUDE_CONFIG_DIR = join(root, "claude");
process.env.CLAUDE_MEM_DATA_DIR = join(root, "claude-mem");
process.env.CODEX_HOME = join(root, "codex");
