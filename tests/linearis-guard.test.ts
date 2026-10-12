import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(
  local: boolean,
  response = '{"error":"Authentication required, not authenticated"}',
  status = 1,
  warning = "",
  shell = "sh",
  errexit = false,
) {
  const root = mkdtempSync(join(tmpdir(), "ak-linearis-"));
  roots.push(root);
  spawnSync("git", ["init", "-q", root]);
  writeFileSync(join(root, "ak.tracker.yaml"), "backend: linear-linearis\ntoken_file: .linear-token\n");
  writeFileSync(join(root, ".linear-token"), "test-token\n");
  const bin = join(root, local ? "node_modules/.bin" : "global-bin");
  mkdirSync(bin, { recursive: true });
  const executable = join(bin, "linearis");
  writeFileSync(
    executable,
    `#!/bin/sh\nif [ "$1" = --version ]; then echo 2026.8.0; exit 0; fi\nprintf '%s\\n' '${warning}' >&2\nprintf '%s\\n' '${response}'\nexit ${status}\n`,
  );
  chmodSync(executable, 0o755);
  const doc = readFileSync(join(import.meta.dir, "../adapters/tracker/backends/linear-linearis.md"), "utf8");
  const block = /## 3\. Credential and invocation[\s\S]*?```sh\n([\s\S]*?)\n```/.exec(doc)?.[1];
  if (!block) throw new Error("linearis guard block is missing");
  const guard = join(root, "guard.sh");
  writeFileSync(guard, block.replace("<command>", '"$@"'));
  const run = spawnSync(shell, [...(errexit ? ["-e"] : []), guard, "issues", "list"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, PATH: `${join(root, "global-bin")}:${process.env.PATH}`, token_file: ".linear-token" },
  });
  return run;
}

describe("linearis guard", () => {
  test("rejects a global binary even when it is on PATH", () => {
    const run = fixture(false);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("linearis is not installed in this project");
  });

  test("maps the observed auth rejection to needs-input exit 42", () => {
    const run = fixture(true);
    expect(run.status).toBe(42);
    expect(run.stderr).toContain("Authentication required, not authenticated");
  });

  test("keeps stderr warnings out of the result JSON on success", () => {
    const run = fixture(true, '{"issues":[]}', 0, "ExperimentalWarning: fetch");
    expect(run.status).toBe(0);
    expect(run.stdout).toBe('{"issues":[]}\n');
    expect(run.stderr).toContain("ExperimentalWarning: fetch");
  });

  test("maps an auth rejection written to stderr to exit 42", () => {
    const run = fixture(true, "", 1, "Error: No API token found");
    expect(run.status).toBe(42);
  });

  test("retains failure status for unrelated application errors", () => {
    const run = fixture(true, '{"error":"Issue not found"}');
    expect(run.status).toBe(1);
  });

  // A host without zsh reports this test as skipped, not as a pass with no assertion in it.
  test.if(spawnSync("zsh", ["--version"]).status === 0)(
    "keeps success output and authentication exit 42 under zsh",
    () => {
      const success = fixture(true, '{"issues":[]}', 0, "", "zsh");
      expect(success.status).toBe(0);
      expect(success.stdout).toBe('{"issues":[]}\n');
      const rejected = fixture(true, '{"error":"Authentication required, not authenticated"}', 1, "", "zsh");
      expect(rejected.status).toBe(42);
    },
  );

  test("preserves authentication output and exit 42 under errexit", () => {
    for (const shell of ["sh", "bash", "zsh"]) {
      if (spawnSync(shell, ["--version"]).error) continue;
      const rejected = fixture(true, '{"error":"Authentication required, not authenticated"}', 1, "", shell, true);
      expect(rejected.status).toBe(42);
      expect(rejected.stderr).toContain("Authentication required, not authenticated");
    }
  });
});
