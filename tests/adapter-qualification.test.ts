import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  checkAdapterLaunch,
  LEAK_CHANNELS,
  parseAdapterLaunch,
  type AdapterReviewLaunch,
  type LeakChannel,
} from "../src/adapter-qualification/isolation.ts";
import { qualifyT3, T3_SLOTS } from "../src/adapter-qualification/t3.ts";

const REPO = resolve(import.meta.dir, "..");
const FIXTURES = join(REPO, "tests/fixtures/adapter-isolation");
const ISOLATION_SCRIPT = join(REPO, "scripts/adapter-isolation-check.sh");
const T3_SCRIPT = join(REPO, "scripts/t3-qualify.sh");
const CURSOR_CONTRACT = join(REPO, "adapters/cursor/CONTRACT.md");

function loadLaunch(name: string): AdapterReviewLaunch {
  const parsed = parseAdapterLaunch(readFileSync(join(FIXTURES, name), "utf8"));
  if (parsed === null) throw new Error(`${name} must parse`);
  return parsed;
}

function scriptEnv(): NodeJS.ProcessEnv {
  const bunBin = join(process.env["HOME"] ?? "", ".bun/bin");
  const path = `${bunBin}:${process.env["PATH"] ?? ""}`;
  return { ...process.env, PATH: path };
}

function runScript(script: string, args: readonly string[]) {
  return spawnSync("bash", [script, ...args], {
    cwd: REPO,
    encoding: "utf8",
    timeout: 30_000,
    killSignal: "SIGKILL",
    env: scriptEnv(),
  });
}

function leakOne(launch: AdapterReviewLaunch, channel: LeakChannel): AdapterReviewLaunch {
  const marker =
    channel === "parent-context"
      ? launch.parent.context
      : channel === "memory"
        ? launch.parent.memory
        : launch.parent.instructions;
  if (channel === "memory") {
    return {
      adapter: launch.adapter,
      parent: launch.parent,
      reviewSeat: { prompt: launch.reviewSeat.prompt, memory: [marker], instructions: launch.reviewSeat.instructions },
    };
  }
  if (channel === "instructions") {
    return {
      adapter: launch.adapter,
      parent: launch.parent,
      reviewSeat: { prompt: launch.reviewSeat.prompt, memory: launch.reviewSeat.memory, instructions: [marker] },
    };
  }
  return {
    adapter: launch.adapter,
    parent: launch.parent,
    reviewSeat: {
      prompt: `${launch.reviewSeat.prompt} ${marker}`,
      memory: launch.reviewSeat.memory,
      instructions: launch.reviewSeat.instructions,
    },
  };
}

describe("contaminated adapter isolation (GAP-18 / AT-27)", () => {
  test("the contaminated fixture fails on parent context, memory and instructions", () => {
    const launch = loadLaunch("contaminated.json");
    const verdict = checkAdapterLaunch(launch);
    expect(verdict.kind).toBe("fail");
    if (verdict.kind !== "fail") return;
    expect([...verdict.leaks]).toEqual([...LEAK_CHANNELS]);
  });

  test("the clean control passes and names no leak", () => {
    const verdict = checkAdapterLaunch(loadLaunch("clean.json"));
    expect(verdict).toEqual({ kind: "pass" });
  });

  test("each parent canary alone is enough to fail that channel", () => {
    const clean = loadLaunch("clean.json");
    for (const channel of LEAK_CHANNELS) {
      const verdict = checkAdapterLaunch(leakOne(clean, channel));
      expect(`${channel}:${verdict.kind}`).toBe(`${channel}:fail`);
      if (verdict.kind !== "fail") continue;
      expect([...verdict.leaks]).toEqual([channel]);
    }
  });

  test("a marker only in the parent document is not a seat leak", () => {
    const clean = loadLaunch("clean.json");
    expect(clean.reviewSeat.prompt.includes(clean.parent.context)).toBe(false);
    expect(clean.reviewSeat.prompt.includes(clean.parent.memory)).toBe(false);
    expect(clean.reviewSeat.prompt.includes(clean.parent.instructions)).toBe(false);
  });

  test("an isolated flag is not a launch field and cannot parse a leak into a pass", () => {
    const launch = loadLaunch("contaminated.json");
    const withFlag = {
      adapter: launch.adapter,
      parent: launch.parent,
      reviewSeat: launch.reviewSeat,
      isolated: true,
    };
    expect(parseAdapterLaunch(JSON.stringify(withFlag))).toBeNull();
  });

  test("the isolation script fails the contaminated fixture and passes the clean control", () => {
    const leaked = runScript(ISOLATION_SCRIPT, [join(FIXTURES, "contaminated.json")]);
    expect(leaked.status).toBe(1);
    expect(leaked.stderr).toContain("parent-context");
    expect(leaked.stderr).toContain("memory");
    expect(leaked.stderr).toContain("instructions");
    const clean = runScript(ISOLATION_SCRIPT, [join(FIXTURES, "clean.json")]);
    expect(clean.status).toBe(0);
    expect(clean.stdout).toContain("pass clean-review");
  });

  test("a missing file or extra argument is a usage error, not a pass", () => {
    expect(runScript(ISOLATION_SCRIPT, [join(FIXTURES, "missing.json")]).status).toBe(2);
    expect(runScript(ISOLATION_SCRIPT, []).status).toBe(2);
    expect(runScript(ISOLATION_SCRIPT, [join(FIXTURES, "clean.json"), "extra"]).status).toBe(2);
  });
});

