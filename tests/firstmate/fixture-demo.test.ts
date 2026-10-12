/**
 * FIXTURE DEMO — mock evidence store, dry-run ship. Not a lifecycle run.
 *
 * One sample repository taken through ticket → build → verify → review finding
 * → fix → delta closure → dry-run ship, with the artifacts each step leaves
 * written by hand in the shape the skills describe. What this proves is the
 * contract between the pieces: the binding, the snapshot and its diff hash,
 * the schemas the receipts and reviews validate against, the staleness rule,
 * and the status line Firstmate would read. What it does not prove is that a
 * model running the skills produces these artifacts: no worker, no child and
 * no Firstmate ran, and the evidence store is the labeled mock, not a
 * knowledgebase.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { bind } from "../../src/firstmate/bind.ts";
import { MOCK_LABEL } from "../../src/firstmate/constants.ts";
import { checkGates, recordGate, takeSnapshot } from "../../src/lifecycle/gate.ts";
import { statusLine } from "../../src/firstmate/status.ts";
import { compileSchemas } from "../../src/validation/schemas.ts";
import { FIXED_NOW, makeBundle, makeDir, makeHome, makeProject, REPO } from "./fixture.ts";

const schemas = compileSchemas(REPO);

function valid(id: string, doc: unknown): string[] {
  const validate = schemas.validatorFor(id);
  if (validate === undefined) return [`${id} did not compile`];
  return validate(doc) ? [] : (validate.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message}`);
}

const template = (name: string) => JSON.parse(readFileSync(join(REPO, "templates", name), "utf8"));
const sha = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`;

type Snap = { repo: string; revision: string; diff_hash: string };

/** Store a document in the mock evidence store and return its ref. */
function store(dir: string, name: string, body: string): { id: string; hash: string } {
  writeFileSync(join(dir, name), body);
  return { id: name.replace(/\.[a-z]+$/, ""), hash: sha(body) };
}

describe("fixture demo (mock evidence, dry-run): ticket to dry-run ship", () => {
  test("every step leaves an artifact that validates, and the fix makes the first receipt stale", () => {
    const { home, upstream } = makeHome({ patched: true });
    const project = makeProject();
    const evidenceDir = makeDir();
    const opts = {
      akRoot: REPO,
      bundleDir: makeBundle(),
      pinsDir: makeDir(),
      ledgerDir: makeDir(),
      upstream,
      now: FIXED_NOW,
    };

    // Firstmate briefs the task; the patched fm-brief binds it.
    const bound = bind(
      {
        fmHome: home,
        taskId: "demo-1",
        project,
        mode: "agent-kit",
        bindingOut: join(home, "data/demo-1/agent-kit-binding.json"),
        host: "claude-code",
        evidence: { store: "mock", location: evidenceDir },
      },
      opts,
    );
    expect(bound.errors).toEqual([]);
    const binding = bound.binding!;
    expect(binding.delivery.action).toBe("dry-run");
    expect(binding.evidence.label).toBe(MOCK_LABEL);
    const projectRef = { id: binding.project.id, repo: binding.source_snapshot.repo };

    // Build: the implementer's ticket, uncommitted in the worktree.
    writeFileSync(join(project, "src/parse.ts"), "export const parse = (p: string) => p;\n");
    const built = takeSnapshot(project) as Snap;
    expect(typeof built).toBe("object");
    expect(built.diff_hash).not.toBe(binding.source_snapshot.diff_hash);

    // Verify: a receipt bound to the revision and the diff hash.
    const receipt = {
      ...template("verification.example.json"),
      id: "demo-verification-1",
      project: projectRef,
      run_id: binding.run_id,
      source_revision: built,
    };
    delete receipt.ticket;
    delete receipt.finding;
    expect(valid("verification", receipt)).toEqual([]);
    const gateDir = makeDir();
    expect(recordGate({ dir: gateDir, run: binding.run_id, gate: "verify", project }).ok).toBe(true);
    expect(checkGates({ dir: gateDir, run: binding.run_id, gates: ["verify"], project }).ok).toBe(true);

    // Review: the correctness seat finds the empty path accepted. Its raw output
    // goes to the evidence store before synthesis.
    const raw = store(
      evidenceDir,
      "raw-correctness-1.txt",
      "parse('') returns '' instead of rejecting the empty path\n",
    );
    const reviewDoc = template("review.example.json");
    Object.assign(reviewDoc, {
      id: "demo-review-1",
      project: projectRef,
      run_id: binding.run_id,
      source_revision: built,
      comparison_base: binding.source_snapshot,
      reviewed_head: built,
      mode: "full",
      verdict: "changes-requested",
    });
    reviewDoc.lanes[0].raw_output = raw;
    reviewDoc.lanes[0].verdict = "request-changes";
    // A first pass: no delta packet, prior head or continuity to carry.
    const deltaOnly = new Set(["packet", "last_head_verified", "delta_scope", "continuity"]);
    const review = Object.fromEntries(Object.entries(reviewDoc).filter(([key]) => !deltaOnly.has(key)));
    expect(valid("review", review)).toEqual([]);
    store(evidenceDir, "demo-review-1.json", JSON.stringify(review));

    // Fix: the worker's next build cycle. Same revision, different diff: the
    // first receipt no longer describes what is on disk.
    writeFileSync(
      join(project, "src/parse.ts"),
      "export const parse = (p: string) => {\n  if (p === '') throw new Error('empty path');\n  return p;\n};\n",
    );
    const fixed = takeSnapshot(project) as Snap;
    expect(fixed.revision).toBe(built.revision);
    // The gate, not a helper here, decides staleness: the verify record taken at `built` no longer counts.
    const verifyRun = { dir: gateDir, run: binding.run_id, gates: ["verify" as const], project };
    expect(checkGates(verifyRun).refusals).toEqual([
      expect.stringContaining("refused: gate verify has no current evidence (the latest record is for"),
    ]);

    const receipt2 = { ...receipt, id: "demo-verification-2", source_revision: fixed };
    expect(valid("verification", receipt2)).toEqual([]);
    expect(recordGate({ dir: gateDir, run: binding.run_id, gate: "verify", project }).ok).toBe(true);
    expect(checkGates(verifyRun)).toMatchObject({ ok: true, refusals: [] });

    // Delta review closes the finding against the fixed snapshot.
    const rawDelta = store(evidenceDir, "raw-correctness-2.txt", "empty path now throws; no new findings\n");
    const delta = template("review.example.json");
    Object.assign(delta, {
      id: "demo-review-2",
      project: projectRef,
      run_id: binding.run_id,
      source_revision: fixed,
      comparison_base: binding.source_snapshot,
      last_head_verified: built,
      reviewed_head: fixed,
      mode: "delta",
    });
    delta.lanes[0].raw_output = rawDelta;
    expect(valid("review", delta)).toEqual([]);
    store(evidenceDir, "demo-review-2.json", JSON.stringify(delta));

    // Dry-run ship: the line Firstmate reads. Nothing is pushed, no PR opened.
    const line = statusLine(binding, {
      outcome: "complete",
      at: 1790000000,
      evidence: ["demo-verification-2", "demo-review-2"],
    });
    expect(line.ok).toBe(true);
    expect(line.line).toContain("dry-run ship prepared, nothing published");
    expect(line.line).toContain("evidence=demo-verification-2,demo-review-2");

    // A publish line needs a PR, and this binding cannot produce one.
    expect(statusLine({ delivery: { action: "publish" } }, { outcome: "complete", at: 1, evidence: ["x"] }).ok).toBe(
      false,
    );
  });
});
