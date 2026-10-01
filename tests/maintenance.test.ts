import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  checkLinearis,
  checkPlugin,
  checkProjectEnablement,
  checkSource,
  checkToken,
  findBindingRoot,
  inProject,
  isClaudeSource,
  isCodexSource,
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
    expect(isCodexSource("/tmp/agent-kit", "published")).toBe(false);
    expect(isCodexSource("Pibomeister/agent-kit", "main")).toBe(false);
    expect(isCodexSource("Pibomeister/agent-kit", "published")).toBe(true);
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

  test("requires token mode 600, gitignore and untracked state", () => {
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
    expect(checkToken(root, binding).level).toBe("FAIL");
    chmodSync(join(root, ".linear-token"), 0o640);
    expect(checkToken(root, binding).level).toBe("FAIL");
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
