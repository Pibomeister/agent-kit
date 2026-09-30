import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

import { loadCatalog } from "../src/catalog/load.ts";
import { compileSchemas } from "../src/validation/schemas.ts";
import { checkCompleteness } from "../src/validation/completeness.ts";
import { HOST_IDS, RESTRICTIONS, loadHostCapabilities } from "../src/packaging/hosts.ts";
import { MODE_CEILING_CHECK } from "../src/packaging/capability-table.ts";
import { INSTALL_FILE, checkInstallConfig, describeInstall, loadAdapterSupplies, loadInstallConfig } from "../src/packaging/install.ts";
import { planBundle } from "../src/packaging/plan.ts";
import { writeBundles, checkBundles } from "../src/packaging/build.ts";
import { hasBlockingSkips, hasErrors } from "../src/validation/types.ts";
import { makeTree } from "./helpers/tree.ts";

const HEAD = (name: string) => `---\nname: ${name}\ndescription: Use when asked.\n---\n`;

/** This repository, for the tests that measure against its real schemas. */
const REPO = join(import.meta.dir, "..");

const CATALOG = `schema_version: 1
package:
  id: ak
  name: agent-kit
  version: 0.1.0
  namespace: "/ak:"
  default_profile: core
  description: What the host is told, which is a different sentence again.
  author: agent-kit maintainers
  license: MIT
skills:
  - id: alpha
    status: authored
    invocation: U
    profiles: [core]
  - id: beta
    status: authored
    invocation: M
    profiles: [core, autonomy]
protocols:
  - id: tdd
    status: authored
roles:
  - id: implementer
    status: authored
adapters:
  - id: claude-code
    status: authored
  - id: codex
    status: authored
profiles:
  - id: core
    status: authored
  - id: autonomy
    status: authored
`;

/**
 * The npm package's own identity, which §5.2 makes a party to two fields and
 * not to the other two.
 *
 * `version` and `license` match `CATALOG` above because they are compared; a
 * fixture whose two sides already disagreed would make every test in this file
 * report a parity failure about the fixture rather than about the code.
 *
 * `name` and `description` deliberately do NOT match, and that is the whole
 * point of the fixture. `adapters/codex/CONTRACT.md` §5.2 says "`package.json`
 * is not a party to either": package.json names and describes the npm package,
 * a manifest names and describes what the host addresses, and a check forcing
 * them to agree is satisfiable only by renaming one of them to suit the check.
 * Stated here as a divergence rather than as one test, so a check that
 * re-acquired either comparison fails every test in the file instead of the one
 * written to catch it.
 */
const PACKAGE_JSON: Record<string, unknown> = {
  name: "fixture-package",
  version: "0.1.0",
  description: "What the npm registry is told, which is a different sentence.",
  license: "MIT",
};

const packageJson = (doc: Record<string, unknown>) => `${JSON.stringify(doc, null, 2)}\n`;

const BASE: Record<string, string> = {
  "catalog.yaml": CATALOG,
  // In every fixture because it is in every real tree: `ak` runs from a package
  // root. A plan with no package.json to agree with is not a plan with nothing
  // to check -- it is the manifests sitting in front of the check with no
  // authority to judge them by, which the check reports rather than passes.
  "package.json": packageJson(PACKAGE_JSON),
  // In every fixture for the same reason package.json is, and it is the same
  // reason: §3's capability table is the authority every `packaging.hosts[]`
  // mode is measured against, so a tree without it is not a tree where every
  // declaration passes -- it is the declarations sitting in front of the check
  // with nothing to judge them by. One file for both hosts, because
  // `adapters/codex/CONTRACT.md` §3 states that it carries no per-capability
  // difference and that a second copy would be "a second thing to keep in step".
  //
  // Six rows rather than the real sixteen, covering all four statuses and both
  // capabilities that actually block anything in this tree. Deliberately not a
  // copy of §3: a fixture that mirrored it would drift, and the one test that
  // needs §3 to be complete measures the real file against the real schema
  // enum, in tests/capability-table.test.ts.
  "adapters/claude-code/CONTRACT.md": [
    "# claude-code",
    "",
    "## 3. Capability support",
    "",
    "| Capability | Status | Detail |",
    "|---|---|---|",
    "| `repository-read` | `satisfied` | Read, Glob, Grep |",
    "| `process-exec` | `satisfied` | Bash |",
    "| `artifact-write` | `partial` | Storage, not hash binding |",
    "| `isolated-worktree` | `convention-only` | Not host-confined |",
    "| `kb-write` | `not-provided` | Transport only |",
    "| `runner-grants` | `not-provided` | No grant validator |",
    "| `trusted-evidence` | `not-provided` | Worker cannot attest its own evidence |",
    "",
    "## 4. Host-capability honesty",
    "",
    "A host that cannot enforce a restriction an autonomous run requires exposes the affected",
    "skill in guided/manual mode and rejects autonomous mode.",
    "",
  ].join("\n"),
  "skills/alpha/SKILL.md": `${HEAD("alpha")}\nFollow [tdd](../../protocols/tdd/PROTOCOL.md).\n`,
  "skills/alpha/skill.yaml": "id: alpha\nversion: 0.1.0\ninvocation: U\nargument_hint: <ticket>\nallowed_tools: [Read, Grep]\n",
  "skills/beta/SKILL.md": `${HEAD("beta")}\nPlain body.\n`,
  "skills/beta/skill.yaml": "id: beta\nversion: 0.1.0\ninvocation: M\n",
  "protocols/tdd/PROTOCOL.md": "# TDD\n\nSee [implementer](../../roles/implementer/ROLE.md).\n",
  "roles/implementer/ROLE.md": "# Implementer\n",
  "profiles/core.yaml": "id: core\nskills: [alpha, beta]\n",
  "profiles/autonomy.yaml": "id: autonomy\nskills: [beta]\n",
  // A source tree that cannot produce a licensed distribution is not a valid
  // fixture for any packaging test, so these are in the base rather than in the
  // one describe that reads them.
  // A case for each fixture skill, because the corpus is scoped to the skills
  // the bundle installs and a fixture carrying one skill's cases cannot show
  // that scoping happening.
  "evals/alpha/does-not-start-unasked/case.yaml": 'schema_version: "1.1"\nname: does-not-start-unasked\ntags: [negative]\n',
  "evals/beta/runs-when-asked/case.yaml": 'schema_version: "1.1"\nname: runs-when-asked\ntags: [positive]\n',
  NOTICE: "agent-kit\nCopyright (c) 2026 A Person\n\nAdapted from MIT-licensed projects.\n",
  LICENSE: "MIT License\n\nCopyright (c) 2026 A Person\n\nPermission is hereby granted, free of charge...\n",
};

function ctxFor(overrides: Record<string, string> = {}, drop: string[] = []) {
  const files = { ...BASE, ...overrides };
  for (const key of drop) delete files[key];
  const root = makeTree(files);
  const { catalog } = loadCatalog(root);
  if (catalog === null) throw new Error("fixture has no catalog");
  return { root, catalog };
}

/** What this build decided, in the file beside that host's own manifest. */
function recordOf(plan: ReturnType<typeof planBundle>) {
  // Derived from the plan rather than fixed, because the record moved with the
  // manifest when the two hosts stopped sharing one. Fixed, it would have gone
  // on reading `{}` for every codex plan and every assertion on it would have
  // been an assertion about an empty object.
  const dir = plan.host === "codex" ? ".codex-plugin" : ".claude-plugin";
  return JSON.parse(plan.files.get(`${dir}/ak.json`)?.contents ?? "{}");
}

describe("host capability honesty", () => {
  test("both hosts are declared and the restriction vocabulary is closed", () => {
    expect([...HOST_IDS]).toEqual(["claude-code", "codex"]);
    expect([...RESTRICTIONS]).toContain("no-model-invocation");
    expect([...RESTRICTIONS]).toContain("tool-allowlist-enforced");
  });

  test("claude-code does not claim to enforce a tool allowlist: it is pre-approval, not a sandbox", () => {
    const caps = loadHostCapabilities(ctxFor().root, "claude-code");
    // Not claimed either: the host honors disable-model-invocation, and this
    // package no longer emits it (docs/decisions/0003-model-invocation.md).
    expect(caps.enforces.has("no-model-invocation")).toBe(false);
    expect(caps.enforces.has("tool-allowlist-enforced")).toBe(false);
    expect(caps.notes.join(" ")).toContain("pre-approval");
  });

  test("an adapter CONTRACT.md may declare what the host actually enforces", () => {
    const ctx = ctxFor({
      "adapters/codex/CONTRACT.md": "# Codex\n\n```yaml\nenforces:\n  - no-model-invocation\n  - filesystem-sandbox\n```\n",
    });
    const caps = loadHostCapabilities(ctx.root, "codex");
    expect([...caps.enforces].sort()).toEqual(["filesystem-sandbox", "no-model-invocation"]);
  });

  test("an unknown restriction in an adapter declaration is reported, not silently accepted", () => {
    const ctx = ctxFor({ "adapters/codex/CONTRACT.md": "```yaml\nenforces: [teleportation]\n```\n" });
    const caps = loadHostCapabilities(ctx.root, "codex");
    expect(caps.issues.some((i) => i.rule === "packaging.unknown-restriction")).toBe(true);
    expect(caps.enforces.has("teleportation")).toBe(false);
  });
});

/**
 * Six donors are MIT. MIT requires the copyright notice and the permission
 * notice accompany the distribution, and `dist/` is the distribution -- so
 * these are a licensing obligation, not bundle tidiness, and a bundle without
 * them is defective however clean the rest of the build reports.
 *
 * Both host contracts specify them at the bundle root (`NOTICE, LICENSE` in
 * `adapters/claude-code/CONTRACT.md` §1 and `adapters/codex/CONTRACT.md` §2),
 * so the filenames and the placement are taken from the contract rather than
 * chosen here.
 */
describe("the licence files the distribution is obliged to carry", () => {
  test("every host's bundle carries them, byte-identical to the source tree's", () => {
    // Iterated over HOST_IDS rather than written twice. The defect this package
    // has already produced once is two host manifests disagreeing about the
    // same fact, and a test that names one host cannot see it.
    const ctx = ctxFor();
    for (const host of HOST_IDS) {
      const plan = planBundle(ctx, host, {});
      for (const name of ["NOTICE", "LICENSE"]) {
        expect(`${host}:${name}=${plan.files.get(name)?.contents}`).toBe(`${host}:${name}=${BASE[name]}`);
      }
    }
  });

  test("a tree with no LICENSE fails the build rather than shipping a distribution without one", () => {
    const plan = planBundle(ctxFor({}, ["LICENSE"]), "claude-code", {});
    const issue = plan.issues.find((i) => i.rule === "packaging.licence-file-missing" && i.file === "LICENSE");
    expect(issue?.severity).toBe("error");
  });

  test("a tree with no NOTICE fails for the same reason: the donors' notices travel with the copy", () => {
    const plan = planBundle(ctxFor({}, ["NOTICE"]), "claude-code", {});
    const issue = plan.issues.find((i) => i.rule === "packaging.licence-file-missing" && i.file === "NOTICE");
    expect(issue?.severity).toBe("error");
  });

  test("a licence file that cannot be read is absent from the bundle, never emitted empty", () => {
    // A zero-byte LICENSE would satisfy every check that asks whether the path
    // is there and satisfy the obligation not at all, which is worse than the
    // absence it replaces: absence is legible, an empty file is a forgery of
    // compliance. It matters here specifically because `writeBundles` writes
    // dist/ before its plan errors are reported -- so whatever the plan holds
    // reaches disk, and only the exit code says the build failed.
    const plan = planBundle(ctxFor({}, ["LICENSE"]), "claude-code", {});
    expect(plan.files.has("LICENSE")).toBe(false);
    expect(plan.files.has("NOTICE")).toBe(true);
  });

  test("the failure names the file that is missing, not the pair", () => {
    // Reported per file. One message covering both would leave a reader who
    // has a NOTICE and no LICENSE unable to tell which of the two to write,
    // and the fix for each is a different file.
    const plan = planBundle(ctxFor({}, ["LICENSE"]), "claude-code", {});
    const missing = plan.issues.filter((i) => i.rule === "packaging.licence-file-missing");
    expect(missing.map((i) => i.file)).toEqual(["LICENSE"]);
  });
});

