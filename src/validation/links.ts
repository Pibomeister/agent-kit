import { join } from "node:path";

import { exists, isDir, readTextIfPresent, walkFiles } from "../util/fs.ts";
import { extractRelativeLinks, relativeLinkBetween, resolveFromFile } from "../util/links.ts";
import { entryBodyPath } from "../catalog/layout.ts";
import { planAll, type BuildOptions } from "../packaging/build.ts";
import { codeSpans, escapesTree, rootPathOf, schemaRefs } from "../packaging/mentions.ts";
import { SHARED_ROOT } from "../packaging/plan.ts";
import type { CheckContext } from "./context.ts";
import { error, type Issue } from "./types.ts";

/** Every tree whose markdown a bundle may need to carry. */
const LINKED_DIRS = ["skills", "packs", "protocols", "roles", "references", "adapters", "templates"];

export function linkedMarkdownFiles(root: string): string[] {
  const out: string[] = [];
  for (const dir of LINKED_DIRS) for (const file of walkFiles(root, dir)) if (file.endsWith(".md")) out.push(file);
  return out.sort();
}

/** Half one of link closure: every relative reference resolves in the source tree. */
export function checkSourceLinks(ctx: CheckContext): Issue[] {
  const issues: Issue[] = [];

  for (const file of linkedMarkdownFiles(ctx.root)) {
    const text = readTextIfPresent(join(ctx.root, file));
    if (text === null) continue;
    for (const link of extractRelativeLinks(text)) {
      const resolved = resolveFromFile(file, link.target);
      if (resolved === null) {
        issues.push(
          error(
            "links.escapes-tree",
            file,
            `Reference '${link.target}' resolves outside the repository root.`,
            link.line,
          ),
        );
        continue;
      }
      const full = join(ctx.root, resolved);
      if (!exists(full) && !isDir(full)) {
        issues.push(
          error(
            "links.broken-source",
            file,
            `Reference '${link.target}' does not resolve; '${resolved}' does not exist.`,
            link.line,
          ),
        );
      }
    }
  }

  return issues;
}

/**
 * The reciprocal of `catalog.reference-loaded-by-names-a-declared-skill`.
 *
 * That rule reads catalog.yaml only: a pack must name its loaders, and each
 * loader must be a declared skill. Nothing read the loader's body, so the
 * relationship the catalog declares could be absent from the tree entirely and
 * validation still returned clean. AUTHORING.md §12.5 makes `loaded_by` the
 * defining property of a reference pack -- progressive disclosure is the
 * mechanism, and a pack nothing links is unreachable -- so an unlinked pack is
 * not a reference pack missing a nicety. It is not a reference pack.
 *
 * Both ends gate on `status: authored`, which is the design and not a
 * shortcut. Each declared edge becomes checkable at the first commit where
 * both of its files exist, and is silent before that: gating on the pack alone
 * would fail a batch for not linking a loader nobody has written yet, and
 * gating on the loader alone would never check a newly authored pack against
 * the skills already in the tree.
 *
 * What counts as a link is `extractRelativeLinks` and `resolveFromFile`, the
 * same pair `checkSourceLinks` uses, so "links to" means one thing in this
 * validator rather than two that can drift.
 */
export function checkLoaderLinks(ctx: CheckContext): Issue[] {
  const issues: Issue[] = [];
  const { root, catalog } = ctx;

  for (const pack of catalog.bySection("references")) {
    if (pack.status !== "authored") continue;
    const target = entryBodyPath("references", pack.id);

    for (const loaderId of pack.loadedBy) {
      const loader = catalog.get("skills", loaderId);
      if (loader === undefined || loader.status !== "authored") continue;

      const body = entryBodyPath("skills", loaderId);
      const text = readTextIfPresent(join(root, body));
      /**
       * An authored skill with no body is `catalog.entry-without-directory` or
       * `catalog.missing-body` from checkCompleteness, which names that file
       * and that defect. Reporting it twice would bury the actionable error,
       * and "add a link to a file that does not exist" is not a followable
       * instruction. The run still fails; it fails under the right rule.
       */
      if (text === null) continue;

      if (extractRelativeLinks(text).some((link) => resolveFromFile(body, link.target) === target)) continue;

      issues.push(
        error(
          "catalog.loader-does-not-link-reference",
          body,
          `Reference pack '${pack.id}' is loaded_by '${loaderId}', but ${body} contains no link to ${target}. Add one -- from this file it is written '${relativeLinkBetween(body, target)}'. loaded_by declares progressive disclosure, and a pack its loader never links cannot be reached.`,
        ),
      );
    }
  }

  return issues;
}

