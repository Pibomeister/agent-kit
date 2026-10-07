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

// These CLI subprocesses run once at module load so a busy host cannot spend a test's entire
// timeout scheduling Bun. The assertions below still cover their exit codes and complete output.
const maintenanceRoot = project();
const maintenanceCli = join(import.meta.dir, "../src/maintenance/cli.ts");
const maintenanceEnv = {
  ...process.env,
  PATH: "/usr/bin:/bin",
  CLAUDE_CONFIG_DIR: join(maintenanceRoot, "claude-home"),
  CODEX_HOME: join(maintenanceRoot, "codex-home"),
  AK_PUBLISHED_ROOT: join(maintenanceRoot, "missing-published"),
};
const doctorJson = spawnSync(process.execPath, [maintenanceCli, "doctor", "--json"], {
  cwd: maintenanceRoot,
  env: maintenanceEnv,
  encoding: "utf8",
});
const rejectedUpdate = spawnSync(process.execPath, [maintenanceCli, "update", "--dry-run"], {
  cwd: maintenanceRoot,
  env: maintenanceEnv,
  encoding: "utf8",
});
const repoUpdate = spawnSync(process.execPath, [join(import.meta.dir, "../src/cli.ts"), "update", "--dry-run"], {
  cwd: maintenanceRoot,
  env: maintenanceEnv,
  encoding: "utf8",
});

function runLinkedWorktreeFixture() {
  const root = realpathSync(project());
  const linked = `${project()}-linked`;
  roots.push(linked);
  mkdirSync(join(root, ".claude"));
  writeFileSync(join(root, ".claude/settings.json"), '{"enabledPlugins":{"ak@agent-kit":true}}');
  writeFileSync(join(root, ".gitignore"), ".linear-token\n");
  spawnSync("git", ["-C", root, "add", ".claude/settings.json", ".gitignore"]);
  spawnSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "setup"]);
  const added = spawnSync("git", ["-C", root, "worktree", "add", "--detach", linked], { encoding: "utf8" });
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
  const projectRuns = [linked, join(root, "src")].map((cwd) => {
    if (cwd.endsWith("src")) mkdirSync(cwd);
    return {
      doctor: spawnSync(process.execPath, [maintenanceCli, "doctor"], { cwd, env, encoding: "utf8" }),
      update: spawnSync(process.execPath, [maintenanceCli, "update"], { cwd, env, encoding: "utf8" }),
    };
  });
  // A published 0.2.0 that the host update reports success for and still leaves 0.1.0 installed.
  const newer = join(root, "published-newer");
  for (const host of ["claude-code", "codex"]) {
    const manifest = join(newer, "dist", host, host === "codex" ? ".codex-plugin" : ".claude-plugin");
    mkdirSync(manifest, { recursive: true });
    writeFileSync(join(manifest, "plugin.json"), '{"name":"ak","version":"0.2.0"}');
  }
  const staleBin = join(root, "stale-bin");
  mkdirSync(staleBin);
  writeFileSync(
    join(staleBin, "codex"),
    `#!/bin/sh\necho '{"installed":[{"pluginId":"ak@agent-kit","version":"0.1.0","enabled":true}]}'\n`,
  );
  chmodSync(join(staleBin, "codex"), 0o755);
  const staleCodexHome = join(root, "stale-codex");
  mkdirSync(staleCodexHome);
  writeFileSync(
    join(staleCodexHome, "config.toml"),
    '[marketplaces.agent-kit]\nsource = "Pibomeister/agent-kit"\nref = "published"\n',
  );
  const staleUpdate = spawnSync(process.execPath, [maintenanceCli, "update"], {
    cwd: linked,
    env: { ...env, PATH: `${staleBin}:${env.PATH}`, AK_PUBLISHED_ROOT: newer, CODEX_HOME: staleCodexHome },
    encoding: "utf8",
  });
  const oldSource = spawnSync(process.execPath, [maintenanceCli, "doctor"], {
    cwd: linked,
    env: { ...env, AK_TEST_MARKET_SOURCE: "directory" },
    encoding: "utf8",
  });
  const update = spawnSync(process.execPath, [maintenanceCli, "update"], {
    cwd: linked,
    env: { ...env, AK_TEST_MARKET_SOURCE: "directory" },
    encoding: "utf8",
  });
  const bundle = join(root, "ak-standalone.mjs");
  const built = spawnSync(process.execPath, ["build", maintenanceCli, "--target=bun", `--outfile=${bundle}`], {
    cwd: root,
    encoding: "utf8",
  });
  const standalone = spawnSync(process.execPath, [bundle, "doctor"], { cwd: linked, env, encoding: "utf8" });
  writeFileSync(
    join(linked, "ak.tracker.yaml"),
    "backend: linear-linearis\ntoken_file: .linear-token\ndefaults:\n  team: ENG\n",
  );
  writeFileSync(join(linked, ".linear-token"), " \n", { mode: 0o600 });
  const blank = spawnSync(process.execPath, [bundle, "doctor"], { cwd: linked, env, encoding: "utf8" });
  writeFileSync(
    join(linked, "ak.tracker.yaml"),
    "backend: linear-linearis\ntoken_file: .linear-token\ndefaults:\n  project: Demo\n",
  );
  const missingTeam = spawnSync(process.execPath, [bundle, "doctor"], { cwd: linked, env, encoding: "utf8" });
  writeFileSync(
    join(linked, "ak.tracker.yaml"),
    "backend: jira-nope\ntoken_file: .linear-token\ndefaults:\n  team: ENG\n",
  );
  const unknown = spawnSync(process.execPath, [bundle, "doctor"], { cwd: linked, env, encoding: "utf8" });
  return { added, projectRuns, staleUpdate, oldSource, update, built, standalone, blank, missingTeam, unknown };
}

