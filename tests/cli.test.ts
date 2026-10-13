import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { loadCatalog } from "../src/catalog/load.ts";
import { runCli } from "../src/cli.ts";
import { checkBundles } from "../src/packaging/build.ts";
import { ADAPTATIONS_FILE, ADAPTATIONS_FRAGMENT_DIR } from "../src/validation/provenance.ts";
import { makeTree, wellFormedSkill, DENY_MARKER, sampleModelTerm } from "./helpers/tree.ts";

const CATALOG = `schema_version: 1
package:
  id: ak
  name: agent-kit
  version: 0.1.0
  namespace: "/ak:"
  default_profile: core
  # Here for the same reason NOTICE and LICENSE are in every tree this file
  # builds: a catalog that declares no author, no licence and no description
  # cannot produce a compliant host manifest, so it is not a valid fixture for a
  # passing build. The description is the field adapters/codex/CONTRACT.md §5.2
  # makes the two manifests agree on, and two manifests that both dropped it
  # agree -- so the build refuses it here rather than certifying the agreement.
  author: agent-kit maintainers
  license: MIT
  description: What the host is told this package is.
skills:
  - id: triage
    invocation: U
    status: authored
    profiles: [core]
packs:
  - id: pack-secure
    status: contract
  - id: pack-perf
    status: contract
# Declared because BUILDABLE carries adapters/claude-code/CONTRACT.md, and
# catalog.yaml is this repository's authority for what exists: a directory with
# no entry is catalog.file-without-entry, which is the check working.
adapters:
  - id: claude-code
    status: authored
profiles:
  - id: core
    status: contract
    default: true
`;

const SKILL = wellFormedSkill(
  "triage",
  "Sort incoming work into the smallest next action.",
  "Read the queue and pick one item.",
);

/**
 * The catalog and the files it declares must exist, which travel together.
 *
 * `catalog.yaml` is this repository's authority for what exists, and it binds
 * in both directions: a directory with no entry is `catalog.file-without-entry`
 * and an entry with no directory is `catalog.entry-without-file`. So the
 * `adapters:` entry above and the contract file below are one fixture and not
 * two, and every tree in this file spreads both. Spelling them separately let
 * six trees quietly carry an entry with no file and go on passing, because each
 * of them was already reporting an error for its own reasons and one more did
 * not change the assertion.
 *
 * §3's table is here rather than in `BUILDABLE` because `ak validate` reaches
 * it too, through the packager: a tree without it is not a tree where every
 * declared mode passed, it is the declarations sitting in front of the check
 * with nothing to judge them by. Two rows are enough -- one status that caps a
 * skill and one that does not -- because the fixture skill requires nothing and
 * these tests are about the CLI, not about the ceiling. The ceiling itself is
 * measured in `tests/capability-table.test.ts` and `tests/packaging.test.ts`.
 */
const TREE = {
  "catalog.yaml": CATALOG,
  "adapters/claude-code/CONTRACT.md": [
    "# claude-code",
    "",
    "## 3. Capability support",
    "",
    "| Capability | Status | Detail |",
    "|---|---|---|",
    "| `repository-read` | `satisfied` | Read, Glob, Grep |",
    "| `kb-write` | `not-provided` | Transport only |",
    "",
    "## 4. Host-capability honesty",
    "",
  ].join("\n"),
};

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: { out: (line: string) => out.push(line), err: (line: string) => err.push(line) },
    stdout: () => out.join("\n"),
    stderr: () => err.join("\n"),
  };
}

