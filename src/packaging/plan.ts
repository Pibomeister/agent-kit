import { join, posix } from "node:path";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";

import { entryBodyPath } from "../catalog/layout.ts";
import { listDirs, readTextIfPresent, walkFiles } from "../util/fs.ts";
import { parseFrontmatter } from "../util/frontmatter.ts";
import { extractRelativeLinks, relativeLinkBetween, resolveFromFile } from "../util/links.ts";
import type { CheckContext } from "../validation/context.ts";
import { error, note, unavailable, type Issue } from "../validation/types.ts";
import { generateHostFrontmatter } from "./frontmatter.ts";
import { CAPABILITY_TABLE_FILE, ceilingFor, loadCapabilityTable, type Ceiling } from "./capability-table.ts";
import { loadHostCapabilities, type HostId, type SkillMode } from "./hosts.ts";
import { INSTALL_FILE, loadInstallConfig, type InstallConfig } from "./install.ts";
import { isUserInvoked, loadSkillManifest } from "./manifest.ts";
import { resolveProfile } from "./profiles.ts";

/** Trees that exist only in the source repository and are never installed. */
const SOURCE_ONLY_PREFIXES = [
  "research/",
  "provenance/",
  "src/",
  "tests/",
  "dist/",
  ".donors/",
  ".work/",
  "node_modules/",
];

/** Where the packager parks a copied shared dependency, preserving its source layout. */
export const SHARED_ROOT = "references/shared";

/**
 * Each host's own manifest, carrying host keys only, at the path that host reads.
 *
 * Keyed by host because it was a single string, and a single string is how one
 * bundle came to be emitted twice under two names: `dist/codex` carried
 * `.claude-plugin/plugin.json`, the other host's directory, and every check
 * passed because both bundles were being measured against the same constant.
 * `adapters/claude-code/CONTRACT.md` §1 and `adapters/codex/CONTRACT.md` §2
 * each give their own path.
 */
export const HOST_MANIFEST_FILE: Record<HostId, string> = {
  "claude-code": ".claude-plugin/plugin.json",
  codex: ".codex-plugin/plugin.json",
};

/**
 * The marketplace entry both host bundles carry. Codex CLI discovers the local
 * marketplace through the same path before resolving `ak@agent-kit`.
 */
const MARKETPLACE_FILE = ".claude-plugin/marketplace.json";

const maintenanceScripts = new Map<string, string | null>();

function maintenanceScript(root: string): string | null {
  const cached = maintenanceScripts.get(root);
  if (cached !== undefined) return cached;
  const script = buildMaintenanceScript(root);
  maintenanceScripts.set(root, script);
  return script;
}

