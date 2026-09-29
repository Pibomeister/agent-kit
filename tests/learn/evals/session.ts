/**
 * Shared plumbing for the manual learning-runtime evals: argument lookup, an
 * async spawn with a timeout, and scratch space. Not a test file.
 */
import { existsSync, mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../../../src/learn/core/proc.ts";

/** Variables that make a nested host CLI believe it runs inside the parent session. */
const NESTED_SESSION_VARS = ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT"];

export function option(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

/** The caller's environment minus the nested-session markers. */
export function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !NESTED_SESSION_VARS.includes(key)) env[key] = value;
  }
  return env;
}

/** Repository identity every manual-eval receipt needs to make its instrument reproducible. */
export function evalInstrument(root: string, revision: string) {
  return {
    revision,
    donors_present: existsSync(join(root, ".donors")),
    install_config: existsSync(join(root, "ak.install.yaml")) ? "ak.install.yaml" : "default (no ak.install.yaml)",
  };
}

/** A fresh git repository in scratch space, with one commit. */
export function scratchRepo(): string {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "ak-eval-")));
  const repo = join(base, "repo");
  mkdirSync(repo);
  run(["git", "init", "-q"], { cwd: repo });
  run(["git", "-c", "user.name=eval", "-c", "user.email=eval@example.invalid", "commit", "-q", "--allow-empty", "-m", "init", "--no-gpg-sign"], { cwd: repo });
  return repo;
}

export interface AsyncResult {
  code: number;
  stdout: string;
  timedOut: boolean;
}

/** Spawn without blocking, so cases can run in parallel. The child is killed at the timeout. */
export async function runAsync(cmd: readonly string[], options: { cwd: string; env: Record<string, string>; timeoutMs: number }): Promise<AsyncResult> {
  const child = Bun.spawn([...cmd], { cwd: options.cwd, env: options.env, stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, options.timeoutMs);
  const stdout = await new Response(child.stdout).text();
  const code = await child.exited;
  clearTimeout(timer);
  return { code, stdout, timedOut };
}
