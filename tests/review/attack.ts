/**
 * Named attack and honest-flow probes for review-convergence T4.
 *
 * The cases live in `scope-git.test.ts`. This file re-runs them by name.
 *
 *   bun tests/review/attack.ts
 */
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../..");

const FILTERS = [
  "BETWEEN-scope",
  "BETWEEN-forge",
  "BETWEEN-edited-previous",
  "BETWEEN-update-ref",
  "FORGE-carry-base-equals-dirty-head",
  "MB-force-pushed-base-branch",
  "FU-replace-decide",
  "FU-decide-dirty-head-after-forged-carry",
  "RC-LAUNDER-SIBLING-BASE",
  "RC-LAUNDER-MAIN-ABSORB",
  "RC-OURS-MERGE-HIDES-DIRTY-HISTORY",
  "RC-COMMIT-TREE-TWO-PARENT-MIX",
  "MERGE-ONLY-DIRTY-DISTINCT-OURS",
  "MERGE-ONLY-DIRTY-EMPTY-SIDE-OURS",
  "EMPTY-FILE-ADD",
  "MERGE-ONLY-EMPTY-FILE-DISTINCT",
  "NATURAL-DIRTY-MERGE-THEN-OURS-BACK",
  "RC-OURS-MERGE-EMPTY-FILE-ON-MAIN",
  "GITMODULES-IGNORE-ALL-ADD",
  "R7-HIDE-UNDER-VISIBLE",
  "R8-DIRTY-MV",
  "R8-DIRTY-RENAME-RESTORE",
  "R8-DIRTY-KEPT",
  "R8-DIRTY-GITLINK-OURS",
  "UNRELATED-OURS-MERGE",
  "UNRELATED-BASE",
  "MERGE-TREE-SPAWN-FAIL",
  "MOVE-HUNK",
  "RC-COMMITGRAPH-ARGV",
  "an empty commit after review carries",
  "RC-OCTOPUS-SAME-TREE",
  "RC-X-OURS-EMPTY-NEW-SCOPE",
  "RC-MERGE-DRIVER-HIDES-CONFLICT",
  "RC-PATH-GIT-WRAPPER",
  "RC-GIT-DIR-CLASS",
  "says the whole change is reviewed",
  "a merge of the base branch with no conflict",
  "the last round of the cap is a closure",
  "a rebase that leaves the patches unchanged",
  "a three-parent merge that mixed",
  "a criss-cross merge still exits 0",
] as const;

/** Attacks that already fail closed. The product does not add a further guard. */
const DID_NOT_LAND = [
  ["git replace of the dirty head onto the reviewed head", "FU-replace-decide still exits 2"],
  ["GIT_GRAFT_FILE grafting the reviewed tree", "isolatedGitEnv sets GIT_GRAFT_FILE=/dev/null"],
  ["carry JSON with no --previous", "ledger add requires the last reviewed scope record"],
  ["decide after a refused carry", "verdict is incomplete"],
  [
    "a blob that arrives only through main",
    "RC-LAUNDER-MAIN-ABSORB still carries. The base branch must sit outside author write",
  ],
] as const;

function main(): number {
  console.log("did not land");
  for (const [attack, reason] of DID_NOT_LAND) console.log(`  ${attack}: ${reason}`);
  const filter = FILTERS.join("|");
  const run = spawnSync("bun", ["test", "tests/review/scope-git.test.ts", "-t", filter, "--timeout=30000"], {
    cwd: ROOT,
    stdio: "inherit",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
  });
  if (run.error !== undefined) {
    console.error(run.error.message);
    return 1;
  }
  return run.status ?? 1;
}

if (import.meta.main) process.exit(main());
