import { describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

import { runCli } from "../src/cli.ts";
import { runValidation } from "../src/validation/run.ts";
import { skippedChecks } from "../src/validation/types.ts";
import { processScratch } from "./helpers/process-tmp.ts";

const ROOT = join(import.meta.dir, "..");
const HOOK = join(ROOT, "tools/hooks/pre-push");
const donorsRequired = process.env.AK_REQUIRE_DONORS === "1";
const donorsPresent = existsSync(join(ROOT, ".donors"));

type CiStep = { run?: string };
type CiWorkflow = { jobs?: { check?: { steps?: CiStep[] } } };

function isCiWorkflow(value: unknown): value is CiWorkflow {
  return value instanceof Object && !Array.isArray(value);
}

function lockPinRows(root: string): Array<{ path: string; commit: string }> {
  const run = spawnSync(
    "bun",
    [
      "--eval",
      `import { readFileSync } from "node:fs";
import { parse } from "yaml";
for (const d of parse(readFileSync(process.env.AK_LOCK, "utf8")).donors ?? []) {
  if (typeof d.path === "string" && typeof d.commit === "string") console.log(d.path + "\\t" + d.commit);
}`,
    ],
    {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, AK_LOCK: join(root, "provenance/upstream.lock.yaml") },
    },
  );
  expect(run.status, run.stderr).toBe(0);
  const rows: Array<{ path: string; commit: string }> = [];
  for (const line of run.stdout.split("\n")) {
    if (line === "") continue;
    const tab = line.indexOf("\t");
    expect(tab).toBeGreaterThan(0);
    rows.push({ path: line.slice(0, tab), commit: line.slice(tab + 1) });
  }
  return rows;
}

function sourceHook(body: string, cwd = ROOT) {
  return spawnSync("sh", ["-c", `AK_PREPUSH_SOURCE=1; . "$HOOK"; ${body}`], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      AK_PREPUSH_SOURCE: "1",
      HOOK,
      PATH: process.env.PATH ?? "/usr/bin:/bin",
    },
  });
}

function git(dir: string, ...args: string[]): string {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env });
}

function seedRepo(dir: string): string {
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "T");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "seed");
  return git(dir, "rev-parse", "HEAD").trim();
}

function makeDonorClone(dir: string): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "README.md"), "donor\n");
  return seedRepo(dir);
}

function summaryOf(root: string) {
  const lines: string[] = [];
  const status = runCli(["validate"], {
    cwd: root,
    io: { out: (line) => lines.push(line), err: (line) => lines.push(line) },
  });
  const line = lines.filter((entry) => entry.startsWith("ak validate:")).at(-1) ?? "";
  return { status, line };
}

