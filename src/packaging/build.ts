import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { isDir, isInside, readTextIfPresent, walkFiles } from "../util/fs.ts";
import type { CheckContext } from "../validation/context.ts";
import { error, type Issue } from "../validation/types.ts";
import { ADAPTATIONS_FILE, loadAdaptationFragments, renderAdaptations } from "../validation/provenance.ts";
import { HOST_IDS, type HostId } from "./hosts.ts";
import { BUILD_RECORD_FILE, isExecutable, planBundle, type BundlePlan, type PlanOptions } from "./plan.ts";

export interface BuildOptions extends PlanOptions {
  hosts?: ReadonlyArray<HostId>;
  /**
   * Replace `dist/<host>` for a single-host write. A relative path is resolved
   * from `process.cwd()`, not the repository root. The directory is replaced
   * wholesale; `outRefusal` refuses `/`, `$HOME` and its ancestors, the
   * repository root and its ancestors, the current directory and its ancestors,
   * a symlink that realpath's into one of those, and a non-empty directory that
   * is not a previous bundle for this host.
   */
  out?: string;
}

export function planAll(ctx: CheckContext, options: BuildOptions): BundlePlan[] {
  return (options.hosts ?? HOST_IDS).map((host) => planBundle(ctx, host, options));
}

function distDir(host: HostId): string {
  return `dist/${host}`;
}

/** Symlinks a kernel would follow before giving up; past this the path cannot be written either. */
const MAX_LINK_HOPS = 40;

/**
 * Where a write to `path` lands: its nearest existing ancestor through
 * `realpath`, with the parts that do not exist yet kept. A dangling symlink is
 * followed, because a write creates its target.
 */
