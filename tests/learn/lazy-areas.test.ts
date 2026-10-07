/**
 * `ak learn` loads an area only when its command runs. The host calls
 * `ak learn hook …` on every session start, prompt and stop, so the hook path
 * must not import the review, memory, skills, setup or stats commands.
 *
 * The commands run in a fresh process, because this test process has already
 * imported every area through other test files, and the probe reads Bun's
 * module registry (`require.cache`, which lists ES modules too) after each one.
 */
import { afterAll, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { run } from "../../src/learn/core/proc.ts";
import { removeStartScratch, startScratch } from "./helpers.ts";

const LEARN = join(import.meta.dir, "..", "..", "src", "learn");
const AREA_MODULES = ["review/cli.ts", "memory/cli.ts", "skills/cli.ts", "setup/cli.ts", "hooks.ts", "stats.ts"];
const COMMANDS = [
  ["hook", "session-start"],
  ["hook", "prompt"],
  ["hook", "stop"],
  // With no verb this is a usage error: it loads the area to print its verbs and does no work.
  ["review"],
];
/** One bun process loading the learn sources, which under a loaded full run takes longer than the default 5s. */
const TIMEOUT_MS = 60_000;

afterAll(removeStartScratch);

test(
  "the hook commands load only the hook area, and another area loads when its own command runs",
  () => {
    const home = startScratch("ak-home-");
    // The hook payload names a directory outside any repository; `review` ignores stdin.
    const stdin = JSON.stringify({ cwd: home, prompt: "no, use bun test not npm" });
    const probe = join(home, "probe.ts");
    writeFileSync(
      probe,
      [
        `import { runLearn } from ${JSON.stringify(join(LEARN, "cli.ts"))};`,
        "const io = { out: () => {}, err: () => {} };",
        "const steps = [];",
        `for (const argv of ${JSON.stringify(COMMANDS)}) {`,
        `  const code = await runLearn(argv, { cwd: ${JSON.stringify(home)}, io, stdin: ${JSON.stringify(stdin)} });`,
        `  const areas = ${JSON.stringify(AREA_MODULES)}.filter((area) => require.cache[${JSON.stringify(LEARN)} + "/" + area]);`,
        "  steps.push({ argv, code, areas });",
        "}",
        "console.log(JSON.stringify(steps));",
      ].join("\n"),
    );
    const result = run([process.execPath, probe], {
      cwd: home,
      timeoutMs: TIMEOUT_MS,
      env: {
        HOME: home,
        PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
        CLAUDE_CONFIG_DIR: join(home, ".claude"),
        AK_LEARN_MEM_DB: join(home, "no-claude-mem.db"),
        AK_LEARN_DRY_RUN: "1",
        GIT_CEILING_DIRECTORIES: home,
      },
    });
    expect(result.stderr).toBe("");
    const steps: unknown = JSON.parse(result.stdout);
    expect(steps).toEqual([
      { argv: ["hook", "session-start"], code: 0, areas: ["hooks.ts"] },
      { argv: ["hook", "prompt"], code: 0, areas: ["hooks.ts"] },
      { argv: ["hook", "stop"], code: 0, areas: ["hooks.ts"] },
      { argv: ["review"], code: 2, areas: ["review/cli.ts", "hooks.ts"] },
    ]);
  },
  TIMEOUT_MS,
);
