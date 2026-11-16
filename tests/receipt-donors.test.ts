import { describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

import { runCli } from "../src/cli.ts";
import { runValidation } from "../src/validation/run.ts";
import { skippedChecks } from "../src/validation/types.ts";
import { processScratch } from "./helpers/process-tmp.ts";

const ROOT = join(import.meta.dir, "..");
const HOOK = join(ROOT, "tools/hooks/pre-push");
const EXTRACT = join(ROOT, "tools/hooks/pre-push-extract.sh");
const donorsRequired = process.env.AK_REQUIRE_DONORS === "1";
const donorsPresent = existsSync(join(ROOT, ".donors"));
const ZERO_SHA = "0".repeat(40);

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
  if (typeof d.path !== "string" || typeof d.commit !== "string") process.exit(1);
  console.log(d.path + "\\t" + d.commit);
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

function gitEnv(extra: Record<string, string> = {}) {
  const base = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  return { ...base, PATH: process.env.PATH ?? "/usr/bin:/bin", ...extra };
}

function sourceExtract(body: string, cwd = ROOT, path = process.env.PATH ?? "/usr/bin:/bin") {
  return spawnSync("sh", ["-c", `. "$EXTRACT"; ${body}`], {
    cwd,
    encoding: "utf8",
    env: gitEnv({ EXTRACT, PATH: path }),
  });
}

function runHook(stdin: string, extraEnv: Record<string, string> = {}, cwd = ROOT) {
  return spawnSync("sh", [HOOK], {
    cwd,
    encoding: "utf8",
    input: stdin,
    env: gitEnv(extraEnv),
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
  return { status, line, lines };
}

describe("CI clones donors before it validates", () => {
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
      const prepared = sourceExtract(`extract_for_gate "${sha}" "${dest}" "${ROOT}"`);
      expect(prepared.status, prepared.stderr).toBe(0);
      expect(prepared.stderr).toContain("pre-push: pin check will run");
      expect(existsSync(join(dest, ".donors"))).toBe(true);
      symlinkSync(join(ROOT, "node_modules"), join(dest, "node_modules"));
      const summary = summaryOf(dest);
      expect(summary.status, summary.lines.join("\n")).toBe(0);
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
    const prepared = sourceExtract(`extract_for_gate "${sha}" "${dest}" "${scratch}"`);
    expect(prepared.status, prepared.stderr).toBe(0);
    expect(prepared.stderr).toContain("pre-push: pin check will run");
    expect(existsSync(join(dest, ".donors/donor_one/.git"))).toBe(true);
  });

  test("the pin check reads the extract lock, not the working-tree lock", () => {
    const scratch = processScratch("ak-extract-lock-disagree-");
    mkdirSync(join(scratch, "provenance"), { recursive: true });
    const commit = makeDonorClone(join(scratch, ".donors/donor_one"));
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
    writeFileSync(join(scratch, "README.md"), "scratch\n");
    writeFileSync(join(scratch, ".gitignore"), ".donors\n");
    const sha = seedRepo(scratch);
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
    const dest = processScratch("ak-extract-lock-disagree-dest-");
    const prepared = sourceExtract(`extract_for_gate "${sha}" "${dest}" "${scratch}"`);
    expect(prepared.status, prepared.stderr).toBe(0);
    expect(prepared.stderr).toContain(
      "pre-push: warning: pin check skipped because the local donors are not at the lock pins",
    );
    expect(prepared.stderr).not.toContain("pin check will run");
    expect(existsSync(join(dest, ".donors"))).toBe(false);
  });

  test("a mixed pin set is not copied and the gate warns", () => {
    const scratch = processScratch("ak-extract-mixed-");
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
  - id: donor-two
    path: .donors/donor_two
    commit: ${"b".repeat(40)}
    license: MIT
`,
    );
    writeFileSync(join(scratch, "README.md"), "scratch\n");
    writeFileSync(join(scratch, ".gitignore"), ".donors\n");
    const sha = seedRepo(scratch);
    const dest = processScratch("ak-extract-mixed-dest-");
    const prepared = sourceExtract(`extract_for_gate "${sha}" "${dest}" "${scratch}"`);
    expect(prepared.status, prepared.stderr).toBe(0);
    expect(prepared.stderr).toContain(
      "pre-push: warning: pin check skipped because the local donors are not at the lock pins",
    );
    expect(existsSync(join(dest, ".donors"))).toBe(false);
  });

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
    const prepared = sourceExtract(`extract_for_gate "${sha}" "${dest}" "${scratch}"`);
    expect(prepared.status, prepared.stderr).toBe(0);
    expect(prepared.stderr).toContain(
      "pre-push: warning: pin check skipped because the local donors are not at the lock pins",
    );
    expect(existsSync(join(dest, ".donors"))).toBe(false);
  });

  test("a missing .donors prints a skip note", () => {
    const scratch = processScratch("ak-extract-absent-");
    writeFileSync(join(scratch, "README.md"), "scratch\n");
    const sha = seedRepo(scratch);
    const dest = processScratch("ak-extract-absent-dest-");
    const prepared = sourceExtract(`extract_for_gate "${sha}" "${dest}" "${scratch}"`);
    expect(prepared.status, prepared.stderr).toBe(0);
    expect(prepared.stderr).toContain("pre-push: pin check skipped (.donors absent)");
    expect(prepared.stderr).not.toContain("not at the lock pins");
    expect(existsSync(join(dest, ".donors"))).toBe(false);
  });

  test("a lock-read failure names that cause", () => {
    const scratch = processScratch("ak-extract-lock-");
    mkdirSync(join(scratch, ".donors/donor_one"), { recursive: true });
    writeFileSync(join(scratch, "README.md"), "scratch\n");
    const sha = seedRepo(scratch);
    const dest = processScratch("ak-extract-lock-dest-");
    const prepared = sourceExtract(`extract_for_gate "${sha}" "${dest}" "${scratch}"`);
    expect(prepared.status, prepared.stderr).toBe(0);
    expect(prepared.stderr).toContain("pre-push: warning: pin check skipped because the lock file could not be read");
    expect(prepared.stderr).not.toContain("not at the lock pins");
    expect(existsSync(join(dest, ".donors"))).toBe(false);
  });

  test("a lock row whose commit is not a string is a lock-read failure", () => {
    const scratch = processScratch("ak-extract-lock-nonstr-");
    mkdirSync(join(scratch, "provenance"), { recursive: true });
    mkdirSync(join(scratch, ".donors/donor_one"), { recursive: true });
    writeFileSync(
      join(scratch, "provenance/upstream.lock.yaml"),
      `schema_version: 1
donors:
  - id: donor-one
    path: .donors/donor_one
    commit: 1
    license: MIT
`,
    );
    writeFileSync(join(scratch, "README.md"), "scratch\n");
    const sha = seedRepo(scratch);
    const dest = processScratch("ak-extract-lock-nonstr-dest-");
    const prepared = sourceExtract(`extract_for_gate "${sha}" "${dest}" "${scratch}"`);
    expect(prepared.status, prepared.stderr).toBe(0);
    expect(prepared.stderr).toContain("pre-push: warning: pin check skipped because the lock file could not be read");
    expect(existsSync(join(dest, ".donors"))).toBe(false);
  });

  test("a lock with zero donors is not a lock-read failure", () => {
    const scratch = processScratch("ak-extract-lock-empty-");
    mkdirSync(join(scratch, "provenance"), { recursive: true });
    makeDonorClone(join(scratch, ".donors/donor_one"));
    writeFileSync(
      join(scratch, "provenance/upstream.lock.yaml"),
      `schema_version: 1
donors: []
`,
    );
    writeFileSync(join(scratch, "README.md"), "scratch\n");
    writeFileSync(join(scratch, ".gitignore"), ".donors\n");
    const sha = seedRepo(scratch);
    const dest = processScratch("ak-extract-lock-empty-dest-");
    const prepared = sourceExtract(`extract_for_gate "${sha}" "${dest}" "${scratch}"`);
    expect(prepared.status, prepared.stderr).toBe(0);
    expect(prepared.stderr).not.toContain("lock file could not be read");
    expect(prepared.stderr).toContain("pre-push: pin check will run");
    expect(existsSync(join(dest, ".donors/donor_one/.git"))).toBe(true);
  });

  test("a stale pin in a partial clone does not fetch from a live origin", () => {
    const scratch = processScratch("ak-extract-lazy-");
    mkdirSync(join(scratch, "provenance"), { recursive: true });
    const origin = processScratch("ak-extract-lazy-origin-");
    makeDonorClone(origin);
    git(origin, "config", "uploadpack.allowFilter", "true");
    git(origin, "config", "uploadpack.allowAnySHA1InWant", "true");
    const clone = join(scratch, ".donors/donor_one");
    const cloned = spawnSync("git", ["clone", "-q", "--filter=blob:none", "--no-local", origin, clone], {
      encoding: "utf8",
      env: gitEnv(),
    });
    expect(cloned.status, cloned.stderr).toBe(0);
    writeFileSync(join(origin, "later.md"), "later\n");
    git(origin, "add", "-A");
    git(origin, "commit", "-q", "-m", "later");
    const pin = git(origin, "rev-parse", "HEAD").trim();
    const marker = join(scratch, "upload-pack.mark");
    const wrapper = join(scratch, "git-upload-pack-wrap");
    writeFileSync(
      wrapper,
      `#!/bin/sh
printf 'fetched\\n' > "${marker}"
exec git upload-pack "$@"
`,
      { mode: 0o755 },
    );
    git(clone, "config", "remote.origin.uploadpack", wrapper);
    writeFileSync(
      join(scratch, "provenance/upstream.lock.yaml"),
      `schema_version: 1
donors:
  - id: donor-one
    path: .donors/donor_one
    commit: ${pin}
    license: MIT
`,
    );
    writeFileSync(join(scratch, "README.md"), "scratch\n");
    writeFileSync(join(scratch, ".gitignore"), ".donors\n");
    const sha = seedRepo(scratch);
    const dest = processScratch("ak-extract-lazy-dest-");
    const prepared = sourceExtract(`extract_for_gate "${sha}" "${dest}" "${scratch}"`);
    expect(prepared.status, prepared.stderr).toBe(0);
    expect(prepared.stderr).toContain(
      "pre-push: warning: pin check skipped because the local donors are not at the lock pins",
    );
    expect(existsSync(join(dest, ".donors"))).toBe(false);
    expect(existsSync(marker)).toBe(false);
    const stillMissing = spawnSync("git", ["-C", clone, "cat-file", "-e", `${pin}^{commit}`], {
      encoding: "utf8",
      env: gitEnv({ GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0" }),
    });
    expect(stillMissing.status).not.toBe(0);
  }, 15_000);

  test("a copy failure warns, strips a partial .donors, and still returns 0", () => {
    const scratch = processScratch("ak-extract-copyfail-");
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
    const dest = processScratch("ak-extract-copyfail-dest-");
    const bin = processScratch("ak-cp-fail-");
    writeFileSync(join(bin, "cp"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    const path = `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`;
    const prepared = sourceExtract(`extract_for_gate "${sha}" "${dest}" "${scratch}"`, ROOT, path);
    expect(prepared.status, prepared.stderr).toBe(0);
    expect(prepared.stderr).toContain("pre-push: warning: pin check skipped because .donors could not be copied");
    expect(existsSync(join(dest, ".donors"))).toBe(false);
  }, 60_000);
});

describe("pre-push refusals", () => {
  test("the hook refuses a HEAD main push", () => {
    const scratch = processScratch("ak-hook-refuse-");
    writeFileSync(join(scratch, "README.md"), "scratch\n");
    const sha = seedRepo(scratch);
    const run = runHook(`HEAD ${sha} refs/heads/main ${ZERO_SHA}\n`, {}, scratch);
    expect(run.status, run.stderr).toBe(1);
    expect(run.stderr).toContain("pre-push: refusing to publish main through 'HEAD'");
  });

  test("a hook copied into .git/hooks refuses HEAD:main and admits a feature branch", () => {
    const scratch = processScratch("ak-hook-copied-");
    mkdirSync(join(scratch, "node_modules"));
    writeFileSync(join(scratch, "README.md"), "scratch\n");
    const sha = seedRepo(scratch);
    const installed = join(scratch, ".git/hooks/pre-push");
    writeFileSync(installed, readFileSync(HOOK, "utf8"), { mode: 0o755 });
    const mark = join(scratch, "ak-build.mark");
    const bin = processScratch("ak-hook-copied-bin-");
    writeFileSync(
      join(bin, "bun"),
      `#!/bin/sh
if [ "$1" = "run" ] && [ "$2" = "ak" ]; then
  printf 'ran\\n' > "$HOOK_MARK"
  exit 1
fi
exit 0
`,
      { mode: 0o755 },
    );
    const env = gitEnv({
      HOOK_MARK: mark,
      PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    });
    const refuse = spawnSync("/bin/sh", [installed], {
      cwd: scratch,
      encoding: "utf8",
      input: `HEAD ${sha} refs/heads/main ${ZERO_SHA}\n`,
      env,
    });
    expect(refuse.status, refuse.stderr).toBe(1);
    expect(refuse.stderr).toContain("pre-push: refusing to publish main through 'HEAD'");
    const admit = spawnSync("/bin/sh", [installed], {
      cwd: scratch,
      encoding: "utf8",
      input: `HEAD ${sha} refs/heads/feat ${ZERO_SHA}\n`,
      env,
    });
    expect(admit.status, admit.stderr).toBe(0);
    expect(admit.stderr).not.toContain("refusing to publish");
    const tag = spawnSync("/bin/sh", [installed], {
      cwd: scratch,
      encoding: "utf8",
      input: `refs/tags/v0 ${sha} refs/heads/main ${ZERO_SHA}\n`,
      env,
    });
    expect(tag.status, tag.stderr).toBe(1);
    expect(tag.stderr).toContain("pre-push: warning: tools/hooks/pre-push-extract.sh is missing; pin check skipped");
    expect(readFileSync(mark, "utf8").trim()).toBe("ran");
  });

  test("the hook clears GIT_DIR before the build", () => {
    const main = processScratch("ak-wt-main-");
    mkdirSync(join(main, "provenance"), { recursive: true });
    mkdirSync(join(main, "tools/hooks"), { recursive: true });
    const commit = makeDonorClone(join(main, ".donors/donor_one"));
    writeFileSync(
      join(main, "provenance/upstream.lock.yaml"),
      `schema_version: 1
donors:
  - id: donor-one
    path: .donors/donor_one
    commit: ${commit}
    license: MIT
`,
    );
    writeFileSync(join(main, "package.json"), '{"scripts":{"ak":"true"}}\n');
    writeFileSync(join(main, "README.md"), "scratch\n");
    writeFileSync(join(main, ".gitignore"), ".donors\n");
    writeFileSync(join(main, "tools/hooks/pre-push-extract.sh"), readFileSync(EXTRACT, "utf8"));
    const sha = seedRepo(main);
    const wt = processScratch("ak-wt-linked-");
    rmSync(wt, { recursive: true, force: true });
    git(main, "worktree", "add", "-q", "--detach", wt);
    symlinkSync(join(ROOT, "node_modules"), join(wt, "node_modules"));
    const copied = spawnSync("cp", ["-R", join(main, ".donors"), join(wt, ".donors")], { encoding: "utf8" });
    expect(copied.status, copied.stderr).toBe(0);
    const installed = join(main, ".git/hooks/pre-push");
    writeFileSync(installed, readFileSync(HOOK, "utf8"), { mode: 0o755 });
    const mark = join(wt, "ak-build.mark");
    const bunBin = process.execPath;
    const bin = processScratch("ak-wt-bin-");
    writeFileSync(
      join(bin, "bun"),
      `#!/bin/sh
if [ "$1" = "run" ] && [ "$2" = "ak" ]; then
  printf 'GIT_DIR=%s\\nGIT_NO_LAZY_FETCH=%s\\nGIT_TERMINAL_PROMPT=%s\\n' "\${GIT_DIR-}" "\${GIT_NO_LAZY_FETCH-}" "\${GIT_TERMINAL_PROMPT-}" > "$HOOK_MARK"
  exit 0
fi
exec "${bunBin}" "$@"
`,
      { mode: 0o755 },
    );
    const gitDir = git(wt, "rev-parse", "--absolute-git-dir").trim();
    const workTree = git(wt, "rev-parse", "--show-toplevel").trim();
    const run = spawnSync("/bin/sh", [installed], {
      cwd: wt,
      encoding: "utf8",
      input: `refs/tags/v0 ${sha} refs/heads/main ${ZERO_SHA}\n`,
      env: {
        ...process.env,
        GIT_DIR: gitDir,
        GIT_WORK_TREE: workTree,
        GIT_INDEX_FILE: join(gitDir, "index"),
        HOOK_MARK: mark,
        PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      },
    });
    expect(run.status, run.stderr).toBe(0);
    expect(run.stderr).toContain("pre-push: pin check will run");
    expect(readFileSync(mark, "utf8").trim()).toBe("GIT_DIR=\nGIT_NO_LAZY_FETCH=1\nGIT_TERMINAL_PROMPT=0");
  }, 60_000);

  test("a separate git dir with GIT_DIR exported still refuses a failing build", () => {
    const scratch = processScratch("ak-sep-work-");
    mkdirSync(join(scratch, "node_modules"));
    mkdirSync(join(scratch, "tools/hooks"), { recursive: true });
    writeFileSync(join(scratch, "package.json"), '{"scripts":{"ak":"true"}}\n');
    writeFileSync(join(scratch, "README.md"), "scratch\n");
    writeFileSync(join(scratch, "tools/hooks/pre-push-extract.sh"), readFileSync(EXTRACT, "utf8"));
    const sha = seedRepo(scratch);
    const gitDir = processScratch("ak-sep-git-");
    rmSync(gitDir, { recursive: true, force: true });
    renameSync(join(scratch, ".git"), gitDir);
    mkdirSync(join(gitDir, "hooks"), { recursive: true });
    const installed = join(gitDir, "hooks/pre-push");
    writeFileSync(installed, readFileSync(HOOK, "utf8"), { mode: 0o755 });
    const mark = join(scratch, "ak-build.mark");
    const bin = processScratch("ak-sep-bin-");
    writeFileSync(
      join(bin, "bun"),
      `#!/bin/sh
if [ "$1" = "run" ] && [ "$2" = "ak" ]; then
  printf 'ran\\n' > "$HOOK_MARK"
  exit 1
fi
exit 0
`,
      { mode: 0o755 },
    );
    const run = spawnSync("/bin/sh", [installed], {
      cwd: scratch,
      encoding: "utf8",
      input: `refs/tags/v0 ${sha} refs/heads/main ${ZERO_SHA}\n`,
      env: {
        ...process.env,
        GIT_DIR: gitDir,
        GIT_WORK_TREE: scratch,
        HOOK_MARK: mark,
        PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      },
    });
    expect(run.status, run.stderr).toBe(1);
    expect(run.stderr).toContain("pre-push: refusing to publish");
    expect(readFileSync(mark, "utf8").trim()).toBe("ran");
  }, 60_000);

  test("a failed donor copy still runs ak build", () => {
    const scratch = processScratch("ak-hook-copyfail-");
    mkdirSync(join(scratch, "provenance"), { recursive: true });
    mkdirSync(join(scratch, "node_modules"));
    const commit = makeDonorClone(join(scratch, ".donors/donor_one"));
    const mark = join(scratch, "ak-build.mark");
    const bunBin = process.execPath;
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
    writeFileSync(join(scratch, "package.json"), '{"scripts":{"ak":"true"}}\n');
    writeFileSync(join(scratch, "README.md"), "scratch\n");
    writeFileSync(join(scratch, ".gitignore"), ".donors\n");
    mkdirSync(join(scratch, "tools/hooks"), { recursive: true });
    writeFileSync(join(scratch, "tools/hooks/pre-push-extract.sh"), readFileSync(EXTRACT, "utf8"));
    const sha = seedRepo(scratch);
    const bin = processScratch("ak-hook-stubs-");
    writeFileSync(join(bin, "cp"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    writeFileSync(
      join(bin, "bun"),
      `#!/bin/sh
for a in "$@"; do
  if [ "$a" = "--eval" ]; then
    cd "${ROOT}" || exit 1
    exec "${bunBin}" "$@"
  fi
done
if [ "$1" = "run" ] && [ "$2" = "ak" ]; then
  printf 'ran\\n' > "$HOOK_MARK"
  exit 0
fi
exec "${bunBin}" "$@"
`,
      { mode: 0o755 },
    );
    const run = runHook(
      `refs/tags/v0 ${sha} refs/heads/main ${ZERO_SHA}\n`,
      {
        HOOK_MARK: mark,
        PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      },
      scratch,
    );
    expect(run.status, run.stderr).toBe(0);
    expect(run.stderr).toContain("pre-push: warning: pin check skipped because .donors could not be copied");
    expect(readFileSync(mark, "utf8").trim()).toBe("ran");
  }, 60_000);
});

describe("provenance pin check skip count", () => {
  test("a raw git archive extract shows the donor-paths skip", () => {
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