describe("bundle planning", () => {
  test("no skill gets disable-model-invocation, U or M, on either host", () => {
    // docs/decisions/0003-model-invocation.md: every skill is loadable by the
    // model, and a U skill's gate is its own authority step.
    for (const host of ["claude-code", "codex"] as const) {
      const plan = planBundle(ctxFor(), host, {});
      expect(plan.files.get("skills/alpha/SKILL.md")?.contents).not.toContain("disable-model-invocation");
      expect(plan.files.get("skills/beta/SKILL.md")?.contents).not.toContain("disable-model-invocation");
    }
  });

  test("argument-hint and allowed-tools are generated from skill.yaml, never copied from the body", () => {
    const plan = planBundle(ctxFor(), "claude-code", {});
    const alpha = plan.files.get("skills/alpha/SKILL.md")?.contents ?? "";
    expect(alpha).toContain("argument-hint: <ticket>");
    expect(alpha).toContain("allowed-tools:");
    expect(alpha).toContain("- Read");
    expect(plan.files.get("skills/beta/SKILL.md")?.contents).not.toContain("argument-hint");
  });

  test("the canonical name and description survive into the bundle", () => {
    const plan = planBundle(ctxFor(), "claude-code", {});
    const alpha = plan.files.get("skills/alpha/SKILL.md")?.contents ?? "";
    expect(alpha).toContain("name: alpha");
    expect(alpha).toContain("description: Use when asked.");
  });

  test("plugin.json enumerates skills explicitly in catalog order rather than globbing", () => {
    const plan = planBundle(ctxFor(), "claude-code", {});
    const manifest = JSON.parse(plan.files.get(".claude-plugin/plugin.json")?.contents ?? "{}");
    expect(manifest.skills).toEqual(["./skills/alpha", "./skills/beta"]);
    expect(JSON.stringify(manifest)).not.toContain("*");
  });

  /**
   * `plugin.json` belongs to the host, and the host checks it. `claude plugin
   * validate dist/claude-code --strict` reports `Unknown field 'ak'. Claude Code
   * ignores it at load time.` and fails, so the build's own provenance -- which
   * profile was applied, what was excluded and why -- was making the bundle
   * unshippable by the tool that decides whether it ships.
   *
   * It moves to `.claude-plugin/ak.json` beside it. The validator reads the
   * manifest, not the directory, and passes with the sibling present. The
   * assertion is on the exact key set rather than on the absence of `ak`,
   * because the next field added out of place fails this the same way.
   */
  test("plugin.json carries host keys only; the build's own record sits beside it", () => {
    const plan = planBundle(ctxFor(), "claude-code", {});
    const manifest = JSON.parse(plan.files.get(".claude-plugin/plugin.json")?.contents ?? "{}");
    expect(Object.keys(manifest)).toEqual(["name", "version", "description", "author", "license", "skills", "experimental"]);

    const record = JSON.parse(plan.files.get(".claude-plugin/ak.json")?.contents ?? "{}");
    expect(Object.keys(record).sort()).toEqual(["autonomy_rejected", "excluded", "host", "install", "modes", "profile"]);
  });

  test("transitive shared dependencies are copied under references/shared/", () => {
    const plan = planBundle(ctxFor(), "claude-code", {});
    expect([...plan.files.keys()]).toContain("references/shared/protocols/tdd/PROTOCOL.md");
    expect([...plan.files.keys()]).toContain("references/shared/roles/implementer/ROLE.md");
  });

  test("links into shared space are rewritten so closure holds in the bundle", () => {
    const plan = planBundle(ctxFor(), "claude-code", {});
    const alpha = plan.files.get("skills/alpha/SKILL.md")?.contents ?? "";
    expect(alpha).toContain("../../references/shared/protocols/tdd/PROTOCOL.md");
    expect(alpha).not.toContain("](../../protocols/tdd/PROTOCOL.md)");
  });

  test("a link between two shared files needs no rewrite because the layout is preserved", () => {
    const plan = planBundle(ctxFor(), "claude-code", {});
    const proto = plan.files.get("references/shared/protocols/tdd/PROTOCOL.md")?.contents ?? "";
    expect(proto).toContain("../../roles/implementer/ROLE.md");
  });

  test("--profile installs only that profile's member list", () => {
    const plan = planBundle(ctxFor(), "claude-code", { profile: "autonomy" });
    const manifest = JSON.parse(plan.files.get(".claude-plugin/plugin.json")?.contents ?? "{}");
    expect(manifest.skills).toEqual(["./skills/beta"]);
    expect([...plan.files.keys()]).not.toContain("skills/alpha/SKILL.md");
  });

  test("--profile all installs every catalog skill, whichever profile it belongs to", () => {
    const plan = planBundle(ctxFor(), "claude-code", { profile: "all" });
    const manifest = JSON.parse(plan.files.get(".claude-plugin/plugin.json")?.contents ?? "{}");
    expect(manifest.skills).toEqual(["./skills/alpha", "./skills/beta"]);
    expect(plan.profile).toBe("all");
    expect(plan.issues.some((i) => i.rule === "packaging.unknown-profile")).toBe(false);
  });

  test("an unknown profile is an error, not an empty bundle", () => {
    const plan = planBundle(ctxFor(), "claude-code", { profile: "nonesuch" });
    expect(plan.issues.some((i) => i.rule === "packaging.unknown-profile")).toBe(true);
  });

  /**
   * `package.default_profile` is the only statement in the tree about what a
   * plain `ak build` installs: catalog.yaml calls core "the default install" and
   * profiles/core.yaml repeats it. A build that names no profile must therefore
   * apply that one.
   *
   * The fixture has to carry a skill outside the default for any of this to be
   * visible. In the real catalog every authored skill happens to be in `core`,
   * so selecting all skills and selecting core's members return the same bundle
   * and the disagreement leaves no trace in the artifact -- it waits on the next
   * skill to be authored outside core.
   */
  describe("a build that names no profile", () => {
    const gamma = {
      "catalog.yaml": CATALOG.replace(
        "protocols:",
        "  - id: gamma\n    status: authored\n    invocation: M\n    profiles: [autonomy]\nprotocols:",
      ),
      "skills/gamma/SKILL.md": `${HEAD("gamma")}\nPlain body.\n`,
      "profiles/autonomy.yaml": "id: autonomy\nskills: [beta, gamma]\n",
    };

    test("installs the catalog's default profile, not every skill in the catalog", () => {
      const plan = planBundle(ctxFor(gamma), "claude-code", {});
      const manifest = JSON.parse(plan.files.get(".claude-plugin/plugin.json")?.contents ?? "{}");
      expect(manifest.skills).toEqual(["./skills/alpha", "./skills/beta"]);
      expect([...plan.files.keys()]).not.toContain("skills/gamma/SKILL.md");
    });

    test("records the profile it applied, so the bundle does not have to be re-derived to know", () => {
      const plan = planBundle(ctxFor(gamma), "claude-code", {});
      expect(recordOf(plan).profile).toBe("core");
      expect(plan.profile).toBe("core");
    });

    test("a default naming no declared profile installs everything rather than nothing", () => {
      // Found by fixture 04-broken-link-bundle, which declares `default_profile:
      // core` and no `profiles:` section at all. Honoring that default emptied
      // the bundle, and an empty bundle has no links, so `links.broken-bundle`
      // stopped reporting the defect the fixture exists to demonstrate. One bad
      // field silenced an unrelated check. The complaint about the field belongs
      // to `catalog.exactly-one-default-profile-matching-package-default-profile`
      // and is left there.
      const plan = planBundle(
        ctxFor({ ...gamma, "catalog.yaml": gamma["catalog.yaml"].replace(/^profiles:\n(?:  .*\n)+/m, "") }),
        "claude-code",
        {},
      );
      const manifest = JSON.parse(plan.files.get(".claude-plugin/plugin.json")?.contents ?? "{}");
      expect(manifest.skills).toEqual(["./skills/alpha", "./skills/beta", "./skills/gamma"]);
      expect(recordOf(plan).profile).toBe("all");
      expect(plan.issues.some((i) => i.rule === "packaging.unknown-profile")).toBe(false);
    });

    test("a catalog declaring no default still installs everything, and says so", () => {
      // The boundary: the fallback is guarded on a default being declared, not
      // applied unconditionally. Without this, a catalog with no default would
      // resolve to the empty string and select nothing.
      const plan = planBundle(ctxFor({ ...gamma, "catalog.yaml": gamma["catalog.yaml"].replace("  default_profile: core\n", "") }), "claude-code", {});
      const manifest = JSON.parse(plan.files.get(".claude-plugin/plugin.json")?.contents ?? "{}");
      expect(manifest.skills).toEqual(["./skills/alpha", "./skills/beta", "./skills/gamma"]);
      expect(recordOf(plan).profile).toBe("all");
    });
  });

  test("a reference into a source-only tree cannot be bundled and is reported", () => {
    const ctx = ctxFor({
      "skills/alpha/SKILL.md": `${HEAD("alpha")}\nSee [notes](../../research/sources/notes.md).\n`,
      "research/sources/notes.md": "# Notes\n",
    });
    const plan = planBundle(ctx, "claude-code", {});
    const issue = plan.issues.find((i) => i.rule === "packaging.not-bundleable");
    expect(issue?.severity).toBe("error");
    expect(issue?.message).toContain("research/sources/notes.md");
  });

  test("planning is deterministic: the same tree plans byte-identical files", () => {
    const ctx = ctxFor();
    const a = planBundle(ctx, "claude-code", {});
    const b = planBundle(ctx, "claude-code", {});
    expect([...a.files.entries()].map(([k, v]) => [k, v.contents])).toEqual(
      [...b.files.entries()].map(([k, v]) => [k, v.contents]),
    );
  });

  test("a skill whose body is not authored yet is skipped without crashing", () => {
    const ctx = ctxFor({}, ["skills/beta/SKILL.md"]);
    const plan = planBundle(ctx, "claude-code", {});
    expect(plan.issues.some((i) => i.rule === "packaging.skill-body-missing")).toBe(true);
    expect([...plan.files.keys()]).not.toContain("skills/beta/SKILL.md");
  });
});

/**
 * Identity the manifests are obliged to carry, from the one place that states it.
 *
 * `adapters/claude-code/CONTRACT.md` §1 specifies both values literally:
 * `"author": { "name": "agent-kit maintainers" }` at :38 and `"license": "MIT"`
 * at :39. Neither is invented here and neither is written into the packager --
 * they come from `catalog.yaml`'s `package:` block, which AGENTS.md calls the
 * single source of truth, so the two manifests cannot drift apart or drift from
 * the catalog.
 *
 * `adapters/codex/CONTRACT.md` §5.2 is why absence is an error rather than an
 * omission. The clause has two party sets and this comment used to state only
 * the wider one: `version` and `license` agree across `package.json` and both
 * manifests, while `name` and `description` agree between the two manifests and
 * with the catalog, with `package.json` not a party to either. The donor this
 * was adapted from treats such a disagreement as release-blocking rather than a
 * lint. A manifest with no `license` key does not disagree with anything -- it
 * removes the field the check compares, which is the quieter way to pass.
 *
 * `description` is checked here for that exact reason and not by the parity
 * comparison. Absent from the catalog, both manifests ship without the key,
 * §5.2's manifest-to-manifest half is satisfied by mutual absence, and nothing
 * reports it -- agreement between two bundles that both dropped the field. Its
 * two siblings have been guarded here since `c0ef130`; it arrived as a manifest
 * field in `19081aa` without the guard, which is the defect this block now
 * holds shut.
 */
describe("the identity fields the manifests are obliged to carry", () => {
  test("both manifests carry the author and licence the contract specifies", () => {
    const ctx = ctxFor();
    for (const [host, path] of [
      ["claude-code", ".claude-plugin/plugin.json"],
      ["codex", ".codex-plugin/plugin.json"],
    ] as const) {
      const manifest = JSON.parse(planBundle(ctx, host, {}).files.get(path)?.contents ?? "{}");
      expect(`${host}:${JSON.stringify(manifest.author)}`).toBe(`${host}:{"name":"agent-kit maintainers"}`);
      expect(`${host}:${manifest.license}`).toBe(`${host}:MIT`);
    }
  });

  test("the values are read from the catalog, not written into the packager", () => {
    // The whole point of putting them in `package:` is that one edit moves both
    // manifests. Asserting the contract's own strings only would pass equally
    // well over a packager with those strings hardcoded, which is the shape
    // that cannot be kept in agreement with anything.
    const ctx = ctxFor({
      "catalog.yaml": CATALOG.replace("author: agent-kit maintainers", "author: someone else").replace("license: MIT", "license: Apache-2.0"),
    });
    const manifest = JSON.parse(planBundle(ctx, "codex", {}).files.get(".codex-plugin/plugin.json")?.contents ?? "{}");
    expect(manifest.author).toEqual({ name: "someone else" });
    expect(manifest.license).toBe("Apache-2.0");
  });

  test("a catalog with no author fails the build rather than shipping a manifest without one", () => {
    const ctx = ctxFor({ "catalog.yaml": CATALOG.replace("  author: agent-kit maintainers\n", "") });
    const plan = planBundle(ctx, "claude-code", {});
    const issue = plan.issues.find((i) => i.rule === "packaging.manifest-identity-missing" && i.message.includes("author"));
    expect(issue?.severity).toBe("error");
    // The wording, not just the rule. Absent and blank are different facts with
    // different fixes, and `loadCatalog` is what keeps them apart by setting the
    // field only when it is present. A loader that defaulted an absent field to
    // `""` would still fail the build, with a message telling the reader their
    // catalog declares a blank author when it declares none -- caught here
    // rather than by the rule id, which is identical either way.
    expect(issue?.message).toContain("declares no 'author'");
  });

  test("a catalog with no license fails the same way, and the two are reported separately", () => {
    // Separately, because the fix for each is a different line and a reader
    // with one of the two needs to know which one they are missing.
    const ctx = ctxFor({ "catalog.yaml": CATALOG.replace("  license: MIT\n", "") });
    const missing = planBundle(ctx, "claude-code", {}).issues.filter(
      (i) => i.rule === "packaging.manifest-identity-missing",
    );
    expect(missing.length).toBe(1);
    expect(missing[0]?.message).toContain("declares no 'license'");
  });

  test("a catalog with no description fails too, which mutual absence would otherwise hide", () => {
    // The field §5.2 makes the two manifests agree on, with `package.json` not a
    // party. Nothing else can catch its absence: `checkManifestParity` no longer
    // compares it, and a manifest-to-manifest comparison passes when neither
    // side has the key. Both bundles would ship describing nothing and agreeing
    // about it.
    const ctx = ctxFor({
      "catalog.yaml": CATALOG.replace("  description: What the host is told, which is a different sentence again.\n", ""),
    });
    const missing = planBundle(ctx, "claude-code", {}).issues.filter(
      (i) => i.rule === "packaging.manifest-identity-missing",
    );
    expect(missing.length).toBe(1);
    expect(missing[0]?.message).toContain("declares no 'description'");
    // The authority is the catalog's own block, not §1. A message sending a
    // reader to adapters/claude-code/CONTRACT.md §1 for this field sends them
    // to a document that does not state its value.
    expect(missing[0]?.message).toContain("adapters/codex/CONTRACT.md §5.2");
  });

  test("an absent field is left out of the manifest rather than emitted empty", () => {
    // Same reasoning as the licence files: `writeBundles` writes dist/ before
    // its plan errors are reported, so whatever the plan holds reaches disk.
    // `"license": ""` would satisfy a check that asks whether the key is there
    // and satisfy §5.2's comparison not at all -- it would disagree with
    // package.json while looking like a field someone had filled in.
    //
    // All three fields, because they are emitted by three separately guarded
    // lines and a test that drops one of them reports clean over that one
    // losing its guard. Measured, not assumed: the licence-only version of this
    // test survived a mutant that emitted `"author": { "name": "" }` for an
    // absent author. The surviving fields are asserted too, so "omit the one
    // that is missing" cannot pass as "omit all of them".
    for (const [field, line] of [
      ["license", "  license: MIT\n"],
      ["author", "  author: agent-kit maintainers\n"],
      ["description", "  description: What the host is told, which is a different sentence again.\n"],
    ] as const) {
      const ctx = ctxFor({ "catalog.yaml": CATALOG.replace(line, "") });
      const manifest = JSON.parse(planBundle(ctx, "claude-code", {}).files.get(".claude-plugin/plugin.json")?.contents ?? "{}");
      expect(`no ${field}: ${field in manifest}`).toBe(`no ${field}: false`);
      for (const other of ["license", "author", "description"].filter((f) => f !== field)) {
        expect(`${field} missing, kept ${other}: ${other in manifest}`).toBe(`${field} missing, kept ${other}: true`);
      }
    }
  });

  test("a field declared blank is a failure, not a value", () => {
    // The other direction onto the same defect. `author: ""` parses, loads, and
    // is a string, so it arrives at the packager indistinguishable from a field
    // someone filled in -- `loadCatalog` runs no schema validation, so
    // `minLength: 1` in the catalog schema does not stand between this value
    // and the manifest. A check that asks only whether the field is defined
    // accepts it and ships `"author": { "name": "" }`.
    //
    // Both halves are asserted because they are two decisions: the build has to
    // report it, and the manifest has to leave the key out. Reporting an error
    // while writing the blank anyway is what a separate predicate in the check
    // and at the emit site produces.
    //
    // `description` is here because blank is the only state in which its guard
    // is observable at all. Absent, `JSON.stringify` drops the undefined value
    // and a guarded emit and an unguarded one produce byte-identical manifests;
    // blank, the unguarded emit ships `"description": ""`. A mutant removing
    // that guard survived the absent-field test above for exactly this reason,
    // and this loop is what fails it.
    for (const [field, from, to] of [
      ["author", "author: agent-kit maintainers", 'author: ""'],
      ["license", "license: MIT", 'license: ""'],
      ["description", "description: What the host is told, which is a different sentence again.", 'description: ""'],
    ] as const) {
      const ctx = ctxFor({ "catalog.yaml": CATALOG.replace(from, to) });
      const plan = planBundle(ctx, "claude-code", {});
      const issue = plan.issues.find((i) => i.rule === "packaging.manifest-identity-missing" && i.message.includes(field));
      expect(`${field}: ${issue?.severity}`).toBe(`${field}: error`);
      expect(`${field}: ${issue?.message.includes("declares a blank")}`).toBe(`${field}: true`);
      const manifest = JSON.parse(plan.files.get(".claude-plugin/plugin.json")?.contents ?? "{}");
      expect(`${field} in manifest: ${field in manifest}`).toBe(`${field} in manifest: false`);
    }
  });
});

