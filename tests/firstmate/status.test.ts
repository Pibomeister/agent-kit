/**
 * `ak firstmate status complete` and `status --verify`: done is audited, not taken on the worker's word.
 *
 * Label: mock/contract. Every case binds a task in a temp Firstmate home (./fixture.ts) with a temp
 * ledger and a temp mock evidence store, runs the grants through the real `ak firstmate grant`, and
 * records gates through the real `ak lifecycle record`, the way a bound worker does.
 *
 * The two "replay" cases restate practice runs 1 and 2 of ADR-0002's worker plan in the gate-record
 * format. Those runs predate the format, so their stores held free-form files; the replay keeps which
 * phases left evidence (run 1: build check, verify receipt, full review, readiness, dry-run ship;
 * run 2: the dry-run ship alone) and records exactly those gates.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { runCli } from "../../src/cli.ts";
import { bind } from "../../src/firstmate/bind.ts";
import { auditRun } from "../../src/firstmate/audit.ts";
import { runFirstmate } from "../../src/firstmate/cli.ts";
import { DEFAULT_GATES } from "../../src/firstmate/constants.ts";
import { grantRecordPath } from "../../src/firstmate/grant.ts";
import { FIXED_NOW, gitIn, makeBundle, makeDir, makeHome, makeProject, REPO } from "./fixture.ts";

const OPERATIONS = ["review.full", "review.readiness", "ship.prepare"] as const;

function bound() {
  const { home, upstream } = makeHome({ patched: true });
  const project = makeProject();
  const ledger = makeDir();
  const store = makeDir();
  const bindingPath = join(home, "data", "T-S", "binding.json");
  const r = bind(
    {
      fmHome: home,
      taskId: "T-S",
      project,
      mode: "agent-kit",
      bindingOut: bindingPath,
      host: "claude-code",
      evidence: { store: "mock", location: store },
    },
    { akRoot: REPO, bundleDir: makeBundle(), pinsDir: makeDir(), ledgerDir: ledger, upstream, now: FIXED_NOW },
  );
  if (!r.ok) throw new Error(r.errors.join("\n"));
  const binding = r.binding!;
  const fm = (...argv: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = runFirstmate(argv, { out: (l) => out.push(l), err: (l) => err.push(l) }, ledger);
    return { code, out, err: err.join("\n") };
  };
  const grants = (...ops: string[]) => {
    for (const op of ops)
      expect(fm("grant", "--binding", bindingPath, "--operation", op, "--cwd", project).code).toBe(0);
  };
  const record = (...gates: string[]) => {
    for (const gate of gates) {
      const argv = ["lifecycle", "record", "--gate", gate, "--run", binding.run_id, "--dir", store];
      expect(runCli(argv, { cwd: project, io: { out: () => {}, err: () => {} } })).toBe(0);
    }
  };
  return { project, store, ledger, bindingPath, binding, fm, grants, record };
}

describe("ak firstmate status complete is audited", () => {
  test("bind requires build-checks, so a worker that skips super-build cannot report done", () => {
    const { binding } = bound();
    expect(binding.required_gates).toEqual([...DEFAULT_GATES]);
    expect(binding.required_gates).toContain("build-checks");
  });

  test("a run with every gate current and every grant matching prints done, and --verify agrees", () => {
    const { bindingPath, binding, fm, grants, record } = bound();
    grants(...OPERATIONS);
    record(...binding.required_gates);
    const done = fm("status", bindingPath, "complete", "--evidence", "v1,r1", "--at", "7");
    expect(done.err).toMatch(/^deprecated:[^\n]*$/);
    expect(done.out).toEqual(["done [at=7]: dry-run ship prepared, nothing published evidence=v1,r1"]);
    const verified = fm("status", bindingPath, "--verify");
    expect(verified.code).toBe(0);
    expect(verified.out[0]).toContain(`verified: run ${binding.run_id}`);
  });

  test("replay of practice run 2, where only the dry-run ship left evidence, is refused", () => {
    const { bindingPath, fm, grants, record } = bound();
    grants(...OPERATIONS);
    record("ship-preflight");
    const r = fm("status", bindingPath, "complete", "--evidence", "ship-dry-run");
    expect(r.code).toBe(1);
    expect(r.out).toEqual([]);
    for (const gate of ["build-checks", "verify", "review-full", "review-readiness"]) {
      expect(r.err).toContain(`refused: gate ${gate} has no current evidence`);
    }
    expect(r.err).toContain("needs-decision: this run is not done");
  });

  test("replay of practice run 1, where every phase left evidence, passes", () => {
    const { bindingPath, fm, grants, record } = bound();
    grants(...OPERATIONS);
    record("build-checks", "verify", "review-full", "review-readiness", "ship-preflight");
    expect(
      fm(
        "status",
        bindingPath,
        "complete",
        "--evidence",
        "build-check,verify-receipt,review-full,review-readiness,ship-dry-run",
      ).code,
    ).toBe(0);
  });

  test("the head is the one ship-preflight names: an edit after ship does not undo done, an edit before it does", () => {
    const { project, bindingPath, binding, fm, grants, record } = bound();
    grants(...OPERATIONS);
    record(...binding.required_gates.filter((g) => g !== "ship-preflight"));
    writeFileSync(join(project, "src/a.ts"), "export const a = 9;\n"); // changed after review, before ship
    record("ship-preflight");
    const r = fm("status", bindingPath, "--verify");
    expect(r.code).toBe(1);
    expect(r.err).toContain("refused: gate verify has no current evidence");
    record("verify", "review-delta", "review-readiness");
    expect(fm("status", bindingPath, "--verify").code).toBe(0);
    writeFileSync(join(project, "src/a.ts"), "export const a = 10;\n"); // after ship: not what was shipped
    expect(fm("status", bindingPath, "--verify").code).toBe(0);
  });

  test("a run the supervisor has since merged into main still verifies", () => {
    const { project, bindingPath, binding, fm, grants, record } = bound();
    grants(...OPERATIONS);
    gitIn(project, "checkout", "-q", "-b", "fm/T-S");
    writeFileSync(join(project, "src/a.ts"), "export const a = 2;\n");
    record("build-checks");
    gitIn(project, "commit", "-qam", "build");
    record(...binding.required_gates.filter((g) => g !== "build-checks"));
    expect(fm("status", bindingPath, "--verify").code).toBe(0);
    gitIn(project, "checkout", "-q", "main");
    gitIn(project, "merge", "-q", "--no-ff", "-m", "merge", "fm/T-S");
    gitIn(project, "checkout", "-q", "fm/T-S");
    const r = fm("status", bindingPath, "--verify");
    expect(r.err).toMatch(/^deprecated:[^\n]*$/);
    expect(r.code).toBe(0);
  });

  test("a gate that ran without its grant is refused", () => {
    const { bindingPath, binding, fm, grants, record } = bound();
    grants("review.full", "ship.prepare");
    record(...binding.required_gates);
    const r = fm("status", bindingPath, "--verify");
    expect(r.code).toBe(1);
    expect(r.err).toContain("refused: grant review.readiness has no record");
  });

  test("a tampered grant record is detected", () => {
    const { bindingPath, binding, fm, grants, record } = bound();
    grants(...OPERATIONS);
    record(...binding.required_gates);
    const path = grantRecordPath(binding, "review.full");
    const g = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(path, JSON.stringify({ ...g, binding_sha256: `sha256:${"0".repeat(64)}` }));
    const r = fm("status", bindingPath, "complete", "--evidence", "x");
    expect(r.code).toBe(1);
    expect(r.err).toContain("refused: grant review.full names binding hash sha256:0000");
  });

  for (const [field, value, refusal] of [
    ["run_id", "another-run", "refused: grant review.full is for run another-run, not "],
    [
      "binding",
      "/elsewhere/binding.json",
      "refused: grant review.full names binding /elsewhere/binding.json, not the registered ",
    ],
  ] as const) {
    test(`a grant record whose ${field} alone was tampered is detected`, () => {
      const { bindingPath, binding, fm, grants, record } = bound();
      grants(...OPERATIONS);
      record(...binding.required_gates);
      expect(fm("status", bindingPath, "complete", "--evidence", "x").code).toBe(0);
      const path = grantRecordPath(binding, "review.full");
      writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), [field]: value }));
      const r = fm("status", bindingPath, "complete", "--evidence", "x");
      expect(r.code).toBe(1);
      expect(r.err).toContain(refusal);
    });
  }

  test("a ledger entry registered at another binding path is detected", () => {
    const { bindingPath, binding, ledger, fm, grants, record } = bound();
    grants(...OPERATIONS);
    record(...binding.required_gates);
    const entry = join(ledger, `${binding.run_id}.json`);
    writeFileSync(
      entry,
      JSON.stringify({ ...JSON.parse(readFileSync(entry, "utf8")), binding_path: "/elsewhere/binding.json" }),
    );
    const r = fm("status", bindingPath, "--verify");
    expect(r.code).toBe(1);
    expect(r.err).toContain("is not the /elsewhere/binding.json the ledger registered");
  });

  test("a binding naming a store other than the mock is refused before anything is read", () => {
    const { bindingPath, binding, ledger, grants, record } = bound();
    grants(...OPERATIONS);
    record(...binding.required_gates);
    expect(auditRun({ binding, bindingPath, ledgerDir: ledger })).toEqual([]);
    const knowledgebase = { ...binding, evidence: { ...binding.evidence, store: "kb" as const } };
    expect(auditRun({ binding: knowledgebase, bindingPath, ledgerDir: ledger })).toEqual([
      "refused: evidence store kb cannot be read: the knowledgebase fails closed (CONTRACT.md §1)",
    ]);
  });

  test("a binding edited by hand after bind is detected", () => {
    const { bindingPath, binding, fm, grants, record } = bound();
    grants(...OPERATIONS);
    record(...binding.required_gates);
    writeFileSync(
      bindingPath,
      `${JSON.stringify({ ...binding, required_gates: ["verify", "ship-preflight"] }, null, 2)}\n`,
    );
    const r = fm("status", bindingPath, "--verify");
    expect(r.code).toBe(1);
    expect(r.err).toContain("not the sha256:");
    expect(r.err).toContain("the ledger registered");
  });

  test("an evidence store that was wiped refuses every gate", () => {
    const { store, bindingPath, binding, fm, grants, record } = bound();
    grants(...OPERATIONS);
    record(...binding.required_gates);
    rmSync(join(store, binding.run_id), { recursive: true, force: true });
    const r = fm("status", bindingPath, "--verify");
    expect(r.code).toBe(1);
    expect(r.err).toContain("refused: gate ship-preflight has no current evidence");
  });

  test("outcomes other than complete are not audited, and --verify takes no outcome", () => {
    const { bindingPath, fm } = bound();
    expect(fm("status", bindingPath, "needs-input", "--reason", "which base").code).toBe(0);
    expect(fm("status", bindingPath, "complete", "--verify").code).toBe(2);
  });
});
