import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
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

function runLink(env: { HOME: string; PATH: string }) {
  const result = spawnSync("bash", ["-c", 'set -euo pipefail\nsource "$INSTALL"\nlink_system_bun\n'], {
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
  return { status: result.status ?? 1, stderr: result.stderr ?? "" };
}

function maintainerHome() {
  const home = processScratch("ak-cursor-install-");
  const trap = join(home, "trap-bin");
  const sudoLog = join(home, "sudo.log");
  mkdirSync(join(home, ".bun/bin"), { recursive: true });
  mkdirSync(trap, { recursive: true });
  writeFileSync(join(home, ".bun/bin/bun"), "#!/bin/sh\necho 1.3.14\n", { mode: 0o755 });
  writeFileSync(join(trap, "sudo"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${sudoLog}'\nexit 0\n`, { mode: 0o755 });
  return {
    home,
    sudoLog,
    path: `${trap}:${home}/.bun/bin:/usr/bin:/bin`,
  };
}

describe("tools/cursor/install.sh system bun link", () => {
  test("a maintainer machine stays inside HOME, does not call sudo, and prints the skip", () => {
    const before = systemBun();
    const fx = maintainerHome();
    const result = runLink({ HOME: fx.home, PATH: `${fx.path}:${process.env.PATH ?? "/usr/bin:/bin"}` });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain("skipping /usr/local/bin/bun");
    expect(result.stderr).toContain("CURSOR_AGENT=1 is unset");
    expect(result.stderr).toContain(`${fx.home}/.bun/bin/bun`);
    expect(existsSync(fx.sudoLog)).toBe(false);
    expect(systemBun()).toEqual(before);
  });
});
