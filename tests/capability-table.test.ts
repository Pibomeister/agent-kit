import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import {
  CAPABILITY_TABLE_FILE,
  HOST_ALONE,
  MODE_CEILING_CHECK,
  blockingStatuses,
  ceilingFor,
  loadCapabilityTable,
  type Supply,
} from "../src/packaging/capability-table.ts";
import { loadCatalog } from "../src/catalog/load.ts";
import { loadInstallConfig } from "../src/packaging/install.ts";
import { loadSkillManifest } from "../src/packaging/manifest.ts";
import { hasBlockingSkips } from "../src/validation/types.ts";
import { makeTree } from "./helpers/tree.ts";

/** This repository, for the tests that measure against the real contract. */
const REPO = join(import.meta.dir, "..");

const HEADER = `# claude-code

## 3. Capabilities

| Capability | Status | Detail |
|---|---|---|
`;

function contractWith(rows: string): Record<string, string> {
  return { [CAPABILITY_TABLE_FILE]: `${HEADER}${rows}\n## 4. Next\n` };
}

const ROWS = [
  "| `repository-read` | `satisfied` | Read, Glob, Grep |",
  "| `artifact-write` | `partial` | Storage, not binding |",
  "| `isolated-worktree` | `convention-only` | Not host-confined |",
  "| `kb-write` | `not-provided` | Transport only |",
].join("\n");

/**
 * §3's table is the single statement of what each host supplies, for both hosts.
 *
 * `adapters/codex/CONTRACT.md` §3 says so in its own words -- "Every
 * `common#/$defs/capability` value carries the status
 * `adapters/claude-code/CONTRACT.md` §3 gives it, with no per-capability
 * difference on this host" -- and gives the reason a copy would be wrong: the
 * copy that decided would be whichever one the code read.
 *
 * Parsed out of the contract rather than restated in TypeScript for the same
 * reason. §3 states outright that "`ak validate` parses it out of this file
 * rather than reading a generated copy", and until this module existed nothing
 * in `src/` did -- the sentence described an instrument that had not been
 * built.
 */
describe("the capability table §3 states once for both hosts", () => {
  test("every row's capability and status is read out of the contract", () => {
    const root = makeTree(contractWith(ROWS));
    const table = loadCapabilityTable(root);
    expect(table.available).toBe(true);
    expect(table.status.get("repository-read")).toBe("satisfied");
    expect(table.status.get("artifact-write")).toBe("partial");
    expect(table.status.get("isolated-worktree")).toBe("convention-only");
    expect(table.status.get("kb-write")).toBe("not-provided");
    expect(table.status.size).toBe(4);
  });

  test("rows outside §3 are not read, so a later table cannot redefine a status", () => {
    // §5's restriction table has the same three-column shape and is not a
    // capability statement. A parser that swept the whole file would read its
    // rows as capabilities and answer with whatever the last one said.
    const root = makeTree({
      [CAPABILITY_TABLE_FILE]: `${HEADER}${ROWS}\n\n## 4. Later\n\n| \`kb-write\` | \`satisfied\` | A row in a different section |\n`,
    });
    const table = loadCapabilityTable(root);
    expect(table.status.get("kb-write")).toBe("not-provided");
    expect(table.status.size).toBe(4);
  });

  test("a status outside the controlled vocabulary is an error, not a silent skip", () => {
    const root = makeTree(contractWith("| `kb-write` | `mostly` | A compound status |"));
    const table = loadCapabilityTable(root);
    const issue = table.issues.find((i) => i.rule === "packaging.unknown-capability-status");
    expect(issue?.severity).toBe("error");
    expect(issue?.message).toContain("mostly");
    expect(table.status.has("kb-write")).toBe(false);
  });

  test("a missing contract is unavailable, never an empty table that answers every question", () => {
    // The failure this guards: an unreadable table yields no `not-provided`
    // rows, every ceiling computes to autonomous, and the build certifies every
    // declaration it was supposed to check. Nothing is emitted from a table
    // that could not be read.
    //
    // Asserted on the blocking axis and not on severity, which is the
    // distinction `src/validation/types.ts` exists to make: the subject -- every
    // skill's declared mode -- is sitting in front of the check, and what went
    // missing is the authority it measures them against. That is `unavailable`,
    // a note that fails the run, and `hasErrors` is false for it in exactly the
    // way it is false for a check that passed.
    const table = loadCapabilityTable(makeTree({}));
    expect(table.available).toBe(false);
    const issue = table.issues.find((i) => i.rule === "packaging.capability-table-unavailable");
    expect(issue?.blocking).toBe(true);
    expect(issue?.skipped).toBe(MODE_CEILING_CHECK);
    expect(hasBlockingSkips(table.issues)).toBe(true);
    expect(table.status.size).toBe(0);
  });

  test("a contract with no §3 section is unavailable for the same reason", () => {
    const root = makeTree({ [CAPABILITY_TABLE_FILE]: "# claude-code\n\n## 4. Install\n\nNothing here.\n" });
    const table = loadCapabilityTable(root);
    expect(table.available).toBe(false);
    expect(table.issues.some((i) => i.rule === "packaging.capability-table-unavailable")).toBe(true);
  });

  test("a §3 section holding no rows is unavailable rather than an empty answer", () => {
    const root = makeTree({ [CAPABILITY_TABLE_FILE]: "# h\n\n## 3. Capabilities\n\nProse only.\n\n## 4. Next\n" });
    const table = loadCapabilityTable(root);
    expect(table.available).toBe(false);
    expect(table.issues.some((i) => i.rule === "packaging.capability-table-unavailable")).toBe(true);
  });

  test("the real contract parses, and its rows are exactly the capability vocabulary", () => {
    // One-to-one against `schemas/common.schema.json#/$defs/capability`. A
    // capability in the vocabulary and absent from the table has no stated
    // status on any host, which is the hole codex §3 records having had for
    // `isolated-worktree`, `isolated-review-context` and `independent-context`.
    const table = loadCapabilityTable(REPO);
    expect(table.available).toBe(true);
    expect(table.issues).toEqual([]);
    const schema = JSON.parse(
      require("node:fs").readFileSync(join(REPO, "schemas/common.schema.json"), "utf8"),
    ) as { $defs: { capability: { enum: string[] } } };
    expect([...table.status.keys()].sort()).toEqual([...schema.$defs.capability.enum].sort());
  });
});

