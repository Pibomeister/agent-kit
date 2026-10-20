import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, realpathSync } from "node:fs";
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

  test("the helpers create fixtures only through it and never list the shared temp directory", () => {
    const files = ["tests/preload.ts", "tests/helpers/tree.ts", "tests/learn/helpers.ts"];
    for (const file of files) {
      const source = readFileSync(join(REPO, file), "utf8");
      const importsTmpdir = /import\s*\{[^}]*\btmpdir\b[^}]*\}\s*from\s*"node:os"/.test(source);
      expect({ file, importsTmpdir }).toEqual({ file, importsTmpdir: false });
      expect({ file, slashTmp: source.includes('"/tmp"') }).toEqual({ file, slashTmp: false });
    }
    const helper = readFileSync(join(REPO, "tests/helpers/process-tmp.ts"), "utf8");
    expect(helper).not.toMatch(/readdir|opendir|glob/i);
  });
});
