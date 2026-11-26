/**
 * Packaged `bin/ak` and Cursor `.cursor/bin/ak` dispatch stock Firstmate verbs.
 *
 * Spawns planBundle binaries, not `runCli`. On main those verbs print doctor
 * usage and exit 2. bind, install and remove keep that refusal.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { loadCatalog } from "../../src/catalog/load.ts";
import { planBundle, type BundleFile } from "../../src/packaging/plan.ts";
import { processScratch, removeProcessDir } from "../helpers/process-tmp.ts";
import { makeTree } from "../helpers/tree.ts";
import { makeBundle, makeProject, REPO } from "./fixture.ts";

const TIMEOUT_MS = 120_000;

function stockHome() {
  return makeTree({
    "bin/fm-brief.sh": "#!/bin/sh\n",
    "bin/fm-spawn.sh": "#!/bin/sh\n",
    "bin/fm-tasks-axi.sh": "#!/bin/sh\n",
  });
}

function writePlan(dest: string, files: Iterable<BundleFile>, keep: (path: string) => boolean) {
  for (const file of files) {
    if (!keep(file.path)) continue;
    const out = join(dest, file.path);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(
      out,
      file.contents,
      file.contents.startsWith("#!") && file.path.endsWith("/ak") ? { mode: 0o755 } : {},
    );
  }
}

interface PackedRun {
  status: number | null;
  stdout: string;
  stderr: string;
}

interface Packed {
  name: string;
  run: (args: readonly string[]) => PackedRun;
}

let entries: Packed[] = [];

beforeAll(() => {
  const { catalog } = loadCatalog(REPO);
  if (catalog === null) throw new Error("no catalog");
  const claude = planBundle({ root: REPO, catalog }, "claude-code", {});
  const cursor = planBundle({ root: REPO, catalog }, "cursor", {});
  if (!claude.files.has("bin/ak") || !cursor.files.has(".cursor/bin/ak") || !cursor.files.has(".cursor/bin/ak.js")) {
    throw new Error("planBundle did not emit bin/ak or .cursor/bin/ak");
  }

  const claudeRoot = processScratch("ak-fm-pkg-claude-");
  writePlan(claudeRoot, claude.files.values(), (path) => path === "bin/ak" || path.startsWith("schemas/"));
  const claudeAk = join(claudeRoot, "bin", "ak");

  const overlayRoot = processScratch("ak-fm-pkg-overlay-");
  writePlan(
    overlayRoot,
    cursor.files.values(),
    (path) => path === ".cursor/bin/ak" || path === ".cursor/bin/ak.js" || path.startsWith(".cursor/schemas/"),
  );
  const overlayAk = join(overlayRoot, ".cursor", "bin", "ak");

  const bunDir = dirname(process.execPath);
  const env = {
    PATH: `${bunDir}:/usr/bin:/bin`,
    HOME: process.env.HOME ?? overlayRoot,
    TERM: "dumb",
  };
  const run = (command: string, args: readonly string[]): PackedRun => {
    const result = spawnSync(command, args, { encoding: "utf8", env });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  };
  entries = [
    {
      name: "claude-code bin/ak",
      run: (args) => run(process.execPath, [claudeAk, ...args]),
    },
    {
      name: "cursor .cursor/bin/ak",
      run: (args) => run(overlayAk, args),
    },
  ];
}, TIMEOUT_MS);

afterAll(() => {
  removeProcessDir();
});

describe("packaged firstmate dispatch", () => {
  test(
    "stock preflight runs from the packaged binaries",
    () => {
      const home = stockHome();
      const project = makeProject();
      const bundle = makeBundle();
      for (const entry of entries) {
        const result = entry.run([
          "firstmate",
          "preflight",
          "--fm-home",
          home,
          "--project",
          project,
          "--host",
          "codex",
          "--bundle-dir",
          bundle,
        ]);
        expect(result.status, `${entry.name}: ${result.stderr}`).not.toBe(2);
        expect(result.stderr, entry.name).not.toContain("Usage: ak doctor");
        expect(result.stderr, entry.name).not.toContain("ak lifecycle");
        expect(result.stdout, entry.name).toContain("stock-firstmate");
      }
    },
    TIMEOUT_MS,
  );

  test(
    "grant runs from the packaged binaries",
    () => {
      const missing = join(processScratch("ak-fm-pkg-grant-"), "absent.json");
      for (const entry of entries) {
        const result = entry.run(["firstmate", "grant", "--binding", missing, "--operation", "review.full"]);
        expect(result.status, `${entry.name}: ${result.stderr}`).toBe(1);
        expect(result.stderr, entry.name).not.toContain("Usage: ak doctor");
        expect(result.stderr, entry.name).not.toContain("ak lifecycle");
        expect(result.stderr, entry.name).toContain("ak firstmate grant: refused: binding");
      }
    },
    TIMEOUT_MS,
  );

  test(
    "grant and status load the binding schema from the packaged root",
    () => {
      const binding = join(processScratch("ak-fm-pkg-schema-"), "empty.json");
      writeFileSync(binding, "{}\n");
      for (const entry of entries) {
        const granted = entry.run(["firstmate", "grant", "--binding", binding, "--operation", "review.full"]);
        expect(granted.status, `${entry.name} grant: ${granted.stderr}`).toBe(1);
        expect(granted.stderr, entry.name).not.toContain("did not compile");
        expect(granted.stderr, entry.name).toContain("must have required property 'schema'");

        const status = entry.run(["firstmate", "status", binding, "complete"]);
        expect(status.status, `${entry.name} status: ${status.stderr}`).toBe(1);
        expect(status.stderr, entry.name).not.toContain("did not compile");
        expect(status.stderr, entry.name).toContain("must have required property 'schema'");
      }
    },
    TIMEOUT_MS,
  );

  test(
    "status and seat-judge run from the packaged binaries",
    () => {
      for (const entry of entries) {
        const status = entry.run(["firstmate", "status"]);
        expect(status.status, `${entry.name} status: ${status.stderr}`).toBe(2);
        expect(status.stderr, entry.name).not.toContain("Usage: ak doctor");
        expect(status.stderr, entry.name).not.toContain("ak lifecycle");
        expect(status.stderr, entry.name).toContain("ak firstmate status: needs");

        const judge = entry.run(["firstmate", "seat-judge"]);
        expect(judge.status, `${entry.name} seat-judge: ${judge.stderr}`).toBe(2);
        expect(judge.stderr, entry.name).not.toContain("Usage: ak doctor");
        expect(judge.stderr, entry.name).not.toContain("ak lifecycle");
        expect(judge.stderr, entry.name).toContain("ak firstmate seat-judge: --fm-home is required");
      }
    },
    TIMEOUT_MS,
  );

  test(
    "bind, install and remove stay refused on the packaged binaries",
    () => {
      for (const entry of entries) {
        for (const args of [
          [
            "firstmate",
            "bind",
            "--fm-home",
            "/tmp",
            "--task-id",
            "t",
            "--project",
            "/tmp",
            "--mode",
            "agent-kit",
            "--binding-out",
            "/tmp/b.json",
          ],
          ["firstmate", "install", "--fm-home", "/tmp"],
          ["firstmate", "remove", "--fm-home", "/tmp"],
        ]) {
          const result = entry.run(args);
          expect(result.status, `${entry.name} ${args[1]}: ${result.stderr}`).toBe(2);
          expect(result.stdout, `${entry.name} ${args[1]}`).toBe("");
          expect(result.stderr, `${entry.name} ${args[1]}`).toContain("Usage: ak doctor");
          expect(result.stderr, `${entry.name} ${args[1]}`).not.toContain("ak lifecycle");
        }
      }
    },
    TIMEOUT_MS,
  );
});