describe("receipt instruments place .donors by copy or clone, never symlink", () => {
  test("CI clones donors before it validates", () => {
    const document: unknown = parseYaml(readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8"));
    expect(isCiWorkflow(document)).toBe(true);
    if (!isCiWorkflow(document)) return;
    const runs = (document.jobs?.check?.steps ?? []).map((step) => step.run);
    const clone = runs.indexOf("tools/donors/clone.sh");
    const validate = runs.indexOf("bun run validate");
    expect(clone).toBeGreaterThanOrEqual(0);
    expect(validate).toBeGreaterThan(clone);
  });
});

describe("pre-push extract_for_gate", () => {
  test.if(donorsPresent || donorsRequired)(
    "an extract with donors at the lock pins has no donor-paths skip",
    () => {
      expect(existsSync(join(ROOT, ".donors"))).toBe(true);
      const dest = processScratch("ak-extract-with-donors-");
      const sha = git(ROOT, "rev-parse", "HEAD").trim();
      const prepared = sourceHook(`extract_for_gate "${sha}" "${dest}" "${ROOT}"`);
      expect(prepared.status, prepared.stderr).toBe(0);
      expect(prepared.stderr).toContain("pre-push: pin check will run");
      expect(existsSync(join(dest, ".donors"))).toBe(true);
      symlinkSync(join(ROOT, "node_modules"), join(dest, "node_modules"));
      const summary = summaryOf(dest);
      expect(summary.status).toBe(0);
      expect(summary.line).not.toContain("donor paths at pin");
      expect(summary.line).toMatch(/0 checks skipped/);
    },
    180_000,
  );

  test("donors at lock pins are copied into the extract", () => {
    const scratch = processScratch("ak-extract-pinned-");
    mkdirSync(join(scratch, "provenance"), { recursive: true });
    const commit = makeDonorClone(join(scratch, ".donors/donor_one"));
    writeFileSync(
      join(scratch, "provenance/upstream.lock.yaml"),
      `schema_version: 1
donors:
  - id: donor-one
    path: .donors/donor_one
    commit: ${commit}
    license: MIT
`,
    );
    writeFileSync(join(scratch, "README.md"), "scratch\n");
    writeFileSync(join(scratch, ".gitignore"), ".donors\n");
    const sha = seedRepo(scratch);
    const dest = processScratch("ak-extract-pinned-dest-");
    const prepared = sourceHook(`extract_for_gate "${sha}" "${dest}" "${scratch}"`);
    expect(prepared.status, prepared.stderr).toBe(0);
    expect(prepared.stderr).toContain("pre-push: pin check will run");
    expect(existsSync(join(dest, ".donors/donor_one/.git"))).toBe(true);
  });

  test("an extract built without .donors shows the donor-paths skip", () => {
    const dest = processScratch("ak-extract-without-donors-");
    const sha = git(ROOT, "rev-parse", "HEAD").trim();
    const archived = spawnSync("sh", ["-c", `git archive "${sha}" | tar -x -C "${dest}"`], {
      cwd: ROOT,
      encoding: "utf8",
    });
    expect(archived.status, archived.stderr).toBe(0);
    expect(existsSync(join(dest, ".donors"))).toBe(false);
    symlinkSync(join(ROOT, "node_modules"), join(dest, "node_modules"));
    const summary = summaryOf(dest);
    expect(summary.line).toContain("donor paths at pin");
  }, 180_000);

  test("unpinned local donors are not copied and the gate warns", () => {
    const scratch = processScratch("ak-extract-unpinned-");
    mkdirSync(join(scratch, "provenance"), { recursive: true });
    writeFileSync(
      join(scratch, "provenance/upstream.lock.yaml"),
      `schema_version: 1
donors:
  - id: donor-one
    path: .donors/donor_one
    commit: ${"a".repeat(40)}
    license: MIT
`,
    );
    mkdirSync(join(scratch, ".donors/donor_one"), { recursive: true });
    writeFileSync(join(scratch, "README.md"), "scratch\n");
    const sha = seedRepo(scratch);
    const dest = processScratch("ak-extract-unpinned-dest-");
    const prepared = sourceHook(`extract_for_gate "${sha}" "${dest}" "${scratch}"`);
    expect(prepared.status, prepared.stderr).toBe(0);
    expect(prepared.stderr).toContain(
      "pre-push: warning: pin check skipped because the local donors are not at the lock pins",
    );
    expect(existsSync(join(dest, ".donors"))).toBe(false);
  });
});

describe("provenance pin check skip count", () => {
  test.if(donorsPresent || donorsRequired)(
    "is 0 when every lock donor is a clone holding its pin",
    () => {
      expect(existsSync(join(ROOT, ".donors"))).toBe(true);
      const donors = lockPinRows(ROOT);
      expect(donors.length).toBeGreaterThan(0);
      for (const donor of donors) {
        expect(existsSync(join(ROOT, donor.path, ".git"))).toBe(true);
        const pin = spawnSync("git", ["-C", join(ROOT, donor.path), "cat-file", "-e", `${donor.commit}^{commit}`]);
        expect(pin.status, pin.stderr?.toString()).toBe(0);
      }
      const result = runValidation(ROOT, { only: ["provenance"] });
      expect(result.issues.some((issue) => issue.rule === "provenance.donors-unavailable")).toBe(false);
      expect(skippedChecks(result.issues)).not.toContain("donor paths at pin");
    },
    120_000,
  );
});