function canonicalWritePath(path: string): string {
  let hops = 0;
  let dir = resolve(path);
  const missing: string[] = [];
  for (;;) {
    try {
      return join(realpathSync(dir), ...missing);
    } catch {
      if (hops < MAX_LINK_HOPS) {
        try {
          const link = readlinkSync(dir);
          hops += 1;
          dir = resolve(dirname(dir), link);
          continue;
        } catch {
          // Not a symlink; walk to the parent.
        }
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return resolve(path);
    missing.unshift(basename(dir));
    dir = parent;
  }
}

/**
 * Why `--out` may not replace `dest`, or null when it may. Refuse-only: an
 * empty or nonexistent directory, or one holding this host's build record, is
 * allowed. Location checks use the realpath, so a symlink cannot hide `/`,
 * `$HOME`, the repository root, or the current directory.
 */
export function outRefusal(dest: string, host: HostId, repoRoot: string): string | null {
  const target = canonicalWritePath(dest);
  if (target === "/") return `--out '${dest}' would replace the filesystem root`;
  const home = process.env.HOME;
  if (home !== undefined && home !== "") {
    const realHome = canonicalWritePath(home);
    if (isInside(realHome, target)) return `--out '${dest}' would replace $HOME or an ancestor of it`;
  }
  if (isInside(canonicalWritePath(repoRoot), target)) {
    return `--out '${dest}' would replace the repository root or an ancestor of it`;
  }
  if (isInside(canonicalWritePath(process.cwd()), target)) {
    return `--out '${dest}' would replace the current directory or an ancestor of it`;
  }
  if (!existsSync(target)) return null;
  if (!isDir(target)) return `--out '${dest}' would replace a file, not a bundle directory`;
  if (readdirSync(target).length === 0) return null;
  if (existsSync(join(target, BUILD_RECORD_FILE[host]))) return null;
  return `--out '${dest}' names a non-empty directory that is not a previous agent-kit bundle for this host (${BUILD_RECORD_FILE[host]})`;
}

function outRequiresOneHost(): Issue {
  return error(
    "packaging.out-requires-one-host",
    "ak build",
    "--out writes one bundle directory and needs exactly one --host. Default ak build still writes dist/<host> for every host.",
  );
}

function refuseOut(dest: string, host: HostId, repoRoot: string): Issue | null {
  const reason = outRefusal(dest, host, repoRoot);
  return reason === null ? null : error("packaging.out-refused", "ak build", reason);
}

/**
 * `planBundle` runs once per host, and most of what it reports is a fact about
 * the source tree rather than about a bundle: a skill with no SKILL.md, an
 * unparseable skill.yaml, a profile naming a skill the catalog does not declare.
 * Each comes back byte-identical from every plan, and a problem that cannot be
 * fixed per target and does not differ per target is one problem -- reporting it
 * once per host doubles the error count that everyone reads as a progress
 * number, and leaves two identical rows that read as a bug in the reporter.
 *
 * Collapsing on the whole diagnostic rather than on the rule is what makes this
 * safe: every genuinely per-target finding names its bundle or its adapter in
 * the file column -- `dist/<host>/...` for dist-missing, dist-stale and
 * dist-extra, `adapters/<host>/...` for an unknown restriction -- so no two of
 * them are ever identical and none is merged away.
 */
function collapseDuplicates(issues: ReadonlyArray<Issue>): Issue[] {
  const seen = new Set<string>();
  const out: Issue[] = [];
  for (const issue of issues) {
    const key = [issue.severity, issue.rule, issue.file, issue.line ?? "", issue.skipped ?? "", issue.message].join(
      "\u0000",
    );
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(issue);
  }
  return out;
}

export interface BuildResult {
  issues: Issue[];
  /**
   * The profile the bundles were planned with, so the command can report the
   * selection that happened rather than working it out a second time. The two
   * derivations had stopped agreeing: the plan recorded `"all"` for a build
   * that named no profile while the command announced the catalog's default.
   */
  profile: string;
}

function bundleOutDir(ctx: CheckContext, host: HostId, options: BuildOptions): string {
  if (options.out === undefined) return join(ctx.root, distDir(host));
  return resolve(options.out);
}

function selectedHosts(options: BuildOptions): ReadonlyArray<HostId> {
  return options.hosts ?? HOST_IDS;
}

function outGuard(ctx: CheckContext, options: BuildOptions): Issue | null {
  if (options.out === undefined) return null;
  const selected = selectedHosts(options);
  if (selected.length !== 1) return outRequiresOneHost();
  const host = selected[0];
  if (host === undefined) return outRequiresOneHost();
  return refuseOut(bundleOutDir(ctx, host, options), host, ctx.root);
}

export function writeBundles(ctx: CheckContext, options: BuildOptions): BuildResult {
  const guarded = outGuard(ctx, options);
  if (guarded !== null) return { issues: [guarded], profile: "all" };
  const plans = planAll(ctx, options);
  const issues = plans.flatMap((plan) => plan.issues);
  const profile = plans.at(-1)?.profile ?? "all";
  // A failure in any host must leave every installed bundle intact.
  if (issues.some((issue) => issue.severity === "error")) return { issues: collapseDuplicates(issues), profile };
  for (const plan of plans) {
    const dest = bundleOutDir(ctx, plan.host, options);
    const outRoot = options.out === undefined ? dest : canonicalWritePath(dest);
    rmSync(outRoot, { recursive: true, force: true });
    for (const file of plan.files.values()) {
      const target = join(outRoot, file.path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, file.contents);
      // chmod rather than a write mode, which the umask would narrow.
      if (isExecutable(file)) chmodSync(target, 0o755);
    }
  }

  return { issues: collapseDuplicates(issues), profile };
}

/** Windows has no executable bit to read, so there every file counts as carrying it. */
function hasExecBit(path: string): boolean {
  return process.platform === "win32" || (statSync(path).mode & 0o111) !== 0;
}

/** Verify dist/ (or `--out`) matches what a build would emit. Writes nothing. */
export function checkBundles(ctx: CheckContext, options: BuildOptions): Issue[] {
  const guarded = outGuard(ctx, options);
  if (guarded !== null) return [guarded];
  const issues: Issue[] = [];

  for (const plan of planAll(ctx, options)) {
    issues.push(...plan.issues);
    const destPath = bundleOutDir(ctx, plan.host, options);
    const dest = options.out === undefined ? destPath : canonicalWritePath(destPath);
    const label = options.out === undefined ? distDir(plan.host) : dest;
    const onDisk = new Set(walkFiles(dest, "."));

    for (const file of plan.files.values()) {
      const actual = readTextIfPresent(join(dest, file.path));
      if (actual === null) {
        issues.push(
          error(
            "packaging.dist-missing",
            `${label}/${file.path}`,
            "Generated by ak build but absent from dist/. Run ak build.",
          ),
        );
        continue;
      }
      onDisk.delete(file.path);
      if (actual !== file.contents) {
        issues.push(
          error(
            "packaging.dist-stale",
            `${label}/${file.path}`,
            "Content differs from what ak build would emit. Run ak build.",
          ),
        );
      }
      if (isExecutable(file) && !hasExecBit(join(dest, file.path))) {
        issues.push(
          error(
            "packaging.dist-not-executable",
            `${label}/${file.path}`,
            "Starts with a shebang under bin/ and lacks the executable bit, so running it fails with Permission denied. Run ak build.",
          ),
        );
      }
    }

    for (const extra of [...onDisk].sort()) {
      issues.push(
        error(
          "packaging.dist-extra",
          `${label}/${extra}`,
          "Present in dist/ but not generated by ak build. Run ak build.",
        ),
      );
    }
  }

  return collapseDuplicates(issues);
}

/**
 * Render provenance/adaptations.yaml from its fragments.
 *
 * This is a source-tree artifact rather than a bundle file: NOTICE, README,
 * AGENTS.md and catalog.yaml all point at the path, so it is generated and
 * committed. It is written before the bundles and independently of them, so a
 * tree whose skills are not yet authored still gets a correct attribution file.
 * Conflicting fragments stop the write: half a merge is worse than none.
 */
export function writeAdaptations(ctx: CheckContext): Issue[] {
  const { rows, issues } = loadAdaptationFragments(ctx.root);
  if (issues.some((i) => i.severity === "error")) return issues.filter((i) => i.severity === "error");

  const target = join(ctx.root, ADAPTATIONS_FILE);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, renderAdaptations(rows));
  return [];
}
