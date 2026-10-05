/**
 * Project discovery from claude-mem tool use: stat-only root resolution,
 * worktree and cache skips, the look-back window, newest sighting wins.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { projectFolderName, registryPath, rootOf } from "../../src/learn/core/paths.ts";
import { discoverProjects, discoverySince, readRegistry, registerRoot } from "../../src/learn/memory/registry.ts";
import { ClaudeMemSource, type CwdRow } from "../../src/learn/sources/claude-mem.ts";
import { MemFixture, projectScratch, removeProjectScratch, scratch, testContext } from "./helpers.ts";

function setup() {
  const dir = scratch();
  const repo = join(projectScratch(), "myrepo");
  mkdirSync(join(repo, "packages", "api"), { recursive: true });
  mkdirSync(join(repo, ".git"));
  const worktree = join(dir, "wt");
  mkdirSync(worktree);
  writeFileSync(join(worktree, ".git"), "gitdir: /elsewhere\n"); // a linked worktree: a file, not a directory
  return { dir, repo, worktree, config: testContext().config };
}

function rows(dir: string, uses: Array<{ project: string; cwd: string; at: number }>, days?: number): CwdRow[] {
  const dbPath = join(dir, "mem.db");
  const mem = new MemFixture(dbPath);
  for (const use of uses) mem.toolUse({ sid: "s", project: use.project, tool: "Bash", cwd: use.cwd, at: use.at });
  mem.close();
  const source = ClaudeMemSource.open(dbPath)!;
  try {
    return source.toolUseCwds(discoverySince(Date.now(), days));
  } finally {
    source.close();
  }
}

afterAll(removeProjectScratch);

describe("registry", () => {
  test("a subdirectory resolves to its root and a worktree suffix is stripped", () => {
    const { dir, repo, config } = setup();
    const registry = discoverProjects(
      config,
      rows(dir, [{ project: "myrepo/some-branch", cwd: join(repo, "packages", "api"), at: Date.now() }]),
    );
    const folder = projectFolderName(repo);
    expect(registry).toEqual({
      [folder]: { root: repo, mem_project: "myrepo", last_seen: registry[folder]!.last_seen },
    });
    expect(readRegistry(config)).toEqual(registry);
  });

  test("plugin caches, scratch space and linked worktrees are skipped", () => {
    const { dir, worktree, config } = setup();
    const now = Date.now();
    const found = rows(dir, [
      { project: "x", cwd: "/Users/x/.claude/plugins/cache/thing", at: now },
      { project: "y", cwd: "/private/tmp/scratch", at: now },
      { project: "z", cwd: worktree, at: now },
    ]);
    expect(discoverProjects(config, found)).toEqual({});
    expect(existsSync(registryPath(config))).toBe(false);
  });

  test("rows outside the window are ignored", () => {
    const { dir, repo, config } = setup();
    expect(
      discoverProjects(config, rows(dir, [{ project: "myrepo", cwd: repo, at: Date.now() - 20 * 86_400_000 }], 14)),
    ).toEqual({});
  });

  test("the newest sighting wins over an older registry entry", () => {
    const { repo, config } = setup();
    registerRoot(config, repo, 5);
    const registry = discoverProjects(config, [{ project: "myrepo", cwd: repo, last_seen: 10 }]);
    expect(registry[projectFolderName(repo)]!.last_seen).toBe(10);
    expect(
      discoverProjects(config, [{ project: "myrepo", cwd: repo, last_seen: 7 }])[projectFolderName(repo)]!.last_seen,
    ).toBe(10);
  });

  test("two roots for one claude-mem project leave one active entry and warn", () => {
    const { config } = setup();
    const older = join(projectScratch(), "older", "shop");
    const newer = join(projectScratch(), "newer", "shop");
    for (const root of [older, newer]) mkdirSync(join(root, ".git"), { recursive: true });
    const warnings: string[] = [];
    const registry = discoverProjects(
      config,
      [
        { project: "shop", cwd: older, last_seen: 10 },
        { project: "shop", cwd: newer, last_seen: 20 },
      ],
      (warning) => warnings.push(warning),
    );
    expect(Object.values(registry)).toEqual([{ root: newer, mem_project: "shop", last_seen: 20 }]);
    expect(warnings).toEqual([
      `registry warning: claude-mem project 'shop' has multiple roots; keeping ${newer}, unregistering ${older}`,
    ]);
  });

  test("bare repositories and no-mistakes repository copies are never registered", () => {
    const { config } = setup();
    const bare = join(projectScratch(), "bare.git");
    mkdirSync(join(bare, "objects"), { recursive: true });
    writeFileSync(join(bare, "HEAD"), "ref: refs/heads/main\n");
    const noMistakes = join(projectScratch(), ".no-mistakes", "repos", "copy");
    mkdirSync(join(noMistakes, ".git"), { recursive: true });

    expect(registerRoot(config, bare)).toEqual({});
    expect(registerRoot(config, noMistakes)).toEqual({});
    expect(
      discoverProjects(config, [
        { project: "bare", cwd: bare, last_seen: 10 },
        { project: "copy", cwd: noMistakes, last_seen: 20 },
      ]),
    ).toEqual({});
    expect(existsSync(registryPath(config))).toBe(false);
  });

  test("root resolution only stats", () => {
    const { repo, worktree } = setup();
    expect(rootOf(join(repo, "packages", "api"))).toBe(repo);
    expect(rootOf(worktree)).toBeNull();
  });
});
