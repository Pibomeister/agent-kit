import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { checkSchemas, compileSchemas } from "../src/validation/schemas.ts";
import { checkArtifacts } from "../src/validation/artifacts.ts";
import { loadCatalog } from "../src/catalog/load.ts";
import { makeTree } from "./helpers/tree.ts";

/**
 * The conditional branches in finding.schema.json, exercised against the
 * shipped schema rather than a synthetic stand-in.
 *
 * tests/schemas.test.ts covers the compile-and-report machinery using small
 * hand-written schemas, which is the right shape for testing the machinery and
 * the wrong shape for testing a constraint: a copy of the constraint inside a
 * test proves the copy works. These cases read schemas/ off disk at run time,
 * so a branch that is edited or deleted is a branch these tests stop agreeing
 * with. Nothing here is duplicated into tests/fixtures/, for the same reason.
 *
 * The rejections assert on the field the branch guards rather than on ajv's
 * wording, which differs per keyword: a missing excerpt reports `required`, a
 * counter-evidence-only array reports `contains`. What makes a rejection
 * meaningful is the accepting case beside it -- the same evidence passes at a
 * lower anchor, so a rejection cannot be the fixture being malformed.
 *
 * The blocks follow the order of the schema's root `allOf`, so a reader can
 * cross-reference a branch by position. Two clauses are deliberately not
 * claimed to be isolated, and say so where they sit: the `smell` branch's ban
 * on a fixer dispatch and the fixer branch's `spec_quality` restriction are
 * the same rule written twice, since `smell` is exactly the value the fixer
 * branch excludes. Either one alone still rejects the document, so no fixture
 * can attribute the rejection to one of them. Those cases pin the behaviour
 * the rulings require, not the clause that happens to deliver it.
 *
 * Every case here was negative-tested by deleting its branch from the schema
 * and confirming the case fails -- a constraint test that still passes with
 * the constraint deleted is measuring nothing, and reading it cannot tell you
 * which kind you have.
 */

const SCHEMAS_DIR = join(import.meta.dir, "..", "schemas");
// The constraints come from the shipped files, compiled once. Each case still
// passes its own artifact through checkSchemas, including its reporting path.
const SCHEMAS = compileSchemas(join(import.meta.dir, ".."));

/** Preserve fixture package layout; SCHEMAS owns validation, not these per-case copies. */
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
const LOCATION = { repo: "demo", revision: SHA, path: "src/p.ts", line_range: { start: 1, end: 1 } };
const FINGERPRINT = {
  value: `sha256:${"b".repeat(64)}`,
  inputs: { rule: "null-deref", symbol_or_path: "src/p.ts", evidence_digest: `sha256:${"c".repeat(64)}` },
};

const UNQUOTED = { location: LOCATION, observation: "the return value is used without a null check" };
const QUOTED = { ...UNQUOTED, excerpt: "return user.profile.name;" };
const COUNTER = { ...UNQUOTED, excerpt: "if (user == null) return;", supports: "counter-evidence" };

const SUGGESTED_FIX = { summary: "guard the dereference and return early when the lookup missed" };
const APPROVAL = { artifact_hash: `sha256:${"d".repeat(64)}`, by: "human", authority: "explicit", at: AT };
const AUTHORIZED = { kind: "explicit", approval: APPROVAL };
const GRANT = { charter_hash: `sha256:${"e".repeat(64)}`, covers: "adjudicate-finding" };
const VERIFICATION_ARTIFACT = { id: "verification-1", schema: "verification", hash: `sha256:${"f".repeat(64)}` };
const RECEIPT = { verification: VERIFICATION_ARTIFACT, closed_by: "verifier", independent: true, at: AT };
const ADJUDICATION = {
  by: "orchestrator",
  outcome: "accepted",
  rationale: "thin evidence, but the exposure is real and the seat is not skipped for being unsure",
  at: AT,
};
const NOVELTY = [{ ref: "src/p.ts@" + SHA, kind: "code" }];

