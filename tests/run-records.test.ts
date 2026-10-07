import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { parse } from "yaml";

import { compileSchemas } from "../src/validation/schemas.ts";
import { edited, parseJson, updated, type JsonValue, type Path } from "./helpers/json.ts";

/**
 * The run records that ADR-0001 §3 assigned without a schema: the handoff
 * record, the evaluation record `bakeoff` and `prototype` share, the `wayfind`
 * map, and later the plan record, ship evidence and run ledger. Without an id in
 * `common#/$defs/schema_id` none of them could pass `publishArtifact`, which
 * refuses an artifact that fails its own schema before any write, so a skill
 * that published one could never reach `complete`. Each case below is a
 * shipped example under templates/ plus the one thing under test, exercised
 * against the shipped schema rather than a synthetic stand-in, so a rejection
 * names the branch and not the fixture.
 *
 * The last block holds the lists that must name the same ids: the enum, the
 * catalog and the schema files themselves. That disagreement is how the defect
 * stayed invisible.
 */

const REPO = resolve(import.meta.dir, "..");
const schemas = compileSchemas(REPO);

function example(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(REPO, "templates", name), "utf8"));
}

function validatorFor(id: string) {
  const validate = schemas.validatorFor(id);
  if (validate === undefined) throw new Error(`no compiled validator for '${id}'`);
  return validate;
}

describe("the map", () => {
  const validate = validatorFor("map");
  const base = example("map.example.json");

  test("the shipped example is valid", () => {
    expect(validate(base)).toBe(true);
  });

  test("a map missing one of its five sections is refused", () => {
    const { not_yet_specified: _, ...rest } = base;
    expect(validate(rest)).toBe(false);
  });

  test("ruling work out of scope without a reason is refused", () => {
    expect(validate({ ...base, out_of_scope: [{ gist: "Replacing the cache for rate limiting." }] })).toBe(false);
  });

  test("a complete map with fog left in Not yet specified is refused", () => {
    expect(validate({ ...base, status: "complete" })).toBe(false);
    expect(validate({ ...base, status: "complete", not_yet_specified: [] })).toBe(true);
  });
});

describe("the handoff record", () => {
  const validate = validatorFor("handoff-record");
  const base = example("handoff-record.example.json");

  test("the shipped example is valid", () => {
    expect(validate(base)).toBe(true);
  });

  test("a decision without its source marked is refused", () => {
    expect(validate({ ...base, decisions: [{ text: "Keep the public signature unchanged." }] })).toBe(false);
  });

  test("evidence not re-verified at the anchor carries a stale marker", () => {
    const unmarked = { claim: "The integration suite was green yesterday.", kind: "statement", reverified: false };
    expect(validate({ ...base, evidence: [unmarked] })).toBe(false);
  });

  test("re-verified evidence is not marked stale", () => {
    const marked = {
      claim: "The loader suite passed.",
      kind: "statement",
      reverified: true,
      stale: { bound_to: "yesterday" },
    };
    expect(validate({ ...base, evidence: [marked] })).toBe(false);
  });

  test("a statement that tests passed is not a receipt", () => {
    const receipt = { id: "example-verification-1", schema: "verification", hash: `sha256:${"7".repeat(64)}` };
    expect(validate({ ...base, evidence: [{ claim: "Green.", kind: "statement", receipt, reverified: true }] })).toBe(
      false,
    );
    expect(validate({ ...base, evidence: [{ claim: "Green.", kind: "receipt", reverified: true }] })).toBe(false);
  });

  test("a readable anchor names a revision", () => {
    expect(validate({ ...base, source_revision: null })).toBe(false);
  });

  test("an unreadable anchor makes every reference machine-local", () => {
    const anchor = { readable: false, reason: "The repository could not be read." };
    expect(validate({ ...base, anchor })).toBe(false);
    const references = [{ what: "The scratch notes.", machine_local: "/tmp/notes.md" }];
    expect(validate({ ...base, anchor, references })).toBe(true);
  });

  test("a heading with nothing under it is left out, not written empty", () => {
    expect(validate({ ...base, failed_approaches: [] })).toBe(false);
  });
});

