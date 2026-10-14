import { beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  SNAPSHOT_ROOT,
  expectedSnapshots,
  snapshotFile,
  type ExpectedSnapshot,
} from "../src/validation/donor-snapshots.ts";

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
  const pinnedFiles = new Map<string, Buffer>();
  beforeAll(() => {
    if (!donorsPresent && !donorsRequired) return;
    // One Git process per clone, rather than one per file. Read the pinned objects,
    // not the checkout, and use byte lengths so embedded newlines stay intact.
    const groups = new Map<string, ExpectedSnapshot[]>();
    for (const snap of expected) {
      if (snap.clone === null) continue;
      const rows = groups.get(snap.clone) ?? [];
      rows.push(snap);
      groups.set(snap.clone, rows);
    }
    for (const [clone, rows] of groups) {
      const result = spawnSync("git", ["-C", join(ROOT, clone), "cat-file", "--batch"], {
        input: `${rows.map((s) => `${s.commit}:${s.donorPath}`).join("\n")}\n`,
        maxBuffer: 64 * 1024 * 1024,
      });
      if (result.status !== 0) continue;
      let offset = 0;
      for (const snap of rows) {
        const end = result.stdout.indexOf(10, offset);
        if (end < 0) throw new Error(`missing cat-file header for ${snap.file}`);
        const header = result.stdout.toString("utf8", offset, end);
        offset = end + 1;
        if (header.endsWith(" missing")) continue;
        const sizeText = /^[0-9a-f]+ blob (\d+)$/.exec(header)?.[1];
        if (sizeText === undefined) throw new Error(`not a pinned blob: ${snap.file}`);
        const size = Number(sizeText);
        if (result.stdout[offset + size] !== 10) throw new Error(`incomplete pinned blob: ${snap.file}`);
        pinnedFiles.set(snap.file, result.stdout.subarray(offset, offset + size));
        offset += size + 1;
      }
    }
  });
  test.if(donorsPresent || donorsRequired)("every snapshot is byte-identical to its pin", () => {
    expect(donorsPresent ? [] : ["no cited donor is cloned under .donors/; run tools/donors/clone.sh"]).toEqual([]);
    let compared = 0;
    const drifted: string[] = [];
    const unresolved: string[] = [];
    for (const snap of expected) {
      const pinned = pinnedFiles.get(snap.file) ?? null;
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
