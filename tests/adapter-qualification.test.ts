import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { isAdapterHost, qualifyT3, T3_SLOTS } from "../src/adapter-qualification/t3.ts";
import { HOST_IDS } from "../src/packaging/hosts.ts";
import { processScratch } from "./helpers/process-tmp.ts";

const REPO = resolve(import.meta.dir, "..");
const T3_SCRIPT = join(REPO, "scripts/t3-qualify.sh");
const CURSOR_CONTRACT = join(REPO, "adapters/cursor/CONTRACT.md");

function scriptEnv(): NodeJS.ProcessEnv {
  const bunDir = dirname(process.execPath);
  const path = `${bunDir}:${process.env["PATH"] ?? ""}`;
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

describe("Cursor T3 qualification (GAP-13)", () => {
  test("t3-qualify.sh writes empty cursor slots and refuses a host that is not an adapters directory", () => {
    expect(existsSync(join(REPO, "adapters/cursor"))).toBe(true);
    expect(existsSync(join(REPO, "adapters/foo"))).toBe(false);
    const cursor = runScript(T3_SCRIPT, ["cursor"]);
    expect(cursor.status).toBe(0);
    expect(cursor.stdout).toContain('"host": "cursor"');
    expect(cursor.stdout).toContain('"adapter": "adapters/cursor"');
    expect(cursor.stdout).toContain('"id": "discovery"');
    expect(cursor.stdout).toContain('"id": "slash"');
    expect(cursor.stdout).toContain('"id": "readonly"');
    expect(cursor.stdout).toContain('"id": "isolation"');
    expect(cursor.stdout).toContain('"path": null');
    expect(cursor.stdout).toContain('"sha256": null');
    expect(cursor.stdout).toContain('"recordedAt": null');
    expect(cursor.stdout).toContain('"kind": "t3-evidence-template"');
    expect(cursor.stdout).toContain('"verdict": "not-qualified"');
    expect(cursor.stdout).toContain('"strict": false');
    const refused = [
      ["foo"],
      ["adapters/cursor"],
      ["tracker"],
      [],
      ["../cursor"],
      ["CURSOR"],
      ["cursor/"],
      ["--help", "extra"],
      ["--bogus"],
    ] as const;
    for (const args of refused) {
      const r = runScript(T3_SCRIPT, args);
      expect(r.status).toBe(2);
      expect(r.stdout).toBe("");
    }
    const unknown = runScript(T3_SCRIPT, ["foo"]);
    expect(unknown.stderr).toContain("adapters/");
    expect(unknown.stderr).toContain(JSON.stringify("foo"));
    const help = runScript(T3_SCRIPT, ["--help"]);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("t3-qualify:");
  });

  test("qualifyT3 refuses a host id that is not a directory under adapters/", () => {
    expect(isAdapterHost("cursor")).toBe(true);
    expect(isAdapterHost("foo")).toBe(false);
    expect(existsSync(join(REPO, "adapters/tracker"))).toBe(true);
    expect(isAdapterHost("tracker")).toBe(false);
    expect(qualifyT3("foo")).toBeNull();
    expect(qualifyT3("tracker")).toBeNull();
    expect(qualifyT3("adapters/cursor")).toBeNull();
    expect(qualifyT3("cursor")).not.toBeNull();
    const empty = processScratch("ak-t3-no-cursor-");
    expect(isAdapterHost("cursor", empty)).toBe(false);
    expect(qualifyT3("cursor", empty)).toBeNull();
  });

  test("qualifyT3 writes empty not-qualified slots for every packaging host", () => {
    for (const id of HOST_IDS) {
      const evidence = qualifyT3(id);
      expect(evidence).not.toBeNull();
      if (evidence === null) throw new Error(`expected T3 evidence for ${id}`);
      expect(evidence.host).toBe(id);
      expect(evidence.adapter).toBe(`adapters/${id}`);
      expect(evidence.traces.map((slot) => slot.id)).toEqual([...T3_SLOTS]);
      for (const slot of evidence.traces) {
        expect(slot.path).toBeNull();
        expect(slot.sha256).toBeNull();
        expect(slot.recordedAt).toBeNull();
      }
      expect(evidence.kind).toBe("t3-evidence-template");
      expect(evidence.verdict).toBe("not-qualified");
      expect(evidence.strict).toBe(false);
    }
  });

  test("the cursor contract still records isolated-review-context as docs-only partial", () => {
    const text = readFileSync(CURSOR_CONTRACT, "utf8");
    expect(text).toContain("| `isolated-review-context` | `partial` |");
    expect(text).toContain("Docs only, not session-tested");
    expect(text.includes("| `isolated-review-context` | `satisfied` |")).toBe(false);
  });
});
