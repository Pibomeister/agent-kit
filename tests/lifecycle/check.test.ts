/**
 * `ak lifecycle record|check`: the gate records the lifecycle phases leave, and the check super-ship
 * runs before it ships. Standalone only: every case is a plain temp git repository, with no Firstmate
 * home, binding or ledger anywhere.
 */
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "../../src/cli.ts";
import { loadCatalog } from "../../src/catalog/load.ts";
import {
  defaultEvidenceDir,
  PRE_SHIP_GATES,
  readRecords,
  recordGate,
  takeSnapshot,
  type Gate,
  type GateRecord,
} from "../../src/lifecycle/gate.ts";
import { GATE_FILE, planBundle } from "../../src/packaging/plan.ts";
import { artifactHash } from "../../src/util/hash.ts";
import { makeTree } from "../helpers/tree.ts";

// Every case spawns git and the CLI several times, so the 5s default times out on a shared host.
setDefaultTimeout(60_000);

const REPO = join(import.meta.dir, "..", "..");

function git(cwd: string, ...args: string[]): string {
  const p = Bun.spawnSync(["git", ...args], {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.invalid",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.invalid",
    },
  });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`);
  return p.stdout.toString().trim();
}

/** A repository on branch `feature`, one commit in, with the work uncommitted on top as a session leaves it. */
function buildRepo(): string {
  const dir = makeTree({ "src/a.js": "export const a = 1;\n" });
  git(dir, "init", "-q", "-b", "main");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  git(dir, "checkout", "-q", "-b", "feature");
  writeFileSync(join(dir, "src/a.js"), "export const a = 2;\n");
  return dir;
}

// Initializing and committing a repository is pure fixture construction but repeatedly competes
// for subprocess slots on a loaded host. Copy one module-level template for each isolated test.
const REPO_TEMPLATE = buildRepo();

function repo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "ak-lifecycle-repo-")));
  cpSync(REPO_TEMPLATE, dir, { recursive: true });
  return dir;
}

function ak(cwd: string, ...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = runCli(["lifecycle", ...argv], { cwd, io: { out: (l) => out.push(l), err: (l) => err.push(l) } });
  return { code, out, err: err.join("\n") };
}

const record = (cwd: string, ...gates: Gate[]) => {
  for (const g of gates) {
    const branch = git(cwd, "symbolic-ref", "--quiet", "--short", "HEAD");
    const pointer = pointerPath(cwd, branch);
    if (g === "verify" && existsSync(pointer)) {
      const run = JSON.parse(readFileSync(pointer, "utf8")).run_id as string;
      const metadata = JSON.parse(readFileSync(join(defaultEvidenceDir(cwd), "runs", run, "run.json"), "utf8"));
      const ticketPath = join(cwd, `${metadata.ticket.id}.json`);
      expect(ak(cwd, "record", "--gate", g, "--receipt", receipt(cwd, run, ticketPath)).code).toBe(0);
    } else {
      expect(ak(cwd, "record", "--gate", g).code).toBe(0);
    }
  }
};

function ticket(cwd: string, id: string): string {
  const path = join(cwd, `${id}.json`);
  writeFileSync(
    path,
    `${JSON.stringify({
      schema: "ticket",
      schema_version: 1,
      id,
      acceptance_criteria: [{ id: "AC-1", text: "The behavior is verified." }],
      verification: [{ id: "project-check", check: "Run the project check.", kind: "command", supports: ["AC-1"] }],
      approvals: [{ role: "human", approved_at: "2026-09-29T00:00:00Z" }],
    })}\n`,
  );
  return path;
}

function receipt(cwd: string, run: string, ticketPath: string, extra: Record<string, unknown> = {}): string {
  const snapshot = takeSnapshot(cwd);
  if (typeof snapshot === "string") throw new Error(snapshot);
  const receiptDir = mkdtempSync(join(tmpdir(), "ak-receipt-"));
  const outputPath = join(receiptDir, "verification-output.log");
  writeFileSync(outputPath, "1 pass, 0 fail\n");
  const outputDigest = `sha256:${createHash("sha256").update(readFileSync(outputPath)).digest("hex")}`;
  const doc = {
    schema: "verification",
    schema_version: 1,
    id: `verification-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    project: { id: "demo" },
    run_id: run,
    created_by: { role: "runner" },
    inputs: [],
    source_revision: snapshot,
    created_at: "2026-09-29T00:00:00Z",
    status: "passed",
    kind: "command",
    command: { argv: ["bun", "test"] },
    exit_status: 0,
    output_digest: outputDigest,
    artifacts: [{ path: "verification-output.log", digest: outputDigest, kind: "log" }],
    environment: { id: "test", isolated: true, secrets_policy: "none" },
    supports: ["AC-1"],
    check: "project-check",
    ticket: {
      id: JSON.parse(readFileSync(ticketPath, "utf8")).id,
      schema: "ticket",
      hash: artifactHash(JSON.parse(readFileSync(ticketPath, "utf8"))),
    },
    ...extra,
  };
  const path = join(receiptDir, `${doc.id}.json`);
  writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`);
  return path;
}

function open(cwd: string, id: string): string {
  const ticketPath = ticket(cwd, id);
  const base = git(cwd, "rev-parse", "HEAD");
  const r = ak(cwd, "open", "--ticket", ticketPath);
  expect(r.code).toBe(0);
  const match = r.out[0]?.match(/^opened run (.+)$/);
  expect(match).not.toBeNull();
  const run = match![1]!;
  const metadata = JSON.parse(readFileSync(join(defaultEvidenceDir(cwd), "runs", run, "run.json"), "utf8"));
  expect(metadata).toEqual({
    run_id: run,
    ticket: { id, hash: artifactHash(JSON.parse(readFileSync(ticketPath, "utf8"))) },
    opened_at: expect.any(String),
    branch: "feature",
    base,
  });
  return run;
}

/** A reference written into the current verify record by hand, the way `record` no longer will for a receipt of another head. */
function plant(cwd: string, run: string, receiptPath: string): void {
  const bytes = readFileSync(receiptPath);
  const hex = createHash("sha256").update(bytes).digest("hex");
  writeFileSync(join(defaultEvidenceDir(cwd), run, "artifacts", hex), bytes);
  const gateDir = join(defaultEvidenceDir(cwd), run, "verify");
  const path = join(gateDir, readdirSync(gateDir)[0]!);
  const gate = JSON.parse(readFileSync(path, "utf8"));
  gate.evidence.push({ id: JSON.parse(bytes.toString()).id, schema: "verification", hash: `sha256:${hex}` });
  writeFileSync(path, JSON.stringify(gate));
}

/** The branch pointer `open` persists: the readable branch name plus a hash of the full name. */
const pointerPath = (cwd: string, branch: string): string =>
  join(
    defaultEvidenceDir(cwd),
    "branches",
    `${branch.replace(/[^A-Za-z0-9._:-]/g, "-")}-${createHash("sha256").update(branch).digest("hex").slice(0, 12)}.json`,
  );

describe("ak lifecycle check, standalone", () => {
  test("a gate record carries delegation class and implementer author kind plus host", () => {
    const dir = repo();
    const recorded = ak(
      dir,
      "record",
      "--gate",
      "build-checks",
      "--class",
      "yellow-agent",
      "--author-kind",
      "agent",
      "--host",
      "codex",
    );
    expect(recorded.code).toBe(0);
    const gateDir = join(defaultEvidenceDir(dir), "feature", "build-checks");
    const [recordFile] = readdirSync(gateDir);
    expect(recordFile).toBeDefined();
    if (recordFile === undefined) throw new Error("gate record was not written");
    const gate: unknown = JSON.parse(readFileSync(join(gateDir, recordFile), "utf8"));
    expect(gate).toMatchObject({
      class: "yellow-agent",
      implementer: { author_kind: "agent", host: "codex" },
    });
  });

  test("an unknown subcommand names the one it was probably meant to be", () => {
    const r = ak(repo(), "chek");
    expect(r.code).toBe(2);
    expect(r.err.split("\n")[0]).toBe("ak lifecycle: unknown subcommand 'chek'; did you mean check?");
  });

  test("a named run the store has never held is flagged as a likely typo, with the runs it does hold", () => {
    const dir = repo();
    expect(ak(dir, "record", "--gate", "build-checks").code).toBe(0);
    const typo = ak(dir, "check", "--run", "featuer");
    expect(typo.code).toBe(1);
    expect(typo.err).toContain(`note: in ${defaultEvidenceDir(dir)}, unknown run 'featuer'; did you mean feature?`);
    const known = ak(dir, "check", "--run", "feature");
    expect(known.code).toBe(1);
    expect(known.err).not.toContain("unknown run");
  });

  test("a --host outside the shipped adapters is refused before it can replace a readable record", () => {
    const dir = repo();
    const identity = ["--class", "green", "--author-kind", "agent"];
    expect(ak(dir, "record", "--gate", "build-checks", ...identity, "--host", "codex").code).toBe(0);
    const blank = ak(dir, "record", "--gate", "build-checks", ...identity, "--host=");
    expect(blank.code).toBe(2);
    expect(blank.err).toContain("--host must be one of claude-code, codex,");
    const model = ak(dir, "record", "--gate", "build-checks", ...identity, "--host", "sonnet-4");
    expect(model.code).toBe(2);
    expect(model.err).toContain("--host must be one of claude-code, codex,");
    expect(ak(dir, "record", "--gate", "build-checks", ...identity, "--host", "claude-code").code).toBe(0);
    expect(ak(dir, "record", "--gate", "build-checks", ...identity, "--host", "codex").code).toBe(0);
    const records = readRecords(defaultEvidenceDir(dir), "feature", "build-checks");
    expect(records.map((entry) => entry.implementer)).toEqual([{ author_kind: "agent", host: "codex" }]);
    const programmatic = recordGate({
      dir: defaultEvidenceDir(dir),
      run: "feature",
      gate: "build-checks",
      project: dir,
      implementer: { author_kind: "agent", host: "sonnet-4" },
    });
    expect(programmatic.ok).toBe(false);
    const gateDir = join(defaultEvidenceDir(dir), "feature", "build-checks");
    const [recordFile] = readdirSync(gateDir);
    if (recordFile === undefined) throw new Error("gate record was not written");
    const path = join(gateDir, recordFile);
    const written: unknown = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(
      path,
      JSON.stringify(Object.assign({}, written, { implementer: { author_kind: "agent", host: "sonnet-4" } })),
    );
    expect(readRecords(defaultEvidenceDir(dir), "feature", "build-checks")).toEqual([]);
  });

  test("re-recording a snapshot without the identity flags keeps its class and implementer", () => {
    const dir = repo();
    const identity = ["--class", "yellow-agent", "--author-kind", "agent", "--host", "codex"];
    expect(ak(dir, "record", "--gate", "build-checks", ...identity).code).toBe(0);
    expect(ak(dir, "record", "--gate", "build-checks").code).toBe(0);
    const records = readRecords(defaultEvidenceDir(dir), "feature", "build-checks");
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      class: "yellow-agent",
      implementer: { author_kind: "agent", host: "codex" },
    });
  });

  test("a record whose implementer is null is skipped, not thrown on", () => {
    const dir = repo();
    expect(ak(dir, "record", "--gate", "build-checks").code).toBe(0);
    const gateDir = join(defaultEvidenceDir(dir), "feature", "build-checks");
    const [recordFile] = readdirSync(gateDir);
    if (recordFile === undefined) throw new Error("gate record was not written");
    const path = join(gateDir, recordFile);
    const written: unknown = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(path, JSON.stringify(Object.assign({}, written, { implementer: null })));
    expect(readRecords(defaultEvidenceDir(dir), "feature", "build-checks")).toEqual([]);
  });

  test("a run with every phase's record for the head passes", () => {
    const dir = repo();
    record(dir, ...PRE_SHIP_GATES);
    const r = ak(dir, "check");
    expect(r.err).toContain("note: v1 marker, no evidence references: history, not proof");
    expect(r.code).toBe(0);
    expect(r.out[0]).toContain(`ok: run feature has current evidence for ${PRE_SHIP_GATES.join(", ")}`);
  });

  test("a v1 marker remains phase evidence but is never promoted to verification evidence", () => {
    const dir = repo();
    record(dir, ...PRE_SHIP_GATES);

    const compatible = ak(dir, "check");
    expect(compatible.code).toBe(0);
    expect(compatible.err).toContain("note: v1 marker, no evidence references: history, not proof");

    const strengthened = ak(dir, "check", "--evidence");
    expect(strengthened.code).toBe(1);
    expect(strengthened.err).toContain("refused: evidence unavailable");
  });

  test("an opened task with receipt-backed verification is allowed and keeps a decision", () => {
    const dir = repo();
    const ticketPath = ticket(dir, "evidenced-task");
    const opened = ak(dir, "open", "--ticket", ticketPath);
    const run = opened.out[0]!.replace(/^opened run /, "");
    record(dir, "build-checks", "review-full", "review-readiness");
    expect(ak(dir, "record", "--gate", "verify", "--receipt", receipt(dir, run, ticketPath)).code).toBe(0);

    const checked = ak(dir, "check", "--json");
    expect(checked.code).toBe(0);
    const decision = JSON.parse(checked.out.join("\n"));
    expect(decision).toMatchObject({
      run_id: run,
      transition: "ship",
      outcome: "allowed",
      trust: "worker-attested",
      reasons: [],
    });
    expect(readdirSync(join(defaultEvidenceDir(dir), run, "decisions"))).toHaveLength(1);
  });

  test("an opened task's current marker without receipts is refused", () => {
    const dir = repo();
    const run = open(dir, "missing-evidence");
    record(dir, "build-checks", "review-full", "review-readiness");
    expect(ak(dir, "record", "--gate", "verify").code).toBe(0);
    const checked = ak(dir, "check");
    expect(checked.code).toBe(1);
    expect(checked.err).toContain("refused: evidence missing");
    expect(run).toMatch(/^feature-[0-9a-f]{12}$/);
  });

  test("a wrong-task receipt is refused by name", () => {
    const dir = repo();
    const ticketPath = ticket(dir, "wrong-task");
    const run = ak(dir, "open", "--ticket", ticketPath).out[0]!.replace(/^opened run /, "");
    record(dir, "build-checks", "review-full", "review-readiness");
    const extra = { ticket: { id: "another-task", schema: "ticket", hash: `sha256:${"f".repeat(64)}` } };
    expect(ak(dir, "record", "--gate", "verify", "--receipt", receipt(dir, run, ticketPath, extra)).code).toBe(0);
    const checked = ak(dir, "check");
    expect(checked.code).toBe(1);
    expect(checked.err).toContain("refused: evidence wrong-task");
    expect(checked.err).not.toContain("evidence unstable");
  });

  test("a receipt bound to another revision is not recorded, and one referenced by hand is refused by name", () => {
    const dir = repo();
    const ticketPath = ticket(dir, "wrong-revision");
    const run = ak(dir, "open", "--ticket", ticketPath).out[0]!.replace(/^opened run /, "");
    record(dir, "build-checks", "review-full", "review-readiness");
    const snapshot = takeSnapshot(dir) as Exclude<ReturnType<typeof takeSnapshot>, string>;
    const stale = receipt(dir, run, ticketPath, { source_revision: { ...snapshot, revision: "f".repeat(40) } });
    const recorded = ak(dir, "record", "--gate", "verify", "--receipt", stale);
    expect(recorded.code).toBe(0);
    expect(recorded.err).toContain(stale);
    expect(recorded.err).toContain("f".repeat(40));
    const unevidenced = ak(dir, "check");
    expect(unevidenced.code).toBe(1);
    expect(unevidenced.err).toContain("refused: evidence missing");

    plant(dir, run, stale);
    const checked = ak(dir, "check");
    expect(checked.code).toBe(1);
    expect(checked.err).toContain("refused: evidence wrong-revision");
  });

  test("a failed receipt left from the previous head does not refuse the next head", () => {
    const dir = repo();
    const ticketPath = ticket(dir, "leftover-failure");
    const run = ak(dir, "open", "--ticket", ticketPath).out[0]!.replace(/^opened run /, "");
    const leftover = receipt(dir, run, ticketPath, { status: "failed", exit_status: 1 });
    expect(ak(dir, "record", "--gate", "verify", "--receipt", leftover).code).toBe(0);
    const before = git(dir, "rev-parse", "HEAD");
    writeFileSync(join(dir, "src/a.js"), "export const a = 21;\n");
    git(dir, "commit", "-qam", "fix");

    record(dir, "build-checks", "review-full", "review-readiness");
    const recorded = ak(
      dir,
      "record",
      "--gate",
      "verify",
      "--receipt",
      leftover,
      "--receipt",
      receipt(dir, run, ticketPath),
    );
    expect(recorded.code).toBe(0);
    expect(recorded.err).toContain(leftover);
    expect(recorded.err).toContain(before);
    const checked = ak(dir, "check", "--json");
    expect(checked.code).toBe(0);
    expect(JSON.parse(checked.out.join("\n"))).toMatchObject({ outcome: "allowed", reasons: [] });
  });

  test("a failed receipt bound to the new head still refuses there after a later passing re-record", () => {
    const dir = repo();
    const ticketPath = ticket(dir, "failure-at-new-head");
    const run = ak(dir, "open", "--ticket", ticketPath).out[0]!.replace(/^opened run /, "");
    writeFileSync(join(dir, "src/a.js"), "export const a = 22;\n");
    git(dir, "commit", "-qam", "next head");
    record(dir, "build-checks", "review-full", "review-readiness");
    const id = "verification-new-head";
    expect(
      ak(
        dir,
        "record",
        "--gate",
        "verify",
        "--receipt",
        receipt(dir, run, ticketPath, { id, status: "failed", exit_status: 1 }),
      ).code,
    ).toBe(0);
    expect(ak(dir, "record", "--gate", "verify", "--receipt", receipt(dir, run, ticketPath, { id })).code).toBe(0);
    expect(ak(dir, "record", "--gate", "verify", "--receipt", receipt(dir, run, ticketPath)).code).toBe(0);
    const checked = ak(dir, "check");
    expect(checked.code).toBe(1);
    expect(checked.err).toContain("refused: evidence unstable: AC-1 has both failed and passed evidence at this head");
  });

  test("a zero-exit failure is failed evidence for its criterion", () => {
    const dir = repo();
    const ticketPath = ticket(dir, "zero-exit");
    const run = ak(dir, "open", "--ticket", ticketPath).out[0]!.replace(/^opened run /, "");
    record(dir, "build-checks", "review-full", "review-readiness");
    const failed = receipt(dir, run, ticketPath, {
      status: "failed",
      exit_status: 0,
      exit_disagreement: { verdict_from: "output", output_reports: "2 fail" },
    });
    expect(ak(dir, "record", "--gate", "verify", "--receipt", failed).code).toBe(0);
    const checked = ak(dir, "check");
    expect(checked.code).toBe(1);
    expect(checked.err).toContain("refused: evidence failed: AC-1 has failed evidence at this head");
  });

  test("one-byte edits to a stored receipt or output are refused", () => {
    for (const target of ["receipt", "output"] as const) {
      const dir = repo();
      const ticketPath = ticket(dir, `tampered-${target}`);
      const run = ak(dir, "open", "--ticket", ticketPath).out[0]!.replace(/^opened run /, "");
      record(dir, "build-checks", "review-full", "review-readiness");
      const receiptPath = receipt(dir, run, ticketPath);
      const receiptDoc = JSON.parse(readFileSync(receiptPath, "utf8"));
      expect(ak(dir, "record", "--gate", "verify", "--receipt", receiptPath).code).toBe(0);
      const gateDir = join(defaultEvidenceDir(dir), run, "verify");
      const gateRecord = JSON.parse(readFileSync(join(gateDir, readdirSync(gateDir)[0]!), "utf8"));
      const hash = target === "receipt" ? gateRecord.evidence[0].hash : receiptDoc.output_digest;
      const stored = join(defaultEvidenceDir(dir), run, "artifacts", hash.replace(/^sha256:/, ""));
      writeFileSync(stored, Buffer.concat([readFileSync(stored), Buffer.from("x")]));
      const checked = ak(dir, "check");
      expect(checked.code).toBe(1);
      expect(checked.err).toContain(target === "receipt" ? "evidence digest-mismatch" : "evidence output-missing");

      expect(ak(dir, "record", "--gate", "verify", "--receipt", receiptPath).code).toBe(0);
      expect(ak(dir, "check").code).toBe(0);
    }
  });

  test("a receipt for a check that did not run neither counts nor refuses beside passed evidence", () => {
    for (const status of ["not-run", "not-applicable"] as const) {
      const dir = repo();
      const ticketPath = ticket(dir, `unrun-${status}`);
      const run = ak(dir, "open", "--ticket", ticketPath).out[0]!.replace(/^opened run /, "");
      record(dir, "build-checks", "review-full", "review-readiness");
      const unrun = receipt(dir, run, ticketPath, {
        status,
        reason: "the check does not apply to this change",
        exit_status: undefined,
        output_digest: undefined,
        artifacts: undefined,
      });
      expect(ak(dir, "record", "--gate", "verify", "--receipt", unrun).code).toBe(0);

      const alone = ak(dir, "check");
      expect(alone.code).toBe(1);
      expect(alone.err).toContain("refused: evidence uncovered: AC-1 has no passed evidence at this head");
      expect(alone.err).not.toContain("output-missing");

      expect(ak(dir, "record", "--gate", "verify", "--receipt", receipt(dir, run, ticketPath)).code).toBe(0);
      const checked = ak(dir, "check", "--json");
      expect(checked.code).toBe(0);
      expect(JSON.parse(checked.out.join("\n"))).toMatchObject({ outcome: "allowed", reasons: [] });
    }
  });

  test("a ticket ref binds by id and artifact hash, with or without a schema, and never another schema", () => {
    for (const [schema, code] of [
      [undefined, 0],
      ["charter", 1],
    ] as const) {
      const dir = repo();
      const ticketPath = ticket(dir, `ticket-ref-${schema ?? "bare"}`);
      const run = ak(dir, "open", "--ticket", ticketPath).out[0]!.replace(/^opened run /, "");
      record(dir, "build-checks", "review-full", "review-readiness");
      const ref = JSON.parse(readFileSync(receipt(dir, run, ticketPath), "utf8")).ticket;
      const bound = receipt(dir, run, ticketPath, { ticket: { id: ref.id, hash: ref.hash, schema } });
      expect(ak(dir, "record", "--gate", "verify", "--receipt", bound).code).toBe(0);
      const checked = ak(dir, "check");
      expect(checked.code).toBe(code);
      if (code === 1) expect(checked.err).toContain("refused: evidence wrong-task");
    }
  });

  test("record refuses a receipt whose output log is not among its artifacts", () => {
    const dir = repo();
    const ticketPath = ticket(dir, "unlisted-log");
    const run = ak(dir, "open", "--ticket", ticketPath).out[0]!.replace(/^opened run /, "");
    const unlisted = receipt(dir, run, ticketPath, { artifacts: undefined });
    const refused = ak(dir, "record", "--gate", "verify", "--receipt", unlisted);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain(unlisted);
    expect(refused.err).toContain(JSON.parse(readFileSync(unlisted, "utf8")).output_digest);
    expect(existsSync(join(defaultEvidenceDir(dir), run, "verify"))).toBe(false);
  });

  test("a corrected receipt re-recorded under the same id replaces the defective one at this head", () => {
    const dir = repo();
    const ticketPath = ticket(dir, "corrected-receipt");
    const run = ak(dir, "open", "--ticket", ticketPath).out[0]!.replace(/^opened run /, "");
    record(dir, "build-checks", "review-full", "review-readiness");
    const id = "verification-corrected";
    expect(
      ak(dir, "record", "--gate", "verify", "--receipt", receipt(dir, run, ticketPath, { id, check: undefined })).code,
    ).toBe(0);
    const defective = ak(dir, "check");
    expect(defective.code).toBe(1);
    expect(defective.err).toContain("refused: evidence unknown-check");

    expect(ak(dir, "record", "--gate", "verify", "--receipt", receipt(dir, run, ticketPath, { id })).code).toBe(0);
    expect(ak(dir, "check").code).toBe(0);
  });

  test("a failed receipt stays refused after a passing receipt is re-recorded under its id", () => {
    const dir = repo();
    const ticketPath = ticket(dir, "sticky-failure");
    const run = ak(dir, "open", "--ticket", ticketPath).out[0]!.replace(/^opened run /, "");
    record(dir, "build-checks", "review-full", "review-readiness");
    const id = "verification-sticky";
    expect(
      ak(
        dir,
        "record",
        "--gate",
        "verify",
        "--receipt",
        receipt(dir, run, ticketPath, { id, status: "failed", exit_status: 1 }),
      ).code,
    ).toBe(0);
    expect(ak(dir, "record", "--gate", "verify", "--receipt", receipt(dir, run, ticketPath, { id })).code).toBe(0);
    const checked = ak(dir, "check");
    expect(checked.code).toBe(1);
    expect(checked.err).toContain("refused: evidence unstable: AC-1 has both failed and passed evidence at this head");
  });

  test("a later pass never overwrites a failure for the same criterion and head", () => {
    const dir = repo();
    const ticketPath = ticket(dir, "unstable-check");
    const run = ak(dir, "open", "--ticket", ticketPath).out[0]!.replace(/^opened run /, "");
    record(dir, "build-checks", "review-full", "review-readiness");
    const failed = receipt(dir, run, ticketPath, { status: "failed", exit_status: 1 });
    expect(ak(dir, "record", "--gate", "verify", "--receipt", failed).code).toBe(0);
    expect(ak(dir, "record", "--gate", "verify", "--receipt", receipt(dir, run, ticketPath)).code).toBe(0);
    const checked = ak(dir, "check");
    expect(checked.code).toBe(1);
    expect(checked.err).toContain("refused: evidence unstable: AC-1 has both failed and passed evidence at this head");
  });

  for (const missing of PRE_SHIP_GATES) {
    test(`refuses when ${missing} left no record`, () => {
      const dir = repo();
      record(dir, ...PRE_SHIP_GATES.filter((g) => g !== missing));
      const r = ak(dir, "check");
      expect(r.code).toBe(1);
      expect(r.err).toContain(`refused: gate ${missing} has no current evidence`);
      for (const other of PRE_SHIP_GATES.filter((g) => g !== missing)) expect(r.err).not.toContain(`gate ${other} `);
    });
  }

  test("a record for an earlier state of the tree is stale", () => {
    const dir = repo();
    record(dir, ...PRE_SHIP_GATES);
    writeFileSync(join(dir, "src/a.js"), "export const a = 3;\n");
    const r = ak(dir, "check");
    expect(r.code).toBe(1);
    expect(r.err).toContain("refused: gate verify has no current evidence (the latest record is for");
    expect(r.err).toContain("refused: gate review-readiness has no current evidence");
    // build-checks and review-full were on this revision, which is still the head's.
    expect(r.err).not.toContain("gate build-checks");
  });

  test("refusal messages name the latest record by recorded time", () => {
    const dir = repo();
    record(dir, "verify", "review-full");
    writeFileSync(join(dir, "src/a.js"), "export const a = 3;\n");
    record(dir, "verify", "review-full");

    const latest: Partial<Record<Gate, GateRecord>> = {};
    for (const gate of ["verify", "review-full"] as const) {
      const evidence = join(defaultEvidenceDir(dir), "feature", gate);
      const files = readdirSync(evidence)
        .filter((name) => name.endsWith(".json"))
        .sort();
      expect(files).toHaveLength(2);
      for (const [index, file] of files.entries()) {
        const path = join(evidence, file);
        const gateRecord = JSON.parse(readFileSync(path, "utf8")) as GateRecord;
        gateRecord.recorded_at = index === 0 ? "2026-01-02T00:00:00.000Z" : "2026-01-01T00:00:00.000Z";
        writeFileSync(path, `${JSON.stringify(gateRecord, null, 2)}\n`);
        if (index === 0) latest[gate] = gateRecord;
      }
    }

    writeFileSync(join(dir, "src/a.js"), "export const a = 4;\n");
    const r = ak(dir, "check", "--gates", "verify,review-full");
    expect(r.code).toBe(1);
    for (const gate of ["verify", "review-full"] as const) {
      const snapshot = latest[gate]!.snapshot;
      const named = `${snapshot.revision.slice(0, 12)}/${snapshot.diff_hash.replace(/^sha256:/, "").slice(0, 12)}`;
      expect(r.err).toContain(
        gate === "verify" ? `the latest record is for ${named}` : `the full review is for ${named}`,
      );
    }
  });

  test("a record without a recorded time is ignored, not trusted and not fatal", () => {
    const dir = repo();
    record(dir, ...PRE_SHIP_GATES);
    const evidence = join(defaultEvidenceDir(dir), "feature", "verify");
    const [file] = readdirSync(evidence).filter((name) => name.endsWith(".json"));
    const good = JSON.parse(readFileSync(join(evidence, file!), "utf8")) as Partial<GateRecord>;
    delete good.recorded_at;
    writeFileSync(join(evidence, "zz-foreign.json"), `${JSON.stringify(good, null, 2)}\n`);
    expect(ak(dir, "check").code).toBe(0);

    writeFileSync(join(evidence, file!), `${JSON.stringify(good, null, 2)}\n`);
    const r = ak(dir, "check");
    expect(r.code).toBe(1);
    expect(r.err).toContain("refused: gate verify has no current evidence (no record for run feature");
  });

  test("a full review at H1 plus a delta review after a fix at H2 passes without another full review", () => {
    const dir = repo();
    const run = open(dir, "fix-cycle");
    record(dir, "build-checks", "verify", "review-full");
    git(dir, "commit", "-qam", "build");
    writeFileSync(join(dir, "src/a.js"), "export const a = 4;\n"); // the fix for a review finding
    record(dir, "verify", "review-readiness");
    expect(ak(dir, "check").err).toContain("refused: gate review-full has no current evidence (the full review is for");
    record(dir, "review-delta");
    const checked = ak(dir, "check");
    expect(checked.code).toBe(0);
    expect(checked.out[0]).toContain(`ok: run ${run}`);
    expect(
      readdirSync(join(defaultEvidenceDir(dir), run, "review-full")).filter((name) => name.endsWith(".json")),
    ).toHaveLength(1);
  });

  test("build-checks from another line of history does not count", () => {
    const dir = repo();
    git(dir, "commit", "-qam", "elsewhere");
    record(dir, "build-checks");
    git(dir, "reset", "-q", "--hard", "main"); // the built commit is no longer in this branch's history
    writeFileSync(join(dir, "src/a.js"), "export const a = 5;\n");
    record(dir, "verify", "review-full", "review-readiness");
    const r = ak(dir, "check");
    expect(r.code).toBe(1);
    expect(r.err).toContain(
      "refused: gate build-checks has no current evidence (every record is for a revision that is not an ancestor",
    );
  });

  test("a branch name reused after its run was merged does not inherit that run's records", () => {
    const dir = repo();
    record(dir, "build-checks");
    git(dir, "commit", "-qam", "build");
    record(dir, ...PRE_SHIP_GATES);
    expect(ak(dir, "check").code).toBe(0);
    git(dir, "checkout", "-q", "main");
    git(dir, "merge", "-q", "--no-ff", "-m", "merge feature", "feature");
    git(dir, "checkout", "-q", "feature");
    git(dir, "merge", "-q", "--ff-only", "main");
    writeFileSync(join(dir, "src/a.js"), "export const a = 6;\n"); // new work that skips super-build
    record(dir, "verify", "review-delta", "review-readiness");
    const r = ak(dir, "check");
    expect(r.code).toBe(1);
    expect(r.err).toContain(
      "refused: gate build-checks has no current evidence (every record is for a revision that is not an ancestor",
    );
    expect(r.err).toContain("since it left main at");
    expect(r.err).toContain("refused: gate review-full has no current evidence");
  });

  test("the v1 branch run warns when a squash reuse inherits records", () => {
    const dir = repo();
    record(dir, "build-checks");
    git(dir, "commit", "-qam", "task one");
    record(dir, ...PRE_SHIP_GATES);
    expect(ak(dir, "check").code).toBe(0);

    git(dir, "checkout", "-q", "main");
    git(dir, "merge", "-q", "--squash", "feature");
    git(dir, "commit", "-qm", "squash task one");
    git(dir, "checkout", "-q", "feature");
    git(dir, "merge", "-q", "--no-edit", "main");
    writeFileSync(join(dir, "src/a.js"), "export const a = 7;\n");
    record(dir, "verify", "review-delta", "review-readiness");

    const inherited = ak(dir, "check");
    expect(inherited.code).toBe(0);
    expect(inherited.err).toContain(
      "note: build-checks for run feature was recorded before this branch last took main (",
    );
    expect(inherited.err).toContain("if this branch was reused for a new task, open a new run");
  });

  test("on a clone, the note and the refusal name the default branch, not the remote HEAD ref", () => {
    const seed = makeTree({ "src/a.js": "export const a = 1;\n" });
    git(seed, "init", "-q", "-b", "main");
    git(seed, "add", "-A");
    git(seed, "commit", "-q", "-m", "init");
    const root = realpathSync(mkdtempSync(join(tmpdir(), "ak-gate-clone-")));
    git(root, "clone", "-q", "--bare", seed, "origin.git");
    git(root, "clone", "-q", "origin.git", "work");
    const dir = join(root, "work");
    git(dir, "checkout", "-q", "-b", "feature");
    writeFileSync(join(dir, "src/a.js"), "export const a = 2;\n");
    record(dir, "build-checks");
    git(dir, "commit", "-qam", "task one");
    record(dir, ...PRE_SHIP_GATES);

    git(dir, "checkout", "-q", "main");
    git(dir, "merge", "-q", "--squash", "feature");
    git(dir, "commit", "-qm", "squash task one");
    git(dir, "push", "-q", "origin", "main");
    git(dir, "checkout", "-q", "feature");
    git(dir, "merge", "-q", "--no-edit", "origin/main");
    writeFileSync(join(dir, "src/a.js"), "export const a = 7;\n");
    record(dir, "verify", "review-delta", "review-readiness");

    const inherited = ak(dir, "check");
    expect(inherited.code).toBe(0);
    expect(inherited.err).toContain(
      "note: build-checks for run feature was recorded before this branch last took main (",
    );

    git(dir, "reset", "-q", "--hard", "origin/main");
    writeFileSync(join(dir, "src/a.js"), "export const a = 8;\n");
    record(dir, "verify", "review-delta", "review-readiness");
    const refused = ak(dir, "check");
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("since it left main at");
    expect(refused.err).not.toContain("refs/remotes/origin/HEAD");
  });

  test("an explicit fresh run inherits no records", () => {
    const dir = repo();
    record(dir, ...PRE_SHIP_GATES);
    const freshRun = ak(dir, "check", "--run", "task-2");
    expect(freshRun.code).toBe(1);
    for (const gate of PRE_SHIP_GATES) {
      expect(freshRun.err).toContain(`refused: gate ${gate} has no current evidence (no record for run task-2`);
    }
  });

  test("a closed strengthened run rejects squash reuse and a newly opened run sees none of its records", () => {
    const dir = repo();
    const first = open(dir, "task-1");
    record(dir, ...PRE_SHIP_GATES, "ship-preflight");
    const closed = JSON.parse(readFileSync(join(defaultEvidenceDir(dir), "runs", first, "run.json"), "utf8"));
    expect(closed.closed_at).toEqual(expect.any(String));
    expect(ak(dir, "record", "--gate", "verify").err).toContain("run closed; open a new run");

    git(dir, "add", "task-1.json");
    git(dir, "commit", "-qm", "task one");
    git(dir, "checkout", "-q", "main");
    git(dir, "merge", "-q", "--squash", "feature");
    git(dir, "commit", "-qm", "squash task one");
    git(dir, "checkout", "-q", "feature");
    git(dir, "merge", "-q", "--no-edit", "main");
    writeFileSync(join(dir, "src/a.js"), "export const a = 8;\n");
    expect(ak(dir, "record", "--gate", "verify").err).toContain("run closed; open a new run");

    const second = open(dir, "task-2");
    expect(second).not.toBe(first);
    const checked = ak(dir, "check");
    expect(checked.code).toBe(1);
    expect(checked.err).toContain(`gate build-checks has no current evidence (no record for run ${second}`);
    expect(checked.err).toContain(`gate review-full has no current evidence (no record for run ${second}`);
  });

  test("a closed run accepts ship-preflight again at the head that closed it, and nothing at a new head", () => {
    const dir = repo();
    const run = open(dir, "dry-run-then-publish");
    record(dir, ...PRE_SHIP_GATES, "ship-preflight");
    expect(ak(dir, "check").code).toBe(0);

    const again = ak(dir, "record", "--gate", "ship-preflight");
    expect(again.err).toBe("");
    expect(again.code).toBe(0);
    expect(again.out[0]).toContain(`recorded ship-preflight for run ${run}`);
    expect(ak(dir, "record", "--gate", "ship-preflight").code).toBe(0);
    for (const gate of PRE_SHIP_GATES) {
      const other = ak(dir, "record", "--gate", gate);
      expect(other.code).toBe(1);
      expect(other.err).toContain("run closed; open a new run");
    }

    writeFileSync(join(dir, "src/a.js"), "export const a = 9;\n");
    for (const gate of ["ship-preflight", "verify"] as const) {
      const moved = ak(dir, "record", "--gate", gate);
      expect(moved.code).toBe(1);
      expect(moved.err).toContain("run closed; open a new run");
    }
  });

  test("a pointer whose run names another branch is absent, so the colliding branch stays on the v1 path", () => {
    const dir = repo();
    git(dir, "checkout", "-q", "-b", "feat/x");
    const opened = ak(dir, "open", "--ticket", ticket(dir, "collide"));
    expect(opened.code).toBe(0);
    const run = opened.out[0]!.replace(/^opened run /, "");
    record(dir, ...PRE_SHIP_GATES);

    git(dir, "checkout", "-q", "-b", "feat-x");
    const before = ak(dir, "check");
    expect(before.code).toBe(1);
    expect(before.err).toContain("no record for run feat-x ");
    record(dir, ...PRE_SHIP_GATES);
    const v1 = ak(dir, "check");
    expect(v1.code).toBe(0);
    expect(v1.out[0]).toContain("ok: run feat-x has current evidence");

    git(dir, "checkout", "-q", "feat/x");
    expect(ak(dir, "check").out[0]).toContain(`ok: run ${run} has current evidence`);
  });

  test("a run opened on a branch that starts with a separator is one a receipt can name", () => {
    for (const [branch, shape] of [
      ["_wip", /^wip-[0-9a-f]{12}$/],
      ["__", /^[0-9a-f]{12}$/],
    ] as const) {
      const dir = repo();
      git(dir, "checkout", "-q", "-b", branch);
      const ticketPath = ticket(dir, "separator-branch");
      const run = ak(dir, "open", "--ticket", ticketPath).out[0]!.replace(/^opened run /, "");
      expect(run).toMatch(shape);
      record(dir, ...PRE_SHIP_GATES);
      const checked = ak(dir, "check", "--json");
      expect(checked.code).toBe(0);
      expect(JSON.parse(checked.out.join("\n"))).toMatchObject({ run_id: run, outcome: "allowed" });
    }
  });

  test("two opened branches whose names differ only in a separator each resolve their own run", () => {
    const dir = repo();
    const runs: Record<string, string> = {};
    for (const branch of ["feat/x", "feat-x"]) {
      git(dir, "checkout", "-q", "-b", branch);
      const opened = ak(dir, "open", "--ticket", ticket(dir, "collide"));
      expect(opened.code).toBe(0);
      runs[branch] = opened.out[0]!.replace(/^opened run /, "");
      expect(JSON.parse(readFileSync(pointerPath(dir, branch), "utf8")).run_id).toBe(runs[branch]!);
    }
    expect(runs["feat/x"]).not.toBe(runs["feat-x"]);

    git(dir, "checkout", "-q", "feat/x");
    record(dir, ...PRE_SHIP_GATES, "ship-preflight");
    expect(ak(dir, "check").out[0]).toContain(`ok: run ${runs["feat/x"]} has current evidence`);
    const closed = ak(dir, "record", "--gate", "verify");
    expect(closed.code).toBe(1);
    expect(closed.err).toContain("run closed; open a new run");

    git(dir, "checkout", "-q", "feat-x");
    const other = ak(dir, "check");
    expect(other.code).toBe(1);
    expect(other.err).toContain(`no record for run ${runs["feat-x"]} `);
    record(dir, ...PRE_SHIP_GATES);
    expect(ak(dir, "check").out[0]).toContain(`ok: run ${runs["feat-x"]} has current evidence`);
  });

  test("records taken before the first commit survive a mid-task merge from main on an opened run", () => {
    const dir = repo();
    const run = open(dir, "precommit");
    record(dir, "build-checks", "verify", "review-full");
    git(dir, "add", "precommit.json");
    git(dir, "commit", "-qam", "first task commit");

    git(dir, "checkout", "-q", "main");
    writeFileSync(join(dir, "main.txt"), "upstream\n");
    git(dir, "add", "main.txt");
    git(dir, "commit", "-qm", "main advances");
    git(dir, "checkout", "-q", "feature");
    git(dir, "merge", "-q", "--no-edit", "main");
    writeFileSync(join(dir, "src/a.js"), "export const a = 10;\n");
    record(dir, "verify", "review-delta", "review-readiness");

    const checked = ak(dir, "check");
    expect(checked.err).toBe("");
    expect(checked.code).toBe(0);
    expect(checked.out[0]).toContain(`ok: run ${run}`);
  });

  test("commits and a mid-task merge from main keep the opened run id and its earlier records", () => {
    const dir = repo();
    const run = open(dir, "continuation");
    git(dir, "add", "continuation.json");
    git(dir, "commit", "-qam", "first task commit");
    record(dir, "build-checks", "verify", "review-full");

    git(dir, "checkout", "-q", "main");
    writeFileSync(join(dir, "main.txt"), "upstream\n");
    git(dir, "add", "main.txt");
    git(dir, "commit", "-qm", "main advances");
    git(dir, "checkout", "-q", "feature");
    git(dir, "merge", "-q", "--no-edit", "main");
    writeFileSync(join(dir, "src/a.js"), "export const a = 9;\n");
    record(dir, "verify", "review-delta", "review-readiness");

    const checked = ak(dir, "check");
    expect(checked.code).toBe(0);
    expect(checked.err).toBe("");
    expect(checked.out[0]).toContain(`ok: run ${run}`);
    const pointer = JSON.parse(readFileSync(pointerPath(dir, "feature"), "utf8"));
    expect(pointer.run_id).toBe(run);
  });

  test("work on the default branch itself keeps build-checks recorded before its commit", () => {
    const dir = repo();
    git(dir, "checkout", "-q", "main");
    record(dir, "build-checks");
    git(dir, "commit", "-qam", "build");
    record(dir, "verify", "review-full", "review-readiness");
    const r = ak(dir, "check");
    expect(r.err).toContain("note: v1 marker, no evidence references: history, not proof");
    expect(r.code).toBe(0);
  });

  test("records live under the git common directory, so a linked worktree's run is found from any worktree", () => {
    const dir = repo();
    git(dir, "commit", "-qam", "work");
    const linked = join(mkdtempSync(join(tmpdir(), "ak-wt-")), "wt");
    git(dir, "worktree", "add", "-q", "-b", "topic", linked);
    const r = ak(linked, "record", "--gate", "verify");
    expect(r.code).toBe(0);
    expect(r.out[0]).toContain(join(realpathSync(dir), ".git", "agent-kit", "evidence", "topic", "verify"));
    expect(ak(dir, "check", "--run", "topic", "--gates", "verify", "--project", linked).code).toBe(0);
    expect(git(dir, "status", "--porcelain")).toBe("");
  });

  test("an explicit run and directory are what a Firstmate worker passes, and a detached head needs one", () => {
    const dir = repo();
    const store = mkdtempSync(join(tmpdir(), "ak-store-"));
    expect(ak(dir, "record", "--gate", "verify", "--run", "ak-T-1", "--dir", store).code).toBe(0);
    expect(ak(dir, "check", "--gates", "verify", "--run", "ak-T-1", "--dir", store).code).toBe(0);
    expect(ak(dir, "check", "--gates", "verify").code).toBe(1);
    git(dir, "checkout", "-q", "--detach");
    const r = ak(dir, "check");
    expect(r.code).toBe(2);
    expect(r.err).toContain("pass --run <id>");
    expect(existsSync(join(store, "runs", "ak-T-1", "run.json"))).toBe(false);
    expect(existsSync(join(store, "branches"))).toBe(false);
  });

  test("bad usage exits 2 and names the gates", () => {
    const dir = repo();
    expect(ak(dir, "record", "--gate", "deploy").err).toContain("--gate must be one of build-checks");
    expect(ak(dir, "check", "--gates", "verify,merge").code).toBe(2);
    expect(ak(dir, "nope").code).toBe(2);
  });
});

describe("the gate a bundle carries", () => {
  test(`every host's bundle ships ${GATE_FILE}, and it runs under node with no checkout`, () => {
    const { catalog } = loadCatalog(REPO);
    if (catalog === null) throw new Error("no catalog");
    const dir = repo();
    for (const host of ["claude-code", "codex"] as const) {
      const file = planBundle({ root: REPO, catalog }, host, {}).files.get(GATE_FILE);
      expect(file?.contents).toContain("ak lifecycle");
      const script = join(mkdtempSync(join(tmpdir(), "ak-bin-")), "ak-gate.mjs");
      writeFileSync(script, file!.contents);
      const node = (...argv: string[]) => Bun.spawnSync(["node", script, ...argv], { cwd: dir });
      const ticketPath = ticket(dir, `${host}-ticket`);
      const opened = node("open", "--ticket", ticketPath);
      expect(opened.exitCode).toBe(0);
      expect(opened.stdout.toString()).toMatch(/^opened run feature-[0-9a-f]{12}\n$/);
      const identity = ["--class", "green", "--author-kind", "agent"];
      expect(node("record", "--gate", "verify", "--run", host, ...identity, "--host", "sonnet-4").exitCode).toBe(2);
      expect(node("record", "--gate", "verify", "--run", host, ...identity, "--host", host).exitCode).toBe(0);
      const ok = node("check", "--gates", "verify", "--run", host);
      expect(ok.stdout.toString()).toContain(`ok: run ${host} has current evidence for verify`);
      const refused = node("check", "--run", host);
      expect(refused.exitCode).toBe(1);
      expect(refused.stderr.toString()).toContain("refused: gate build-checks has no current evidence");
    }
  });

  test("both byte-identical packaged gates enforce the strengthened evidence cases", () => {
    const { catalog } = loadCatalog(REPO);
    if (catalog === null) throw new Error("no catalog");
    const contents = (["claude-code", "codex"] as const).map(
      (host) => planBundle({ root: REPO, catalog }, host, {}).files.get(GATE_FILE)!.contents,
    );
    expect(contents[0]).toBe(contents[1]);

    for (const [index, host] of (["claude-code", "codex"] as const).entries()) {
      const script = join(mkdtempSync(join(tmpdir(), `ak-bin-${host}-`)), "ak-gate.mjs");
      writeFileSync(script, contents[index]!);
      const node = (cwd: string, ...argv: string[]) => Bun.spawnSync(["node", script, ...argv], { cwd });
      const start = (id: string) => {
        const dir = repo();
        const ticketPath = ticket(dir, id);
        const opened = node(dir, "open", "--ticket", ticketPath);
        expect(opened.exitCode).toBe(0);
        const run = opened.stdout
          .toString()
          .trim()
          .replace(/^opened run /, "");
        for (const gate of ["build-checks", "review-full", "review-readiness"])
          expect(node(dir, "record", "--gate", gate).exitCode).toBe(0);
        return { dir, ticketPath, run, node: (...argv: string[]) => node(dir, ...argv) };
      };

      const legacy = repo();
      for (const gate of PRE_SHIP_GATES)
        expect(node(legacy, "record", "--gate", gate, "--run", "legacy").exitCode).toBe(0);
      expect(node(legacy, "check", "--run", "legacy").exitCode).toBe(0);
      expect(node(legacy, "check", "--run", "legacy", "--evidence").stderr.toString()).toContain(
        "evidence unavailable",
      );

      const allowed = start(`${host}-allowed`);
      expect(
        allowed.node("record", "--gate", "verify", "--receipt", receipt(allowed.dir, allowed.run, allowed.ticketPath))
          .exitCode,
      ).toBe(0);
      expect(JSON.parse(allowed.node("check", "--json").stdout.toString()).outcome).toBe("allowed");

      const missing = start(`${host}-missing`);
      expect(missing.node("record", "--gate", "verify").exitCode).toBe(0);
      expect(missing.node("check").stderr.toString()).toContain("evidence missing");

      const task = start(`${host}-wrong-task`);
      const otherTask = { ticket: { id: "other", schema: "ticket", hash: `sha256:${"e".repeat(64)}` } };
      expect(
        task.node("record", "--gate", "verify", "--receipt", receipt(task.dir, task.run, task.ticketPath, otherTask))
          .exitCode,
      ).toBe(0);
      expect(task.node("check").stderr.toString()).toContain("evidence wrong-task");

      const revision = start(`${host}-wrong-revision`);
      const snapshot = takeSnapshot(revision.dir) as Exclude<ReturnType<typeof takeSnapshot>, string>;
      const stale = receipt(revision.dir, revision.run, revision.ticketPath, {
        source_revision: { ...snapshot, revision: "e".repeat(40) },
      });
      const skipped = revision.node("record", "--gate", "verify", "--receipt", stale);
      expect(skipped.exitCode).toBe(0);
      expect(skipped.stderr.toString()).toContain("e".repeat(40));
      expect(revision.node("check").stderr.toString()).toContain("evidence missing");
      plant(revision.dir, revision.run, stale);
      expect(revision.node("check").stderr.toString()).toContain("evidence wrong-revision");

      const zero = start(`${host}-zero-exit`);
      const zeroReceipt = receipt(zero.dir, zero.run, zero.ticketPath, {
        status: "failed",
        exit_status: 0,
        exit_disagreement: { verdict_from: "output", output_reports: "2 fail" },
      });
      expect(zero.node("record", "--gate", "verify", "--receipt", zeroReceipt).exitCode).toBe(0);
      expect(zero.node("check").stderr.toString()).toContain("evidence failed: AC-1");

      for (const target of ["receipt", "output"] as const) {
        const scenario = start(`${host}-tamper-${target}`);
        const receiptPath = receipt(scenario.dir, scenario.run, scenario.ticketPath);
        const receiptDoc = JSON.parse(readFileSync(receiptPath, "utf8"));
        expect(scenario.node("record", "--gate", "verify", "--receipt", receiptPath).exitCode).toBe(0);
        const gateDir = join(defaultEvidenceDir(scenario.dir), scenario.run, "verify");
        const gate = JSON.parse(readFileSync(join(gateDir, readdirSync(gateDir)[0]!), "utf8"));
        const hash = target === "receipt" ? gate.evidence[0].hash : receiptDoc.output_digest;
        const stored = join(defaultEvidenceDir(scenario.dir), scenario.run, "artifacts", hash.replace(/^sha256:/, ""));
        writeFileSync(stored, Buffer.concat([readFileSync(stored), Buffer.from("x")]));
        expect(scenario.node("check").stderr.toString()).toContain(
          target === "receipt" ? "digest-mismatch" : "output-missing",
        );
      }

      const unstable = start(`${host}-unstable`);
      expect(
        unstable.node(
          "record",
          "--gate",
          "verify",
          "--receipt",
          receipt(unstable.dir, unstable.run, unstable.ticketPath, { status: "failed", exit_status: 1 }),
        ).exitCode,
      ).toBe(0);
      expect(
        unstable.node(
          "record",
          "--gate",
          "verify",
          "--receipt",
          receipt(unstable.dir, unstable.run, unstable.ticketPath),
        ).exitCode,
      ).toBe(0);
      expect(unstable.node("check").stderr.toString()).toContain("evidence unstable: AC-1");

      const deltaDir = repo();
      const deltaTicket = ticket(deltaDir, `${host}-delta`);
      const deltaRun = node(deltaDir, "open", "--ticket", deltaTicket)
        .stdout.toString()
        .trim()
        .replace(/^opened run /, "");
      expect(node(deltaDir, "record", "--gate", "build-checks").exitCode).toBe(0);
      expect(
        node(deltaDir, "record", "--gate", "verify", "--receipt", receipt(deltaDir, deltaRun, deltaTicket)).exitCode,
      ).toBe(0);
      expect(node(deltaDir, "record", "--gate", "review-full").exitCode).toBe(0);
      git(deltaDir, "add", `${host}-delta.json`);
      git(deltaDir, "commit", "-qam", "first head");
      writeFileSync(join(deltaDir, "src/a.js"), "export const a = 12;\n");
      expect(
        node(deltaDir, "record", "--gate", "verify", "--receipt", receipt(deltaDir, deltaRun, deltaTicket)).exitCode,
      ).toBe(0);
      expect(node(deltaDir, "record", "--gate", "review-delta").exitCode).toBe(0);
      expect(node(deltaDir, "record", "--gate", "review-readiness").exitCode).toBe(0);
      expect(node(deltaDir, "check").exitCode).toBe(0);
      expect(readdirSync(join(defaultEvidenceDir(deltaDir), deltaRun, "review-full"))).toHaveLength(1);
    }
  }, 120_000);
});