/**
 * A valid finding that trips no conditional: an open `patch` finding, manually
 * fixed, anchored at 50 so the quote-the-line gate is out of range, in a lane
 * that is not the security lane. Every case below is this document plus the
 * one thing under test, so a rejection names the branch rather than the
 * fixture.
 */
const BASE = {
  schema: "finding",
  schema_version: 1,
  id: "finding-1",
  project: { id: "demo" },
  run_id: null,
  created_by: { role: "implementer" },
  inputs: [],
  source_revision: null,
  created_at: AT,
  status: "open",
  title: "A caller dereferences a value the callee may return null for",
  lane: "correctness",
  fingerprint: FINGERPRINT,
  severity: "P1",
  confidence_anchor: 50,
  spec_quality: "patch",
  difficulty: "mechanical",
  autofix_class: "manual",
  evidence: [UNQUOTED],
  verification: [{ check: "bun test" }],
};

/** Errors reported against the finding artifact alone; catalog noise is not the subject here. */
function findingErrors(overrides: Record<string, unknown>): string[] {
  const root = makeTree({
    "catalog.yaml": CATALOG,
    ...shippedSchemas(),
    "templates/finding.json": JSON.stringify({ ...BASE, ...overrides }),
  });
  const { catalog } = loadCatalog(root);
  if (catalog === null) throw new Error("fixture has no catalog");
  return checkSchemas({ root, catalog }, SCHEMAS)
    .filter((i) => i.file === "templates/finding.json" && i.severity === "error")
    .map((i) => i.message ?? "");
}

/**
 * The artifact-level rules on the same document. Schema conformance is asserted
 * separately by `findingErrors`, and the pair is the point: `checkArtifacts`
 * reads raw values and never validates, so a rule tested only against a bare
 * envelope cannot distinguish firing on a conforming finding from firing on
 * anything at all. That is exactly how `finding.self-closed` stayed dead --
 * every fixture for it spelled the receipt a way the schema forbids.
 */
function artifactRules(overrides: Record<string, unknown>): string[] {
  const root = makeTree({
    "catalog.yaml": CATALOG,
    ...shippedSchemas(),
    "templates/finding.json": JSON.stringify({ ...BASE, ...overrides }),
  });
  const { catalog } = loadCatalog(root);
  if (catalog === null) throw new Error("fixture has no catalog");
  return checkArtifacts({ root, catalog })
    .filter((i) => i.file === "templates/finding.json" && i.severity === "error")
    .map((i) => i.rule);
}

/** The reported errors as one string, for matching the guarded field. */
function reason(overrides: Record<string, unknown>): string {
  const errors = findingErrors(overrides);
  expect(errors.length).toBeGreaterThan(0);
  return errors.join(" ");
}

test("the base document every case is built from is valid", () => {
  expect(findingErrors({})).toEqual([]);
});

