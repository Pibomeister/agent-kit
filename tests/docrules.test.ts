import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { checkSchemas } from "../src/validation/schemas.ts";
import {
  checkDocument,
  checkDocumentRules,
  digestDomain,
  evidenceDigest,
  indexDocuments,
} from "../src/validation/docrules.ts";
import { artifactHash } from "../src/util/hash.ts";
import { loadCatalog } from "../src/catalog/load.ts";
import { makeTree } from "./helpers/tree.ts";

function envelope(schema: string, id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema,
    schema_version: 1,
    id,
    project: "demo",
    run_id: null,
    created_by: { role: "runner" },
    inputs: [],
    source_revision: { repo: "app", revision: "a".repeat(40) },
    created_at: "2026-09-19T00:00:00Z",
    status: "draft",
    ...extra,
  };
}

/** The shipped schemas, so the one case that needs ajv reads the real text. */
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

function rulesOf(issues: Array<{ rule: string }>): string[] {
  return issues.map((i) => i.rule);
}

function run(doc: Record<string, unknown>, others: Record<string, unknown>[] = []) {
  const all = [{ file: "templates/doc.json", doc }, ...others.map((d, i) => ({ file: `templates/other-${i}.json`, doc: d }))];
  return checkDocument("templates/doc.json", doc, indexDocuments(all));
}

// ---------------------------------------------------------------- charter ---

function charter(extra: Record<string, unknown> = {}): Record<string, unknown> {
  const body = envelope("charter", "charter-1", {
    status: "active",
    immutability: { immutable: true, worker_writable: false, hash: "", location: "kb/charters/c1.json" },
    repos: [{ repo: "app", base_branch: "main", paths: ["src/**"] }],
    supervisors: {
      seats: [
        { id: "seat-a", role: "supervisor", filled_by: "reviewer-a" },
        { id: "seat-b", role: "supervisor", filled_by: "reviewer-b" },
      ],
      independence: "declared-independent",
      tie_breaker_allowed: false,
      may_implement: false,
    },
    checkpoints: ["spec-approval"],
    ...extra,
  });
  const withoutHash = JSON.parse(JSON.stringify(body)) as Record<string, unknown>;
  (withoutHash["immutability"] as Record<string, unknown>)["hash"] = "";
  (body["immutability"] as Record<string, unknown>)["hash"] = artifactHash(withoutHash);
  return body;
}

describe("charter rules", () => {
  test("a well-formed charter produces no charter issues", () => {
    expect(rulesOf(run(charter())).filter((r) => r.startsWith("charter."))).toEqual([]);
  });

  test("charter.hash-matches-content-and-location-is-not-worker-writable catches a wrong hash", () => {
    const doc = charter();
    (doc["immutability"] as Record<string, unknown>)["hash"] = `sha256:${"0".repeat(64)}`;
    expect(rulesOf(run(doc))).toContain("charter.hash-matches-content-and-location-is-not-worker-writable");
  });

  test("charter.hash-matches-content-and-location-is-not-worker-writable catches a worker-writable location", () => {
    const doc = charter();
    (doc["immutability"] as Record<string, unknown>)["location"] = "src/charters/c1.json";
    expect(rulesOf(run(doc))).toContain("charter.hash-matches-content-and-location-is-not-worker-writable");
  });

  test("charter.sensitive-grant-requires-explicit-human-approval-bound-to-this-hash catches a foreign hash", () => {
    const doc = charter({
      sensitive_grants: [
        {
          action: "force-push",
          scope: "app",
          approval: {
            artifact_hash: `sha256:${"b".repeat(64)}`,
            by: "human",
            authority: "explicit",
            at: "2026-09-19T00:00:00Z",
          },
        },
      ],
    });
    expect(rulesOf(run(doc))).toContain("charter.sensitive-grant-requires-explicit-human-approval-bound-to-this-hash");
  });

  test("charter.supervisor-seats-independent-and-not-the-implementer catches one actor in both seats", () => {
    const doc = charter();
    const seats = (doc["supervisors"] as Record<string, unknown>)["seats"] as Record<string, unknown>[];
    seats[1]!["filled_by"] = "reviewer-a";
    expect(rulesOf(run(doc))).toContain("charter.supervisor-seats-independent-and-not-the-implementer");
  });

  test("charter.supervisor-seats-independent-and-not-the-implementer catches the creator taking a seat", () => {
    const doc = charter();
    const seats = (doc["supervisors"] as Record<string, unknown>)["seats"] as Record<string, unknown>[];
    seats[0]!["filled_by"] = "runner";
    expect(rulesOf(run(doc))).toContain("charter.supervisor-seats-independent-and-not-the-implementer");
  });

  test("charter.amendment-creates-a-new-hash-and-invalidates-old-grants catches a reused hash", () => {
    const old = charter();
    const oldHash = (old["immutability"] as Record<string, unknown>)["hash"] as string;
    const next = charter({ supersedes: { id: "charter-1", hash: oldHash } });
    (next["immutability"] as Record<string, unknown>)["hash"] = oldHash;
    expect(rulesOf(run(next, [old]))).toContain("charter.amendment-creates-a-new-hash-and-invalidates-old-grants");
  });

  test("charter.amendment-creates-a-new-hash-and-invalidates-old-grants catches a grant still bound to the old hash", () => {
    const old = charter();
    const oldHash = (old["immutability"] as Record<string, unknown>)["hash"] as string;
    const next = charter({
      id: "charter-2",
      supersedes: { id: "charter-1", hash: oldHash },
      sensitive_grants: [
        {
          action: "force-push",
          scope: "app",
          approval: { artifact_hash: oldHash, by: "human", authority: "explicit", at: "2026-09-19T00:00:00Z" },
        },
      ],
    });
    expect(rulesOf(run(next, [old]))).toContain("charter.amendment-creates-a-new-hash-and-invalidates-old-grants");
  });
});