function buildMaintenanceScript(root: string): string | null {
  const source = join(root, "src/maintenance/cli.ts");
  if (!existsSync(source)) return null;
  const scratch = join(root, ".work");
  mkdirSync(scratch, { recursive: true });
  const dir = mkdtempSync(join(scratch, "ak-maintenance-"));
  try {
    const outfile = join(dir, "ak.mjs");
    const result = spawnSync(process.execPath, ["build", source, "--target=bun", `--outfile=${outfile}`], {
      cwd: root,
      encoding: "utf8",
    });
    if (result.status !== 0) throw new Error(result.stderr || "bun build failed");
    return `#!/usr/bin/env bun\n${readFileSync(outfile, "utf8").replace(/^#![^\n]*\n/, "")}`;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The eval corpus directory: where the cases are copied, and what the manifest
 * says they are.
 *
 * One constant for both, because they are one claim. The bundle path and the
 * `experimental.evals` value are the pointer and the thing pointed at, and two
 * literals agree with each other while agreeing with nothing -- which is how
 * one manifest path became two bundles under one name.
 */
const EVAL_DIR = "evals";

/** The npm package manifest, which §5.2 makes a party to two fields of four. */
const PACKAGE_FILE = "package.json";
const CLAUDE_MEM_MODE_FILE = "adapters/observation-source/claude-mem/code--review-learning.json";

/** One term for the summary line, whichever way the authority went missing. */
const PARITY_CHECK = "manifest parity";

/**
 * The two fields `package.json` is a party to, as
 * `<manifest key> -> <the catalog key that feeds it>`.
 *
 * `name` and `description` are deliberately not here.
 * `adapters/codex/CONTRACT.md` §5.2: they "agree between the two manifests and
 * with `catalog.yaml`'s `package.id` and `package.description`, and
 * **`package.json` is not a party to either**" -- package.json names and
 * describes the npm package, a manifest names and describes what the host
 * addresses, and `ak` and `agent-kit` are two names for two objects. A check
 * forcing them equal is satisfiable only by renaming one to suit the check.
 *
 * The donor supports the `version` clause and no other. At
 * `compound-engineering@05c42da:src/release/metadata.ts` the token
 * `compoundPackage.` occurs exactly once, `:283`, comparing `package.json`'s
 * version; each manifest's description is derived and written rather than
 * compared (`:259`, `:291-304`), which is why the donor ships one description
 * in `package.json` and a different one in its manifest, and manifest `name` is
 * compared manifest-to-manifest (`:403`). `license` is this package's own
 * release condition rather than donor practice -- the donor's `package.json`
 * carries no `license` key at all -- and is kept on that footing.
 *
 * This constant previously carried all four and cited
 * `src/release/components.ts`, which does version bookkeeping and holds no
 * parity logic. The wider rule and the citation for it were both wrong, and the
 * check enforcing them is what turned `main` red.
 *
 * The second half is for the message alone: a reader told `version` disagrees
 * should be sent to the catalog field behind it. The comparison reads the
 * emitted object, so a stale citation misdirects without changing a verdict.
 */
const PARITY_FIELDS = [
  ["version", "package.version"],
  ["license", "package.license"],
] as const;

interface HostManifest {
  name: string;
  version: string;
  description?: string;
  author?: { name: string };
  license?: string;
  skills?: string | string[];
  experimental?: { evals: string };
}

/**
 * The field list as the messages spell it, derived rather than written out.
 *
 * Two of the three messages below used to carry `'version' and 'license'` as a
 * literal while the third derived it from `PARITY_FIELDS`. That is the shape
 * this file keeps naming as the defect: an edit to the list updates the derived
 * spelling and leaves the literals stating the old rule, and the one a reader
 * acts on is whichever message their build happened to emit. The literals are
 * exactly what went stale when `1167bca` withdrew the four-field clause.
 */
const PARITY_FIELD_LIST = PARITY_FIELDS.map(([field]) => `'${field}'`).join(" and ");

/**
 * Where this package records what its own build decided, beside that host's
 * manifest.
 *
 * Separate from the host manifest because `claude plugin validate --strict`
 * errors on a key it does not define. Named here rather than spelled out at
 * each use: the previous spelling-it-out is what let a reader-facing message go
 * on naming the host manifest after the record moved out of it.
 *
 * It moved with the manifest rather than staying put. Left behind, the codex
 * bundle would still ship a `.claude-plugin/` directory holding one file --
 * the same defect as before, one file further down, and invisible to any check
 * that asks only about `plugin.json`.
 */
export const BUILD_RECORD_FILE: Record<HostId, string> = {
  "claude-code": ".claude-plugin/ak.json",
  codex: ".codex-plugin/ak.json",
};

/**
 * The licence files every bundle carries at its root, copied verbatim.
 *
 * A licensing obligation rather than bundle tidiness: the MIT donors' licence
 * requires the copyright notice and the permission notice accompany every copy,
 * and `dist/` is the copy that gets distributed. Absence is an `error()` for
 * that reason -- a build that quietly omits them reports success over a
 * distribution that may not lawfully be distributed, which is the worst shape
 * this package has a name for.
 *
 * Emitted from here, once, for every host rather than per adapter. Both host
 * contracts specify the same two names at the same place
 * (`adapters/claude-code/CONTRACT.md` §1, `adapters/codex/CONTRACT.md` §2), and
 * two bundles disagreeing about their own licensing is the defect this package
 * has already produced once in a different field.
 */
const LICENCE_FILES = ["NOTICE", "LICENSE"];

const GATE_SOURCE = "src/lifecycle/gate.ts";
/** The line of gate.ts the bundled copy carries its host vocabulary in: a bundle has no `adapters/` to read. */
const GATE_ADAPTER_IDS = "const BUNDLED_ADAPTER_IDS: readonly string[] = [];";
export const GATE_FILE = "bin/ak-gate.mjs";
/** The skills whose text runs `../../bin/ak-gate.mjs`; a bundle with any of them carries the gate. */
const GATE_SKILLS = [
  "super-align",
  "super-bound",
  "super-build",
  "super-verify",
  "super-review",
  "super-ship",
  "verify",
];

/** gate.ts with its types stripped: it imports only `node:` built-ins, so the output runs under plain node. */
function gateScript(source: string, adapterIds: readonly string[]): string {
  const js = new Bun.Transpiler({ loader: "ts", target: "node" }).transformSync(
    source.replace(GATE_ADAPTER_IDS, `${GATE_ADAPTER_IDS.slice(0, -3)}${JSON.stringify(adapterIds)};`),
  );
  return `// Generated by ak build from ${GATE_SOURCE}. Do not edit. Run it with no arguments for usage.\n${js}`;
}

export interface BundleFile {
  /** Path inside dist/<host>/. */
  path: string;
  contents: string;
  /** Repo-relative source, when the file was copied rather than generated. */
  source?: string;
}

export interface HostDecision {
  skill: string;
  mode: SkillMode;
  rejected: string[];
  unenforceable: string[];
}

export interface BundlePlan {
  host: HostId;
  /** The profile applied, or `"all"`. Always set: every plan applied one. */
  profile: string;
  files: Map<string, BundleFile>;
  decisions: HostDecision[];
  issues: Issue[];
}

export interface PlanOptions {
  profile?: string;
}

function isSourceOnly(path: string): boolean {
  return SOURCE_ONLY_PREFIXES.some((prefix) => path.startsWith(prefix));
}

function publishedPathFor(sourcePath: string, includedSkillDirs: ReadonlySet<string>): string | null {
  const skillDir = /^skills\/([^/]+)\//.exec(sourcePath)?.[1];
  if (skillDir !== undefined) return includedSkillDirs.has(skillDir) ? sourcePath : null;
  if (isSourceOnly(sourcePath)) return null;
  return posix.join(SHARED_ROOT, sourcePath);
}

/**
 * Rewrite every relative reference in `text` so it resolves inside the bundle,
 * pulling each referenced file in as a dependency. Returns the rewritten text
 * and the source paths that must also be copied.
 */
function rewriteLinks(
  sourcePath: string,
  publishedPath: string,
  text: string,
  includedSkillDirs: ReadonlySet<string>,
  file: string,
): { text: string; dependencies: string[]; issues: Issue[] } {
  const issues: Issue[] = [];
  const dependencies: string[] = [];
  let out = text;

  for (const link of extractRelativeLinks(text)) {
    const resolved = resolveFromFile(sourcePath, link.target);
    if (resolved === null) continue; // checkSourceLinks owns escaping references.

    const targetPublished = publishedPathFor(resolved, includedSkillDirs);
    if (targetPublished === null) {
      issues.push(
        error(
          "packaging.not-bundleable",
          file,
          `Reference '${link.target}' resolves to '${resolved}', which is never installed. An installed skill may not reference a source-tree-only path or an excluded skill.`,
          link.line,
        ),
      );
      continue;
    }

    dependencies.push(resolved);
    const wanted = relativeLinkBetween(publishedPath, targetPublished);
    if (wanted === link.target) continue;
    const anchor = link.anchor === undefined ? "" : `#${link.anchor}`;
    const replacement = link.raw.replace(`${link.target}${anchor}`, `${wanted}${anchor}`);
    out = out.split(link.raw).join(replacement);
  }

  return { text: out, dependencies, issues };
}

/**
 * The three modes ordered by how much of a skill the package exposes.
 *
 * A `Record<SkillMode, number>` rather than an index into `SKILL_MODES`,
 * because that constant's declaration order is an enum's order and nothing
 * documents it as a ranking -- a fourth value appended there would silently
 * become the most autonomous thing in the package. Written exhaustively here,
 * a fourth value fails to compile instead.
 */
const AUTONOMY_RANK: Record<SkillMode, number> = { autonomous: 2, guided: 1, manual: 0 };

function autonomyRank(mode: SkillMode): number {
  return AUTONOMY_RANK[mode];
}

/**
 * Why the ceiling is where it is, in the terms the reader has to act on.
 *
 * The two cases take different fixes and are never merged into one sentence: a
 * capability the host withholds means the row's mode is wrong, and a
 * capability §3 does not mention means either the contract is missing a row or
 * `requires[]` has a typo in it. Only the blocking capabilities are named --
 * listing everything the skill requires would bury the one at fault in a list
 * of the ones that are fine.
 */
function ceilingReason(ceiling: Ceiling): string {
  const list = (caps: string[]) => caps.map((c) => `'${c}'`).join(", ");
  const parts: string[] = [];
  if (ceiling.blocking.length > 0) {
    const them = ceiling.blocking.length === 1 ? "it" : "them";
    parts.push(
      `${CAPABILITY_TABLE_FILE} §3 gives ${list(ceiling.blocking)} a status no host in this package supplies, and no adapter's contract supplies ${them} failing closed, so an autonomous run would proceed with ${them} silently absent.`,
    );
  }
  if (ceiling.unknown.length > 0) {
    parts.push(
      `${CAPABILITY_TABLE_FILE} §3 states no status for ${list(ceiling.unknown)}, so nothing in this package says any host supplies ${ceiling.unknown.length === 1 ? "it" : "them"}; add the row to §3, or correct the spelling in requires[].`,
    );
  }
  if (ceiling.detached.length > 0) parts.push(detachedReason(ceiling));
  return parts.join(" ");
}

/**
 * The third case, which takes a third fix: attach the adapter.
 *
 * Named per capability with the adapters that would supply it, because the
 * reader acts on the adapter id -- it is what goes in `attached:` -- and a
 * capability name alone sends them to find it.
 */
function detachedReason(ceiling: Ceiling): string {
  const quoted = (ids: string[]) => ids.map((a) => `'${a}'`).join(" or ");
  const plain = ceiling.detached.filter((d) => d.fallsBackOn === undefined);
  const parts: string[] = [];
  if (plain.length > 0) {
    const each = plain.map(({ capability, adapters }) => `'${capability}' (supplied by ${quoted(adapters)})`);
    parts.push(
      `${CAPABILITY_TABLE_FILE} §3 marks ${each.join(", ")} as not provided by the host, and ${INSTALL_FILE} attaches no adapter that supplies ${plain.length === 1 ? "it" : "them"}; add the adapter to its attached: list to package this skill at its declared mode (ruling \`fail-closed-adapter-lifts-ceiling\`).`,
    );
  }
  // The second shape: the supplier is attached, but with no backend configured
  // its refusal is borrowed from a capability this install does not have.
  for (const { capability, adapters, fallsBackOn } of ceiling.detached) {
    if (fallsBackOn === undefined) continue;
    const attach = fallsBackOn.adapters.length > 0 ? `, or attach ${quoted(fallsBackOn.adapters)}` : "";
    parts.push(
      `'${capability}' is supplied by ${quoted(adapters)}, which ${INSTALL_FILE} configures no backend for, and with none it falls back on '${fallsBackOn.capability}', which neither the host nor an attached adapter supplies; configure the backend under its ${adapters[0]}: key${attach}, to package this skill at its declared mode (ruling \`tracker-of-record-falls-back-to-kb\`).`,
    );
  }
  return parts.join(" ");
}

export function planBundle(ctx: CheckContext, host: HostId, options: PlanOptions): BundlePlan {
  const { root, catalog } = ctx;
  const issues: Issue[] = [];
  const files = new Map<string, BundleFile>();
  const decisions: HostDecision[] = [];

  const capabilities = loadHostCapabilities(root, host);
  issues.push(...capabilities.issues);

  // Once per plan, not once per skill: a tree with no contract would otherwise
  // report the same unavailable check for every skill in the bundle, and the
  // summary's "1 check unavailable" would become a count of skills.
  const capabilityTable = loadCapabilityTable(root);
  issues.push(...capabilityTable.issues);

  // Once per plan for the same reason, and beside the table because the two
  // are the ceiling's inputs: what the host supplies, and what the attached
  // adapters add to it.
  const install = loadInstallConfig(root, catalog);
  issues.push(...install.issues);

  const membership = resolveProfile(root, catalog, options.profile);
  issues.push(...membership.issues);

  /**
   * A skill the catalog has not authored yet is excluded from the bundle, not
   * a reason the bundle cannot be built.
   *
   * Treating a missing body as a packaging error meant `ak build` could emit
   * nothing until the last of the declared skills was written: 33 errors that
   * said nothing about the bundle and blocked every release before the final
   * one. `status` is the catalog's own statement about what exists, so it
   * decides membership, and a body that is genuinely missing from an
   * `authored` skill is still an error below.
   *
   * Keyed on the catalog rather than on whether a file is present, which is
   * the difference between an exclusion and a silent drop: a body sitting in
   * the tree under a `contract` entry is excluded too, and the author hears
   * about it from `catalog.status-behind-body`. Built in catalog order because
   * this list reaches `.claude-plugin/plugin.json`, whose bytes `ak build
   * --check` compares.
   */
  const selected = new Set(membership.skills);
  const included = new Set<string>();
  const excluded: Array<{ skill: string; reason: string }> = [];
  for (const entry of catalog.bySection("skills")) {
    if (!selected.has(entry.id)) continue;
    if (entry.status === "authored") {
      included.add(entry.id);
      continue;
    }
    excluded.push({ skill: entry.id, reason: `status: ${entry.status}` });
  }

  /**
   * Excluding every skill does not produce a small bundle, it produces no
   * bundle -- a directory holding its own manifest and nothing to install.
   * Reporting success over that would be the defect the exclusion was meant to
   * remove, wearing a green run instead of an error count, so a bundle with
   * nothing left in it fails.
   *
   * This is also what keeps the exclusion an unblocking change: the build goes
   * green on the first authored skill rather than on the last.
   */
  if (included.size === 0 && excluded.length > 0) {
    issues.push(
      error(
        "packaging.empty-bundle",
        "catalog.yaml",
        `Every skill selected for this bundle is excluded, so it would contain no skills at all: ${excluded.map((e) => e.skill).join(", ")}. A bundle is emitted once at least one selected skill is authored.`,
      ),
    );
  }

  /**
   * Said out loud, because the build record is a file nobody opens on a green
   * run and a bundle quietly missing most of its skills is exactly the failure
   * this package keeps finding elsewhere.
   *
   * The filename is written once and used for both the issue's `file` and the
   * sentence that sends a reader there. It was written twice before, and when
   * the `ak` block moved out of the host manifest into `ak.json` both copies
   * were left naming the manifest -- a note pointing at a file that no longer
   * carried what the note promised it did.
   */
  if (excluded.length > 0) {
    issues.push(
      note(
        "packaging.excluded-unauthored",
        BUILD_RECORD_FILE[host],
        `${excluded.length} skill(s) are excluded from this bundle because catalog.yaml does not declare them authored: ${excluded.map((e) => e.skill).join(", ")}. The exclusion and its reason are recorded in ${BUILD_RECORD_FILE[host]}.`,
      ),
    );
  }

  const ordered = catalog.bySection("skills").filter((e) => included.has(e.id));
  const emitted: string[] = [];
  const pending: Array<{ source: string; published: string }> = [];

  for (const entry of ordered) {
    const bodyPath = entryBodyPath("skills", entry.id);
    const body = readTextIfPresent(join(root, bodyPath));
    if (body === null) {
      issues.push(
        error(
          "packaging.skill-body-missing",
          bodyPath,
          `Skill '${entry.id}' is included in the bundle but has no ${bodyPath}.`,
        ),
      );
      continue;
    }

    const manifest = loadSkillManifest(root, entry.id);
    if (manifest.parseError !== undefined) {
      issues.push(error("packaging.skill-yaml-unparseable", `skills/${entry.id}/skill.yaml`, manifest.parseError));
    }

    for (const adapter of manifest.duplicateHosts) {
      issues.push(
        error(
          "packaging.duplicate-host-row",
          `skills/${entry.id}/skill.yaml`,
          `packaging.hosts[] declares adapter '${adapter}' more than once, so which row decides this skill's mode is whichever the packager reached first. schemas/skill.schema.json puts no uniqueness constraint on the list, so ak validate passes it; keep one row per adapter.`,
        ),
      );
    }

    /**
     * The mode this skill runs in here, from its own row for this host.
     *
     * `manual` when it declares no row for this host, which is the
     * conservative end: neither contract says what an undeclared host gets, and
     * a skill that has not been thought about on a host is not one to expose
     * more of. An unrecognised `mode` lands here too -- `loadSkillManifest`
     * only accepts the schema's three, and `ak validate` reports the rest.
     *
     * The cap is `adapters/claude-code/CONTRACT.md` §4 with the input it always
     * should have had: "A host that cannot enforce a restriction an autonomous
     * run requires **exposes the affected skill in guided/manual mode and
     * rejects autonomous mode.**" What an autonomous run requires is
     * `requires[]`, and what the host supplies is §3's table, so those two are
     * the rule's terms and the ceiling is computed from them.
     *
     * Two earlier readings of this sentence stood here and neither could come
     * out false for the right reason. The first compared
     * `autonomy.requires_enforced`, a key `schemas/skill.schema.json` forbids
     * outright, against `capabilities.enforces`, a set drawn from a different
     * enum: two halves that never met, and a decision that came out `manual`
     * for every skill in every bundle. The second keyed the downgrade on
     * whether `unsupported` was non-empty -- and `unsupported` is prose, so
     * that fired on whether an author had written a sentence rather than on
     * anything the host withholds. A skill naming three unenforceable semantics
     * and requiring nothing the host lacks was capped; one naming none and
     * requiring `kb-write` was not.
     *
     * `unsupported` keeps the job it can do. It is a declaration a reader of
     * the installed skill sees, emitted into the body's frontmatter below, and
     * it is not an input to this decision.
     */
    const row = manifest.hosts[host];
    const declaredMode: SkillMode = row?.mode ?? "manual";
    const unenforceable = row?.unsupported ?? [];

    /**
     * `min(declared, ceiling)`, and an error when the declaration was above it.
     *
     * Corrected *and* reported, for the reason `packaging.u-skill-not-manual`
     * gives a few lines down and `adapters/codex/CONTRACT.md` §3.1 states
     * outright: the declaration is "the record that the weakening was noticed
     * rather than absorbed", so a bundle quietly corrected leaves a skill.yaml
     * in the tree stating a mode the packager will not honor with nothing
     * pointing at it -- which is the weakening absorbed.
     *
     * A null ceiling is not a permissive one. The table was unavailable, which
     * `loadCapabilityTable` has already reported as a blocking skip, and this
     * leaves the declared mode alone rather than correcting it on the strength
     * of a ceiling nobody computed.
     *
     * A note instead of the error when the only thing holding the skill down
     * is an adapter this install did not attach. The row is then not wrong: it
     * states the mode the skill runs in wherever the adapter is attached, which
     * is the default, and `ak.install.yaml` chose otherwise for this install --
     * a choice about one machine, recorded in a file the tree does not carry,
     * so an error would fail the tree for a decision nobody can fix in it. The capping still happens and is still
     * said out loud: the note names the capability and the adapter that would
     * lift it (ruling `fail-closed-adapter-lifts-ceiling`).
     */
    const ceiling = ceilingFor(manifest.requires, capabilityTable, install.supply);
    let mode: SkillMode = declaredMode;
    const onlyDetached = ceiling.blocking.length === 0 && ceiling.unknown.length === 0;
    if (ceiling.mode !== null && autonomyRank(declaredMode) > autonomyRank(ceiling.mode) && onlyDetached) {
      mode = ceiling.mode;
      issues.push(
        note(
          "packaging.mode-capped",
          `skills/${entry.id}/skill.yaml`,
          `'${entry.id}' declares mode '${declaredMode}' for adapter '${host}' and is packaged '${mode}' in this install. ${detachedReason(ceiling)}`,
        ),
      );
    } else if (ceiling.mode !== null && autonomyRank(declaredMode) > autonomyRank(ceiling.mode)) {
      mode = ceiling.mode;
      issues.push(
        error(
          "packaging.mode-above-ceiling",
          `skills/${entry.id}/skill.yaml`,
          `'${entry.id}' declares mode '${declaredMode}' for adapter '${host}', above the '${ceiling.mode}' its own requires[] allows. ${ceilingReason(ceiling)} adapters/claude-code/CONTRACT.md §4: a host that cannot enforce what an autonomous run requires exposes the skill in guided/manual mode and rejects autonomous mode. The bundle packages it '${mode}' regardless; declare '${ceiling.mode}' or less in the row, or drop the capability from requires[].`,
        ),
      );
    }

    /**
     * `adapters/codex/CONTRACT.md` §3.1, keyed on the capability rather than on
     * the host's name.
     *
     * §3.1 states a property of the bundle, not advice about what to declare:
     * "Every U skill's `packaging.hosts[]` entry for `adapter: codex` records
     * this explicitly: `mode: manual`". On a host where model invocation is not
     * suppressed, a U skill exposed as anything else is one the model may start
     * on a host that has not been told not to -- and a human having asked is
     * that skill's whole protection there.
     *
     * The premise §3.1 names is that the package "does not emit" the host's
     * suppression key, so the host does not enforce it, and that is what is
     * tested. Keyed on `host === "codex"` this would be a rule that happens to
     * be right about the two hosts that exist and goes on firing at codex after
     * its bundle starts enforcing suppression. `enforces` rather than
     * `HOST_FRONTMATTER_KEYS` because emitting the key and honoring it are
     * different claims, and the one that protects the skill is the second.
     *
     * The bundle is corrected AND the declaration is reported. Correcting alone
     * would leave three skill.yaml files saying `guided` with nothing pointing
     * at them, and §3.1's own reason for requiring the declaration is that it
     * is "the record that the weakening was noticed rather than absorbed" -- a
     * row that says `guided` here is the weakening absorbed.
     */
    const suppressible = capabilities.enforces.has("no-model-invocation");
    if (!suppressible && isUserInvoked(entry, manifest) && mode !== "manual") {
      mode = "manual";
      issues.push(
        error(
          "packaging.u-skill-not-manual",
          `skills/${entry.id}/skill.yaml`,
          `'${entry.id}' is a U skill and its packaging.hosts[] row for adapter '${host}' declares mode '${declaredMode}'. ${host} does not enforce no-model-invocation, so adapters/codex/CONTRACT.md §3.1 requires 'mode: manual' with the unsuppressed model invocation named in 'unsupported'. The bundle packages it manual regardless; fix the row so the declaration records the weakening instead of contradicting it.`,
        ),
      );
    }

    // Only an actual refusal. A skill that asked for guided and got guided has
    // had nothing rejected, and recording one would make `autonomy_rejected` a
    // list of every skill that named an unenforceable semantic -- which is most
    // of them -- and stop it meaning that a claim was refused.
    const rejected = mode === declaredMode ? [] : [declaredMode];
    decisions.push({ skill: entry.id, mode, rejected, unenforceable });

    const canonical = parseFrontmatter(body);
    const generated = generateHostFrontmatter(entry, canonical, manifest, mode, unenforceable, host);
    const rewritten = rewriteLinks(bodyPath, bodyPath, canonical.body, included, bodyPath);
    issues.push(...rewritten.issues);

    files.set(bodyPath, { path: bodyPath, contents: `${generated.text}${rewritten.text}`, source: bodyPath });
    emitted.push(entry.id);
    for (const dep of rewritten.dependencies) {
      const published = publishedPathFor(dep, included);
      if (published !== null) pending.push({ source: dep, published });
    }

    // Skill-local assets travel with the skill, keeping their own links valid.
    for (const asset of skillAssets(root, entry.id)) {
      const text = readTextIfPresent(join(root, asset));
      if (text === null) continue;
      const assetRewrite = rewriteLinks(asset, asset, text, included, asset);
      issues.push(...assetRewrite.issues);
      files.set(asset, { path: asset, contents: assetRewrite.text, source: asset });
      for (const dep of assetRewrite.dependencies) {
        const published = publishedPathFor(dep, included);
        if (published !== null) pending.push({ source: dep, published });
      }
    }
  }

  // Transitive closure over shared dependencies.
  const done = new Set<string>();
  while (pending.length > 0) {
    const next = pending.shift();
    if (next === undefined) continue;
    if (done.has(next.source) || files.has(next.published)) continue;
    done.add(next.source);

    const text = readTextIfPresent(join(root, next.source));
    if (text === null) continue; // checkSourceLinks owns the dangling-source case.

    const rewritten = rewriteLinks(next.source, next.published, text, included, next.source);
    issues.push(...rewritten.issues);
    files.set(next.published, { path: next.published, contents: rewritten.text, source: next.source });
    for (const dep of rewritten.dependencies) {
      const published = publishedPathFor(dep, included);
      if (published !== null) pending.push({ source: dep, published });
    }
  }

  /**
   * The eval corpus, for the one host whose contract has a runner for it.
   *
   * Scoped to `emitted` rather than copied wholesale: the install set is
   * profile-dependent and `evals/` holds cases for skills a profile
   * deliberately excludes (`profiles/core.yaml` names `babysit-pr` and
   * `ultraqa`, both of which have cases in this tree). Shipped wholesale, those
   * cases reach `claude plugin eval dist/claude-code --threshold 1.0`
   * (`adapters/claude-code/CONTRACT.md` §5) naming skills the bundle does not
   * contain, where they cannot pass.
   *
   * Verbatim, with no link rewriting. A case is graded input, not prose this
   * packager owns; a rewritten path changes what the eval asks.
   *
   * The count is what the manifest key is conditioned on, so the pointer and
   * the corpus are emitted or withheld together. A bundle that installs no
   * skills at all -- a profile can narrow to that -- carries neither, and says
   * nothing rather than pointing at an empty directory.
   *
   * What this does NOT check: that every installed skill has a case, or that
   * every U skill has a *non-trigger* case whose prompt comes from its
   * `## Not for` section. That is `adapters/codex/CONTRACT.md` §5.4 and
   * `adapters/claude-code/CONTRACT.md` §5.7, and it is not built. One case for
   * one skill satisfies the check below, which is deliberately only the
   * pointer-has-a-referent property.
   */
  let cases = 0;
  if (host === "claude-code") {
    for (const id of emitted) {
      for (const file of walkFiles(root, `${EVAL_DIR}/${id}`)) {
        const text = readTextIfPresent(join(root, file));
        if (text === null) continue;
        files.set(file, { path: file, contents: text, source: file });
        cases += 1;
      }
    }
    if (cases === 0 && emitted.length > 0) {
      issues.push(
        error(
          "packaging.eval-corpus-missing",
          EVAL_DIR,
          `None of this bundle's ${emitted.length} skill(s) has a case under ${EVAL_DIR}/<id>/, so the bundle carries no eval corpus at all and nothing can be run against it. adapters/claude-code/CONTRACT.md §1 puts ${EVAL_DIR}/<id>/<case>/case.yaml in this bundle's shape; write a case under ${EVAL_DIR}/<id>/ for a skill this bundle installs.`,
        ),
      );
    }
  }

  for (const name of LICENCE_FILES) {
    const text = readTextIfPresent(join(ctx.root, name));
    if (text === null) {
      issues.push(
        error(
          "packaging.licence-file-missing",
          name,
          `${name} is not in the source tree, so the bundle cannot carry it. MIT requires the copyright notice and the permission notice accompany every copy of the software, and dist/ is a copy that gets distributed. Write ${name} at the repository root.`,
        ),
      );
      continue;
    }
    files.set(name, { path: name, contents: text, source: name });
  }

  const memMode = readTextIfPresent(join(root, CLAUDE_MEM_MODE_FILE));
  if (memMode !== null) {
    files.set(CLAUDE_MEM_MODE_FILE, { path: CLAUDE_MEM_MODE_FILE, contents: memMode, source: CLAUDE_MEM_MODE_FILE });
  }

  try {
    const script = maintenanceScript(root);
    if (script !== null) files.set("bin/ak", { path: "bin/ak", contents: script });
  } catch (cause) {
    issues.push(
      error(
        "packaging.maintenance-build-failed",
        "src/maintenance/cli.ts",
        cause instanceof Error ? cause.message : String(cause),
      ),
    );
  }

  // The lifecycle gate travels with the lifecycle: a session with only this bundle records and checks
  // gates with `node bin/ak-gate.mjs`, the same code `ak lifecycle` runs (src/lifecycle/gate.ts).
  if (GATE_SKILLS.some((name) => emitted.includes(name))) {
    const text = readTextIfPresent(join(root, GATE_SOURCE));
    if (text === null) {
      issues.push(
        error(
          "packaging.gate-source-missing",
          GATE_SOURCE,
          `${GATE_SOURCE} is missing, so the bundle cannot carry the lifecycle gate its super-* skills record and check.`,
        ),
      );
    } else {
      files.set(GATE_FILE, {
        path: GATE_FILE,
        contents: gateScript(text, listDirs(join(root, "adapters"))),
        source: GATE_SOURCE,
      });
    }
  }

  issues.push(...checkManifestIdentity(ctx.catalog.package));
  // Built once and then both checked and serialised, rather than built twice.
  // The parity check's whole claim is about what this bundle ships, and a check
  // that re-derived the four values from the catalog would agree with the emit
  // for the same reason the emit agrees with itself -- it would report clean
  // over a manifest that had stopped matching, because it never looked at one.
  const manifest = manifestObject(ctx, host, emitted, cases > 0);
  issues.push(...checkManifestParity(root, manifest));
  files.set(HOST_MANIFEST_FILE[host], {
    path: HOST_MANIFEST_FILE[host],
    contents: `${JSON.stringify(manifest, null, 2)}\n`,
  });
  files.set(MARKETPLACE_FILE, { path: MARKETPLACE_FILE, contents: marketplace(ctx) });
  files.set(BUILD_RECORD_FILE[host], {
    path: BUILD_RECORD_FILE[host],
    contents: buildRecord(
      host,
      membership.profile,
      install,
      excluded,
      decisions,
      capabilities.enforces,
      capabilities.notes,
    ),
  });

  return { host, profile: membership.profile, files: sortFiles(files), decisions, issues };
}

function skillAssets(root: string, skillId: string): string[] {
  const out: string[] = [];
  for (const sub of ["references", "assets"]) {
    const dir = `skills/${skillId}/${sub}`;
    for (const file of walkFiles(root, dir)) out.push(file);
  }
  return out;
}

function sortFiles(files: Map<string, BundleFile>): Map<string, BundleFile> {
  return new Map([...files.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * The host's manifest, carrying host keys only.
 *
 * `claude plugin validate --strict` treats a key it does not define as an error
 * ("Unknown field 'ak'. Claude Code ignores it at load time."), so anything this
 * package wants to record about its own build goes in `buildRecord` instead.
 */
function manifestObject(
  ctx: CheckContext,
  host: HostId,
  skills: ReadonlyArray<string>,
  hasCorpus: boolean,
): HostManifest {
  const pkg = ctx.catalog.package;
  const manifest: HostManifest = {
    name: pkg.id,
    version: pkg.version,
  };
  // From `package.description` and not `package.name`, which is the defect the
  // withdrawn parity clause was masking: the manifest shipped the literal
  // `agent-kit` as the bundle's description into every build, and the check
  // that would have caught it was comparing that value against the same wrong
  // field in package.json, so the two agreed and nothing complained.
  //
  // Omitted rather than emitted blank when the catalog states none, for the
  // reason `author` and `license` are below.
  if (declared(pkg.description)) manifest.description = pkg.description;
  // Key order follows the contract's own example at
  // `adapters/claude-code/CONTRACT.md` §1, and these are set before `skills` for
  // that reason. Each is omitted when the catalog does not declare it rather
  // than emitted blank -- `"license": ""` would satisfy a check that asks
  // whether the key is present and fail the comparison §5 requires, which is
  // the quieter of the two ways to be wrong. `checkManifestIdentity` is what
  // makes the omission loud.
  if (declared(pkg.author)) manifest.author = { name: pkg.author };
  if (declared(pkg.license)) manifest.license = pkg.license;
  manifest.skills = skillRegistration(host, skills);
  // Last, as in §1's example, and conditioned on the corpus alone rather than
  // on the corpus and the host. The key is a pointer: emitted with nothing
  // behind it, it is the pointer half of this feature shipping without the
  // half that makes it true.
  //
  // `&& host === "claude-code"` stood here too and has been removed, because it
  // could not fail. The count is only ever incremented inside the host-gated
  // copy above, so `hasCorpus` is already false for codex and the second
  // condition decided nothing -- a guard that reads as load-bearing and is not,
  // which a mutation surviving is how it was found rather than by reading it.
  // The host decision now lives in one place, at the copy, and the assertion
  // that codex's manifest carries no such key is a test rather than a
  // condition that cannot be observed failing.
  if (hasCorpus) manifest.experimental = { evals: EVAL_DIR };
  return manifest;
}

/**
 * `package.json` as an object, or `null` when it is not one.
 *
 * `null` for a throw and `null` for a document that parses to an array, a
 * string or `null` itself, because the caller does the same thing with all of
 * them: say the authority could not be read. Caught into `{}` instead, an
 * unparseable file would arrive at the comparison looking like a package
 * manifest that simply declares nothing, and the build would report four
 * missing fields about a file sitting in the tree.
 */
function parsePackageJson(text: string): Record<string, unknown> | null {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return null;
  }
  return typeof doc === "object" && doc !== null && !Array.isArray(doc) ? (doc as Record<string, unknown>) : null;
}

/**
 * `adapters/codex/CONTRACT.md` §5.2: `version` and `license` agree across
 * `package.json` and both host manifests.
 *
 * `name` and `description` are §5.2's other rule and are not checked here,
 * because within one plan they cannot fail. Both are generated from
 * `catalog.package.id` and `catalog.package.description` a few lines above, so
 * comparing the emitted object back against those fields is the emit and the
 * check reading one source and agreeing with each other whatever the manifest
 * says. The half of that clause that can fail is manifest-to-manifest, which
 * needs both plans at once and belongs in `planAll`; it is held by
 * `tests/packaging.test.ts` today and is not a runtime check. Reported as a gap
 * rather than written here as a comparison that cannot come out false.
 *
 * Emitted from `planBundle` for the reason `checkManifestIdentity` is -- so it
 * fails the build rather than reporting from `ak validate`, where a bundle is
 * never planned and nothing would read it.
 *
 * The row names `package.json` and not the manifest it was compared against.
 * Both manifests are generated from the same catalog fields, so the same field
 * disagrees in both plans and the two rows are identical; `collapseDuplicates`
 * in build.ts merges them, and a four-field skew reaches the reader as four
 * failures rather than eight. It is also the honest column: the manifest is
 * generated, so a reader sent there has nothing they can edit. The message
 * names the catalog field behind the manifest's value, which is the other of
 * the two places the fix can go.
 *
 * Reported per field rather than as one row for the set, for the same reason
 * `checkManifestIdentity` is: each disagreement has its own pair of values and
 * its own decision about which side is wrong, and they are not usually the
 * same decision.
 *
 * What this does NOT check: that the two host manifests agree with each other.
 * They are built from one object in one place, so they cannot disagree without
 * the packager being changed, and §5.1's cross-bundle parity is a test
 * (`the two bundles are the same skills in two shapes`) rather than a
 * condition this could observe failing.
 */
function checkManifestParity(root: string, manifest: HostManifest): Issue[] {
  const text = readTextIfPresent(join(root, PACKAGE_FILE));
  const pkg = text === null ? null : parsePackageJson(text);
  if (pkg === null) {
    return [
      unavailable(
        "packaging.manifest-parity-unavailable",
        PACKAGE_FILE,
        PARITY_CHECK,
        `${PACKAGE_FILE} is ${text === null ? "not in the source tree" : "not a JSON object"}, so neither of the fields adapters/codex/CONTRACT.md §5.2 requires the host manifests to agree with it on could be read. The manifests are in the plan and there is nothing to measure them against, which is a check that did not run rather than a check that passed. Write ${PACKAGE_FILE} declaring ${PARITY_FIELD_LIST}.`,
      ),
    ];
  }

  const issues: Issue[] = [];
  for (const [field, source] of PARITY_FIELDS) {
    const theirs = pkg[field];
    if (typeof theirs !== "string") {
      issues.push(
        unavailable(
          "packaging.manifest-parity-unavailable",
          PACKAGE_FILE,
          PARITY_CHECK,
          `${PACKAGE_FILE} states no '${field}', so the '${field}' this bundle's manifest carries had nothing to be compared against. adapters/codex/CONTRACT.md §5.2 requires ${PARITY_FIELD_LIST} to agree across ${PACKAGE_FILE} and both host manifests; declare '${field}' in ${PACKAGE_FILE}.`,
        ),
      );
      continue;
    }
    const ours = manifest[field];
    if (ours === theirs) continue;
    issues.push(
      error(
        "packaging.manifest-parity",
        PACKAGE_FILE,
        `'${field}' disagrees: ${PACKAGE_FILE} declares '${theirs}' and the host manifest ${ours === undefined ? "carries no such key" : `carries '${ours}'`}. adapters/codex/CONTRACT.md §5.2 requires ${PARITY_FIELD_LIST} to agree across ${PACKAGE_FILE} and both host manifests. The manifest's '${field}' is generated from catalog.yaml's ${source}, so the edit goes there or in ${PACKAGE_FILE} -- not in the bundle, which is rewritten on every build.`,
      ),
    );
  }
  return issues;
}

/**
 * The marketplace file, from the same catalog fields the manifest reads.
 *
 * The shape is the donor's, read at the pin the contract cites
 * (`compound-engineering@05c42da:.claude-plugin/marketplace.json`) rather than
 * recalled: `name`, `owner`, `metadata`, and one `plugins[]` entry whose
 * `source` is `"./"`.
 *
 * `owner` is the catalog's `author`, not a second identity. The contract states
 * one identity for this package and the donor uses the same string in both
 * places; deriving it here means the two cannot disagree, and it avoids
 * inventing an owner, which would be a claim about a real party in a file that
 * gets distributed.
 *
 * The donor's `homepage` and `tags` are not emitted because this tree states no
 * value for them. `metadata.description` is the catalog package description:
 * Claude's strict marketplace validator requires it, and deriving it from the
 * same source as the plugin manifest prevents the two descriptions drifting.
 */
function marketplace(ctx: CheckContext): string {
  const pkg = ctx.catalog.package;
  const author = declared(pkg.author) ? { name: pkg.author } : undefined;
  const doc = {
    name: pkg.name,
    owner: author,
    metadata: { version: pkg.version, description: pkg.description },
    plugins: [{ name: pkg.id, description: pkg.name, author, source: "./" }],
  };
  return `${JSON.stringify(doc, null, 2)}\n`;
}

/**
 * The package identity every host manifest is obliged to carry.
 *
 * Reported per field, because the fix for each is a different line and a reader
 * missing one of the three needs to know which. Emitted from `planBundle` rather
 * than from a validation check so that it fails the build: a bundle whose
 * manifest omits `license` does not disagree with `package.json`, it removes
 * the field `adapters/codex/CONTRACT.md` §5 compares, and a check that only
 * compares present fields would pass over it.
 *
 * `description` is checked here and nowhere else, which is the gap `19081aa`
 * left when it made the field a manifest value. It is not in `PARITY_FIELDS`,
 * because §5.2 makes `package.json` no party to it; and the half of §5.2 that
 * does bind it is manifest-to-manifest, where two manifests that both dropped
 * the key agree. Absence is the one state in which that comparison certifies
 * nothing, so absence has to fail before the comparison is reached.
 *
 * The citation differs by field because the authority does. `author` and
 * `license` are specified by `adapters/claude-code/CONTRACT.md` §1; the
 * authority for `description` is `catalog.yaml`'s own `package.description`,
 * per `adapters/codex/CONTRACT.md` §5.2, and sending a reader to §1 for it
 * would send them to a document that does not state the value.
 */
function checkManifestIdentity(pkg: CheckContext["catalog"]["package"]): Issue[] {
  const issues: Issue[] = [];
  for (const [field, value, authority] of [
    ["author", pkg.author, "adapters/claude-code/CONTRACT.md §1 specifies the value"],
    ["license", pkg.license, "adapters/claude-code/CONTRACT.md §1 specifies the value"],
    [
      "description",
      pkg.description,
      "adapters/codex/CONTRACT.md §5.2 makes this block the authority for it, and package.json is not a party",
    ],
  ] as const) {
    if (declared(value)) continue;
    issues.push(
      error(
        "packaging.manifest-identity-missing",
        "catalog.yaml",
        `catalog.yaml's package: block ${value === undefined ? "declares no" : "declares a blank"} '${field}', so every host manifest would ship without it. ${authority}; declare '${field}' under package: and both manifests get it from there.`,
      ),
    );
  }
  return issues;
}

/**
 * Whether the catalog states a value for an identity field.
 *
 * One predicate, read by the check and by both emit sites, because "declared"
 * has to mean the same thing in all three or the build reports an error over a
 * field and writes it into the manifest anyway. `""` is not a value: it parses,
 * loads, and is a string -- `loadCatalog` does no schema validation of its own,
 * so a blank reaches the packager looking exactly like a field someone filled
 * in, and `"license": ""` satisfies a check that asks whether the key is there
 * while failing the comparison `adapters/codex/CONTRACT.md` §5.2 requires.
 */
function declared(value: string | undefined): value is string {
  return value !== undefined && value !== "";
}

/**
 * How each host is told which skills the bundle holds.
 *
 * The two forms are a contract difference, not a style one. claude-code
 * enumerates every path in catalog order, so load order is controlled rather
 * than glob-dependent and the manifest is the one place that states what this
 * bundle actually contains -- which matters because the install set is
 * profile-dependent (`adapters/claude-code/CONTRACT.md` §1). codex takes the
 * directory pointer its contract carries from the donor
 * (`adapters/codex/CONTRACT.md` §1).
 *
 * The forms resolve to the same set only because both bundles are built from
 * one `skills/` tree. That is a property of this function's caller rather than
 * of the manifests, and nothing in either manifest would show it breaking --
 * a pointer states no set to disagree with. The comparison in
 * `tests/packaging.test.ts` is what holds it, per §1: divergence between the
 * two bundles is a build failure, not a host difference.
 */
function skillRegistration(host: HostId, skills: ReadonlyArray<string>): string | string[] {
  return host === "codex" ? "./skills/" : skills.map((id) => `./skills/${id}`);
}

/**
 * What this build decided, written beside the host's manifest rather than
 * inside it. Read by people and by the release checks, never by the host.
 */
function buildRecord(
  host: HostId,
  /** Passed in, not re-derived: the record states the selection that was made. */
  profile: string,
  install: InstallConfig,
  excluded: ReadonlyArray<{ skill: string; reason: string }>,
  decisions: ReadonlyArray<HostDecision>,
  enforces: ReadonlySet<string>,
  notes: ReadonlyArray<string>,
): string {
  const record = {
    profile,
    /**
     * Which adapters the modes below were computed with. The bundle's modes
     * depend on a file the tree does not carry, so a record that omitted this
     * would describe a build nobody else could reproduce from it. `file` is
     * `null` when the default applied. `backends` because the same attached
     * list lifts `tracker-access` with a backend and borrows `kb-write`
     * without one (`adapters/tracker/CONTRACT.md` §1).
     */
    install: { file: install.file, attached: [...install.attached], backends: Object.fromEntries(install.backends) },
    /**
     * Emitted even when empty. An absent key would read as "an older build
     * that did not record this" rather than "nothing was left out", and the
     * two have to be distinguishable in a file whose job is to say what the
     * bundle does not contain.
     */
    excluded: excluded.map((e) => ({ skill: e.skill, reason: e.reason })),
    host: { id: host, enforces: [...enforces].sort(), notes: [...notes] },
    modes: decisions.map((d) => ({ skill: d.skill, mode: d.mode })),
    autonomy_rejected: decisions
      .values()
      .filter((d) => d.rejected.length > 0)
      .map((d) => ({ skill: d.skill, unenforceable: d.unenforceable }))
      .toArray(),
  };
  return `${JSON.stringify(record, null, 2)}\n`;
}