describe("a smell has an open solution space", () => {
  // Plan 5.5: inventing a difficulty before the solution class is known is the
  // thing forbidden, so the schema forces null rather than trusting prose.
  test("a smell may not carry a difficulty", () => {
    expect(reason({ spec_quality: "smell" })).toMatch(/difficulty/);
  });

  test("a smell with a null difficulty and no automatic class is valid", () => {
    expect(findingErrors({ spec_quality: "smell", difficulty: null, autofix_class: "advisory" })).toEqual([]);
    expect(findingErrors({ spec_quality: "smell", difficulty: null, autofix_class: "manual" })).toEqual([]);
  });

  test("a smell may not be automatically appliable", () => {
    // `gated_auto` rather than `safe_auto` isolates this clause: safe_auto also
    // trips the branch below, and a fixture that fails two branches cannot say
    // which one it was testing.
    const overrides = { spec_quality: "smell", difficulty: null, suggested_fix: SUGGESTED_FIX };
    expect(reason({ ...overrides, autofix_class: "gated_auto" })).toMatch(/autofix_class/);
    expect(reason({ ...overrides, autofix_class: "safe_auto" })).toMatch(/autofix_class/);
  });

  test("a smell is never handed to a fixer (release scenario 6)", () => {
    // Jointly held with the fixer-dispatch branch, which excludes exactly the
    // `smell` spec quality this branch fires on. Deleting either clause leaves
    // the document rejected, so this pins the ruling and not the clause.
    expect(
      reason({ spec_quality: "smell", difficulty: null, dispatch: { kind: "fixer" }, authorization_ref: AUTHORIZED }),
    ).toMatch(/dispatch|spec_quality/);
  });

  test("a smell may be sharpened, diagnosed or escalated", () => {
    for (const kind of ["sharpen", "diagnose", "escalate"]) {
      expect(findingErrors({ spec_quality: "smell", difficulty: null, dispatch: { kind } })).toEqual([]);
    }
  });
});

describe("an automatically appliable finding is a fully specified one", () => {
  // Plan 5.5 and plan 2.5 apply-findings: this is the structural floor under
  // `safe_auto`. The per-seat restriction (ruling `safe-auto-restricted-per-seat`)
  // sits on top of it and is a review-policy property, not a shape.
  const SAFE = {
    autofix_class: "safe_auto",
    spec_quality: "patch",
    difficulty: "mechanical",
    suggested_fix: SUGGESTED_FIX,
  };

  test("safe_auto with a patch, a mechanical difficulty and a suggested fix is valid", () => {
    expect(findingErrors(SAFE)).toEqual([]);
  });

  test("safe_auto needs a suggested fix to apply", () => {
    const { suggested_fix: _suggestedFix, ...withoutFix } = SAFE;
    expect(reason(withoutFix)).toMatch(/suggested_fix/);
  });

  test("safe_auto may not run on a sketch", () => {
    expect(reason({ ...SAFE, spec_quality: "sketch" })).toMatch(/spec_quality/);
  });

  test("safe_auto may not run on a finding whose difficulty is not mechanical", () => {
    for (const difficulty of ["local-judgment", "cross-cutting"]) {
      expect(reason({ ...SAFE, difficulty })).toMatch(/difficulty/);
    }
  });
});

describe("a gated_auto finding proposes a change", () => {
  test("gated_auto needs a suggested fix", () => {
    expect(reason({ autofix_class: "gated_auto" })).toMatch(/suggested_fix/);
  });

  test("gated_auto with a suggested fix is valid", () => {
    expect(findingErrors({ autofix_class: "gated_auto", suggested_fix: SUGGESTED_FIX })).toEqual([]);
  });

  test("gated_auto does not require the authorization to exist yet", () => {
    // Deliberate, and pinned here so it is not quietly tightened into the rule
    // the branch's description used to claim it was. The class says what may
    // happen to the finding; the authority to do it is recorded where it is
    // exercised, by the disposition and fixer-dispatch branches. Requiring
    // `authorization_ref` here would also contradict ruling
    // `safe-auto-restricted-per-seat`, which has an intake step remap an
    // inbound safe_auto to gated_auto and keep the finding -- a remap that
    // would then have to invent an authorization to produce a valid document.
    expect(findingErrors({ autofix_class: "gated_auto", suggested_fix: SUGGESTED_FIX })).toEqual([]);
  });
});

describe("a disposition is an exercise of authority", () => {
  // Plan 5.5. `open` and `awaiting-verification` are not dispositions: nobody
  // has exercised authority yet, which is the distinction the status list in
  // the schema description draws and this block holds.
  for (const status of ["accepted", "in-progress", "deferred", "rejected"]) {
    test(`'${status}' without a recorded authorization is rejected`, () => {
      expect(reason({ status })).toMatch(/authorization_ref/);
    });

    test(`'${status}' with a recorded authorization is valid`, () => {
      expect(findingErrors({ status, authorization_ref: AUTHORIZED })).toEqual([]);
    });
  }

  test("'open' and 'awaiting-verification' need no authorization, because neither disposes of anything", () => {
    expect(findingErrors({ status: "open" })).toEqual([]);
    expect(findingErrors({ status: "awaiting-verification" })).toEqual([]);
  });
});