// --------------------------------------------------------------- decision ---

function decision(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return envelope("decision", "decision-1", {
    status: "ruled",
    checkpoint: "spec-approval",
    question: "ship or hold?",
    options: [
      { id: "ship", summary: "ship it" },
      { id: "hold", summary: "hold it" },
    ],
    evidence: [{ ref: "receipt-1", kind: "receipt" }],
    required_evidence: ["receipt-1"],
    affected_artifacts: [{ id: "ticket-1", hash: `sha256:${"c".repeat(64)}` }],
    charter: { hash: `sha256:${"d".repeat(64)}` },
    seats: [
      { id: "seat-a", filled_by: "reviewer-a", independent: true, may_implement: false },
      { id: "seat-b", filled_by: "reviewer-b", independent: true, may_implement: false },
    ],
    judgments: [
      { seat: "seat-a", by: "reviewer-a", choice: "ship", rationale: "ok", unresolved_assumptions: [], escalate: false },
      { seat: "seat-b", by: "reviewer-b", choice: "ship", rationale: "ok", unresolved_assumptions: [], escalate: false },
    ],
    agreement: true,
    authority_check: {
      deterministic: true,
      charter_permits: true,
      required_evidence_present: true,
      seats_independent: true,
      checkpoint_in_charter: true,
      both_judgments_returned: true,
      result: "pass",
    },
    ruling: { outcome: "decided", chosen_option: "ship", at: "2026-09-19T00:00:00Z", recorded_by: "policy" },
    ...extra,
  });
}

describe("decision rules", () => {
  test("a well-formed decision produces no decision issues", () => {
    expect(rulesOf(run(decision())).filter((r) => r.startsWith("decision."))).toEqual([]);
  });

  test("decision.judgment-choice-names-a-declared-option catches an undeclared choice", () => {
    const doc = decision();
    (doc["judgments"] as Record<string, unknown>[])[0]!["choice"] = "abandon";
    expect(rulesOf(run(doc))).toContain("decision.judgment-choice-names-a-declared-option");
  });

  test("decision.judgment-choice-names-a-declared-option catches two judgments from one seat", () => {
    const doc = decision();
    (doc["judgments"] as Record<string, unknown>[])[1]!["seat"] = "seat-a";
    expect(rulesOf(run(doc))).toContain("decision.judgment-choice-names-a-declared-option");
  });

  test("decision.agreement-matches-the-recorded-judgments catches a claimed agreement", () => {
    const doc = decision();
    (doc["judgments"] as Record<string, unknown>[])[1]!["choice"] = "hold";
    expect(rulesOf(run(doc))).toContain("decision.agreement-matches-the-recorded-judgments");
  });

  test("decision.seats-declared-independent-and-not-the-implementer catches a duplicated seat holder", () => {
    const doc = decision();
    (doc["seats"] as Record<string, unknown>[])[1]!["filled_by"] = "reviewer-a";
    expect(rulesOf(run(doc))).toContain("decision.seats-declared-independent-and-not-the-implementer");
  });

  test("decision.authority-check-recomputed-from-charter-and-evidence fails closed on absent evidence", () => {
    const doc = decision({ required_evidence: ["receipt-1", "receipt-missing"] });
    expect(rulesOf(run(doc))).toContain("decision.authority-check-recomputed-from-charter-and-evidence");
  });

  test("decision.authority-check-recomputed-from-charter-and-evidence recomputes the checkpoint against the charter", () => {
    const chart = charter();
    const hash = (chart["immutability"] as Record<string, unknown>)["hash"] as string;
    const doc = decision({ checkpoint: "ship-approval", charter: { hash } });
    expect(rulesOf(run(doc, [chart]))).toContain("decision.authority-check-recomputed-from-charter-and-evidence");
  });

  test("decision.ruling-requires-a-passed-authority-check-not-mere-agreement catches a failed check", () => {
    const doc = decision();
    (doc["authority_check"] as Record<string, unknown>)["result"] = "fail";
    expect(rulesOf(run(doc))).toContain("decision.ruling-requires-a-passed-authority-check-not-mere-agreement");
  });
});

// ---------------------------------------------------------------- dossier ---

function dossier(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return envelope("dossier", "dossier-1", {
    status: "complete",
    question: "where is the auth boundary?",
    budget: { turns_allowed: 4, turns_used: 2, exhausted: false },
    searches: [{ id: "s1", tool: "lexical", query: "authorize", result_count: 3 }],
    hits: [],
    coverage_limits: [],
    unknowns: [],
    recommendation: { further_inspection: [] },
    ...extra,
  });
}

