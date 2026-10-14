import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const files = [...new Bun.Glob("**/*.test.ts").scanSync({ cwd: join(root, "tests") })]
  .map((file) => `tests/${file}`)
  .sort();
const heavy = [
  "tests/learn/spans-e2e.test.ts",
  "tests/learn/memory-evals-reflect.test.ts",
  "tests/learn/bundle.test.ts",
  "tests/version-gate.test.ts",
  "tests/catalog-progress.test.ts",
  "tests/kb-adapter.test.ts",
  "tests/firstmate/firstmate.test.ts",
  "tests/firstmate/grant.test.ts",
  "tests/firstmate/status.test.ts",
  "tests/lifecycle/bypass.test.ts",
  "tests/lifecycle/check.test.ts",
  "tests/runner/runner.test.ts",
];

describe("configured test lanes", () => {
  for (const childStatus of [0, 7]) {
    test(`every file runs once, even when child commands exit ${childStatus}`, () => {
      const scratch = mkdtempSync(join(tmpdir(), "ak-test-lanes-"));
      try {
        const bin = join(scratch, "bin");
        const log = join(scratch, "calls");
        mkdirSync(bin);
        // Capture the executable interface, without recursively running the suite.
        writeFileSync(
          join(bin, "bun"),
          '#!/bin/sh\nprintf "%s\\n" CALL "$@" >> "$TEST_LANE_LOG"\nexit "$TEST_LANE_EXIT"\n',
          { mode: 0o755 },
        );
        const run = spawnSync(process.execPath, ["run", "test"], {
          cwd: root,
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH ?? ""}`,
            TEST_LANE_LOG: log,
            TEST_LANE_EXIT: String(childStatus),
          },
          encoding: "utf8",
        });
        expect(run.status).toBe(childStatus === 0 ? 0 : 1);
        const calls = readFileSync(log, "utf8")
          .trimEnd()
          .split("CALL\n")
          .slice(1)
          .map((call) => call.trimEnd().split("\n"));
        const [ordinary, ...integration] = calls;
        expect(ordinary?.[0]).toBe("test");
        const ignored = (ordinary ?? []).filter((_, index) => ordinary?.[index - 1] === "--path-ignore-patterns");
        const ordinaryFiles = files.filter((file) => !ignored.some((pattern) => new Bun.Glob(pattern).match(file)));
        const integrationFiles = integration.map((call) => {
          expect(call.slice(0, 2)).toEqual(["test", "--max-concurrency=1"]);
          expect(call).toHaveLength(3);
          return call[2]?.replace(/^\.\//, "");
        });
        expect(integrationFiles).toEqual(heavy);
        expect([...ordinaryFiles, ...integrationFiles].sort()).toEqual(files);
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    });
  }
});