/**
 * §5.2's two parity rules, which have two different party sets.
 *
 * `version` and `license` agree across `package.json` and both host manifests.
 * `name` and `description` agree between the two manifests and with
 * `catalog.yaml`'s `package.id` and `package.description`, and package.json is
 * not a party to either -- it names and describes the npm package, a manifest
 * names and describes what the host addresses, and they are two names for two
 * objects.
 *
 * The donor supports the `version` clause and no other, read at the pin rather
 * than recalled. At `compound-engineering@05c42da:src/release/metadata.ts` the
 * token `compoundPackage.` occurs exactly once, `:283`, comparing
 * `package.json`'s version. Each manifest's description is derived and written
 * rather than compared (`:259`, `:291-304`), which is why the donor ships one
 * description in `package.json` and a different one in its manifest, and
 * manifest `name` is compared manifest-to-manifest (`:403`). This file
 * previously cited `src/release/components.ts`, which does version bookkeeping
 * and holds no parity logic at all.
 *
 * Measured against the object the bundle emits, not against the catalog the
 * object was built from. Re-derived from the catalog, the check and the emit
 * would be two readings of one source: they agree with each other whatever the
 * manifest says, which is an instrument returning the same answer under both
 * hypotheses.
 */
describe("the two fields package.json is a party to, and the two it is not", () => {
  /** A package.json built from the agreeing one, with fields changed or dropped. */
  const PKG = (over: Record<string, unknown> = {}, drop: ReadonlyArray<string> = []) => {
    const doc = { ...PACKAGE_JSON, ...over };
    for (const key of drop) delete doc[key];
    return { "package.json": packageJson(doc) };
  };

  const parity = (plan: ReturnType<typeof planBundle>) => plan.issues.filter((i) => i.rule === "packaging.manifest-parity");
  const blocked = (plan: ReturnType<typeof planBundle>) =>
    plan.issues.filter((i) => i.rule === "packaging.manifest-parity-unavailable");

  test("a tree whose two sides agree reports nothing, for either host", () => {
    const ctx = ctxFor();
    for (const host of HOST_IDS) {
      expect(`${host}: ${parity(planBundle(ctx, host, {})).length}`).toBe(`${host}: 0`);
      expect(`${host}: ${blocked(planBundle(ctx, host, {})).length}`).toBe(`${host}: 0`);
    }
  });

  test("version and license are each compared, and the row names the field and both values", () => {
    // Each one alone, and both of them. The donor check this was adapted from
    // compares `version` only; a check that kept that scope while carrying the
    // contract's wording passes any test that perturbs the version and reports
    // nothing about the licence.
    for (const [field, wrong] of [
      ["version", "0.0.0"],
      ["license", "Apache-2.0"],
    ] as const) {
      const rows = parity(planBundle(ctxFor(PKG({ [field]: wrong })), "claude-code", {}));
      expect(`${field}: ${rows.length}`).toBe(`${field}: 1`);
      expect(`${field}: ${rows[0]?.severity}`).toBe(`${field}: error`);
      expect(`${field}: ${rows[0]?.file}`).toBe(`${field}: package.json`);
      expect(rows[0]?.message).toContain(field);
      expect(rows[0]?.message).toContain(wrong);
      expect(rows[0]?.message).toContain(String(PACKAGE_JSON[field]));
    }
  });

  test("name and description are not compared against package.json, however far apart they are", () => {
    // The clause that was withdrawn, asserted as a property rather than left to
    // the absence of a test. `ak` addresses the plugin and the `/ak:`
    // namespace; `agent-kit` names the npm package. Forcing them equal means
    // renaming one to suit a check, which is the shape §5.2 now names outright.
    const far = PKG({ name: "something-else-entirely", description: "A sentence sharing no word with the other." });
    for (const host of HOST_IDS) {
      const plan = planBundle(ctxFor(far), host, {});
      expect(`${host}: ${parity(plan).length}`).toBe(`${host}: 0`);
      expect(`${host}: ${blocked(plan).length}`).toBe(`${host}: 0`);
    }
    // And package.json missing them entirely is not an unavailable authority
    // either, because it was never the authority for them.
    const plan = planBundle(ctxFor(PKG({}, ["name", "description"])), "claude-code", {});
    expect(parity(plan)).toEqual([]);
    expect(blocked(plan)).toEqual([]);
  });

  test("the manifest's name and description come from package.id and package.description", () => {
    // Which catalog field feeds which manifest key, pinned. `description` was
    // sourced from `package.name` and shipped the literal string `agent-kit` as
    // the bundle's description into every build; nothing downstream complained,
    // because the parity check that would have caught it was comparing against
    // the same wrong field's value in package.json.
    //
    // The catalog here states none of the strings the rest of the file repeats,
    // so a generator hardcoded to this repo's own values diverges. That is the
    // arm the previous version of this test carried and it is kept.
    const ctx = ctxFor({
      "catalog.yaml": CATALOG.replace("id: ak", "id: zzz")
        .replace("name: agent-kit", "name: Some Other Thing")
        .replace("description: What the host is told, which is a different sentence again.", "description: Nine nine nine.")
        .replace("version: 0.1.0", "version: 9.9.9")
        .replace("license: MIT", "license: Apache-2.0"),
      ...PKG({ version: "9.9.9", license: "Apache-2.0" }),
    });
    const plan = planBundle(ctx, "claude-code", {});
    expect(parity(plan)).toEqual([]);
    expect(blocked(plan)).toEqual([]);
    const manifest = JSON.parse(plan.files.get(".claude-plugin/plugin.json")?.contents ?? "{}");
    expect([manifest.name, manifest.version, manifest.description, manifest.license]).toEqual([
      "zzz",
      "9.9.9",
      "Nine nine nine.",
      "Apache-2.0",
    ]);
    // Not the catalog's `name`, which is the field it used to read.
    expect(manifest.description).not.toBe("Some Other Thing");
  });

  test("the two manifests carry the same name and description, which is the half §5.2 still asserts", () => {
    // §5.2's `name`/`description` clause is manifest-to-manifest. Both are built
    // from one object in one place, so this cannot fail without the packager
    // being changed -- which is the reason to assert it here rather than to
    // write a check that re-derives both sides from the catalog and agrees with
    // itself whatever the manifests say.
    const ctx = ctxFor();
    const read = (host: (typeof HOST_IDS)[number]) => {
      const dir = host === "codex" ? ".codex-plugin" : ".claude-plugin";
      return JSON.parse(planBundle(ctx, host, {}).files.get(`${dir}/plugin.json`)?.contents ?? "{}");
    };
    const cc = read("claude-code");
    const cx = read("codex");
    expect([cc.name, cc.description]).toEqual([cx.name, cx.description]);
    expect(cc.name).toBe("ak");
    expect(cc.description).toBe("What the host is told, which is a different sentence again.");
  });

  test("a field package.json does not state is unavailable, not agreement by default", () => {
    // The authority went missing, not the subject: the manifest carries a
    // licence and there is nothing to measure it against. `unavailable` rather
    // than a note, because `report()` exits non-zero on a blocking skip and on
    // nothing else that is not an error -- absent the flag, a package.json
    // with three of the four fields builds green over a field nobody compared.
    const plan = planBundle(ctxFor(PKG({}, ["license"])), "claude-code", {});
    const rows = blocked(plan);
    expect(rows.length).toBe(1);
    expect(rows[0]?.blocking).toBe(true);
    expect(rows[0]?.skipped).toBe("manifest parity");
    expect(rows[0]?.file).toBe("package.json");
    expect(rows[0]?.message).toContain("license");
    // `version` still compared: one absent field does not stand the whole check
    // down. And the row names only the fields package.json is a party to -- an
    // instruction to declare `name` and `description` there would make the tree
    // wrong under the clause that withdrew them.
    expect(parity(plan)).toEqual([]);
    expect(rows[0]?.message).not.toContain("description");
  });

  test("a field the catalog does not declare disagrees with a package.json that states it", () => {
    // The manifest side of the same comparison. `checkManifestIdentity` reports
    // the catalog's silence; this reports what that silence does to §5.2 -- the
    // bundle ships with no `license` key and package.json says MIT, which is a
    // disagreement and not an absence. Both rows are expected: they name
    // different files and different edits.
    const plan = planBundle(ctxFor({ "catalog.yaml": CATALOG.replace("  license: MIT\n", "") }), "claude-code", {});
    const rows = parity(plan);
    expect(rows.length).toBe(1);
    expect(rows[0]?.severity).toBe("error");
    expect(rows[0]?.message).toContain("license");
    expect(plan.issues.some((i) => i.rule === "packaging.manifest-identity-missing")).toBe(true);
  });

  test("no package.json at all blocks the build rather than passing quietly", () => {
    const plan = planBundle(ctxFor({}, ["package.json"]), "claude-code", {});
    const rows = blocked(plan);
    expect(rows.length).toBe(1);
    expect(rows[0]?.blocking).toBe(true);
    expect(rows[0]?.skipped).toBe("manifest parity");
    // One row about the file, not one per field: nothing was read, so there is
    // one thing to say.
    expect(parity(plan)).toEqual([]);
    expect(rows[0]?.message).not.toContain("description");
  });

  test("a package.json that is not a JSON object blocks the same way, rather than reading as empty", () => {
    // The quieter half. `JSON.parse` throwing and being caught into `{}` makes
    // every field missing, and four unavailable rows about a file sitting right
    // there in the tree is a report nobody can act on. A document that parses
    // to an array or a string is the same case: it is not a package manifest.
    for (const text of ["{ not json\n", "[]\n", '"agent-kit"\n']) {
      const plan = planBundle(ctxFor({ "package.json": text }), "claude-code", {});
      expect(`${JSON.stringify(text)}: ${blocked(plan).length}`).toBe(`${JSON.stringify(text)}: 1`);
      expect(blocked(plan)[0]?.blocking).toBe(true);
      expect(parity(plan)).toEqual([]);
    }
  });

  test("one disagreement is one row, not one row per bundle", () => {
    // Both manifests are built from the same catalog fields, so the same field
    // disagrees in both plans. The row names `package.json` -- one of the two
    // files a reader can actually edit, the manifests being generated -- so the
    // two are identical and `collapseDuplicates` in build.ts merges them. Named
    // for the generated manifest they would not be, and a four-field skew would
    // reach the reader as eight failures.
    const rows = checkBundles(ctxFor(PKG({ version: "0.0.0" })), {}).filter((i) => i.rule === "packaging.manifest-parity");
    expect(rows.length).toBe(1);
    expect(rows[0]?.file).toBe("package.json");
  });
});

/**
 * The marketplace entry, which only one of the two bundles carries.
 *
 * `adapters/claude-code/CONTRACT.md` §1 puts `.claude-plugin/marketplace.json`
 * in that bundle's shape; `adapters/codex/CONTRACT.md` §2 does not list it in
 * the codex bundle at all, and that host installs through
 * `codex plugin marketplace add <path>` (§4) rather than from a file of this
 * name. So its presence is a third place the bundles are contractually
 * different, and it is asserted as a difference rather than assumed.
 *
 * The shape is taken from the donor the contract cites,
 * `compound-engineering@05c42da:.claude-plugin/marketplace.json`, read at the
 * pin rather than remembered. Every field this package emits has a value the
 * tree already states. The donor's `homepage`, `tags` and
 * `metadata.description` are omitted because this tree states no value for
 * them, and a plausible-looking invented one is the failure mode this package
 * has already produced once.
 */