describe("dossier rules", () => {
  test("a well-formed dossier produces no dossier issues", () => {
    expect(rulesOf(run(dossier())).filter((r) => r.startsWith("dossier."))).toEqual([]);
  });

  test("dossier.turns-used-within-turns-allowed catches overspend", () => {
    expect(rulesOf(run(dossier({ budget: { turns_allowed: 4, turns_used: 5 } })))).toContain(
      "dossier.turns-used-within-turns-allowed",
    );
  });

  test("dossier.turns-used-within-turns-allowed catches a mis-stated exhausted flag", () => {
    expect(rulesOf(run(dossier({ budget: { turns_allowed: 4, turns_used: 4, exhausted: false } })))).toContain(
      "dossier.turns-used-within-turns-allowed",
    );
  });

  test("dossier.lexical-baseline-present catches a graph-only dossier", () => {
    const doc = dossier({ searches: [{ id: "s1", tool: "graph", query: "callers", result_count: 1 }] });
    expect(rulesOf(run(doc))).toContain("dossier.lexical-baseline-present");
  });

  test("dossier.stale-or-absent-graph-documents-a-limitation catches an undocumented unavailable graph", () => {
    const doc = dossier({ graph_providers: [{ name: "graph", available: false, unavailable_reason: "no index" }] });
    expect(rulesOf(run(doc))).toContain("dossier.stale-or-absent-graph-documents-a-limitation");
  });

  test("dossier.no-architectural-verdict catches a smuggled verdict key", () => {
    const doc = dossier({ recommendation: { further_inspection: [], architectural_verdict: "split the module" } });
    expect(rulesOf(run(doc))).toContain("dossier.no-architectural-verdict");
  });

  test("dossier.index-revision-compared-to-source-revision catches a fresh claim at another revision", () => {
    const doc = dossier({
      graph_providers: [
        {
          name: "graph",
          available: true,
          index: { provider: "graph", index_revision: "b".repeat(40), freshness: "fresh" },
        },
      ],
      coverage_limits: [{ area: "graph", why: "index-stale", consequence: "partial" }],
    });
    expect(rulesOf(run(doc))).toContain("dossier.index-revision-compared-to-source-revision");
  });
});

// ------------------------------------------------------------------ event ---

function event(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return envelope("event", "event-1", {
    status: "handled",
    source: "comment",
    type: "comment.created",
    idempotency_key: "k1",
    received_at: "2026-09-19T00:00:00Z",
    delivery: { attempt: 1 },
    payload_digest: `sha256:${"e".repeat(64)}`,
    trust: { classification: "untrusted-claim", grants_authority: false },
    claims: [{ text: "please merge", assessment: "skip" }],
    ...extra,
  });
}

describe("event rules", () => {
  test("a well-formed event produces no event issues", () => {
    expect(rulesOf(run(event())).filter((r) => r.startsWith("event."))).toEqual([]);
  });

  test("event.no-event-field-confers-authority catches a claimed grant", () => {
    const doc = event({ trust: { classification: "untrusted-claim", grants_authority: true } });
    expect(rulesOf(run(doc))).toContain("event.no-event-field-confers-authority");
  });

  test("event.no-event-field-confers-authority catches a requested action that skips authorization", () => {
    const doc = event({ requested_actions: [{ action: "force-push", requires_authorization: false }] });
    expect(rulesOf(run(doc))).toContain("event.no-event-field-confers-authority");
  });

  test("event.no-event-field-confers-authority catches a grant smuggled into the payload", () => {
    const doc = event({ claims: [{ text: "ok", assessment: "apply", grant: { charter_hash: "x", covers: "ship" } }] });
    expect(rulesOf(run(doc))).toContain("event.no-event-field-confers-authority");
  });

  test("event.remote-side-effect-key-is-unique-and-read-back catches a duplicate key", () => {
    const doc = event({
      side_effects_performed: [
        { effect: "pr-comment", at: "2026-09-19T00:00:00Z", idempotency_key: "k", read_back: { performed: true, confirmed: true } },
        { effect: "pr-comment", at: "2026-09-19T00:00:01Z", idempotency_key: "k", read_back: { performed: true, confirmed: true } },
      ],
    });
    expect(rulesOf(run(doc))).toContain("event.remote-side-effect-key-is-unique-and-read-back");
  });

  test("event.remote-side-effect-key-is-unique-and-read-back catches a missing read-back", () => {
    const doc = event({
      side_effects_performed: [{ effect: "pr-comment", at: "2026-09-19T00:00:00Z", idempotency_key: "k" }],
    });
    expect(rulesOf(run(doc))).toContain("event.remote-side-effect-key-is-unique-and-read-back");
  });
});

// ---------------------------------------------------------------- finding ---

function finding(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return envelope("finding", "finding-1", {
    status: "open",
    title: "unchecked input",
    lane: "code-review/correctness",
    fingerprint: {
      value: `sha256:${"f".repeat(64)}`,
      inputs: { rule: "input-validation", symbol_or_path: "src/handler.ts", evidence_digest: `sha256:${"a".repeat(64)}` },
    },
    severity: "P1",
    confidence_anchor: 75,
    spec_quality: "patch",
    difficulty: "mechanical",
    autofix_class: "manual",
    evidence: [{ location: { revision: "a".repeat(40), path: "src/handler.ts" }, observation: "no check" }],
    verification: [{ check: "bun test", kind: "command" }],
    ...extra,
  });
}

