/**
 * The suite never reaches the operator's real learn state: `tests/preload.ts`
 * strips the operator's `AK_LEARN_*` and points the environment's config roots
 * at scratch.
 */
import { describe, expect, test } from "bun:test";
import { basename, dirname, relative } from "node:path";
import { processDir } from "../helpers/process-tmp.ts";

describe("test isolation", () => {
  test("the preload stripped AK_LEARN_* and moved every config root to scratch", () => {
    expect(Object.keys(process.env).filter((key) => key.startsWith("AK_LEARN_"))).toEqual([]);
    for (const key of ["CLAUDE_CONFIG_DIR", "CLAUDE_MEM_DATA_DIR", "CODEX_HOME"]) {
      const value = process.env[key] ?? "/";
      expect(relative(processDir(), value).startsWith("..")).toBe(false);
      expect(basename(dirname(value)).startsWith("ak-test-env-")).toBe(true);
    }
  });
});
