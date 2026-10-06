import { join } from "node:path";
import { parse as parseYaml } from "yaml";

import { listFiles, readTextIfPresent } from "../util/fs.ts";
import { error, note, warning, type Issue } from "../validation/types.ts";
import { ALL_SECTIONS, type Section } from "./layout.ts";

/** The catalog's own file. */
export const CATALOG_FILE = "catalog.yaml";

/**
 * Where fragments that add entries to catalog.yaml live, one `<name>.yaml` each.
 *
 * The precedent is `provenance/adaptations.d/`, which exists so parallel batches
 * merge without a conflict on one shared file. This directory exists so a
 * downstream install can declare its own profile or entry and still take
 * catalog.yaml from upstream unchanged. The two differ in one respect, on
 * purpose: adaptation rows are rendered into a generated file that NOTICE
 * points a reader at, while nothing reads the catalog except this loader, so
 * the merge happens here, in memory, and there is no generated catalog to hold
 * in sync.
 *
 * A fragment only adds. An id that catalog.yaml or an earlier fragment already
 * declares in the same section is `catalog.duplicate-id`, never an override: a
 * merge in which the last file wins makes an entry's meaning depend on file
 * order, the same hazard `provenance.conflicting-adaptation` refuses. Nor does
 * a fragment carry a `package:` block. Package identity is catalog.yaml's
 * alone, so the loader never reads one from a fragment, and the schema check
 * (`schemas/catalog.schema.json#/$defs/fragment`) reports one as a defect.
 * Fragments merge in file-name order, each after catalog.yaml, so the order of
 * a section is the same on every run.
 *
 * `docs/decisions/0010-catalog-fragments.md` records the decision.
 */
export const CATALOG_FRAGMENT_DIR = "catalog.d";

export type EntryStatus = "contract" | "authored";
export type Invocation = "U" | "M";

export interface Entrypoint {
  authority?: string;
  invocation?: Invocation;
}

export interface CatalogEntry {
  section: Section;
  id: string;
  status: EntryStatus;
  invocation?: Invocation;
  profiles: string[];
  provenanceOrigin?: "donor" | "conversation";
  entrypoints?: Record<string, Entrypoint>;
  batch?: number;
  summary?: string;
  activation?: string;
  loadedBy: string[];
  raw: Record<string, unknown>;
  /** The file that declares the entry: catalog.yaml or one of its catalog.d/ fragments. */
  file: string;
}

export interface PackageInfo {
  id: string;
  name: string;
  version: string;
  namespace: string;
  defaultProfile: string;
  /**
   * Package identity the host manifests are obliged to carry, stated once here.
   *
   * Optional on the type and not defaulted to `""`, so the packager can tell an
   * absent field from a blank one. Those are different facts with different
   * fixes, and a blank is the worse of the two: it satisfies a check that asks
   * whether the key exists and fails the comparison
   * `adapters/codex/CONTRACT.md` §5.2 actually requires.
   *
   * Absent rather than required by the schema on purpose. Requiring them would
   * add a second, unrelated error to every `tests/fixtures/invalid/` catalog,
   * each of which exists to demonstrate exactly one defect -- so the
   * failure belongs at the bundle boundary, where a manifest without them is
   * genuinely wrong, rather than on every catalog in the tree.
   */
  author?: string;
  license?: string;
  /**
   * What the host is told this package is, which is not what the npm registry
   * is told.
   *
   * `adapters/codex/CONTRACT.md` §5.2 makes this and `id` the authority for the
   * two manifest fields `package.json` is not a party to. Optional here for the
   * same reason as the two above, and read by the packager through the same
   * `declared()` predicate.
   */
  description?: string;
}

export class Catalog {
  constructor(
    readonly packageInfo: PackageInfo,
    readonly entries: ReadonlyArray<CatalogEntry>,
    /** catalog.yaml as parsed. A fragment's own document is not part of it. */
    readonly raw: Record<string, unknown>,
    /** The catalog.d/ fragments merged into `entries`, in merge order. */
    readonly fragments: ReadonlyArray<string> = [],
  ) {}

  get package(): PackageInfo {
    return this.packageInfo;
  }

  bySection(section: Section): CatalogEntry[] {
    return this.entries.filter((e) => e.section === section);
  }

  get(section: Section, id: string): CatalogEntry | undefined {
    return this.entries.find((e) => e.section === section && e.id === id);
  }

  /** Every skill id, for invocation-graph reference resolution. */
  skillIds(): Set<string> {
    return new Set(this.bySection("skills").map((e) => e.id));
  }
}