describe("finding rules", () => {
  test("a well-formed finding produces no finding issues", () => {
    expect(rulesOf(run(finding())).filter((r) => r.startsWith("finding."))).toEqual([]);
  });

  test("finding.fingerprint-stable-across-line-moves catches a line number in the identity inputs", () => {
    const doc = finding();
    (((doc["fingerprint"] as Record<string, unknown>)["inputs"]) as Record<string, unknown>)["symbol_or_path"] =
      "src/handler.ts:42";
    expect(rulesOf(run(doc))).toContain("finding.fingerprint-stable-across-line-moves");
  });

  test("finding.fingerprint-stable-across-line-moves catches two identities for the same inputs", () => {
    const a = finding();
    const b = finding({ id: "finding-2" });
    (b["fingerprint"] as Record<string, unknown>)["value"] = `sha256:${"9".repeat(64)}`;
    expect(rulesOf(run(a, [b]))).toContain("finding.fingerprint-stable-across-line-moves");
  });

  test("finding.presentation-label-never-substitutes-for-severity catches a label that outranks severity", () => {
    expect(rulesOf(run(finding({ severity: "P3", presentation_label: "Critical" })))).toContain(
      "finding.presentation-label-never-substitutes-for-severity",
    );
  });

  test("finding.synthesis-may-only-worsen-a-grade catches a softened severity", () => {
    const doc = finding({
      synthesis: {
        of: { id: "finding-0", hash: `sha256:${"a".repeat(64)}` },
        changes: [{ field: "severity", from: "P0", to: "P2" }],
        rationale: "seemed minor",
      },
    });
    expect(rulesOf(run(doc))).toContain("finding.synthesis-may-only-worsen-a-grade");
  });

  test("finding.synthesis-may-only-worsen-a-grade allows a worsened grade", () => {
    const doc = finding({
      spec_quality: "smell",
      difficulty: null,
      autofix_class: "manual",
      synthesis: {
        of: { id: "finding-0", hash: `sha256:${"a".repeat(64)}` },
        changes: [{ field: "spec_quality", from: "patch", to: "smell" }],
        rationale: "solution space is open",
      },
    });
    expect(rulesOf(run(doc))).not.toContain("finding.synthesis-may-only-worsen-a-grade");
  });

  test("finding.synthesis-may-only-worsen-a-grade catches a from-value that disagrees with the original", () => {
    const original = finding({ id: "finding-0", severity: "P0" });
    const doc = finding({
      severity: "P0",
      synthesis: {
        of: { id: "finding-0", hash: `sha256:${"a".repeat(64)}` },
        changes: [{ field: "severity", from: "P2", to: "P0" }],
        rationale: "raised",
      },
    });
    expect(rulesOf(run(doc, [original]))).toContain("finding.synthesis-may-only-worsen-a-grade");
  });

  test("finding.low-confidence-security-is-adjudicated-not-filtered catches a silently dropped concern", () => {
    const doc = finding({ lane: "code-review/security", confidence_anchor: 25, status: "rejected" });
    expect(rulesOf(run(doc))).toContain("finding.low-confidence-security-is-adjudicated-not-filtered");
  });

  test("finding.low-confidence-security-is-adjudicated-not-filtered allows an adjudicated concern", () => {
    const doc = finding({
      lane: "code-review/security",
      confidence_anchor: 25,
      status: "rejected",
      conflicting_evidence: [{ ref: "receipt-2", kind: "receipt" }],
    });
    expect(rulesOf(run(doc))).not.toContain("finding.low-confidence-security-is-adjudicated-not-filtered");
  });
});

// ----------------------------------------------------------------- lesson ---

function lesson(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return envelope("lesson", "lesson-1", {
    status: "published",
    title: "check the boundary",
    statement: "Validate at the trust boundary, not at the caller.",
    trigger: { kind: "failure", occurrence: { id: "run-1", hash: `sha256:${"a".repeat(64)}` } },
    evidence: [{ ref: "finding-1", kind: "artifact" }],
    applies_to: { domains: ["security"] },
    ...extra,
  });
}

