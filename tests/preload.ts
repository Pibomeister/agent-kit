/**
 * Loaded by `bun test` before the suite (`bunfig.toml` `[test] preload`). The
 * process drops the operator's learn settings (a scope, a judge command), and
 * every config root it would resolve from its environment or from `homedir()`
 * points at scratch. A context built from an explicit env that names a real
 * directory is outside its reach; `tests/learn/isolation.test.ts` guards the
 * one such shape that reached the operator's judge trace.
 */
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

for (const key of Object.keys(process.env)) if (key.startsWith("AK_LEARN_")) Reflect.deleteProperty(process.env, key);
const root = realpathSync(mkdtempSync(join(tmpdir(), "ak-test-env-")));
process.env.CLAUDE_CONFIG_DIR = join(root, "claude");
process.env.CLAUDE_MEM_DATA_DIR = join(root, "claude-mem");
process.env.CODEX_HOME = join(root, "codex");
// `loadConfig({})` and every other `homedir()` reader resolve under HOME, so it moves too.
process.env.HOME = join(root, "home");
mkdirSync(process.env.HOME);
