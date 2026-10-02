import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "../src/cli.ts";
import {
  BINDING_FILE,
  checkTrackerBinding,
  checkTrackerSecret,
  findProjectRoot,
  loadTrackerBinding,
} from "../src/tracker/binding.ts";
import { compileSchemas } from "../src/validation/schemas.ts";
import { makeTree } from "./helpers/tree.ts";

/**
 * adapters/tracker/CONTRACT.md §5 and ruling `tracker-of-record-falls-back-to-kb`:
 * the binding's shape, and that its secret never reaches git.
 *
 * Every project folder here is a fixture built in a temporary directory. The
 * schemas are this repository's, because they are the thing under test; nothing
 * here runs a tracker CLI or opens a network connection.
 */

const REPO = join(import.meta.dir, "..");

/** A value no message may ever contain: finding it in output means a secret was printed. */
const TOKEN = "lin_api_fixture_secret_4b1d";

const BINDING = `backend: linear-linearis
token_file: .linear-token
defaults:
  team: ENG
`;

/**
 * Git with the settings a fixture commit needs and nothing from the operator's
 * own configuration that could sign, hook or refuse it.
 */
function git(dir: string, ...args: string[]): string {
  return execFileSync(
    "git",
    [
      "-C",
      dir,
      "-c",
      "user.name=fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "core.hooksPath=/dev/null",
      ...args,
    ],
    { encoding: "utf8" },
  );
}

/** Writes the token owner-only, as setup leaves it, so only the permission test sees a loose mode. */
function writeToken(path: string, text = TOKEN): void {
  writeFileSync(path, text);
  chmodSync(path, 0o600);
}

function project(files: Record<string, string>, repo = true): string {
  const dir = realpathSync(makeTree(files));
  for (const name of Object.keys(files)) if (name.endsWith(".linear-token")) chmodSync(join(dir, name), 0o600);
  if (repo) {
    git(dir, "init", "-q");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "--allow-empty", "-m", "fixture");
  }
  return dir;
}

const rules = (dir: string) => checkTrackerBinding(dir, REPO).map((i) => `${i.severity} ${i.rule}`);

describe("the binding schema", () => {
  const validate = compileSchemas(REPO).validatorFor("tracker-binding")!;

  test("is registered and compiles", () => {
    expect(validate).toBeDefined();
  });

  test("a linear-linearis binding with a team, a project and statuses is valid", () => {
    expect(
      validate({
        backend: "linear-linearis",
        token_file: ".linear-token",
        defaults: { team: "ENG", project: "Billing" },
        statuses: { done: "Done" },
      }),
    ).toBe(true);
  });

  test("a token under an unknown top-level key is a schema error, because the root refuses unknown keys", () => {
    expect(validate({ backend: "linear-linearis", token_file: ".t", defaults: { team: "ENG" }, token: TOKEN })).toBe(
      false,
    );
  });

  test("the generic schema names no vendor: any backend id and its own defaults pass it", () => {
    expect(validate({ backend: "some-other-tracker", token_file: ".t", defaults: { board: "7" } })).toBe(true);
  });

  test("token_file cannot leave the folder by its spelling", () => {
    for (const token_file of ["../shared-token", "/home/op/.linearis/token", "a/../../b"]) {
      expect(validate({ backend: "linear-linearis", token_file, defaults: { team: "ENG" } })).toBe(false);
    }
  });

  test("statuses map only the ticket schema's statuses", () => {
    expect(
      validate({
        backend: "linear-linearis",
        token_file: ".t",
        defaults: { team: "ENG" },
        statuses: { triaged: "Triage" },
      }),
    ).toBe(false);
  });
});

