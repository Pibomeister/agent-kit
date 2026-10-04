/**
 * `ak firstmate grant`: the Firstmate binding as the delegated grant (ADR-0004).
 *
 * Label: mock/contract. Every case binds a task in a temp Firstmate home built by
 * ./fixture.ts, with a temp binding ledger, then asks the real `ak firstmate` entry for a grant.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { runCli } from "../../src/cli.ts";
import { bind } from "../../src/firstmate/bind.ts";
import { runFirstmate } from "../../src/firstmate/cli.ts";
import { ENV_FILE, type LedgerRecord } from "../../src/firstmate/constants.ts";
import { takeSnapshot } from "../../src/lifecycle/gate.ts";
import { artifactHash } from "../../src/util/hash.ts";
import { FIXED_NOW, makeBundle, makeDir, makeHome, makeProject, REPO } from "./fixture.ts";

const sha256 = (bytes: string | Buffer) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

function bound(opts: { taskId?: string; out?: (home: string, worktree: string) => string } = {}) {
  const taskId = opts.taskId ?? "T-G";
  const { home, upstream } = makeHome({ patched: true });
  const project = makeProject();
  // The worker's worktree: a checkout of its own, apart from the Firstmate home.
  const worktree = makeProject();
  const ledger = makeDir();
  const bindingPath = opts.out?.(home, worktree) ?? join(home, "data", taskId, "binding.json");
  const r = bind(
    {
      fmHome: home,
      taskId,
      project,
      mode: "agent-kit",
      bindingOut: bindingPath,
      host: "claude-code",
      evidence: { store: "mock", location: makeDir() },
    },
    { akRoot: REPO, bundleDir: makeBundle(), pinsDir: makeDir(), ledgerDir: ledger, upstream, now: FIXED_NOW },
  );
  if (!r.ok) throw new Error(r.errors.join("\n"));
  return { home, project, worktree, ledger, bindingPath, binding: r.binding! };
}

/** Write a binding and register it in the ledger, as a Firstmate re-bind would. */
function rewrite(ledger: string, bindingPath: string, binding: { run_id: string; task_id: string }) {
  const text = JSON.stringify(binding);
  mkdirSync(dirname(bindingPath), { recursive: true });
  writeFileSync(bindingPath, text);
  const record: LedgerRecord = {
    run_id: binding.run_id,
    task_id: binding.task_id,
    binding_path: realpathSync(bindingPath),
    binding_sha256: sha256(text),
  };
  writeFileSync(join(ledger, `${binding.run_id}.json`), JSON.stringify(record));
}

function grant(ledger: string, bindingPath: string, operation: string, cwd: string) {
  const out: string[] = [];
  const err: string[] = [];
  const code = runFirstmate(
    ["grant", "--binding", bindingPath, "--operation", operation, "--cwd", cwd],
    { out: (l) => out.push(l), err: (l) => err.push(l) },
    ledger,
  );
  return { code, out, err };
}

function refused(r: { code: number; out: string[]; err: string[] }, reason: RegExp) {
  expect(r.code).not.toBe(0);
  expect(r.out).toEqual([]);
  expect(r.err[0]).toMatch(reason);
  expect(r.err.join("\n")).toContain("needs-decision");
}

