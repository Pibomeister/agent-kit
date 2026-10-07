import { describe, expect, test } from "bun:test";

import { extractRelativeLinks, resolveFromFile } from "../src/util/links.ts";
import { checkSourceLinks } from "../src/validation/links.ts";
import { loadCatalog } from "../src/catalog/load.ts";
import { makeTree } from "./helpers/tree.ts";

const CATALOG = `schema_version: 1
package:
  id: ak
  name: agent-kit
  version: 0.1.0
  namespace: "/ak:"
  default_profile: core
skills:
  - id: alpha
    status: authored
    invocation: U
protocols:
  - id: tdd
    status: authored
`;

function ctxFor(files: Record<string, string>) {
  const root = makeTree({ "catalog.yaml": CATALOG, ...files });
  const { catalog } = loadCatalog(root);
  if (catalog === null) throw new Error("fixture has no catalog");
  return { root, catalog };
}

const HEAD = "---\nname: alpha\ndescription: d\n---\n";

describe("relative link extraction", () => {
  test("finds markdown link targets", () => {
    const links = extractRelativeLinks("See [the protocol](../../protocols/tdd/PROTOCOL.md) first.\n");
    expect(links.map((l) => l.target)).toEqual(["../../protocols/tdd/PROTOCOL.md"]);
    expect(links[0]?.line).toBe(1);
  });

  test("finds bare relative paths written in inline code", () => {
    const links = extractRelativeLinks("Read `../../protocols/tdd/PROTOCOL.md` before starting.\n");
    expect(links.map((l) => l.target)).toEqual(["../../protocols/tdd/PROTOCOL.md"]);
  });

  test("finds ./ prefixed targets and records column-free line numbers", () => {
    const links = extractRelativeLinks("a\nb\n[x](./references/detail.md)\n");
    expect(links[0]).toMatchObject({ target: "./references/detail.md", line: 3 });
  });

  test("ignores absolute URLs, anchors and mail links", () => {
    const text = "[a](https://example.com/x.md) [b](#section) [c](mailto:x@y.z) [d](/abs/path.md)\n";
    expect(extractRelativeLinks(text)).toEqual([]);
  });

  test("strips a trailing anchor from the target", () => {
    const links = extractRelativeLinks("[a](../x/PROTOCOL.md#step-2)\n");
    expect(links[0]?.target).toBe("../x/PROTOCOL.md");
    expect(links[0]?.anchor).toBe("step-2");
  });

  test("deduplicates the same target on the same line", () => {
    const links = extractRelativeLinks("[a](../x.md) and `../x.md`\n");
    expect(links.length).toBe(1);
  });

  test("resolveFromFile normalizes against the referencing file's directory", () => {
    expect(resolveFromFile("skills/alpha/SKILL.md", "../../protocols/tdd/PROTOCOL.md")).toBe(
      "protocols/tdd/PROTOCOL.md",
    );
    expect(resolveFromFile("skills/alpha/SKILL.md", "./references/d.md")).toBe("skills/alpha/references/d.md");
  });

  test("resolveFromFile returns null for a target that escapes the tree", () => {
    expect(resolveFromFile("skills/alpha/SKILL.md", "../../../outside.md")).toBeNull();
  });
});

