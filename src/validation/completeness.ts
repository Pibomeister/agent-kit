import { join } from "node:path";

import { CATALOG_FRAGMENT_DIR, type CatalogEntry } from "../catalog/load.ts";
import {
  DIRECTORY_SECTIONS,
  FILE_SECTIONS,
  MANDATORY_BODY_SECTIONS,
  entryDir,
  entryFilePath,
  preferredBodyFile,
  type DirectorySection,
  type FileSection,
} from "../catalog/layout.ts";
import { exists, isDir, listDirs, listFiles } from "../util/fs.ts";
import type { CheckContext } from "./context.ts";
import { error, note, warning, type Issue } from "./types.ts";

function bodyFiles(root: string, dir: string): string[] {
  return listFiles(join(root, dir)).filter((n) => n.endsWith(".md"));
}

/**
 * Directory ids actually present under a section root, plus the containers that
 * are still waiting for the batch that fills them.
 *
 * A container (e.g. `roles/code-review`) holds seats, not a body of its own:
 * AUTHORING.md §12.2 nests role ids one level, so `code-review/security` is the
 * id and `roles/code-review/` is only the path it lives under. A directory is a
 * container when its name is a proper prefix of one or more declared ids, and
 * its children are checked in its place. An empty one is a batch that has not
 * run yet, which is the same category as `catalog.entry-not-authored` — a note.
 * A directory that is neither an entry nor a prefix of one is still an error.
 */
function presentDirIds(
  root: string,
  section: DirectorySection,
  declared: ReadonlySet<string>,
): { ids: string[]; emptyContainers: string[] } {
  const sectionRoot = join(root, section);
  const ids: string[] = [];
  const emptyContainers: string[] = [];
  for (const top of listDirs(sectionRoot)) {
    if (declared.has(top)) {
      ids.push(top);
      continue;
    }
    const isContainer =
      bodyFiles(root, `${section}/${top}`).length === 0 && [...declared].some((id) => id.startsWith(`${top}/`));
    if (isContainer) {
      const children = listDirs(join(sectionRoot, top));
      if (children.length === 0) emptyContainers.push(top);
      ids.push(...children.map((n) => `${top}/${n}`));
      continue;
    }
    ids.push(top);
  }
  return { ids, emptyContainers };
}

/**
 * Both directions of catalog completeness.
 *
 * `status: contract` with no directory is "declared, not yet authored" — a note.
 * A directory with no entry is always an error: undeclared content is not
 * installable, packageable or referenceable (catalog.yaml header).
 */
export function checkCompleteness(ctx: CheckContext): Issue[] {
  const issues: Issue[] = [];
  const { root, catalog } = ctx;

  for (const section of DIRECTORY_SECTIONS) {
    const entries = catalog.bySection(section);
    const declared = new Set(entries.map((e) => e.id));

    for (const entry of entries) {
      const dir = entryDir(section, entry.id);
      if (!isDir(join(root, dir))) {
        if (entry.status === "authored") {
          issues.push(
            error(
              "catalog.entry-without-directory",
              dir,
              `${entry.file} declares ${section}/${entry.id} as authored but ${dir}/ does not exist.`,
            ),
          );
        } else {
          issues.push(
            note(
              "catalog.entry-not-authored",
              dir,
              `${section}/${entry.id} is declared with status: contract and has no body yet.`,
            ),
          );
        }
        continue;
      }

      const preferred = preferredBodyFile(section);
      const present = bodyFiles(root, dir);
      const hasPreferred = exists(join(root, dir, preferred));
      const mandatory = MANDATORY_BODY_SECTIONS.includes(section);

      if (!hasPreferred) {
        if (present.length === 0) {
          issues.push(error("catalog.entry-missing-body", dir, `${dir}/ exists but has no ${preferred}.`));
        } else {
          const report = mandatory ? error : warning;
          issues.push(
            report(
              "catalog.unexpected-body-name",
              `${dir}/${present[0]}`,
              `${dir}/ has no ${preferred}; found ${present.join(", ")}. The canonical body file name for ${section} is ${preferred}.`,
            ),
          );
        }
      } else if (entry.status === "contract") {
        issues.push(
          warning(
            "catalog.status-behind-body",
            `${dir}/${preferred}`,
            `${dir}/${preferred} exists but ${entry.file} still says status: contract. Set it to authored.`,
          ),
        );
      }
    }

    const onDisk = presentDirIds(root, section, declared);
    for (const container of onDisk.emptyContainers) {
      issues.push(
        note(
          "catalog.container-without-entries",
          `${section}/${container}`,
          `${section}/${container}/ groups the declared ids beneath it and has none on disk yet. Nothing is missing until one of them is authored.`,
        ),
      );
    }
    for (const id of onDisk.ids) {
      if (declared.has(id)) continue;
      issues.push(
        error(
          "catalog.directory-without-entry",
          `${section}/${id}`,
          `${section}/${id}/ exists but catalog.yaml declares no ${section} entry '${id}', and no ${CATALOG_FRAGMENT_DIR}/ fragment does. Nothing is installable unless it is declared.`,
        ),
      );
    }
  }

  issues.push(...checkFileSections(ctx));
  return issues;
}

function declaredFilePaths(entries: ReadonlyArray<CatalogEntry>, section: FileSection): Set<string> {
  return new Set(entries.map((e) => entryFilePath(section, e.id)));
}

function checkFileSections(ctx: CheckContext): Issue[] {
  const issues: Issue[] = [];
  const { root, catalog } = ctx;

  for (const section of FILE_SECTIONS) {
    const entries = catalog.bySection(section);
    for (const entry of entries) {
      const path = entryFilePath(section, entry.id);
      if (exists(join(root, path))) {
        if (entry.status === "contract") {
          issues.push(
            warning(
              "catalog.status-behind-body",
              path,
              `${path} exists but ${entry.file} still says status: contract. Set it to authored.`,
            ),
          );
        }
        continue;
      }
      if (entry.status === "authored") {
        issues.push(
          error(
            "catalog.entry-without-file",
            path,
            `${entry.file} declares ${section}/${entry.id} as authored but ${path} does not exist.`,
          ),
        );
      } else {
        issues.push(
          note(
            "catalog.entry-not-authored",
            path,
            `${section}/${entry.id} is declared with status: contract and has no file yet.`,
          ),
        );
      }
    }

    const declared = declaredFilePaths(entries, section);
    if (section === "adapters") {
      for (const dir of listDirs(join(root, "adapters"))) {
        if (!declared.has(entryFilePath("adapters", dir))) {
          issues.push(
            error(
              "catalog.file-without-entry",
              `adapters/${dir}`,
              `adapters/${dir}/ exists but catalog.yaml declares no adapters entry '${dir}', and no ${CATALOG_FRAGMENT_DIR}/ fragment does.`,
            ),
          );
        }
      }
      continue;
    }
    for (const name of listFiles(join(root, section))) {
      if (!name.endsWith(section === "schemas" ? ".schema.json" : ".yaml")) continue;
      const path = `${section}/${name}`;
      if (!declared.has(path)) {
        issues.push(
          error(
            "catalog.file-without-entry",
            path,
            `${path} exists but catalog.yaml declares no ${section} entry for it, and no ${CATALOG_FRAGMENT_DIR}/ fragment does.`,
          ),
        );
      }
    }
  }

  return issues;
}