describe("the marketplace entry the claude-code bundle carries", () => {
  const marketplaceIn = (plan: ReturnType<typeof planBundle>) =>
    JSON.parse(plan.files.get(".claude-plugin/marketplace.json")?.contents ?? "{}");

  test("the claude-code bundle carries it and the codex bundle does not", () => {
    const ctx = ctxFor();
    expect(planBundle(ctx, "claude-code", {}).files.has(".claude-plugin/marketplace.json")).toBe(true);
    expect([...planBundle(ctx, "codex", {}).files.keys()].filter((p) => p.endsWith("marketplace.json"))).toEqual([]);
  });

  test("it lists exactly one plugin, sourced from the bundle root", () => {
    // "one entry, source ./" is the whole of what
    // `adapters/claude-code/CONTRACT.md` §1 says about it, so both halves are
    // asserted. A second entry would point the host at something this bundle
    // does not contain.
    const entries = marketplaceIn(planBundle(ctxFor(), "claude-code", {})).plugins;
    expect(entries.length).toBe(1);
    expect(entries[0].source).toBe("./");
    expect(entries[0].name).toBe("ak");
  });

  test("its identity comes from the same catalog fields the manifest uses", () => {
    // One source, so the marketplace entry cannot describe a different package
    // than the manifest beside it. Compared against the manifest rather than
    // against literals: literals would pass while the two files drifted apart,
    // which is the defect this pairing exists to prevent.
    //
    // Over a catalog that states none of the real values, because comparing two
    // files built from a fixture carrying the contract's own strings passes
    // just as well when one of them holds a hardcoded copy of those strings. A
    // mutant that set `owner` to the literal "agent-kit maintainers" survived
    // the version of this test that used the unmodified fixture: the literal
    // equalled the manifest's author, and the comparison could not see it.
    const ctx = ctxFor({
      "catalog.yaml": CATALOG.replace("author: agent-kit maintainers", "author: someone else")
        .replace("  version: 0.1.0\n", "  version: 9.9.9\n")
        .replace("  id: ak\n", "  id: not-ak\n"),
    });
    const plan = planBundle(ctx, "claude-code", {});
    const manifest = JSON.parse(plan.files.get(".claude-plugin/plugin.json")?.contents ?? "{}");
    const market = marketplaceIn(plan);
    expect(market.owner).toEqual(manifest.author);
    expect(market.plugins[0].author).toEqual(manifest.author);
    expect(market.metadata.version).toBe(manifest.version);
    expect(market.plugins[0].name).toBe(manifest.name);
  });

  test("it carries no field this tree has no value for", () => {
    // The donor carries `homepage`, `tags` and a `metadata.description`. This
    // tree states none of them, and emitting a plausible one is how a manifest
    // ends up asserting something nobody checked. Absence is the honest answer
    // until a value exists, and this test is what stops one being invented
    // later without a source.
    const market = marketplaceIn(planBundle(ctxFor(), "claude-code", {}));
    expect("homepage" in market.plugins[0]).toBe(false);
    expect("tags" in market.plugins[0]).toBe(false);
    expect("description" in market.metadata).toBe(false);
  });

  test("a catalog with no usable author fails rather than shipping an unowned marketplace", () => {
    // `owner` is an ownership claim in a distributed file. With no author
    // declared there is nothing to derive it from, and an empty owner is worse
    // than a failed build.
    //
    // Blank as well as absent, at this emit site and not only at the manifest's:
    // they are two guarded lines, and `{ "name": "" }` in a file that says who
    // owns a published plugin is the shape that looks answered and is not.
    for (const catalog of [
      CATALOG.replace("  author: agent-kit maintainers\n", ""),
      CATALOG.replace("author: agent-kit maintainers", 'author: ""'),
    ]) {
      const plan = planBundle(ctxFor({ "catalog.yaml": catalog }), "claude-code", {});
      expect(plan.issues.some((i) => i.rule === "packaging.manifest-identity-missing")).toBe(true);
      const market = marketplaceIn(plan);
      expect("owner" in market).toBe(false);
      expect("author" in market.plugins[0]).toBe(false);
    }
  });
});

/**
 * The eval corpus, and the manifest key that points at it.
 *
 * One item, because they are one claim. `experimental.evals` tells the host
 * where the cases are; the cases are what makes the claim true. Shipping the
 * key over a bundle with no corpus points the host at a directory that is not
 * there, and shipping the corpus without the key leaves
 * `claude plugin eval dist/claude-code` (`adapters/claude-code/CONTRACT.md`
 * §5, the command at :166) with nothing to find. Either half alone is a
 * bundle that looks evaluable and is not.
 *
 * claude-code only, and that is the fourth place the two bundles differ on
 * purpose. §1's tree lists `evals/<id>/<case>/case.yaml` and its manifest
 * example carries `"experimental": { "evals": "evals" }`;
 * `adapters/codex/CONTRACT.md` §2's tree lists neither, and §3's capability
 * table records **None verified** for a bundled eval runner on that host. §5
 * closes the question outright: "the behavioral corpus is executed against the
 * claude-code bundle", and results for codex alone are `not-run` rather than
 * inferred from the claude-code run.
 *
 * Scoped to the skills the bundle installs, not copied wholesale. The install
 * set is profile-dependent, and `evals/` holds cases for skills core
 * deliberately excludes -- `profiles/core.yaml`'s `deliberately_excludes`
 * names `babysit-pr` and `ultraqa`, both of which have cases in the tree. A
 * wholesale copy would put cases for uninstalled skills in front of a runner
 * invoked with `--threshold 1.0`, where a case for a skill that is not there
 * cannot pass.
 */
describe("the eval corpus the claude-code bundle carries", () => {
  const casesIn = (plan: ReturnType<typeof planBundle>) =>
    [...plan.files.keys()].filter((p) => p.startsWith("evals/")).sort();

  const experimentalIn = (plan: ReturnType<typeof planBundle>, path: string) =>
    JSON.parse(plan.files.get(path)?.contents ?? "{}").experimental;

  test("the claude-code bundle carries the corpus and the codex bundle carries none of it", () => {
    const ctx = ctxFor();
    expect(casesIn(planBundle(ctx, "claude-code", {}))).toEqual([
      "evals/alpha/does-not-start-unasked/case.yaml",
      "evals/beta/runs-when-asked/case.yaml",
    ]);
    expect(casesIn(planBundle(ctx, "codex", {}))).toEqual([]);
  });

  test("only the skills the bundle installs bring their cases", () => {
    // `autonomy` holds beta alone, so alpha's case must not travel. Asserted as
    // the whole corpus rather than as alpha's absence: "the excluded skill's
    // cases are gone" also passes over a bundle that dropped every case.
    const plan = planBundle(ctxFor(), "claude-code", { profile: "autonomy" });
    expect(casesIn(plan)).toEqual(["evals/beta/runs-when-asked/case.yaml"]);
  });

  test("the manifest points at the directory the cases are actually in", () => {
    // The key and the paths come from one constant, so this compares the
    // manifest against the bundle rather than against the string "evals". A
    // literal on both sides agrees with itself while pointing at nothing.
    const plan = planBundle(ctxFor(), "claude-code", {});
    const dir = experimentalIn(plan, ".claude-plugin/plugin.json").evals;
    expect(typeof dir).toBe("string");
    expect(casesIn(plan).every((p) => p.startsWith(`${dir}/`))).toBe(true);
  });

  test("the codex manifest claims no corpus, because that bundle has none", () => {
    const manifest = JSON.parse(
      planBundle(ctxFor(), "codex", {}).files.get(".codex-plugin/plugin.json")?.contents ?? "{}",
    );
    expect("experimental" in manifest).toBe(false);
  });

  test("a case travels verbatim", () => {
    // Cases are graded input, not prose the packager owns: a rewritten path or
    // a normalised quote changes what the eval asks. Nothing in the packager
    // rewrites YAML today, and this is what says so if something starts to.
    const plan = planBundle(ctxFor(), "claude-code", {});
    expect(plan.files.get("evals/alpha/does-not-start-unasked/case.yaml")?.contents).toBe(
      BASE["evals/alpha/does-not-start-unasked/case.yaml"],
    );
  });

  test("a bundle with no cases does not claim a corpus it does not carry", () => {
    // The manifest key is a pointer, and §1 already makes a manifest pointing
    // at something the bundle does not contain a build failure for `skills`.
    // Reported rather than silently dropped: a bundle that quietly stops being
    // evaluable is the same fails-open shape as a check that cannot fail.
    const ctx = ctxFor({}, ["evals/alpha/does-not-start-unasked/case.yaml", "evals/beta/runs-when-asked/case.yaml"]);
    const plan = planBundle(ctx, "claude-code", {});
    const issue = plan.issues.find((i) => i.rule === "packaging.eval-corpus-missing");
    expect(issue?.severity).toBe("error");
    expect(casesIn(plan)).toEqual([]);
    // Both halves withheld together. Reporting the error while still writing
    // the key would leave the pointer on disk -- `writeBundles` writes before
    // the plan's errors are read -- pointing at a directory that is not there.
    expect(experimentalIn(plan, ".claude-plugin/plugin.json")).toBeUndefined();
  });

  test("a bundle that installs nothing claims nothing, and that is not an error", () => {
    // A profile can narrow to no skills at all, and an empty bundle with no
    // corpus is consistent rather than defective: there is nothing to evaluate
    // and it says so by carrying neither half. The error is for the bundle that
    // installs skills and has no cases for any of them, which is the state that
    // silently stops being evaluable.
    const ctx = ctxFor({ "profiles/autonomy.yaml": "id: autonomy\nskills: []\n" });
    const plan = planBundle(ctx, "claude-code", { profile: "autonomy" });
    expect(plan.issues.some((i) => i.rule === "packaging.eval-corpus-missing")).toBe(false);
    expect(experimentalIn(plan, ".claude-plugin/plugin.json")).toBeUndefined();
  });
});

/**
 * The two bundles are meant to differ, and the contracts say exactly where.
 *
 * This is the comparison whose absence let a decorative second adapter report
 * clean indefinitely. `ak build` was emitting one bundle under two names: the
 * manifest path was a single constant, so `dist/codex` carried
 * `.claude-plugin/plugin.json` -- the other host's directory -- and no check
 * looked at two bundles at once to notice. Every assertion in this file named
 * `claude-code`, and a test that names one host cannot see two hosts agreeing
 * where they are supposed to disagree.
 *
 * Where they differ, taken from the contracts rather than decided here:
 *   - the manifest path, `adapters/codex/CONTRACT.md` §2 against
 *     `adapters/claude-code/CONTRACT.md` §1
 *   - the skill registration: codex takes a directory pointer
 *     (`adapters/codex/CONTRACT.md` §1, the donor table row for
 *     `.codex-plugin/plugin.json`), claude-code enumerates every path because
 *     its install set is profile-dependent and the manifest is the one place
 *     that states what the bundle actually contains
 *     (`adapters/claude-code/CONTRACT.md` §1)
 *
 * Where they must agree, same authority: the identity fields
 * (`adapters/codex/CONTRACT.md` §5.2, adapted from the donor's own release
 * check, which treats manifest drift as release-blocking rather than a lint)
 * and the installed skill set itself (§1: "Divergence between the two bundles
 * is a build failure, not a host difference").
 *
 * Both halves are here on purpose. A test that only proves they differ passes
 * just as well over two bundles that have drifted apart in every other field,
 * and a test that only proves they agree is what the single shared constant
 * already satisfied.
 */