/**
 * The ceiling: the most autonomy a skill can be packaged with on a host that
 * does not supply everything the skill requires.
 *
 * `adapters/claude-code/CONTRACT.md` §4: "A host that cannot enforce a
 * restriction an autonomous run requires **exposes the affected skill in
 * guided/manual mode and rejects autonomous mode.** It never runs the skill
 * with the restriction silently absent."
 */
describe("the ceiling a skill's requires[] puts on its mode", () => {
  const table = loadCapabilityTable(makeTree(contractWith(ROWS)));

  test("a skill requiring nothing the host withholds may be autonomous", () => {
    const ceiling = ceilingFor(["repository-read"], table);
    expect(ceiling.mode).toBe("autonomous");
    expect(ceiling.blocking).toEqual([]);
    expect(ceiling.unknown).toEqual([]);
  });

  test("a skill requiring a not-provided capability is capped at guided, and the capability is named", () => {
    const ceiling = ceilingFor(["repository-read", "kb-write"], table);
    expect(ceiling.mode).toBe("guided");
    expect(ceiling.blocking).toEqual(["kb-write"]);
  });

  test("every blocking capability is named, not just the first", () => {
    // The reader has to fix all of them. A message naming one sends them back
    // for a second build to discover the next.
    const twoMissing = loadCapabilityTable(
      makeTree(contractWith(`${ROWS}\n| \`runner-grants\` | \`not-provided\` | No grant validator |`)),
    );
    expect(ceilingFor(["kb-write", "runner-grants", "repository-read"], twoMissing).blocking).toEqual([
      "kb-write",
      "runner-grants",
    ]);
  });

  test("an empty requires[] is autonomous, because it asks the host for nothing", () => {
    expect(ceilingFor([], table).mode).toBe("autonomous");
  });

  test("a required capability with no row in the table is unknown, not absent and not satisfied", () => {
    // The fails-open this replaces: treating an unlisted capability as
    // satisfied certifies a skill against a table that never mentioned what it
    // needs. Reported so the ceiling for that skill is stated as unknown.
    const ceiling = ceilingFor(["repository-read", "telepathy"], table);
    expect(ceiling.unknown).toEqual(["telepathy"]);
    expect(ceiling.mode).toBe("guided");
  });

  test("an unavailable table yields no ceiling at all rather than autonomous", () => {
    const ceiling = ceilingFor(["repository-read"], loadCapabilityTable(makeTree({})));
    expect(ceiling.mode).toBe(null);
  });

  test("the statuses that cap autonomy are stated in one place and `partial` is not among them", () => {
    // Measured rather than assumed. Under the stricter reading -- anything not
    // `satisfied` caps -- `artifact-write` is `partial` and every skill that
    // emits a run artifact requires it, so most ceilings in the tree would be
    // guided by construction rather than by fact. Both readings give the
    // identical answer on all 26 skill-adapter rows in this repository today,
    // so the choice is not observable here; it is made on §4's own worked
    // example, which names `runner-grants` and `event-delivery`, both
    // `not-provided`.
    expect([...blockingStatuses()]).toEqual(["not-provided"]);
    expect(ceilingFor(["artifact-write", "isolated-worktree"], table).mode).toBe("autonomous");
  });

  test("the ceiling is never `manual`, because §4 offers two and this is the most it permits", () => {
    // §4's phrasing is "exposes the affected skill in guided/manual mode", so a
    // reader could take either as the rule. It is a ceiling and not an
    // assignment: a skill may declare less than it, and `manual` here would
    // silently demote every capped skill past what the contract requires with
    // nothing recording that a choice had been made.
    const reachable = new Set(
      [[], ["repository-read"], ["kb-write"], ["telepathy"], ["kb-write", "telepathy"]].map(
        (requires) => ceilingFor(requires, table).mode,
      ),
    );
    expect([...reachable].sort()).toEqual(["autonomous", "guided"]);
  });
});