/**
 * What every tree `ak build` is expected to succeed on must carry.
 *
 * `ak build` refuses to emit a bundle that cannot carry these, because `dist/`
 * is a distribution and MIT requires the notices travel with the copy. Written
 * once and spread into each fixture rather than repeated: three fixtures in
 * this file build for real, and a fourth added later gets it by spreading the
 * same constant rather than by rediscovering the requirement from a failure.
 *
 * The eval case is here for the same reason and under the same rule. The
 * claude-code manifest declares `experimental.evals`, so a bundle with no case
 * under `evals/<id>/` points the host at a directory it does not contain, and
 * `ak build` reports that rather than shipping the pointer. Named for the
 * obligation rather than for the licence half once it carried two: a fixture
 * that cannot produce a compliant bundle is not a fixture for a passing build,
 * whichever obligation it misses.
 */
const BUILDABLE = {
  NOTICE: "agent-kit\nCopyright (c) 2026 A Person\n",
  LICENSE: "MIT License\n\nCopyright (c) 2026 A Person\n",
  "node_modules/ajv/LICENSE": "Copyright (c) 2015-2021 Evgeny Poberezkin\n",
  "node_modules/ajv-formats/LICENSE": "Copyright (c) 2020 Evgeny Poberezkin\n",
  "node_modules/fast-deep-equal/LICENSE": "Copyright (c) 2017 Evgeny Poberezkin\n",
  "node_modules/fast-uri/LICENSE": "Copyright (c) 2011-2021 Gary Court\n",
  "node_modules/json-schema-traverse/LICENSE": "Copyright (c) 2017 Evgeny Poberezkin\n",
  "node_modules/yaml/LICENSE": "Copyright Eemeli Aro\n",
  "provenance/licenses/thedotmack_claude-mem.LICENSE": "Apache License\nVersion 2.0, January 2004\n",
  "provenance/licenses/thedotmack_claude-mem.NOTICE": "Claude-Mem\nCopyright 2026 Alex Newman\n",
  // §5.2's authority for the four identity fields the host manifests carry.
  // The values are the ones CATALOG above produces -- `name` from `package.id`,
  // `description` from `package.name` -- because a tree whose two sides already
  // disagree is a tree `ak build` is right to refuse, and these fixtures exist
  // to exercise everything except that.
  "package.json": '{\n  "name": "ak",\n  "version": "0.1.0",\n  "description": "agent-kit",\n  "license": "MIT"\n}\n',
  "evals/triage/does-not-start-unasked/case.yaml":
    'schema_version: "1.1"\nname: does-not-start-unasked\ntags: [negative]\n',
};

function cleanTree(): string {
  return makeTree({ ...TREE, "skills/triage/SKILL.md": SKILL, ...BUILDABLE });
}

describe("ak", () => {
  test("no command prints usage and exits non-zero", () => {
    const io = capture();
    expect(runCli([], { cwd: cleanTree(), io: io.io })).not.toBe(0);
    expect(io.stderr()).toContain("validate");
    expect(io.stderr()).toContain("attach");
    expect(io.stderr()).toContain("build");
  });

  test("an unknown command is an error, not a silent success", () => {
    const io = capture();
    expect(runCli(["frobnicate"], { cwd: cleanTree(), io: io.io })).not.toBe(0);
    expect(io.stderr()).toContain("frobnicate");
  });

  test("an unknown command names the command it was probably meant to be", () => {
    const io = capture();
    expect(runCli(["valdiate"], { cwd: cleanTree(), io: io.io })).toBe(2);
    expect(io.err[0]).toBe("ak: unknown command 'valdiate'; did you mean validate?");
  });

  test("an unknown kb command suggests kb", () => {
    const io = capture();
    expect(runCli(["kbb"], { cwd: cleanTree(), io: io.io })).toBe(2);
    expect(io.err[0]).toBe("ak: unknown command 'kbb'; did you mean kb?");
  });
});

