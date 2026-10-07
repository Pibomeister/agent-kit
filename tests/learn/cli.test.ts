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
    const { io, err } = capture();
    expect(
      await runLearn(["memory", "nope"], { cwd: scratch(), io, env: { ...process.env, CLAUDE_CONFIG_DIR: scratch() } }),
    ).toBe(2);
    expect(err[0]).toBe("ak learn memory: unknown verb 'nope'; nearest of 8: mute, run, show");
  });

  test("an unknown area or verb names what was probably meant", async () => {
    const env = { ...process.env, CLAUDE_CONFIG_DIR: scratch() };
    const area = capture();
    expect(await runLearn(["memroy", "show"], { cwd: scratch(), io: area.io, env })).toBe(2);
    expect(area.err[0]).toBe("ak learn: unknown area 'memroy'; did you mean memory?");
    const verb = capture();
    expect(await runLearn(["review", "retier"], { cwd: scratch(), io: verb.io, env })).toBe(2);
    expect(verb.err[0]).toBe("ak learn review: unknown verb 'retier'; did you mean retire?");
    const hook = capture();
    expect(await runLearn(["hook", "sesion-start"], { cwd: scratch(), io: hook.io, env })).toBe(0);
    expect(hook.err[0]).toBe("ak learn hook: unknown verb 'sesion-start'; did you mean session-start?");
  });
});