// Nine nested Bun invocations took 17s normally and 25s beside another full suite on this host.
// Running the fixture here keeps scheduler delay outside the timed assertion body.
const linkedWorktreeFixture = runLinkedWorktreeFixture();

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
    expect(doctorJson.status).toBe(1);
    const parsed: unknown = JSON.parse(doctorJson.stdout);
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
    expect(rejectedUpdate.status).toBe(2);
    expect(rejectedUpdate.stderr).toContain("Usage: ak doctor [--json] | ak update");
  });

  test("the repo CLI forwards maintenance flags instead of running a real update", () => {
    expect(repoUpdate.status).toBe(2);
    expect(repoUpdate.stderr).toContain("Usage: ak doctor [--json] | ak update");
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
    expect(linkedWorktreeFixture.added.status).toBe(0);
    for (const run of linkedWorktreeFixture.projectRuns) {
      expect(run.doctor.status).toBe(0);
      expect(run.doctor.stdout).toContain("PASS Claude Code plugin: enabled; installed 0.1.0");
      expect(run.update.status).toBe(0);
      expect(run.update.stdout).toContain("PASS Claude Code project: 0.1.0 -> 0.1.0");
    }
    // A host that reports success but leaves the old version installed is a failed update on both hosts.
    expect(linkedWorktreeFixture.staleUpdate.stdout).toContain("FAIL Claude Code project: 0.1.0 -> 0.1.0");
    expect(linkedWorktreeFixture.staleUpdate.stdout).toContain("FAIL Codex: 0.1.0 -> 0.1.0");
    expect(linkedWorktreeFixture.staleUpdate.status).toBe(1);
    expect(linkedWorktreeFixture.oldSource.status).toBe(1);
    expect(linkedWorktreeFixture.oldSource.stdout).toContain(
      "FAIL Claude Code marketplace source: configured marketplace is local",
    );
    expect(linkedWorktreeFixture.update.status).toBe(1);
    expect(linkedWorktreeFixture.update.stderr).toContain("FAIL Claude Code update: configured marketplace is local");
    expect(linkedWorktreeFixture.built.status).toBe(0);
    expect(linkedWorktreeFixture.standalone.status).toBe(0);
    expect(linkedWorktreeFixture.standalone.stdout).toContain("PASS Claude Code plugin: enabled; installed 0.1.0");
    expect(linkedWorktreeFixture.blank.status).toBe(1);
    expect(linkedWorktreeFixture.blank.stdout).toContain("FAIL tracker token:");
    expect(linkedWorktreeFixture.missingTeam.status).toBe(1);
    expect(linkedWorktreeFixture.missingTeam.stdout).toContain("FAIL tracker binding:");
    expect(linkedWorktreeFixture.unknown.status).toBe(1);
    expect(linkedWorktreeFixture.unknown.stdout).toContain("FAIL tracker binding:");
  });

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
