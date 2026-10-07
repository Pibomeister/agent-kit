/**
 * `ak learn` from the published bundle: the claude-code bundle's files are
 * written to a scratch directory outside any checkout, the way the plugin
 * cache holds them, and its `bin/ak` is run as a subprocess with a scratch
 * HOME and config dir. Nothing here may reach a checkout's roles, templates
 * or catalog, or the operator's home.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadCatalog } from "../../src/catalog/load.ts";
import { loadConfig } from "../../src/learn/core/config.ts";
import { packageRoot } from "../../src/learn/core/roles.ts";
import { run } from "../../src/learn/core/proc.ts";
import { loadEvents } from "../../src/learn/review/events.ts";
import { reviewLedger } from "../../src/learn/review/ledger.ts";
import { planBundle } from "../../src/packaging/plan.ts";
import { gitRepo, projectScratch, removeProjectScratch, removeStartScratch, scratch, startScratch } from "./helpers.ts";

const REPO = join(import.meta.dir, "..", "..");
/** Each call starts bun on a large bundle, which under a loaded full run takes longer than the default 5s. */
const TIMEOUT_MS = 60_000;

let bundle = "";
let codexBundle = "";
afterAll(() => {
  removeProjectScratch();
  removeStartScratch();
});
beforeAll(() => {
  const { catalog } = loadCatalog(REPO);
  if (catalog === null) throw new Error("no catalog");
  bundle = startScratch("ak-bundle-");
  codexBundle = startScratch("ak-codex-bundle-");
  for (const [host, target] of [
    ["claude-code", bundle],
    ["codex", codexBundle],
  ] as const) {
    for (const file of planBundle({ root: REPO, catalog }, host, {}).files.values()) {
      mkdirSync(dirname(join(target, file.path)), { recursive: true });
      writeFileSync(join(target, file.path), file.contents);
    }
  }
}, TIMEOUT_MS);

/** A machine with nothing on it: scratch HOME and config dir, git and bun on PATH, no claude-mem. */
function machine(extra: Record<string, string> = {}, entry = join(bundle, "bin", "ak")) {
  const home = startScratch("ak-home-");
  const env = {
    HOME: home,
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
    CLAUDE_CONFIG_DIR: join(home, ".claude"),
    AK_LEARN_MEM_DB: join(home, "no-claude-mem.db"),
    ...extra,
  };
  const ak = (argv: string[], cwd: string, input?: string) =>
    run([process.execPath, entry, "learn", ...argv], { cwd, env, input, timeoutMs: TIMEOUT_MS });
  return { home, env, ak };
}

function expectMemModeWired(entry: string, source: string): void {
  const { ak, home, env } = machine({}, entry);
  writeFileSync(env.AK_LEARN_MEM_DB, "");
  const result = ak(["setup", "wire", "--host", "claude"], home);
  expect(result.code).toBe(0);
  expect(result.stdout).not.toContain("mode file not shipped");
  expect(JSON.parse(readFileSync(join(home, ".claude-mem", "modes", "code--review-learning.json"), "utf8"))).toEqual(
    JSON.parse(source),
  );
  const settings = readFileSync(join(env.CLAUDE_CONFIG_DIR, "settings.json"), "utf8");
  expect(settings).toContain(`${entry} learn hook session-start`);
  expect(ak(["setup", "verify"], home).stdout).toContain("PASS  claude-mem mode file");
}

