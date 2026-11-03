/**
 * Schema contract for the EGM 1b review settings and cold-read record.
 *
 * These cases compile the shipped schemas. They pin: missing review object
 * equals off, off/shadow/on are the only modes, existing review documents stay
 * valid, paraphrase is required only on a covered comprehension lane, and a
 * proposed-absent claim is a valid cold-read record.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { compileSchemas } from "../src/validation/schemas.ts";
import { parseJson, updated, type JsonValue } from "./helpers/json.ts";

const ROOT = join(import.meta.dir, "..");
const HASH = `sha256:${"a".repeat(64)}`;

const set = compileSchemas(ROOT);
const validateProject = set.validatorFor("project");
const validateReview = set.validatorFor("review");
const validateTicket = set.validatorFor("ticket");
const validateColdRead = set.validatorFor("cold-read");
if (
  validateProject === undefined ||
  validateReview === undefined ||
  validateTicket === undefined ||
  validateColdRead === undefined
)
  throw new Error("EGM 1b schemas did not compile");

function example(name: string): JsonValue {
  return parseJson(readFileSync(join(ROOT, "templates", name), "utf8"));
}

function asObject(value: JsonValue): { [key: string]: JsonValue } {
  if (value instanceof Object && !Array.isArray(value)) return value;
  throw new Error("expected an object fixture");
}

const projectExample = asObject(example("project.example.json"));
const reviewExample = asObject(example("review.example.json"));
const ticketExample = asObject(example("ticket.example.json"));
const coldReadExample = asObject(example("cold-read.example.json"));

describe("project.review settings", () => {
  test("a project with no review object validates and is the off default", () => {
    expect("review" in projectExample).toBe(false);
    expect(validateProject(projectExample)).toBe(true);
  });

  test.each(["off", "shadow", "on"] as const)("review.comprehension and review.cold_read accept %s", (mode) => {
    expect(validateProject({ ...projectExample, review: { comprehension: mode, cold_read: mode } })).toBe(true);
  });

  test("an empty review object validates (both keys default off)", () => {
    expect(validateProject({ ...projectExample, review: {} })).toBe(true);
  });

  test("a value outside off|shadow|on is rejected", () => {
    expect(validateProject({ ...projectExample, review: { comprehension: "maybe" } })).toBe(false);
    expect(validateProject({ ...projectExample, review: { cold_read: "blocking" } })).toBe(false);
  });

  test("an unknown key on review is rejected", () => {
    expect(validateProject({ ...projectExample, review: { extra: "off" } })).toBe(false);
  });
});

describe("review comprehension paraphrase", () => {
  test("the shipped review example stays valid without a comprehension lane", () => {
    expect(validateReview(reviewExample)).toBe(true);
  });

  test("a covered comprehension lane requires paraphrase.proposes, existing_system and raw_output", () => {
    const lanes = reviewExample["lanes"];
    if (!Array.isArray(lanes)) throw new Error("review example has no lanes");
    const without = {
      ...reviewExample,
      lanes: [
        ...lanes,
        {
          role: "doc-review/comprehension",
          required: true,
          tier: "always-on",
          state: "covered",
          seat: { filled_by: "doc-review/comprehension", independent_of_author: true },
          verdict: "approve",
          raw_output: { id: "raw-comprehension", hash: HASH },
        },
      ],
    };
    expect(validateReview(without)).toBe(false);

    const withParaphrase = updated(without, ["lanes", lanes.length, "paraphrase"], () => ({
      proposes: "The loader reads every configured directory.",
      existing_system: "The loader reads only the first configured directory.",
    }));
    expect(validateReview(withParaphrase)).toBe(true);
  });

  test("a skipped lane without raw_output stays valid", () => {
    expect(
      Array.isArray(reviewExample["lanes"]) &&
        reviewExample["lanes"].some(
          (lane) =>
            lane instanceof Object &&
            !Array.isArray(lane) &&
            lane["state"] === "skipped" &&
            lane["raw_output"] === undefined,
        ),
    ).toBe(true);
    expect(validateReview(reviewExample)).toBe(true);
  });
});

describe("ticket.cold_read_ref", () => {
  test("the shipped implementation ticket stays valid without cold_read_ref", () => {
    expect("cold_read_ref" in ticketExample).toBe(false);
    expect(validateTicket(ticketExample)).toBe(true);
  });

  test("cold_read_ref is accepted when it names a cold-read artifact", () => {
    expect(
      validateTicket({
        ...ticketExample,
        cold_read_ref: { id: "example-cold-read-1", schema: "cold-read", hash: HASH },
      }),
    ).toBe(true);
  });

  test("cold_read_ref that names another schema is rejected", () => {
    expect(
      validateTicket({
        ...ticketExample,
        cold_read_ref: { id: "example-review-1", schema: "review", hash: HASH },
      }),
    ).toBe(false);
  });

  test("cold_read_ref without schema is rejected", () => {
    expect(
      validateTicket({
        ...ticketExample,
        cold_read_ref: { id: "example-cold-read-1", hash: HASH },
      }),
    ).toBe(false);
  });
});

describe("cold-read schema", () => {
  test("the shipped example validates, including a proposed-absent claim", () => {
    expect(validateColdRead(coldReadExample)).toBe(true);
    const claims = coldReadExample["claims"];
    expect(
      Array.isArray(claims) &&
        claims.some(
          (claim) =>
            claim instanceof Object &&
            !Array.isArray(claim) &&
            claim["kind"] === "proposed" &&
            claim["observed"] === "absent",
        ),
    ).toBe(true);
  });

  test("a covered read without paraphrase is rejected", () => {
    expect(validateColdRead(updated(coldReadExample, ["paraphrase"], () => undefined))).toBe(false);
  });

  test("an unavailable read requires a reason and does not require paraphrase", () => {
    const unavailable = updated(
      updated(coldReadExample, ["state"], () => "unavailable"),
      ["status"],
      () => "unavailable",
    );
    const withReason = updated(unavailable, ["reason"], () => "The host could not start a separate reader context.");
    expect(validateColdRead(withReason)).toBe(true);
    const withoutParaphrase = updated(withReason, ["paraphrase"], () => undefined);
    expect(validateColdRead(withoutParaphrase)).toBe(true);
    expect(validateColdRead(updated(withoutParaphrase, ["reason"], () => undefined))).toBe(false);
  });

  test("status complete requires state covered", () => {
    const completeUnavailable = updated(
      updated(
        updated(coldReadExample, ["state"], () => "unavailable"),
        ["status"],
        () => "complete",
      ),
      ["reason"],
      () => "The host could not start a separate reader context.",
    );
    expect(validateColdRead(completeUnavailable)).toBe(false);
  });

  test.each(["complete", "draft"] as const)("state unavailable with status %s is rejected", (status) => {
    const mismatched = updated(
      updated(
        updated(coldReadExample, ["state"], () => "unavailable"),
        ["status"],
        () => status,
      ),
      ["reason"],
      () => "The host could not start a separate reader context.",
    );
    expect(validateColdRead(mismatched)).toBe(false);
  });

  test("status unavailable requires state unavailable", () => {
    expect(validateColdRead(updated(coldReadExample, ["status"], () => "unavailable"))).toBe(false);
  });

  test("status draft with state covered remains valid", () => {
    expect(validateColdRead(updated(coldReadExample, ["status"], () => "draft"))).toBe(true);
  });
});
