import { describe, expect, test } from "bun:test";
import { BLOCK_BEGIN, BLOCK_END, hookBlock, tomlHooks, withHookBlock } from "../../src/learn/setup/toml-hooks.ts";

const HOOK = { event: "UserPromptSubmit", command: `"/opt/my bun" '/pkg/src/cli.ts' learn hook x`, timeout: 10 };
const BLOCK = hookBlock([HOOK, { event: "PostCompact", command: "ak learn hook y", timeout: 5 }]);

describe("managed TOML hook block", () => {
  test("renders tables TOML reads back to the same values, quotes and all", () => {
    expect(BLOCK.startsWith(`${BLOCK_BEGIN}\n`)).toBe(true);
    expect(BLOCK.endsWith(`\n${BLOCK_END}`)).toBe(true);
    expect(Bun.TOML.parse(BLOCK)).toEqual({
      hooks: [HOOK, { event: "PostCompact", command: "ak learn hook y", timeout: 5 }],
    });
    expect(tomlHooks(BLOCK)?.map((hook) => hook.event)).toEqual(["UserPromptSubmit", "PostCompact"]);
  });

  test("is appended after one blank line, whatever the file ended with", () => {
    expect(withHookBlock("", BLOCK)).toBe(`${BLOCK}\n`);
    expect(withHookBlock("a = 1\n", BLOCK)).toBe(`a = 1\n\n${BLOCK}\n`);
    expect(withHookBlock("a = 1", BLOCK)).toBe(`a = 1\n\n${BLOCK}\n`);
  });

  test("is replaced where it stands, and the text around it is not touched", () => {
    const old = hookBlock([{ event: "SessionStart", command: "old learn hook z", timeout: 1 }]);
    const text = `a = 1\n\n${old}\n\n# mine\n[[hooks]]\nevent = "Stop"\ncommand = "echo bye"\n`;
    expect(withHookBlock(text, BLOCK)).toBe(
      `a = 1\n\n${BLOCK}\n\n# mine\n[[hooks]]\nevent = "Stop"\ncommand = "echo bye"\n`,
    );
  });

  test("setting the block it already holds changes nothing", () => {
    const text = `a = 1\n\n${BLOCK}\n`;
    expect(withHookBlock(text, BLOCK)).toBe(text);
  });

  test("removal gives back the bytes the block was appended to", () => {
    for (const original of ["", "a = 1\n", "# only a comment\n\n\n"]) {
      const wired = withHookBlock(original, BLOCK) ?? "";
      expect(withHookBlock(wired, null)).toBe(original);
    }
    expect(withHookBlock("a = 1\n", null)).toBe("a = 1\n");
  });

  test("markers that are not one ordered pair are refused", () => {
    expect(withHookBlock(`${BLOCK_BEGIN}\n`, BLOCK)).toBeNull();
    expect(withHookBlock(`${BLOCK_END}\n`, BLOCK)).toBeNull();
    expect(withHookBlock(`${BLOCK_END}\n${BLOCK_BEGIN}\n`, BLOCK)).toBeNull();
    expect(withHookBlock(`${BLOCK}\n${BLOCK}\n`, null)).toBeNull();
  });

  test("reads hook tables only from TOML whose hooks are a list of tables", () => {
    expect(tomlHooks("a = 1\n")).toEqual([]);
    expect(tomlHooks("a = = 1\n")).toBeNull();
    expect(tomlHooks('hooks = "none"\n')).toBeNull();
    expect(tomlHooks("[[hooks]]\nevent = 3\n")).toBeNull();
  });
});