describe("only independent verification evidence closes a finding", () => {
  // Plan 11, ruling `closure-requires-independent-verification`, release
  // scenario 3. `resolved` is also a disposition, so a closure fixture carries
  // an authorization and the missing receipt is the only thing under test.
  const RESOLVED = { status: "resolved", authorization_ref: AUTHORIZED };

  test("a resolved finding with no receipt is an invalid transition, not an optimistic one", () => {
    expect(reason(RESOLVED)).toMatch(/closure_receipt/);
  });

  test("the same finding with an independent receipt closes", () => {
    // The pair is the point. Without the accepting case beside it the rejection
    // above could be the fixture being malformed rather than the rule biting.
    expect(findingErrors({ ...RESOLVED, closure_receipt: RECEIPT })).toEqual([]);
  });

  test("a receipt that does not claim independence does not close a finding", () => {
    // The strongest form of 'the fixer's own claim' this schema can see.
    // Whether the named closer is in fact the author of the change is a
    // cross-document comparison and no shape here decides it. This deferral
    // used to name the `finding.closer-is-not-the-author-of-the-change`
    // validator rule, which was wrong twice over: that rule could not fire at
    // all, and the half it was reaching for is not the validator's. The closer
    // versus the finding's author is checked below; the closer versus the
    // author of the fix belongs to the `apply-findings` protocol, which is the
    // only place both identities exist. This case is the structural half and
    // is not evidence about either.
    expect(reason({ ...RESOLVED, closure_receipt: { ...RECEIPT, independent: false } })).toMatch(/independent/);
    const { independent: _independent, ...withoutClaim } = RECEIPT;
    expect(reason({ ...RESOLVED, closure_receipt: withoutClaim })).toMatch(/independent/);
  });

  test("a receipt points at a verification artifact, because a description of green tests is not one", () => {
    // Plan 5.6, release scenario 10.
    const { verification: _verification, ...withoutArtifact } = RECEIPT;
    expect(reason({ ...RESOLVED, closure_receipt: withoutArtifact })).toMatch(/verification/);
  });

  test("a finding that satisfies the schema in full and closes itself is reported", () => {
    // The half the case above defers to the validator, asserted end to end on
    // one document rather than split across two suites that cannot see each
    // other. `BASE.created_by.role` is `implementer`, so naming `implementer`
    // as the closer is the author signing their own closure. The first
    // assertion is what makes the second mean anything: the document is not
    // merely accepted by `checkArtifacts`, it conforms, so the rule is firing
    // on the shape a real finding has.
    const selfClosed = { ...RESOLVED, closure_receipt: { ...RECEIPT, closed_by: "implementer" } };
    expect(findingErrors(selfClosed)).toEqual([]);
    expect(artifactRules(selfClosed)).toContain("finding.self-closed");
  });

  test("the same finding closed by an independent role is clean on both axes", () => {
    // The accepting half, for the reason the receipt pair above gives: without
    // it the rejection could be the fixture being malformed rather than the
    // rule biting. RECEIPT names `verifier`, who did not author the finding.
    const independent = { ...RESOLVED, closure_receipt: RECEIPT };
    expect(findingErrors(independent)).toEqual([]);
    expect(artifactRules(independent)).not.toContain("finding.self-closed");
  });
});

