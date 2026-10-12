import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import catalogSchema from "../schemas/catalog.schema.json" with { type: "json" };
import commonSchema from "../schemas/common.schema.json" with { type: "json" };
import { ARTIFACT_SCHEMA_IDS, checkRunArtifact } from "../src/kb/artifacts.ts";
import { edited, parseJson, updated, type JsonValue } from "./helpers/json.ts";

/**
 * The two record kinds a work trail leaves: `trail`, one stretch of an
 * implementer's working decisions, and `trail-audit`, the auditor's comparison
 * of the trail with what the run left behind. Every case sends a shipped
 * example under templates/, or that example with one thing changed, through
 * `checkRunArtifact`, the check a knowledgebase publish runs before any write.
 *
 * A refusal must come from the kind's own schema. `checkRunArtifact` also
 * refuses a kind it does not know, so a case that asked only for a non-empty
 * problem would pass before either schema existed. Each refusal therefore
 * checks that the unchanged example passes, and that the problem names the
 * kind's schema file.
 */

const REPO = resolve(import.meta.dir, "..");

const TRAIL = "trail.example.json";
const TRAIL_EMPTY = "trail.empty.example.json";
const AUDIT_ITEMS = "trail-audit.example.json";
const AUDIT_NOTHING = "trail-audit.nothing-to-flag.example.json";
const AUDIT_NO_MATERIAL = "trail-audit.no-material.example.json";

const TRAIL_REFUSED = "does not match schemas/trail.schema.json: ";
const AUDIT_REFUSED = "does not match schemas/trail-audit.schema.json: ";

/** A shipped example, typed. Read inside each test, so a missing file fails that test alone. */
function example(name: string): JsonValue {
  return parseJson(readFileSync(join(REPO, "templates", name), "utf8"));
}

/** Why `checkRunArtifact` refuses the document; empty when it accepts it. */
function problemOf(doc: JsonValue): string {
  return checkRunArtifact(JSON.stringify(doc)).problem;
}

/** The problem for the example `name` after `change`. The unchanged example must pass first. */
function refusal(name: string, change: (doc: JsonValue) => JsonValue): string {
  const doc = example(name);
  expect(problemOf(doc)).toBe("");
  return problemOf(change(doc));
}

/** The member `key` of an object, or undefined for anything else. */
function member(value: JsonValue | undefined, key: string): JsonValue | undefined {
  return value instanceof Object && !Array.isArray(value) ? value[key] : undefined;
}

/** The array member `key` of an object, or an empty list for anything else. */
function listAt(value: JsonValue | undefined, key: string): JsonValue[] {
  const found = member(value, key);
  return Array.isArray(found) ? found : [];
}

describe("AC-7: the three closed lists of record kinds name trail and trail-audit", () => {
  test.each(["trail", "trail-audit"])("%s is a schema_id, a catalog schema id and an ARTIFACT_SCHEMAS kind", (kind) => {
    expect(commonSchema.$defs.schema_id.enum).toContain(kind);
    expect(catalogSchema.properties.schemas.items.properties.id.enum).toContain(kind);
    expect(ARTIFACT_SCHEMA_IDS).toContain(kind);
  });
});

describe("the five examples (AC-7, AC-8, AC-10, AC-11)", () => {
  test.each([TRAIL, TRAIL_EMPTY, AUDIT_ITEMS, AUDIT_NOTHING, AUDIT_NO_MATERIAL])(
    "%s passes checkRunArtifact with an empty problem",
    (name) => {
      const check = checkRunArtifact(readFileSync(join(REPO, "templates", name), "utf8"));
      expect(check.problem).toBe("");
      expect(check.artifact?.schema).toBe(name.startsWith("trail-audit.") ? "trail-audit" : "trail");
    },
  );

  test("the trail example has at least two entries, and one supersedes an earlier one", () => {
    const entries = listAt(example(TRAIL), "entries");
    expect(entries.length).toBeGreaterThanOrEqual(2);
    const earlierIds = (index: number) => entries.slice(0, index).map((entry) => member(entry, "id"));
    const superseding = entries.filter((entry, index) => {
      const target = member(entry, "supersedes");
      return target !== undefined && earlierIds(index).includes(target);
    });
    expect(superseding.length).toBeGreaterThan(0);
  });

  test("the empty trail example has no entries and states why", () => {
    const doc = example(TRAIL_EMPTY);
    expect(member(doc, "entries")).toEqual([]);
    expect(member(doc, "empty_reason")).toBeString();
  });

  test.each(
    Object.entries({
      [AUDIT_ITEMS]: "items-to-look-at",
      [AUDIT_NOTHING]: "nothing-to-flag",
      [AUDIT_NO_MATERIAL]: "no-material-to-assess",
    }),
  )("%s records the result %s", (name, result) => {
    expect(member(example(name), "result")).toBe(result);
  });
});

describe("AC-8: what a trail entry may hold", () => {
  test("what else was considered and the pointers may both be empty lists", () => {
    const doc = updated(
      updated(example(TRAIL), ["entries", 0, "alternatives"], () => []),
      ["entries", 0, "pointers"],
      () => [],
    );
    expect(problemOf(doc)).toBe("");
  });

  test("the shape never resolves a pointer, so one that names anything else passes it", () => {
    const pointers = ["../outside-the-repository/notes.md", "a sentence that names no file, commit or receipt"];
    expect(problemOf(updated(example(TRAIL), ["entries", 0, "pointers"], () => pointers))).toBe("");
  });
});

