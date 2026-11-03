import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import Ajv from "ajv";

import { isDir, isInside, readTextIfPresent, toPosix, walkFiles } from "../util/fs.ts";
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
   * a symlink that realpath's into one of those, a non-empty directory that
   * is not a previous bundle for this host, a previous bundle whose record
   * names a different host, and a previous bundle that still holds entries
   * this host did not write.
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

/** How many extra paths the refuse message names before it stops listing. */
const EXTRA_ENTRY_SAMPLE = 5;

/**
 * Why `--out` may not replace `dest`, or null when it may. Refuse-only: an
 * empty or nonexistent directory, or a previous bundle for this host whose
 * on-disk entries are only what that build wrote, is allowed. Location checks
 * use the realpath, so a symlink cannot hide `/`, `$HOME`, the repository
 * root, or the current directory. `emittedPaths` is the plan about to be
 * written: a legacy record that does not list outputs is allowed only when
 * the directory's top-level names match those paths.
 */
export function outRefusal(
  dest: string,
  host: HostId,
  repoRoot: string,
  emittedPaths?: ReadonlyArray<string>,
): string | null {
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
  const topLevel = readdirSync(target);
  if (topLevel.length === 0) return null;
  const recordPath = join(target, BUILD_RECORD_FILE[host]);
  if (!existsSync(recordPath)) {
    return `--out '${dest}' names a non-empty directory that is not a previous agent-kit bundle for this host (${BUILD_RECORD_FILE[host]})`;
  }
  const record = parseBuildRecord(readTextIfPresent(recordPath) ?? "");
  if (!record.ok) {
    return `--out '${dest}' has an unreadable build record (${BUILD_RECORD_FILE[host]})`;
  }
  if (record.hostId !== host) {
    return `--out '${dest}' holds an agent-kit bundle for host '${record.hostId}', not '${host}'`;
  }
  if (record.outputs !== null) {
    const walked = extraBundleEntries(target, record.outputs);
    if ("inspect" in walked) return `--out '${dest}' could not inspect '${walked.inspect}'`;
    if (walked.extras.length === 0) return null;
    return `--out '${dest}' contains entries not written by the previous agent-kit bundle: ${formatExtras(walked.extras)}`;
  }
  if (emittedPaths === undefined) return null;
  const expected = topLevelNames(emittedPaths);
  const extraTop = topLevel.filter((name) => !expected.has(name)).toSorted();
  if (extraTop.length > 0) {
    return `--out '${dest}' has a legacy build record and top-level entries that are not this host's bundle: ${formatExtras(extraTop)}`;
  }
  const missingTop = [...expected].filter((name) => !topLevel.includes(name)).toSorted();
  if (missingTop.length > 0) {
    return `--out '${dest}' has a legacy build record whose top-level entries do not match this host's bundle: missing ${formatExtras(missingTop)}`;
  }
  return null;
}

const buildRecordValidator = new Ajv({ strict: false }).compile<{ host: { id: string }; outputs?: string[] }>({
  type: "object",
  required: ["host"],
  additionalProperties: true,
  properties: {
    host: {
      type: "object",
      required: ["id"],
      additionalProperties: true,
      properties: { id: { type: "string", minLength: 1 } },
    },
    outputs: { type: "array", items: { type: "string" } },
  },
});

function parseBuildRecord(text: string): { ok: true; hostId: string; outputs: string[] | null } | { ok: false } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false };
  }
  if (!buildRecordValidator(parsed)) return { ok: false };
  return { ok: true, hostId: parsed.host.id, outputs: parsed.outputs === undefined ? null : parsed.outputs };
}

function topLevelNames(paths: ReadonlyArray<string>): Set<string> {
  const names = new Set<string>();
  for (const path of paths) {
    const slash = path.indexOf("/");
    names.add(slash === -1 ? path : path.slice(0, slash));
  }
  return names;
}

/** True when `rel` is a listed output, a directory holding one, or nested under one. */
function listedCovers(rel: string, outputs: ReadonlyArray<string>): boolean {
  for (const out of outputs) {
    if (rel === out || rel.startsWith(`${out}/`) || out.startsWith(`${rel}/`)) return true;
  }
  return false;
}

function isMissing(cause: unknown): boolean {
  return cause instanceof Error && "code" in cause && cause.code === "ENOENT";
}

function extraBundleEntries(
  target: string,
  outputs: ReadonlyArray<string>,
): { extras: string[] } | { inspect: string } {
  const extras: string[] = [];
  const stack = [target];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (dir === undefined) break;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch (cause) {
      // The target root not existing is not an inspect failure; anything else is.
      if (dir === target && isMissing(cause)) return { extras: [] };
      return { inspect: dir };
    }
    for (const name of names) {
      const full = join(dir, name);
      const rel = toPosix(relative(target, full));
      try {
        const st = lstatSync(full);
        // lstat, not stat: a symlink is one extra (or listed) leaf. Following it
        // would walk `/` or recurse on `loop -> .` until the path is too long.
        if (st.isDirectory() && !st.isSymbolicLink()) stack.push(full);
      } catch {
        return { inspect: full };
      }
      if (!listedCovers(rel, outputs)) extras.push(rel);
    }
  }
  return { extras: extras.toSorted() };
}

function formatExtras(entries: ReadonlyArray<string>): string {
  const shown = entries.slice(0, EXTRA_ENTRY_SAMPLE).map((entry) => `'${entry}'`);
  const rest = entries.length - shown.length;
  if (rest <= 0) return shown.join(", ");
  return `${shown.join(", ")}, and ${rest} more`;
}

function outRequiresOneHost(): Issue {
  return error(
    "packaging.out-requires-one-host",
    "ak build",
    "--out writes one bundle directory and needs exactly one --host. Default ak build still writes dist/<host> for every host.",
  );
}

function refuseOut(dest: string, host: HostId, repoRoot: string, emittedPaths?: ReadonlyArray<string>): Issue | null {
  const reason = outRefusal(dest, host, repoRoot, emittedPaths);
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

function outGuard(ctx: CheckContext, options: BuildOptions, emittedPaths?: ReadonlyArray<string>): Issue | null {
  if (options.out === undefined) return null;
  const selected = selectedHosts(options);
  if (selected.length !== 1) return outRequiresOneHost();
  const host = selected[0];
  if (host === undefined) return outRequiresOneHost();
  return refuseOut(bundleOutDir(ctx, host, options), host, ctx.root, emittedPaths);
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
    if (options.out !== undefined) {
      const late = refuseOut(outRoot, plan.host, ctx.root, [...plan.files.keys()]);
      if (late !== null) return { issues: [late], profile };
    }
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
  const plans = planAll(ctx, options);
  if (options.out !== undefined) {
    const plan = plans[0];
    const host = selectedHosts(options)[0];
    if (plan !== undefined && host !== undefined) {
      const dest = canonicalWritePath(bundleOutDir(ctx, host, options));
      const late = refuseOut(dest, host, ctx.root, [...plan.files.keys()]);
      if (late !== null) return [late];
    }
  }

  for (const plan of plans) {
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
