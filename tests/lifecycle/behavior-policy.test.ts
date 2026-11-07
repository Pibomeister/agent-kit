/**
 * BV-T01: real `ak lifecycle open|record|check` against frozen behavior policy snapshots.
 */
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadCatalog } from "../../src/catalog/load.ts";
import { runCli } from "../../src/cli.ts";
import {
  asJsonObject,
  classifyRun,
  parseBehaviorBinding,
  RUN_SCHEMA_VERSION,
  type Json,
  type JsonObject,
} from "../../src/lifecycle/behavior-policy.ts";
import { defaultEvidenceDir, takeSnapshot, type Snapshot } from "../../src/lifecycle/gate.ts";
import { GATE_FILE, planBundle } from "../../src/packaging/plan.ts";
import { artifactHash, canonicalJson } from "../../src/util/hash.ts";
import { makeTree } from "../helpers/tree.ts";

setDefaultTimeout(60_000);

const ROOT = join(import.meta.dir, "..", "..");
const HASH = `sha256:${"a".repeat(64)}`;

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

function buildRepo(): string {
  const dir = makeTree({ "src/a.js": "export const a = 1;\n" });
  git(dir, "init", "-q", "-b", "main");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  git(dir, "checkout", "-q", "-b", "feature");
  writeFileSync(join(dir, "src/a.js"), "export const a = 2;\n");
  return dir;
}

const REPO_TEMPLATE = buildRepo();

function repo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "ak-bv-policy-")));
  cpSync(REPO_TEMPLATE, dir, { recursive: true });
  return dir;
}

function ak(cwd: string, ...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = runCli(["lifecycle", ...argv], { cwd, io: { out: (l) => out.push(l), err: (l) => err.push(l) } });
  return { code, out, err: err.join("\n") };
}

function parseObject(text: string): JsonObject {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("not json");
  }
  if (!asJsonObject(value)) throw new Error("not a JSON object");
  return value;
}

function isSnapshot(value: Snapshot | string): value is Snapshot {
  return Object(value) === value;
}

function headSnapshot(cwd: string): Snapshot {
  const snapshot = takeSnapshot(cwd);
  if (isSnapshot(snapshot)) return snapshot;
  throw new Error(snapshot);
}

function isText(value: Json | undefined): value is string {
  return Object.prototype.toString.call(value) === "[object String]";
}

function textField(value: Json | undefined): string | undefined {
  return isText(value) ? value : undefined;
}

function writeJson(path: string, doc: JsonObject): void {
  writeFileSync(path, `${JSON.stringify(doc)}\n`);
}

function projectRecord(cwd: string, mode: "off" | "shadow" | "on", id = "example-project"): string {
  const base = parseObject(readFileSync(join(ROOT, "templates/project.example.json"), "utf8"));
  const identity = asJsonObject(base.identity) ? { ...base.identity, id } : { id };
  const path = join(cwd, `${id}.project.json`);
  writeJson(path, { ...base, identity, review: { behavior: mode } });
  return path;
}

function behaviorTicket(cwd: string, id: string, layer: "model" | "implementation" = "implementation"): JsonObject {
  const doc: JsonObject = {
    schema: "ticket",
    schema_version: 1,
    id,
    project: { id: "example-project" },
    acceptance_criteria: [{ id: "AC-1", text: "The behavior is verified.", surface: "none" }],
    verification: [
      {
        id: "project-check",
        check: "Run the project check.",
        kind: "command",
        supports: ["AC-1"],
        behavior: {
          evidence_layer: layer,
          property_ids: ["every-configured-directory-is-read"],
          property_types: { "every-configured-directory-is-read": "safety" },
          contract: { id: "example-behavior-contract-1", schema: "behavior-contract", hash: HASH },
        },
      },
    ],
    approvals: [{ role: "human", approved_at: "2026-09-29T00:00:00Z" }],
  };
  writeJson(join(cwd, `${id}.json`), doc);
  return doc;
}

function plainTicket(cwd: string, id: string): JsonObject {
  const doc: JsonObject = {
    schema: "ticket",
    schema_version: 1,
    id,
    acceptance_criteria: [{ id: "AC-1", text: "The behavior is verified." }],
    verification: [{ id: "project-check", check: "Run the project check.", kind: "command", supports: ["AC-1"] }],
    approvals: [{ role: "human", approved_at: "2026-09-29T00:00:00Z" }],
  };
  writeJson(join(cwd, `${id}.json`), doc);
  return doc;
}

