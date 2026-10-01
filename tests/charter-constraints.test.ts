import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { checkSchemas } from "../src/validation/schemas.ts";
import { loadCatalog } from "../src/catalog/load.ts";
import { makeTree } from "./helpers/tree.ts";

/**
 * What charter.schema.json may and may not decide on its own, exercised against
 * the shipped schema rather than a synthetic stand-in, in the shape
 * tests/finding-constraints.test.ts established.
 *
 * The block these cases exist for is the one that is no longer there. The
 * schema's `allOf/2` used to require `supersedes` on any charter whose status
 * was `superseded`, while the sentence beside it said the opposite: a change
 * produces a *new* charter whose `supersedes` names the old one. Bound to the
 * old charter instead, the constraint said a charter could only be retired if
 * it had retired something first, so a project's first charter became
 * unrepresentable the moment it was amended -- the one case every project
 * reaches. A single-document schema writing about a two-document relationship
 * will bind it to whichever document is in front of it, and that is how it
 * happened. The relationship is now carried by
 * `charter.amendment-creates-a-new-hash-and-invalidates-old-grants` at the
 * validator level, which can hold both charters at once; `allOf/2` keeps the
 * annotation as the pointer to it and claims no check it cannot perform.
 *
 * So the cases below are a pair: the retirement the schema used to refuse is
 * accepted, and the amendment that names its ancestor is accepted with it.
 * Neither alone is worth much -- the first on its own is also what deleting the
 * whole branch by accident would produce -- and the well-formedness case is
 * what says the remaining local constraints still bite.
 *
 * Negative-tested by restoring the deleted `if`/`then` to `allOf/2` and
 * confirming the retirement case fails, and by deleting `allOf/3` and
 * confirming the grant case fails. A constraint test that still passes with the
 * constraint gone is measuring nothing.
 */

const SCHEMAS_DIR = join(import.meta.dir, "..", "schemas");

function shippedSchemas(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of readdirSync(SCHEMAS_DIR)) {
    if (name.endsWith(".schema.json")) out[`schemas/${name}`] = readFileSync(join(SCHEMAS_DIR, name), "utf8");
  }
  return out;
}

const CATALOG = `schema_version: 1
package:
  id: ak
  name: agent-kit
  version: 0.1.0
  namespace: "/ak:"
  default_profile: core
schemas:
${readdirSync(SCHEMAS_DIR)
  .filter((n) => n.endsWith(".schema.json"))
  .map((n) => `  - id: ${n.replace(".schema.json", "")}\n    status: authored`)
  .join("\n")}
`;

const SHA = "a".repeat(40);
const AT = "2026-09-19T10:00:00Z";
const HASH = `sha256:${"b".repeat(64)}`;

/**
 * An active charter that trips no conditional. Every case is this document plus
 * the one thing under test, so a rejection names the branch rather than the
 * fixture. The hash is not the document's real digest and does not need to be:
 * `checkSchemas` validates shape, and the digest is checked by
 * `charter.hash-matches-content-and-location-is-not-worker-writable` a layer up.
 */
const BASE = {
  schema: "charter",
  schema_version: 1,
  id: "charter-1",
  project: { id: "demo" },
  run_id: null,
  created_by: { role: "human" },
  inputs: [],
  source_revision: { repo: "demo/app", revision: SHA },
  created_at: AT,
  status: "active",
  immutability: { immutable: true, worker_writable: false, hash: HASH, location: "demo/kb/charters/charter-1.json" },
  work_source: {
    kind: "ticket",
    ref: { id: "ticket-1", schema: "ticket", hash: `sha256:${"c".repeat(64)}`, revision: SHA },
    summary: "Close the finding raised against the loader.",
  },
  repos: [{ repo: "demo/app", base_branch: "main", work_branch_prefix: "run/", paths: ["src/**"] }],
  artifact_destinations: { kb_root: "demo/kb", runs_path: "projects/demo/runs", project: "demo" },
  allowed_capabilities: ["repository-read", "repository-write", "artifact-write"],
  default_grants: ["approve-ticket"],
  denied_actions: ["merge", "deploy", "money-movement", "force-push"],
  checkpoints: ["ticket-approval"],
  limits: {
    fix_cycles: 2,
    ci_repair_attempts: 3,
    alignment_questions: 5,
    tickets: 10,
    elapsed_minutes: 120,
    review_rounds: 2,
  },
  budgets: { provided_by: "runner", enforces: ["fix-cycles", "elapsed-minutes"], on_exhaustion: "cap-reached" },
  approvals: [{ artifact_hash: `sha256:${"d".repeat(64)}`, by: "human", authority: "explicit", at: AT }],
  supervisors: {
    seats: [
      { id: "seat-one", role: "supervisor", filled_by: "supervisor" },
      { id: "seat-two", role: "supervisor", filled_by: "reviewer-standards" },
    ],
    independence: "declared-independent",
    tie_breaker_allowed: false,
    may_implement: false,
    on_missing_seat: "block-and-escalate",
  },
};

/** Errors reported against the charter artifact alone; catalog noise is not the subject here. */
function charterErrors(overrides: Record<string, unknown>): string[] {
  const root = makeTree({
    "catalog.yaml": CATALOG,
    ...shippedSchemas(),
    "templates/charter.json": JSON.stringify({ ...BASE, ...overrides }),
  });
  const { catalog } = loadCatalog(root);
  if (catalog === null) throw new Error("fixture has no catalog");
  return checkSchemas({ root, catalog })
    .filter((i) => i.file === "templates/charter.json" && i.severity === "error")
    .map((i) => i.message ?? "");
}

test("the base document every case is built from is valid", () => {
  expect(charterErrors({})).toEqual([]);
});

describe("a charter's retirement is not a fact about the charter being retired", () => {
  test("a superseded charter needs nothing added to it", () => {
    expect(charterErrors({ status: "superseded" })).toEqual([]);
  });

  test("the charter that retired it names it", () => {
    expect(charterErrors({ id: "charter-2", supersedes: { id: "charter-1", schema: "charter", hash: HASH } })).toEqual(
      [],
    );
  });

  test("a reference that names nothing is still refused", () => {
    const errors = charterErrors({ id: "charter-2", supersedes: { schema: "charter", hash: HASH } });
    expect(errors.join(" ")).toMatch(/id/);
  });
});

describe("what the schema can still decide with one document in front of it", () => {
  // Both halves are properties of the charter being read, so the branch that
  // pairs them is answerable here in a way the amendment relationship was not.
  test("a checkpoint the supervisors may decide needs the grant that carries it out", () => {
    const errors = charterErrors({
      checkpoints: ["ticket-approval", "lesson-publication"],
      default_grants: ["approve-ticket"],
    });
    expect(errors.join(" ")).toMatch(/default_grants/);
  });

  test("the same charter is accepted once the grant is there", () => {
    expect(
      charterErrors({
        checkpoints: ["ticket-approval", "lesson-publication"],
        default_grants: ["approve-ticket", "publish-lesson"],
      }),
    ).toEqual([]);
  });
});