describe("ak validate", () => {
  test("a clean tree exits 0", () => {
    const io = capture();
    expect(runCli(["validate"], { cwd: cleanTree(), io: io.io })).toBe(0);
  });

  test("every failure line names the file and the rule", () => {
    const root = makeTree({ ...TREE, "skills/triage/SKILL.md": SKILL, "skills/stray/SKILL.md": SKILL });
    const io = capture();
    expect(runCli(["validate"], { cwd: root, io: io.io })).not.toBe(0);
    const lines = io.out.filter((l) => l.includes("catalog.directory-without-entry"));
    expect(lines.length).toBeGreaterThan(0);
    expect(lines[0]).toContain("skills/stray");
    expect(lines[0]).toMatch(/^ERROR\s/);
  });

  test("a warning alone does not fail the run", () => {
    const long = `${SKILL}\n${"A line of guidance.\n".repeat(200)}`;
    const io = capture();
    const root = makeTree({ ...TREE, "skills/triage/SKILL.md": long });
    expect(runCli(["validate"], { cwd: root, io: io.io })).toBe(0);
    expect(io.stdout()).toContain("budget.skill-over-target");
  });

  test("--json emits one machine-readable record per issue", () => {
    const root = makeTree({ ...TREE, "skills/triage/SKILL.md": SKILL, "skills/stray/SKILL.md": SKILL });
    const io = capture();
    runCli(["validate", "--json"], { cwd: root, io: io.io });
    const parsed = JSON.parse(io.stdout()) as { ok: boolean; issues: Array<{ rule: string; file: string }> };
    expect(parsed.ok).toBe(false);
    expect(parsed.issues.some((i) => i.rule === "catalog.directory-without-entry")).toBe(true);
  });

  test("a missing catalog is reported, not a crash", () => {
    const io = capture();
    expect(runCli(["validate"], { cwd: makeTree({ "README.md": "x\n" }), io: io.io })).not.toBe(0);
    expect(io.stdout()).toContain("catalog.missing");
  });

  test("the summary counts errors, warnings and notes", () => {
    const io = capture();
    runCli(["validate"], { cwd: cleanTree(), io: io.io });
    // Anchored: an unanchored /0 error/ also matches "10 errors".
    expect(io.stdout()).toMatch(/^ak validate: 0 errors, \d+ warnings?, \d+ notes?, /m);
  });

  /**
   * The summary has to say whether the checks ran, not only what they found.
   *
   * `.donors/` is gitignored, so a machine that has not cloned it skips
   * donor-path-at-pin verification -- the check the provenance story rests on --
   * and before the skipped term the resulting summary was indistinguishable from
   * a verified one. An instrument that returns the same answer under both
   * hypotheses is not evidence.
   *
   * Severity cannot carry this. A warning claims a finding and invites being
   * silenced; the skipped term counts the absence of a look, so it has nothing
   * to silence.
   */
  const SKIPPING_TREE = {
    ...TREE,
    "skills/triage/SKILL.md": SKILL,
    "provenance/upstream.lock.yaml":
      "schema_version: 1\ndonors:\n  - id: donor-one\n    repo: example/one\n    path: .donors/donor_one\n    commit: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n    license: MIT\n",
    "provenance/adaptations.d/batch-1.yaml":
      "adaptations:\n  - path: skills/triage/SKILL.md\n    source: donor-one@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:x.md\n",
  };

  /** A tree with the generated adaptations file in place, so the only finding left is the skip. */
  function builtTree(tree: Record<string, string>): string {
    const root = makeTree(tree);
    runCli(["build"], { cwd: root, io: capture().io });
    return root;
  }

  /**
   * A tree where nothing is skipped, which takes the real schemas: without
   * `schemas/catalog.schema.json` even `cleanTree()` leaves catalog.yaml
   * unchecked against its own contract. That most fixtures in this file validate
   * without schema conformance running at all is a fact the term surfaced, and
   * the reason it is worth having.
   *
   * It takes a `skill.yaml` for the same reason. A body with no execution
   * contract leaves `## Side effects` with nothing to agree with, and
   * `sideeffects.manifest-unavailable` says so -- a second fact this term
   * surfaced about a fixture that called itself verified. The manifest is
   * deliberately partial: the tests below read the summary's skipped clause,
   * and an incomplete manifest is `schemas.document-invalid`, which is an
   * error and not a skip.
   */
  function verifiedTree(): string {
    const dir = join(import.meta.dir, "..", "schemas");
    const schemas: Record<string, string> = {};
    for (const name of readdirSync(dir)) {
      if (name.endsWith(".schema.json")) schemas[`schemas/${name}`] = readFileSync(join(dir, name), "utf8");
    }
    return makeTree({
      ...TREE,
      "skills/triage/SKILL.md": SKILL,
      "skills/triage/skill.yaml": "id: triage\nversion: 0.1.0\nkind: lifecycle\ninvocation: U\nside_effects: []\n",
      ...schemas,
    });
  }

  function summaryOf(root: string): string {
    const io = capture();
    runCli(["validate"], { cwd: root, io: io.io });
    return io.out[io.out.length - 1] ?? "";
  }

  test("the summary names a check that could not run", () => {
    const summary = summaryOf(builtTree(SKIPPING_TREE));
    expect(summary).toMatch(/\d+ checks? skipped: /);
    expect(summary).toContain("donor paths at pin");
  });

  test("a run with nothing skipped says so rather than staying silent", () => {
    // The zero is printed for the same reason the other three counts are. Were the
    // clause omitted when empty, its absence would carry the claim, and a reader who
    // does not know the convention could not tell a silent clause from a silent check.
    expect(summaryOf(verifiedTree())).toContain("0 checks skipped");
  });

  test("the two summaries differ, which is the whole point of the term", () => {
    expect(summaryOf(builtTree(SKIPPING_TREE))).not.toBe(summaryOf(verifiedTree()));
  });

  test("a skipped check is not a failure: the run still exits 0", () => {
    const io = capture();
    expect(runCli(["validate"], { cwd: builtTree(SKIPPING_TREE), io: io.io })).toBe(0);
  });

  test("--json carries the skipped checks beside ok, not only inside the issues", () => {
    // `ok: true` with no donor clones is the same value as `ok: true` having verified
    // every row, so a consumer gating on `ok` alone cannot see the difference either.
    const io = capture();
    runCli(["validate", "--json"], { cwd: builtTree(SKIPPING_TREE), io: io.io });
    const parsed = JSON.parse(io.stdout()) as { ok: boolean; skipped: string[] };
    expect(parsed.ok).toBe(true);
    expect(parsed.skipped).toContain("donor paths at pin");
  });

  test("--skill-style narrows the printed findings but the skipped clause still names the real skip", () => {
    // The clause reports on the whole run, not on the lines `--skill-style` chose
    // to print: a display filter that quietly zeroed it would say "0 checks
    // skipped" while one genuinely had nothing to judge, the same false-clean
    // reading the clause exists to rule out (see the tests above).
    const io = capture();
    runCli(["validate", "--skill-style"], { cwd: builtTree(SKIPPING_TREE), io: io.io });
    const summary = io.out.at(-1) ?? "";
    expect(summary).toMatch(/\d+ checks? skipped: /);
    expect(summary).toContain("donor paths at pin");
  });
});