describe("the evaluation record", () => {
  const validate = validatorFor("evaluation");
  const bakeoff = example("evaluation.bakeoff.example.json");
  const prototype = example("evaluation.prototype.example.json");
  const judge = bakeoff.judge as Record<string, unknown>;

  test("the shipped bake-off and prototype examples are valid", () => {
    expect(validate(bakeoff)).toBe(true);
    expect(validate(prototype)).toBe(true);
  });

  test("a bake-off whose judge could not attest independence is not selected or unresolved", () => {
    for (const independence of [false, "unverified"]) {
      expect(validate({ ...bakeoff, judge: { ...judge, independence } })).toBe(false);
      expect(validate({ ...bakeoff, status: "unresolved", judge: { ...judge, independence } })).toBe(false);
      expect(validate({ ...bakeoff, status: "incomplete", judge: { ...judge, independence } })).toBe(true);
    }
  });

  test("a Blocked judgment leaves the outcome unresolved", () => {
    const { position: _, ...rest } = judge;
    const blocked = {
      ...rest,
      blocked: { floor: "insufficient-project-grounding", needed: ["Name the incumbent parser."] },
    };
    expect(validate({ ...bakeoff, judge: blocked })).toBe(false);
    expect(validate({ ...bakeoff, status: "unresolved", judge: blocked })).toBe(true);
  });

  test("a judge returns a position or a Blocked result, not both", () => {
    const both = { ...judge, blocked: { floor: "external-evidence-unavailable", needed: ["A benchmark."] } };
    expect(validate({ ...bakeoff, status: "unresolved", judge: both })).toBe(false);
  });

  test("selected shows its counterexample check", () => {
    const { counterexample: _, ...rest } = bakeoff;
    expect(validate(rest)).toBe(false);
  });

  test("selected leaves no decision-critical premise without evidence", () => {
    expect(validate({ ...bakeoff, premises: [{ premise: "The parser exposes key positions.", evidence: [] }] })).toBe(
      false,
    );
  });

  test("a human-experience question is evaluated by a named human", () => {
    const evaluator = { kind: "automated-criteria", criteria: ["The failing service is found in under ten seconds."] };
    expect(validate({ ...prototype, evaluator })).toBe(false);
  });

  test("a human-experience question is never settled by an automated verdict", () => {
    expect(validate({ ...prototype, settled_by: "automated-criteria" })).toBe(false);
  });

  test("a technical question settled by its criteria shows their results", () => {
    const technical = {
      ...prototype,
      question_kind: "technical",
      evaluator: { kind: "automated-criteria", criteria: ["Every awkward transition is handled."] },
      settled_by: "automated-criteria",
    };
    expect(validate(technical)).toBe(false);
    expect(validate({ ...technical, acceptance_results: [{ ref: "example-verification-3", kind: "receipt" }] })).toBe(
      true,
    );
  });

  test("a prototype stopped without a human records why and claims no settlement", () => {
    const { settled_by: _, choice: __, answer: ___, ...rest } = prototype;
    const stop = { reason: "no-human-present", learned: "Nothing yet; no evaluator was present." };
    expect(validate({ ...rest, status: "stopped" })).toBe(false);
    expect(validate({ ...rest, status: "stopped", stop })).toBe(true);
    expect(validate({ ...rest, status: "stopped", stop, settled_by: "human" })).toBe(false);
  });

  test("each kind's members are refused on the other", () => {
    expect(validate({ ...prototype, judge })).toBe(false);
    expect(validate({ ...bakeoff, question: "Which layout reads best?" })).toBe(false);
    expect(validate({ ...prototype, status: "selected" })).toBe(false);
  });
});

// The three records ADR-0001 §3 assigned to super-bound, super-ship and
// autopilot, in the same form: the shipped example, then each branch the
// skill's body states, refused on the example with one thing changed.