export interface LoadResult {
  catalog: Catalog | null;
  issues: Issue[];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asStringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function readEntrypoints(value: unknown): Record<string, Entrypoint> | undefined {
  const record = asRecord(value);
  const keys = Object.keys(record);
  if (keys.length === 0) return undefined;
  const out: Record<string, Entrypoint> = {};
  for (const key of keys) {
    const raw = asRecord(record[key]);
    const entrypoint: Entrypoint = {};
    if (typeof raw["authority"] === "string") entrypoint.authority = raw["authority"];
    if (raw["invocation"] === "U" || raw["invocation"] === "M") entrypoint.invocation = raw["invocation"];
    out[key] = entrypoint;
  }
  return out;
}

export function loadCatalog(root: string): LoadResult {
  const path = join(root, "catalog.yaml");
  const text = readTextIfPresent(path);
  if (text === null) {
    return {
      catalog: null,
      issues: [
        error(
          "catalog.missing",
          "catalog.yaml",
          "catalog.yaml not found; it is the source of truth for what must exist.",
        ),
      ],
    };
  }

  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    return {
      catalog: null,
      issues: [error("catalog.unparseable", "catalog.yaml", `catalog.yaml is not valid YAML: ${reason}`)],
    };
  }

  const rootDoc = asRecord(doc);
  if (Object.keys(rootDoc).length === 0) {
    return { catalog: null, issues: [error("catalog.unparseable", "catalog.yaml", "catalog.yaml is not a mapping.")] };
  }

  const issues: Issue[] = [];
  const pkg = asRecord(rootDoc["package"]);
  const packageInfo: PackageInfo = {
    id: typeof pkg["id"] === "string" ? pkg["id"] : "",
    name: typeof pkg["name"] === "string" ? pkg["name"] : "",
    version: typeof pkg["version"] === "string" ? pkg["version"] : "",
    namespace: typeof pkg["namespace"] === "string" ? pkg["namespace"] : "",
    defaultProfile: typeof pkg["default_profile"] === "string" ? pkg["default_profile"] : "",
  };
  // Set only when present, so `undefined` means absent and `""` means declared
  // blank. The packager reports those differently.
  if (typeof pkg["author"] === "string") packageInfo.author = pkg["author"];
  if (typeof pkg["license"] === "string") packageInfo.license = pkg["license"];
  if (typeof pkg["description"] === "string") packageInfo.description = pkg["description"];

  const fragments = readFragments(root, issues);
  const documents: CatalogDocument[] = [{ file: CATALOG_FILE, doc: rootDoc }, ...fragments];

  const entries: CatalogEntry[] = [];
  for (const section of ALL_SECTIONS) {
    /** id -> the file that declared it first, across catalog.yaml and every fragment. */
    const declaredIn = new Map<string, string>();
    for (const { file, doc: declared } of documents) {
      const list = declared[section];
      if (list === undefined || list === null) continue;
      if (!Array.isArray(list)) {
        issues.push(error("catalog.section-not-a-list", file, `Section '${section}' must be a list.`));
        continue;
      }
      for (const item of list) {
        const raw = asRecord(item);
        const id = raw["id"];
        if (typeof id !== "string" || id.length === 0) {
          issues.push(error("catalog.entry-without-id", file, `An entry in section '${section}' has no id.`));
          continue;
        }
        const prior = declaredIn.get(id);
        if (prior !== undefined) {
          issues.push(
            error(
              "catalog.duplicate-id",
              file,
              prior === file
                ? `Section '${section}' declares id '${id}' more than once.`
                : `Section '${section}' declares id '${id}' here and in ${prior}. A ${CATALOG_FRAGMENT_DIR}/ fragment adds entries and never replaces one, so which declaration stands cannot depend on file order; rename the entry or remove one declaration.`,
            ),
          );
          continue;
        }
        declaredIn.set(id, file);
        entries.push(readEntry(section, id, raw, file, issues));
      }
    }
  }

  issues.push(...idsInTwoAddressableSections(entries));
  issues.push(...fragmentNotes(fragments, entries));

  return {
    catalog: new Catalog(
      packageInfo,
      entries,
      rootDoc,
      fragments.map((f) => f.file),
    ),
    issues,
  };
}

interface CatalogDocument {
  file: string;
  /** Parsed the way catalog.yaml is, since a fragment holds the same sections. */
  doc: Catalog["raw"];
}

/**
 * Every `catalog.d/*.yaml` that parses to a mapping, in file-name order.
 *
 * A fragment that cannot be read as one is reported here and left out of the
 * merge, rather than failing the whole catalog the way an unreadable
 * catalog.yaml does: the entries catalog.yaml declares are still well defined
 * without it, and every other check can still run against them. The schema
 * check validates only the fragments this returns, so a broken one is reported
 * once.
 */
function readFragments(root: string, issues: Issue[]): CatalogDocument[] {
  const out: CatalogDocument[] = [];
  for (const name of listFiles(join(root, CATALOG_FRAGMENT_DIR))) {
    if (!/\.ya?ml$/.test(name)) continue;
    const file = `${CATALOG_FRAGMENT_DIR}/${name}`;
    const text = readTextIfPresent(join(root, file));
    if (text === null) continue;
    let doc: unknown;
    try {
      doc = parseYaml(text);
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      issues.push(
        error("catalog.unparseable", file, `${file} is not valid YAML, so none of its entries were merged: ${reason}`),
      );
      continue;
    }
    // asRecord hands a mapping back as itself and anything else as a fresh {}.
    const mapping = asRecord(doc);
    if (mapping !== doc) {
      issues.push(error("catalog.unparseable", file, `${file} is not a mapping, so none of its entries were merged.`));
      continue;
    }
    out.push({ file, doc: mapping });
  }
  return out;
}

