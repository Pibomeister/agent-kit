import { join } from "node:path";
import { parse as parseYaml } from "yaml";

import type { Catalog } from "../catalog/load.ts";
import { entryFilePath } from "../catalog/layout.ts";
import { readTextIfPresent } from "../util/fs.ts";
import { error, type Issue } from "../validation/types.ts";
import { numberedSection, type Supply } from "./capability-table.ts";
import { HOST_IDS } from "./hosts.ts";

/**
 * The per-install configuration: which adapters this install attaches.
 *
 * Local and uncommitted, at the tree root, because attachment is a fact about
 * one install and not about the package. The tree states what each adapter
 * *would* supply, in the adapter's own contract; this file states only which of
 * them are attached here. Absent, every adapter that supplies anything is
 * attached, which is the default ruling `fail-closed-adapter-lifts-ceiling`
 * sets and the reason a `git archive` extract -- which never carries this file
 * -- measures the default.
 */
export const INSTALL_FILE = "ak.install.yaml";

/**
 * The one value an adapter's supply table may state, and what it asserts.
 *
 * A one-value vocabulary rather than no column, because the column is the
 * claim that makes attaching the adapter safe. An adapter that supplies a
 * capability and falls back to something else when unconfigured -- a scratch
 * directory, a second system of record, an unavailable answer the run carries
 * on past -- would let an autonomous run proceed without the capability, which is what
 * `adapters/claude-code/CONTRACT.md` §4 forbids. Such a capability is left out
 * of the table rather than listed under a weaker value, so every row that
 * parses is one this module may count.
 */
const FAILS_CLOSED = "fails-closed";

/** `| `capability` | `fails-closed` | ...rest |`, which is the only row shape the supply tables write. */
const ROW = /^\|\s*`([^`]+)`\s*\|\s*`([^`]+)`\s*\|([^\n]*)$/gm;

/**
 * The optional third column, and the header that declares it.
 *
 * Read from the header rather than guessed from the cell, because the tables
 * without the column put free prose there, and prose may open with a
 * backticked word -- the runner's `runner-grants` row does.
 */
const FALLBACK_HEADER = /^\|\s*Capability\s*\|\s*Unconfigured\s*\|\s*Falls back on\s*\|/m;
const FALLBACK_CELL = /^`([^`]+)`$/;
const NO_FALLBACK = "none";

export interface AdapterSupply {
  adapter: string;
  /** The contract the capabilities were read from. */
  file: string;
  capabilities: string[];
  /**
   * Capability -> the capability this adapter's no-backend path consumes.
   *
   * `adapters/tracker/CONTRACT.md` §1 is the case: with no backend configured
   * its ticket operations are carried by the knowledgebase's records, so they
   * fail closed only because `kb-write` does. The adapter's refusal is then
   * borrowed, and the capability is lifted only where the one it borrows from
   * is (ruling `tracker-of-record-falls-back-to-kb`).
   */
  fallsBackOn: Map<string, string>;
}

/**
 * What each non-host adapter's contract says it supplies, read from its §1.
 *
 * Parsed out of the contract rather than restated here, for the reason
 * `adapters/claude-code/CONTRACT.md` §3 gives for its own table: a second copy
 * is a second thing to keep in step, and the one that decides is whichever the
 * code happened to read. Scoped to §1 because the runner contract carries other
 * tables of the same shape further down -- §3's seat exclusions and §7's
 * restart record among them.
 *
 * The hosts are skipped. What a host supplies is §3 of its own contract,
 * already read by `loadCapabilityTable`, and a host is not something an install
 * attaches: it is what the bundle is built for.
 */
export function loadAdapterSupplies(root: string, catalog: Catalog): { adapters: AdapterSupply[]; issues: Issue[] } {
  const issues: Issue[] = [];
  const adapters: AdapterSupply[] = [];
  const hosts = new Set<string>(HOST_IDS);

  for (const entry of catalog.bySection("adapters")) {
    if (hosts.has(entry.id)) continue;
    const file = entryFilePath("adapters", entry.id);
    const text = readTextIfPresent(join(root, file));
    if (text === null) continue; // completeness owns a declared adapter with no contract.
    const section = numberedSection(text, 1);
    if (section === null) continue;

    const capabilities: string[] = [];
    const fallsBackOn = new Map<string, string>();
    const hasFallbackColumn = FALLBACK_HEADER.test(section);
    for (const match of section.matchAll(ROW)) {
      const capability = match[1] ?? "";
      const stated = match[2] ?? "";
      if (stated !== FAILS_CLOSED) {
        issues.push(
          error(
            "packaging.unknown-supply-status",
            file,
            `§1's supply row for '${capability}' states '${stated}', and the only value that table may state is '${FAILS_CLOSED}'. A capability this adapter supplies without failing closed would let an autonomous run proceed with it silently absent (ruling \`fail-closed-adapter-lifts-ceiling\`), so the row is not counted; remove it, or state where this contract says the adapter refuses when unconfigured.`,
          ),
        );
        continue;
      }
      if (hasFallbackColumn) {
        const cell = (match[3] ?? "").split("|")[0]?.trim() ?? "";
        const named = FALLBACK_CELL.exec(cell)?.[1];
        if (named === undefined && cell !== NO_FALLBACK) {
          // Not counted, like a row with an unknown status: a dependency the
          // parser cannot read would otherwise be read as no dependency, and
          // the capability lifted on a refusal it only borrows.
          issues.push(
            error(
              "packaging.malformed-fallback",
              file,
              `§1's supply row for '${capability}' states '${cell}' under 'Falls back on', which is neither one backticked capability nor '${NO_FALLBACK}'. The column names the capability this adapter's unconfigured path consumes, and the row lifts the ceiling only where that capability is itself available (ruling \`tracker-of-record-falls-back-to-kb\`), so an unreadable cell is not counted.`,
            ),
          );
          continue;
        }
        if (named !== undefined) fallsBackOn.set(capability, named);
      }
      if (!capabilities.includes(capability)) capabilities.push(capability);
    }
    if (capabilities.length > 0) adapters.push({ adapter: entry.id, file, capabilities, fallsBackOn });
  }

  return { adapters, issues };
}