describe("the plan record", () => {
  const validate = validatorFor("plan-record");
  const base = example("plan-record.example.json");
  const spec = base.specification as Record<string, unknown>;

  test("the shipped example is valid", () => {
    expect(validate(base)).toBe(true);
  });

  test("a specification missing one of its sections is refused", () => {
    const { non_goals: _, ...rest } = spec;
    expect(validate({ ...base, specification: rest })).toBe(false);
    expect(validate({ ...base, specification: { ...spec, non_goals: [] } })).toBe(true);
  });

  test("a specification with no test seam, or a seam without its reason, is refused", () => {
    expect(validate({ ...base, specification: { ...spec, test_seams: [] } })).toBe(false);
    expect(validate({ ...base, specification: { ...spec, test_seams: [{ seam: "The load function." }] } })).toBe(false);
  });

  test("a plan with no slices is refused", () => {
    expect(validate({ ...base, slices: [] })).toBe(false);
  });

  test("the approval's binding, the specification's own hash, is required", () => {
    const { specification_hash: _, ...unbound } = base;
    expect(validate(unbound)).toBe(false);
  });

  test("a published plan carries the specification approval; a draft may await it", () => {
    const { specification_approval: _, ...unapproved } = base;
    expect(validate(unapproved)).toBe(false);
    expect(validate({ ...unapproved, status: "draft" })).toBe(true);
  });

  test("a specification with no acceptance criterion is refused", () => {
    expect(validate({ ...base, specification: { ...spec, acceptance_criteria: [] } })).toBe(false);
  });

  test("a slice is an implementation or a decision, nothing else", () => {
    const slices = base.slices as Array<Record<string, unknown>>;
    expect(validate({ ...base, slices: [{ ...slices[0], type: "decision" }] })).toBe(true);
    expect(validate({ ...base, slices: [{ ...slices[0], type: "epic" }] })).toBe(false);
  });

  test("the bound.run draft and the published record are the only states", () => {
    expect(validate({ ...base, status: "draft" })).toBe(true);
    expect(validate({ ...base, status: "approved" })).toBe(false);
  });
});

describe("the ship evidence", () => {
  const validate = validatorFor("ship-evidence");
  const base = example("ship-evidence.example.json");
  const effects = base.effects as Array<Record<string, unknown>>;
  const preflight = base.preflight as Array<Record<string, unknown>>;

  test("the shipped example is valid", () => {
    expect(validate(base)).toBe(true);
  });

  test("a dry run records no remote effect", () => {
    const { effects: _, ...dry } = base;
    expect(validate({ ...dry, mode: "dry-run" })).toBe(true);
    expect(validate({ ...base, mode: "dry-run" })).toBe(false);
  });

  test("a remote effect without its idempotency key is refused", () => {
    const { idempotency_key: _, ...keyless } = effects[0]!;
    expect(validate({ ...base, effects: [keyless, effects[1]] })).toBe(false);
  });

  test("a complete publish records both the push and the pull request", () => {
    expect(validate({ ...base, effects: [effects[0]] })).toBe(false);
  });

  test("a complete ship's pre-flight holds the sensitive-data scan", () => {
    expect(validate({ ...base, preflight: preflight.filter((c) => c.check !== "sensitive-data-scan") })).toBe(false);
  });

  test("a check that did not run says why", () => {
    const silent = { check: "dependency-audit", outcome: "not-run" };
    expect(validate({ ...base, preflight: [preflight[0], silent] })).toBe(false);
  });

  test("a stopped ship names what it needs", () => {
    const { payload: _, preflight: __, effects: ___, ...bare } = base;
    expect(validate({ ...bare, status: "needs-input" })).toBe(false);
    expect(validate({ ...bare, status: "needs-input", reason: "No review verdict binds to this head." })).toBe(true);
  });

  test("only a ship stopped for input may leave its head unnamed", () => {
    const { payload: _, preflight: __, effects: ___, ...bare } = base;
    const reason = "The head to ship is not named.";
    expect(validate({ ...bare, source_revision: null, status: "needs-input", reason })).toBe(true);
    expect(validate({ ...bare, source_revision: null, status: "failed", reason })).toBe(false);
    expect(validate({ ...base, source_revision: null })).toBe(false);
  });

  test("a release check names the check it ran", () => {
    const { name: _, ...unnamed } = preflight[2]!;
    expect(validate({ ...base, preflight: [preflight[0], preflight[1], unnamed] })).toBe(false);
  });

  test("a remote effect without its read-back is refused", () => {
    const { read_back: _, ...unread } = effects[0]!;
    expect(validate({ ...base, effects: [unread, effects[1]] })).toBe(false);
  });

  test("a merge is not an effect this record admits", () => {
    expect(validate({ ...base, effects: [...effects, { ...effects[1], effect: "merge" }] })).toBe(false);
  });
});