describe("loading a binding", () => {
  test("an unbound folder is a note, because the knowledgebase chain covers it", () => {
    const dir = project({}, false);
    const loaded = loadTrackerBinding(dir, REPO);
    expect(loaded.binding).toBeNull();
    expect(loaded.issues.map((i) => `${i.severity} ${i.rule}`)).toEqual(["note tracker.unbound"]);
  });

  test("a binding parses into its fields", () => {
    const dir = project({ [BINDING_FILE]: BINDING }, false);
    expect(loadTrackerBinding(dir, REPO).binding).toEqual({
      backend: "linear-linearis",
      token_file: ".linear-token",
      defaults: { team: "ENG" },
    });
  });

  test("linear-linearis needs a team and reads no other default than project, from its own schema", () => {
    for (const defaults of ["  project: Billing\n", "  team: ENG\n  workspace: x\n"]) {
      const dir = project(
        { [BINDING_FILE]: `backend: linear-linearis\ntoken_file: .t\ndefaults:\n${defaults}` },
        false,
      );
      const issues = loadTrackerBinding(dir, REPO).issues;
      expect(issues.map((i) => i.rule)).toEqual(["tracker.binding-invalid"]);
      expect(issues[0]!.message).toContain("schemas/tracker-backends/linear-linearis.schema.json");
    }
  });

  test("a backend with no document under adapters/tracker/backends is an error", () => {
    const dir = project(
      { [BINDING_FILE]: "backend: some-other-tracker\ntoken_file: .t\ndefaults:\n  board: '7'\n" },
      false,
    );
    const loaded = loadTrackerBinding(dir, REPO);
    expect(loaded.binding).toBeNull();
    expect(loaded.issues.map((i) => `${i.severity} ${i.rule}`)).toEqual(["error tracker.backend-unknown"]);
  });

  test("unparseable YAML is an error, not an unbound folder", () => {
    const dir = project({ [BINDING_FILE]: "backend: [unclosed\n" }, false);
    expect(loadTrackerBinding(dir, REPO).issues.map((i) => i.rule)).toEqual(["tracker.binding-unparseable"]);
  });

  test("a schema failure names the offending key and never its value", () => {
    const dir = project({ [BINDING_FILE]: `${BINDING}token: ${TOKEN}\n` }, false);
    const issues = loadTrackerBinding(dir, REPO).issues;
    expect(issues.map((i) => i.rule)).toEqual(["tracker.binding-invalid"]);
    expect(issues[0]!.message).toContain("token");
    expect(JSON.stringify(issues)).not.toContain(TOKEN);
  });
});