export interface InstallConfig {
  /** `INSTALL_FILE` when it was read, `null` when the default applied. */
  file: string | null;
  /** The adapters this install attached, in catalog order. */
  attached: string[];
  /** Every adapter that supplies anything, attached or not, in catalog order. */
  attachable: string[];
  /**
   * Adapter -> the backend this install configured behind it, for the adapters
   * whose §1 names a fallback. Free-form ids: the file names which backend the
   * operator's environment binds, and the package holds no list of vendors to
   * check it against (`adapters/tracker/CONTRACT.md` §1).
   */
  backends: Map<string, string>;
  /**
   * Adapter -> the capabilities its no-backend path consumes, for every
   * attachable adapter whose §1 names one. Read by `describeInstall`.
   */
  fallbacks: Map<string, string[]>;
  /** The input `ceilingFor` takes. */
  supply: Supply;
  issues: Issue[];
}

/**
 * Read `INSTALL_FILE`, or apply the default when there is none.
 *
 * An unreadable file attaches nothing rather than everything. The error blocks
 * the build either way; what the choice decides is which ceiling the report
 * beside the error was computed under, and the one that cannot overstate what
 * this install supplies is the host alone.
 */
export function loadInstallConfig(root: string, catalog: Catalog): InstallConfig {
  const { adapters, issues } = loadAdapterSupplies(root, catalog);
  const attachable = adapters.map((a) => a.adapter);
  const suppliers = new Map<string, string[]>();
  for (const { adapter, capabilities } of adapters) {
    for (const capability of capabilities) suppliers.set(capability, [...(suppliers.get(capability) ?? []), adapter]);
  }
  const fallbacks = new Map<string, string[]>();
  for (const { adapter, fallsBackOn } of adapters) {
    if (fallsBackOn.size > 0) fallbacks.set(adapter, [...new Set(fallsBackOn.values())]);
  }
  const done = (file: string | null, attached: string[], backends = new Map<string, string>()): InstallConfig => {
    // A configured backend is the system of record, so its adapter's fallback
    // is not what an operation reaches and borrows nothing
    // (`adapters/tracker/CONTRACT.md` §2).
    const borrowed = new Map<string, Map<string, string>>();
    for (const { adapter, fallsBackOn } of adapters) {
      if (backends.has(adapter)) continue;
      for (const [capability, needs] of fallsBackOn)
        borrowed.set(capability, new Map([...(borrowed.get(capability) ?? []), [adapter, needs]]));
    }
    return {
      file,
      attached,
      attachable,
      backends,
      fallbacks,
      supply: { attached: new Set(attached), suppliers, fallbacks: borrowed },
      issues,
    };
  };

  const text = readTextIfPresent(join(root, INSTALL_FILE));
  if (text === null) return done(null, attachable);

  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch (cause) {
    issues.push(
      error(
        "packaging.install-unreadable",
        INSTALL_FILE,
        `Not valid YAML, so nothing is attached: ${cause instanceof Error ? cause.message : String(cause)}`,
      ),
    );
    return done(INSTALL_FILE, []);
  }
  const listed =
    doc !== null && typeof doc === "object" && !Array.isArray(doc)
      ? (doc as Record<string, unknown>)["attached"]
      : undefined;
  if (!Array.isArray(listed) || !listed.every((id): id is string => typeof id === "string")) {
    issues.push(
      error(
        "packaging.install-unreadable",
        INSTALL_FILE,
        `Declares no 'attached:' list of adapter ids, so nothing is attached. Write 'attached: [${attachable.join(", ")}]' for the default, or 'attached: []' for the host alone (schemas/install.schema.json).`,
      ),
    );
    return done(INSTALL_FILE, []);
  }

  const declared = new Set(catalog.bySection("adapters").map((e) => e.id));
  const wanted = new Set<string>();
  for (const id of listed) {
    if (attachable.includes(id)) {
      wanted.add(id);
      continue;
    }
    const why = declared.has(id)
      ? HOST_IDS.includes(id as (typeof HOST_IDS)[number])
        ? `'${id}' is a host, which a bundle is built for rather than attached to`
        : `${entryFilePath("adapters", id)} §1 states no capability this adapter supplies and fails closed on, so attaching it would change nothing`
      : `catalog.yaml declares no adapter '${id}'`;
    issues.push(
      error(
        "packaging.install-unknown-adapter",
        INSTALL_FILE,
        `attached: names '${id}', and ${why}. The adapters an install can attach are ${attachable.length === 0 ? "none in this tree" : attachable.join(", ")}.`,
      ),
    );
  }
  // Catalog order rather than the file's, so two files listing the same set
  // produce the same build record.
  const attached = attachable.filter((id) => wanted.has(id));

  // One key per adapter whose §1 names a fallback, spelled as the adapter's
  // id: `tracker: { backend: <id> }`. The shape is the schema's to report; a
  // key this reads and cannot use is left to it rather than reported twice.
  const backends = new Map<string, string>();
  for (const adapter of fallbacks.keys()) {
    const section = (doc as Record<string, unknown>)[adapter];
    const backend =
      section !== null && typeof section === "object" ? (section as Record<string, unknown>)["backend"] : undefined;
    if (typeof backend !== "string" || backend.length === 0) continue;
    if (!attached.includes(adapter)) {
      // Not quietly honoured and not quietly dropped: the file says both that
      // this install has a backend and that it does not attach the adapter
      // that would reach it, and either reading overstates or understates
      // what the install supplies.
      issues.push(
        error(
          "packaging.install-backend-unattached",
          INSTALL_FILE,
          `${adapter}: names backend '${backend}', and attached: does not list '${adapter}', so nothing would reach that backend. Add '${adapter}' to attached:, or remove the ${adapter}: key (ruling \`tracker-of-record-falls-back-to-kb\`).`,
        ),
      );
      continue;
    }
    backends.set(adapter, backend);
  }
  return done(INSTALL_FILE, attached, backends);
}