describe("ak learn from a bundle outside any checkout", () => {
  test("the package root is the bundle's own directory, never three levels above its bin/", () => {
    expect(packageRoot("/plugins/cache/agent-kit/ak/0.2.0/bin")).toBe("/plugins/cache/agent-kit/ak/0.2.0");
    expect(packageRoot(join(REPO, "src", "learn", "core"))).toBe(REPO);
  });

  test(
    "stats --json runs and prints one JSON object",
    () => {
      const { ak, home } = machine();
      const result = ak(["stats", "--json"], home);
      expect([result.code, result.stderr]).toEqual([0, ""]);
      const stats: unknown = JSON.parse(result.stdout);
      expect(stats).toHaveProperty("cost");
    },
    TIMEOUT_MS,
  );

  test(
    "hooks read their payload from stdin: session-start prints the block, prompt captures a correction",
    () => {
      const { ak, env } = machine();
      const root = gitRepo(join(projectScratch(), "shop"));
      const config = loadConfig(env);
      writeFileSync(reviewLedger(config, root).path("guardrails.md"), "# Guardrails\n\n- [rp-001] read the diff\n");
      const block = ak(["hook", "session-start"], root, JSON.stringify({ cwd: root })).stdout;
      expect(block).toContain("[rp-001] read the diff");
      // The roster never lists the bundle's own skills/: with nothing installed it names no skill.
      expect(block).not.toContain("/ak:");
      expect(ak(["hook", "prompt"], root, JSON.stringify({ cwd: root, prompt: "no, use bun test not npm" })).code).toBe(
        0,
      );
      expect(loadEvents(reviewLedger(config, root)).map((event) => event.source)).toEqual(["correction"]);
    },
    TIMEOUT_MS,
  );

  test(
    "review run hands the judge the shipped role prompt",
    () => {
      const base = scratch();
      const seen = join(base, "prompt");
      writeFileSync(join(base, "judge.sh"), `cat > '${seen}'\nprintf '%s\\n' '{"result":"{}"}'\n`);
      const { ak } = machine({ AK_LEARN_JUDGE: `sh ${join(base, "judge.sh")}` });
      const root = gitRepo(join(projectScratch(), "cafe"));
      ak(["hook", "prompt"], root, JSON.stringify({ cwd: root, prompt: "no, use bun test not npm" }));
      expect(ak(["review", "run", "--repo", root, "--no-github", "--no-mem"], root).code).toBe(0);
      const role = readFileSync(join(REPO, "roles", "learn", "pattern-maintainer", "ROLE.md"), "utf8");
      expect(readFileSync(seen, "utf8")).toContain(role.split("\n").slice(0, 5).join("\n").trim());
    },
    TIMEOUT_MS,
  );

  test(
    "setup wire installs the shipped claude-mem mode from both plugin bundles",
    () => {
      const source = readFileSync(
        join(REPO, "adapters/observation-source/claude-mem/code--review-learning.json"),
        "utf8",
      );
      for (const root of [bundle, codexBundle]) {
        expect(
          readFileSync(join(root, "adapters/observation-source/claude-mem/code--review-learning.json"), "utf8"),
        ).toBe(source);
        expectMemModeWired(join(root, "bin", "ak"), source);
      }
    },
    TIMEOUT_MS,
  );

  test(
    "setup wire installs the embedded claude-mem mode from a standalone bin/ak",
    () => {
      const standalone = startScratch("ak-standalone-");
      const entry = join(standalone, "bin", "ak");
      mkdirSync(dirname(entry), { recursive: true });
      copyFileSync(join(bundle, "bin", "ak"), entry);
      expect(existsSync(join(standalone, "adapters"))).toBe(false);
      const source = readFileSync(
        join(REPO, "adapters/observation-source/claude-mem/code--review-learning.json"),
        "utf8",
      );
      expectMemModeWired(entry, source);
    },
    TIMEOUT_MS,
  );

  test(
    "setup schedule writes a unit under the scratch HOME that runs the bundle's bin/ak",
    () => {
      const { ak, home } = machine();
      const result = ak(["setup", "schedule"], home);
      expect(result.code).toBe(0);
      const written = result.stdout
        .split("\n")
        .filter((line) => line.endsWith(": written"))
        .map((line) => line.slice(0, -": written".length));
      // launchd on macOS, a systemd user unit where systemctl exists; elsewhere the cron line is printed.
      if (process.platform === "darwin" || Bun.which("systemctl") !== null) expect(written.length).toBeGreaterThan(0);
      for (const path of written) expect(path.startsWith(home)).toBe(true);
      const text = [result.stdout, ...written.filter(existsSync).map((path) => readFileSync(path, "utf8"))].join("\n");
      expect(text).toContain(join(bundle, "bin", "ak"));
      expect(text).not.toContain(join(REPO, "src", "cli.ts"));
    },
    TIMEOUT_MS,
  );
});
