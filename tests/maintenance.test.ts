import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Ajv from "ajv";

import {
  checkLinearis,
  checkMaintenanceCommand,
  checkPlugin,
  checkProjectEnablement,
  checkSource,
  checkToken,
  command,
  findBindingRoot,
  inProject,
  isClaudeSource,
  isCodexSource,
  manifest as fetchManifest,
  parseBinding,
} from "../src/maintenance/cli.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function project(): string {
  const root = mkdtempSync(join(tmpdir(), "ak-doctor-"));
  roots.push(root);
  spawnSync("git", ["init", "-q", root]);
  return root;
}

describe("ak doctor checks", () => {
  test("checks installed, enabled and published plugin versions", () => {
    expect(checkPlugin("Claude Code", [], "1.2.0").level).toBe("WARN");
    expect(checkPlugin("Claude Code", [{ id: "ak@agent-kit", enabled: false, version: "1.2.0" }], "1.2.0").level).toBe(
      "FAIL",
    );
    expect(checkPlugin("Claude Code", [{ id: "ak@agent-kit", enabled: true, version: "1.1.0" }], "1.2.0").level).toBe(
      "WARN",
    );
    expect(checkPlugin("Claude Code", [{ id: "ak@agent-kit", enabled: true, version: "1.2.0" }], "1.2.0").level).toBe(
      "PASS",
    );
  });

  test("matches project-scoped installs to this repo through symlinks only", () => {
    const root = realpathSync(project());
    const link = `${project()}-link`;
    roots.push(link);
    symlinkSync(root, link);
    expect(inProject({ id: "ak@agent-kit", scope: "user" }, root)).toBe(true);
    expect(inProject({ id: "ak@agent-kit", scope: "project", projectPath: link }, root)).toBe(true);
    expect(inProject({ id: "ak@agent-kit", scope: "project", projectPath: project() }, root)).toBe(false);
    expect(inProject({ id: "ak@agent-kit", scope: "project", projectPath: join(root, "gone") }, root)).toBe(false);
  });

  test("recognizes an enabled project install from a linked worktree", () => {
    const root = project();
    const linked = project();
    rmSync(linked, { recursive: true });
    spawnSync("git", [
      "-C",
      root,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "commit",
      "--allow-empty",
      "-qm",
      "seed",
    ]);
    const added = spawnSync("git", ["-C", root, "worktree", "add", "--detach", linked], { encoding: "utf8" });
    expect(added.status).toBe(0);
    const installed = { id: "ak@agent-kit", scope: "project", projectPath: root, projectEnabled: true };
    expect(inProject(installed, realpathSync(linked))).toBe(true);
  });

  test("requires a resolvable published bundle", () => {
    expect(checkSource("Claude Code", null).level).toBe("FAIL");
    expect(checkSource("Claude Code", { name: "ak", version: "1.2.0" }).level).toBe("PASS");
    expect(checkSource("Claude Code", { name: "ak", version: "1.2.0" }, false).level).toBe("FAIL");
    expect(isClaudeSource({ name: "agent-kit", source: "directory" })).toBe(false);
    expect(isClaudeSource({ name: "agent-kit", source: "github", repo: "Pibomeister/agent-kit" })).toBe(true);
    expect(isClaudeSource({ name: "agent-kit", source: "github", repo: "pibomeister/AGENT-KIT" })).toBe(true);
    for (const url of [
      "git@github.com:Pibomeister/agent-kit.git",
      "ssh://git@github.com/PIBOMEISTER/AGENT-KIT",
      "https://github.com/pibomeister/agent-kit.git",
    ])
      expect(isClaudeSource({ name: "agent-kit", source: "git", url })).toBe(true);
    expect(isClaudeSource({ name: "agent-kit", source: "git", url: "git@github.com:other/agent-kit.git" })).toBe(false);
    expect(isCodexSource("/tmp/agent-kit", "published")).toBe(false);
    expect(isCodexSource("Pibomeister/agent-kit", "main")).toBe(false);
    expect(isCodexSource("Pibomeister/agent-kit", "published")).toBe(true);
  });

  test("explains published network failures separately from 404", () => {
    expect(checkSource("Codex", null, true, { reason: "network" }).detail).toContain("cannot reach");
    expect(checkSource("Codex", null, true, { reason: "network" }).remedy).toContain("network access");
    expect(checkSource("Codex", null, true, { reason: "missing", status: 404 }).detail).toContain("HTTP 404");
    expect(checkSource("Codex", null, true, { reason: "missing", status: 404 }).remedy).toContain("published branch");
  });

  test("published manifest fetch distinguishes 404 and times out", async () => {
    const missing = Bun.serve({ port: 0, fetch: () => new Response("missing", { status: 404 }) });
    try {
      const result = await fetchManifest("claude-code", `http://127.0.0.1:${missing.port}`, 500);
      expect(result.failure).toEqual({ reason: "missing", status: 404 });
    } finally {
      void missing.stop(true);
    }
    const stalled = Bun.serve({ port: 0, fetch: () => new Promise<Response>(() => {}) });
    try {
      const start = Date.now();
      const result = await fetchManifest("codex", `http://127.0.0.1:${stalled.port}`, 100);
      expect(result.failure?.reason).toBe("network");
      expect(Date.now() - start).toBeLessThan(2000);
    } finally {
      void stalled.stop(true);
    }
  });

  test("host subprocesses time out", () => {
    const start = Date.now();
    const result = command("sh", ["-c", "exec sleep 5"], project(), process.env, 100);
    expect(result.ok).toBe(false);
    expect(result.output).toContain("ETIMEDOUT");
    expect(Date.now() - start).toBeLessThan(2000);
  });

  test("warns when the curl-installed maintenance command is stale", () => {
    expect(checkMaintenanceCommand("old", "new").level).toBe("WARN");
    expect(checkMaintenanceCommand("current", "current").level).toBe("PASS");
  });

  test("doctor --json is parseable and update rejects unknown flags before touching hosts", () => {
    const root = project();
    const cli = join(import.meta.dir, "../src/maintenance/cli.ts");
    const env = {
      ...process.env,
      PATH: "/usr/bin:/bin",
      CLAUDE_CONFIG_DIR: join(root, "claude-home"),
      CODEX_HOME: join(root, "codex-home"),
      AK_PUBLISHED_ROOT: join(root, "missing-published"),
    };
    const doctor = spawnSync(process.execPath, [cli, "doctor", "--json"], { cwd: root, env, encoding: "utf8" });
    expect(doctor.status).toBe(1);
    const parsed: unknown = JSON.parse(doctor.stdout);
    const valid = new Ajv().compile({
      type: "object",
      required: ["findings"],
      properties: {
        findings: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            required: ["level", "check", "detail", "remedy"],
            properties: {
              level: { enum: ["PASS", "WARN", "FAIL"] },
              check: { type: "string" },
              detail: { type: "string" },
              remedy: { type: "string", minLength: 1 },
            },
          },
        },
      },
    });
    expect(valid(parsed)).toBe(true);
    const update = spawnSync(process.execPath, [cli, "update", "--dry-run"], { cwd: root, env, encoding: "utf8" });
    expect(update.status).toBe(2);
    expect(update.stderr).toContain("Usage: ak doctor [--json] | ak update");
  });

  test("the repo CLI forwards maintenance flags instead of running a real update", () => {
    const root = project();
    const cli = join(import.meta.dir, "../src/cli.ts");
    const env = { ...process.env, PATH: "/usr/bin:/bin", AK_PUBLISHED_ROOT: join(root, "missing-published") };
    const update = spawnSync(process.execPath, [cli, "update", "--dry-run"], { cwd: root, env, encoding: "utf8" });
    expect(update.status).toBe(2);
    expect(update.stderr).toContain("Usage: ak doctor [--json] | ak update");
  });

  test("doctor ignores foreign GIT_DIR and GIT_WORK_TREE", () => {
    const local = project();
    const foreign = project();
    mkdirSync(join(foreign, ".claude"));
    writeFileSync(join(foreign, ".claude/settings.json"), '{"enabledPlugins":{"ak@agent-kit":true}}');
    const bin = join(foreign, "node_modules/.bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "linearis"), "#!/bin/sh\necho 2026.8.0\n");
    chmodSync(join(bin, "linearis"), 0o755);
    const savedDir = process.env.GIT_DIR;
    const savedTree = process.env.GIT_WORK_TREE;
    process.env.GIT_DIR = join(foreign, ".git");
    process.env.GIT_WORK_TREE = foreign;
    try {
      expect(checkProjectEnablement(local).level).toBe("WARN");
      expect(checkLinearis(local, "linear-linearis").level).toBe("FAIL");
    } finally {
      if (savedDir === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = savedDir;
      if (savedTree === undefined) delete process.env.GIT_WORK_TREE;
      else process.env.GIT_WORK_TREE = savedTree;
    }
  });

  test("doctor sees a project install from a linked worktree and a subdirectory", () => {
    const root = realpathSync(project());
    const linked = `${project()}-linked`;
    roots.push(linked);
    mkdirSync(join(root, ".claude"));
    writeFileSync(join(root, ".claude/settings.json"), '{"enabledPlugins":{"ak@agent-kit":true}}');
    writeFileSync(join(root, ".gitignore"), ".linear-token\n");
    spawnSync("git", ["-C", root, "add", ".claude/settings.json", ".gitignore"]);
    spawnSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "setup"]);
    const added = spawnSync("git", ["-C", root, "worktree", "add", "--detach", linked], { encoding: "utf8" });
    expect(added.status).toBe(0);
    const published = join(root, "published");
    for (const host of ["claude-code", "codex"]) {
      const manifest = join(published, "dist", host, host === "codex" ? ".codex-plugin" : ".claude-plugin");
      mkdirSync(manifest, { recursive: true });
      writeFileSync(join(manifest, "plugin.json"), '{"name":"ak","version":"0.1.0"}');
    }
    const fakeBin = join(root, "fake-bin");
    mkdirSync(fakeBin);
    const claude = join(fakeBin, "claude");
    writeFileSync(
      claude,
      `#!/bin/sh
if [ "$2" = marketplace ]; then
  if [ "$AK_TEST_MARKET_SOURCE" = directory ]; then
    printf '%s\n' '[{"name":"agent-kit","source":"directory","path":"/tmp/old-clone"}]'
  else
    printf '%s\n' '[{"name":"agent-kit","source":"github","repo":"Pibomeister/agent-kit"}]'
  fi
else
  current="$(pwd -P)"
  enabled=false
  if [ "$current" = "$AK_TEST_ROOT" ] || [ "$current" = "$AK_TEST_LINKED" ]; then enabled=true; fi
  printf '[{"id":"ak@agent-kit","version":"0.1.0","scope":"project","enabled":%s,"projectEnabled":%s,"projectPath":"%s"}]\n' "$enabled" "$enabled" "$AK_TEST_ROOT"
fi
`,
    );
    chmodSync(claude, 0o755);
    const codex = join(fakeBin, "codex");
    writeFileSync(codex, "#!/bin/sh\necho '{\"installed\":[]}'\n");
    chmodSync(codex, 0o755);
    const env = {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH}`,
      AK_PUBLISHED_ROOT: published,
      AK_TEST_ROOT: root,
      AK_TEST_LINKED: realpathSync(linked),
      CODEX_HOME: join(root, "empty-codex"),
      AK_TEST_MARKET_SOURCE: "github",
    };
    for (const cwd of [linked, join(root, "src")]) {
      if (cwd.endsWith("src")) mkdirSync(cwd);
      const run = spawnSync(process.execPath, [join(import.meta.dir, "../src/maintenance/cli.ts"), "doctor"], {
        cwd,
        env,
        encoding: "utf8",
      });
      expect(run.status).toBe(0);
      expect(run.stdout).toContain("PASS Claude Code plugin: enabled; installed 0.1.0");
      const refreshed = spawnSync(process.execPath, [join(import.meta.dir, "../src/maintenance/cli.ts"), "update"], {
        cwd,
        env,
        encoding: "utf8",
      });
      expect(refreshed.status).toBe(0);
      expect(refreshed.stdout).toContain("PASS Claude Code project: 0.1.0 -> 0.1.0");
    }
    const oldSource = spawnSync(process.execPath, [join(import.meta.dir, "../src/maintenance/cli.ts"), "doctor"], {
      cwd: linked,
      env: { ...env, AK_TEST_MARKET_SOURCE: "directory" },
      encoding: "utf8",
    });
    expect(oldSource.status).toBe(1);
    expect(oldSource.stdout).toContain("FAIL Claude Code marketplace source: configured marketplace is local");
    const update = spawnSync(process.execPath, [join(import.meta.dir, "../src/maintenance/cli.ts"), "update"], {
      cwd: linked,
      env: { ...env, AK_TEST_MARKET_SOURCE: "directory" },
      encoding: "utf8",
    });
    expect(update.status).toBe(1);
    expect(update.stderr).toContain("FAIL Claude Code update: configured marketplace is local");
    const bundle = join(root, "ak-standalone.mjs");
    const built = spawnSync(
      process.execPath,
      ["build", join(import.meta.dir, "../src/maintenance/cli.ts"), "--target=bun", `--outfile=${bundle}`],
      { cwd: root, encoding: "utf8" },
    );
    expect(built.status).toBe(0);
    const standalone = spawnSync(process.execPath, [bundle, "doctor"], { cwd: linked, env, encoding: "utf8" });
    expect(standalone.status).toBe(0);
    expect(standalone.stdout).toContain("PASS Claude Code plugin: enabled; installed 0.1.0");
    writeFileSync(
      join(linked, "ak.tracker.yaml"),
      "backend: linear-linearis\ntoken_file: .linear-token\ndefaults:\n  team: ENG\n",
    );
    writeFileSync(join(linked, ".linear-token"), " \n", { mode: 0o600 });
    const blank = spawnSync(process.execPath, [bundle, "doctor"], { cwd: linked, env, encoding: "utf8" });
    expect(blank.status).toBe(1);
    expect(blank.stdout).toContain("FAIL tracker token:");
    writeFileSync(
      join(linked, "ak.tracker.yaml"),
      "backend: linear-linearis\ntoken_file: .linear-token\ndefaults:\n  project: Demo\n",
    );
    const missingTeam = spawnSync(process.execPath, [bundle, "doctor"], { cwd: linked, env, encoding: "utf8" });
    expect(missingTeam.status).toBe(1);
    expect(missingTeam.stdout).toContain("FAIL tracker binding:");
    writeFileSync(
      join(linked, "ak.tracker.yaml"),
      "backend: jira-nope\ntoken_file: .linear-token\ndefaults:\n  team: ENG\n",
    );
    const unknown = spawnSync(process.execPath, [bundle, "doctor"], { cwd: linked, env, encoding: "utf8" });
    expect(unknown.status).toBe(1);
    expect(unknown.stdout).toContain("FAIL tracker binding:");
  }, 30_000);

  test("checks project enablement", () => {
    const root = project();
    expect(checkProjectEnablement(root).level).toBe("WARN");
    mkdirSync(join(root, ".claude"));
    writeFileSync(join(root, ".claude/settings.json"), '{"enabledPlugins":{"ak@agent-kit":true}}');
    expect(checkProjectEnablement(root).level).toBe("PASS");
  });

  test("parses the nearest tracker binding and rejects malformed YAML", () => {
    const root = project();
    const nested = join(root, "src");
    mkdirSync(nested);
    expect(findBindingRoot(nested)).toBeNull();
    writeFileSync(
      join(root, "ak.tracker.yaml"),
      "backend: linear-linearis\ntoken_file: .linear-token\ndefaults:\n  team: ENG\n",
    );
    expect(findBindingRoot(nested)).toBe(realpathSync(root));
    expect(parseBinding(root).finding.level).toBe("PASS");
    writeFileSync(join(root, "ak.tracker.yaml"), "backend: [\n");
    expect(parseBinding(root).finding.level).toBe("FAIL");
  });

  test("rejects a backend-required team and an unknown backend", () => {
    const root = project();
    writeFileSync(
      join(root, "ak.tracker.yaml"),
      "backend: linear-linearis\ntoken_file: .linear-token\ndefaults:\n  project: Demo\n",
    );
    expect(parseBinding(root).finding.level).toBe("FAIL");
    writeFileSync(
      join(root, "ak.tracker.yaml"),
      "backend: jira-nope\ntoken_file: .linear-token\ndefaults:\n  team: ENG\n",
    );
    expect(parseBinding(root).finding.level).toBe("FAIL");
  });

  test("requires an owner-only token, gitignore and untracked state", () => {
    const root = project();
    const binding = { backend: "linear-linearis", token_file: ".linear-token", defaults: { team: "ENG" } };
    expect(checkToken(root, binding).level).toBe("FAIL");
    writeFileSync(join(root, ".linear-token"), "secret\n", { mode: 0o644 });
    expect(checkToken(root, binding).level).toBe("FAIL");
    chmodSync(join(root, ".linear-token"), 0o600);
    expect(checkToken(root, binding).level).toBe("FAIL");
    writeFileSync(join(root, ".gitignore"), ".linear-token\n");
    expect(checkToken(root, binding).level).toBe("FAIL");
    spawnSync("git", ["-C", root, "add", ".gitignore"]);
    spawnSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "ignore token"]);
    expect(checkToken(root, binding).level).toBe("PASS");
    chmodSync(join(root, ".linear-token"), 0o400);
    expect(checkToken(root, binding).level).toBe("PASS");
    chmodSync(join(root, ".linear-token"), 0o640);
    expect(checkToken(root, binding).level).toBe("FAIL");
    expect(checkToken(root, binding).detail).toContain("chmod 600 .linear-token");
    chmodSync(join(root, ".linear-token"), 0o600);
    writeFileSync(join(root, ".linear-token"), " \n");
    expect(checkToken(root, binding).level).toBe("FAIL");
    writeFileSync(join(root, ".linear-token"), "secret\n");
    const outside = project();
    writeFileSync(join(outside, "secret"), "secret\n", { mode: 0o600 });
    rmSync(join(root, ".linear-token"));
    symlinkSync(join(outside, "secret"), join(root, ".linear-token"));
    expect(checkToken(root, binding).level).toBe("FAIL");
  }, 15_000);

  test("rejects global and escaped linearis binaries", () => {
    const root = project();
    expect(checkLinearis(root, "linear-linearis").level).toBe("FAIL");
    const bin = join(root, "node_modules/.bin");
    mkdirSync(bin, { recursive: true });
    const outside = join(root, "outside-linearis");
    writeFileSync(outside, "#!/bin/sh\necho 2026.8.0\n");
    chmodSync(outside, 0o755);
    symlinkSync(outside, join(bin, "linearis"));
    expect(checkLinearis(root, "linear-linearis").level).toBe("FAIL");
    rmSync(join(bin, "linearis"));
    const local = join(root, "node_modules/linearis");
    writeFileSync(local, '#!/bin/sh\n[ "$NO_UPDATE_NOTIFIER" = 1 ] || exit 7\necho 2026.8.0\n');
    chmodSync(local, 0o755);
    symlinkSync(local, join(bin, "linearis"));
    expect(checkLinearis(root, "linear-linearis").level).toBe("PASS");
    const nested = join(root, "packages/app");
    const nestedBin = join(nested, "node_modules/.bin");
    mkdirSync(nestedBin, { recursive: true });
    symlinkSync(outside, join(nestedBin, "linearis"));
    expect(checkLinearis(nested, "linear-linearis").level).toBe("FAIL");
  });
});
