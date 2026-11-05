import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { processScratch } from "./helpers/process-tmp.ts";

const repo = join(import.meta.dir, "..");
const install = join(repo, "tools/cursor/install.sh");

function systemBun() {
  const dst = "/usr/local/bin/bun";
  if (!existsSync(dst)) return { exists: false, target: "" };
  const link = spawnSync("readlink", [dst], { encoding: "utf8" });
  return { exists: true, target: (link.stdout ?? "").trim() };
}

function runFn(
  env: {
    HOME: string;
    PATH: string;
    CURSOR_AGENT?: string;
    CURSOR_AGENT_CLI_LOCAL_MODE?: string;
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
      CURSOR_AGENT: env.CURSOR_AGENT ?? "",
      CURSOR_AGENT_CLI_LOCAL_MODE: env.CURSOR_AGENT_CLI_LOCAL_MODE ?? "",
    },
  });
  return { status: result.status ?? 1, stderr: result.stderr ?? "" };
}

function scratchHome() {
  const home = processScratch("ak-cursor-install-");
  const trap = join(home, "trap-bin");
  const sudoLog = join(home, "sudo.log");
  mkdirSync(join(home, ".bun/bin"), { recursive: true });
  mkdirSync(trap, { recursive: true });
  writeFileSync(join(trap, "sudo"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${sudoLog}'\nexit 0\n`, { mode: 0o755 });
  return {
    home,
    sudoLog,
    bun: join(home, ".bun/bin/bun"),
    path: `${trap}:${home}/.bun/bin:/usr/bin:/bin`,
  };
}

describe("tools/cursor/install.sh system bun link", () => {
  test("a maintainer machine stays inside HOME, does not call sudo, and prints the skip", () => {
    const before = systemBun();
    const fx = scratchHome();
    writeFileSync(fx.bun, "#!/bin/sh\necho 1.3.14\n", { mode: 0o755 });
    const result = runFn(
      { HOME: fx.home, PATH: `${fx.path}:${process.env.PATH ?? "/usr/bin:/bin"}` },
      "link_system_bun",
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain("skipping /usr/local/bin/bun");
    expect(result.stderr).toContain("not a Cursor cloud worker");
    expect(result.stderr).toContain(`${fx.home}/.bun/bin/bun`);
    expect(existsSync(fx.sudoLog)).toBe(false);
    expect(systemBun()).toEqual(before);
  });

  test("CURSOR_AGENT=1 with CLI local mode and no worker markers does not call sudo", () => {
    const before = systemBun();
    const fx = scratchHome();
    writeFileSync(fx.bun, "#!/bin/sh\necho 1.3.14\n", { mode: 0o755 });
    const result = runFn(
      {
        HOME: fx.home,
        PATH: `${fx.path}:${process.env.PATH ?? "/usr/bin:/bin"}`,
        CURSOR_AGENT: "1",
        CURSOR_AGENT_CLI_LOCAL_MODE: "true",
      },
      "link_system_bun",
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain("skipping /usr/local/bin/bun");
    expect(result.stderr).toContain("not a Cursor cloud worker");
    expect(existsSync(fx.sudoLog)).toBe(false);
    expect(systemBun()).toEqual(before);
  });

  test("off-cloud leaves an existing home bun that is not the pin", () => {
    const fx = scratchHome();
    const body = "#!/bin/sh\necho 1.2.0\n";
    writeFileSync(fx.bun, body, { mode: 0o755 });
    const result = runFn(
      { HOME: fx.home, PATH: `${fx.path}:${process.env.PATH ?? "/usr/bin:/bin"}` },
      "ensure_home_bun",
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain(`leaving ${fx.bun} in place`);
    expect(readFileSync(fx.bun, "utf8")).toBe(body);
    expect(existsSync(fx.sudoLog)).toBe(false);
  });
});
