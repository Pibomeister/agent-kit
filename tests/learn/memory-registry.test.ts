/**
 * Project discovery from claude-mem tool use: stat-only root resolution,
 * worktree and cache skips, the look-back window, newest sighting wins.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { projectFolderName, registryPath, rootOf, tickLogPath } from "../../src/learn/core/paths.ts";
import { discoverProjects, discoverySince, readRegistry, registerRoot } from "../../src/learn/memory/registry.ts";
import { sessionStartBlock } from "../../src/learn/memory/session-context.ts";
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

  test("a registered root is not moved onto a claude-mem project another root holds", () => {
    const { config } = setup();
    const shop = join(projectScratch(), "shop");
    const other = join(projectScratch(), "other");
    for (const root of [shop, other]) mkdirSync(join(root, ".git"), { recursive: true });
    registerRoot(config, shop, 5);
    registerRoot(config, other, 5);
    const warnings: string[] = [];
    const registry = discoverProjects(config, [{ project: "shop", cwd: other, last_seen: 10 }], (warning) =>
      warnings.push(warning),
    );
    expect(Object.values(registry)).toEqual([
      { root: shop, mem_project: "shop", last_seen: 5 },
      { root: other, mem_project: "other", last_seen: 5 },
    ]);
    expect(warnings).toEqual([
      `registry warning: claude-mem project 'shop' is already registered at ${shop}; refusing ${other}`,
    ]);
    expect(readRegistry(config)).toEqual(registry);
  });

  test("roots already sharing a claude-mem project still refresh", () => {
    const { config } = setup();
    const first = join(projectScratch(), "first", "shop");
    const second = join(projectScratch(), "second", "shop");
    for (const root of [first, second]) mkdirSync(join(root, ".git"), { recursive: true });
    mkdirSync(config.runtimeDir, { recursive: true });
    writeFileSync(
      registryPath(config),
      `${JSON.stringify({
        [projectFolderName(first)]: { root: first, mem_project: "shop", last_seen: 1 },
        [projectFolderName(second)]: { root: second, mem_project: "shop", last_seen: 2 },
      })}\n`,
    );
    expect(registerRoot(config, first, 8).refusal).toBeNull();
    expect(registerRoot(config, second, 9).refusal).toBeNull();
    expect(Object.values(readRegistry(config)).map((entry) => entry.last_seen)).toEqual([8, 9]);
  });

  test("two roots for one claude-mem project leave one active entry and warn", () => {
    const { config } = setup();
    const first = join(projectScratch(), "first", "shop");
    const second = join(projectScratch(), "second", "shop");
    for (const root of [first, second]) mkdirSync(join(root, ".git"), { recursive: true });
    const warnings: string[] = [];
    const registry = discoverProjects(
      config,
      [
        { project: "shop", cwd: first, last_seen: 10 },
        { project: "shop", cwd: second, last_seen: 20 },
      ],
      (warning) => warnings.push(warning),
    );
    expect(Object.values(registry)).toEqual([{ root: first, mem_project: "shop", last_seen: 10 }]);
    expect(warnings).toEqual([
      `registry warning: claude-mem project 'shop' is already registered at ${first}; refusing ${second}`,
    ]);
    expect(readRegistry(config)).toEqual(registry);
  });

  test("a second root for a registered claude-mem project is refused and the established root stays", () => {
    const { config } = setup();
    const established = join(projectScratch(), "work", "api");
    const stray = join(projectScratch(), "oss", "api");
    for (const root of [established, stray]) mkdirSync(join(root, ".git"), { recursive: true });
    expect(registerRoot(config, established, 5).refusal).toBeNull();

    const refused = registerRoot(config, stray, 50);
    const warning = `registry warning: claude-mem project 'api' is already registered at ${established}; refusing ${stray}`;
    expect(refused.refusal).toBe(warning);
    expect(refused.warnings).toEqual([warning]);
    expect(Object.values(readRegistry(config))).toEqual([{ root: established, mem_project: "api", last_seen: 5 }]);

    expect(registerRoot(config, established, 60)).toMatchObject({ refusal: null, warnings: [] });
    expect(Object.values(readRegistry(config))).toEqual([{ root: established, mem_project: "api", last_seen: 60 }]);
  });

  test("a session start in a refused root writes the warning to the tick log and not to the session block", () => {
    const established = join(projectScratch(), "work", "api");
    const stray = join(projectScratch(), "oss", "api");
    for (const root of [established, stray]) mkdirSync(join(root, ".git"), { recursive: true });
    const ctx = testContext({ cwd: stray });
    registerRoot(ctx.config, established, 5);

    const block = sessionStartBlock(ctx);
    expect(block).not.toContain("registry warning");
    expect(ctx.out.join("\n")).not.toContain("registry warning");
    expect(readFileSync(tickLogPath(ctx.config), "utf8")).toContain(
      `registry warning: claude-mem project 'api' is already registered at ${established}; refusing ${stray}\n`,
    );
    expect(Object.values(readRegistry(ctx.config)).map((entry) => entry.root)).toEqual([established]);
  });

  test("bare repositories and no-mistakes repository copies are never registered", () => {
    const { config } = setup();
    const bare = join(projectScratch(), "bare.git");
    mkdirSync(join(bare, "objects"), { recursive: true });
    writeFileSync(join(bare, "HEAD"), "ref: refs/heads/main\n");
    const noMistakes = join(projectScratch(), ".no-mistakes", "repos", "copy");
    mkdirSync(join(noMistakes, ".git"), { recursive: true });

    expect(registerRoot(config, bare)).toEqual({
      registry: {},
      warnings: [`registry warning: ${bare} is a bare repository and cannot be registered`],
      refusal: `registry warning: ${bare} is a bare repository and cannot be registered`,
    });
    expect(registerRoot(config, noMistakes)).toEqual({
      registry: {},
      warnings: [`registry warning: ${noMistakes} is managed by no-mistakes and cannot be registered`],
      refusal: `registry warning: ${noMistakes} is managed by no-mistakes and cannot be registered`,
    });
    expect(
      discoverProjects(config, [
        { project: "bare", cwd: bare, last_seen: 10 },
        { project: "copy", cwd: noMistakes, last_seen: 20 },
      ]),
    ).toEqual({});
    expect(existsSync(registryPath(config))).toBe(false);
  });

  test("hygiene unregisters bare and no-mistakes entries and keeps a root it cannot stat", () => {
    const { repo, config } = setup();
    const bare = join(projectScratch(), "bare.git");
    mkdirSync(join(bare, "objects"), { recursive: true });
    writeFileSync(join(bare, "HEAD"), "ref: refs/heads/main\n");
    const noMistakes = join(projectScratch(), ".no-mistakes", "repos", "copy");
    const unmounted = join(projectScratch(), "unmounted", "app");
    const kept = { root: unmounted, mem_project: "renamed-app", last_seen: 3 };
    mkdirSync(config.runtimeDir, { recursive: true });
    writeFileSync(
      registryPath(config),
      `${JSON.stringify({
        [projectFolderName(bare)]: { root: bare, mem_project: "bare", last_seen: 1 },
        [projectFolderName(noMistakes)]: { root: noMistakes, mem_project: "copy", last_seen: 2 },
        [projectFolderName(unmounted)]: kept,
      })}\n`,
    );

    const result = registerRoot(config, repo, 9);
    expect(result.refusal).toBeNull();
    expect(result.warnings).toEqual([
      `registry warning: ${bare} is a bare repository and cannot be registered`,
      `registry warning: ${noMistakes} is managed by no-mistakes and cannot be registered`,
    ]);
    expect(readRegistry(config)).toEqual({
      [projectFolderName(unmounted)]: kept,
      [projectFolderName(repo)]: { root: repo, mem_project: "myrepo", last_seen: 9 },
    });
  });

  test("root resolution only stats", () => {
    const { repo, worktree } = setup();
    expect(rootOf(join(repo, "packages", "api"))).toBe(repo);
    expect(rootOf(worktree)).toBeNull();
  });
});