/**
 * Half two of link closure, and the half that actually breaks in installed
 * bundles: after the packager has copied transitive dependencies into
 * references/shared/ and rewritten the links, every relative reference must
 * still resolve inside the bundle.
 */
export function checkBundleLinks(ctx: CheckContext, options: BuildOptions): Issue[] {
  const issues: Issue[] = [];
  const authored = (section: "roles" | "protocols") =>
    new Set(
      ctx.catalog
        .bySection(section)
        .filter((entry) => entry.status === "authored")
        .map((entry) => entry.id),
    );
  const ids = { roles: authored("roles"), protocols: authored("protocols") };

  for (const plan of planAll(ctx, options)) {
    issues.push(
      ...plan.issues.filter(
        (issue) => issue.rule === "packaging.gate-build-failed" || issue.rule === "packaging.project-invalid",
      ),
    );
    const present = new Set(plan.files.keys());
    const dirs = new Set<string>();
    for (const path of present) {
      const parts = path.split("/");
      for (let i = 1; i < parts.length; i += 1) dirs.add(parts.slice(0, i).join("/"));
    }

    for (const file of plan.files.values()) {
      if (file.path.endsWith(".schema.json")) {
        for (const ref of schemaRefs(file.path, file.contents)) {
          if (present.has(ref)) continue;
          issues.push(
            error(
              "links.broken-bundle",
              `dist/${plan.host}/${file.path}`,
              `A relative $ref resolves to '${ref}', which is not in the ${plan.host} bundle.`,
            ),
          );
        }
        continue;
      }
      if (!file.path.endsWith(".md")) continue;
      for (const link of extractRelativeLinks(file.contents)) {
        const resolved = resolveFromFile(file.path, link.target);
        const where = `dist/${plan.host}/${file.path}`;
        if (resolved === null) {
          issues.push(
            error("links.broken-bundle", where, `Reference '${link.target}' escapes the bundle root.`, link.line),
          );
          continue;
        }
        if (present.has(resolved) || dirs.has(resolved)) continue;
        issues.push(
          error(
            "links.broken-bundle",
            where,
            `Reference '${link.target}' resolves in the source tree but '${resolved}' is not in the ${plan.host} bundle. The packager must copy it into ${SHARED_ROOT}/ or the reference must be removed.`,
            link.line,
          ),
        );
      }
      if (file.verbatim !== true) issues.push(...unlinkedMentions(plan.host, file.path, file.contents, ids));
    }
  }

  return issues;
}

/**
 * A seat, protocol or schema a bundled body names by root path, role id or ``protocol `<id>` ``
 * must arrive as a link, because the packager links every one it can carry
 * (`src/packaging/mentions.ts`). A span still plain in the bundle names a file the source tree does
 * not have, or the packager stopped carrying it; either way the installed skill would stop
 * `unavailable` when it reached for it. A path that climbs out of its tree is refused outright.
 */
export function unlinkedMentions(
  host: string,
  path: string,
  text: string,
  ids: { roles: ReadonlySet<string>; protocols: ReadonlySet<string> },
): Issue[] {
  const issues: Issue[] = [];
  const where = `dist/${host}/${path}`;
  for (const { span, line, linked, protocolCited } of codeSpans(text)) {
    if (linked) continue;
    const root = rootPathOf(span);
    let message: string | null = null;
    if (escapesTree(span))
      message = `'${span}' leaves its tree through a '.', '..' or empty segment, so the packager does not follow it. Name the file by its path from the repository root.`;
    else if (root !== null)
      message = `'${root.path}' is named here, and the ${host} bundle does not carry it. The packager copies every file or catalog entry a bundled body names by root path into ${SHARED_ROOT}/ and links it; write a path that exists in the source tree, or name it without a root path.`;
    else if (protocolCited ? ids.protocols.has(span) : ids.roles.has(span))
      message = `${protocolCited ? "Protocol" : "Role"} '${span}' is named here, and the ${host} bundle does not carry its body as a link. The packager links every authored ${protocolCited ? "protocol cited as protocol `<id>` or the `<id>` protocol" : "role"} a bundled body names; check that it is authored.`;
    if (message !== null) issues.push(error("links.mention-not-bundled", where, message, line));
  }
  return issues;
}