describe("the secret stays in the folder and out of git", () => {
  test("a gitignored, untracked, never-committed token passes clean", () => {
    const dir = project({ [BINDING_FILE]: BINDING, ".gitignore": ".linear-token\n", ".linear-token": `${TOKEN}\n` });
    expect(rules(dir)).toEqual([]);
  });

  test("an absent token refuses: there is no fallback to a global login", () => {
    const dir = project({ [BINDING_FILE]: BINDING, ".gitignore": ".linear-token\n" });
    expect(rules(dir)).toEqual(["error tracker.secret-absent"]);
  });

  test("a blank token is refused like an absent one", () => {
    const dir = project({ [BINDING_FILE]: BINDING, ".gitignore": ".linear-token\n", ".linear-token": " \n\t\n" });
    expect(rules(dir)).toEqual(["error tracker.secret-empty"]);
  });

  test("a token not ignored by a .gitignore in the project is flagged", () => {
    const dir = project({ [BINDING_FILE]: BINDING });
    writeToken(join(dir, ".linear-token"));
    expect(rules(dir)).toEqual(["error tracker.secret-not-ignored"]);
  });

  test("a .gitignore that ignores the token and then un-ignores it with ! does not count", () => {
    const dir = project({ [BINDING_FILE]: BINDING, ".gitignore": ".linear-token\n!.linear-token\n" });
    writeToken(join(dir, ".linear-token"));
    expect(rules(dir)).toEqual(["error tracker.secret-not-ignored"]);
  });

  test("an untracked .gitignore does not count: the next clone has no rule", () => {
    const dir = project({ [BINDING_FILE]: BINDING });
    writeFileSync(join(dir, ".gitignore"), ".linear-token\n");
    writeToken(join(dir, ".linear-token"));
    expect(rules(dir)).toEqual(["error tracker.secret-not-ignored"]);
  });

  test("a rule added to a tracked .gitignore counts only once it is committed", () => {
    const dir = project({ [BINDING_FILE]: BINDING, ".gitignore": "node_modules\n" });
    writeFileSync(join(dir, ".gitignore"), "node_modules\n.linear-token\n");
    writeToken(join(dir, ".linear-token"));
    expect(rules(dir)).toEqual(["error tracker.secret-not-ignored"]);
    git(dir, "add", ".gitignore");
    expect(rules(dir)).toEqual(["error tracker.secret-not-ignored"]);
    git(dir, "commit", "-q", "-m", "ignore the token");
    expect(rules(dir)).toEqual([]);
  });

  test("an unrelated uncommitted edit to .gitignore does not hide a committed rule", () => {
    const dir = project({ [BINDING_FILE]: BINDING, ".gitignore": ".linear-token\n" });
    writeFileSync(join(dir, ".gitignore"), ".linear-token\ndist/\n");
    writeToken(join(dir, ".linear-token"));
    expect(rules(dir)).toEqual([]);
  });

  test("a negation committed after the rule still counts once deleted only from the working tree", () => {
    const dir = project({ [BINDING_FILE]: BINDING, ".gitignore": ".linear-token\n!.linear-token\n" });
    writeFileSync(join(dir, ".gitignore"), ".linear-token\n");
    writeToken(join(dir, ".linear-token"));
    expect(rules(dir)).toEqual(["error tracker.secret-not-ignored"]);
  });

  test("an uncommitted later rule that also matches does not hide the committed one", () => {
    const dir = project({ [BINDING_FILE]: BINDING, ".gitignore": ".linear-token\n" });
    writeFileSync(join(dir, ".gitignore"), ".linear-token\n*-token\n");
    writeToken(join(dir, ".linear-token"));
    expect(rules(dir)).toEqual([]);
  });

  test("an untracked nested .gitignore that also matches does not hide the committed rule", () => {
    const binding = BINDING.replace(".linear-token", "keys/.linear-token");
    const dir = project({ [BINDING_FILE]: binding, ".gitignore": ".linear-token\n" });
    mkdirSync(join(dir, "keys"));
    writeFileSync(join(dir, "keys", ".gitignore"), ".linear-token\n");
    writeToken(join(dir, "keys", ".linear-token"));
    expect(rules(dir)).toEqual([]);
  });

  test("a committed .gitignore larger than the default output buffer is still read", () => {
    const dir = project({ [BINDING_FILE]: BINDING, ".gitignore": `${"# padding\n".repeat(200_000)}.linear-token\n` });
    writeToken(join(dir, ".linear-token"));
    expect(rules(dir)).toEqual([]);
  });

  test("a project in a subdirectory of the repository is checked against its own committed .gitignore", () => {
    const dir = project({ [`app/${BINDING_FILE}`]: BINDING, "app/.gitignore": ".linear-token\n" });
    writeToken(join(dir, "app", ".linear-token"));
    expect(rules(join(dir, "app"))).toEqual([]);
  });

  test("a token path holding ':' is still matched to its .gitignore", () => {
    const binding = BINDING.replace(".linear-token", "keys/a:b");
    const dir = project({ [BINDING_FILE]: binding, "keys/.gitignore": "a:b\n" });
    writeToken(join(dir, "keys", "a:b"));
    expect(rules(dir)).toEqual([]);
  });

  test("a token_file spelled like a pathspec is taken literally", () => {
    // Without --literal-pathspecs, `*` matches the tracked binding file and reads as tracked.
    const binding = BINDING.replace(".linear-token", "'*'");
    const dir = project({ [BINDING_FILE]: binding, ".gitignore": "\\*\n" });
    writeToken(join(dir, "*"));
    expect(rules(dir)).toEqual([]);
  });

  test("GIT_DIR in the caller's environment does not redirect the check", () => {
    // The token is in this repository's history; a check redirected to the clean
    // repository in GIT_DIR would find no history and pass.
    const other = project({ x: "1" });
    const dir = project({ [BINDING_FILE]: BINDING, ".linear-token": TOKEN });
    git(dir, "rm", "-q", "--cached", ".linear-token");
    writeFileSync(join(dir, ".gitignore"), ".linear-token\n");
    git(dir, "add", ".gitignore");
    git(dir, "commit", "-q", "-m", "untrack");
    const saved = process.env["GIT_DIR"];
    process.env["GIT_DIR"] = join(other, ".git");
    try {
      expect(rules(dir)).toEqual(["error tracker.secret-in-history"]);
    } finally {
      if (saved === undefined) delete process.env["GIT_DIR"];
      else process.env["GIT_DIR"] = saved;
    }
  });

  test("a token_file spelled with pathspec magic is not checked as another file", () => {
    // Without the ./ prefix on stdin, check-ignore reads `:(top)tok` as `tok`, which is ignored.
    const binding = BINDING.replace(".linear-token", "':(top)tok'");
    const dir = project({ [BINDING_FILE]: binding, ".gitignore": "tok\n" });
    writeToken(join(dir, ":(top)tok"));
    expect(rules(dir)).toEqual(["error tracker.secret-not-ignored"]);
  });

  test("a token must have exact mode 600", () => {
    const dir = project({ [BINDING_FILE]: BINDING, ".gitignore": ".linear-token\n", ".linear-token": TOKEN });
    chmodSync(join(dir, ".linear-token"), 0o644);
    expect(rules(dir)).toEqual(["error tracker.secret-mode"]);
    chmodSync(join(dir, ".linear-token"), 0o400);
    expect(rules(dir)).toEqual(["error tracker.secret-mode"]);
  });

  test("a history scan that runs out of time is a warning, not a pass", () => {
    const dir = project({ [BINDING_FILE]: BINDING, ".gitignore": ".linear-token\n", ".linear-token": TOKEN });
    const binding = loadTrackerBinding(dir, REPO).binding!;
    // A real `git log` on a one-commit fixture can finish inside any timeout, so the
    // scan is made to hang: a `git` first on PATH sleeps on `log` and defers the rest.
    const bin = mkdtempSync(join(tmpdir(), "ak-slow-git-"));
    writeFileSync(
      join(bin, "git"),
      `#!/bin/sh\nfor a in "$@"; do [ "$a" = log ] && exec sleep 30; done\nexec ${Bun.which("git")} "$@"\n`,
    );
    chmodSync(join(bin, "git"), 0o755);
    const saved = process.env["PATH"];
    process.env["PATH"] = `${bin}:${saved}`;
    let issues;
    try {
      issues = checkTrackerSecret(dir, binding, 200);
    } finally {
      process.env["PATH"] = saved;
    }
    expect(issues.map((i) => `${i.severity} ${i.rule}`)).toEqual(["warning tracker.history-unreadable"]);
    expect(issues[0]!.message).toContain("did not finish");
  });

  test("a local-only exclude does not count, because it protects one machine", () => {
    const dir = project({ [BINDING_FILE]: BINDING });
    writeFileSync(join(dir, ".git", "info", "exclude"), ".linear-token\n");
    writeToken(join(dir, ".linear-token"));
    expect(rules(dir)).toEqual(["error tracker.secret-not-ignored"]);
  });

  test("a tracked token is flagged even when it is also ignored, and so is its commit", () => {
    const dir = project({ [BINDING_FILE]: BINDING, ".gitignore": ".linear-token\n" });
    writeToken(join(dir, ".linear-token"));
    git(dir, "add", "-f", ".linear-token");
    expect(rules(dir)).toEqual(["error tracker.secret-tracked"]);
    git(dir, "commit", "-q", "-m", "leak");
    expect(rules(dir)).toEqual(["error tracker.secret-tracked", "error tracker.secret-in-history"]);
  });

  test("a token removed from the index is still flagged while any commit holds it", () => {
    const dir = project({ [BINDING_FILE]: BINDING, ".linear-token": TOKEN });
    git(dir, "rm", "-q", "--cached", ".linear-token");
    writeFileSync(join(dir, ".gitignore"), ".linear-token\n");
    git(dir, "add", ".gitignore");
    git(dir, "commit", "-q", "-m", "untrack");
    const issues = checkTrackerBinding(dir, REPO);
    expect(issues.map((i) => i.rule)).toEqual(["tracker.secret-in-history"]);
    expect(issues[0]!.message).toContain("rotate");
  });

  test("a token on another branch is still in history", () => {
    const dir = project({ [BINDING_FILE]: BINDING, ".gitignore": ".linear-token\n" });
    const base = git(dir, "rev-parse", "--abbrev-ref", "HEAD").trim();
    git(dir, "checkout", "-q", "-b", "side");
    writeToken(join(dir, ".linear-token"));
    git(dir, "add", "-f", ".linear-token");
    git(dir, "commit", "-q", "-m", "leak on a branch");
    git(dir, "checkout", "-q", base);
    writeToken(join(dir, ".linear-token"));
    expect(rules(dir)).toEqual(["error tracker.secret-in-history"]);
  });

  test("a token file linking outside the folder is not project-local", () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "ak-global-")));
    writeToken(join(outside, "token"));
    const dir = project({ [BINDING_FILE]: BINDING, ".gitignore": ".linear-token\n" });
    symlinkSync(join(outside, "token"), join(dir, ".linear-token"));
    expect(rules(dir)).toEqual(["error tracker.secret-outside-project"]);
  });

  test("outside a git repository the git checks are reported as not run", () => {
    const dir = project({ [BINDING_FILE]: BINDING, ".linear-token": TOKEN }, false);
    expect(rules(dir)).toEqual(["warning tracker.not-a-git-repository"]);
  });

  test("a project in a subdirectory of the repository is checked against that repository", () => {
    const dir = project({ "app/.gitignore": ".linear-token\n", [`app/${BINDING_FILE}`]: BINDING });
    writeToken(join(dir, "app", ".linear-token"));
    expect(rules(join(dir, "app"))).toEqual([]);
  });

  test("no message from any case above prints the token", () => {
    const dir = project({ [BINDING_FILE]: BINDING, ".linear-token": TOKEN });
    expect(JSON.stringify(checkTrackerBinding(dir, REPO))).not.toContain(TOKEN);
  });
});