describe("source-tree link closure", () => {
  test("a resolvable relative reference passes", () => {
    const ctx = ctxFor({
      "skills/alpha/SKILL.md": `${HEAD}\nSee [tdd](../../protocols/tdd/PROTOCOL.md).\n`,
      "protocols/tdd/PROTOCOL.md": "# TDD\n",
    });
    expect(checkSourceLinks(ctx)).toEqual([]);
  });

  test("a dangling relative reference is an error naming the file, line and target", () => {
    const ctx = ctxFor({ "skills/alpha/SKILL.md": `${HEAD}\nSee [tdd](../../protocols/tdd/PROTOCOL.md).\n` });
    const issue = checkSourceLinks(ctx).find((i) => i.rule === "links.broken-source");
    expect(issue?.severity).toBe("error");
    expect(issue?.file).toBe("skills/alpha/SKILL.md");
    expect(issue?.line).toBe(6);
    expect(issue?.message).toContain("protocols/tdd/PROTOCOL.md");
  });

  test("a reference escaping the repository root is an error", () => {
    const ctx = ctxFor({ "skills/alpha/SKILL.md": `${HEAD}\n[x](../../../etc/passwd)\n` });
    expect(checkSourceLinks(ctx).some((i) => i.rule === "links.escapes-tree")).toBe(true);
  });

  test("links inside shared resources are checked too, not only skill bodies", () => {
    const ctx = ctxFor({
      "skills/alpha/SKILL.md": HEAD,
      "protocols/tdd/PROTOCOL.md": "See [role](../../roles/implementer/ROLE.md).\n",
    });
    const issue = checkSourceLinks(ctx).find((i) => i.rule === "links.broken-source");
    expect(issue?.file).toBe("protocols/tdd/PROTOCOL.md");
  });

  // Literal, not LINKED_DIRS: every directory whose markdown carries links, each with a broken one.
  test.each(["skills", "packs", "protocols", "roles", "references", "adapters", "templates"])(
    "a broken link in a %s markdown file is reported",
    (dir) => {
      const file = `${dir}/x/NOTES.md`;
      const ctx = ctxFor({ "skills/alpha/SKILL.md": HEAD, [file]: "See [gone](./missing.md).\n" });
      expect(
        checkSourceLinks(ctx)
          .filter((i) => i.rule === "links.broken-source")
          .map((i) => i.file),
      ).toEqual([file]);
    },
  );

  test("a link to a directory that exists is accepted", () => {
    const ctx = ctxFor({
      "skills/alpha/SKILL.md": `${HEAD}\n[dir](../../protocols/tdd/)\n`,
      "protocols/tdd/PROTOCOL.md": "# TDD\n",
    });
    expect(checkSourceLinks(ctx)).toEqual([]);
  });
});