describe("the run ledger", () => {
  const validate = validatorFor("run-ledger");
  const base = example("run-ledger.example.json");
  const entries = base.entries as Array<Record<string, unknown>>;
  const open = (id: string) => ({
    checkpoint: "finding-adjudication",
    decision: { id, schema: "decision", hash: `sha256:${"9".repeat(64)}` },
    outcome: "escalation",
    answered: false,
  });

  test("the shipped example is valid", () => {
    expect(validate(base)).toBe(true);
  });

  test("one open escalation is admitted and a second is refused", () => {
    expect(validate({ ...base, entries: [...entries, open("example-decision-3")] })).toBe(true);
    expect(validate({ ...base, entries: [...entries, open("example-decision-3"), open("example-decision-4")] })).toBe(
      false,
    );
  });

  test("a ruling reads what, why and what it costs if wrong", () => {
    const ruling = { what: "Approve.", why: "Both seats agreed and the charter lists it." };
    expect(validate({ ...base, entries: [{ ...entries[0], ruling }] })).toBe(false);
  });

  test("an answer is carried only by an answered escalation", () => {
    const answer = {
      choice: "accept",
      by: "captain",
      rationale: "The receipt supports it.",
      at: "2026-10-01T00:00:00Z",
    };
    expect(
      validate({ ...base, entries: [...entries, { ...open("example-decision-3"), answered: true, answer }] }),
    ).toBe(true);
    expect(validate({ ...base, entries: [...entries, { ...open("example-decision-3"), answer }] })).toBe(false);
  });

  test("a ruling carries no answered flag", () => {
    expect(validate({ ...base, entries: [{ ...entries[0], answered: true }, entries[1]] })).toBe(false);
  });

  test("an escalation carries no ruling", () => {
    expect(
      validate({ ...base, entries: [{ ...entries[1], ruling: (entries[0] as { ruling: unknown }).ruling }] }),
    ).toBe(false);
  });

  test("a checkpoint outside the charter categories is refused", () => {
    expect(validate({ ...base, entries: [{ ...entries[0], checkpoint: "merge" }] })).toBe(false);
  });
});

describe("every list of artifact schema ids names the same ids", () => {
  const common = JSON.parse(readFileSync(join(REPO, "schemas", "common.schema.json"), "utf8"));
  const ids: string[] = common.$defs.schema_id.enum;

  test("each id has a schema file whose envelope pins that id", () => {
    for (const id of ids) {
      const file = join(REPO, "schemas", `${id}.schema.json`);
      expect(existsSync(file)).toBe(true);
      expect(JSON.parse(readFileSync(file, "utf8")).properties.schema).toEqual({ const: id });
    }
  });

  test("the catalog declares every id", () => {
    const catalog = parse(readFileSync(join(REPO, "catalog.yaml"), "utf8"));
    const declared = new Set((catalog.schemas as Array<{ id: string }>).map((s) => s.id));
    const catalogSchema = JSON.parse(readFileSync(join(REPO, "schemas", "catalog.schema.json"), "utf8"));
    const admitted = new Set(catalogSchema.properties.schemas.items.properties.id.enum);
    for (const id of ids) {
      expect(declared.has(id)).toBe(true);
      expect(admitted.has(id)).toBe(true);
    }
  });
});

/** A shipped example, typed. */
function template(name: string): JsonValue {
  return parseJson(readFileSync(join(REPO, "templates", name), "utf8"));
}

