import { join } from "node:path";

import { readTextIfPresent } from "../util/fs.ts";

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

const CITED_PATH =
  /(?:provenance\/licenses\/[A-Za-z0-9_.+-]+\.(?:LICENSE|NOTICE)|LICENSES\/(?:@[A-Za-z0-9_.+-]+\/)?[A-Za-z0-9_.+-]+\.LICENSE)(?![A-Za-z0-9])/g;

const ROOTS = ["NOTICE", "LICENSE"] as const;

function citedLicencePaths(text: string): string[] {
  CITED_PATH.lastIndex = 0;
  return text.match(CITED_PATH) ?? [];
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
  return `bin/ak inlines ${name}, and NOTICE does not cite LICENSES/${name}.LICENSE, so neither the bundle nor bin/ak carries it. A licence requires its text to accompany every copy, and dist/ is a copy that gets distributed. Cite LICENSES/${name}.LICENSE from NOTICE. The bytes are read from node_modules/${name}/LICENSE.`;
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

  for (const filename of ROOTS) {
    const text = readTextIfPresent(join(root, filename));
    if (text === null) {
      problems.push({ source: filename, message: missingLicence(filename) });
      continue;
    }
    duties.push({ source: filename, path: filename, text });
    if (filename === "NOTICE") {
      for (const path of citedLicencePaths(text)) queue.push(path);
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
    if (demanded.has(`LICENSES/${name}.LICENSE`)) continue;
    problems.push({ source: `node_modules/${name}`, message: uncitedInlined(name) });
  }

  const orderedDuties = duties.toSorted(
    (left, right) => dutyRank(left.path) - dutyRank(right.path) || left.path.localeCompare(right.path),
  );
  const orderedProblems = problems.toSorted((left, right) => left.source.localeCompare(right.source));
  return {
    duties: orderedDuties,
    problems: orderedProblems,
    coveredPackages: [...covered].toSorted((left, right) => left.localeCompare(right)),
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
