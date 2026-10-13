/**
 * research/probes/catalog-progress.sh against fixture repositories.
 *
 * The probe compares each catalog section with the baseline count plus the ids
 * recorded in research/probes/catalog-expansions.yaml, and checks the record
 * against history: the baseline catalog, and the commits each expansion cites.
 * Each fixture is a git repository whose first commit is the baseline and
 * whose second adds the expansion, so the history checks run on real commits.
 * Assertions read the probe's reason codes and sections and its exit status,
 * never its prose.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";

import { makeTree } from "./helpers/tree.ts";

const ROOT = join(import.meta.dir, "..");
const PROBE = join(ROOT, "research/probes/catalog-progress.sh");
const EXPANSIONS = "research/probes/catalog-expansions.yaml";

const BASELINE: Record<string, number> = {
  skills: 33,
  packs: 8,
  protocols: 7,
  roles: 29,
  references: 4,
  schemas: 14,
  policies: 5,
  profiles: 4,
  adapters: 4,
};

/** A catalog with the baseline count in every section, plus `extra` ids per section. */
function catalog(extra: Record<string, string[]> = {}): string {
  const doc: Record<string, unknown> = {};
  for (const [section, n] of Object.entries(BASELINE)) {
    const ids = [...Array.from({ length: n }, (_, i) => `${section}-${i}`), ...(extra[section] ?? [])];
    doc[section] = ids.map((id) => ({ id, status: "authored" }));
  }
  return stringify(doc);
}