describe("ak tracker check", () => {
  function run(argv: string[]) {
    const out: string[] = [];
    const err: string[] = [];
    const code = runCli(argv, { cwd: REPO, io: { out: (l) => out.push(l), err: (l) => err.push(l) } });
    return { code, out: out.join("\n"), err: err.join("\n") };
  }

  test("a clean binding exits 0", () => {
    const dir = project({ [BINDING_FILE]: BINDING, ".gitignore": ".linear-token\n", ".linear-token": TOKEN });
    const result = run(["tracker", "check", dir]);
    expect(result.code).toBe(0);
    expect(result.out).toContain("ak tracker check: 0 errors");
  });

  test("a leaked secret exits non-zero, names the rule and prints no token", () => {
    const dir = project({ [BINDING_FILE]: BINDING, ".linear-token": TOKEN });
    const result = run(["tracker", "check", dir]);
    expect(result.code).toBe(1);
    expect(result.out).toContain("tracker.secret-in-history");
    expect(result.out + result.err).not.toContain(TOKEN);
  });

  test("an unbound folder exits 0 with a note", () => {
    const result = run(["tracker", "check", project({}, false)]);
    expect(result.code).toBe(0);
    expect(result.out).toContain("tracker.unbound");
  });

  test("run from a subdirectory, it checks the nearest binding above, up to the repository top", () => {
    const dir = project({
      [BINDING_FILE]: BINDING,
      ".gitignore": ".linear-token\n",
      ".linear-token": TOKEN,
      "src/deep/x.ts": "",
    });
    expect(findProjectRoot(join(dir, "src", "deep"))).toBe(dir);
    const result = run(["tracker", "check", join(dir, "src", "deep")]);
    expect(result.code).toBe(0);
    expect(result.out).not.toContain("tracker.unbound");
  });

  test("the search stops at the repository top: a binding above it is not this project's", () => {
    const outer = realpathSync(makeTree({ [BINDING_FILE]: BINDING }));
    mkdirSync(join(outer, "inner"));
    git(join(outer, "inner"), "init", "-q");
    expect(findProjectRoot(join(outer, "inner"))).toBe(join(outer, "inner"));
    expect(run(["tracker", "check", join(outer, "inner")]).out).toContain("tracker.unbound");
  });

  test("a directory that does not exist is an error, not an unbound folder", () => {
    const missing = join(realpathSync(makeTree({})), "nope");
    expect(existsSync(missing)).toBe(false);
    const result = run(["tracker", "check", missing]);
    expect(result.code).toBe(1);
    expect(result.out).toContain("tracker.project-missing");
  });

  test("a subcommand other than check is a usage error", () => {
    expect(run(["tracker"]).code).toBe(2);
    expect(run(["tracker", "login"]).code).toBe(2);
  });
});

describe("the guarded linearis call", () => {
  const firstShBlock = (text: string): string => {
    const match = /^```sh\n([\s\S]*?)^```$/m.exec(text);
    if (match?.[1] === undefined) throw new Error("no sh block");
    return match[1];
  };

  // Owned executable text contract: linearis-guard.sh executes the backend copy, the plugin ships the reference-pack copy.
  test("the reference pack carries the backend document's form exactly", () => {
    const backend = readFileSync(join(import.meta.dir, "../adapters/tracker/backends/linear-linearis.md"), "utf8");
    const section3 = backend.slice(backend.indexOf("\n## 3."));
    const reference = readFileSync(join(import.meta.dir, "../references/tracker-of-record/REFERENCE.md"), "utf8");
    expect(firstShBlock(reference)).toBe(firstShBlock(section3));
  });
});
