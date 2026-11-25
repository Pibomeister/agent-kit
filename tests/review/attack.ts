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
] as const;

function main(): number {
  console.log("did not land");
  for (const [attack, reason] of DID_NOT_LAND) console.log(`  ${attack}: ${reason}`);
  const filter = FILTERS.join("|");
  const run = spawnSync("bun", ["test", "tests/review/scope-git.test.ts", "-t", filter], {
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