function ticketPath(cwd: string, id: string): string {
  return join(cwd, `${id}.json`);
}

function receipt(cwd: string, run: string, ticket: JsonObject, extra: JsonObject = {}): string {
  const snapshot = headSnapshot(cwd);
  const receiptDir = mkdtempSync(join(tmpdir(), "ak-bv-receipt-"));
  const outputPath = join(receiptDir, "verification-output.log");
  writeFileSync(outputPath, "1 pass, 0 fail\n");
  const outputDigest = `sha256:${createHash("sha256").update(readFileSync(outputPath)).digest("hex")}`;
  const id = `verification-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const ticketId = textField(ticket.id);
  if (ticketId === undefined) throw new Error("ticket has no id");
  const doc: JsonObject = {
    schema: "verification",
    schema_version: 1,
    id,
    project: { id: "demo" },
    run_id: run,
    created_by: { role: "runner" },
    inputs: [],
    source_revision: { repo: snapshot.repo, revision: snapshot.revision, diff_hash: snapshot.diff_hash },
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
    ticket: { id: ticketId, schema: "ticket", hash: artifactHash(ticket) },
    ...extra,
  };
  const path = join(receiptDir, `${id}.json`);
  writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`);
  return path;
}

function recordPhases(cwd: string): void {
  for (const gate of ["build-checks", "review-full", "review-readiness"] as const) {
    expect(ak(cwd, "record", "--gate", gate).code).toBe(0);
  }
}

function runFile(cwd: string, run: string): string {
  return join(defaultEvidenceDir(cwd), "runs", run, "run.json");
}

function readRun(cwd: string, run: string): JsonObject {
  return parseObject(readFileSync(runFile(cwd, run), "utf8"));
}

function bindingOf(run: JsonObject) {
  return parseBehaviorBinding(run.behavior);
}

function frozenTicket(run: JsonObject): JsonObject {
  const ticket = asJsonObject(run.ticket) ? run.ticket : undefined;
  const id = ticket === undefined ? undefined : textField(ticket.id);
  const hash = ticket === undefined ? undefined : textField(ticket.hash);
  if (id === undefined || hash === undefined) throw new Error("run has no ticket");
  return { id, schema: "ticket", hash };
}

function opened(cwd: string, ticketFile: string, projectPath?: string): string {
  const args = ["open", "--ticket", ticketFile];
  if (projectPath !== undefined) args.push("--project-record", projectPath);
  const r = ak(cwd, ...args);
  expect(r.code, r.err).toBe(0);
  const line = r.out[0];
  const match = line === undefined ? undefined : /^opened run (.+)$/.exec(line);
  const run = match === undefined || match === null ? undefined : match[1];
  if (run === undefined) throw new Error(`open did not return a run id: ${String(line)}`);
  return run;
}

function checkLayer(ticket: JsonObject): string | undefined {
  const verification = Array.isArray(ticket.verification) ? ticket.verification : [];
  const check = asJsonObject(verification[0]) ? verification[0] : undefined;
  const behavior = check !== undefined && asJsonObject(check.behavior) ? check.behavior : undefined;
  return behavior === undefined ? undefined : textField(behavior.evidence_layer);
}

