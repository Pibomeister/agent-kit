import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { CURSOR_BUN_PIN, cursorAkLauncher } from "../src/packaging/cursor-ak.ts";
import { processScratch } from "./helpers/process-tmp.ts";

const repo = join(import.meta.dir, "..");
const install = join(repo, "tools/cursor/install.sh");

function runFn(
  env: {
    HOME: string;
    PATH: string;
  },
  body: string,
) {
  const result = spawnSync("bash", ["-c", `set -euo pipefail\nsource "$INSTALL"\n${body}\n`], {
    encoding: "utf8",
    env: {
      HOME: env.HOME,
      PATH: env.PATH,
      INSTALL: install,
      TERM: "dumb",
      USER: "tester",
      LOGNAME: "tester",
    },
  });
  return { status: result.status ?? 1, stderr: result.stderr ?? "", stdout: result.stdout ?? "" };
}

function scratchHome() {
  const home = processScratch("ak-cursor-install-");
  const trap = join(home, "trap-bin");
  const sudoLog = join(home, "sudo.log");
  mkdirSync(join(home, ".bun/bin"), { recursive: true });
  mkdirSync(trap, { recursive: true });
  writeFileSync(join(trap, "sudo"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${sudoLog}'\nexit 0\n`, {
    mode: 0o755,
  });
  return {
    home,
    sudoLog,
    bun: join(home, ".bun/bin/bun"),
    path: `${trap}:${home}/.bun/bin:/usr/bin:/bin`,
  };
}

function writeFakeBun(path: string, version: string, mark: string) {
  writeFileSync(
    path,
    `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo ${version}
  exit 0
fi
printf '%s\\n' "${mark} $*" > "\${HOME}/launcher.out"
`,
    { mode: 0o755 },
  );
}

function noBunPath() {
  const dir = join(processScratch("ak-cursor-nopath-"), "bin");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function runLauncher(home: string | undefined, path: string, args: string[]) {
  const dir = join(processScratch("ak-cursor-overlay-"), "bin");
  mkdirSync(dir, { recursive: true });
  const launcher = join(dir, "ak");
  writeFileSync(launcher, cursorAkLauncher(), { mode: 0o755 });
  writeFileSync(join(dir, "ak.js"), "placeholder\n");
  const env = home === undefined ? { PATH: path, TERM: "dumb" } : { PATH: path, TERM: "dumb", HOME: home };
  return { result: spawnSync(launcher, args, { encoding: "utf8", env }), script: join(dir, "ak.js") };
}

describe("tools/cursor/install.sh", () => {
  test("the installer text never names sudo", () => {
    expect(readFileSync(install, "utf8")).not.toMatch(/\bsudo\b/);
  });

  test("ensure_home_bun never calls sudo", () => {
    const fx = scratchHome();
    writeFileSync(fx.bun, "#!/bin/sh\necho 1.3.14\n", { mode: 0o755 });
    const result = runFn({ HOME: fx.home, PATH: fx.path }, "ensure_home_bun");
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(fx.sudoLog)).toBe(false);
  });

  test("leaves an existing home bun that is not the pin", () => {
    const fx = scratchHome();
    const body = "#!/bin/sh\necho 1.2.0\n";
    writeFileSync(fx.bun, body, { mode: 0o755 });
    const result = runFn({ HOME: fx.home, PATH: fx.path }, "ensure_home_bun");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain(`leaving ${fx.bun} in place`);
    expect(readFileSync(fx.bun, "utf8")).toBe(body);
    expect(existsSync(fx.sudoLog)).toBe(false);
  });
});

describe("cursor ak launcher", () => {
  test("the launcher pin matches the installer pin", () => {
    const pin = readFileSync(install, "utf8").match(/^PIN=(.+)$/m)?.[1];
    expect(pin).toBe(CURSOR_BUN_PIN);
    expect(cursorAkLauncher()).toContain(`pin=${CURSOR_BUN_PIN}`);
  });

  test("uses $HOME/.bun/bin/bun when PATH has no bun", () => {
    const home = processScratch("ak-cursor-launcher-home-");
    mkdirSync(join(home, ".bun/bin"), { recursive: true });
    writeFakeBun(join(home, ".bun/bin/bun"), CURSOR_BUN_PIN, "HOME");
    const { result, script } = runLauncher(home, noBunPath(), ["--version"]);
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(home, "launcher.out"), "utf8").trim()).toBe(`HOME ${script} --version`);
  });

  test("uses PATH bun when it is the pin", () => {
    const home = processScratch("ak-cursor-launcher-path-");
    mkdirSync(join(home, ".bun/bin"), { recursive: true });
    mkdirSync(join(home, "path-bin"), { recursive: true });
    writeFakeBun(join(home, "path-bin/bun"), CURSOR_BUN_PIN, "PATH");
    writeFakeBun(join(home, ".bun/bin/bun"), "1.2.0", "HOME");
    const { result, script } = runLauncher(home, `${join(home, "path-bin")}:${noBunPath()}`, ["firstmate", "grant"]);
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(home, "launcher.out"), "utf8").trim()).toBe(`PATH ${script} firstmate grant`);
  });

  test("fails when neither PATH bun nor home bun is the pin", () => {
    const home = processScratch("ak-cursor-launcher-fail-");
    mkdirSync(join(home, ".bun/bin"), { recursive: true });
    writeFakeBun(join(home, ".bun/bin/bun"), "1.2.0", "HOME");
    const { result } = runLauncher(home, noBunPath(), ["--version"]);
    expect(result.status).toBe(127);
    expect(result.stderr).toContain(`need bun ${CURSOR_BUN_PIN}`);
    expect(result.stderr).toContain(`${home}/.bun/bin/bun`);
  });

  test("does not fall back to /.bun/bin/bun when HOME is empty", () => {
    for (const home of [undefined, ""]) {
      const { result } = runLauncher(home, noBunPath(), ["--version"]);
      expect(result.status).toBe(127);
      expect(result.stderr).toContain(`need bun ${CURSOR_BUN_PIN} on PATH`);
      expect(result.stderr).not.toContain("/.bun/bin/bun");
    }
  });

  test("resolves the sibling script when $0 has no slash", () => {
    const home = processScratch("ak-cursor-launcher-noslash-");
    mkdirSync(join(home, ".bun/bin"), { recursive: true });
    writeFakeBun(join(home, ".bun/bin/bun"), CURSOR_BUN_PIN, "HOME");
    const dir = join(processScratch("ak-cursor-overlay-noslash-"), "bin");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "ak"), cursorAkLauncher(), { mode: 0o755 });
    writeFileSync(join(dir, "ak.js"), "placeholder\n");
    const result = spawnSync("sh", ["ak", "--version"], {
      encoding: "utf8",
      cwd: dir,
      env: { HOME: home, PATH: `${dir}:/bin:${noBunPath()}`, TERM: "dumb" },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(home, "launcher.out"), "utf8").trim()).toBe(`HOME ${join(dir, "ak.js")} --version`);
  });
});
