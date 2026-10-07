import { describe, expect, test } from "bun:test";
import { runLearn } from "../../src/learn/cli.ts";
import { scratch } from "./helpers.ts";

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (line: string) => out.push(line), err: (line: string) => err.push(line) }, out, err };
}

describe("ak learn hook never fails a session", () => {
  test("a malformed judge setting is reported and the hook exits 0", async () => {
    const { io, err } = capture();
    const env = { ...process.env, CLAUDE_CONFIG_DIR: scratch(), AK_LEARN_JUDGE: 'claude "' };
    expect(await runLearn(["hook", "stop"], { cwd: scratch(), io, env, stdin: "{}" })).toBe(0);
    expect(err.join("\n")).toContain("unterminated");
  });

  test("an unknown hook verb exits 0, never 2", async () => {
    const { io } = capture();
    expect(
      await runLearn(["hook", "renamed-later"], {
        cwd: scratch(),
        io,
        env: { ...process.env, CLAUDE_CONFIG_DIR: scratch() },
      }),
    ).toBe(0);
  });

  test("outside hooks, an unknown verb is still a usage error", async () => {
    const { io } = capture();
    expect(
      await runLearn(["memory", "nope"], { cwd: scratch(), io, env: { ...process.env, CLAUDE_CONFIG_DIR: scratch() } }),
    ).toBe(2);
  });
});
