/**
 * The typechecker and the packager, wired into the thing that already runs.
 *
 * `bun test` transpiles and does not typecheck, so until this file existed a
 * type error reached a commit and was found by whoever next ran `tsc` by hand.
 * The gate was deferred once, correctly, because `tsc` was exiting 1 over an
 * in-flight file and a gate that starts red is a gate people learn to skip. It
 * exits 0 over the whole tree now, so the reason has expired.
 *
 * It lives in a test rather than in `package.json`'s `test` script so that it
 * runs however the suite is invoked, and only when the whole suite is invoked --
 * a single-file `bun test tests/foo.test.ts` does not pay for it.
 *
 * Three assertions and not one. "`tsc` exits 0" is true of a tree that
 * typechecks and equally true of a `tsc` that checked nothing, so the exit code
 * is paired with a population check (every file in `src/` and `tests/` is in the
 * checked set) and a positive control (the binary still reports a planted
 * error). Each answers a different way the first one can be a lie.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { processScratch } from "./helpers/process-tmp.ts";

const REPO = resolve(import.meta.dir, "..");
const TSC = join(REPO, "node_modules", ".bin", "tsc");

function tsc(args: string[], cwd = REPO) {
  return spawnSync(TSC, args, { cwd, encoding: "utf8" });
}

/**
 * Every `.ts` file under a directory, repo-relative, in no particular order.
 *
 * `tests/fixtures/` is left out to match `tsconfig.json`'s `exclude`, and for
 * the same reason: a fixture repository is test input that exists to be broken,
 * so its files are not this project's source. The exclusion is spelled here as
 * one directory name rather than read from the config, so that widening the
 * config's `exclude` fails this test instead of silently agreeing with it.
 */
function sourcesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (at: string) => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      if (entry.isDirectory() && relative(REPO, join(at, entry.name)) === join("tests", "fixtures")) continue;
      const path = join(at, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".ts")) out.push(relative(REPO, path));
    }
  };
  walk(join(REPO, dir));
  return out;
}

/**
 * A path in the one spelling this file compares in.
 *
 * `/var` is a symlink to `/private/var` on macOS, so a directory reached
 * through `mktemp -d` has two absolute names and string comparison between
 * them fails while both are correct. Missing paths pass through unchanged:
 * the caller is comparing, not asserting existence.
 */
function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * The repo-relative files `tsc` reports having read, invoked from `cwd`.
 *
 * Both sides are canonicalised before they meet. `REPO` is already resolved --
 * Bun realpaths `import.meta.dir` -- but `tsc` prints paths built from `PWD`,
 * and `spawnSync`'s `cwd` option sets the kernel working directory without
 * rewriting `PWD` in the inherited environment. So invoking the suite through
 * any symlinked path gave two correct sets spelled differently, an empty
 * intersection, and all 78 owned files reported as untypechecked.
 *
 * That is a false alarm whose output is indistinguishable from the real
 * catastrophe this assertion exists to catch, and it fired in a `git archive`
 * extract under `mktemp -d` -- which is how every lane here verifies anything.
 * It was first routed around at the call site, by choosing a non-symlinked
 * extract directory; that left the next caller to pay again, so the comparison
 * is fixed here instead. See the symlink test below, which is the regression
 * control and fails without `canonical`.
 */
function checkedSet(cwd: string): Set<string> {
  const run = tsc(["--noEmit", "--listFiles"], cwd);
  expect(run.status).toBe(0);
  const root = canonical(cwd);
  return new Set(
    run.stdout
      .split("\n")
      .map((line) => canonical(line.trim()))
      .filter((line) => line.startsWith(root))
      .map((line) => relative(root, line)),
  );
}

describe("the tree typechecks, and the typechecker is doing work", () => {
  test("tsc --noEmit reports nothing", () => {
    const run = tsc(["--noEmit"]);
    expect(`${run.stdout}${run.stderr}`.trim()).toBe("");
    expect(run.status).toBe(0);
  });

  test("every file in src/ and tests/ is in the checked set", () => {
    // The population check. A clean typecheck over zero files is byte-identical
    // to a clean typecheck over the whole tree, and `include` is a glob that can
    // silently stop matching a new directory.
    const checked = checkedSet(REPO);

    const owned = [...sourcesUnder("src"), ...sourcesUnder("tests")];
    expect(owned.length).toBeGreaterThan(30);
    expect(owned.filter((file) => !checked.has(file))).toEqual([]);

    // And the exclusion is the one documented in `tsconfig.json`, not a wider
    // one that happens to still satisfy the line above; anything the config
    // started excluding beyond fixtures would drop out of `owned` and pass
    // silently without this. The population here is `src/` and `tests/` only.
    // `tools/oxlint/ratchet.ts` is typechecked too, through the config's
    // `include` and through its import from `tests/lint-tooling.test.ts`, but
    // that import keeps it in `tsc`'s program whether or not `include` names
    // it, so no assertion here could fail on an `include` regression for it.
    expect(owned.filter((file) => file.startsWith("tests/fixtures"))).toEqual([]);
    expect(owned.some((file) => file.startsWith("src/"))).toBe(true);
    expect(owned.some((file) => file.startsWith("tests/"))).toBe(true);
  });

  test("the population check survives being reached through a symlink", () => {
    // The regression control for the paragraph above, and it is a control
    // rather than a repetition: it is the only test here that fails if
    // `canonical` is removed, and it fails in the loud direction -- reporting
    // every owned file as unchecked -- which is what made the original so
    // expensive to read. A gate that is green where the repository lives and
    // red wherever it is verified teaches people to skip it, and this file's
    // own docstring records that happening once already.
    const dir = processScratch("ak-tsc-link-");
    const link = join(dir, "repo");
    symlinkSync(REPO, link);

    const checked = checkedSet(link);
    const owned = [...sourcesUnder("src"), ...sourcesUnder("tests")];
    expect(owned.length).toBeGreaterThan(30);
    expect(owned.filter((file) => !checked.has(file))).toEqual([]);
  });

  test("a planted error is still reported, so exit 0 means something", () => {
    // The positive control, run against a scratch file so the repository is
    // never mutated -- three lanes are in this tree and a test that writes into
    // it would race them.
    const dir = processScratch("ak-tsc-");
    const file = join(dir, "planted.ts");
    writeFileSync(file, 'export const x: number = "not a number";\n');
    const run = tsc(["--noEmit", "--strict", "--types", "", file], dir);
    expect(run.status).not.toBe(0);
    expect(`${run.stdout}${run.stderr}`).toContain("TS2322");
  });
});

/**
 * `ak build --check` is deliberately NOT gated here, and the reason is a finding.
 *
 * It was gated, briefly, and it passed -- because this working tree happened to
 * carry a `dist/` from an earlier build. In a clean `git archive` extract the
 * same command emits 22 `packaging.dist-missing` errors, because `dist/` is
 * generated and `.gitignore`d and therefore absent from every fresh checkout.
 *
 * So it is not a gate. It is a post-build verification whose result is decided
 * by uncommitted local state: green for a developer who has built, red for one
 * who has not, and neither answer is about the tree. AGENTS.md lists it in the
 * pre-commit block beside `bun test` without saying that `ak build` has to
 * precede it, which is the same trap one level up.
 *
 * Gating it properly means building to a scratch directory and checking there,
 * and `ak build` has no output-directory flag today. That is a packaging change
 * and it is reported rather than bodged in here -- a test that ran `ak build`
 * into the repository would write `dist/` during the suite and race the other
 * lanes working in this tree.
 */