describe("the two host bundles, compared", () => {
  /** Both plans from one source tree, so every difference is the packager's doing. */
  function bundles() {
    const ctx = ctxFor();
    return { claude: planBundle(ctx, "claude-code", {}), codex: planBundle(ctx, "codex", {}) };
  }

  const manifestIn = (plan: ReturnType<typeof planBundle>, path: string) =>
    JSON.parse(plan.files.get(path)?.contents ?? "{}");

  const skillIdsIn = (plan: ReturnType<typeof planBundle>) =>
    [...new Set([...plan.files.keys()].flatMap((p) => /^skills\/([^/]+)\//.exec(p)?.[1] ?? []))].sort();

  test("each bundle carries its own host's manifest", () => {
    const { claude, codex } = bundles();
    expect(claude.files.has(".claude-plugin/plugin.json")).toBe(true);
    expect(codex.files.has(".codex-plugin/plugin.json")).toBe(true);
  });

  test("neither bundle carries anything at all from the other host's directory", () => {
    // Asserted over every path rather than over the two manifest names, because
    // the build record sits in the same directory and had to move with it. A
    // check written against `plugin.json` alone would report clean over a codex
    // bundle still shipping `.claude-plugin/ak.json`, which is the same defect
    // one file further down.
    const { claude, codex } = bundles();
    expect([...codex.files.keys()].filter((p) => p.startsWith(".claude-plugin/"))).toEqual([]);
    expect([...claude.files.keys()].filter((p) => p.startsWith(".codex-plugin/"))).toEqual([]);
  });

  test("codex registers the skills directory; claude-code enumerates the paths", () => {
    const { claude, codex } = bundles();
    expect(manifestIn(claude, ".claude-plugin/plugin.json").skills).toEqual(["./skills/alpha", "./skills/beta"]);
    expect(manifestIn(codex, ".codex-plugin/plugin.json").skills).toBe("./skills/");
  });

  test("the two manifests agree on every identity field they both carry", () => {
    // Compared as whole objects with the one key the contracts say differs
    // removed, rather than against a list of field names written here. A field
    // added to one manifest and not the other fails this immediately; a list
    // would have to be remembered, and the thing being guarded against is
    // exactly the edit nobody remembers to mirror.
    //
    // A key that is genuinely host-specific -- `experimental.evals`, which
    // `adapters/claude-code/CONTRACT.md` §1 gives to that host alone -- must be
    // added to this exclusion when it lands, and that is the point: it makes
    // whoever adds it say out loud that it belongs to one host.
    //
    // It has landed, and this is that saying-out-loud. `experimental` is
    // excluded from claude-code's side and *not* from codex's: if codex ever
    // grows the key, it stays in `codexIdentity` and fails here, which is the
    // asymmetry the exclusion is allowed to have. That codex carries no such
    // key today is asserted positively in the eval-corpus describe, not left
    // to this subtraction.
    const { claude, codex } = bundles();
    const { skills: _enumerated, experimental: _corpus, ...claudeIdentity } = manifestIn(claude, ".claude-plugin/plugin.json");
    const { skills: _pointer, ...codexIdentity } = manifestIn(codex, ".codex-plugin/plugin.json");
    expect(Object.keys(claudeIdentity).length).toBeGreaterThan(0);
    expect(codexIdentity).toEqual(claudeIdentity);
  });

  test("the two bundles install the same skills, whatever form each manifest states it in", () => {
    // `adapters/codex/CONTRACT.md` §1: "Divergence between the two bundles is a
    // build failure, not a host difference." Compared through the bundles' own
    // skill trees rather than through the manifests, because a directory
    // pointer states no set at all -- reading the two manifests against each
    // other here would be comparing a list to a string and calling it agreement.
    //
    // The second assertion is a positive control. Two empty bundles have equal
    // skill sets, and without a figure this test would report agreement most
    // loudly at the moment both bundles had stopped containing anything.
    const { claude, codex } = bundles();
    expect(skillIdsIn(codex)).toEqual(skillIdsIn(claude));
    expect(skillIdsIn(claude)).toEqual(["alpha", "beta"]);
  });

  test("the same skill body reaches both bundles; only the generated frontmatter differs", () => {
    // Contract §5.1, bundle parity. The canonical tree is host-neutral, which is
    // the whole reason host keys are generated rather than written, so a body
    // that differs between bundles means something edited content on the way to
    // one host.
    const { claude, codex } = bundles();
    const bodyOf = (plan: ReturnType<typeof planBundle>, id: string) =>
      (plan.files.get(`skills/${id}/SKILL.md`)?.contents ?? "").replace(/^---\n[\s\S]*?\n---\n/, "");
    for (const id of ["alpha", "beta"]) {
      expect(bodyOf(claude, id)).not.toBe("");
      expect(`${id}:${bodyOf(codex, id)}`).toBe(`${id}:${bodyOf(claude, id)}`);
    }
    // And the frontmatter genuinely is generated per host, so the equality above
    // is a statement about bodies rather than about two identical files.
    const claudeAlpha = claude.files.get("skills/alpha/SKILL.md")?.contents ?? "";
    expect(claudeAlpha).toContain("allowed-tools:");
    expect(codex.files.get("skills/alpha/SKILL.md")?.contents ?? "").not.toContain("allowed-tools:");
  });

  /**
   * Contract §5, test 3, which this adapter owns and did not have: "the codex
   * bundle contains no `disable-model-invocation` and no `allowed-tools`; the
   * claude-code bundle contains both where required. A key from one host's set
   * appearing in the other's bundle is a failure."
   *
   * It was failing in the direction that leaves no trace. Both keys were
   * reaching the codex bundle, because `generateHostFrontmatter` took no host
   * argument at all -- the function that generates host frontmatter could not
   * tell the hosts apart, so it answered the same under both.
   *
   * Removing them subtracts no protection. §3 records that codex has no
   * verified equivalent for either, so neither key was ever honored there; what
   * the codex bundle loses is a claim, not an enforcement. The restraint that
   * does the work on that host is §3.1's description clause, which this package
   * does not generate yet.
   */
  test("neither host's own frontmatter keys leak into the other host's bundle", () => {
    const { claude, codex } = bundles();
    const alphaIn = (plan: ReturnType<typeof planBundle>) => plan.files.get("skills/alpha/SKILL.md")?.contents ?? "";

    // alpha is a U skill declaring allowed_tools, so claude-code is where both
    // keys are required. Asserted, not assumed: absent from codex means nothing
    // if the fixture never produced them anywhere.
    // disable-model-invocation is on neither host's list any more
    // (docs/decisions/0003-model-invocation.md), so it must reach neither bundle.
    expect(alphaIn(claude)).not.toContain("disable-model-invocation");
    expect(alphaIn(claude)).toContain("allowed-tools:");

    for (const leaked of ["disable-model-invocation", "allowed-tools"]) {
      expect(`codex carries ${leaked}: ${alphaIn(codex).includes(leaked)}`).toBe(`codex carries ${leaked}: false`);
    }

    // argument-hint is on both lists on purpose. §3's table names exactly two
    // differences and §5's leaked-key test names the same two, so removing a
    // third key would be this package inventing a host difference the contract
    // does not state.
    expect(alphaIn(codex)).toContain("argument-hint: <ticket>");
  });

  test("each bundle's build record sits beside its own host's manifest and names that host", () => {
    const { claude, codex } = bundles();
    expect(claude.files.has(".claude-plugin/ak.json")).toBe(true);
    expect(codex.files.has(".codex-plugin/ak.json")).toBe(true);
    // `host` in the record is the whole capability declaration, not a name, so
    // the id is reached through it. Asserted on both so a record written into
    // the right directory for the wrong host still fails: the path and the
    // contents are two separate claims and only one of them is a filename.
    expect(recordOf(codex).host.id).toBe("codex");
    expect(recordOf(claude).host.id).toBe("claude-code");
  });
});

/**
 * A skill the catalog declares with `status: contract` has no body yet, and
 * treating that as a packaging error made `ak build` unable to emit anything at
 * all until the last of 33 skills was written -- a gate that says nothing about
 * the bundle and blocks every intermediate release. The catalog is the
 * authority on what exists, so an unauthored skill is excluded from the bundle
 * rather than failing it.
 *
 * Exclusion is the dangerous half of that: a bundle that silently ships without
 * most of its skills and reports success is the fails-open shape this validator
 * exists to prevent. So the exclusion is recorded in `.claude-plugin/ak.json`,
 * which is inside the byte comparison `ak build --check` performs, and a run
 * that drops a skill says so in its output. Neither is a courtesy; they are what
 * make the exclusion checkable rather than invisible.
 */
describe("skills the catalog has not authored yet", () => {
  const WITH_CONTRACT = {
    "catalog.yaml": CATALOG.replace(
      "protocols:",
      `  - id: gamma
    status: contract
    invocation: M
    profiles: [core]
protocols:`,
    ),
    "profiles/core.yaml": "id: core\nskills: [alpha, beta, gamma]\n",
  };

  test("a contract skill with no body is excluded from the bundle, not an error", () => {
    const plan = planBundle(ctxFor(WITH_CONTRACT), "claude-code", {});
    expect(plan.issues.filter((i) => i.rule === "packaging.skill-body-missing")).toEqual([]);
    expect([...plan.files.keys()].filter((p) => p.startsWith("skills/gamma/"))).toEqual([]);
  });

  test("an authored skill with no body is still an error", () => {
    // The gate that had to survive. Exclusion is keyed on what the catalog
    // says, not on whether a file happens to be there, so a skill declared
    // `authored` with no body is still a packaging failure and not silently
    // dropped into the excluded list.
    const plan = planBundle(ctxFor({}, ["skills/beta/SKILL.md"]), "claude-code", {});
    const issue = plan.issues.find((i) => i.rule === "packaging.skill-body-missing");
    expect(issue?.severity).toBe("error");
    expect(issue?.file).toBe("skills/beta/SKILL.md");
  });

  test("the build record names every exclusion and its reason", () => {
    const plan = planBundle(ctxFor(WITH_CONTRACT), "claude-code", {});
    const manifest = JSON.parse(plan.files.get(".claude-plugin/plugin.json")?.contents ?? "{}");
    expect(manifest.skills).toEqual(["./skills/alpha", "./skills/beta"]);
    expect(recordOf(plan).excluded).toEqual([{ skill: "gamma", reason: "status: contract" }]);
  });

  test("a run that excludes a skill says so, not only in the file it writes", () => {
    // The manifest is the durable record and this is the one a person reads.
    // Without it the only signal that a third of the catalog is missing from
    // the bundle is a JSON file nobody opens on a green run.
    const plan = planBundle(ctxFor(WITH_CONTRACT), "claude-code", {});
    const note = plan.issues.find((i) => i.rule === "packaging.excluded-unauthored");
    expect(note?.severity).toBe("note");
    expect(note?.message).toContain("gamma");
  });

  test("the file the note sends you to is the file the exclusion is written to", () => {
    // This drifted once. The note kept naming `plugin.json` after the build
    // record moved to `ak.json`, so it sent the reader to a file that no longer
    // held what it promised -- and nothing failed, because every assertion on
    // this note was about its severity and its skill list.
    //
    // The filename is taken out of the message and used to look the file up,
    // rather than compared against a second copy of the name written here. A
    // literal would have passed through the move that broke this, since both
    // sides of it would have been edited together or neither.
    const plan = planBundle(ctxFor(WITH_CONTRACT), "claude-code", {});
    const note = plan.issues.find((i) => i.rule === "packaging.excluded-unauthored");
    const named = /recorded in (\S+?)\.\s*$/.exec(note?.message ?? "")?.[1];
    expect(named).toBeDefined();
    expect(note?.file).toBe(named);
    const written = JSON.parse(plan.files.get(named ?? "")?.contents ?? "{}");
    expect(written.excluded).toEqual([{ skill: "gamma", reason: "status: contract" }]);
  });

  test("a bundle with no skills left in it is an error, not a green empty build", () => {
    // The failure this exclusion would otherwise introduce, and it is the same
    // one it was meant to remove. With every skill still `contract`, excluding
    // them all leaves a bundle containing nothing but its own manifest, and
    // without this the packager reports `0 errors` and exit 0 over it -- a
    // claim that a releasable artifact was produced, which is worse than the
    // 33 errors it replaced, because that at least said something was wrong.
    //
    // This is what makes the exclusion an unblocking change rather than a
    // silencing one: the build goes green the moment the *first* skill is
    // authored, instead of staying red until the last.
    const noneAuthored = {
      "catalog.yaml": CATALOG.replace(/status: authored\n    invocation/g, "status: contract\n    invocation"),
      "profiles/core.yaml": "id: core\nskills: [alpha, beta]\n",
    };
    const plan = planBundle(ctxFor(noneAuthored), "claude-code", {});
    const issue = plan.issues.find((i) => i.rule === "packaging.empty-bundle");
    expect(issue?.severity).toBe("error");
    expect(issue?.message).toContain("alpha");

    // And it is gone as soon as one skill is real, which is the whole claim.
    const oneAuthored = {
      ...noneAuthored,
      "catalog.yaml": (noneAuthored["catalog.yaml"] ?? "").replace("id: alpha\n    status: contract", "id: alpha\n    status: authored"),
    };
    expect(planBundle(ctxFor(oneAuthored), "claude-code", {}).issues.some((i) => i.rule === "packaging.empty-bundle")).toBe(false);
  });

  test("an included skill linking an excluded one fails the build rather than dangling", () => {
    // Exclusion removes the skill from the bundle's namespace, so a link into
    // it has nowhere to resolve. `packaging.not-bundleable` already carried
    // this case for profile exclusions and carries it unchanged here: the
    // alternative is a bundle shipping a link to a directory it does not have.
    const plan = planBundle(
      ctxFor({ ...WITH_CONTRACT, "skills/alpha/SKILL.md": `${HEAD("alpha")}\nSee [gamma](../gamma/SKILL.md).\n` }),
      "claude-code",
      {},
    );
    const issue = plan.issues.find((i) => i.rule === "packaging.not-bundleable");
    expect(issue?.severity).toBe("error");
    expect(issue?.file).toBe("skills/alpha/SKILL.md");
  });

  test("a body present while the catalog still says contract is excluded, and the catalog is why", () => {
    // The catalog is the authority on what exists; a directory listing is not.
    // So this is excluded even though the file is right there, and the author
    // is told by `catalog.status-behind-body` rather than by a silent
    // inclusion that makes the catalog wrong about its own bundle. Asserted in
    // both directions so the exclusion cannot become a hole nobody is warned
    // about.
    const ctx = ctxFor({
      ...WITH_CONTRACT,
      "skills/gamma/SKILL.md": `${HEAD("gamma")}\nWritten already.\n`,
    });
    const plan = planBundle(ctx, "claude-code", {});
    expect([...plan.files.keys()].filter((p) => p.startsWith("skills/gamma/"))).toEqual([]);
    const warned = checkCompleteness(ctx).filter((i) => i.rule === "catalog.status-behind-body");
    expect(warned.map((i) => i.file)).toContain("skills/gamma/SKILL.md");
  });
});

/**
 * The mode each skill runs in on the host it is being packaged for.
 *
 * `packaging.hosts[]` is where a skill.yaml states it, one row per adapter, and
 * it is the only legal place: `schemas/skill.schema.json` sets
 * `additionalProperties: false`, so the `autonomy:` block the packager used to
 * read cannot appear in a skill.yaml that passes `ak validate` -- appending one
 * to a real skill reports `schemas.document-invalid`, "(root) must NOT have
 * additional properties {"additionalProperty":"autonomy"}". It never appeared
 * in one. Every skill in every bundle came out `mode: manual` regardless of
 * what it declared, and `autonomy_unenforceable` was never emitted at all.
 *
 * Four tests stood here and passed over that, because the fixture invented the
 * input: it wrote `autonomy.modes` into `skills/beta/skill.yaml`, a shape the
 * validator rejects. The assertions were real and the feature they covered
 * could not run. The fixtures below declare what a real skill declares, so a
 * decision the packager cannot make is a decision these tests cannot pass.
 *
 * The downgrade rule survives the move, with a legal input. `adapters/
 * claude-code/CONTRACT.md` §3 calls `unsupported` "the `unsupported` semantics
 * this host cannot enforce", and §4's rule is that a host which cannot enforce
 * what an autonomous run requires exposes the skill guided and rejects
 * autonomous. So a row claiming `autonomous` while naming its own host's
 * unenforceable semantics is the rule's case, stated by the skill itself.
 */
describe("the mode a skill is packaged in, per host", () => {
  /** A skill.yaml declaring `packaging.hosts[]` rows, which is the real shape. */
  const declaring = (rows: string) => ({
    "skills/beta/skill.yaml": `id: beta\nversion: 0.1.0\ninvocation: M\npackaging:\n  generated_frontmatter:\n    disable-model-invocation: false\n  hosts:\n${rows}`,
  });

  /**
   * The same, with a `requires[]` -- which is what the ceiling is computed from.
   *
   * Separate from `declaring` rather than an optional argument to it, because
   * the two ask different questions and a reader of a test should be able to
   * see from the call which one it is asking. Every skill in the real tree
   * declares `requires[]`; `declaring` alone is the skill that asks the host
   * for nothing, whose ceiling is `autonomous` by definition.
   */
  const requiring = (caps: string[], rows: string) => ({
    "skills/beta/skill.yaml": `id: beta\nversion: 0.1.0\ninvocation: M\nrequires:\n${caps
      .map((c) => `  - ${c}\n`)
      .join("")}packaging:\n  generated_frontmatter:\n    disable-model-invocation: false\n  hosts:\n${rows}`,
  });

  const CC_AUTONOMOUS = "    - adapter: claude-code\n      mode: autonomous\n";

  const decisionFor = (plan: ReturnType<typeof planBundle>, skill: string) => plan.decisions.find((d) => d.skill === skill);

  test("the mode comes from this host's row, and the two hosts may differ", () => {
    // The property the old fixture could not express at all: `autonomy.modes`
    // was one flat list for every adapter, so two hosts could not disagree
    // about a skill even in principle.
    const ctx = ctxFor(declaring("    - adapter: claude-code\n      mode: autonomous\n    - adapter: codex\n      mode: manual\n"));
    expect(decisionFor(planBundle(ctx, "claude-code", {}), "beta")?.mode).toBe("autonomous");
    expect(decisionFor(planBundle(ctx, "codex", {}), "beta")?.mode).toBe("manual");
    expect(planBundle(ctx, "claude-code", {}).files.get("skills/beta/SKILL.md")?.contents).toContain("mode: autonomous");
    expect(planBundle(ctx, "codex", {}).files.get("skills/beta/SKILL.md")?.contents).toContain("mode: manual");
  });

  test("a skill with no row for this host is manual, not autonomous by omission", () => {
    const ctx = ctxFor(declaring("    - adapter: codex\n      mode: autonomous\n"));
    expect(decisionFor(planBundle(ctx, "claude-code", {}), "beta")?.mode).toBe("manual");
    expect(decisionFor(planBundle(ctx, "codex", {}), "beta")?.mode).toBe("autonomous");
  });

  test("a skill with no packaging block at all is manual", () => {
    expect(decisionFor(planBundle(ctxFor(), "claude-code", {}), "alpha")?.mode).toBe("manual");
  });

  test("a row claiming autonomous while requiring a capability the host does not provide is exposed guided", () => {
    const ctx = ctxFor(
      requiring(
        ["repository-read", "kb-write"],
        `${CC_AUTONOMOUS}      unsupported:\n        - the host does not scope writes to a grant.\n        - artifact-write is storage only.\n`,
      ),
    );
    const plan = planBundle(ctx, "claude-code", {});
    const decision = decisionFor(plan, "beta");
    expect(decision?.mode).toBe("guided");
    expect(decision?.rejected).toEqual(["autonomous"]);
    expect(decision?.unenforceable).toEqual(["the host does not scope writes to a grant.", "artifact-write is storage only."]);
    expect(plan.files.get("skills/beta/SKILL.md")?.contents).toContain("mode: guided");
  });

  test("the declaration above the ceiling is an error, not only a quiet correction", () => {
    // The half that distinguishes this from the downgrade it replaces. A
    // bundle corrected in silence leaves a skill.yaml in the tree stating a
    // mode the packager will not honor, with nothing pointing at it -- and
    // `adapters/codex/CONTRACT.md` §3.1 gives the reason that matters: the
    // declaration is "the record that the weakening was noticed rather than
    // absorbed", so a row nobody is told about is the weakening absorbed.
    const ctx = ctxFor(requiring(["repository-read", "kb-write", "runner-grants"], CC_AUTONOMOUS));
    const plan = planBundle(ctx, "claude-code", {});
    const issue = plan.issues.find((i) => i.rule === "packaging.mode-above-ceiling");
    expect(issue?.severity).toBe("error");
    expect(issue?.file).toBe("skills/beta/skill.yaml");
    // Every blocking capability, not the first: a reader has to fix all of
    // them, and a message naming one sends them back for a second build to
    // discover the next.
    expect(issue?.message).toContain("kb-write");
    expect(issue?.message).toContain("runner-grants");
    // Not the satisfied one, which would make the message a list of everything
    // the skill requires and tell the reader nothing about which is at fault.
    expect(issue?.message).not.toContain("repository-read");
    expect(issue?.message).toContain("autonomous");
    expect(issue?.message).toContain("guided");
  });

  test("a declaration at the ceiling is not an error, so the check is not just 'autonomous fails'", () => {
    const ctx = ctxFor(
      requiring(["repository-read", "kb-write"], "    - adapter: claude-code\n      mode: guided\n"),
    );
    const plan = planBundle(ctx, "claude-code", {});
    expect(plan.issues.some((i) => i.rule === "packaging.mode-above-ceiling")).toBe(false);
    expect(decisionFor(plan, "beta")?.mode).toBe("guided");
    expect(decisionFor(plan, "beta")?.rejected).toEqual([]);
  });

  test("a declaration below the ceiling stays where it was declared, because the rule is a cap", () => {
    // `min(declared, ceiling)`, not `= ceiling`. A skill that asked for manual
    // and got raised to guided would have the packager overriding its author in
    // the permissive direction, which is the one direction no contract permits.
    const ctx = ctxFor(
      requiring(["repository-read", "kb-write"], "    - adapter: claude-code\n      mode: manual\n"),
    );
    const plan = planBundle(ctx, "claude-code", {});
    expect(decisionFor(plan, "beta")?.mode).toBe("manual");
    expect(plan.issues.some((i) => i.rule === "packaging.mode-above-ceiling")).toBe(false);
  });

  test("a skill requiring only capabilities the host supplies keeps autonomous", () => {
    // The control that stops "everything is capped" passing as the rule. Three
    // statuses are present and none of them is `not-provided`, so a ceiling
    // computed from anything short of `satisfied` would fail here.
    const ctx = ctxFor(requiring(["repository-read", "process-exec", "artifact-write", "isolated-worktree"], CC_AUTONOMOUS));
    const plan = planBundle(ctx, "claude-code", {});
    expect(decisionFor(plan, "beta")?.mode).toBe("autonomous");
    expect(plan.issues.some((i) => i.rule === "packaging.mode-above-ceiling")).toBe(false);
  });

  test("a required capability §3 does not mention caps the skill and is named as unstated", () => {
    // Absence read as `satisfied` would certify a skill against a table that
    // never mentioned what it needs. The message has to separate the two cases,
    // because the fix differs: a blocking capability means change the mode, an
    // unstated one means the contract is missing a row.
    const ctx = ctxFor(requiring(["repository-read", "telepathy"], CC_AUTONOMOUS));
    const plan = planBundle(ctx, "claude-code", {});
    const issue = plan.issues.find((i) => i.rule === "packaging.mode-above-ceiling");
    expect(issue?.severity).toBe("error");
    expect(issue?.message).toContain("telepathy");
    expect(issue?.message).toContain("no status");
    expect(decisionFor(plan, "beta")?.mode).toBe("guided");
  });

  test("the ceiling comes from requires[], not from the unsupported prose beside it", () => {
    // The behaviour this replaced, stated as its own test so the move cannot be
    // undone quietly. `unsupported` is prose -- `adapters/claude-code/
    // CONTRACT.md` §3 calls it "the `unsupported` semantics this host cannot
    // enforce" and nothing constrains its wording -- so a downgrade keyed on it
    // fires on whether an author wrote a sentence, not on what the host
    // withholds. Here the sentences are present and the capabilities are all
    // supplied, and the skill keeps what it declared.
    const ctx = ctxFor(
      requiring(
        ["repository-read", "artifact-write"],
        `${CC_AUTONOMOUS}      unsupported:\n        - the host does not scope writes to a grant.\n        - artifact-write is storage only.\n`,
      ),
    );
    const plan = planBundle(ctx, "claude-code", {});
    expect(decisionFor(plan, "beta")?.mode).toBe("autonomous");
    expect(decisionFor(plan, "beta")?.rejected).toEqual([]);
    // And the prose still reaches the installed skill, which is the job it does
    // keep: it is a declaration a reader sees, not an input to a decision.
    expect(plan.files.get("skills/beta/SKILL.md")?.contents).toContain("the host does not scope writes to a grant.");
  });

  test("a tree with no capability table blocks the build instead of passing every declaration", () => {
    // The fails-open this check is shaped around. With no §3 table nothing is
    // `not-provided`, every ceiling computes to `autonomous`, and a build
    // certifies every declaration it was supposed to measure -- reporting the
    // same clean result it reports for a tree that genuinely checked out.
    //
    // `unavailable` and not `error`, per `src/validation/types.ts`: the subject
    // is present -- every mode declaration is in the plan -- and what went
    // missing is the authority. It blocks, which is what makes it more than a
    // label: `hasErrors` is false here and the run still does not pass.
    const ctx = ctxFor(requiring(["repository-read", "kb-write"], CC_AUTONOMOUS), ["adapters/claude-code/CONTRACT.md"]);
    const plan = planBundle(ctx, "claude-code", {});
    const issue = plan.issues.find((i) => i.rule === "packaging.capability-table-unavailable");
    expect(issue?.blocking).toBe(true);
    expect(issue?.skipped).toBe(MODE_CEILING_CHECK);
    expect(hasErrors(plan.issues)).toBe(false);
    expect(hasBlockingSkips(plan.issues)).toBe(true);
    // No ceiling was computed, so nothing was corrected on the strength of one.
    expect(decisionFor(plan, "beta")?.mode).toBe("autonomous");
    expect(plan.issues.some((i) => i.rule === "packaging.mode-above-ceiling")).toBe(false);
  });

  test("the table is read once per plan, not once per skill", () => {
    // Otherwise a tree with no contract reports the same unavailable check once
    // for every skill in the bundle, and the summary's "1 check unavailable"
    // becomes a count of skills.
    const ctx = ctxFor({}, ["adapters/claude-code/CONTRACT.md"]);
    const plan = planBundle(ctx, "claude-code", {});
    expect(plan.issues.filter((i) => i.rule === "packaging.capability-table-unavailable").length).toBe(1);
  });

  test("the rejection is recorded in the bundle, not only in the plan", () => {
    const ctx = ctxFor(
      requiring(
        ["repository-read", "kb-write"],
        `${CC_AUTONOMOUS}      unsupported:\n        - the host does not scope writes to a grant.\n`,
      ),
    );
    const record = recordOf(planBundle(ctx, "claude-code", {}));
    expect(record.autonomy_rejected).toEqual([{ skill: "beta", unenforceable: ["the host does not scope writes to a grant."] }]);
  });

  test("the semantics the host cannot enforce travel into the skill's own frontmatter", () => {
    // Where a reader of the installed skill can see them. The field existed and
    // had never once been emitted, because its input could not exist.
    const ctx = ctxFor(
      declaring("    - adapter: claude-code\n      mode: guided\n      unsupported:\n        - idempotency is not provided by the host.\n"),
    );
    const body = planBundle(ctx, "claude-code", {}).files.get("skills/beta/SKILL.md")?.contents ?? "";
    expect(body).toContain("autonomy_unenforceable");
    expect(body).toContain("idempotency is not provided by the host.");
  });

  test("a guided row naming unsupported semantics stays guided and is not recorded as a rejection", () => {
    // Nothing was rejected: the skill asked for guided and got guided. Recording
    // a rejection here would make `autonomy_rejected` a list of every skill that
    // named an unenforceable semantic, which is most of them, and the field
    // would stop meaning that a claim was refused.
    const ctx = ctxFor(
      declaring("    - adapter: claude-code\n      mode: guided\n      unsupported:\n        - the host does not scope writes to a grant.\n"),
    );
    const decision = decisionFor(planBundle(ctx, "claude-code", {}), "beta");
    expect(decision?.mode).toBe("guided");
    expect(decision?.rejected).toEqual([]);
    expect(recordOf(planBundle(ctx, "claude-code", {})).autonomy_rejected).toEqual([]);
  });

  test("an autonomous row on a skill requiring nothing at all keeps autonomous", () => {
    // The other side of the cap, so "always guided" cannot pass as the rule. A
    // skill declaring no `requires[]` asks the host for nothing, so there is
    // nothing the host can withhold from it and the ceiling is `autonomous`.
    //
    // The host's own `enforces` set is still deliberately not consulted here:
    // the restriction vocabulary it holds and the capability vocabulary
    // `requires[]` speaks are different enums. The comparison that does run is
    // against §3's table, which is a third vocabulary again and the one
    // `requires[]` is actually drawn from.
    const ctx = ctxFor(declaring("    - adapter: claude-code\n      mode: autonomous\n"));
    const decision = decisionFor(planBundle(ctx, "claude-code", {}), "beta");
    expect(decision?.mode).toBe("autonomous");
    expect(decision?.rejected).toEqual([]);
  });

  test("two rows for one adapter is an error, and the first of them is the one that decided", () => {
    // The schema puts no uniqueness constraint on `hosts[]`, so `ak validate`
    // passes a skill.yaml declaring the same adapter twice and whichever row the
    // packager happened to keep would decide the mode with nothing saying so.
    //
    // Which row won is asserted and not left to whichever the loop reached,
    // because the error says "whichever the packager reached first" -- a
    // sentence sending a reader to the first of two rows, and a loader that
    // kept the last would make the message point at the wrong line.
    const ctx = ctxFor(
      declaring("    - adapter: claude-code\n      mode: autonomous\n    - adapter: claude-code\n      mode: manual\n"),
    );
    const plan = planBundle(ctx, "claude-code", {});
    const issue = plan.issues.find((i) => i.rule === "packaging.duplicate-host-row");
    expect(issue?.severity).toBe("error");
    expect(issue?.file).toBe("skills/beta/skill.yaml");
    expect(issue?.message).toContain("claude-code");
    expect(decisionFor(plan, "beta")?.mode).toBe("autonomous");
  });

  test("a row naming no adapter is dropped, not filed under a host that does not exist", () => {
    // Two of them, because one is dropped either way -- a row with an empty
    // adapter that survived would be keyed under "" and nothing ever looks that
    // up, so the guard is invisible until a second one arrives and the pair is
    // reported as a duplicate. That error names adapter '' and sends a reader
    // to fix a host that was never being built.
    const ctx = ctxFor(declaring('    - adapter: ""\n      mode: autonomous\n    - adapter: ""\n      mode: manual\n'));
    const plan = planBundle(ctx, "claude-code", {});
    expect(plan.issues.some((i) => i.rule === "packaging.duplicate-host-row")).toBe(false);
    expect(decisionFor(plan, "beta")?.mode).toBe("manual");
  });

  test("the mode vocabulary is the schema's, and a value outside it is not packaged as one", () => {
    // Two halves, because the packager's fallback is `manual` and a typo that
    // fell through to it would look exactly like a skill that declared nothing.
    // The schema is what stops it, and that is asserted against the real
    // schema rather than described: a mode outside the three fails validation.
    const schemas = compileSchemas(REPO);
    const validate = schemas.validatorFor("skill");
    expect(validate).toBeDefined();
    const doc = parseYaml(readFileSync(join(REPO, "skills/diagnose/skill.yaml"), "utf8")) as Record<string, unknown>;
    expect(validate?.(doc)).toBe(true);
    const rows = (doc["packaging"] as Record<string, unknown>)["hosts"] as Array<Record<string, unknown>>;
    rows[0]!["mode"] = "sideways";
    expect(validate?.(doc)).toBe(false);

    // And the packager does not invent one from it either.
    const ctx = ctxFor(declaring("    - adapter: claude-code\n      mode: sideways\n"));
    expect(decisionFor(planBundle(ctx, "claude-code", {}), "beta")?.mode).toBe("manual");
  });
});

/**
 * `adapters/codex/CONTRACT.md` §3.1, which the mode decision has to honor now
 * that it makes one.
 *
 * §3.1 is not advice about what a skill should declare. It is a statement about
 * what the codex bundle contains: "For every U skill in the codex bundle" the
 * description carries the non-trigger clause, the authority check is the first
 * step, and "Every U skill's `packaging.hosts[]` entry for `adapter: codex`
 * records this explicitly: `mode: manual`". The host has no manual-invocation
 * flag, so a U skill exposed as anything but manual there is a skill the model
 * may start on a host that cannot be told not to.
 *
 * This became reachable and therefore necessary in the same change. While every
 * skill shipped `manual` by accident the bundle satisfied §3.1 without anyone
 * having built the rule; honoring the declarations means honoring three that
 * say `guided` on codex, so the rule has to exist for the bundle to stay
 * compliant. The skill files are wrong as well -- named in the packager's own
 * error, because a declaration that says `guided` where §3.1 requires `manual`
 * is precisely the weakening §3.1 says the declaration exists to notice.
 */
describe("a U skill on a host that cannot suppress model invocation", () => {
  /** A skill.yaml for `alpha`, which the catalog declares U. */
  const alpha = (rows: string, invocation = "invocation: U\n") =>
    ({ "skills/alpha/skill.yaml": `id: alpha\nversion: 0.1.0\n${invocation}packaging:\n  hosts:\n${rows}` });

  const decisionFor = (plan: ReturnType<typeof planBundle>, skill: string) => plan.decisions.find((d) => d.skill === skill);

  const BOTH_GUIDED = "    - adapter: claude-code\n      mode: guided\n    - adapter: codex\n      mode: guided\n";

  test("is packaged manual on codex however its own row reads, and keeps its declared mode elsewhere", () => {
    // Both halves in one test on purpose: "codex forces manual" and "this is a
    // codex rule" are the same claim, and a test that only showed the first
    // would pass just as well against a packager that forced manual everywhere.
    // No default host enforces no-model-invocation now, so "elsewhere" is a
    // host that declares it does.
    const ctx = ctxFor({ ...alpha(BOTH_GUIDED), "adapters/claude-code/capabilities.yaml": "enforces: [no-model-invocation]\n" });
    expect(decisionFor(planBundle(ctx, "codex", {}), "alpha")?.mode).toBe("manual");
    expect(decisionFor(planBundle(ctx, "claude-code", {}), "alpha")?.mode).toBe("guided");
    expect(planBundle(ctx, "codex", {}).files.get("skills/alpha/SKILL.md")?.contents).toContain("mode: manual");
    expect(planBundle(ctx, "claude-code", {}).files.get("skills/alpha/SKILL.md")?.contents).toContain("mode: guided");
  });

  test("records the refusal rather than quietly packaging something other than what was declared", () => {
    const plan = planBundle(ctxFor(alpha(BOTH_GUIDED)), "codex", {});
    expect(decisionFor(plan, "alpha")?.rejected).toEqual(["guided"]);
    expect(recordOf(plan).autonomy_rejected).toEqual([{ skill: "alpha", unenforceable: [] }]);
  });

  test("names the skill file and the rule, because the declaration is wrong and not only the bundle", () => {
    const plan = planBundle(ctxFor(alpha(BOTH_GUIDED)), "codex", {});
    const issue = plan.issues.find((i) => i.rule === "packaging.u-skill-not-manual");
    expect(issue?.severity).toBe("error");
    expect(issue?.file).toBe("skills/alpha/skill.yaml");
    expect(issue?.message).toContain("guided");
    expect(issue?.message).toContain("codex");
    // And not on a host where the declaration is legal: one that enforces no-model-invocation.
    const enforcing = ctxFor({ ...alpha(BOTH_GUIDED), "adapters/claude-code/capabilities.yaml": "enforces: [no-model-invocation]\n" });
    expect(planBundle(enforcing, "claude-code", {}).issues.some((i) => i.rule === "packaging.u-skill-not-manual")).toBe(false);
  });

  test("goes to manual, not to the guided that §4's downgrade alone would give it", () => {
    // A U skill claiming autonomous on codex is both rules' case at once: §4
    // would expose it guided, §3.1 requires manual. The stricter one is the
    // answer, and this is the test that tells the two apart -- with only §4
    // built, the mode here reads `guided` and looks like a rule having worked.
    const ctx = ctxFor(
      alpha("    - adapter: codex\n      mode: autonomous\n      unsupported:\n        - model invocation cannot be suppressed on this host.\n"),
    );
    const decision = decisionFor(planBundle(ctx, "codex", {}), "alpha");
    expect(decision?.mode).toBe("manual");
    expect(decision?.rejected).toEqual(["autonomous"]);
    expect(decision?.unenforceable).toEqual(["model invocation cannot be suppressed on this host."]);
  });

  test("leaves an M skill's codex row alone, because the rule is about who may start the skill", () => {
    // The control. §3.1's subject is the U skill, whose whole protection on this
    // host is that a human asked for it; an M skill is startable by the model by
    // design and forcing it to manual would be a different package.
    const ctx = ctxFor({ "skills/beta/skill.yaml": `id: beta\nversion: 0.1.0\ninvocation: M\npackaging:\n  hosts:\n${BOTH_GUIDED}` });
    expect(decisionFor(planBundle(ctx, "codex", {}), "beta")?.mode).toBe("guided");
    expect(planBundle(ctx, "codex", {}).issues.some((i) => i.rule === "packaging.u-skill-not-manual")).toBe(false);
  });

  test("reads U from the catalog as well, so it cannot disagree with the frontmatter about what the skill is", () => {
    // Twenty skills in this tree state an invocation in catalog.yaml and none in
    // skill.yaml, so a rule reading only skill.yaml would exempt every one of
    // them -- while `generateHostFrontmatter`, which reads both, went on writing
    // `disable-model-invocation: true` for the same skills. One predicate, or
    // the bundle says a skill is U in its frontmatter and packages it as though
    // it were not.
    const ctx = ctxFor(alpha(BOTH_GUIDED, ""));
    expect(decisionFor(planBundle(ctx, "codex", {}), "alpha")?.mode).toBe("manual");
    expect(planBundle(ctx, "codex", {}).issues.some((i) => i.rule === "packaging.u-skill-not-manual")).toBe(true);
  });

  test("reads U from skill.yaml as well, for the catalog that is missing the field it is meant to carry", () => {
    // The other arm of the same predicate, and not a theoretical one.
    // `catalog.schema.json` requires `invocation` on every skill entry, so a
    // catalog without it is a catalog that failed `ak validate` -- and `ak
    // build` plans and writes anyway, so the packager sees that catalog. A
    // skill whose one surviving record of being U is its own skill.yaml is
    // exactly when the protection has to hold.
    const noInvocation = CATALOG.replace("    status: authored\n    invocation: U\n", "    status: authored\n");
    expect(noInvocation).not.toBe(CATALOG);
    const ctx = ctxFor({ ...alpha(BOTH_GUIDED), "catalog.yaml": noInvocation });
    expect(decisionFor(planBundle(ctx, "codex", {}), "alpha")?.mode).toBe("manual");
    expect(planBundle(ctx, "codex", {}).issues.some((i) => i.rule === "packaging.u-skill-not-manual")).toBe(true);
  });

  test("says nothing about a U skill that declares manual, which is what §3.1 asks for", () => {
    const ctx = ctxFor(alpha("    - adapter: codex\n      mode: manual\n      unsupported:\n        - model invocation cannot be suppressed on this host.\n"));
    const plan = planBundle(ctx, "codex", {});
    expect(decisionFor(plan, "alpha")?.mode).toBe("manual");
    expect(decisionFor(plan, "alpha")?.rejected).toEqual([]);
    expect(plan.issues.some((i) => i.rule === "packaging.u-skill-not-manual")).toBe(false);
  });

  test("follows the capability rather than the host's name, in both directions", () => {
    // The rule's subject is "a host with no manual-invocation flag", not "codex".
    // Keyed on the host id it would be a rule that happens to be right about the
    // two hosts that exist today and silently wrong about the third, and it
    // would keep firing at codex after codex grew the flag. Both directions,
    // because either alone is satisfied by a constant: claude-code declaring it
    // enforces nothing forces the U skill to manual there, and codex declaring
    // it enforces no-model-invocation leaves the declared mode alone.
    const off = ctxFor({ ...alpha(BOTH_GUIDED), "adapters/claude-code/capabilities.yaml": "enforces: []\n" });
    expect(decisionFor(planBundle(off, "claude-code", {}), "alpha")?.mode).toBe("manual");
    expect(planBundle(off, "claude-code", {}).issues.some((i) => i.rule === "packaging.u-skill-not-manual")).toBe(true);

    const on = ctxFor({ ...alpha(BOTH_GUIDED), "adapters/codex/capabilities.yaml": "enforces: [no-model-invocation]\n" });
    expect(decisionFor(planBundle(on, "codex", {}), "alpha")?.mode).toBe("guided");
    expect(planBundle(on, "codex", {}).issues.some((i) => i.rule === "packaging.u-skill-not-manual")).toBe(false);
  });

  test("says nothing about a U skill with no codex row, which was already manual", () => {
    // The fallback and the rule agree here, and they must not both fire: an
    // error naming a declaration that does not exist would send a reader to a
    // file to fix a line that is not in it.
    const ctx = ctxFor(alpha("    - adapter: claude-code\n      mode: guided\n"));
    const plan = planBundle(ctx, "codex", {});
    expect(decisionFor(plan, "alpha")?.mode).toBe("manual");
    expect(decisionFor(plan, "alpha")?.rejected).toEqual([]);
    expect(plan.issues.some((i) => i.rule === "packaging.u-skill-not-manual")).toBe(false);
  });
});

describe("ak build and --check", () => {
  test("writes both host bundles under dist/", () => {
    const ctx = ctxFor();
    const built = writeBundles(ctx, {});
    expect(built.issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(readFileSync(join(ctx.root, "dist/claude-code/.claude-plugin/plugin.json"), "utf8")).toContain("alpha");
    expect(readFileSync(join(ctx.root, "dist/codex/skills/alpha/SKILL.md"), "utf8")).toContain("name: alpha");
  });

  test("--check passes immediately after a build", () => {
    const ctx = ctxFor();
    writeBundles(ctx, {});
    expect(checkBundles(ctx, {}).filter((i) => i.severity === "error")).toEqual([]);
  });

  test("--check reports a stale file and writes nothing", () => {
    const ctx = ctxFor();
    writeBundles(ctx, {});
    const target = join(ctx.root, "dist/claude-code/skills/alpha/SKILL.md");
    writeFileSync(target, "tampered\n");
    const issues = checkBundles(ctx, {});
    expect(issues.some((i) => i.rule === "packaging.dist-stale")).toBe(true);
    expect(readFileSync(target, "utf8")).toBe("tampered\n");
  });

  test("--check reports a missing generated file", () => {
    const ctx = ctxFor();
    expect(checkBundles(ctx, {}).some((i) => i.rule === "packaging.dist-missing")).toBe(true);
  });

  test("a missing skill body is one problem, not one per bundle that wanted it", () => {
    // planBundle runs once per host, so every fact it reports about the source
    // tree used to be emitted once per host. A missing SKILL.md is not a fact
    // about either bundle: it cannot be fixed per target and does not differ
    // per target, so two byte-identical rows read as a bug in the reporter and
    // double the error count everyone glances at as a progress number.
    const ctx = ctxFor({}, ["skills/beta/SKILL.md"]);
    const missing = checkBundles(ctx, {}).filter((i) => i.rule === "packaging.skill-body-missing");
    expect(missing.length).toBe(1);
    expect(missing[0]?.file).toBe("skills/beta/SKILL.md");
  });

  test("a per-target problem is still reported per target", () => {
    // The other half, and the reason this is a dedup rather than a blanket
    // collapse: dist-missing names the bundle in its file column, so its rows
    // are genuinely different diagnostics about different artifacts and both
    // must survive.
    const ctx = ctxFor();
    const files = checkBundles(ctx, {})
      .filter((i) => i.rule === "packaging.dist-missing")
      .map((i) => i.file);
    expect(files.length).toBeGreaterThan(1);
    expect(new Set(files).size).toBe(files.length);
  });

  test("--check reports an extra file left behind in dist/", () => {
    const ctx = ctxFor();
    writeBundles(ctx, {});
    mkdirSync(join(ctx.root, "dist/claude-code/skills/zombie"), { recursive: true });
    writeFileSync(join(ctx.root, "dist/claude-code/skills/zombie/SKILL.md"), "x\n");
    expect(checkBundles(ctx, {}).some((i) => i.rule === "packaging.dist-extra")).toBe(true);
  });

  test("rebuilding removes a file that is no longer generated", () => {
    const ctx = ctxFor();
    writeBundles(ctx, {});
    writeFileSync(join(ctx.root, "dist/claude-code/skills/zombie.md"), "x\n");
    writeBundles(ctx, {});
    expect(checkBundles(ctx, {}).filter((i) => i.severity === "error")).toEqual([]);
  });
});

/**
 * Per-install autonomy (ruling `fail-closed-adapter-lifts-ceiling`).
 *
 * The base fixture has no adapter beyond the two hosts, so every case above is
 * the host alone whatever the install says. These add a knowledgebase and a
 * runner whose contracts carry §1 supply tables, and put `ak.install.yaml` in
 * the fixture root or leave it out -- never the developer's own file, which
 * would make the answer depend on whoever ran the suite.
 */
describe("the adapters an install attaches, and what they lift", () => {
  const CATALOG_WITH_ADAPTERS = CATALOG.replace(
    "  - id: codex\n    status: authored\n",
    "  - id: codex\n    status: authored\n  - id: knowledgebase\n    status: authored\n  - id: runner-contract\n    status: authored\n",
  );

  const supplyTable = (rows: string[]) =>
    ["# adapter", "", "## 1. Capabilities", "", "| Capability | Unconfigured | What the refusal is |", "|---|---|---|", ...rows, "", "## 2. Next", ""].join(
      "\n",
    );

  const ADAPTERS: Record<string, string> = {
    "catalog.yaml": CATALOG_WITH_ADAPTERS,
    "adapters/knowledgebase/CONTRACT.md": supplyTable(["| `kb-write` | `fails-closed` | Refuses |"]),
    // A runner whose table lists nothing: attachable is decided by the table,
    // not by being in the catalog, and this one supplies nothing.
    "adapters/runner-contract/CONTRACT.md": supplyTable([]),
  };

  const requiring = (caps: string[]) => ({
    "skills/beta/skill.yaml": `id: beta\nversion: 0.1.0\ninvocation: M\nrequires:\n${caps
      .map((c) => `  - ${c}\n`)
      .join("")}packaging:\n  generated_frontmatter:\n    disable-model-invocation: false\n  hosts:\n    - adapter: claude-code\n      mode: autonomous\n`,
  });

  const ctxWith = (caps: string[], install?: string, extra: Record<string, string> = {}) =>
    ctxFor({ ...ADAPTERS, ...requiring(caps), ...(install === undefined ? {} : { [INSTALL_FILE]: install }), ...extra });

  const modeOf = (plan: ReturnType<typeof planBundle>) => plan.decisions.find((d) => d.skill === "beta")?.mode;
  const rules = (plan: ReturnType<typeof planBundle>) => plan.issues.map((i) => i.rule);

  test("with no install file every fail-closed adapter is attached, and the declared autonomy is packaged", () => {
    const plan = planBundle(ctxWith(["repository-read", "kb-write"]), "claude-code", {});
    expect(modeOf(plan)).toBe("autonomous");
    expect(rules(plan)).not.toContain("packaging.mode-capped");
    expect(rules(plan)).not.toContain("packaging.mode-above-ceiling");
    expect(hasErrors(plan.issues)).toBe(false);
    expect(recordOf(plan).install).toEqual({ file: null, attached: ["knowledgebase"], backends: {} });
  });

  test("`attached: []` is the host alone: guided, and a note naming the capability and the adapter", () => {
    const plan = planBundle(ctxWith(["repository-read", "kb-write"], "attached: []\n"), "claude-code", {});
    expect(modeOf(plan)).toBe("guided");
    expect(plan.files.get("skills/beta/SKILL.md")?.contents).toContain("mode: guided");
    const capped = plan.issues.find((i) => i.rule === "packaging.mode-capped");
    expect(capped?.severity).toBe("note");
    expect(capped?.file).toBe("skills/beta/skill.yaml");
    expect(capped?.message).toContain("kb-write");
    expect(capped?.message).toContain("knowledgebase");
    // A note and not the error: nothing is wrong with the tree, only with what
    // this install chose to attach.
    expect(rules(plan)).not.toContain("packaging.mode-above-ceiling");
    expect(hasErrors(plan.issues)).toBe(false);
    expect(recordOf(plan).install).toEqual({ file: INSTALL_FILE, attached: [], backends: {} });
  });

  test("listing the adapter is the same as the default", () => {
    const plan = planBundle(ctxWith(["kb-write"], "attached: [knowledgebase]\n"), "claude-code", {});
    expect(modeOf(plan)).toBe("autonomous");
    expect(rules(plan)).not.toContain("packaging.mode-capped");
  });

  test("trusted-evidence is a valid capability whose runner supply lifts the build ceiling", () => {
    const runner = supplyTable(["| `trusted-evidence` | `fails-closed` | Refuses autonomous evidence consumption |"]);
    const withRunner = planBundle(
      ctxWith(["trusted-evidence"], undefined, { "adapters/runner-contract/CONTRACT.md": runner }),
      "claude-code",
      {},
    );
    expect(modeOf(withRunner)).toBe("autonomous");
    expect(rules(withRunner)).not.toContain("packaging.mode-above-ceiling");

    const hostAlone = planBundle(
      ctxWith(["trusted-evidence"], "attached: []\n", { "adapters/runner-contract/CONTRACT.md": runner }),
      "claude-code",
      {},
    );
    expect(modeOf(hostAlone)).toBe("guided");
    expect(rules(hostAlone)).toContain("packaging.mode-capped");
  });

  test("an unknown adapter id is an error, and so is a host or an adapter that supplies nothing", () => {
    const ctx = ctxWith(["kb-write"], "attached: [knowledgebase, nope, codex, runner-contract]\n");
    const unknown = loadInstallConfig(ctx.root, ctx.catalog).issues.filter((i) => i.rule === "packaging.install-unknown-adapter");
    expect(unknown.map((i) => i.severity)).toEqual(["error", "error", "error"]);
    expect(unknown.some((i) => i.message.includes("'nope'"))).toBe(true);
    expect(unknown.some((i) => i.message.includes("'codex' is a host"))).toBe(true);
    expect(unknown.some((i) => i.message.includes("'runner-contract'"))).toBe(true);
    // Reported by `ak validate` as well as by the build, since it is a fact
    // about the tree's configuration and not about any one bundle.
    expect(checkInstallConfig(ctx).filter((i) => i.rule === "packaging.install-unknown-adapter")).toHaveLength(3);
    expect(hasErrors(planBundle(ctx, "claude-code", {}).issues)).toBe(true);
  });

  test("a capability no adapter supplies is still the error, whatever is attached", () => {
    const plan = planBundle(ctxWith(["kb-write", "runner-grants"]), "claude-code", {});
    const issue = plan.issues.find((i) => i.rule === "packaging.mode-above-ceiling");
    expect(issue?.severity).toBe("error");
    expect(issue?.message).toContain("runner-grants");
    expect(modeOf(plan)).toBe("guided");
  });

  test("a capability §3 does not list is still the error, even when an attached adapter claims it", () => {
    const plan = planBundle(
      ctxWith(["telepathy"], undefined, {
        "adapters/knowledgebase/CONTRACT.md": supplyTable(["| `telepathy` | `fails-closed` | Refuses |"]),
      }),
      "claude-code",
      {},
    );
    expect(plan.issues.find((i) => i.rule === "packaging.mode-above-ceiling")?.message).toContain("telepathy");
  });

  test("a supply row stating anything but fails-closed is an error and lifts nothing", () => {
    // The degradations the ruling excludes: an adapter that falls back rather
    // than refusing would let an autonomous run proceed without the capability.
    const ctx = ctxWith(["kb-write"], undefined, {
      "adapters/knowledgebase/CONTRACT.md": supplyTable(["| `kb-write` | `falls-back` | Writes a scratch directory |"]),
    });
    const plan = planBundle(ctx, "claude-code", {});
    expect(plan.issues.find((i) => i.rule === "packaging.unknown-supply-status")?.severity).toBe("error");
    expect(modeOf(plan)).toBe("guided");
    expect(loadInstallConfig(ctx.root, ctx.catalog).attachable).toEqual([]);
  });

  test("an unreadable install file attaches nothing rather than everything", () => {
    const ctx = ctxWith(["kb-write"], "attached: knowledgebase\n");
    const config = loadInstallConfig(ctx.root, ctx.catalog);
    expect(config.attached).toEqual([]);
    expect(config.issues.map((i) => i.rule)).toContain("packaging.install-unreadable");
    // The schema reports the shape to `ak validate`; one defect, one row.
    expect(checkInstallConfig(ctx).map((i) => i.rule)).not.toContain("packaging.install-unreadable");
  });

  test("the description names the file, or says the default applied", () => {
    const absent = ctxWith([]);
    expect(describeInstall(loadInstallConfig(absent.root, absent.catalog))).toBe(
      "no ak.install.yaml: default, all fail-closed adapters attached (knowledgebase)",
    );
    const empty = ctxWith([], "attached: []\n");
    expect(describeInstall(loadInstallConfig(empty.root, empty.catalog))).toBe("ak.install.yaml: attached none");
  });

  test("the real contracts supply kb-write, runner capabilities, firstmate-supervision and tracker-access, and only the tracker borrows", () => {
    // The only case reading this repository, and it reads the contracts, never
    // an install file: loadAdapterSupplies does not open one.
    const { catalog } = loadCatalog(REPO);
    if (catalog === null) throw new Error("repository has no catalog");
    const { adapters, issues } = loadAdapterSupplies(REPO, catalog);
    expect(issues).toEqual([]);
    const byAdapter = Object.fromEntries(adapters.map((a) => [a.adapter, [...a.capabilities].sort()]));
    // kb-read is absent on purpose: unconfigured, it answers unavailable and the
    // run continues, which is reported but not refused.
    expect(byAdapter).toEqual({
      firstmate: ["firstmate-supervision"],
      knowledgebase: ["kb-write"],
      "runner-contract": ["runner-grants", "trusted-evidence"],
      tracker: ["tracker-access"],
    });
    // adapters/tracker/CONTRACT.md §1: with no backend its refusal is kb-write's.
    const borrowed = Object.fromEntries(adapters.map((a) => [a.adapter, Object.fromEntries(a.fallsBackOn)]));
    expect(borrowed).toEqual({ firstmate: {}, knowledgebase: {}, "runner-contract": {}, tracker: { "tracker-access": "kb-write" } });
  });
});

/**
 * The tracker's fallback chain, as the packager reads it (ruling
 * `tracker-of-record-falls-back-to-kb`; `adapters/tracker/CONTRACT.md` §1).
 *
 * Fixture roots only, like the block above: every case writes its own
 * contracts and its own install file, so the developer's `ak.install.yaml` and
 * the real contracts' wording decide nothing here.
 */
describe("tracker-access follows the system-of-record chain", () => {
  const CATALOG_WITH_TRACKER = CATALOG.replace(
    "  - id: codex\n    status: authored\n",
    "  - id: codex\n    status: authored\n  - id: knowledgebase\n    status: authored\n  - id: tracker\n    status: authored\n",
  );

  const table = (header: string, rows: string[]) =>
    ["# adapter", "", "## 1. Capabilities", "", header, "|---|---|---|---|", ...rows, "", "## 2. Next", ""].join("\n");
  const WITH_FALLBACK = "| Capability | Unconfigured | Falls back on | What the refusal is |";

  const TREE_FILES: Record<string, string> = {
    "catalog.yaml": CATALOG_WITH_TRACKER,
    // The base fixture's §3 has no tracker-access row, and a capability §3
    // does not list is never lifted; the row is added here, as the real §3 has it.
    "adapters/claude-code/CONTRACT.md": (BASE["adapters/claude-code/CONTRACT.md"] ?? "").replace(
      "| `runner-grants` |",
      "| `tracker-access` | `not-provided` | See the tracker adapter |\n| `runner-grants` |",
    ),
    "adapters/knowledgebase/CONTRACT.md": table("| Capability | Unconfigured | What the refusal is |", ["| `kb-write` | `fails-closed` | Refuses |"]),
    "adapters/tracker/CONTRACT.md": table(WITH_FALLBACK, ["| `tracker-access` | `fails-closed` | `kb-write` | The knowledgebase's records, else a refusal |"]),
  };

  const requiring = (caps: string[]) => ({
    "skills/beta/skill.yaml": `id: beta\nversion: 0.1.0\ninvocation: M\nrequires:\n${caps
      .map((c) => `  - ${c}\n`)
      .join("")}packaging:\n  generated_frontmatter:\n    disable-model-invocation: false\n  hosts:\n    - adapter: claude-code\n      mode: autonomous\n`,
  });
  const ctxWith = (install?: string, extra: Record<string, string> = {}) =>
    ctxFor({ ...TREE_FILES, ...requiring(["repository-read", "tracker-access"]), ...(install === undefined ? {} : { [INSTALL_FILE]: install }), ...extra });
  const modeOf = (plan: ReturnType<typeof planBundle>) => plan.decisions.find((d) => d.skill === "beta")?.mode;
  const capped = (plan: ReturnType<typeof planBundle>) => plan.issues.find((i) => i.rule === "packaging.mode-capped");

  test("a configured backend lifts it with the knowledgebase attached", () => {
    const plan = planBundle(ctxWith("attached: [knowledgebase, tracker]\ntracker:\n  backend: some-tracker\n"), "claude-code", {});
    expect(modeOf(plan)).toBe("autonomous");
    expect(capped(plan)).toBeUndefined();
    expect(recordOf(plan).install).toEqual({ file: INSTALL_FILE, attached: ["knowledgebase", "tracker"], backends: { tracker: "some-tracker" } });
  });

  test("a configured backend lifts it with the knowledgebase detached, because nothing is borrowed", () => {
    const plan = planBundle(ctxWith("attached: [tracker]\ntracker:\n  backend: some-tracker\n"), "claude-code", {});
    expect(modeOf(plan)).toBe("autonomous");
    expect(capped(plan)).toBeUndefined();
    expect(hasErrors(plan.issues)).toBe(false);
  });

  test("no backend with the knowledgebase attached is lifted through the fallback", () => {
    // Also the default: no install file attaches both and configures no backend.
    for (const install of [undefined, "attached: [knowledgebase, tracker]\n"]) {
      const plan = planBundle(ctxWith(install), "claude-code", {});
      expect(modeOf(plan)).toBe("autonomous");
      expect(capped(plan)).toBeUndefined();
    }
  });

  test("no backend with the knowledgebase detached is capped, with a note naming both fixes", () => {
    const plan = planBundle(ctxWith("attached: [tracker]\n"), "claude-code", {});
    expect(modeOf(plan)).toBe("guided");
    const note = capped(plan);
    expect(note?.severity).toBe("note");
    expect(note?.message).toContain("'tracker-access'");
    expect(note?.message).toContain("'kb-write'");
    expect(note?.message).toContain("tracker: key");
    expect(note?.message).toContain("attach 'knowledgebase'");
    expect(note?.message).toContain("tracker-of-record-falls-back-to-kb");
    // A note, not the error: the tree is fine, the install chose this.
    expect(hasErrors(plan.issues)).toBe(false);
  });

  test("the tracker detached is the ordinary detached case, whatever the knowledgebase does", () => {
    const plan = planBundle(ctxWith("attached: [knowledgebase]\n"), "claude-code", {});
    expect(modeOf(plan)).toBe("guided");
    expect(capped(plan)?.message).toContain("supplied by 'tracker'");
    expect(capped(plan)?.message).toContain("fail-closed-adapter-lifts-ceiling");
  });

  test("a backend for an adapter the file does not attach is an error, and lifts nothing", () => {
    const ctx = ctxWith("attached: [knowledgebase]\ntracker:\n  backend: some-tracker\n");
    const config = loadInstallConfig(ctx.root, ctx.catalog);
    expect(config.backends.size).toBe(0);
    expect(config.issues.find((i) => i.rule === "packaging.install-backend-unattached")?.severity).toBe("error");
    expect(checkInstallConfig(ctx).map((i) => i.rule)).toContain("packaging.install-backend-unattached");
  });

  test("an unreadable Falls back on cell is an error, and the row is not counted", () => {
    const ctx = ctxWith(undefined, {
      "adapters/tracker/CONTRACT.md": table(WITH_FALLBACK, ["| `tracker-access` | `fails-closed` | the knowledgebase | Prose |"]),
    });
    const { adapters, issues } = loadAdapterSupplies(ctx.root, ctx.catalog);
    expect(issues.map((i) => i.rule)).toEqual(["packaging.malformed-fallback"]);
    expect(adapters.map((a) => a.adapter)).toEqual(["knowledgebase"]);
  });

  test("a 'none' cell borrows nothing", () => {
    const ctx = ctxWith("attached: [tracker]\n", {
      "adapters/tracker/CONTRACT.md": table(WITH_FALLBACK, ["| `tracker-access` | `fails-closed` | none | Refuses |"]),
    });
    expect(modeOf(planBundle(ctx, "claude-code", {}))).toBe("autonomous");
  });

  test("the summary names the tracker's state in each configuration", () => {
    const describe_ = (install?: string) => {
      const ctx = ctxWith(install);
      return describeInstall(loadInstallConfig(ctx.root, ctx.catalog));
    };
    expect(describe_()).toBe(
      "no ak.install.yaml: default, all fail-closed adapters attached (knowledgebase, tracker); tracker: no backend, kb-write fallback (knowledgebase)",
    );
    expect(describe_("attached: [tracker]\n")).toBe(
      "ak.install.yaml: attached tracker; tracker: no backend, kb-write fallback, which no attached adapter supplies",
    );
    expect(describe_("attached: [tracker]\ntracker:\n  backend: some-tracker\n")).toBe("ak.install.yaml: attached tracker; tracker: backend some-tracker");
    expect(describe_("attached: [knowledgebase]\n")).toBe("ak.install.yaml: attached knowledgebase");
  });
});