describe("link closure after packaging", () => {
  const PKG_CATALOG = `schema_version: 1
package:
  id: ak
  name: agent-kit
  version: 0.1.0
  namespace: "/ak:"
  default_profile: core
skills:
  - id: alpha
    status: authored
    invocation: U
    profiles: [core]
  - id: beta
    status: authored
    invocation: M
    profiles: [autonomy]
protocols:
  - id: tdd
    status: authored
roles:
  - id: implementer
    status: authored
profiles:
  - id: core
    status: authored
  - id: autonomy
    status: authored
`;

  function pkgCtx(files: Record<string, string>) {
    const root = makeTree({ "catalog.yaml": PKG_CATALOG, ...files });
    const { catalog } = loadCatalog(root);
    if (catalog === null) throw new Error("fixture has no catalog");
    return { root, catalog };
  }

  test("a link into a shared protocol still resolves once the packager has copied it", async () => {
    const { checkBundleLinks } = await import("../src/validation/links.ts");
    const ctx = pkgCtx({
      "skills/alpha/SKILL.md": `${HEAD}\nSee [tdd](../../protocols/tdd/PROTOCOL.md).\n`,
      "skills/beta/SKILL.md": "---\nname: beta\ndescription: d\n---\nbody\n",
      "protocols/tdd/PROTOCOL.md": "# TDD\n\nSee [impl](../../roles/implementer/ROLE.md).\n",
      "roles/implementer/ROLE.md": "# Implementer\n",
    });
    expect(checkBundleLinks(ctx, {})).toEqual([]);
  });

  test("a link that resolves in the source tree but dangles in the bundle is an error", async () => {
    const { checkBundleLinks } = await import("../src/validation/links.ts");
    const ctx = pkgCtx({
      "skills/alpha/SKILL.md": `${HEAD}\nSee [notes](../../research/sources/notes.md).\n`,
      "skills/beta/SKILL.md": "---\nname: beta\ndescription: d\n---\nbody\n",
      "research/sources/notes.md": "# Notes\n",
    });
    expect(checkSourceLinks(ctx)).toEqual([]);
    const issue = checkBundleLinks(ctx, {}).find((i) => i.rule === "links.broken-bundle");
    expect(issue?.severity).toBe("error");
    expect(issue?.message).toContain("research/sources/notes.md");
    expect(issue?.file).toContain("dist/claude-code/skills/alpha/SKILL.md");
  });

  test("a cross-skill link dangles when the profile excludes the target skill", async () => {
    const { checkBundleLinks } = await import("../src/validation/links.ts");
    const ctx = pkgCtx({
      "skills/alpha/SKILL.md": `${HEAD}\nSee [beta](../beta/SKILL.md).\n`,
      "skills/beta/SKILL.md": "---\nname: beta\ndescription: d\n---\nbody\n",
      "profiles/core.yaml": "id: core\nskills: [alpha]\n",
    });
    expect(checkSourceLinks(ctx)).toEqual([]);
    expect(checkBundleLinks(ctx, { profile: "core" }).some((i) => i.rule === "links.broken-bundle")).toBe(true);
  });

  test("closure is verified for every host bundle, not only the first", async () => {
    const { checkBundleLinks } = await import("../src/validation/links.ts");
    const ctx = pkgCtx({
      "skills/alpha/SKILL.md": `${HEAD}\nSee [notes](../../research/sources/notes.md).\n`,
      "skills/beta/SKILL.md": "---\nname: beta\ndescription: d\n---\nbody\n",
      "research/sources/notes.md": "# Notes\n",
    });
    const files = new Set(checkBundleLinks(ctx, {}).map((i) => i.file.split("/").slice(0, 2).join("/")));
    expect([...files].sort()).toEqual(["dist/claude-code", "dist/codex"]);
  });
});

/**
 * `loaded_by` was enforced in one direction only: `checkCatalogRules` fails a
 * reference pack naming no loader, or naming a loader that is not a declared
 * skill. Nothing read the loader's body, so the relationship catalog.yaml
 * declares could be entirely absent from the tree and `ak validate` returned
 * clean -- and §12.5 makes `loaded_by` the defining property of the shape, so
 * a pack no skill links is not an under-documented reference pack, it is not a
 * reference pack.
 *
 * Both sides gate on `status: authored`, which is the design rather than a
 * simplification waiting to happen. A pack is checked against the loaders that
 * exist, and a loader against the packs that exist, so each edge fires at the
 * first commit where both its files are written and never before. Gating on
 * the pack alone would fail a batch for not linking a pack nobody has authored
 * yet; gating on the loader alone would never check a new pack against the
 * skills already written.
 */
const LOADER_PACKAGE = `schema_version: 1
package:
  id: ak
  name: agent-kit
  version: 0.1.0
  namespace: "/ak:"
  default_profile: core
`;

function loaderCtx(sections: string, files: Record<string, string>) {
  const root = makeTree({ "catalog.yaml": LOADER_PACKAGE + sections, ...files });
  const { catalog } = loadCatalog(root);
  if (catalog === null) throw new Error("fixture has no catalog");
  return { root, catalog };
}

/** Both sides authored: the state in which the rule is meant to fire. */
const BOTH_AUTHORED = `skills:
  - id: alpha
    status: authored
    invocation: U
references:
  - id: guide
    status: authored
    loaded_by: [alpha]
`;

const PACK_BODY = "# Guide\n\nLong material.\n";