function readEntry(
  section: Section,
  id: string,
  raw: CatalogEntry["raw"],
  file: string,
  issues: Issue[],
): CatalogEntry {
  const statusRaw = raw["status"];
  let status: EntryStatus = "contract";
  if (statusRaw === "authored") status = "authored";
  else if (statusRaw !== "contract" && statusRaw !== undefined) {
    issues.push(
      warning(
        "catalog.unknown-status",
        file,
        `Entry '${section}/${id}' has status '${String(statusRaw)}'; expected 'contract' or 'authored'.`,
      ),
    );
  }

  const entry: CatalogEntry = {
    section,
    id,
    status,
    profiles: asStringList(raw["profiles"]),
    loadedBy: asStringList(raw["loaded_by"]),
    raw,
    file,
  };
  if (raw["invocation"] === "U" || raw["invocation"] === "M") entry.invocation = raw["invocation"];
  if (raw["provenance_origin"] === "donor" || raw["provenance_origin"] === "conversation") {
    entry.provenanceOrigin = raw["provenance_origin"];
  }
  const entrypoints = readEntrypoints(raw["entrypoints"]);
  if (entrypoints !== undefined) entry.entrypoints = entrypoints;
  if (typeof raw["batch"] === "number") entry.batch = raw["batch"];
  if (typeof raw["summary"] === "string") entry.summary = raw["summary"];
  if (typeof raw["activation"] === "string") entry.activation = raw["activation"];
  return entry;
}

/**
 * One note per merged fragment, naming what it adds.
 *
 * A tree with fragments is a different catalog from the catalog.yaml it
 * carries, and a figure quoted from it is a figure about both. The note is what
 * puts that in the run's own output, the way the summary line's `install:`
 * clause does for the install configuration. With no fragments there is no
 * note, so a tree without them reports exactly what it reported before this
 * directory existed.
 */
function fragmentNotes(fragments: ReadonlyArray<CatalogDocument>, entries: ReadonlyArray<CatalogEntry>): Issue[] {
  return fragments.map(({ file }) => {
    const added = entries.flatMap((e) => (e.file === file ? [`${e.section}/${e.id}`] : []));
    const what =
      added.length === 0
        ? "adds no entries"
        : `adds ${added.length} ${added.length === 1 ? "entry" : "entries"}: ${added.join(", ")}`;
    return note(
      "catalog.fragment-merged",
      file,
      `${file} ${what}. The catalog checked and packaged here is catalog.yaml plus this fragment.`,
    );
  });
}

/**
 * The three sections an id can be reclassified between, and the reason the rule
 * stops at three.
 *
 * `AGENTS.md` maps the invocation law's vocabulary onto this package: `tdd` and
 * `attach-pack` became protocols "not skills", `standards-review` and
 * `spec-review` became the roles `reviewer-standards` and `reviewer-spec`. The
 * mapping table is defensible only because of the sentence that follows it --
 * "No id is both a skill and a protocol, so this is reclassification, not a
 * contradiction" -- and nothing verified that sentence.
 *
 * These three are addressable in the sense that matters: a body cites `tdd` and
 * the reader has to land on exactly one artifact, and the U/M partition has to
 * have exactly one answer for it. An id in two of them makes both undecidable.
 *
 * Deliberately not every section. The authored catalog declares `review` in
 * both `schemas` and `policies` -- `schemas/review.schema.json` and
 * `policies/review.yaml` -- which is correct and which a blanket uniqueness
 * rule would report. Those are addressed by path, never by bare id.
 */
const ADDRESSABLE_SECTIONS = ["skills", "protocols", "roles"] as const;

function idsInTwoAddressableSections(entries: ReadonlyArray<CatalogEntry>): Issue[] {
  /** id -> one entry per addressable section that declares it, in catalog order. */
  const declaredById = new Map<string, CatalogEntry[]>();
  for (const entry of entries) {
    if (!(ADDRESSABLE_SECTIONS as ReadonlyArray<string>).includes(entry.section)) continue;
    const seen = declaredById.get(entry.id);
    if (seen === undefined) declaredById.set(entry.id, [entry]);
    else if (!seen.some((e) => e.section === entry.section)) seen.push(entry);
  }

  const issues: Issue[] = [];
  for (const [id, declared] of declaredById) {
    if (declared.length < 2) continue;
    const sections = declared.map((e) => e.section);
    // Reported against catalog.yaml when every declaration is there, and against
    // the first fragment among them otherwise: catalog.yaml alone never makes
    // the collision a fragment brings, whichever section sorts first.
    const file = declared.find((e) => e.file !== CATALOG_FILE)?.file ?? CATALOG_FILE;
    issues.push(
      error(
        "catalog.id-in-two-addressable-sections",
        file,
        `Id '${id}' is declared in ${sections.join(" and ")}. A body citing '${id}' by name must reach exactly one artifact, and its invocation class must have one answer; declared twice it has neither. AGENTS.md's reclassification table holds only while no id is in two of these sections.`,
      ),
    );
  }
  return issues;
}
