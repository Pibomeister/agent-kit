import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
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

function allowTimeout(home: string) {
  writeFileSync(join(home, "trap-bin", "timeout"), '#!/bin/sh\nshift\nexec "$@"\n', { mode: 0o755 });
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

function linkHostCommands(dir: string, names: readonly string[]) {
  for (const name of names) {
    const run = spawnSync("bash", ["-c", 'command -v "$1"', "_", name], { encoding: "utf8" });
    const resolved = (run.stdout ?? "").trim();
    expect(run.status, `${name}: ${run.stderr}`).toBe(0);
    if (!resolved.startsWith("/")) continue;
    const dest = join(dir, name);
    if (existsSync(dest)) continue;
    symlinkSync(resolved, dest);
  }
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

  test("clone_donors reuses clone.sh and continues when it fails", () => {
    const fx = scratchHome();
    allowTimeout(fx.home);
    const scratch = processScratch("ak-cursor-clone-");
    mkdirSync(join(scratch, "tools/donors"), { recursive: true });
    writeFileSync(join(scratch, "tools/donors/clone.sh"), "#!/bin/sh\necho clone-failed >&2\nexit 1\n", {
      mode: 0o755,
    });
    const result = runFn({ HOME: fx.home, PATH: fx.path }, `ROOT="${scratch}"; clone_donors`);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain("install.sh: warning: donor clone failed; provenance pin check will skip");
  });

  test("clone_donors skips when timeout is not on PATH", () => {
    const fx = scratchHome();
    const scratch = processScratch("ak-cursor-clone-notimeout-");
    mkdirSync(join(scratch, "tools/donors"), { recursive: true });
    const marker = join(scratch, "cloned");
    writeFileSync(join(scratch, "tools/donors/clone.sh"), `#!/bin/sh\nprintf 'ran\\n' > '${marker}'\nexit 0\n`, {
      mode: 0o755,
    });
    const trap = join(fx.home, "trap-bin");
    symlinkSync("/bin/bash", join(trap, "bash"));
    linkHostCommands(trap, ["dirname", "git", "cat", "sh", "bash", "mkdir", "rm", "grep", "id", "env"]);
    const path = `${trap}:${join(fx.home, ".bun/bin")}`;
    const timeoutProbe = spawnSync("bash", ["-c", "command -v timeout"], {
      encoding: "utf8",
      env: { PATH: path, HOME: fx.home },
    });
    expect(timeoutProbe.status).not.toBe(0);
    const result = runFn({ HOME: fx.home, PATH: path }, `ROOT="${scratch}"; clone_donors`);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain(
      "install.sh: warning: timeout is not on PATH; donor clone skipped (no time bound available)",
    );
    expect(existsSync(marker)).toBe(false);
  });

  test("the installer clones donors after bun install --frozen-lockfile", () => {
    const runs = readFileSync(install, "utf8")
      .split("\n")
      .filter((line) => line === "clone_donors" || line === "bun install --frozen-lockfile");
    expect(runs).toEqual(["bun install --frozen-lockfile", "clone_donors"]);
  });

  test("clone_donors bounds the clone with timeout 300", () => {
    const fx = scratchHome();
    const scratch = processScratch("ak-cursor-clone-timeout-");
    const log = join(scratch, "timeout.args");
    mkdirSync(join(scratch, "tools/donors"), { recursive: true });
    writeFileSync(join(scratch, "tools/donors/clone.sh"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    writeFileSync(
      join(fx.home, "trap-bin", "timeout"),
      `#!/bin/sh
printf '%s\\n' "$1" > '${log}'
shift
exec "$@"
`,
      { mode: 0o755 },
    );
    const result = runFn({ HOME: fx.home, PATH: fx.path }, `ROOT="${scratch}"; clone_donors`);
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(log, "utf8").trim()).toBe("300");
  });

  test("clone_donors runs the lock pin clone script", () => {
    const fx = scratchHome();
    allowTimeout(fx.home);
    const scratch = processScratch("ak-cursor-clone-ok-");
    mkdirSync(join(scratch, "tools/donors"), { recursive: true });
    writeFileSync(
      join(scratch, "tools/donors/clone.sh"),
      `#!/bin/sh
echo "GIT_TERMINAL_PROMPT=\${GIT_TERMINAL_PROMPT-unset}" >&2
echo "GIT_HTTP_LOW_SPEED_LIMIT=\${GIT_HTTP_LOW_SPEED_LIMIT-unset}" >&2
echo "GIT_HTTP_LOW_SPEED_TIME=\${GIT_HTTP_LOW_SPEED_TIME-unset}" >&2
if [ -t 0 ]; then echo stdin-tty >&2; else echo stdin-not-tty >&2; fi
echo clone.sh: .donors/donor_one at pin >&2
exit 0
`,
      { mode: 0o755 },
    );
    const result = runFn({ HOME: fx.home, PATH: fx.path }, `ROOT="${scratch}"; clone_donors`);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain("clone.sh: .donors/donor_one at pin");
    expect(result.stderr).toContain("GIT_TERMINAL_PROMPT=0");
    expect(result.stderr).toContain("GIT_HTTP_LOW_SPEED_LIMIT=1000");
    expect(result.stderr).toContain("GIT_HTTP_LOW_SPEED_TIME=30");
    expect(result.stderr).toContain("stdin-not-tty");
    expect(result.stderr).not.toContain("donor clone failed");
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
    const result = spawnSync("/bin/sh", ["ak", "--version"], {
      encoding: "utf8",
      cwd: dir,
      env: { HOME: home, PATH: `${dir}:${noBunPath()}`, TERM: "dumb" },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(home, "launcher.out"), "utf8").trim()).toBe(`HOME ${join(dir, "ak.js")} --version`);
  });
});
