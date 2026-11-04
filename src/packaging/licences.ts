import { join } from "node:path";

import Ajv2020 from "ajv/dist/2020.js";
import { parse as parseYaml } from "yaml";

import { readTextIfPresent, walkFiles } from "../util/fs.ts";
import { parseDonorSource, parseLocalAdaptationSource } from "../validation/provenance.ts";

/** A licence text this bundle must carry. `path` is the bundle path before host relocation. */
export interface LicenceDuty {
  readonly source: string;
  readonly path: string;
  readonly text: string;
}

/** A demanded licence text that could not be read, or an inlined package NOTICE does not cite. */
export interface LicenceProblem {
  readonly source: string;
  readonly message: string;
}

export interface LicenceClosure {
  /** `NOTICE`, then `LICENSE`, then other bundle paths in path order. Missing paths are absent. */
  readonly duties: readonly LicenceDuty[];
  readonly problems: readonly LicenceProblem[];
  /** npm package names whose `LICENSES/<name>.LICENSE` path was demanded, including failed reads. */
  readonly coveredPackages: readonly string[];
}

export interface CitationFile {
  readonly file: string;
  readonly text: string;
}

/** Trees excluded from dependency copying and from the citation walk, except the gate source. */
export const SOURCE_ONLY_PREFIXES = [
  "research/",
  "provenance/",
  "src/",
  "tests/",
  "dist/",
  ".cursor/",
  ".donors/",
  ".work/",
  "node_modules/",
] as const;

/** Gate source whose header can cite licences before the compiled file is inserted. */
export const GATE_SOURCE_FILE = "src/lifecycle/gate.ts";

const CITED_PATH =
  /(?:provenance\/licenses\/[A-Za-z0-9_.+-]+\.(?:LICENSE|NOTICE)|LICENSES\/(?:@[A-Za-z0-9_.+-]+\/)?[A-Za-z0-9_.+-]+\.LICENSE)(?![A-Za-z0-9])/g;

const ROOTS = ["NOTICE", "LICENSE"] as const;

/** Exact NOTICE line that starts the held-not-copied list. Citations after it do not ship. */
export const NOT_BUNDLED_HEADING = "Not bundled. Licence texts held in this repository and not copied into dist/:";

const CITATION_TEXT = /(?:^|\/)(?:LICENSE|NOTICE)$|\.(?:LICENSE|NOTICE|md|ya?ml|json|ts|js|mjs|txt|tmpl)$/;

