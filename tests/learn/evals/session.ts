/**
 * Shared plumbing for the manual learning-runtime evals: argument lookup, an
 * async spawn with a timeout, scratch space, and the instrument fields every
 * receipt carries. Not a test file.
 */
import { existsSync, mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCatalog } from "../../../src/catalog/load.ts";
import { run } from "../../../src/learn/core/proc.ts";
import { describeInstall, loadInstallConfig } from "../../../src/packaging/install.ts";
import { hasErrors } from "../../../src/validation/types.ts";

/** Variables that make a nested host CLI believe it runs inside the parent session. */
const NESTED_SESSION_VARS = new Set(["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT"]);

/**
 * Process plumbing and network basics every host may inherit; `scripts/eval-local.sh` passes the
 * same proxy and CA names. Locale categories are admitted by prefix below.
 */
const PROCESS_ENV = new Set([
  "PATH",
  "HOME",
  "TMPDIR",
  "SHELL",
  "TERM",
  "LANG",
  "USER",
  "LOGNAME",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
]);

export function option(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

/**
 * The process basics, the variables explicitly declared by one subject adapter, and the names the
 * operator lists in `$AK_EVAL_PASS_ENV` (whitespace-separated, as `scripts/eval-local.sh` reads it).
 * A `CLAUDE_CODE_*` or `EVAL_*` name cannot be opted in: `runSubject` strips those prefixes with
 * `withoutParentSession` after this, keeping only its auth and provider-routing names.
 */
export function cleanEnv(subjectEnv: readonly string[]): Record<string, string> {
  const optIn = (process.env.AK_EVAL_PASS_ENV ?? "").split(/\s+/).filter((name) => name !== "");
  const allowed = new Set([...PROCESS_ENV, ...subjectEnv, ...optIn]);
  const env: Record<string, string> = {};
  for (const key of [...allowed, ...Object.keys(process.env).filter((name) => name.startsWith("LC_"))]) {
    const value = process.env[key];
    if (value !== undefined && !NESTED_SESSION_VARS.has(key)) env[key] = value;
  }
  return env;
}

/** Repository identity every manual-eval receipt needs to make its instrument reproducible. */
export function evalInstrument(root: string, revision: string) {
  const { catalog } = loadCatalog(root);
  if (catalog === null)
    throw new Error(`${root} has no readable catalog.yaml, so the receipt cannot name its install configuration`);
  const install = loadInstallConfig(root, catalog);
  if (hasErrors(install.issues)) {
    const why = install.issues.filter((i) => i.severity === "error").map((i) => `${i.file}: ${i.message}`);
    throw new Error(`${root} has an install configuration the receipt cannot name: ${why.join("; ")}`);
  }
  return {
    revision,
    donors_present: existsSync(join(root, ".donors")),
    install_config: describeInstall(install),
  };
}

/** A fresh git repository in scratch space, with one commit. */
export function scratchRepo(): string {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "ak-eval-")));
  const repo = join(base, "repo");
  mkdirSync(repo);
  run(["git", "init", "-q"], { cwd: repo });
  run(
    [
      "git",
      "-c",
      "user.name=eval",
      "-c",
      "user.email=eval@example.invalid",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "init",
      "--no-gpg-sign",
    ],
    { cwd: repo },
  );
  return repo;
}

export interface AsyncResult {
  code: number;
  stdout: string;
  timedOut: boolean;
}

/** Spawn without blocking, so cases can run in parallel. The child is killed at the timeout. */
export async function runAsync(
  cmd: readonly string[],
  options: { cwd: string; env: Record<string, string>; timeoutMs: number },
): Promise<AsyncResult> {
  const child = Bun.spawn([...cmd], {
    cwd: options.cwd,
    env: options.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  });
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
