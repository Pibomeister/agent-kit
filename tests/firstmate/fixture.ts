/**
 * Throwaway Firstmate homes and projects for the firstmate CLI tests.
 *
 * Every home here is a temp git repository standing in for a Firstmate
 * checkout: one commit plays the upstream commit, and two synthetic patches play
 * 0001-agent-kit-mode and 0002-agent-kit-audit. No test reads, writes or even resolves the live
 * Firstmate home; the real-upstream check is recorded separately, against a
 * scratch clone, and says so.
 */
import { cpSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Upstream } from "../../src/firstmate/constants.ts";
import { makeTree } from "../helpers/tree.ts";

export const REPO = join(import.meta.dir, "..", "..");

export function gitIn(cwd: string, ...args: string[]): string {
  const proc = Bun.spawnSync(["git", ...args], {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.invalid",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.invalid",
    },
  });
  if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${proc.stderr.toString()}`);
  return proc.stdout.toString().trim();
}

const ORIGINAL = "fm_dod_block() {\n  echo default\n}\n";
const PATCHED = "fm_dod_block() {\n  echo default\n}\n# agent-kit mode\n";
// 0002 rewrites a line 0001 added, as the real 0002 does, so a check that does not peel the stack fails.
const PATCHED_2 = "fm_dod_block() {\n  echo default\n}\n# agent-kit mode, audited\n";

export interface Home {
  home: string;
  upstream: Upstream;
}

/**
 * A home at a synthetic upstream commit with a synthetic two-patch stack.
 * `patched: true` applies both to the working tree, which is what a maintainer
 * applying 0001 then 0002 does; `"0001"` applies only the first; `false` neither.
 */
function buildHome(patched: boolean | "0001"): Home {
  const home = makeTree({ "bin/fm-dod-lib.sh": ORIGINAL, "config/.keep": "" });
  gitIn(home, "init", "-q", "-b", "main");
  gitIn(home, "add", "-A");
  gitIn(home, "commit", "-q", "-m", "upstream");
  const commit = gitIn(home, "rev-parse", "HEAD");

  // The patches are produced by git itself, so the reverse check is testing
  // real patches rather than hand-written ones that happen to parse.
  const patchDir = mkdtempSync(join(tmpdir(), "ak-fm-patch-"));
  const file = join(home, "bin/fm-dod-lib.sh");
  const stack: Upstream["stack"] = [];
  let before = ORIGINAL;
  for (const [id, after] of [
    ["0001-agent-kit-mode", PATCHED],
    ["0002-agent-kit-audit", PATCHED_2],
  ] as const) {
    writeFileSync(file, before);
    gitIn(home, "add", "-A");
    writeFileSync(file, after);
    const patchFile = join(patchDir, `${id}.patch`);
    writeFileSync(patchFile, `${gitIn(home, "diff", "--no-ext-diff", "--binary")}\n`);
    stack.push({ id, file: patchFile });
    before = after;
  }
  gitIn(home, "reset", "-q");
  writeFileSync(file, patched === true ? PATCHED_2 : patched === "0001" ? PATCHED : ORIGINAL);

  return { home, upstream: { commit, patch: "0001-agent-kit-mode", stack } };
}

// Creating a synthetic home runs git repeatedly to build its upstream commit and patch stack.
// Build each immutable starting state once at module load, then copy it for tests that mutate it.
const HOME_TEMPLATES = {
  patched: buildHome(true),
  firstPatch: buildHome("0001"),
  unpatched: buildHome(false),
};

export function makeHome(opts: { patched: boolean | "0001" }): Home {
  const template =
    opts.patched === true
      ? HOME_TEMPLATES.patched
      : opts.patched === "0001"
        ? HOME_TEMPLATES.firstPatch
        : HOME_TEMPLATES.unpatched;
  const home = realpathSync(mkdtempSync(join(tmpdir(), "ak-fm-home-")));
  cpSync(template.home, home, { recursive: true });
  return { home, upstream: template.upstream };
}

/** A project checkout with a trusted no-mistakes config, as preflight requires. */
function buildProject(noMistakes?: string): string {
  const project = makeTree({
    "src/a.ts": "export const a = 1;\n",
    ".no-mistakes.yaml": noMistakes ?? "commands:\n  test: bun test\nauto_fix:\n  test: 0\n  lint: 0\n  ci: 0\n",
  });
  gitIn(project, "init", "-q", "-b", "main");
  gitIn(project, "add", "-A");
  gitIn(project, "commit", "-q", "-m", "init");
  return project;
}

const PROJECT_TEMPLATE = buildProject();

export function makeProject(noMistakes?: string): string {
  if (noMistakes !== undefined) return buildProject(noMistakes);
  const project = realpathSync(mkdtempSync(join(tmpdir(), "ak-fm-project-")));
  cpSync(PROJECT_TEMPLATE, project, { recursive: true });
  return project;
}

export const LIFECYCLE = [
  "super-scout",
  "super-bound",
  "super-align",
  "super-build",
  "super-verify",
  "super-review",
  "super-ship",
] as const;

/** A built bundle with the lifecycle in it, as `ak build` would leave dist/<host>. */
export function makeBundle(extra: Record<string, string> = {}): string {
  const files: Record<string, string> = {
    "skills/super-ship/references/transport-no-mistakes.md": "# Transport\n",
    "bin/ak-gate.mjs": "// gate\n",
    ...extra,
  };
  for (const id of LIFECYCLE) files[`skills/${id}/SKILL.md`] = `---\nname: ${id}\n---\n`;
  return makeTree(files);
}

export function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ak-fm-dir-"));
  mkdirSync(dir, { recursive: true });
  return dir;
}

export const FIXED_NOW = () => new Date("2026-09-24T12:00:00.000Z");
