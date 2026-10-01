import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative } from "node:path";

/**
 * Reads the runner admin token from a supervisor-only file. The file may not sit under any of the
 * given roots or inside a git checkout or git directory, and must be readable by its owner alone.
 * On a same-user install a deliberately adversarial worker can still read it: this guards against
 * accidental exposure and is not isolation.
 */
export function readAdminToken(path: string, forbiddenRoots: string[]): string {
  const at = realpathSync(path);
  const underRoot = forbiddenRoots.some((root) => {
    const rel = relative(realpathSync(root), at);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  });
  const env = { ...process.env };
  delete env["GIT_DIR"];
  delete env["GIT_WORK_TREE"];
  const probe = Bun.spawnSync(["git", "rev-parse", "--is-inside-work-tree", "--is-inside-git-dir"], {
    cwd: dirname(at),
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (underRoot || (probe.exitCode === 0 && probe.stdout.toString().includes("true")))
    throw new Error(
      "runner admin token file must live outside the Firstmate home, the worker root and any git checkout",
    );
  if ((statSync(at).mode & 0o077) !== 0) throw new Error("runner admin token file must be mode 0600");
  const token = readFileSync(at, "utf8").trim();
  if (token.length < 32) throw new Error("runner admin token must be at least 32 characters");
  return token;
}