function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${new TextDecoder().decode(r.stderr)}`);
  return new TextDecoder().decode(r.stdout).trim();
}

/** A repository: the baseline catalog, then a commit that adds `extra`. */
interface Repo {
  readonly root: string;
  readonly baseline: string;
  readonly added: string;
}

function repo(extra: Record<string, string[]> = {}): Repo {
  const root = makeTree({ "catalog.yaml": catalog() });
  git(root, "init", "-q");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "baseline");
  const baseline = git(root, "rev-parse", "HEAD");
  writeFileSync(join(root, "catalog.yaml"), catalog(extra));
  git(root, "commit", "-q", "--allow-empty", "-am", "expand");
  return { root, baseline, added: git(root, "rev-parse", "HEAD") };
}

type Section = {
  baseline: number;
  catalog: number;
  expansions: { ids: string[]; reason: string; commits: string[] }[];
};

function record(sections: Record<string, Section>): string {
  return stringify(sections);
}

interface Run {
  readonly code: number;
  readonly expanded: string[];
  /** What each SKIPPED line on stdout says was skipped. */
  readonly skipped: string[];
  /** `[code, section]` per DISAGREEMENT line. */
  readonly disagreements: [string, string][];
}

function probe(cwd: string, baseline: string, expansions?: string): Run {
  if (expansions !== undefined) {
    Bun.spawnSync(["mkdir", "-p", join(cwd, "research/probes")]);
    writeFileSync(join(cwd, EXPANSIONS), expansions);
  }
  const run = Bun.spawnSync(["bash", PROBE], { cwd, env: { ...process.env, CATALOG_BASELINE: baseline } });
  const lines = (s: Uint8Array, tag: string) =>
    new TextDecoder()
      .decode(s)
      .split("\n")
      .filter((l) => l.startsWith(`  ${tag}  `))
      .map((l) => l.slice(tag.length + 4));
  return {
    code: run.exitCode ?? -1,
    expanded: lines(run.stdout, "EXPANDED").map((l) => l.split(/\s+/)[0] ?? ""),
    skipped: lines(run.stdout, "SKIPPED"),
    disagreements: lines(run.stderr, "DISAGREEMENT").map((l) => {
      const [code = "", section = ""] = l.split(/\s+/);
      return [code, section];
    }),
  };
}

const one = (ids: string[], commits: string[], baseline = 4, size = 4 + ids.length): string =>
  record({ adapters: { baseline, catalog: size, expansions: [{ ids, reason: "r", commits }] } });

describe("catalog-progress.sh", () => {
  test("a catalog at the baseline counts is clean with no expansions file", () => {
    const r = repo();
    expect(probe(r.root, r.baseline)).toEqual({ code: 0, expanded: [], skipped: [], disagreements: [] });
  });

  test("a recorded expansion, cited to the commit that adds it, reads clean", () => {
    const r = repo({ adapters: ["extra"] });
    expect(probe(r.root, r.baseline, one(["extra"], [r.added]))).toEqual({
      code: 0,
      expanded: ["adapters"],
      skipped: [],
      disagreements: [],
    });
  });

  test("an unrecorded entry flags its section", () => {
    const r = repo({ adapters: ["extra"], roles: ["unrecorded"] });
    const run = probe(r.root, r.baseline, one(["extra"], [r.added]));
    expect(run.code).toBe(1);
    expect(run.disagreements).toEqual([["count-differs", "roles"]]);
  });

  test("a recorded id that is not in the catalog flags", () => {
    const r = repo({ adapters: ["extra"] });
    const run = probe(r.root, r.baseline, one(["extra", "gone"], [r.added]));
    expect(run.code).toBe(1);
    expect(run.disagreements).toEqual([
      ["id-absent", "adapters"],
      ["id-not-added-by-cited-commit", "adapters"],
      ["count-differs", "adapters"],
    ]);
  });

  test("a stale baseline or catalog figure in the record flags", () => {
    const r = repo({ adapters: ["extra"] });
    const run = probe(r.root, r.baseline, one(["extra"], [r.added], 3, 4));
    expect(run.code).toBe(1);
    expect(run.disagreements).toEqual([
      ["baseline-figure-stale", "adapters"],
      ["catalog-figure-stale", "adapters"],
    ]);
  });

  test("a recorded id the baseline catalog already had flags", () => {
    const r = repo({ adapters: ["extra"] });
    // adapters-0 is in the baseline; recording it as an expansion explains a
    // difference it did not cause, whatever the counts say.
    const run = probe(r.root, r.baseline, one(["extra", "adapters-0"], [r.added]));
    expect(run.code).toBe(1);
    expect(run.disagreements).toContainEqual(["id-in-baseline", "adapters"]);
  });

  test("a cited commit that does not resolve flags", () => {
    const r = repo({ adapters: ["extra"] });
    const run = probe(r.root, r.baseline, one(["extra"], [r.added, "0000000"]));
    expect(run.code).toBe(1);
    expect(run.disagreements).toEqual([["commit-unresolved", "adapters"]]);
  });

  test("a cited commit that leaves catalog.yaml alone flags, though its tree has the id", () => {
    const r = repo({ adapters: ["extra"] });
    // The id is in this commit's catalog because an earlier commit added it;
    // having it is not adding it.
    writeFileSync(join(r.root, "notes.md"), "unrelated\n");
    git(r.root, "add", "notes.md");
    git(r.root, "commit", "-q", "-m", "notes");
    const later = git(r.root, "rev-parse", "HEAD");
    const run = probe(r.root, r.baseline, one(["extra"], [later]));
    expect(run.code).toBe(1);
    expect(run.disagreements).toEqual([
      ["commit-does-not-add", "adapters"],
      ["id-not-added-by-cited-commit", "adapters"],
    ]);
  });

  test("a cited commit whose catalog change does not add the id flags", () => {
    const r = repo({ adapters: ["extra"] });
    const run = probe(r.root, r.baseline, one(["extra"], [r.baseline]));
    expect(run.code).toBe(1);
    expect(run.disagreements).toEqual([
      ["commit-does-not-add", "adapters"],
      ["id-not-added-by-cited-commit", "adapters"],
    ]);
  });

  test("a baseline count that differs from the baseline commit flags", () => {
    const r = repo();
    // A baseline commit whose catalog has one role more than the probe's count.
    writeFileSync(join(r.root, "catalog.yaml"), catalog({ roles: ["r"] }));
    git(r.root, "commit", "-q", "-am", "grow");
    const grown = git(r.root, "rev-parse", "HEAD");
    writeFileSync(join(r.root, "catalog.yaml"), catalog());
    const run = probe(r.root, grown);
    expect(run.code).toBe(1);
    expect(run.disagreements).toEqual([["baseline-count-differs", "roles"]]);
  });

  test("a shallow clone without the history skips the history checks, not the counts", () => {
    const r = repo({ adapters: ["extra"] });
    const clone = join(mkdtempSync(join(tmpdir(), "ak-shallow-")), "c");
    git(tmpdir(), "clone", "-q", "--depth", "1", `file://${r.root}`, clone);
    const run = probe(clone, r.baseline, one(["extra"], [r.added]));
    expect(run).toEqual({
      code: 0,
      expanded: ["adapters"],
      skipped: [`history checks: baseline ${r.baseline} is not in this shallow clone`],
      disagreements: [],
    });
    const unrecorded = probe(clone, r.baseline, one([], [r.added]));
    expect(unrecorded.disagreements).toContainEqual(["count-differs", "adapters"]);
  });

  describe("a shallow clone with the baseline but not every cited commit", () => {
    /**
     * main: a root commit, the baseline, a commit adding `extra` and `other`,
     * and one that leaves the catalog alone. A side branch off the baseline
     * adds `other` on its own. A depth-3 clone of main has the baseline and
     * everything after it, is shallow, and lacks the side commit.
     */
    function partial(): { clone: string; baseline: string; added: string; later: string; side: string } {
      const root = makeTree({ "README.md": "root\n" });
      git(root, "init", "-q", "-b", "main");
      git(root, "add", "-A");
      git(root, "commit", "-q", "-m", "root");
      writeFileSync(join(root, "catalog.yaml"), catalog());
      git(root, "add", "-A");
      git(root, "commit", "-q", "-m", "baseline");
      const baseline = git(root, "rev-parse", "HEAD");
      git(root, "checkout", "-q", "-b", "side");
      writeFileSync(join(root, "catalog.yaml"), catalog({ adapters: ["other"] }));
      git(root, "commit", "-q", "-am", "side");
      const side = git(root, "rev-parse", "HEAD");
      git(root, "checkout", "-q", "main");
      writeFileSync(join(root, "catalog.yaml"), catalog({ adapters: ["extra", "other"] }));
      git(root, "commit", "-q", "-am", "expand");
      const added = git(root, "rev-parse", "HEAD");
      writeFileSync(join(root, "notes.md"), "unrelated\n");
      git(root, "add", "notes.md");
      git(root, "commit", "-q", "-m", "notes");
      const later = git(root, "rev-parse", "HEAD");
      const clone = join(mkdtempSync(join(tmpdir(), "ak-partial-")), "c");
      git(tmpdir(), "clone", "-q", "--depth", "3", "--single-branch", "--branch", "main", `file://${root}`, clone);
      expect(git(clone, "rev-parse", "--is-shallow-repository")).toBe("true");
      return { clone, baseline, added, later, side };
    }

    const two = (extraCommit: string, side: string): string =>
      record({
        adapters: {
          baseline: 4,
          catalog: 6,
          expansions: [
            { ids: ["extra"], reason: "r", commits: [extraCommit] },
            { ids: ["other"], reason: "r", commits: [side] },
          ],
        },
      });

    test("skips only the missing commit, and the ids that depend on it", () => {
      const p = partial();
      expect(probe(p.clone, p.baseline, two(p.added, p.side))).toEqual({
        code: 0,
        expanded: ["adapters"],
        skipped: [`adapters: commit ${p.side} is not in this shallow clone`],
        disagreements: [],
      });
    });

    test("still checks the cited commits that resolve", () => {
      const p = partial();
      const run = probe(p.clone, p.baseline, two(p.later, p.side));
      expect(run.code).toBe(1);
      expect(run.skipped).toEqual([`adapters: commit ${p.side} is not in this shallow clone`]);
      expect(run.disagreements).toEqual([
        ["commit-does-not-add", "adapters"],
        ["id-not-added-by-cited-commit", "adapters"],
      ]);
    });

    test("does not read a boundary commit's missing parent as an empty catalog", () => {
      const p = partial();
      // The baseline is the clone's boundary: its parent was not fetched.
      // Read as empty, it would appear to add every id in its catalog.
      const run = probe(p.clone, p.baseline, one(["adapters-0"], [p.baseline], 4, 4));
      expect(run.skipped).toEqual([`adapters: the parent of commit ${p.baseline} is not in this shallow clone`]);
      expect(run.disagreements.map(([code]) => code)).not.toContain("commit-does-not-add");
    });
  });

  test("this repository's catalog has no unexplained difference from the baseline", () => {
    const run = Bun.spawnSync(["bash", PROBE], { cwd: ROOT });
    expect(new TextDecoder().decode(run.stderr)).not.toContain("DISAGREEMENT");
    expect(run.exitCode).toBe(0);
    // A full clone has every commit the record cites, so a SKIPPED line here
    // means a check did not run, not that the record held up.
    if (git(ROOT, "rev-parse", "--is-shallow-repository") === "false") {
      expect(new TextDecoder().decode(run.stdout)).not.toContain("SKIPPED");
    }
    // The probe walks this repository's real history, which takes about as
    // long as the default limit allows; the fixtures above have two commits.
  }, 30_000);
});