describe("ak firstmate grant", () => {
  test("grants each operation the binding covers and prints the grant record", () => {
    const { worktree, ledger, bindingPath, binding } = bound();
    const sha = sha256(readFileSync(bindingPath));
    expect(JSON.parse(readFileSync(join(ledger, `${binding.run_id}.json`), "utf8"))).toEqual({
      run_id: binding.run_id,
      task_id: binding.task_id,
      binding_path: realpathSync(bindingPath),
      binding_sha256: sha,
    });
    for (const operation of ["review.full", "review.readiness", "ship.prepare"]) {
      const r = grant(ledger, bindingPath, operation, worktree);
      expect(r.err).toEqual([]);
      expect(r.code).toBe(0);
      expect(JSON.parse(r.out.join("\n"))).toEqual({
        operation,
        binding: bindingPath,
        binding_sha256: sha,
        task_id: binding.task_id,
        run_id: binding.run_id,
        granted_by: "firstmate-binding",
      });
    }
  });

  test("a host-unattested verifier receipt ships by hand until the run holds a delegated grant", () => {
    const { project, worktree, ledger, bindingPath, binding } = bound();
    const store = binding.evidence.location;
    const lifecycle = (...argv: string[]) => {
      const out: string[] = [];
      const err: string[] = [];
      const code = runCli(["lifecycle", ...argv, "--dir", store], {
        cwd: project,
        io: { out: (l) => out.push(l), err: (l) => err.push(l) },
      });
      return { code, out: out.join("\n"), err: err.join("\n") };
    };
    const recipe = { id: "service-runtime", hash: `sha256:${"1".repeat(64)}` };
    const ticket = {
      schema: "ticket",
      schema_version: 1,
      id: binding.task_id,
      acceptance_criteria: [{ id: "AC-1", text: "The service answers health requests.", surface: "backend" }],
      verification: [
        {
          id: "project-check",
          check: "Exercise the running service.",
          kind: "command",
          supports: ["AC-1"],
          recipe,
          evidence_required: ["smoke-test"],
        },
      ],
      approvals: [{ role: "human", approved_at: "2026-09-29T00:00:00Z" }],
    };
    const ticketPath = join(makeDir(), "ticket.json");
    writeFileSync(ticketPath, `${JSON.stringify(ticket)}\n`);
    const run = lifecycle("open", "--ticket", ticketPath, "--binding", bindingPath).out.match(
      /^opened run (.+)$/m,
    )?.[1];
    if (run === undefined) throw new Error("open did not return a run id");
    for (const gate of ["build-checks", "review-full", "review-readiness"])
      expect(lifecycle("record", "--gate", gate, "--run", run).code).toBe(0);
    const snapshot = takeSnapshot(project);
    if (typeof snapshot === "string") throw new Error(snapshot);
    const receiptDir = makeDir();
    const log = "1 pass, 0 fail\n";
    writeFileSync(join(receiptDir, "verification-output.log"), log);
    const receiptPath = join(receiptDir, "verification-1.json");
    writeFileSync(
      receiptPath,
      `${JSON.stringify({
        schema: "verification",
        schema_version: 1,
        id: "verification-1",
        project: { id: "demo" },
        run_id: run,
        created_by: { role: "verifier" },
        inputs: [],
        source_revision: snapshot,
        created_at: "2026-09-29T00:00:00Z",
        status: "passed",
        kind: "command",
        command: { argv: ["bun", "test"] },
        exit_status: 0,
        output_digest: sha256(log),
        artifacts: [{ path: "verification-output.log", digest: sha256(log), kind: "log" }],
        environment: { id: "test", isolated: true, secrets_policy: "none" },
        supports: ["AC-1"],
        check: "project-check",
        ticket: { id: binding.task_id, schema: "ticket", hash: artifactHash(ticket) },
        recipe,
        evidence_kind: "smoke-test",
        verifier_seat: { id: "verify-1", implementer_seat: "build-1", isolation: "host-unattested", attestation: null },
      })}\n`,
    );
    expect(lifecycle("record", "--gate", "verify", "--receipt", receiptPath, "--run", run).code).toBe(0);
    const byHand = lifecycle("check", "--run", run);
    expect(byHand.err).toContain("note: verifier seat verify-1 on receipt verification-1 is host-unattested");
    expect(byHand.code).toBe(0);
    expect(grant(ledger, bindingPath, "ship.prepare", worktree).code).toBe(0);
    const delegated = lifecycle("check", "--run", run);
    expect(delegated.code).toBe(1);
    expect(delegated.err).toContain(
      `refused: verifier seat verify-1 is host-unattested; autonomous ship requires a runner attestation (the run holds grant record ${join(store, binding.run_id, "grants", "ship.prepare.json")})`,
    );
  }, 120_000);

  test("grants a binding bind wrote under a data-dir override, outside the home", () => {
    const { worktree, ledger, bindingPath } = bound({
      out: () => join(makeDir(), "override-data", "T-G", "agent-kit-binding.json"),
    });
    expect(grant(ledger, bindingPath, "ship.prepare", worktree).code).toBe(0);
  });

  test("refuses a binding inside the worktree the grant is asked from, even from a subdirectory", () => {
    const { worktree, ledger, bindingPath } = bound({ out: (_, wt) => join(wt, "binding.json") });
    refused(grant(ledger, bindingPath, "review.full", worktree), /inside the worktree/);
    mkdirSync(join(worktree, "src"), { recursive: true });
    refused(grant(ledger, bindingPath, "review.full", join(worktree, "src")), /inside the worktree/);
  });

  test("a binding whose name starts with '..' is still inside the worktree", () => {
    const { worktree, ledger, bindingPath } = bound({ out: (_, wt) => join(wt, "..binding.json") });
    refused(grant(ledger, bindingPath, "review.full", worktree), /inside the worktree/);
  });

  test("refuses a binding inside the bound project checkout, even one the ledger names", () => {
    const { project, worktree, ledger, bindingPath, binding } = bound();
    const copy = join(project, "binding.json");
    copyFileSync(bindingPath, copy);
    rewrite(ledger, copy, binding);
    refused(grant(ledger, copy, "review.full", worktree), /inside the project/);
  });

  test("refuses a copied-and-widened binding, and one in a fabricated home", () => {
    const { worktree, ledger, bindingPath } = bound();
    const b = JSON.parse(readFileSync(bindingPath, "utf8"));
    b.required_gates = b.required_gates.filter((g: string) => g !== "ship-preflight");
    rewrite(ledger, bindingPath, b);
    refused(grant(ledger, bindingPath, "ship.prepare", worktree), /ship-preflight/);
    const widened = JSON.stringify({ ...b, required_gates: [...b.required_gates, "ship-preflight"] });

    const loose = join(makeDir(), "b.json");
    writeFileSync(loose, widened);
    refused(grant(ledger, loose, "ship.prepare", worktree), /not the .* ak firstmate bind registered/);

    // A home-shaped directory with config/agent-kit.env and a matching hash beside the binding.
    const fakeHome = makeDir();
    mkdirSync(join(fakeHome, "config"), { recursive: true });
    writeFileSync(join(fakeHome, ENV_FILE), "");
    const fake = join(fakeHome, "data", b.task_id, "binding.json");
    mkdirSync(dirname(fake), { recursive: true });
    writeFileSync(fake, widened);
    writeFileSync(join(dirname(fake), "agent-kit-binding.sha256"), `${sha256(widened)}\n`);
    refused(grant(ledger, fake, "ship.prepare", worktree), /not the .* ak firstmate bind registered/);
  });

  test("refuses a binding edited in place, and one bind never registered", () => {
    const { worktree, ledger, bindingPath } = bound();
    const b = JSON.parse(readFileSync(bindingPath, "utf8"));
    b.required_gates = b.required_gates.filter((g: string) => g !== "ship-preflight");
    rewrite(ledger, bindingPath, b);
    b.required_gates = [...b.required_gates, "ship-preflight"];
    writeFileSync(bindingPath, JSON.stringify(b));
    refused(grant(ledger, bindingPath, "ship.prepare", worktree), /hashes to/);
    refused(grant(makeDir(), bindingPath, "ship.prepare", worktree), /never registered/);
  });

  test("refuses with the needs-decision hint when the ledger record is corrupt or the wrong shape", () => {
    const { worktree, ledger, bindingPath, binding } = bound();
    const entry = join(ledger, `${binding.run_id}.json`);
    for (const bad of ["{ truncated", "null", JSON.stringify({ run_id: binding.run_id, binding_path: 7 })]) {
      writeFileSync(entry, bad);
      const r = grant(ledger, bindingPath, "review.full", worktree);
      expect(r.code).toBe(1);
      refused(r, /ledger record .* is unreadable/);
    }
  });

  test("bind refuses a '..'-prefixed binding path inside the project", () => {
    const { home, upstream } = makeHome({ patched: true });
    const project = makeProject();
    const opts = {
      akRoot: REPO,
      bundleDir: makeBundle(),
      pinsDir: makeDir(),
      ledgerDir: makeDir(),
      upstream,
      now: FIXED_NOW,
    };
    const r = bind(
      {
        fmHome: home,
        taskId: "T-D",
        project,
        mode: "agent-kit",
        bindingOut: join(project, "..b.json"),
        host: "claude-code",
        evidence: { store: "mock", location: makeDir() },
      },
      opts,
    );
    expect(r.ok).toBe(false);
    expect(r.errors.join("\n")).toContain("inside the project");
  });

  test("refuses an operation whose gate the binding does not require", () => {
    const { worktree, ledger, bindingPath } = bound();
    const b = JSON.parse(readFileSync(bindingPath, "utf8"));
    b.required_gates = ["verify", "review-readiness"];
    rewrite(ledger, bindingPath, b);
    refused(grant(ledger, bindingPath, "review.full", worktree), /review-full/);
    refused(grant(ledger, bindingPath, "ship.prepare", worktree), /ship-preflight/);
    expect(grant(ledger, bindingPath, "review.readiness", worktree).code).toBe(0);
  });

  test("refuses a tampered binding that no longer validates, and one that is not JSON", () => {
    const { worktree, ledger, bindingPath } = bound();
    const b = JSON.parse(readFileSync(bindingPath, "utf8"));
    b.delivery.merge = true;
    rewrite(ledger, bindingPath, b);
    refused(grant(ledger, bindingPath, "ship.prepare", worktree), /does not validate/);
    writeFileSync(bindingPath, "{ not json");
    refused(grant(ledger, bindingPath, "review.full", worktree), /not JSON/);
    refused(grant(ledger, join(makeDir(), "missing.json"), "review.full", worktree), /does not exist/);
  });

  test("refuses when the pinned bundle no longer matches its hash, or is gone", () => {
    const { worktree, ledger, bindingPath, binding } = bound();
    writeFileSync(
      join(binding.skill_bundle.path, "skills/super-ship/SKILL.md"),
      "---\nname: super-ship\n---\nedited\n",
    );
    refused(grant(ledger, bindingPath, "ship.prepare", worktree), /pinned bundle/);

    const b = JSON.parse(readFileSync(bindingPath, "utf8"));
    b.skill_bundle.path = join(makeDir(), "gone");
    rewrite(ledger, bindingPath, b);
    refused(grant(ledger, bindingPath, "review.full", worktree), /pinned bundle/);
  });

  test("refuses an operation that is not on the slip: merge and unknown names", () => {
    const { worktree, ledger, bindingPath } = bound();
    refused(grant(ledger, bindingPath, "merge", worktree), /not an operation/);
    refused(grant(ledger, bindingPath, "review.delta", worktree), /not an operation/);
  });

  test("a missing flag is a usage error", () => {
    const err: string[] = [];
    const code = runFirstmate(["grant", "--operation", "review.full"], { out: () => {}, err: (l) => err.push(l) });
    expect(code).toBe(2);
    expect(err.join("\n")).toContain("--binding is required");
  });
});
