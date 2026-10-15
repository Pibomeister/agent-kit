/**
 * `ak learn setup <verb> --help` must print usage and leave every config file
 * untouched. The check runs the real CLI in a child process whose HOME and
 * host config dirs sit in scratch space, then compares a manifest of that
 * tree and the operator's own hook files.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { run } from "../../src/learn/core/proc.ts";
import { decideSetupArgs } from "../../src/learn/setup/cli.ts";
import { createSetupArea } from "../../src/learn/setup/cli.ts";
import { removeStartScratch, startScratch } from "./helpers.ts";

const CLI = join(import.meta.dir, "..", "..", "src", "cli.ts");
/** One bun process loading the CLI, which under a loaded full run takes longer than the default 5s. */
const TIMEOUT_MS = 60_000;

/** Operator hook files a regressed child would rewrite. The test only stats them. */
const OPERATOR_FILES = [
  ".claude/settings.json",
  ".codex/hooks.json",
  ".factory/settings.json",
  ".grok/hooks/agent-kit-learn.json",
  ".kimi-code/config.toml",
  ".claude-mem/settings.json",
];

function operatorStamp(): string[] {
  return OPERATOR_FILES.map((rel) => {
    const stat = lstatSync(join(homedir(), rel), { throwIfNoEntry: false });
    return stat === undefined ? `${rel} absent` : `${rel} ${stat.mtimeMs} ${stat.size}`;
  });
}

/** A scratch machine. The child receives only this env, never the operator's. */
function isolated() {
  const home = startScratch("ak-setup-help-");
  const claude = join(home, ".claude");
  const mem = join(home, ".claude-mem");
  const codex = join(home, ".codex");
  const factory = join(home, ".factory");
  const grok = join(home, ".grok");
  const kimi = join(home, ".kimi-code");
  const tmp = join(home, "tmp");
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
    TMPDIR: tmp,
    // Keep Bun's platform-specific transpiler cache out of the configuration-write check.
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
    CLAUDE_CONFIG_DIR: claude,
    CLAUDE_MEM_DATA_DIR: mem,
    CODEX_HOME: codex,
    FACTORY_HOME_OVERRIDE: home,
    GROK_HOME: grok,
    KIMI_CODE_HOME: kimi,
    GIT_CEILING_DIRECTORIES: home,
  };
  for (const dir of [tmp, claude, mem, codex, factory, grok, kimi]) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "sentinel"), "keep\n");
  }
  writeFileSync(join(home, "sentinel"), "keep\n");
  return { home, env };
}

/** Relative path, size and content hash of every file under `root`. */
function manifest(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).toSorted()) {
      const path = join(dir, name);
      const stat = lstatSync(path);
      const rel = path.slice(root.length);
      if (stat.isSymbolicLink()) {
        out.push(`link ${rel} ${readlinkSync(path)}`);
        continue;
      }
      if (stat.isDirectory()) {
        walk(path);
        continue;
      }
      const hash = createHash("sha256").update(readFileSync(path)).digest("hex");
      out.push(`${rel} ${stat.size} ${hash}`);
    }
  };
  walk(root);
  return out;
}

function invoke(home: string, env: NodeJS.ProcessEnv, args: readonly string[]) {
  return run([process.execPath, CLI, "learn", "setup", ...args], { cwd: home, env, timeoutMs: TIMEOUT_MS });
}

function usageOf(name: string): string {
  const verb = createSetupArea().verbs[name];
  if (verb === undefined) throw new Error(`missing setup verb ${name}`);
  return verb.usage;
}