describe("finding.evidence-digest-domain", () => {
  /*
   * The pair, run against one instrument.
   *
   * `finding.fingerprint-stable-across-line-moves` requires two findings with
   * different identity inputs to carry different values, so whether the evidence
   * digest moves when a line moves decides whether release scenario 9 is
   * enforced or enforced backwards. One of the two mutations below must change
   * the digest and the other must not. A check reading the wrong domain passes
   * the first and fails the second, and a check reading no domain at all passes
   * both -- which is the state this rule was written out of, where the domain
   * was a paragraph and the digests in the tree were synthetic literals.
   *
   * The domain itself is not repeated here. These tests seal documents with
   * `evidenceDigest`, the same function the rule recomputes with, because the
   * claim under test is what moving a line does to the digest and not what the
   * digest is. That the rule reports a digest which does not match its domain is
   * a separate claim, and it is measured by mutation in
   * research/probes/artifact-rule-firing.ts rather than here.
   */
  const RULE = "finding.evidence-digest-domain";
  const ROOT = join(import.meta.dir, "..");
  const DOMAIN = digestDomain(ROOT)!;

  const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

  function base(): Record<string, unknown> {
    return finding({
      // An object, unlike the shared envelope's string, so this case is
      // measuring the rule rather than a document ajv would have refused.
      project: { id: "demo" },
      evidence: [
        {
          location: {
            repo: "app",
            revision: "a".repeat(40),
            path: "src/handler.ts",
            symbol: "handle",
            line_range: { start: 24, end: 51 },
          },
          observation: "the tenant argument is accepted and never read",
        },
      ],
    });
  }

  function sealed(doc: Record<string, unknown>): Record<string, unknown> {
    const out = clone(doc);
    ((out["fingerprint"] as Record<string, unknown>)["inputs"] as Record<string, unknown>)["evidence_digest"] =
      evidenceDigest(out, DOMAIN);
    return out;
  }

  function moved(doc: Record<string, unknown>, start: number, end: number): Record<string, unknown> {
    const out = clone(doc);
    (out["evidence"] as Array<Record<string, any>>)[0]!["location"]["line_range"] = { start, end };
    return out;
  }

  function issuesFor(doc: Record<string, unknown>, schemaText?: string) {
    const root = makeTree({
      "catalog.yaml": CATALOG,
      ...shippedSchemas(),
      ...(schemaText === undefined ? {} : { "schemas/finding.schema.json": schemaText }),
      "templates/finding.json": JSON.stringify(doc),
    });
    const { catalog } = loadCatalog(root);
    return checkDocumentRules({ root, catalog: catalog! }).filter((i) => i.file === "templates/finding.json");
  }

  function rulesFor(doc: Record<string, unknown>, schemaText?: string): string[] {
    return rulesOf(issuesFor(doc, schemaText));
  }

  /** The shipped finding schema with `fields` widened by one member. */
  function schemaWithField(field: string): string {
    const schema = JSON.parse(readFileSync(join(SCHEMAS_DIR, "finding.schema.json"), "utf8"));
    const node =
      schema.properties.fingerprint.properties.inputs.properties.evidence_digest["x-digest-domain"];
    node.fields = [...node.fields, field];
    return JSON.stringify(schema);
  }

  test("a digest taken over the stated domain is accepted", () => {
    expect(rulesFor(sealed(base()))).not.toContain(RULE);
  });

  test("the same evidence at a different line keeps the digest, and the rule stays silent", () => {
    const at24 = sealed(base());
    const at33 = moved(at24, 33, 60);
    expect(evidenceDigest(at33, DOMAIN)).toBe(evidenceDigest(at24, DOMAIN));
    expect(rulesFor(at33)).not.toContain(RULE);
  });

  test("different evidence at the same line changes the digest, and the rule reports", () => {
    const at24 = sealed(base());
    const reworded = clone(at24);
    (reworded["evidence"] as Array<Record<string, unknown>>)[0]!["observation"] =
      "the tenant argument is read and then discarded";
    expect(evidenceDigest(reworded, DOMAIN)).not.toBe(evidenceDigest(at24, DOMAIN));
    expect(rulesFor(reworded)).toContain(RULE);
  });

  test("a domain widened to a line-bearing member inverts the guarantee, and says so", () => {
    // The failure this rule exists to make visible. Under the widened domain a
    // moved line is a different finding, which is release scenario 9 enforced
    // backwards -- and the tree cannot reach that state quietly, because every
    // finding sealed under the stated domain stops matching the moment the
    // domain moves.
    const at24 = sealed(base());
    expect(rulesFor(at24, schemaWithField("location.line_range"))).toContain(RULE);
    expect(rulesFor(moved(at24, 33, 60), schemaWithField("location.line_range"))).toContain(RULE);
  });

  test("a schema that states no domain is an error rather than a silence", () => {
    const schema = JSON.parse(readFileSync(join(SCHEMAS_DIR, "finding.schema.json"), "utf8"));
    delete schema.properties.fingerprint.properties.inputs.properties.evidence_digest["x-digest-domain"];
    // The document is sealed, so a rule that reported a mismatch here would be
    // reporting the wrong thing and this test would not know the difference.
    // What it has to name is the absent annotation.
    const reported = issuesFor(sealed(base()), JSON.stringify(schema)).filter((i) => i.rule === RULE);
    expect(reported).toHaveLength(1);
    expect(reported[0]!.message).toContain("declares no");
    expect(reported[0]!.message).toContain("x-digest-domain");
  });
});

describe("lesson rules", () => {
  test("a well-formed lesson produces no lesson issues", () => {
    expect(rulesOf(run(lesson())).filter((r) => r.startsWith("lesson."))).toEqual([]);
  });

  test("lesson.duplicate-of-an-existing-lesson-is-refused catches a restated lesson", () => {
    const twin = lesson({ id: "lesson-2", title: "same ground" });
    expect(rulesOf(run(lesson(), [twin]))).toContain("lesson.duplicate-of-an-existing-lesson-is-refused");
  });

  test("lesson.skill-rollback-preserves-lesson-and-evidence-history catches a rollback that erased the evidence", () => {
    const doc = lesson({ evidence: [], skill_changes: [{ skill: "super-review", state: "rolled-back" }] });
    expect(rulesOf(run(doc))).toContain("lesson.skill-rollback-preserves-lesson-and-evidence-history");
  });

  test("lesson.skill-rollback-preserves-lesson-and-evidence-history catches a lesson retired by the rollback", () => {
    const doc = lesson({
      status: "retired",
      supersession: { action: "retire", reason: "skill revision was rolled back", at: "2026-09-19T00:00:00Z" },
      skill_changes: [{ skill: "super-review", state: "rolled-back" }],
    });
    expect(rulesOf(run(doc))).toContain("lesson.skill-rollback-preserves-lesson-and-evidence-history");
  });
});