/**
 * What an attached adapter adds to the host's table (ruling
 * `fail-closed-adapter-lifts-ceiling`).
 *
 * The supply is handed in rather than read here, so these cases pin the rule
 * itself: `src/packaging/install.ts` owns reading it out of the contracts, and
 * tests/packaging.test.ts measures the two together.
 */
describe("a not-provided capability an attached adapter supplies", () => {
  const table = loadCapabilityTable(
    makeTree(contractWith(`${ROWS}\n| \`runner-grants\` | \`not-provided\` | No grant validator |`)),
  );
  const supply = (attached: string[]): Supply => ({
    attached: new Set(attached),
    suppliers: new Map([["kb-write", ["knowledgebase"]]]),
  });

  test("does not cap the mode when its supplier is attached", () => {
    const ceiling = ceilingFor(["repository-read", "kb-write"], table, supply(["knowledgebase"]));
    expect(ceiling.mode).toBe("autonomous");
    expect(ceiling.blocking).toEqual([]);
    expect(ceiling.detached).toEqual([]);
  });

  test("caps the mode when its supplier is not attached, and names the adapter that would lift it", () => {
    // Kept apart from `blocking` because the two ask different things of the
    // reader: one is fixed in ak.install.yaml, the other only by a contract.
    const ceiling = ceilingFor(["kb-write"], table, supply([]));
    expect(ceiling.mode).toBe("guided");
    expect(ceiling.blocking).toEqual([]);
    expect(ceiling.detached).toEqual([{ capability: "kb-write", adapters: ["knowledgebase"] }]);
  });

  test("lifts only what the attached adapter supplies, so a capability no adapter supplies still blocks", () => {
    const ceiling = ceilingFor(["kb-write", "runner-grants"], table, supply(["knowledgebase"]));
    expect(ceiling.mode).toBe("guided");
    expect(ceiling.blocking).toEqual(["runner-grants"]);
    expect(ceiling.detached).toEqual([]);
  });

  test("never lifts a capability the host's table does not mention", () => {
    // An adapter claiming to supply something §3 has no row for does not make
    // the row exist; the unknown stays unknown and still caps.
    const claims: Supply = { attached: new Set(["knowledgebase"]), suppliers: new Map([["telepathy", ["knowledgebase"]]]) };
    const ceiling = ceilingFor(["telepathy"], table, claims);
    expect(ceiling.unknown).toEqual(["telepathy"]);
    expect(ceiling.mode).toBe("guided");
  });

  describe("an attached supplier whose refusal is borrowed (ruling `tracker-of-record-falls-back-to-kb`)", () => {
    const trackerTable = loadCapabilityTable(
      makeTree(contractWith(`${ROWS}\n| \`tracker-access\` | \`not-provided\` | See the tracker adapter |`)),
    );
    const borrowing = (attached: string[], fallbacks = new Map([["tracker-access", new Map([["tracker", "kb-write"]])]])): Supply => ({
      attached: new Set(attached),
      suppliers: new Map([
        ["kb-write", ["knowledgebase"]],
        ["tracker-access", ["tracker"]],
      ]),
      fallbacks,
    });

    test("lifts where what it borrows is supplied by an attached adapter", () => {
      expect(ceilingFor(["tracker-access"], trackerTable, borrowing(["tracker", "knowledgebase"])).mode).toBe("autonomous");
    });

    test("caps where what it borrows is not, and names what it borrows and who would supply it", () => {
      const ceiling = ceilingFor(["tracker-access"], trackerTable, borrowing(["tracker"]));
      expect(ceiling.mode).toBe("guided");
      expect(ceiling.blocking).toEqual([]);
      expect(ceiling.detached).toEqual([
        { capability: "tracker-access", adapters: ["tracker"], fallsBackOn: { capability: "kb-write", adapters: ["knowledgebase"] } },
      ]);
    });

    test("with no borrowing -- a backend configured -- the attached supplier lifts on its own", () => {
      expect(ceilingFor(["tracker-access"], trackerTable, borrowing(["tracker"], new Map())).mode).toBe("autonomous");
    });

    test("lifts where the host itself provides what is borrowed", () => {
      const hostHasKb = loadCapabilityTable(
        makeTree(
          contractWith(
            `${ROWS.replace(/\| `kb-write` \| `not-provided` \|/, "| `kb-write` | `satisfied` |")}\n| \`tracker-access\` | \`not-provided\` | See the tracker adapter |`,
          ),
        ),
      );
      expect(hostHasKb.status.get("kb-write")).toBe("satisfied");
      expect(ceilingFor(["tracker-access"], hostHasKb, borrowing(["tracker"])).mode).toBe("autonomous");
    });

    test("a cycle of borrowing lifts nothing", () => {
      const cycle: Supply = {
        attached: new Set(["a", "b"]),
        suppliers: new Map([
          ["kb-write", ["a"]],
          ["tracker-access", ["b"]],
        ]),
        fallbacks: new Map([
          ["kb-write", new Map([["a", "tracker-access"]])],
          ["tracker-access", new Map([["b", "kb-write"]])],
        ]),
      };
      expect(ceilingFor(["tracker-access"], trackerTable, cycle).mode).toBe("guided");
    });
  });

  test("the default supply is the host alone, which is today's reading of §3", () => {
    expect(ceilingFor(["kb-write"], table)).toEqual(ceilingFor(["kb-write"], table, HOST_ALONE));
    expect(ceilingFor(["kb-write"], table, HOST_ALONE).blocking).toEqual(["kb-write"]);
  });
});