describe("a reopened finding says why it came back", () => {
  test("'reopened' without novelty evidence is rejected", () => {
    expect(reason({ status: "reopened" })).toMatch(/novelty_evidence/);
  });

  test("'reopened' with novelty evidence is valid, and needs no fresh authorization", () => {
    // Plan 6.3: a finding that comes back is the same finding, recognisable by
    // its fingerprint. Nobody exercises authority by noticing that, which is
    // why `reopened` is absent from the disposition list two blocks up.
    expect(findingErrors({ status: "reopened", novelty_evidence: NOVELTY })).toEqual([]);
  });
});

describe("a low-confidence security finding stays visible and is adjudicated", () => {
  // Plan 6.1, release scenario 3, ruling `low-confidence-security-adjudicated`.
  // Confidence is an evidence anchor recorded on the finding, never a gate in
  // front of it, so a thin security finding is decided by someone with
  // authority rather than filtered away by a threshold.
  const SECURITY = { lane: "code-review/security" };

  for (const anchor of [0, 25, 50]) {
    test(`a security finding anchored at ${anchor} cannot be left open and unadjudicated`, () => {
      const errors = reason({ ...SECURITY, confidence_anchor: anchor });
      expect(errors).toMatch(/adjudication/);
      expect(errors).toMatch(/status/);
    });

    test(`a security finding anchored at ${anchor} is valid once adjudicated`, () => {
      expect(
        findingErrors({
          ...SECURITY,
          confidence_anchor: anchor,
          adjudication: ADJUDICATION,
          status: "accepted",
          authorization_ref: AUTHORIZED,
        }),
      ).toEqual([]);
    });
  }

  test("an adjudicated security finding may not still be sitting open", () => {
    // Isolates the second half of the branch: the ruling is recorded and the
    // finding has moved, not recorded and then left where it was.
    expect(reason({ ...SECURITY, confidence_anchor: 25, adjudication: ADJUDICATION, status: "open" })).toMatch(
      /status/,
    );
  });

  test("a well-evidenced security finding is not forced through adjudication", () => {
    // The guard, not the rule: the branch reaches thin findings only. Without
    // this case a branch that fired on every security finding would pass.
    expect(findingErrors({ ...SECURITY, confidence_anchor: 100, evidence: [QUOTED] })).toEqual([]);
  });

  test("a thin finding outside the security lane is not forced through adjudication", () => {
    // The other guard. Plan 6.1 scopes this to the security concern; a thin
    // correctness finding is an ordinary low anchor.
    expect(findingErrors({ confidence_anchor: 25 })).toEqual([]);
    expect(findingErrors({ lane: "code-review/performance", confidence_anchor: 0 })).toEqual([]);
  });
});

describe("a fixer dispatch needs a specified finding and a recorded authorization", () => {
  // Plan 2.5: apply-findings applies only accepted, sufficiently specified
  // findings. The base status is `open`, so the missing authorization reported
  // here is this branch's and not the disposition branch's -- both emit the
  // same message, and only the fixture can tell them apart.
  test("a fixer dispatch without an authorization is rejected", () => {
    expect(reason({ dispatch: { kind: "fixer" } })).toMatch(/authorization_ref/);
  });

  test("a fixer dispatch with an authorization is valid", () => {
    expect(findingErrors({ dispatch: { kind: "fixer" }, authorization_ref: AUTHORIZED })).toEqual([]);
    expect(
      findingErrors({ dispatch: { kind: "fixer" }, spec_quality: "sketch", authorization_ref: AUTHORIZED }),
    ).toEqual([]);
  });

  test("a dispatch that is not a hand-off carries no authorization requirement", () => {
    // The guard: sharpening or diagnosing a finding asks someone to look again,
    // which is not an exercise of authority over the code.
    for (const kind of ["sharpen", "diagnose", "escalate"]) {
      expect(findingErrors({ dispatch: { kind } })).toEqual([]);
    }
  });

  test("a hand-off is specified enough to be implemented once rather than guessed at", () => {
    // Jointly held with the smell branch above; see the note there. `smell` is
    // the only spec quality this clause excludes, and it is the value that
    // branch fires on.
    expect(
      reason({ spec_quality: "smell", difficulty: null, dispatch: { kind: "fixer" }, authorization_ref: AUTHORIZED }),
    ).toMatch(/dispatch|spec_quality/);
  });
});

