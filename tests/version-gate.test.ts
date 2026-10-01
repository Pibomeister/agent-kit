import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Ajv from "ajv";
import { parse } from "yaml";

const script = join(import.meta.dir, "../tools/publish/version-gate.sh");
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function bundle(dir: string, version: string, skill: string) {
  mkdirSync(join(dir, "claude-code/.claude-plugin"), { recursive: true });
  writeFileSync(join(dir, "claude-code/.claude-plugin/plugin.json"), JSON.stringify({ name: "ak", version }));
  writeFileSync(join(dir, "claude-code/SKILL.md"), skill);
}

function gate(published: [string, string] | null, built: [string, string], packageVersion = built[0]) {
  const root = mkdtempSync(join(tmpdir(), "ak-version-gate-"));
  roots.push(root);
  writeFileSync(join(root, "package.json"), JSON.stringify({ version: packageVersion }));
  if (published) bundle(join(root, "published"), ...published);
  bundle(join(root, "dist"), ...built);
  return spawnSync("sh", [script, "published", "dist"], { cwd: root, encoding: "utf8" });
}

interface Workflow {
  on: Record<string, { branches?: string[] } | null>;
  jobs: Record<string, { steps: { run?: string }[] }>;
}

const isWorkflow = new Ajv().compile<Workflow>({
  type: "object",
  required: ["on", "jobs"],
  properties: {
    on: { type: "object" },
    jobs: {
      type: "object",
      additionalProperties: {
        type: "object",
        required: ["steps"],
        properties: { steps: { type: "array", items: { type: "object" } } },
      },
    },
  },
});

function workflow(file: string): Workflow {
  const value: unknown = parse(readFileSync(join(import.meta.dir, "../.github/workflows", file), "utf8"));
  if (!isWorkflow(value)) throw new Error(`${file} is not a workflow`);
  return value;
}

describe("bundle version gate", () => {
  test("refuses changed content at the published version", () => {
    const run = gate(["0.1.0", "old"], ["0.1.0", "new"]);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("without a catalog.yaml and package.json version bump");
  });

  test("accepts changed content with a version bump", () => {
    expect(gate(["0.1.0", "old"], ["0.2.0", "new"]).status).toBe(0);
  });

  test("accepts unchanged content at the published version", () => {
    expect(gate(["0.1.0", "same"], ["0.1.0", "same"]).status).toBe(0);
  });

  test("accepts a first publish", () => {
    expect(gate(null, ["0.1.0", "new"]).status).toBe(0);
  });

  test("refuses a catalog bump package.json does not match", () => {
    const run = gate(["0.1.0", "old"], ["0.2.0", "new"], "0.1.0");
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("package.json version 0.1.0 differ");
  });

  test("runs on pull requests and again before publishing", () => {
    const ci = workflow("ci.yml");
    const publish = workflow("publish-bundle.yml");
    expect("pull_request" in ci.on).toBe(true);
    expect(publish.on["push"]?.branches).toEqual(["main"]);
    for (const { jobs } of [ci, publish]) {
      const runs = Object.values(jobs).flatMap((job) => job.steps.map((step) => step.run ?? ""));
      expect(runs.some((run) => run.includes("tools/publish/version-gate.sh"))).toBe(true);
    }
  });
});
