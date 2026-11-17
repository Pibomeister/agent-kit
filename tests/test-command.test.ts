import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { processScratch } from "./helpers/process-tmp.ts";

const root = join(import.meta.dir, "..");
const files = [...new Bun.Glob("**/*.test.ts").scanSync({ cwd: join(root, "tests") })]
  .map((file) => `tests/${file}`)
  .toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0));
const heavy = [
  "tests/learn/spans-e2e.test.ts",
  "tests/learn/memory-evals-reflect.test.ts",
  "tests/learn/bundle.test.ts",
  "tests/guard/claude-code.test.ts",
  "tests/packaging.test.ts",
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
      const scratch = processScratch("ak-test-lanes-");
      try {
        // A separate package keeps the checkout's dependency binaries from shadowing the recorder.
        const project = join(scratch, "project");
        for (const file of ["package.json", "tools/test/run.sh", "tools/test/integration-files.txt", ...heavy]) {
          const target = join(project, file);
          mkdirSync(dirname(target), { recursive: true });
          copyFileSync(join(root, file), target);
        }
        const bin = join(project, "node_modules", ".bin");
        const log = join(scratch, "calls");
        mkdirSync(bin, { recursive: true });
        // Capture the executable interface, without recursively running the suite.
        writeFileSync(
          join(bin, "bun"),
          '#!/bin/sh\nprintf "%s\\n" CALL "$@" >> "$TEST_LANE_LOG"\nexit "$TEST_LANE_EXIT"\n',
          { mode: 0o755 },
        );
        const run = spawnSync(process.execPath, ["run", "test"], {
          cwd: project,
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
          expect(call.slice(0, 3)).toEqual(["test", "--max-concurrency=1", "--timeout=30000"]);
          expect(call).toHaveLength(4);
          return call[3]?.replace(/^\.\//, "");
        });
        expect(integrationFiles).toEqual(heavy);
        expect(
          [...ordinaryFiles, ...integrationFiles].toSorted((a = "", b = "") => (a < b ? -1 : a > b ? 1 : 0)),
        ).toEqual(files);
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    });
  }

  // Linux runners ship gawk, which reserves `load`; BSD awk on macOS does not. Run the worker-count
  // awk under each awk the machine has, so a reserved name fails here and not only in CI.
  const awks = ["/usr/bin/awk", Bun.which("gawk")].filter((path): path is string => Boolean(path));
  for (const awk of awks) {
    test(`worker count rule runs under ${awk}`, () => {
      const scratch = processScratch("ak-test-awk-");
      try {
        const project = join(scratch, "project");
        for (const file of ["package.json", "tools/test/run.sh", "tools/test/integration-files.txt", ...heavy]) {
          const target = join(project, file);
          mkdirSync(dirname(target), { recursive: true });
          copyFileSync(join(root, file), target);
        }
        const bin = join(project, "node_modules", ".bin");
        const log = join(scratch, "calls");
        mkdirSync(bin, { recursive: true });
        writeFileSync(join(bin, "bun"), '#!/bin/sh\nprintf "%s\\n" "$@" >> "$TEST_LANE_LOG"\nexit 0\n', {
          mode: 0o755,
        });
        symlinkSync(awk, join(bin, "awk"));
        const { AK_TEST_PARALLEL: _unset, ...inherited } = process.env;
        const env = { ...inherited, TEST_LANE_LOG: log, PATH: `${bin}:${process.env.PATH ?? ""}` };
        const run = spawnSync("sh", [join(project, "tools/test/run.sh")], { cwd: project, env, encoding: "utf8" });
        expect(run.stderr).toBe("");
        expect(run.status).toBe(0);
        const parallel = readFileSync(log, "utf8")
          .split("\n")
          .find((line) => line.startsWith("--parallel="));
        expect(["--parallel=1", "--parallel=2", "--parallel=4"]).toContain(parallel ?? "");
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    });
  }
});