describe("super-ship's trusted-evidence ceiling", () => {
  const table = loadCapabilityTable(REPO);
  const manifest = loadSkillManifest(REPO, "super-ship");
  const { catalog } = loadCatalog(REPO);
  if (catalog === null) throw new Error("repository has no catalog");
  const defaultInstall = loadInstallConfig(REPO, catalog);
  const hostAlone: Supply = {
    ...defaultInstall.supply,
    attached: new Set(),
  };

  test("the autonomous form is permitted only behind runner-contract's fail-closed supply", () => {
    expect(manifest.requires).toContain("trusted-evidence");
    expect(table.status.get("trusted-evidence")).toBe("not-provided");
    expect(defaultInstall.supply.suppliers.get("trusted-evidence")).toEqual(["runner-contract"]);
    expect(defaultInstall.supply.attached.has("runner-contract")).toBe(true);

    const withRunner = ceilingFor(manifest.requires, table, defaultInstall.supply);
    expect(withRunner.mode).toBe("autonomous");
    expect(withRunner.blocking).toEqual([]);
    expect(withRunner.detached).toEqual([]);

    const withoutRunner = ceilingFor(manifest.requires, table, hostAlone);
    expect(withoutRunner.mode).toBe("guided");
    expect(withoutRunner.blocking).toEqual([]);
    expect(withoutRunner.detached).toContainEqual({
      capability: "trusted-evidence",
      adapters: ["runner-contract"],
    });
  });
});
