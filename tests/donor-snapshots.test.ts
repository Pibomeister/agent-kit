import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { SNAPSHOT_ROOT, expectedSnapshots, pinnedBytes, snapshotFile } from "../src/validation/donor-snapshots.ts";

const ROOT = join(import.meta.dir, "..");
const expected = expectedSnapshots(ROOT);

describe("donor snapshots", () => {
  test("the path is keyed by donor and a 12-character pin", () => {
    expect(snapshotFile("addy", "c004a74784a08295d52749b04cda634125b9a581", "skills/x/SKILL.md")).toBe(
      `${SNAPSHOT_ROOT}/addy@c004a74784a0/skills/x/SKILL.md`,
    );
  });

  test("the fragments cite at least one donor file", () => {
    expect(expected.length).toBeGreaterThan(0);
  });

  test("every donor file a fragment row cites has a committed snapshot", () => {
    const missing = expected.filter((s) => !existsSync(join(ROOT, s.file))).map((s) => s.file);
    // Run research/probes/snapshot-donors.sh with the donors cloned to write them.
    expect(missing).toEqual([]);
  });

  // The byte comparison needs the clones, which are gitignored. Without them the
  // existence check above still holds the set to the fragments; only the
  // content half goes unverified, the same scope `provenance.donors-unavailable`
  // reports for the validator's own path check. CI clones them
  // (tools/donors/clone.sh) and sets AK_REQUIRE_DONORS=1, where a missing clone
  // is a failure rather than a skip: a skip there is the content check never running.
  const donorsRequired = process.env.AK_REQUIRE_DONORS === "1";
  // Present means at least one cited donor is cloned: an empty or unrelated .donors/ compares nothing.
  const donorsPresent = expected.some((snap) => snap.clone !== null && existsSync(join(ROOT, snap.clone)));
  test.if(donorsPresent || donorsRequired)("every snapshot is byte-identical to its pin", () => {
    expect(donorsPresent ? [] : ["no cited donor is cloned under .donors/; run tools/donors/clone.sh"]).toEqual([]);
    let compared = 0;
    const drifted: string[] = [];
    const unresolved: string[] = [];
    for (const snap of expected) {
      const pinned = pinnedBytes(ROOT, snap);
      if (pinned === null) {
        const cloned = snap.clone !== null && existsSync(join(ROOT, snap.clone));
        if (cloned || donorsRequired) unresolved.push(snap.file);
        continue;
      }
      const path = join(ROOT, snap.file);
      compared += 1;
      if (existsSync(path) && !readFileSync(path).equals(pinned)) drifted.push(snap.file);
    }
    expect(drifted).toEqual([]);
    expect(unresolved).toEqual([]);
    expect(compared).toBeGreaterThan(0);
  });
});