describe("the quote-the-line gate on high confidence anchors", () => {
  test("anchor 75 with no excerpt anywhere is rejected", () => {
    expect(findingErrors({ confidence_anchor: 75, evidence: [UNQUOTED] }).join(" ")).toMatch(/evidence/);
  });

  test("anchor 100 with no excerpt anywhere is rejected", () => {
    expect(findingErrors({ confidence_anchor: 100, evidence: [UNQUOTED] }).join(" ")).toMatch(/evidence/);
  });

  test("anchor 75 with a grounding excerpt passes", () => {
    expect(findingErrors({ confidence_anchor: 75, evidence: [QUOTED] })).toEqual([]);
  });

  test("an empty excerpt string does not satisfy the gate", () => {
    expect(findingErrors({ confidence_anchor: 75, evidence: [{ ...UNQUOTED, excerpt: "" }] }).join(" ")).toMatch(
      /evidence/,
    );
  });

  test("a quote that argues against the finding does not ground it", () => {
    expect(findingErrors({ confidence_anchor: 100, evidence: [COUNTER] }).join(" ")).toMatch(/evidence/);
  });

  test("counter-evidence beside a grounding quote passes, and order does not matter", () => {
    expect(findingErrors({ confidence_anchor: 100, evidence: [COUNTER, QUOTED] })).toEqual([]);
    expect(findingErrors({ confidence_anchor: 100, evidence: [QUOTED, COUNTER] })).toEqual([]);
  });

  test("the gate does not reach anchors below 75, which is where an unquotable finding belongs", () => {
    for (const anchor of [0, 25, 50])
      expect(findingErrors({ confidence_anchor: anchor, evidence: [UNQUOTED] })).toEqual([]);
  });

  test("a seat that cannot quote has a passing option, so the gate never forces a fabricated excerpt", () => {
    // The pair that matters: the same evidence is rejected at 75 and accepted at 50. If this
    // ever inverts, the cheapest way past the gate becomes inventing a quote rather than
    // recording the weaker anchor the vocabulary already provides.
    expect(findingErrors({ confidence_anchor: 75, evidence: [UNQUOTED] }).length).toBeGreaterThan(0);
    expect(findingErrors({ confidence_anchor: 50, evidence: [UNQUOTED] })).toEqual([]);
  });
});

describe("an authorization names the authority it rests on", () => {
  // Nested inside `authorization_ref`, and load-bearing for the two branches
  // that require it: without these, `{"kind": "delegated-grant"}` would satisfy
  // both the disposition branch and the fixer branch while pointing at nothing.
  // A finding does not carry its own authority (plan 5.5).
  test("a delegated grant names the grant", () => {
    expect(reason({ status: "accepted", authorization_ref: { kind: "delegated-grant" } })).toMatch(/grant/);
    expect(findingErrors({ status: "accepted", authorization_ref: { kind: "delegated-grant", grant: GRANT } })).toEqual(
      [],
    );
  });

  test("a decision authorization names the decision", () => {
    const decision = { id: "decision-1", schema: "decision", hash: `sha256:${"9".repeat(64)}` };
    expect(reason({ status: "accepted", authorization_ref: { kind: "decision" } })).toMatch(/decision/);
    expect(findingErrors({ status: "accepted", authorization_ref: { kind: "decision", decision } })).toEqual([]);
  });

  test("an explicit authorization names the approval", () => {
    expect(reason({ status: "accepted", authorization_ref: { kind: "explicit" } })).toMatch(/approval/);
    expect(findingErrors({ status: "accepted", authorization_ref: AUTHORIZED })).toEqual([]);
  });
});