describe("BV-T01 policy binding at open, resume and check", () => {
  test("legacy-shaped records without schema_version stay unclassified as off-feature", () => {
    expect(
      classifyRun({ run_id: "old", ticket: { id: "t", hash: HASH }, opened_at: "t", branch: "b", base: "c" }, "old"),
    ).toEqual({ kind: "legacy" });
  });

  test("an ordinary off open keeps current completion and records mode off", () => {
    const dir = repo();
    const ticket = plainTicket(dir, "plain-off");
    const run = opened(dir, ticketPath(dir, "plain-off"));
    const record = readRun(dir, run);
    expect(record.schema_version).toBe(RUN_SCHEMA_VERSION);
    expect(record.behavior).toMatchObject({ run_id: run, mode: "off", required_checks: [] });
    recordPhases(dir);
    expect(ak(dir, "record", "--gate", "verify", "--receipt", receipt(dir, run, ticket)).code).toBe(0);
    expect(ak(dir, "check").code).toBe(0);
  });

  test("an enabled on open freezes complete check definitions and still accepts a valid witness", () => {
    const dir = repo();
    const ticket = behaviorTicket(dir, "enabled-on");
    const run = opened(dir, ticketPath(dir, "enabled-on"), projectRecord(dir, "on"));
    const binding = bindingOf(readRun(dir, run));
    expect(binding?.mode).toBe("on");
    expect(binding?.required_checks).toEqual([
      expect.objectContaining({
        id: "project-check",
        evidence_layer: "implementation",
        property_ids: ["every-configured-directory-is-read"],
        property_types: { "every-configured-directory-is-read": "safety" },
        contract: { id: "example-behavior-contract-1", schema: "behavior-contract", hash: HASH },
        surfaces: { "AC-1": "none" },
      }),
    ]);
    recordPhases(dir);
    expect(ak(dir, "record", "--gate", "verify", "--receipt", receipt(dir, run, ticket)).code).toBe(0);
    const checked = ak(dir, "check", "--json");
    expect(checked.code, checked.err).toBe(0);
    expect(parseObject(checked.out.join("\n")).outcome).toBe("allowed");
  });

  test("resume uses the snapshot after the project file is removed", () => {
    const dir = repo();
    const ticket = behaviorTicket(dir, "kept-on");
    const projectPath = projectRecord(dir, "on");
    const run = opened(dir, ticketPath(dir, "kept-on"), projectPath);
    writeFileSync(projectPath, "");
    recordPhases(dir);
    expect(ak(dir, "record", "--gate", "verify", "--receipt", receipt(dir, run, ticket)).code).toBe(0);
    expect(ak(dir, "check").code).toBe(0);
    expect(bindingOf(readRun(dir, run))?.mode).toBe("on");
  });

  test("moving the ticket onto another project cannot turn a required run off", () => {
    const dir = repo();
    const ticket = behaviorTicket(dir, "stay-on");
    const projectPath = projectRecord(dir, "on");
    const run = opened(dir, ticketPath(dir, "stay-on"), projectPath);
    const frozen = frozenTicket(readRun(dir, run));
    writeJson(ticketPath(dir, "stay-on"), { ...ticket, project: { id: "other-project" } });
    const liveProject = parseObject(readFileSync(projectPath, "utf8"));
    writeJson(projectPath, { ...liveProject, review: { behavior: "off" } });
    expect(bindingOf(readRun(dir, run))?.mode).toBe("on");
    recordPhases(dir);
    expect(ak(dir, "record", "--gate", "verify", "--receipt", receipt(dir, run, ticket, { ticket: frozen })).code).toBe(
      0,
    );
    expect(ak(dir, "check").code).toBe(0);
  });

  test("editing a live check's layer while keeping its id cannot weaken the frozen obligation", () => {
    const dir = repo();
    const ticket = behaviorTicket(dir, "same-id", "implementation");
    const run = opened(dir, ticketPath(dir, "same-id"), projectRecord(dir, "on"));
    const frozen = frozenTicket(readRun(dir, run));
    expect(bindingOf(readRun(dir, run))?.required_checks[0]?.evidence_layer).toBe("implementation");
    const weaker = behaviorTicket(dir, "same-id", "model");
    expect(checkLayer(weaker)).toBe("model");
    expect(bindingOf(readRun(dir, run))?.required_checks[0]?.evidence_layer).toBe("implementation");
    recordPhases(dir);
    expect(ak(dir, "record", "--gate", "verify", "--receipt", receipt(dir, run, ticket, { ticket: frozen })).code).toBe(
      0,
    );
    expect(ak(dir, "check").code).toBe(0);
  });

  test("substituting a weaker ticket under the same id is incomplete, not a weaker obligation", () => {
    const dir = repo();
    const original = behaviorTicket(dir, "swap-id", "implementation");
    const run = opened(dir, ticketPath(dir, "swap-id"), projectRecord(dir, "on"));
    const weaker = behaviorTicket(dir, "swap-id", "model");
    const weakerHash = artifactHash(weaker);
    const runDoc = readRun(dir, run);
    runDoc.ticket = { id: "swap-id", hash: weakerHash };
    writeFileSync(runFile(dir, run), `${JSON.stringify(runDoc, null, 2)}\n`);
    const subject = Object.fromEntries(Object.entries(weaker).filter(([key]) => key !== "approvals"));
    writeFileSync(
      join(defaultEvidenceDir(dir), run, "artifacts", weakerHash.slice("sha256:".length)),
      canonicalJson(subject),
    );
    expect(classifyRun(readRun(dir, run), run).kind).toBe("incomplete");
    recordPhases(dir);
    expect(ak(dir, "record", "--gate", "verify", "--receipt", receipt(dir, run, original)).code).toBe(0);
    const checked = ak(dir, "check");
    expect(checked.code).toBe(1);
    expect(checked.err).toContain("behavior snapshot is for ticket");
  });

  test("mutating a frozen check without resealing the binding hash is incomplete", () => {
    const dir = repo();
    const ticket = behaviorTicket(dir, "tamper-check");
    const run = opened(dir, ticketPath(dir, "tamper-check"), projectRecord(dir, "on"));
    const doc = readRun(dir, run);
    const behavior = asJsonObject(doc.behavior) ? doc.behavior : undefined;
    const checks = behavior !== undefined && Array.isArray(behavior.required_checks) ? behavior.required_checks : [];
    const first = asJsonObject(checks[0]) ? checks[0] : undefined;
    if (first === undefined) throw new Error("snapshot has no frozen check");
    first.evidence_layer = "model";
    writeFileSync(runFile(dir, run), `${JSON.stringify(doc, null, 2)}\n`);
    expect(classifyRun(readRun(dir, run), run).kind).toBe("incomplete");
    recordPhases(dir);
    expect(ak(dir, "record", "--gate", "verify", "--receipt", receipt(dir, run, ticket)).code).toBe(0);
    expect(ak(dir, "check").code).toBe(1);
  });

  test("a snapshot copied from another run is a wrong-run refusal", () => {
    const dir = repo();
    const firstTicket = behaviorTicket(dir, "first-run");
    const secondTicket = behaviorTicket(dir, "second-run");
    const projectPath = projectRecord(dir, "on");
    const first = opened(dir, ticketPath(dir, "first-run"), projectPath);
    git(dir, "checkout", "-q", "-b", "other");
    const second = opened(dir, ticketPath(dir, "second-run"), projectPath);
    const secondDoc = readRun(dir, second);
    const copied = readRun(dir, first).behavior;
    if (copied === undefined) throw new Error("first run has no snapshot");
    secondDoc.behavior = copied;
    writeFileSync(runFile(dir, second), `${JSON.stringify(secondDoc, null, 2)}\n`);
    recordPhases(dir);
    expect(ak(dir, "record", "--gate", "verify", "--receipt", receipt(dir, second, secondTicket)).code).toBe(0);
    const checked = ak(dir, "check");
    expect(checked.code).toBe(1);
    expect(checked.err).toContain("wrong-run");
    expect(checked.err).toContain(first);
    expect(firstTicket.schema).toBe("ticket");
  });

  test("a new enabled run missing its snapshot is incomplete, not legacy", () => {
    const dir = repo();
    const ticket = behaviorTicket(dir, "stripped");
    const run = opened(dir, ticketPath(dir, "stripped"), projectRecord(dir, "on"));
    const doc = readRun(dir, run);
    delete doc.behavior;
    writeFileSync(runFile(dir, run), `${JSON.stringify(doc, null, 2)}\n`);
    recordPhases(dir);
    expect(ak(dir, "record", "--gate", "verify", "--receipt", receipt(dir, run, ticket)).code).toBe(0);
    const checked = ak(dir, "check");
    expect(checked.code).toBe(1);
    expect(checked.err).toContain("behavior-policy");
    expect(checked.err).not.toContain("legacy");
    expect(classifyRun(readRun(dir, run), run).kind).toBe("incomplete");
  });

  test("a worker legacy flag does not downgrade an enabled snapshot", () => {
    const dir = repo();
    const ticket = behaviorTicket(dir, "no-legacy");
    const run = opened(dir, ticketPath(dir, "no-legacy"), projectRecord(dir, "on"));
    const doc = readRun(dir, run);
    const behavior = asJsonObject(doc.behavior) ? doc.behavior : undefined;
    if (behavior === undefined) throw new Error("enabled run has no snapshot");
    behavior.legacy = true;
    writeFileSync(runFile(dir, run), `${JSON.stringify(doc, null, 2)}\n`);
    expect(bindingOf(readRun(dir, run))?.mode).toBe("on");
    recordPhases(dir);
    expect(ak(dir, "record", "--gate", "verify", "--receipt", receipt(dir, run, ticket)).code).toBe(0);
    expect(ak(dir, "check").code).toBe(0);
  });

  test("missing project record cannot open an enabled ticket as off", () => {
    const dir = repo();
    behaviorTicket(dir, "need-project");
    const r = ak(dir, "open", "--ticket", ticketPath(dir, "need-project"));
    expect(r.code).toBe(1);
    expect(r.err).toContain("authoritative project record");
    expect(r.err).toContain("cannot turn this run off");
  });

  test("off plus mandatory behavior checks is a configuration conflict", () => {
    const dir = repo();
    behaviorTicket(dir, "conflict-off");
    const r = ak(
      dir,
      "open",
      "--ticket",
      ticketPath(dir, "conflict-off"),
      "--project-record",
      projectRecord(dir, "off"),
    );
    expect(r.code).toBe(1);
    expect(r.err).toContain("cannot cancel those checks");
  });

  test("shadow plus mandatory behavior checks is a configuration conflict", () => {
    const dir = repo();
    behaviorTicket(dir, "conflict-shadow");
    const r = ak(
      dir,
      "open",
      "--ticket",
      ticketPath(dir, "conflict-shadow"),
      "--project-record",
      projectRecord(dir, "shadow"),
    );
    expect(r.code).toBe(1);
    expect(r.err).toContain("authorized resolution path");
  });

  test("shadow mode retains current completion and a shadow receipt cannot satisfy a missing check", () => {
    const dir = repo();
    const ticket = plainTicket(dir, "shadow-plain");
    const run = opened(dir, ticketPath(dir, "shadow-plain"), projectRecord(dir, "shadow"));
    expect(bindingOf(readRun(dir, run))?.mode).toBe("shadow");
    recordPhases(dir);
    const shadowOnly = receipt(dir, run, ticket, { behavior: { mode: "shadow", gate_eligible: false } });
    expect(ak(dir, "record", "--gate", "verify", "--receipt", shadowOnly).code).toBe(0);
    const missing = ak(dir, "check");
    expect(missing.code).toBe(1);
    expect(missing.err).toContain("no passed evidence");
    expect(ak(dir, "record", "--gate", "verify", "--receipt", receipt(dir, run, ticket)).code).toBe(0);
    const allowed = ak(dir, "check");
    expect(allowed.code).toBe(0);
    expect(allowed.err).toContain("shadow behavior artifact");
    expect(allowed.err).toContain("not gate evidence");
  });

  test("an authorized new open records the updated policy; the earlier run keeps its snapshot", () => {
    const dir = repo();
    behaviorTicket(dir, "policy-v1");
    const first = opened(dir, ticketPath(dir, "policy-v1"), projectRecord(dir, "on"));
    const firstHash = bindingOf(readRun(dir, first))?.binding_hash;
    git(dir, "checkout", "-q", "-b", "policy-update");
    projectRecord(dir, "off", "example-project");
    plainTicket(dir, "policy-v2");
    const second = opened(dir, ticketPath(dir, "policy-v2"), join(dir, "example-project.project.json"));
    expect(bindingOf(readRun(dir, first))?.mode).toBe("on");
    expect(bindingOf(readRun(dir, first))?.binding_hash).toBe(firstHash);
    expect(bindingOf(readRun(dir, second))?.mode).toBe("off");
    expect(readdirSync(join(defaultEvidenceDir(dir), "runs"))).toEqual(expect.arrayContaining([first, second]));
  });

  test("an unreadable project record named at open fails closed", () => {
    const dir = repo();
    plainTicket(dir, "bad-project");
    const r = ak(
      dir,
      "open",
      "--ticket",
      ticketPath(dir, "bad-project"),
      "--project-record",
      join(dir, "missing.json"),
    );
    expect(r.code).toBe(1);
    expect(r.err).toContain("cannot read project record");
  });

  test("the bundled standalone gate refuses an enabled open without a project record", () => {
    const { catalog } = loadCatalog(ROOT);
    if (catalog === null) throw new Error("no catalog");
    const file = planBundle({ root: ROOT, catalog }, "claude-code", {}).files.get(GATE_FILE);
    if (file === undefined) throw new Error("planned gate missing");
    expect(file.contents).toContain("cannot turn this run off");
    const script = join(mkdtempSync(join(tmpdir(), "ak-bv-gate-")), "ak-gate.mjs");
    writeFileSync(script, file.contents);
    const dir = repo();
    behaviorTicket(dir, "bundled-need-project");
    const result = Bun.spawnSync(["node", script, "open", "--ticket", ticketPath(dir, "bundled-need-project")], {
      cwd: dir,
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("authoritative project record");
  });
});