describe("AC-9: a trail record is valid with entries, or with none and a reason, and in no other case", () => {
  test("a trail with entries passes, and so does one with none and a reason", () => {
    expect(problemOf(example(TRAIL))).toBe("");
    expect(problemOf(example(TRAIL_EMPTY))).toBe("");
  });

  test("no entries and no reason is refused", () => {
    expect(refusal(TRAIL_EMPTY, (doc) => edited(doc, ["empty_reason"], "delete"))).toStartWith(TRAIL_REFUSED);
  });

  test("an entry missing what was decided is refused", () => {
    expect(refusal(TRAIL, (doc) => edited(doc, ["entries", 0, "decision"], "delete"))).toStartWith(TRAIL_REFUSED);
  });

  test("an entry missing why is refused", () => {
    expect(refusal(TRAIL, (doc) => edited(doc, ["entries", 0, "why"], "delete"))).toStartWith(TRAIL_REFUSED);
  });

  test("an entry missing the result is refused", () => {
    expect(refusal(TRAIL, (doc) => edited(doc, ["entries", 0, "result"], "delete"))).toStartWith(TRAIL_REFUSED);
  });

  test("an unknown member is refused, and a phase is one", () => {
    expect(refusal(TRAIL, (doc) => updated(doc, ["phase"], () => "build"))).toStartWith(TRAIL_REFUSED);
  });

  test("a status outside the kind's own list is refused", () => {
    expect(refusal(TRAIL, (doc) => updated(doc, ["status"], () => "draft"))).toStartWith(TRAIL_REFUSED);
  });
});

describe("AC-12: one valid fixture per audit result, and each listed refusal", () => {
  test.each([AUDIT_ITEMS, AUDIT_NOTHING, AUDIT_NO_MATERIAL])("the valid fixture %s passes", (name) => {
    expect(problemOf(example(name))).toBe("");
  });

  test("1. items to look at with an empty list is refused", () => {
    expect(refusal(AUDIT_ITEMS, (doc) => edited(doc, ["attention_list"], "empty"))).toStartWith(AUDIT_REFUSED);
  });

  test("2. nothing to flag with items is refused", () => {
    const items = listAt(example(AUDIT_ITEMS), "attention_list");
    expect(items.length).toBeGreaterThan(0);
    expect(refusal(AUDIT_NOTHING, (doc) => updated(doc, ["attention_list"], () => items))).toStartWith(AUDIT_REFUSED);
  });

  test("3. no material to assess with items is refused", () => {
    const items = listAt(example(AUDIT_ITEMS), "attention_list");
    expect(items.length).toBeGreaterThan(0);
    expect(refusal(AUDIT_NO_MATERIAL, (doc) => updated(doc, ["attention_list"], () => items))).toStartWith(
      AUDIT_REFUSED,
    );
  });

  test("4. no material to assess without a reason is refused", () => {
    expect(refusal(AUDIT_NO_MATERIAL, (doc) => edited(doc, ["no_material_reason"], "delete"))).toStartWith(
      AUDIT_REFUSED,
    );
  });

  test("5. a missing audited revision is refused, null or absent", () => {
    expect(refusal(AUDIT_ITEMS, (doc) => edited(doc, ["source_revision"], "null"))).toStartWith(AUDIT_REFUSED);
    expect(refusal(AUDIT_ITEMS, (doc) => edited(doc, ["source_revision"], "delete"))).toStartWith(AUDIT_REFUSED);
  });

  test("6. an item without a reason is refused", () => {
    expect(refusal(AUDIT_ITEMS, (doc) => edited(doc, ["attention_list", 0, "reason"], "delete"))).toStartWith(
      AUDIT_REFUSED,
    );
  });

  test("7. an item whose comparison is not one of the four is refused", () => {
    expect(
      refusal(AUDIT_ITEMS, (doc) => updated(doc, ["attention_list", 0, "comparison"], () => "looks-risky")),
    ).toStartWith(AUDIT_REFUSED);
  });

  test("8. runner-attested with no attestation is refused", () => {
    expect(member(member(example(AUDIT_NOTHING), "auditor_seat"), "isolation")).toBe("runner-attested");
    expect(refusal(AUDIT_NOTHING, (doc) => edited(doc, ["auditor_seat", "attestation"], "null"))).toStartWith(
      AUDIT_REFUSED,
    );
  });

  test("9. host-unattested with an attestation is refused", () => {
    const attestation = { id: "example-seat-attestation-1", hash: `sha256:${"e".repeat(64)}` };
    expect(member(member(example(AUDIT_ITEMS), "auditor_seat"), "isolation")).toBe("host-unattested");
    expect(refusal(AUDIT_ITEMS, (doc) => updated(doc, ["auditor_seat", "attestation"], () => attestation))).toStartWith(
      AUDIT_REFUSED,
    );
  });

  test("10. a published stretch with no hash is refused", () => {
    expect(
      refusal(AUDIT_ITEMS, (doc) =>
        edited(
          updated(doc, ["stretches", 0, "state"], () => "published"),
          ["stretches", 0, "content_hash"],
          "delete",
        ),
      ),
    ).toStartWith(AUDIT_REFUSED);
  });

  test("11. a missing stretch with a hash is refused", () => {
    expect(member(listAt(example(AUDIT_ITEMS), "stretches")[0], "content_hash")).toBeString();
    expect(refusal(AUDIT_ITEMS, (doc) => updated(doc, ["stretches", 0, "state"], () => "missing"))).toStartWith(
      AUDIT_REFUSED,
    );
  });

  test("12. any other statement about a transcript is refused", () => {
    for (const statement of ["supplied", "agent-transcripts/example-run-1.jsonl"]) {
      expect(refusal(AUDIT_ITEMS, (doc) => updated(doc, ["transcript"], () => statement))).toStartWith(AUDIT_REFUSED);
    }
  });
});