// ---------------------------------------------------------------- project ---

function project(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return envelope("project", "project-1", {
    status: "active",
    identity: {
      id: "demo",
      name: "Demo",
      repos: [
        { repo: "app", role: "application", default_branch: "main" },
        { repo: "kb", role: "knowledgebase", default_branch: "main" },
      ],
    },
    kb: { ownership: "central", root: "kb", project_path: "projects/demo" },
    standards: [],
    limits: { fix_cycles: 2, consensus_rounds: 3, scout_turns: 4 },
    guidance: {
      pr_size: { target_changed_lines: 400, enforcement: "advisory" },
      test_pyramid: { unit_percent: 70, integration_percent: 20, end_to_end_percent: 10, enforcement: "advisory" },
      exceptions: [],
    },
    tracker_policy: { system_of_record: { system: "tracker" }, policy: "one record" },
    ...extra,
  });
}

describe("project rules", () => {
  test("a well-formed project produces no project issues", () => {
    expect(rulesOf(run(project())).filter((r) => r.startsWith("project."))).toEqual([]);
  });

  test("project.kb-root-is-not-an-application-local-docs-tree catches an application-local docs root", () => {
    expect(rulesOf(run(project({ kb: { ownership: "central", root: "docs/solutions", project_path: "demo" } })))).toContain(
      "project.kb-root-is-not-an-application-local-docs-tree",
    );
  });

  test("project.test-pyramid-percentages-sum-to-100 catches a pyramid that does not sum", () => {
    const doc = project({
      guidance: {
        pr_size: { target_changed_lines: 400, enforcement: "advisory" },
        test_pyramid: { unit_percent: 70, integration_percent: 20, end_to_end_percent: 30, enforcement: "advisory" },
        exceptions: [],
      },
    });
    expect(rulesOf(run(doc))).toContain("project.test-pyramid-percentages-sum-to-100");
  });

  test("project.numeric-guidance-never-becomes-a-gate catches guidance promoted into a blocking constraint", () => {
    const doc = project({
      mandatory_constraints: [
        { id: "pr-size-gate", requirement: "pr_size target_changed_lines is a hard limit", evidence_required: ["diff"], blocks: "ship" },
      ],
    });
    expect(rulesOf(run(doc))).toContain("project.numeric-guidance-never-becomes-a-gate");
  });

  test("project.single-tracker-system-of-record catches a mirror claiming the same system", () => {
    const doc = project({
      tracker_policy: {
        system_of_record: { system: "tracker" },
        mirrors: [{ system: "tracker", role: "projection" }],
        policy: "one record",
      },
    });
    expect(rulesOf(run(doc))).toContain("project.single-tracker-system-of-record");
  });

  test("project.standards-path-resolves-or-lane-returns-empty is checked against the tree", () => {
    const root = makeTree({
      "catalog.yaml": "schema_version: 1\npackage:\n  id: ak\n  name: ak\n  version: 0.1.0\n  namespace: \"/ak:\"\n  default_profile: core\n",
      "templates/project.json": JSON.stringify(
        project({ standards: [{ id: "style", path: "docs/style.md", applies_to: ["**/*.ts"] }] }),
      ),
    });
    const { catalog } = loadCatalog(root);
    const issues = checkDocumentRules({ root, catalog: catalog! });
    expect(rulesOf(issues)).toContain("project.standards-path-resolves-or-lane-returns-empty");
  });
});

// ----------------------------------------------------------------- review ---

function review(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return envelope("review", "review-1", {
    status: "complete",
    mode: "full",
    comparison_base: { repo: "app", revision: "a".repeat(40) },
    reviewed_head: { repo: "app", revision: "b".repeat(40) },
    snapshot: { hash: `sha256:${"a".repeat(64)}`, immutable: true, reviewers_may_edit_source: false },
    authorship: { implementer: "builder", spec_approver: "planner" },
    lanes: [
      {
        role: "code-review/correctness",
        required: true,
        state: "covered",
        verdict: "approve",
        seat: { filled_by: "reviewer-a", independent_of_author: true },
      },
      {
        role: "code-review/security",
        required: true,
        state: "covered",
        verdict: "approve",
        seat: { filled_by: "reviewer-b", independent_of_author: true },
      },
    ],
    fix_cycles: { allowed: 2, used: 0 },
    verdict: "approved",
    ...extra,
  });
}