/** Byte-stable path order. `localeCompare` follows the locale and is not a build input. */
export function comparePath(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function citedLicencePaths(text: string): string[] {
  CITED_PATH.lastIndex = 0;
  return text.match(CITED_PATH) ?? [];
}

function splitNotice(text: string) {
  const index = text.indexOf(NOT_BUNDLED_HEADING);
  if (index === -1) return { shipping: text, held: "" };
  return { shipping: text.slice(0, index), held: text.slice(index) };
}

/** Licence paths NOTICE demands into the bundle. Paths under the not-bundled heading are omitted. */
export function shippingCitedLicencePaths(text: string): string[] {
  return [...new Set(citedLicencePaths(splitNotice(text).shipping))].toSorted(comparePath);
}

/** Licence paths NOTICE holds in-repo and does not copy into dist/, unless a shipped header cites them. */
export function heldCitedLicencePaths(text: string): string[] {
  return [...new Set(citedLicencePaths(splitNotice(text).held))].toSorted(comparePath);
}

function isSourceOnly(file: string): boolean {
  return SOURCE_ONLY_PREFIXES.some((prefix) => file.startsWith(prefix));
}

/**
 * Files whose headers (and NOTICE/LICENSE bodies) feed licence citations.
 * `ak validate` and `ak build` call this so they scan the same set.
 */
export function listCitationSources(root: string): CitationFile[] {
  const byFile = new Map<string, string>();
  for (const file of walkFiles(root, ".")) {
    if (isSourceOnly(file) || !CITATION_TEXT.test(file)) continue;
    const text = readTextIfPresent(join(root, file));
    if (text !== null) byFile.set(file, text);
  }
  const gateText = readTextIfPresent(join(root, GATE_SOURCE_FILE));
  if (gateText !== null) byFile.set(GATE_SOURCE_FILE, gateText);
  return [...byFile.entries()]
    .map(([file, text]) => ({ file, text }))
    .toSorted((left, right) => comparePath(left.file, right.file));
}

/** Comment or HTML prefix. A YAML `---` line is frontmatter, so it ends the prefix. */
export function fileHeader(text: string): string {
  const lines = text.split("\n");
  let index = 0;
  const first = lines[0];
  if (first !== undefined && first.startsWith("#!")) index = 1;
  const start = index;
  while (index < lines.length && (lines[index] ?? "").trim() === "") index += 1;
  if ((lines[index] ?? "").trimStart().startsWith("<!--")) {
    while (index < lines.length) {
      const line = lines[index] ?? "";
      index += 1;
      if (line.includes("-->")) break;
    }
    return lines.slice(start, index).join("\n");
  }
  if ((lines[index] ?? "").trimStart().startsWith("/*")) {
    while (index < lines.length) {
      const line = lines[index] ?? "";
      index += 1;
      if (line.includes("*/")) break;
    }
    return lines.slice(start, index).join("\n");
  }
  index = start;
  while (index < lines.length) {
    const trimmed = (lines[index] ?? "").trim();
    if (trimmed === "---") break;
    if (trimmed.length === 0 || trimmed.startsWith("//") || trimmed.startsWith("#")) {
      index += 1;
      continue;
    }
    break;
  }
  return lines.slice(start, index).join("\n");
}

function npmPackageName(bundlePath: string): string | null {
  const prefix = "LICENSES/";
  const suffix = ".LICENSE";
  if (!bundlePath.startsWith(prefix) || !bundlePath.endsWith(suffix)) return null;
  return bundlePath.slice(prefix.length, -suffix.length);
}

function licenceSource(bundlePath: string): string {
  const name = npmPackageName(bundlePath);
  if (name !== null) return `node_modules/${name}/LICENSE`;
  return bundlePath;
}

function missingLicence(source: string): string {
  const remedy = source.startsWith("node_modules/")
    ? `Install dependencies so ${source} is present.`
    : `Restore ${source}.`;
  return `${source} is missing, so the bundle cannot carry it. A licence requires its text to accompany every copy, and dist/ is a copy that gets distributed. ${remedy}`;
}

function uncitedInlined(name: string): string {
  return `The bundle inlines ${name}, and NOTICE does not cite LICENSES/${name}.LICENSE, so neither the bundle nor the inlined file carries it. A licence requires its text to accompany every copy, and dist/ is a copy that gets distributed. Cite LICENSES/${name}.LICENSE from NOTICE. The bytes are read from node_modules/${name}/LICENSE.`;
}

function dottedPackage(name: string): string {
  return `LICENSES/${name}.LICENSE names a package that starts with '.', so the path is not a licence file this bundle can carry.`;
}

function undemandedLicence(source: string): string {
  return `${source} is present under provenance/licenses and no citation demands it, so a matcher miss would leave it out of the bundle. Cite ${source} from NOTICE or a shipped file header.`;
}

function heldAdaptedLicence(file: string, path: string, source: string): string {
  return `${file} is listed as not bundled, and provenance/adaptations.yaml records ${path} from ${source}, so the bundle would carry derived code without that licence text. A licence requires its text to accompany every copy, and dist/ is a copy that gets distributed. Move ${file} out of the not-bundled NOTICE section.`;
}

function unmappedHeldLicence(file: string): string {
  return `${file} is listed as not bundled, and provenance/upstream.lock.yaml records no donor for it, so the held-licence guard cannot tell whether adapted code would ship without that licence text. Name ${file} as license_file or notice_file on a lock donor, or move it out of the not-bundled NOTICE section.`;
}

function missingHeldLicence(file: string): string {
  return `${file} is listed as not bundled, and it is not on disk, so the held-licence record names a text that is not there. Restore ${file}.`;
}

function unreadProvenance(source: string, reason: "missing" | "unparseable" | "invalid"): string {
  if (reason === "missing") {
    return `${source} is missing, so the held-licence guard cannot tell which provenance texts belong to adapted donors. Restore ${source}.`;
  }
  if (reason === "unparseable") {
    return `${source} is not YAML, so the held-licence guard cannot read it. Fix the YAML.`;
  }
  return `${source} does not match its schema, so the held-licence guard cannot read it.`;
}

function unparsedAdaptation(path: string, source: string): string {
  return `provenance/adaptations.yaml records ${path} from ${source}, which is not a donor@commit:path pin, so the held-licence guard cannot tell which licence it belongs to.`;
}

function normalizeLicencePath(path: string): string {
  let out = path.replaceAll("\\", "/");
  while (out.startsWith("./")) out = out.slice(2);
  return out;
}

function licenceKey(path: string): string {
  return normalizeLicencePath(path).toLowerCase();
}

interface DonorLicencePin {
  id: string;
  path?: string;
  license_file?: string;
  notice_file?: string;
}

interface AdaptationRow {
  path: string;
  source?: string;
}

const isLockDonors = new Ajv2020({ strict: false }).compile<{ donors: DonorLicencePin[] }>({
  type: "object",
  required: ["donors"],
  properties: {
    donors: {
      type: "array",
      items: {
        type: "object",
        required: ["id"],
        properties: {
          id: { type: "string" },
          path: { type: "string" },
          license_file: { type: "string" },
          notice_file: { type: "string" },
        },
        additionalProperties: true,
      },
    },
  },
  additionalProperties: true,
});

const isAdaptationsDoc = new Ajv2020({ strict: false }).compile<{ adaptations: AdaptationRow[] }>({
  type: "object",
  required: ["adaptations"],
  properties: {
    adaptations: {
      type: "array",
      items: {
        type: "object",
        required: ["path"],
        properties: {
          path: { type: "string" },
          source: { type: "string" },
        },
        additionalProperties: true,
      },
    },
  },
  additionalProperties: true,
});

interface ProvenanceRead<T> {
  value: T;
  problem: LicenceProblem | null;
}

function readLockDonors(root: string): ProvenanceRead<DonorLicencePin[]> {
  const source = "provenance/upstream.lock.yaml";
  const text = readTextIfPresent(join(root, source));
  if (text === null) return { value: [], problem: { source, message: unreadProvenance(source, "missing") } };
  try {
    const parsed: unknown = parseYaml(text);
    if (!isLockDonors(parsed)) {
      return { value: [], problem: { source, message: unreadProvenance(source, "invalid") } };
    }
    return { value: parsed.donors, problem: null };
  } catch {
    return { value: [], problem: { source, message: unreadProvenance(source, "unparseable") } };
  }
}

function companionNotice(licencePath: string, root: string): string | null {
  if (!licencePath.endsWith(".LICENSE")) return null;
  const notice = `${licencePath.slice(0, -".LICENSE".length)}.NOTICE`;
  return readTextIfPresent(join(root, notice)) === null ? null : notice;
}

/** `license_file` / `notice_file` from the lock. Else NOTICE's `provenance/licenses/<clone-dir>.LICENSE` spelling. */
function donorLicenceFiles(root: string): ProvenanceRead<Map<string, string[]>> {
  const read = readLockDonors(root);
  const files = new Map<string, string[]>();
  for (const entry of read.value) {
    const listed = [];
    if (entry.license_file !== undefined) listed.push(normalizeLicencePath(entry.license_file));
    if (entry.notice_file !== undefined) listed.push(normalizeLicencePath(entry.notice_file));
    if (listed.length === 0 && entry.path !== undefined) {
      const base = normalizeLicencePath(entry.path)
        .split("/")
        .filter((part) => part.length > 0)
        .at(-1);
      if (base !== undefined && base.length > 0) listed.push(`provenance/licenses/${base}.LICENSE`);
    }
    for (const file of listed.slice()) {
      const notice = companionNotice(file, root);
      if (notice !== null && !listed.includes(notice)) listed.push(notice);
    }
    files.set(entry.id, listed);
  }
  return { value: files, problem: read.problem };
}

function loadAdaptationsDocument(root: string): ProvenanceRead<AdaptationRow[]> {
  const source = "provenance/adaptations.yaml";
  const text = readTextIfPresent(join(root, source));
  if (text === null) return { value: [], problem: { source, message: unreadProvenance(source, "missing") } };
  try {
    const parsed: unknown = parseYaml(text);
    if (!isAdaptationsDoc(parsed)) {
      return { value: [], problem: { source, message: unreadProvenance(source, "invalid") } };
    }
    return { value: parsed.adaptations, problem: null };
  } catch {
    return { value: [], problem: { source, message: unreadProvenance(source, "unparseable") } };
  }
}

function dutyRank(path: string): number {
  if (path === "NOTICE") return 0;
  if (path === "LICENSE") return 1;
  return 2;
}

export function licenceClosure(
  root: string,
  shipped: readonly { file: string; text: string }[],
  inlinedPackages: readonly string[],
): LicenceClosure {
  const duties: LicenceDuty[] = [];
  const problems: LicenceProblem[] = [];
  const covered = new Set<string>();
  const demanded = new Set<string>();
  const queue: string[] = [];
  let noticeText = "";

  for (const filename of ROOTS) {
    const text = readTextIfPresent(join(root, filename));
    if (text === null) {
      problems.push({ source: filename, message: missingLicence(filename) });
      continue;
    }
    duties.push({ source: filename, path: filename, text });
    if (filename === "NOTICE") {
      noticeText = text;
      for (const path of citedLicencePaths(splitNotice(text).shipping)) queue.push(path);
    }
  }

  for (const entry of shipped) {
    if (entry.file === "NOTICE" || entry.file === "LICENSE") continue;
    for (const path of citedLicencePaths(fileHeader(entry.text))) queue.push(path);
  }

  let index = 0;
  while (index < queue.length) {
    const bundlePath = queue[index];
    index += 1;
    if (bundlePath === undefined || demanded.has(bundlePath)) continue;
    demanded.add(bundlePath);
    const packageName = npmPackageName(bundlePath);
    if (packageName !== null && packageName.startsWith(".")) {
      problems.push({ source: bundlePath, message: dottedPackage(packageName) });
      continue;
    }
    if (packageName !== null) covered.add(packageName);
    const source = licenceSource(bundlePath);
    const text = readTextIfPresent(join(root, source));
    if (text === null) {
      problems.push({ source, message: missingLicence(source) });
      continue;
    }
    duties.push({ source, path: bundlePath, text });
    for (const path of citedLicencePaths(text)) queue.push(path);
  }

  const seenInlined = new Set<string>();
  for (const name of inlinedPackages) {
    if (seenInlined.has(name)) continue;
    seenInlined.add(name);
    if (name.startsWith(".")) {
      problems.push({ source: `node_modules/${name}`, message: dottedPackage(name) });
      continue;
    }
    if (demanded.has(`LICENSES/${name}.LICENSE`)) continue;
    problems.push({ source: `node_modules/${name}`, message: uncitedInlined(name) });
  }

  const held = new Set(citedLicencePaths(splitNotice(noticeText).held));
  const donorFiles = donorLicenceFiles(root);
  if (donorFiles.problem !== null) problems.push(donorFiles.problem);
  const donorsByLicence = new Map<string, string[]>();
  for (const [donor, files] of donorFiles.value) {
    for (const file of files) {
      const key = licenceKey(file);
      const ids = donorsByLicence.get(key) ?? [];
      if (!ids.includes(donor)) ids.push(donor);
      donorsByLicence.set(key, ids);
    }
  }
  const adaptations = loadAdaptationsDocument(root);
  if (adaptations.problem !== null) problems.push(adaptations.problem);
  const rowsByDonor = new Map<string, { path: string; source: string }[]>();
  for (const row of adaptations.value) {
    if (row.source === undefined) {
      problems.push({
        source: "provenance/adaptations.yaml",
        message: unparsedAdaptation(row.path, "(missing source)"),
      });
      continue;
    }
    const parsed = parseDonorSource(row.source);
    if (parsed === null) {
      if (parseLocalAdaptationSource(row.source) !== null) continue;
      problems.push({ source: "provenance/adaptations.yaml", message: unparsedAdaptation(row.path, row.source) });
      continue;
    }
    const rows = rowsByDonor.get(parsed.donor) ?? [];
    rows.push({ path: row.path, source: row.source });
    rowsByDonor.set(parsed.donor, rows);
  }
  for (const file of held) {
    if (readTextIfPresent(join(root, file)) === null) {
      problems.push({ source: file, message: missingHeldLicence(file) });
      continue;
    }
    const donors = donorsByLicence.get(licenceKey(file));
    if (donors === undefined) {
      problems.push({ source: file, message: unmappedHeldLicence(file) });
      continue;
    }
    for (const donor of donors) {
      const rows = rowsByDonor.get(donor);
      if (rows === undefined) continue;
      const [row] = rows.toSorted(
        (left, right) => comparePath(left.path, right.path) || comparePath(left.source, right.source),
      );
      if (row === undefined) continue;
      problems.push({ source: file, message: heldAdaptedLicence(file, row.path, row.source) });
    }
  }
  for (const file of walkFiles(root, "provenance/licenses")) {
    if (demanded.has(file) || held.has(file)) continue;
    problems.push({ source: file, message: undemandedLicence(file) });
  }

  const orderedDuties = duties.toSorted(
    (left, right) => dutyRank(left.path) - dutyRank(right.path) || comparePath(left.path, right.path),
  );
  const orderedProblems = problems.toSorted((left, right) => comparePath(left.source, right.source));
  return {
    duties: orderedDuties,
    problems: orderedProblems,
    coveredPackages: [...covered].toSorted(comparePath),
  };
}

/** Comment block for `bin/ak` and `bin/ak-gate.mjs`. Headings use the bundle path, before relocation. */
export function licenceBanner(duties: readonly LicenceDuty[]): string {
  const lines = [
    "// Licence texts for this file and the third-party code inlined into it.",
    "// Each block is also copied into the plugin bundles at the path in its heading.",
  ];
  for (const duty of duties) {
    lines.push(`// --- ${duty.path} ---`);
    const body = duty.text.endsWith("\n") ? duty.text.slice(0, -1) : duty.text;
    for (const line of body.split("\n")) lines.push(line.length === 0 ? "//" : `// ${line}`);
  }
  return `${lines.join("\n")}\n`;
}