describe("ak validate --skill-style", () => {
  test("the default summary names a skill-style warning count", () => {
    const io = capture();
    runCli(["validate"], { cwd: cleanTree(), io: io.io });
    expect(io.stdout()).toMatch(/\d+ skill-style warnings?/);
  });

  test("the count is positive on a tree the style linter actually has something to say about", () => {
    const root = makeTree({ ...TREE, "skills/triage/SKILL.md": SKILL, "skills/stray/SKILL.md": SKILL });
    const io = capture();
    runCli(["validate"], { cwd: root, io: io.io });
    const summary = io.out.at(-1) ?? "";
    expect(summary).not.toMatch(/\b0 skill-style warnings\b/);
  });

  test("--skill-style prints only the skill-style findings, not other issues", () => {
    const root = makeTree({ ...TREE, "skills/triage/SKILL.md": SKILL, "skills/stray/SKILL.md": SKILL });
    const io = capture();
    const code = runCli(["validate", "--skill-style"], { cwd: root, io: io.io });
    expect(io.stdout()).not.toContain("catalog.directory-without-entry");
    expect(io.stdout()).toContain("skill-style.");
    // The flag narrows what is printed, not what the exit code answers for: a
    // real error sitting outside the skill-style findings still fails the run.
    expect(code).not.toBe(0);
    // And the summary line, the run's receipt, does not read "0 errors" beside that exit 1.
    expect(io.out.at(-1) ?? "").not.toMatch(/\b0 errors\b/);
  });

  test("--skill-style --json carries only the skill-style issues in the issues array", () => {
    const root = makeTree({ ...TREE, "skills/triage/SKILL.md": SKILL, "skills/stray/SKILL.md": SKILL });
    const io = capture();
    runCli(["validate", "--skill-style", "--json"], { cwd: root, io: io.io });
    const parsed = JSON.parse(io.stdout()) as { ok: boolean; issues: Array<{ rule: string }> };
    expect(parsed.ok).toBe(false);
    expect(parsed.issues.length).toBeGreaterThan(0);
    expect(parsed.issues.every((i) => i.rule.startsWith("skill-style."))).toBe(true);
  });

  test("a tree with nothing but skill-style findings still exits 0 under --skill-style", () => {
    const io = capture();
    expect(runCli(["validate", "--skill-style"], { cwd: cleanTree(), io: io.io })).toBe(0);
  });
});