/**
 * The install configuration as the summary line states it.
 *
 * A figure from `ak build` or `ak validate` now depends on a file that is never
 * committed, so a receipt that omits which configuration produced it cannot be
 * re-derived by anyone else -- `AGENTS.md`, "Receipts name their instrument".
 */
export function describeInstall(config: InstallConfig): string {
  const list = (ids: string[]) => (ids.length === 0 ? "none" : ids.join(", "));
  const base =
    config.file === null
      ? `no ${INSTALL_FILE}: default, all fail-closed adapters attached (${list(config.attached)})`
      : `${config.file}: attached ${list(config.attached)}`;
  return [base, ...backendStates(config)].join("; ");
}

/**
 * One clause per attached adapter with a fallback, because the attached list
 * alone no longer fixes the ceiling: the same list lifts `tracker-access` or
 * caps it depending on whether a backend is configured and whether what the
 * fallback consumes is attached. Stated in terms of attached adapters and not
 * of the lift itself, which also depends on the host's own table, and this
 * line is shared by every host the build packages.
 */
function backendStates(config: InstallConfig): string[] {
  const states: string[] = [];
  for (const [adapter, needs] of config.fallbacks) {
    if (!config.attached.includes(adapter)) continue;
    const backend = config.backends.get(adapter);
    if (backend !== undefined) {
      states.push(`${adapter}: backend ${backend}`);
      continue;
    }
    const each = needs.map((capability) => {
      const by = (config.supply.suppliers.get(capability) ?? []).filter((a) => config.supply.attached.has(a));
      return by.length > 0
        ? `${capability} fallback (${by.join(", ")})`
        : `${capability} fallback, which no attached adapter supplies`;
    });
    states.push(`${adapter}: no backend, ${each.join(", ")}`);
  }
  return states;
}

/**
 * The install configuration's cross-references, for `ak validate`.
 *
 * Without `packaging.install-unreadable`, whose every cause is a shape
 * `schemas/install.schema.json` already rejects -- `checkSchemas` reports the
 * same file as `schemas.document-unparseable` or `schemas.document-invalid`, and
 * two rows for one defect read as two defects. The planner keeps the rule,
 * because `ak build` reports plan issues only once validation is clean and a
 * tree whose schema could not be compiled would otherwise hear about it from
 * nothing. What is left here is what no document schema can state: that an
 * attached id names an adapter whose contract supplies something.
 */
export function checkInstallConfig(ctx: { root: string; catalog: Catalog }): Issue[] {
  return loadInstallConfig(ctx.root, ctx.catalog).issues.filter(
    (issue) => issue.rule !== "packaging.install-unreadable",
  );
}