describe("setup argument guard", () => {
  test("every flag named in a setup usage line is accepted, and unknown flags are not", () => {
    for (const [name, verb] of Object.entries(createSetupArea().verbs)) {
      for (const match of verb.usage.matchAll(/--([A-Za-z0-9-]+)/g)) {
        const flagName = match[1];
        if (flagName === undefined) continue;
        expect(decideSetupArgs(name, verb.usage, [`--${flagName}`])).toBeNull();
      }
      expect(decideSetupArgs(name, verb.usage, ["--help"])).toEqual({
        code: 0,
        stream: "out",
        lines: [`ak learn ${verb.usage}`],
      });
      const short = decideSetupArgs(name, verb.usage, ["-h"]);
      expect(short === null ? null : short.code).toBe(0);
      expect(decideSetupArgs(name, verb.usage, ["--not-a-real-flag"])).toEqual({
        code: 2,
        stream: "err",
        lines: [`ak learn setup ${name}: unexpected --not-a-real-flag; usage: ak learn ${verb.usage}`],
      });
    }
    expect(
      decideSetupArgs("seed", usageOf("seed"), ["--repo", "/tmp/repo", "--since", "2026-01-01", "--no-github"]),
    ).toBe(null);
    expect(decideSetupArgs("wire", usageOf("wire"), ["--host", "claude", "--no-mem", "--restart-worker"])).toBeNull();
    const helped = decideSetupArgs("wire", usageOf("wire"), ["--no-mem", "--help"]);
    expect(helped === null ? null : helped.code).toBe(0);
    const positional = decideSetupArgs("wire", usageOf("wire"), ["extra"]);
    expect(positional === null ? null : positional.code).toBe(2);
    expect(decideSetupArgs("scope", usageOf("scope"), ["--set", "/tmp/repo", "--clear"])).toBeNull();
  });
});

describe("setup help writes nothing", () => {
  const area = createSetupArea();

  for (const [name, verb] of Object.entries(area.verbs)) {
    test(
      `setup ${name} --help and -h print usage and leave config untouched`,
      () => {
        for (const flag of ["--help", "-h"]) {
          const { home, env } = isolated();
          const before = manifest(home);
          const operator = operatorStamp();
          const result = invoke(home, env, [name, flag]);
          expect({
            code: result.code,
            stdout: result.stdout,
            stderr: result.stderr,
            timedOut: result.timedOut,
          }).toEqual({
            code: 0,
            stdout: `ak learn ${verb.usage}\n`,
            stderr: "",
            timedOut: false,
          });
          expect(manifest(home)).toEqual(before);
          expect(operatorStamp()).toEqual(operator);
        }
      },
      TIMEOUT_MS,
    );

    test.each(["--not-a-real-flag", "--help=x"])(
      `setup ${name} rejects %s and writes nothing`,
      (flag) => {
        const { home, env } = isolated();
        const before = manifest(home);
        const operator = operatorStamp();
        const result = invoke(home, env, [name, flag]);
        expect({
          code: result.code,
          stdout: result.stdout,
          stderr: result.stderr,
          timedOut: result.timedOut,
        }).toEqual({
          code: 2,
          stdout: "",
          stderr: `ak learn setup ${name}: unexpected ${flag}; usage: ak learn ${verb.usage}\n`,
          timedOut: false,
        });
        expect(manifest(home)).toEqual(before);
        expect(operatorStamp()).toEqual(operator);
      },
      TIMEOUT_MS,
    );
  }

  test(
    "setup wire --help still prints usage when a real flag is also present",
    () => {
      const { home, env } = isolated();
      const before = manifest(home);
      const operator = operatorStamp();
      const usage = usageOf("wire");
      const result = invoke(home, env, ["wire", "--no-mem", "--help"]);
      expect(result.code).toBe(0);
      expect(result.stdout).toBe(`ak learn ${usage}\n`);
      expect(result.stderr).toBe("");
      expect(manifest(home)).toEqual(before);
      expect(operatorStamp()).toEqual(operator);
    },
    TIMEOUT_MS,
  );

  test(
    "an intentional setup wire writes only inside the isolated home",
    () => {
      const { home, env } = isolated();
      const before = manifest(home);
      const operator = operatorStamp();
      const result = invoke(home, env, ["wire", "--host", "claude", "--no-mem"]);
      expect(result.code).toBe(0);
      expect(result.timedOut).toBe(false);
      expect(result.stdout).toContain("hook entries added or updated");
      const created = manifest(home).filter((line) => !before.includes(line));
      expect(created.length).toBeGreaterThan(0);
      expect(created.every((line) => line.startsWith("/.claude/"))).toBe(true);
      expect(readFileSync(join(home, ".claude", "settings.json"), "utf8")).toContain("learn hook");
      expect(operatorStamp()).toEqual(operator);
    },
    TIMEOUT_MS,
  );
});

afterAll(removeStartScratch);