describe("Cursor T3 qualification (GAP-13)", () => {
  test("cursor evidence has empty trace slots and is not-qualified, not strict", () => {
    const evidence = qualifyT3("cursor");
    expect(evidence).not.toBeNull();
    if (evidence === null) return;
    expect(evidence.host).toBe("cursor");
    expect(evidence.adapter).toBe("adapters/cursor");
    expect(evidence.verdict).toBe("not-qualified");
    expect(evidence.strict).toBe(false);
    expect(evidence.traces.map((slot) => slot.id)).toEqual([...T3_SLOTS]);
    for (const slot of evidence.traces) {
      expect(slot.path).toBeNull();
      expect(slot.sha256).toBeNull();
      expect(slot.recordedAt).toBeNull();
    }
  });

  test("no host id is marked strict and none is qualified without traces", () => {
    for (const host of ["cursor", "claude-code", "codex", "droid", "grok", "kimi"]) {
      const evidence = qualifyT3(host);
      expect(evidence).not.toBeNull();
      if (evidence === null) continue;
      expect(evidence.strict).toBe(false);
      expect(evidence.verdict).toBe("not-qualified");
      expect(
        evidence.traces.every((slot) => slot.path === null && slot.sha256 === null && slot.recordedAt === null),
      ).toBe(true);
    }
  });

  test("the cursor contract still records isolated-review-context as docs-only partial", () => {
    const text = readFileSync(CURSOR_CONTRACT, "utf8");
    expect(text).toContain("| `isolated-review-context` | `partial` |");
    expect(text).toContain("Docs only, not session-tested");
    expect(text.includes("| `isolated-review-context` | `satisfied` |")).toBe(false);
  });

  test("t3-qualify.sh writes the empty cursor template and refuses a path-like host", () => {
    const cursor = runScript(T3_SCRIPT, ["cursor"]);
    expect(cursor.status).toBe(0);
    expect(cursor.stdout).toContain('"host": "cursor"');
    expect(cursor.stdout).toContain('"verdict": "not-qualified"');
    expect(cursor.stdout).toContain('"strict": false');
    expect(cursor.stdout).toContain('"id": "discovery"');
    expect(cursor.stdout).toContain('"id": "slash"');
    expect(cursor.stdout).toContain('"id": "readonly"');
    expect(cursor.stdout).toContain('"id": "isolation"');
    expect(cursor.stdout).toContain('"path": null');
    expect(cursor.stdout).toContain('"sha256": null');
    expect(cursor.stdout).toContain('"recordedAt": null');
    expect(runScript(T3_SCRIPT, ["adapters/cursor"]).status).toBe(2);
    expect(runScript(T3_SCRIPT, []).status).toBe(2);
  });
});