/** The last validation's errors for `id`, one line each: keyword, instance path and parameters. */
function errorsOf(id: string): string[] {
  return (validatorFor(id).errors ?? []).map((e) => `${e.keyword} ${e.instancePath} ${JSON.stringify(e.params)}`);
}

/**
 * One member at a time, from a valid shipped example, with the keyword that must refuse it. The member
 * lists are literal rather than read off the schema: a test that took them from the schema would shrink
 * with it, and dropping a member from `required` or `minItems` is the defect this exists to catch.
 */
describe("each required member and non-empty list is enforced on its own", () => {
  const ruled = updated(template("run-ledger.example.json"), ["entries", 0, "ruling"], () => ({
    what: "Approve.",
    why: "Both seats agreed.",
    cost_if_wrong: "One revert.",
  }));
  const required: [string, string, JsonValue, Path][] = [
    ...["destination", "notes", "decisions_so_far", "not_yet_specified", "out_of_scope", "tickets"].map(
      (member): [string, string, JsonValue, Path] => ["map", "", template("map.example.json"), [member]],
    ),
    ...["intent", "anchor", "objective", "pieces"].map((member): [string, string, JsonValue, Path] => [
      "handoff-record",
      "",
      template("handoff-record.example.json"),
      [member],
    ]),
    ...["specification", "specification_hash", "slices", "dependency_graph"].map(
      (member): [string, string, JsonValue, Path] => [
        "plan-record",
        "",
        template("plan-record.example.json"),
        [member],
      ],
    ),
    ...[
      "problem",
      "solution",
      "non_goals",
      "acceptance_criteria",
      "test_seams",
      "verification_commands",
      "out_of_scope",
    ].map((member): [string, string, JsonValue, Path] => [
      "plan-record",
      "/specification",
      template("plan-record.example.json"),
      ["specification", member],
    ]),
    ["ship-evidence", "", template("ship-evidence.example.json"), ["mode"]],
    ["run-ledger", "", template("run-ledger.example.json"), ["entries"]],
    ...["checkpoint", "decision", "outcome"].map((member): [string, string, JsonValue, Path] => [
      "run-ledger",
      "/entries/0",
      template("run-ledger.example.json"),
      ["entries", 0, member],
    ]),
    ...["what", "why", "cost_if_wrong"].map((member): [string, string, JsonValue, Path] => [
      "run-ledger",
      "/entries/0/ruling",
      ruled,
      ["entries", 0, "ruling", member],
    ]),
  ];
  test.each(required.map(([id, at, doc, path]) => [`${id} ${path.join(".")}`, id, at, doc, path] as const))(
    "%s is required",
    (_name, id, at, doc, path) => {
      const validate = validatorFor(id);
      expect(validate(doc)).toBe(true);
      expect(validate(edited(doc, path, "delete"))).toBe(false);
      expect(errorsOf(id)).toContain(`required ${at} ${JSON.stringify({ missingProperty: path.at(-1) })}`);
    },
  );

  const nonEmpty: [string, JsonValue, Path][] = [
    ...[
      "decisions",
      "references",
      "evidence",
      "pieces",
      "outstanding",
      "failed_approaches",
      "next_steps",
      "skills",
      "directives",
      "redactions",
    ].map((member): [string, JsonValue, Path] => ["handoff-record", template("handoff-record.example.json"), [member]]),
    ...["capability_map", "slices"].map((member): [string, JsonValue, Path] => [
      "plan-record",
      template("plan-record.example.json"),
      [member],
    ]),
    ...["acceptance_criteria", "test_seams", "verification_commands"].map((member): [string, JsonValue, Path] => [
      "plan-record",
      template("plan-record.example.json"),
      ["specification", member],
    ]),
  ];
  test.each(nonEmpty.map(([id, doc, path]) => [`${id} ${path.join(".")}`, id, doc, path] as const))(
    "%s may not be an empty list",
    (_name, id, doc, path) => {
      const validate = validatorFor(id);
      expect(validate(edited(doc, path, "empty"))).toBe(false);
      expect(errorsOf(id)).toContain(`minItems /${path.join("/")} ${JSON.stringify({ limit: 1 })}`);
    },
  );
});