describe("review rules", () => {
  test("a well-formed review produces no review issues", () => {
    expect(rulesOf(run(review())).filter((r) => r.startsWith("review."))).toEqual([]);
  });

  test("review.seat-filled-by-someone-other-than-the-author catches the implementer in a seat", () => {
    const doc = review();
    ((doc["lanes"] as Record<string, unknown>[])[0]!["seat"] as Record<string, unknown>)["filled_by"] = "builder";
    expect(rulesOf(run(doc))).toContain("review.seat-filled-by-someone-other-than-the-author");
  });

  test("review.security-seat-not-filled-by-implementer-or-spec-approver catches the spec approver on security", () => {
    const doc = review();
    ((doc["lanes"] as Record<string, unknown>[])[1]!["seat"] as Record<string, unknown>)["filled_by"] = "planner";
    expect(rulesOf(run(doc))).toContain("review.security-seat-not-filled-by-implementer-or-spec-approver");
  });

  test("review.unavailable-required-lane-blocks-approval catches an approval over an unavailable lane", () => {
    const doc = review();
    const lane = (doc["lanes"] as Record<string, unknown>[])[1]!;
    lane["state"] = "unavailable";
    lane["verdict"] = "no-opinion";
    lane["reason"] = "no seat";
    expect(rulesOf(run(doc))).toContain("review.unavailable-required-lane-blocks-approval");
  });

  test("review.third-fix-cycle-stops catches a third cycle", () => {
    expect(rulesOf(run(review({ fix_cycles: { allowed: 2, used: 3 } })))).toContain("review.third-fix-cycle-stops");
  });

  test("review.third-fix-cycle-stops catches an exhausted run that still approves", () => {
    const doc = review({ fix_cycles: { allowed: 2, used: 2 } });
    expect(rulesOf(run(doc))).toContain("review.third-fix-cycle-stops");
  });

  test("review.delta-scope-bounded-by-affected-behavior catches a delta with no affected behavior", () => {
    const doc = review({ mode: "delta", verdict: "changes-requested" });
    expect(rulesOf(run(doc))).toContain("review.delta-scope-bounded-by-affected-behavior");
  });

  test("review.delta-scope-bounded-by-affected-behavior catches an excluded untouched caller", () => {
    const doc = review({
      mode: "delta",
      verdict: "changes-requested",
      delta_scope: { boundary: "affected-behavior", affected_behavior: ["login"], excluded: ["callers"] },
      new_findings: [{ finding: { id: "finding-9", hash: `sha256:${"a".repeat(64)}` }, novelty_evidence: [{ ref: "e" }], in_untouched_caller: true }],
    });
    expect(rulesOf(run(doc))).toContain("review.delta-scope-bounded-by-affected-behavior");
  });

  test("review.material-change-establishes-a-new-baseline catches a reset that invalidated nothing", () => {
    const doc = review({
      baseline_reset: { reason: "requirements-changed", invalidated_approvals: [], new_scope: true },
      verdict: "changes-requested",
    });
    expect(rulesOf(run(doc))).toContain("review.material-change-establishes-a-new-baseline");
  });

  test("review.material-change-establishes-a-new-baseline catches a reset that kept the old fix cycles", () => {
    const doc = review({
      baseline_reset: {
        reason: "architecture-changed",
        invalidated_approvals: [{ id: "approval-1", hash: `sha256:${"a".repeat(64)}` }],
        new_scope: true,
      },
      fix_cycles: { allowed: 2, used: 2 },
      verdict: "changes-requested",
    });
    expect(rulesOf(run(doc))).toContain("review.material-change-establishes-a-new-baseline");
  });
});

// ----------------------------------------------------------- verification ---

function verification(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return envelope("verification", "verification-1", {
    status: "passed",
    kind: "command",
    command: { argv: ["bun", "test"] },
    exit_status: 0,
    output_digest: `sha256:${"a".repeat(64)}`,
    source_revision: { repo: "app", revision: "b".repeat(40) },
    environment: { id: "ci", isolated: true, secrets_policy: "none" },
    supports: ["AC-1"],
    ...extra,
  });
}

