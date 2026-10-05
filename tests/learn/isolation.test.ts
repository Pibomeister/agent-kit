/**
 * The suite never reaches the operator's real learn state: `tests/preload.ts`
 * strips the operator's `AK_LEARN_*` and points every config root at scratch,
 * and no test builds a judge from `loadConfig({})`, whose config directory is
 * the real `~/.claude` whatever the environment says.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";

const TESTS = join(import.meta.dir, "..");
const REAL_CONFIG_JUDGE = /commandJudge\([^;]*loadConfig\(\s*\{\s*\}\s*\)/;

/** A judge call with `body` as its argument, assembled so this file's own text never carries the shape it scans for. */
function call(body: string): string {
  return ["commandJudge", "(", body, ")"].join("");
}

function sources(dir: string): string[] {
  return (
    readdirSync(dir, { recursive: true, encoding: "utf8" })
      // tests/fixtures holds scaffold repositories, not tests.
      .filter((path) => path.endsWith(".ts") && !path.split("/").includes("fixtures"))
      .map((path) => join(dir, path))
  );
}

describe("test isolation", () => {
  test("the preload stripped AK_LEARN_* and moved every config root to scratch", () => {
    expect(Object.keys(process.env).filter((key) => key.startsWith("AK_LEARN_"))).toEqual([]);
    for (const key of ["CLAUDE_CONFIG_DIR", "CLAUDE_MEM_DATA_DIR", "CODEX_HOME", "HOME"]) {
      const value = process.env[key] ?? "/";
      expect(relative(realpathSync(tmpdir()), value).startsWith("..")).toBe(false);
      expect(basename(dirname(value)).startsWith("ak-test-env-")).toBe(true);
    }
  });

  test("the guard matches the defect's shapes and not the fix", () => {
    for (const body of ["{ ...loadConfig({}), judgeCommand: x }", "{\n  ...loadConfig({ }),\n}"])
      expect(REAL_CONFIG_JUDGE.test(call(body))).toBe(true);
    expect(REAL_CONFIG_JUDGE.test(call('{ ...loadConfig({ CLAUDE_CONFIG_DIR: "x" }) }'))).toBe(false);
  });

  test("no test builds a judge from loadConfig({}), which writes the real trace", () => {
    const offenders = sources(TESTS)
      .filter((path) => REAL_CONFIG_JUDGE.test(readFileSync(path, "utf8")))
      .map((path) => relative(TESTS, path));
    expect(offenders).toEqual([]);
  });
});