describe("ak build", () => {
  test("writes every host bundle and enumerates skills explicitly", () => {
    const root = cleanTree();
    const io = capture();
    expect(runCli(["build"], { cwd: root, io: io.io })).toBe(0);
    const manifestPath = join(root, "dist/claude-code/.claude-plugin/plugin.json");
    expect(existsSync(manifestPath)).toBe(true);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { skills: string[] };
    expect(manifest.skills).toEqual(["./skills/triage"]);
    expect(existsSync(join(root, "dist/codex"))).toBe(true);
    expect(existsSync(join(root, "dist/kimi/.kimi-plugin/plugin.json"))).toBe(true);
  });

  test("--check on an unbuilt tree fails and writes nothing", () => {
    const root = cleanTree();
    const io = capture();
    expect(runCli(["build", "--check"], { cwd: root, io: io.io })).not.toBe(0);
    expect(existsSync(join(root, "dist"))).toBe(false);
  });

  test("--check after a build succeeds", () => {
    const root = cleanTree();
    expect(runCli(["build"], { cwd: root, io: capture().io })).toBe(0);
    expect(runCli(["build", "--check"], { cwd: root, io: capture().io })).toBe(0);
  });

  test("--check fails once the source moves ahead of dist", () => {
    const root = cleanTree();
    runCli(["build"], { cwd: root, io: capture().io });
    writeFileSync(join(root, "skills/triage/SKILL.md"), `${SKILL}\nOne more line.\n`);
    const io = capture();
    expect(runCli(["build", "--check"], { cwd: root, io: io.io })).not.toBe(0);
    expect(io.stdout()).toContain("packaging.dist-stale");
  });

  test("--profile narrows the bundle to that profile's members", () => {
    const catalog = CATALOG.replace("    profiles: [core]", "    profiles: [autonomy]").replace(
      "  - id: core\n    status: contract\n    default: true\n",
      "  - id: core\n    status: contract\n    default: true\n  - id: autonomy\n    status: contract\n",
    );
    // `...TREE` first so the edited catalog replaces the stock one while the
    // adapter contract it declares still travels with it.
    const root = makeTree({ ...TREE, "catalog.yaml": catalog, "skills/triage/SKILL.md": SKILL, ...BUILDABLE });
    expect(runCli(["build", "--profile", "core"], { cwd: root, io: capture().io })).toBe(0);
    const manifest = JSON.parse(readFileSync(join(root, "dist/claude-code/.claude-plugin/plugin.json"), "utf8")) as {
      skills: string[];
    };
    expect(manifest.skills).toEqual([]);
  });

  test("an unknown profile is refused before building, with the profiles that exist", () => {
    const io = capture();
    const root = cleanTree();
    expect(runCli(["build", "--profile", "cor"], { cwd: root, io: io.io })).toBe(2);
    expect(io.stderr()).toBe("ak build: unknown profile 'cor'; did you mean core?");
    expect(existsSync(join(root, "dist"))).toBe(false);
  });

  // `ak validate --profile` only reached the links check, which keeps link issues alone, so a
  // mistyped profile measured nothing and passed.
  test("ak validate refuses an unknown profile instead of passing over it", () => {
    const io = capture();
    expect(runCli(["validate", "--profile", "ghost"], { cwd: cleanTree(), io: io.io })).toBe(2);
    expect(io.stderr()).toBe("ak validate: unknown profile 'ghost'; valid: core, all");
    expect(io.stdout()).toBe("");
  });

  test("--profile all is known even where the catalog does not declare it", () => {
    expect(runCli(["validate", "--profile", "all"], { cwd: cleanTree(), io: capture().io })).toBe(0);
  });

  test("an unknown host is refused with the hosts that exist", () => {
    for (const command of ["validate", "build"]) {
      const io = capture();
      expect(runCli([command, "--host", "codx"], { cwd: cleanTree(), io: io.io })).toBe(2);
      expect(io.stderr()).toBe(`ak ${command}: unknown host 'codx'; did you mean codex?`);
    }
  });

  test("--host builds that host's bundle alone", () => {
    const root = cleanTree();
    expect(runCli(["build", "--host", "codex"], { cwd: root, io: capture().io })).toBe(0);
    expect(existsSync(join(root, "dist", "codex"))).toBe(true);
    expect(existsSync(join(root, "dist", "claude-code"))).toBe(false);
  });

  test("the packager's own unknown-profile issue names the nearest profile", () => {
    const root = cleanTree();
    const { catalog } = loadCatalog(root);
    if (catalog === null) throw new Error("fixture catalog did not load");
    const issue = checkBundles({ root, catalog }, { profile: "cor" }).find(
      (i) => i.rule === "packaging.unknown-profile",
    );
    expect(issue?.message).toContain("did you mean core?");
  });

  /**
   * The generated adaptations file is committed, so the thing that keeps it
   * honest is not the generator but `ak build --check` refusing a tree where it
   * has drifted. `checkAdaptationsSync` is unit-tested; these assert the command
   * actually runs it and exits non-zero, which is the wiring a refactor can drop
   * without any unit test noticing.
   */
  describe("--check gates the committed adaptations record", () => {
    const LOCK =
      "donors:\n  - id: donorx\n    path: .donors/donorx\n    commit: 0123456789abcdef0123456789abcdef01234567\n";
    const SOURCE = "donorx@0123456789abcdef0123456789abcdef01234567:docs/guide.md";
    const FRAGMENT = `adaptations:\n  - path: skills/triage/SKILL.md\n    source: ${SOURCE}\n`;

    const adaptedTree = (extra: Record<string, string> = {}) =>
      makeTree({
        ...TREE,
        "skills/triage/SKILL.md": SKILL,
        "provenance/upstream.lock.yaml": LOCK,
        [`${ADAPTATIONS_FRAGMENT_DIR}/batch-1.yaml`]: FRAGMENT,
        ...BUILDABLE,
        ...extra,
      });

    test("a fragment with no generated file fails, naming the path NOTICE points at", () => {
      const io = capture();
      expect(runCli(["build", "--check"], { cwd: adaptedTree(), io: io.io })).not.toBe(0);
      expect(io.stdout()).toContain("provenance.adaptations-out-of-sync");
      expect(io.stdout()).toContain(ADAPTATIONS_FILE);
    });

    test("a generated file edited away from its fragments fails", () => {
      const root = adaptedTree();
      runCli(["build"], { cwd: root, io: capture().io });
      writeFileSync(join(root, ADAPTATIONS_FILE), "adaptations: []\n");
      const io = capture();
      expect(runCli(["build", "--check"], { cwd: root, io: io.io })).not.toBe(0);
      expect(io.stdout()).toContain("provenance.adaptations-out-of-sync");
    });

    test("a fragment added after the last build fails, which is the batch case", () => {
      const root = adaptedTree();
      runCli(["build"], { cwd: root, io: capture().io });
      writeFileSync(
        join(root, `${ADAPTATIONS_FRAGMENT_DIR}/batch-2.yaml`),
        `adaptations:\n  - path: references/guide/REFERENCE.md\n    source: ${SOURCE}\n`,
      );
      const io = capture();
      expect(runCli(["build", "--check"], { cwd: root, io: io.io })).not.toBe(0);
      expect(io.stdout()).toContain("provenance.adaptations-out-of-sync");
    });

    test("running the build clears the drift, so the gate is passable rather than permanent", () => {
      const root = adaptedTree();
      expect(runCli(["build"], { cwd: root, io: capture().io })).toBe(0);
      expect(existsSync(join(root, ADAPTATIONS_FILE))).toBe(true);
      expect(runCli(["build", "--check"], { cwd: root, io: capture().io })).toBe(0);
    });

    test("ak validate reports the same drift, so neither command is the only guard", () => {
      const io = capture();
      expect(runCli(["validate"], { cwd: adaptedTree(), io: io.io })).not.toBe(0);
      expect(io.stdout()).toContain("provenance.adaptations-out-of-sync");
    });
  });

  test("a content failure blocks the build rather than shipping it", () => {
    const body = SKILL.replace("Read the queue", `Read the queue with ${DENY_MARKER}`).replace(
      DENY_MARKER,
      sampleModelTerm(),
    );
    const root = makeTree({ ...TREE, "skills/triage/SKILL.md": body });
    const io = capture();
    expect(runCli(["build"], { cwd: root, io: io.io })).not.toBe(0);
    expect(existsSync(join(root, "dist"))).toBe(false);
    expect(io.stdout()).toContain("content.denylist");
  });
});