describe("a declared loader links the pack it loads", () => {
  test("both authored and the link present is silent", async () => {
    // The direction a gate test cannot establish on its own, and the one that
    // matters most here: references/ is empty in this tree today, so nothing
    // in the repository distinguishes a rule that works from one that never
    // fires. A rule that reported every authored pair would pass the error
    // test below and fail only here.
    const { checkLoaderLinks } = await import("../src/validation/links.ts");
    const ctx = loaderCtx(BOTH_AUTHORED, {
      "skills/alpha/SKILL.md": `${HEAD}\nRead [the guide](../../references/guide/REFERENCE.md) first.\n`,
      "references/guide/REFERENCE.md": PACK_BODY,
    });
    expect(checkLoaderLinks(ctx)).toEqual([]);
  });

  test("both authored and no link is an error naming the file that must change", async () => {
    // The message names the loader body, not only the unlinked pack. Batch 6
    // is the first batch that must edit bodies it did not write -- a pack
    // landing makes this fire on skills from three batches earlier -- so the
    // writer receives an error while holding the pack and needs to be told
    // which other file to edit rather than being left to work it out.
    const { checkLoaderLinks } = await import("../src/validation/links.ts");
    const ctx = loaderCtx(BOTH_AUTHORED, {
      "skills/alpha/SKILL.md": `${HEAD}\nNo mention of it at all.\n`,
      "references/guide/REFERENCE.md": PACK_BODY,
    });
    const issue = checkLoaderLinks(ctx).find((i) => i.rule === "catalog.loader-does-not-link-reference");
    expect(issue?.severity).toBe("error");
    expect(issue?.file).toBe("skills/alpha/SKILL.md");
    expect(issue?.message).toContain("references/guide/REFERENCE.md");
    expect(issue?.message).toContain("guide");
  });

  test("a pack authored ahead of its loader is silent", async () => {
    // batch 6's `simplify` row: the pack lands in 6, the loader is written in
    // 9. If this fired, a batch would be blocked by a file its plan does not
    // schedule until three batches later.
    //
    // The contract loader is given a body on purpose. Written without one --
    // the ordinary shape of a contract entry -- this test passes whether the
    // loader's status is checked or not, because the body read finds nothing
    // and the pair is skipped before the status is ever consulted. Measured:
    // with no body here, deleting the `status !== "authored"` gate from the
    // implementation leaves the whole suite green. A body present while the
    // catalog still says `contract` is `catalog.status-behind-body`, a warning
    // this repo hits whenever a batch writes bodies before flipping the
    // catalog, so it is also the realistic form of the case.
    const { checkLoaderLinks } = await import("../src/validation/links.ts");
    const ctx = loaderCtx(
      `skills:
  - id: alpha
    status: contract
    invocation: U
references:
  - id: guide
    status: authored
    loaded_by: [alpha]
`,
      {
        "skills/alpha/SKILL.md": `${HEAD}\nNo mention of it at all.\n`,
        "references/guide/REFERENCE.md": PACK_BODY,
      },
    );
    expect(checkLoaderLinks(ctx)).toEqual([]);
  });

  test("a loader authored ahead of its pack is silent", async () => {
    // batch 3's `doc-review`, which is loaded by a pack batch 6 writes. If
    // this fired, batch 3 could not pass at all.
    const { checkLoaderLinks } = await import("../src/validation/links.ts");
    const ctx = loaderCtx(
      `skills:
  - id: alpha
    status: authored
    invocation: U
references:
  - id: guide
    status: contract
    loaded_by: [alpha]
`,
      { "skills/alpha/SKILL.md": `${HEAD}\nNo mention of it at all.\n` },
    );
    expect(checkLoaderLinks(ctx)).toEqual([]);
  });

  test("a link to some other pack does not satisfy the edge", async () => {
    // The fails-open shape: a rule asking only whether the body contains any
    // relative link, or any link into references/, would pass this.
    const { checkLoaderLinks } = await import("../src/validation/links.ts");
    const ctx = loaderCtx(BOTH_AUTHORED, {
      "skills/alpha/SKILL.md": `${HEAD}\nRead [elsewhere](../../references/other/REFERENCE.md).\n`,
      "references/guide/REFERENCE.md": PACK_BODY,
      "references/other/REFERENCE.md": PACK_BODY,
    });
    expect(checkLoaderLinks(ctx).map((i) => i.rule)).toEqual(["catalog.loader-does-not-link-reference"]);
  });

  test("each unlinked loader is reported once, and a loader that links is not", async () => {
    const { checkLoaderLinks } = await import("../src/validation/links.ts");
    const ctx = loaderCtx(
      `skills:
  - id: alpha
    status: authored
    invocation: U
  - id: beta
    status: authored
    invocation: U
references:
  - id: guide
    status: authored
    loaded_by: [alpha, beta]
`,
      {
        "skills/alpha/SKILL.md": `${HEAD}\nRead [the guide](../../references/guide/REFERENCE.md).\n`,
        "skills/beta/SKILL.md": "---\nname: beta\ndescription: d\n---\nNothing.\n",
        "references/guide/REFERENCE.md": PACK_BODY,
      },
    );
    expect(checkLoaderLinks(ctx).map((i) => i.file)).toEqual(["skills/beta/SKILL.md"]);
  });

  test("an anchored link counts, and so does a backticked path", async () => {
    // What counts as a link is `extractRelativeLinks`, the same definition
    // `checkSourceLinks` uses. Pinning it here because the batch-3 brief tells
    // writers a backticked path is a link when it carries a `./` prefix, and
    // two definitions of "links to" in one validator is how that instruction
    // and this gate drift apart.
    const { checkLoaderLinks } = await import("../src/validation/links.ts");
    const anchored = loaderCtx(BOTH_AUTHORED, {
      "skills/alpha/SKILL.md": `${HEAD}\nSee [the rule](../../references/guide/REFERENCE.md#naming).\n`,
      "references/guide/REFERENCE.md": PACK_BODY,
    });
    expect(checkLoaderLinks(anchored)).toEqual([]);

    const backticked = loaderCtx(BOTH_AUTHORED, {
      "skills/alpha/SKILL.md": `${HEAD}\nRead \`../../references/guide/REFERENCE.md\` first.\n`,
      "references/guide/REFERENCE.md": PACK_BODY,
    });
    expect(checkLoaderLinks(backticked)).toEqual([]);
  });

  test("a bare path with no ./ prefix is not a link, and does not satisfy the edge", async () => {
    // The other half of the same rule, and the reason the brief spells the
    // prefix out: `references/guide/REFERENCE.md` written without one is
    // prose, not a reference the packager can follow.
    const { checkLoaderLinks } = await import("../src/validation/links.ts");
    const ctx = loaderCtx(BOTH_AUTHORED, {
      "skills/alpha/SKILL.md": `${HEAD}\nRead \`references/guide/REFERENCE.md\` first.\n`,
      "references/guide/REFERENCE.md": PACK_BODY,
    });
    expect(checkLoaderLinks(ctx).map((i) => i.rule)).toEqual(["catalog.loader-does-not-link-reference"]);
  });

  test("an authored loader with no body is left to the check that names that defect", async () => {
    // Not a silent skip: the pair is passed over here because a missing body
    // is already an error from checkCompleteness, which names the file and the
    // reason. Two errors on one absent file would make the actionable one
    // harder to find, and "add a link to a file that does not exist" is not an
    // instruction anyone can follow. Asserted in both directions so the skip
    // cannot quietly become a hole: this check says nothing, and the tree is
    // still red.
    const { checkLoaderLinks } = await import("../src/validation/links.ts");
    const { checkCompleteness } = await import("../src/validation/completeness.ts");
    const ctx = loaderCtx(BOTH_AUTHORED, { "references/guide/REFERENCE.md": PACK_BODY });
    expect(checkLoaderLinks(ctx)).toEqual([]);
    const blocking = checkCompleteness(ctx).filter((i) => i.severity === "error" && i.file.startsWith("skills/alpha"));
    expect(blocking.length).toBeGreaterThan(0);
  });
});