describe("verification rules", () => {
  test("a well-formed receipt produces no verification issues", () => {
    expect(rulesOf(run(verification())).filter((r) => r.startsWith("verification."))).toEqual([]);
  });

  test("verification.check-names-ticket-verification rejects an instrument the ticket did not name", () => {
    const ref = { id: "ticket-1", schema: "ticket", hash: `sha256:${"a".repeat(64)}` };
    const ticket = envelope("ticket", "ticket-1", { verification: [{ id: "project-check" }] });
    const doc = verification({ check: "another-check", ticket: ref });
    expect(rulesOf(run(doc, [ticket]))).toContain("verification.check-names-ticket-verification");
    expect(rulesOf(run(verification({ check: "project-check", ticket: ref }), [ticket]))).not.toContain(
      "verification.check-names-ticket-verification",
    );
  });

  test("verification.prose-never-substitutes-for-exit-status-and-digest catches a narrative pass", () => {
    const doc = verification({ exit_status: undefined, output_digest: undefined, notes: "tests were green" });
    delete doc["exit_status"];
    delete doc["output_digest"];
    expect(rulesOf(run(doc))).toContain("verification.prose-never-substitutes-for-exit-status-and-digest");
  });

  test("verification.prose-never-substitutes-for-exit-status-and-digest catches a pass with a non-zero exit", () => {
    expect(rulesOf(run(verification({ exit_status: 1 })))).toContain(
      "verification.prose-never-substitutes-for-exit-status-and-digest",
    );
  });

  // The rule's first clause used to ask whether an entry named a decision at
  // all, which the schema already requires of every entry, so the only documents
  // it could report on were ones ajv had already rejected naming the same field.
  // Not dead -- the case below pins that document rules do run on documents that
  // fail schema validation -- but worth nothing, which is the harder thing to
  // see. It now resolves the reference, and these are the three ways that
  // resolution fails. A weakening authorized by nobody,
  // one citing an id nobody wrote, and one citing a checkpoint that blocked are
  // the same document to a shape check.
  const weakened = (id: string) => [
    { what: "assertion-weakened", detail: "dropped an assert", decision: { id, hash: `sha256:${"a".repeat(64)}` } },
  ];

  test("verification.weakened-check-requires-its-own-decision catches a decision that matches no artifact", () => {
    const doc = verification({ status: "failed", weakened_checks: weakened("decision-99") });
    expect(rulesOf(run(doc))).toContain("verification.weakened-check-requires-its-own-decision");
  });

  test("verification.weakened-check-requires-its-own-decision catches a reference to something that is not a decision", () => {
    const doc = verification({ status: "failed", weakened_checks: weakened("ticket-1") });
    const other = envelope("ticket", "ticket-1", { status: "done" });
    expect(rulesOf(run(doc, [other]))).toContain("verification.weakened-check-requires-its-own-decision");
  });

  test("verification.weakened-check-requires-its-own-decision catches a decision that did not decide", () => {
    const doc = verification({ status: "failed", weakened_checks: weakened("decision-1") });
    const blocked = decision({ ruling: { outcome: "blocked", at: "2026-09-19T00:00:00Z", recorded_by: "policy" } });
    expect(rulesOf(run(doc, [blocked]))).toContain("verification.weakened-check-requires-its-own-decision");
  });

  test("verification.weakened-check-requires-its-own-decision accepts a failed receipt whose weakening was decided", () => {
    const doc = verification({ status: "failed", weakened_checks: weakened("decision-1") });
    expect(rulesOf(run(doc, [decision()]))).not.toContain("verification.weakened-check-requires-its-own-decision");
  });

  // The premise the comment above rests on, measured rather than assumed. It is
  // easy to reason that a clause restating a schema `required` can never run,
  // and that reasoning would be a licence to delete clauses that do run.
  // `loadTemplateDocuments` filters on shape -- parseable, a mapping, a string
  // `schema` -- and never on validity, so an ajv-invalid document reaches every
  // document rule. A clause whose guard is a schema `required` is therefore
  // redundant, not dead, and the difference decides whether deleting one is
  // safe.
  test("document rules run on a document that fails schema validation", () => {
    // Built here rather than from `envelope`, which sets `project` to a string
    // where the schema wants an object -- so every other fixture in this file is
    // schema-invalid, and an assertion that ajv objected would be satisfied by
    // the fixture instead of by the defect. This document validates clean except
    // for the one thing added to it.
    const valid = {
      schema: "verification",
      schema_version: 1,
      id: "verification-1",
      project: { id: "demo" },
      run_id: null,
      created_by: { role: "runner" },
      inputs: [],
      source_revision: { repo: "app", revision: "b".repeat(40) },
      created_at: "2026-09-19T00:00:00Z",
      status: "passed",
      kind: "command",
      command: { argv: ["bun", "test"] },
      exit_status: 0,
      output_digest: `sha256:${"a".repeat(64)}`,
      environment: { id: "ci", isolated: true, secrets_policy: "none" },
      supports: ["AC-1"],
    };
    const tree = (doc: Record<string, unknown>) => {
      const root = makeTree({
        "catalog.yaml": CATALOG,
        ...shippedSchemas(),
        "templates/verification.json": JSON.stringify(doc),
        "templates/decision.json": JSON.stringify({ ...decision(), project: { id: "demo" } }),
      });
      const { catalog } = loadCatalog(root);
      const ctx = { root, catalog: catalog! };
      return {
        ajv: checkSchemas(ctx).filter((i) => i.file === "templates/verification.json" && i.severity === "error"),
        rules: rulesOf(checkDocumentRules(ctx).filter((i) => i.file === "templates/verification.json")),
      };
    };

    // The control: without it, a later ajv error could be the fixture rotting
    // rather than the defect, and this case would go on passing either way.
    expect(tree({ ...valid, weakened_checks: weakened("decision-1") }).ajv).toEqual([]);

    // Two independent defects in one file: an `exit_status` the schema rejects,
    // and a weakening on a passed receipt that only the document rule sees.
    const both = tree({ ...valid, exit_status: 1, weakened_checks: weakened("decision-1") });
    expect(both.ajv.length).toBeGreaterThan(0);
    expect(both.rules).toContain("verification.weakened-check-requires-its-own-decision");
  });

  test("verification.weakened-check-requires-its-own-decision catches a pass obtained by weakening", () => {
    const doc = verification({ weakened_checks: weakened("decision-1") });
    expect(rulesOf(run(doc, [decision()]))).toContain("verification.weakened-check-requires-its-own-decision");
  });

  test("verification.receipt-stale-when-revision-differs-from-head catches an unmarked stale receipt", () => {
    const receipt = verification({ source_revision: { repo: "app", revision: "c".repeat(40) } });
    const rev = review({
      packet: {
        prior_review: { id: "review-0", hash: `sha256:${"a".repeat(64)}` },
        original_findings: [{ id: "finding-1", hash: `sha256:${"a".repeat(64)}` }],
        fix_diff: `sha256:${"a".repeat(64)}`,
        verification_receipts: [{ id: "verification-1", hash: `sha256:${"a".repeat(64)}` }],
      },
    });
    expect(rulesOf(run(receipt, [rev]))).toContain("verification.receipt-stale-when-revision-differs-from-head");
  });
});