/**
 * The summary line names the install configuration it was measured under.
 *
 * A packaged mode now depends on `ak.install.yaml`, which no commit carries, so
 * a figure that omitted it could not be re-derived -- `AGENTS.md`, "Receipts
 * name their instrument". On the summary line itself rather than a line of its
 * own, because that line is the receipt: research/probes/validate-figure.sh
 * quotes the last line and nothing else. Each tree here is a fixture root, so
 * the developer's own install file is never read.
 */
describe("the install configuration the summary names", () => {
  const DEFAULT = "; install: no ak.install.yaml: default, all fail-closed adapters attached (none)";

  const summaryLine = (io: ReturnType<typeof capture>, label: string) =>
    io.out.filter((line) => line.startsWith(`${label}: `) && line.includes(" error")).at(-1) ?? "";

  test("with no install file, ak validate's summary says the default applied", () => {
    const io = capture();
    runCli(["validate"], { cwd: cleanTree(), io: io.io });
    expect(io.out.at(-1)).toEndWith(DEFAULT);
  });

  test("with an install file, the summary names it and what it attached", () => {
    const io = capture();
    const root = makeTree({
      ...TREE,
      "skills/triage/SKILL.md": SKILL,
      ...BUILDABLE,
      "ak.install.yaml": "attached: []\n",
    });
    runCli(["validate"], { cwd: root, io: io.io });
    expect(io.out.at(-1)).toEndWith("; install: ak.install.yaml: attached none");
  });

  test("ak build and ak build --check carry the same clause", () => {
    const root = cleanTree();
    const built = capture();
    expect(runCli(["build"], { cwd: root, io: built.io })).toBe(0);
    expect(summaryLine(built, "ak build")).toEndWith(DEFAULT);
    const checked = capture();
    runCli(["build", "--check"], { cwd: root, io: checked.io });
    expect(summaryLine(checked, "ak build --check")).toEndWith(DEFAULT);
  });

  test("an unknown adapter id fails the run", () => {
    const io = capture();
    const root = makeTree({
      ...TREE,
      "skills/triage/SKILL.md": SKILL,
      ...BUILDABLE,
      "ak.install.yaml": "attached: [nope]\n",
    });
    expect(runCli(["validate"], { cwd: root, io: io.io })).not.toBe(0);
    expect(io.stdout()).toContain("packaging.install-unknown-adapter");
    expect(io.stdout()).toContain("'nope'");
  });

  /** The real schemas beside the fixture, so `ak validate` checks the file's shape against the real contract. */
  function withRealSchemas(install: string): string {
    const dir = join(import.meta.dir, "..", "schemas");
    const schemas: Record<string, string> = {};
    for (const name of readdirSync(dir)) {
      if (name.endsWith(".schema.json")) schemas[`schemas/${name}`] = readFileSync(join(dir, name), "utf8");
    }
    return makeTree({ ...TREE, "skills/triage/SKILL.md": SKILL, ...BUILDABLE, ...schemas, "ak.install.yaml": install });
  }

  for (const [what, install] of [
    ["a bare id where the list belongs", "attached: knowledgebase\n"],
    ["an empty file", ""],
  ] as const) {
    test(`a malformed install file fails ak validate on its shape: ${what}`, () => {
      // The loader attaches nothing and says so only to the build; the shape
      // is the schema's to report, so this is the row validate must show.
      const io = capture();
      expect(runCli(["validate", "--json"], { cwd: withRealSchemas(install), io: io.io })).not.toBe(0);
      const parsed = JSON.parse(io.stdout()) as { issues: Array<{ rule: string; file: string; severity: string }> };
      const hit = parsed.issues.find((i) => i.rule === "schemas.document-invalid" && i.file === "ak.install.yaml");
      expect(hit?.severity).toBe("error");
    });
  }

  test("--json carries the install configuration beside ok", () => {
    const io = capture();
    runCli(["validate", "--json"], { cwd: cleanTree(), io: io.io });
    const parsed = JSON.parse(io.stdout()) as {
      install: { file: string | null; attached: string[]; backends: Record<string, string> };
    };
    expect(parsed.install).toEqual({ file: null, attached: [], backends: {} });
  });
});

describe("ak attach", () => {
  test("requires a subject", () => {
    const io = capture();
    expect(runCli(["attach"], { cwd: cleanTree(), io: io.io })).not.toBe(0);
  });

  test("prints the selected packs with a rationale for each", () => {
    const io = capture();
    expect(runCli(["attach", "src/auth/session.ts"], { cwd: cleanTree(), io: io.io })).toBe(0);
    expect(io.stdout()).toContain("pack-secure");
    expect(io.stdout()).toContain("why:");
  });

  test("--json emits the selections and the rejected packs", () => {
    const io = capture();
    runCli(["attach", "src/auth/session.ts", "--json"], { cwd: cleanTree(), io: io.io });
    const parsed = JSON.parse(io.stdout()) as {
      selections: Array<{ pack: string; rationale: string }>;
      skipped: Array<{ pack: string; reason: string }>;
    };
    expect(parsed.selections.some((s) => s.pack === "pack-secure" && s.rationale.length > 0)).toBe(true);
    expect(parsed.skipped.length).toBeGreaterThan(0);
  });
});
