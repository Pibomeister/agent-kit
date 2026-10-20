import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";

import { scratch, startScratch } from "./learn/helpers.ts";
import { processDir, processScratch, processTmpParent } from "./helpers/process-tmp.ts";
import { makeTree, materializeFixture } from "./helpers/tree.ts";

const REPO = join(import.meta.dir, "..");

function inside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !rel.startsWith(sep);
}

describe("process temp directory", () => {
  test("is created under /tmp on macOS and under os.tmpdir() elsewhere", () => {
    expect(processTmpParent("darwin")).toBe("/tmp");
    expect(processTmpParent("linux")).toBe(tmpdir());
    expect(dirname(processDir())).toBe(realpathSync(processTmpParent()));
    if (process.platform === "darwin") expect(dirname(processDir())).toBe(realpathSync("/tmp"));
  });

  test("makeTree, materializeFixture, scratch, startScratch and processScratch return paths inside it", () => {
    const paths = [
      makeTree({ "a.txt": "a\n" }),
      materializeFixture("valid/minimal"),
      scratch(),
      scratch("ak-home-"),
      scratch("ak-pkg-"),
      startScratch(),
      processScratch("ak-probe-"),
    ];
    for (const path of paths) expect(inside(processDir(), path)).toBe(true);
    expect(new Set(paths).size).toBe(paths.length);
  });

  test("the preload's config roots sit inside it", () => {
    for (const key of ["CLAUDE_CONFIG_DIR", "CLAUDE_MEM_DATA_DIR", "CODEX_HOME"]) {
      expect(inside(processDir(), process.env[key] ?? "")).toBe(true);
    }
  });

  test("is removed when the process exits normally, with its fixtures", () => {
    const script = [
      `import { processDir } from ${JSON.stringify(join(REPO, "tests/helpers/process-tmp.ts"))};`,
      `import { makeTree } from ${JSON.stringify(join(REPO, "tests/helpers/tree.ts"))};`,
      `const tree = makeTree({ "a.txt": "a" });`,
      `console.log(processDir());`,
      `console.log(tree);`,
    ].join("\n");
    const child = Bun.spawnSync([process.execPath, "-e", script], { cwd: REPO });
    expect(child.exitCode).toBe(0);
    const [dir = "", tree = ""] = child.stdout.toString().trim().split("\n");
    expect(dir).not.toBe(processDir());
    expect(inside(dir, tree)).toBe(true);
    expect(existsSync(tree)).toBe(false);
    expect(existsSync(dir)).toBe(false);
  });

  test.each([false, true])("is removed when the Bun test runner finishes (failing test: %s)", (failing) => {
    const file = join(processScratch("ak-runner-"), "cleanup.test.ts");
    const script = [
      `import { afterAll, test, expect } from "bun:test";`,
      `import { existsSync } from "node:fs";`,
      `import { processDir } from ${JSON.stringify(join(REPO, "tests/helpers/process-tmp.ts"))};`,
      `afterAll(() => expect(existsSync(processDir())).toBe(true));`,
      `test("fixture exists during the test", () => {`,
      `  console.log("PROCESS_DIR " + processDir());`,
      `  expect(existsSync(processDir())).toBe(true);`,
      `  expect(${!failing}).toBe(true);`,
      `});`,
    ].join("\n");
    writeFileSync(file, script);
    const child = Bun.spawnSync([process.execPath, "test", file], { cwd: REPO });
    expect(child.exitCode).toBe(failing ? 1 : 0);
    const line = child.stdout
      .toString()
      .split("\n")
      .find((value) => value.startsWith("PROCESS_DIR "));
    expect(line).toBeDefined();
    const dir = line?.slice("PROCESS_DIR ".length) ?? "";
    expect(dir).not.toBe(processDir());
    try {
      expect(existsSync(dir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// Outside the lifecycle and Firstmate trees, which keep their own fixtures for now, every test,
// eval harness and budget tool directory is made through the helper above.
// The eval subject repositories under evals/**/_fixtures/ are copied into each run's own
// workspace and cannot import the helper. The search reads tracked source, never a temp directory.
const SHARED_PARENT = /mkdtemp(?:Sync)?\(\s*(?:(?:path\.)?join\(\s*)?(?:(?:os\.)?tmpdir\(\)|["'`]\/tmp["'`])/;
const EXEMPT = /^(?:tests\/lifecycle\/|tests\/firstmate\/|evals\/.*\/_fixtures\/|tests\/helpers\/process-tmp\.ts$)/;

function sharedParentSites(): string[] {
  const listed = Bun.spawnSync(["git", "ls-files", "--", "tests", "evals", "tools/budget"], { cwd: REPO });
  const files = listed.stdout
    .toString()
    .split("\n")
    .filter((file) => /\.(?:[cm]?[jt]s)$/.test(file) && !EXEMPT.test(file));
  return files.flatMap((file) =>
    readFileSync(join(REPO, file), "utf8")
      .split("\n")
      .flatMap((line, i) => (SHARED_PARENT.test(line) ? [`${file}:${i + 1}`] : [])),
  );
}

describe("test call sites", () => {
  test("the search recognises a mkdtemp in the shared temp directory", () => {
    // Spelled in pieces so this file's own source does not match the search below.
    const make = "mkdtemp";
    for (const line of [
      `${make}Sync(join(tmpdir(), "ak-x-"))`,
      `fs.${make}Sync(path.join(os.tmpdir(), 'x-'))`,
      `${make}Sync(join("/tmp", "ak-x-"))`,
      `await ${make}(tmpdir())`,
    ])
      expect(SHARED_PARENT.test(line)).toBe(true);
    expect(SHARED_PARENT.test('processScratch("ak-x-")')).toBe(false);
  });

  test("outside lifecycle and Firstmate, none makes a temp directory in the shared parent", () => {
    expect(sharedParentSites()).toEqual([]);
  });
});
