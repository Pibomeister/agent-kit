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

  test("requires a resolvable published bundle", () => {
    expect(checkSource("Claude Code", null).level).toBe("FAIL");
    expect(checkSource("Claude Code", { name: "ak", version: "1.2.0" }).level).toBe("PASS");
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

  test("requires token mode 600, gitignore and untracked state", () => {
    const root = project();
    expect(checkToken(root, ".linear-token").level).toBe("FAIL");
    writeFileSync(join(root, ".linear-token"), "secret\n", { mode: 0o644 });
    expect(checkToken(root, ".linear-token").level).toBe("FAIL");
    chmodSync(join(root, ".linear-token"), 0o600);
    expect(checkToken(root, ".linear-token").level).toBe("FAIL");
    writeFileSync(join(root, ".gitignore"), ".linear-token\n");
    expect(checkToken(root, ".linear-token").level).toBe("PASS");
    const outside = project();
    writeFileSync(join(outside, "secret"), "secret\n", { mode: 0o600 });
    rmSync(join(root, ".linear-token"));
    symlinkSync(join(outside, "secret"), join(root, ".linear-token"));
    expect(checkToken(root, ".linear-token").level).toBe("FAIL");
  });

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
    writeFileSync(local, "#!/bin/sh\necho 2026.8.0\n");
    chmodSync(local, 0o755);
    symlinkSync(local, join(bin, "linearis"));
    expect(checkLinearis(root, "linear-linearis").level).toBe("PASS");
  });
});
