/**
 * `ak lifecycle bypass grant|check` and `record --bypass`: the supervisor-held grant that starts the
 * human-started lifecycle phases for one task without a typed command (ADR-0008). Start only.
 *
 * Every case is a temp repository with a linked worktree standing in for the worker's, a temp
 * supervisor home outside both, and a temp ledger handed to `main` in place of the account's.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";

import { parse } from "yaml";

import { loadCatalog } from "../../src/catalog/load.ts";
import {
  BYPASS_PHASES,
  checkBypass,
  defaultEvidenceDir,
  main,
  readRecords,
  takeSnapshot,
  type GateRecord,
} from "../../src/lifecycle/gate.ts";
import { GATE_FILE, planBundle } from "../../src/packaging/plan.ts";
import { artifactHash } from "../../src/util/hash.ts";
import { makeTree } from "../helpers/tree.ts";

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

const dir = (prefix: string) => mkdtempSync(join(tmpdir(), prefix));

/** The id of the one grant registered in a ledger, from its ledger file name. */
/** The grant entries in a ledger: `<grant_id>.json` files, not the `ended/` directory beside them. */
const entries = (ledger: string) => readdirSync(ledger).filter((name) => name.endsWith(".json"));

function grantId(ledger: string): string {
  const [name] = entries(ledger);
  if (name === undefined) throw new Error("nothing registered");
  return name.replace(/\.json$/, "");
}

function only(records: GateRecord[]): GateRecord {
  expect(records).toHaveLength(1);
  const [record] = records;
  if (record === undefined) throw new Error("no record");
  return record;
}

/** A project, the worker's linked worktree on branch `task`, a supervisor home and a ledger. */
function setup() {
  const project = makeTree({ "src/a.js": "export const a = 1;\n" });
  git(project, "init", "-q", "-b", "main");
  git(project, "add", "-A");
  git(project, "commit", "-q", "-m", "init");
  const worktree = join(dir("ak-bypass-wt-"), "task");
  git(project, "worktree", "add", "-q", "-b", "task", worktree);
  const home = dir("ak-bypass-home-");
  const ledger = dir("ak-bypass-ledger-");
  return { project, worktree, home, ledger, grantPath: join(home, "data", "T-1", "bypass.json") };
}

function akAt(now: () => Date, cwd: string, ledger: string, ...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = main(argv, { out: (l) => out.push(l), err: (l) => err.push(l) }, cwd, ledger, now);
  return { code, out: out.join("\n"), err: err.join("\n") };
}

const ak = (cwd: string, ledger: string, ...argv: string[]) => akAt(() => new Date(), cwd, ledger, ...argv);

/** A clock a day and an hour on, past a default grant's expiry. */
const dayLater = () => new Date(Date.now() + 25 * 3_600_000);

const checkPhase = (s: ReturnType<typeof setup>, grant: string, task: string, phase: string) =>
  ak(s.worktree, s.ledger, "bypass", "check", "--grant", grant, "--task", task, "--phase", phase);

const recordArgs = (gate: string, grant: string, task: string) => [
  "record",
  "--gate",
  gate,
  "--bypass",
  grant,
  "--task",
  task,
];

/** A second grant on the setup's worktree, issued at `now`, for `task`: its path and id. */
function freshGrant(s: ReturnType<typeof setup>, now: () => Date, task: string) {
  const before = new Set(entries(s.ledger));
  const path = join(s.home, "data", task, "bypass-fresh.json");
  const r = akAt(
    now,
    s.home,
    s.ledger,
    "bypass",
    "grant",
    "--task",
    task,
    "--by",
    "captain",
    "--reason",
    "r",
    "--out",
    path,
    "--project",
    s.project,
    "--worktree",
    s.worktree,
  );
  expect(r).toMatchObject({ code: 0 });
  const added = entries(s.ledger).filter((name) => !before.has(name));
  expect(added).toHaveLength(1);
  return { path, id: String(added[0]).replace(/\.json$/, "") };
}

/** `bypass grant` for task T-1 on the setup's worktree, run from `cwd`. */
function grantFrom(s: ReturnType<typeof setup>, cwd: string, out: string, ...extra: string[]) {
  return ak(
    cwd,
    s.ledger,
    "bypass",
    "grant",
    "--task",
    "T-1",
    "--by",
    "captain",
    "--reason",
    "r",
    "--out",
    out,
    "--project",
    s.project,
    "--worktree",
    s.worktree,
    ...extra,
  );
}

function granted() {
  const s = setup();
  const r = ak(
    s.home,
    s.ledger,
    "bypass",
    "grant",
    "--task",
    "T-1",
    "--by",
    "captain",
    "--reason",
    "ENG-4151 is customer-blocking",
    "--out",
    s.grantPath,
    "--project",
    s.project,
    "--worktree",
    s.worktree,
  );
  expect(r).toMatchObject({ code: 0 });
  return { ...s, brief: r.out };
}

describe("bypass granted: phases start without a typed command", () => {
  test("grant writes the file outside the repository and prints the brief section", () => {
    const { grantPath, brief, ledger } = granted();
    expect(JSON.parse(readFileSync(grantPath, "utf8"))).toMatchObject({
      schema: "bypass-grant",
      authorized_by: "captain",
      approvals: "supervisor",
      covers: [...BYPASS_PHASES],
      grant_id: grantId(ledger),
    });
    expect(readdirSync(ledger)).toHaveLength(1);
    expect(brief).toContain(`bypass check --grant ${realpathSync(grantPath)} --task T-1 --phase`);
    expect(brief).toContain("Every approval inside a phase stops with needs-decision");
  });

  test("the worker's check passes for every phase and leaves a use record naming who authorized it", () => {
    const { worktree, ledger, grantPath } = granted();
    for (const phase of BYPASS_PHASES) {
      const r = ak(worktree, ledger, "bypass", "check", "--grant", grantPath, "--task", "T-1", "--phase", phase);
      expect(r.code).toBe(0);
      expect(JSON.parse(r.out)).toMatchObject({ mode: "bypass", authorized_by: "captain", task_id: "T-1", phase });
    }
    const used = join(defaultEvidenceDir(worktree), "task", "bypass");
    expect(readdirSync(used).toSorted()).toEqual(BYPASS_PHASES.map((p) => `${p.replace(":", "-")}.json`).toSorted());
  });

  test("a gate recorded with --bypass carries the attribution; one recorded without it does not", () => {
    const { worktree, ledger, grantPath } = granted();
    expect(ak(worktree, ledger, "record", "--gate", "review-full", "--bypass", grantPath, "--task", "T-1").code).toBe(
      0,
    );
    expect(ak(worktree, ledger, "record", "--gate", "build-checks").code).toBe(0);
    const evidence = defaultEvidenceDir(worktree);
    const full = only(readRecords(evidence, "task", "review-full"));
    expect(full.authority).toMatchObject({ mode: "bypass", authorized_by: "captain", task_id: "T-1" });
    expect(full.authority?.mode === "bypass" && full.authority.grant_sha256).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(only(readRecords(evidence, "task", "build-checks")).authority).toBeUndefined();
  });
});

describe("start only: approvals, merge and deploy are never covered", () => {
  test("a host-unattested verifier receipt is refused once a checked gate started under the grant", () => {
    for (const start of ["typed", "bypass", "ship-use", "before-open", "other-task"] as const) {
      const s = granted();
      const { worktree, ledger, grantPath } = s;
      const task = start === "other-task" ? "T-2" : "T-1";
      const recipe = { id: "service-runtime", hash: `sha256:${"1".repeat(64)}` };
      const ticket = {
        schema: "ticket",
        schema_version: 1,
        id: task,
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
      const ticketPath = join(worktree, "T-1.json");
      writeFileSync(ticketPath, `${JSON.stringify(ticket)}\n`);
      if (start === "before-open" || start === "other-task")
        expect(
          ak(worktree, ledger, "bypass", "check", "--grant", grantPath, "--task", "T-1", "--phase", "super-align").code,
        ).toBe(0);
      if (start === "other-task") expect(checkPhase(s, grantPath, "T-1", "super-review:full").code).toBe(0);
      const grantFlags = start === "bypass" ? ["--bypass", grantPath, "--task", "T-1"] : [];
      const openAndCheck = () => {
        const run = ak(worktree, ledger, "open", "--ticket", ticketPath).out.match(/^opened run (.+)$/m)?.[1];
        if (run === undefined) throw new Error("open did not return a run id");
        expect(ak(worktree, ledger, "record", "--gate", "build-checks").code).toBe(0);
        expect(ak(worktree, ledger, "record", "--gate", "review-full", ...grantFlags).code).toBe(0);
        expect(ak(worktree, ledger, "record", "--gate", "review-readiness", ...grantFlags).code).toBe(0);
        const snapshot = takeSnapshot(worktree);
        if (typeof snapshot === "string") throw new Error(snapshot);
        const receiptDir = dir("ak-bypass-receipt-");
        const log = "1 pass, 0 fail\n";
        writeFileSync(join(receiptDir, "verification-output.log"), log);
        const digest = `sha256:${createHash("sha256").update(log).digest("hex")}`;
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
            output_digest: digest,
            artifacts: [{ path: "verification-output.log", digest, kind: "log" }],
            environment: { id: "test", isolated: true, secrets_policy: "none" },
            supports: ["AC-1"],
            check: "project-check",
            ticket: { id: task, schema: "ticket", hash: artifactHash(ticket) },
            recipe,
            evidence_kind: "smoke-test",
            verifier_seat: {
              id: "verify-1",
              implementer_seat: "build-1",
              isolation: "host-unattested",
              attestation: null,
            },
          })}\n`,
        );
        expect(ak(worktree, ledger, "record", "--gate", "verify", "--receipt", receiptPath).code).toBe(0);
        if (start === "ship-use")
          expect(
            ak(worktree, ledger, "bypass", "check", "--grant", grantPath, "--task", "T-1", "--phase", "super-ship")
              .code,
          ).toBe(0);
        return { run, ...ak(worktree, ledger, "check") };
      };
      const byHand = "note: verifier seat verify-1 on receipt verification-1 is host-unattested";
      const checked = openAndCheck();
      if (start === "typed" || start === "other-task") {
        expect(checked.err).toContain(byHand);
        expect(checked.code).toBe(0);
      }
      if (start === "other-task") {
        expect(checkPhase(s, freshGrant(s, () => new Date(), "T-2").path, "T-2", "super-review:full").code).toBe(0);
        const earlier = join(defaultEvidenceDir(worktree), "task", "bypass");
        for (const phase of ["super-align", "super-review-full"])
          expect(JSON.parse(readFileSync(join(earlier, `${phase}.json`), "utf8"))).toMatchObject({ task_id: "T-1" });
      }
      if (start === "typed" || start === "other-task") continue;
      const used = { bypass: "super-review-full", "ship-use": "super-ship", "before-open": "super-align" }[start];
      expect(checked.code).toBe(1);
      expect(checked.err).toContain(
        `refused: verifier seat verify-1 is host-unattested; autonomous ship requires a runner attestation (the run holds grant record ${join(defaultEvidenceDir(worktree), checked.run, "bypass", `${used}.json`)})`,
      );
      if (start !== "before-open") continue;
      const fresh = openAndCheck();
      expect(fresh.err).toContain(byHand);
      expect(fresh.code).toBe(0);
    }
  }, 120_000);

  test("policies/invocation.yaml lists the same bypass phases the gate starts", () => {
    expect(parse(readFileSync(join(REPO, "policies", "invocation.yaml"), "utf8"))).toMatchObject({
      bypass: { phases: [...BYPASS_PHASES] },
    });
  });

  test.each(["align-answer", "spec-approval", "ticket-approval", "ship-pr", "merge", "deploy", "autopilot"])(
    "%s is refused with a needs-decision hint",
    (phase) => {
      const { worktree, ledger, grantPath } = granted();
      const r = ak(worktree, ledger, "bypass", "check", "--grant", grantPath, "--task", "T-1", "--phase", phase);
      expect(r.code).toBe(1);
      expect(r.err).toContain("not a phase a bypass grant starts");
      expect(r.err).toContain("needs-decision");
    },
  );
});

describe("bypass absent or forged: the refusal is unchanged", () => {
  test("no grant file: refused, and no use record is written", () => {
    const s = setup();
    const r = ak(
      s.worktree,
      s.ledger,
      "bypass",
      "check",
      "--grant",
      s.grantPath,
      "--task",
      "T-1",
      "--phase",
      "super-align",
    );
    expect(r.code).toBe(1);
    expect(r.err).toContain("does not exist");
    expect(existsSync(join(defaultEvidenceDir(s.worktree), "task", "bypass"))).toBe(false);
  });

  test("a grant edited after it was registered is refused", () => {
    const { worktree, ledger, grantPath } = granted();
    const text = readFileSync(grantPath, "utf8");
    writeFileSync(grantPath, text.replace('"authorized_by": "captain"', '"authorized_by": "someone else"'));
    const r = ak(worktree, ledger, "bypass", "check", "--grant", grantPath, "--task", "T-1", "--phase", "super-align");
    expect(r.code).toBe(1);
    expect(r.err).toContain("not the sha256:");
  });

  test("a copy of a registered grant is refused", () => {
    const { worktree, ledger, grantPath, home } = granted();
    const copy = join(home, "copy.json");
    copyFileSync(grantPath, copy);
    const r = ak(worktree, ledger, "bypass", "check", "--grant", copy, "--task", "T-1", "--phase", "super-align");
    expect(r.code).toBe(1);
    expect(r.err).toContain("that was registered");
  });

  test("a well-formed grant nobody registered is refused", () => {
    const s = setup();
    const { grantPath } = granted();
    mkdirSync(join(s.home, "data"), { recursive: true });
    const forged = join(s.home, "data", "forged.json");
    copyFileSync(grantPath, forged);
    const r = ak(s.worktree, s.ledger, "bypass", "check", "--grant", forged, "--task", "T-1", "--phase", "super-align");
    expect(r.code).toBe(1);
    expect(r.err).toContain("was never registered");
  });

  test("an expired grant is refused", () => {
    const s = setup();
    expect(
      ak(
        s.home,
        s.ledger,
        "bypass",
        "grant",
        "--task",
        "T-1",
        "--by",
        "captain",
        "--reason",
        "r",
        "--out",
        s.grantPath,
        "--project",
        s.project,
        "--worktree",
        s.worktree,
        "--hours",
        "1",
      ).code,
    ).toBe(0);
    const later = new Date(Date.now() + 3_600_001);
    const r = checkBypass({
      grant: s.grantPath,
      task: "T-1",
      cwd: s.worktree,
      phase: "super-align",
      project: s.worktree,
      ledger: s.ledger,
      now: () => later,
    });
    expect(r).toMatchObject({ ok: false });
    expect(!r.ok && r.reason).toContain("expired");
  });

  test("a grant for another repository is refused", () => {
    const { ledger, grantPath } = granted();
    const other = setup();
    const r = ak(
      other.worktree,
      ledger,
      "bypass",
      "check",
      "--grant",
      grantPath,
      "--task",
      "T-1",
      "--phase",
      "super-align",
    );
    expect(r.code).toBe(1);
    expect(r.err).toContain("is for");
  });

  test("record --bypass with a forged grant writes no record", () => {
    const { worktree, ledger, grantPath } = granted();
    writeFileSync(grantPath, readFileSync(grantPath, "utf8").replace("captain", "captain2"));
    expect(ak(worktree, ledger, "record", "--gate", "review-full", "--bypass", grantPath, "--task", "T-1").code).toBe(
      1,
    );
    expect(readRecords(defaultEvidenceDir(worktree), "task", "review-full")).toEqual([]);
  });
});

describe("one task: the grant binds to the task it names and that task's worktree, not to a run", () => {
  test("another task's grant is refused at check, and no use record is written", () => {
    const { worktree, ledger, grantPath } = granted();
    const r = ak(worktree, ledger, "bypass", "check", "--grant", grantPath, "--task", "T-2", "--phase", "super-align");
    expect(r.code).toBe(1);
    expect(r.err).toContain("is for task T-1, not T-2");
    expect(existsSync(join(defaultEvidenceDir(worktree), "task", "bypass"))).toBe(false);
  });

  test("another task's grant is refused at record --bypass, and no gate record is written", () => {
    const { worktree, ledger, grantPath } = granted();
    const r = ak(worktree, ledger, "record", "--gate", "review-full", "--bypass", grantPath, "--task", "T-2");
    expect(r.code).toBe(1);
    expect(r.err).toContain("is for task T-1, not T-2");
    expect(readRecords(defaultEvidenceDir(worktree), "task", "review-full")).toEqual([]);
  });

  test("check and record --bypass without --task are usage errors", () => {
    const { worktree, ledger, grantPath } = granted();
    expect(ak(worktree, ledger, "bypass", "check", "--grant", grantPath, "--phase", "super-align").code).toBe(2);
    expect(ak(worktree, ledger, "record", "--gate", "review-full", "--bypass", grantPath).code).toBe(2);
    expect(readRecords(defaultEvidenceDir(worktree), "task", "review-full")).toEqual([]);
  });

  test("another task's worktree of the same repository is refused at check and record --bypass, even with the right --task", () => {
    const { project, ledger, grantPath } = granted();
    const other = join(dir("ak-bypass-wt-"), "other");
    git(project, "worktree", "add", "-q", "-b", "other", other);
    const r = ak(other, ledger, "bypass", "check", "--grant", grantPath, "--task", "T-1", "--phase", "super-align");
    expect(r.code).toBe(1);
    expect(r.err).toContain("is for worktree");
    expect(existsSync(join(defaultEvidenceDir(other), "other", "bypass"))).toBe(false);
    const rec = ak(other, ledger, "record", "--gate", "review-full", "--bypass", grantPath, "--task", "T-1");
    expect(rec.code).toBe(1);
    expect(rec.err).toContain("is for worktree");
    expect(readRecords(defaultEvidenceDir(other), "other", "review-full")).toEqual([]);
  });

  test("--project naming the granted worktree does not let another worktree pass check or record --bypass", () => {
    const { project, worktree, ledger, grantPath } = granted();
    const other = join(dir("ak-bypass-wt-"), "other");
    git(project, "worktree", "add", "-q", "-b", "other", other);
    const flags = ["--grant", grantPath, "--task", "T-1", "--project", worktree];
    const r = ak(other, ledger, "bypass", "check", ...flags, "--phase", "super-align");
    expect(r.code).toBe(1);
    expect(r.err).toContain("is not the worktree this runs from");
    expect(existsSync(join(defaultEvidenceDir(other), "other", "bypass"))).toBe(false);
    const rec = ak(
      other,
      ledger,
      "record",
      "--gate",
      "review-full",
      "--bypass",
      grantPath,
      "--task",
      "T-1",
      "--project",
      worktree,
      "--run",
      "other",
    );
    expect(rec.code).toBe(1);
    expect(rec.err).toContain("is not the worktree this runs from");
    expect(readRecords(defaultEvidenceDir(other), "other", "review-full")).toEqual([]);
  });

  test("grant refuses a worktree that is not one of the repository's", () => {
    const s = setup();
    const r = ak(
      s.home,
      s.ledger,
      "bypass",
      "grant",
      "--task",
      "T-1",
      "--by",
      "captain",
      "--reason",
      "r",
      "--out",
      s.grantPath,
      "--project",
      s.project,
      "--worktree",
      s.home,
    );
    expect(r.code).toBe(1);
    expect(r.err).toContain("is not one of the worktrees");
    expect(existsSync(s.grantPath)).toBe(false);
  });

  test("a grant works only in the run it starts in; super-build's new run takes a fresh grant through ship", () => {
    const g = granted();
    const { worktree, ledger, grantPath, home } = g;
    const check = (grant: string, phase: string) =>
      ak(worktree, ledger, "bypass", "check", "--grant", grant, "--task", "T-1", "--phase", phase);
    expect(check(grantPath, "super-align").code).toBe(0);
    expect(check(grantPath, "super-bound").code).toBe(0);
    const ticketPath = join(home, "ticket.json");
    writeFileSync(ticketPath, JSON.stringify({ id: "T-1" }));
    const opened = ak(worktree, ledger, "open", "--ticket", ticketPath);
    expect(opened.code).toBe(0);
    const run = opened.out.replace(/^opened run /, "");
    expect(run).not.toBe("task");
    const refused = check(grantPath, "super-review:full");
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("first used in run task");
    expect(refused.err).toContain("fresh grant for this run");
    expect(ak(worktree, ledger, ...recordArgs("review-full", grantPath, "T-1")).code).toBe(1);
    expect(readRecords(defaultEvidenceDir(worktree), run, "review-full")).toEqual([]);
    const fresh = freshGrant(g, () => new Date(), "T-1");
    expect(check(fresh.path, "super-review:full").code).toBe(0);
    expect(ak(worktree, ledger, ...recordArgs("review-full", fresh.path, "T-1")).code).toBe(0);
    expect(check(fresh.path, "super-ship").code).toBe(0);
    expect(ak(worktree, ledger, ...recordArgs("ship-preflight", fresh.path, "T-1")).code).toBe(0);
    expect(readRecords(defaultEvidenceDir(worktree), run, "ship-preflight").map((r) => r.authority)).toEqual([
      expect.objectContaining({ mode: "bypass", grant_id: fresh.id, task_id: "T-1" }),
    ]);
  });

  test("a phase-less check is a read-only probe and writes no use record", () => {
    const { worktree, ledger, grantPath } = granted();
    expect(ak(worktree, ledger, "bypass", "check", "--grant", grantPath, "--task", "T-1").code).toBe(0);
    expect(existsSync(join(defaultEvidenceDir(worktree), "task", "bypass"))).toBe(false);
  });
});

describe("attribution: --bypass only where a phase covers the gate, and a typed record after a bypassed start is marked explicit", () => {
  test.each(["build-checks", "verify", "review-delta"])(
    "record --gate %s --bypass is refused and writes nothing",
    (gate) => {
      const { worktree, ledger, grantPath } = granted();
      const r = ak(worktree, ledger, "record", "--gate", gate, "--bypass", grantPath, "--task", "T-1");
      expect(r.code).toBe(1);
      expect(r.err).toContain("does not apply");
      expect(existsSync(join(defaultEvidenceDir(worktree), "task", gate))).toBe(false);
    },
  );

  test("a review started under a grant that expired continues under a fresh grant for the same task", () => {
    const s = granted();
    const first = grantId(s.ledger);
    expect(checkPhase(s, s.grantPath, "T-1", "super-review:full").code).toBe(0);
    const expired = akAt(dayLater, s.worktree, s.ledger, ...recordArgs("review-full", s.grantPath, "T-1"));
    expect(expired.code).toBe(1);
    expect(expired.err).toContain("expired");
    expect(readRecords(defaultEvidenceDir(s.worktree), "task", "review-full")).toEqual([]);
    const fresh = freshGrant(s, dayLater, "T-1");
    expect(akAt(dayLater, s.worktree, s.ledger, ...recordArgs("review-full", fresh.path, "T-1")).code).toBe(0);
    expect(only(readRecords(defaultEvidenceDir(s.worktree), "task", "review-full")).authority).toMatchObject({
      mode: "bypass",
      grant_id: fresh.id,
      task_id: "T-1",
      superseded_grant_id: first,
    });
  });

  test("a typed record after a bypassed start succeeds and names the grant it ends", () => {
    const s = granted();
    expect(checkPhase(s, s.grantPath, "T-1", "super-review:full").code).toBe(0);
    expect(ak(s.worktree, s.ledger, "record", "--gate", "review-full").code).toBe(0);
    expect(only(readRecords(defaultEvidenceDir(s.worktree), "task", "review-full")).authority).toEqual({
      mode: "explicit",
      superseded_grant_id: grantId(s.ledger),
    });
  });

  test("another task's grant cannot continue a bypassed start, at check or at record", () => {
    const s = granted();
    const first = grantId(s.ledger);
    expect(checkPhase(s, s.grantPath, "T-1", "super-review:full").code).toBe(0);
    const other = freshGrant(s, () => new Date(), "T-2").path;
    const checked = checkPhase(s, other, "T-2", "super-review:full");
    expect(checked.code).toBe(1);
    expect(checked.err).toContain("started under bypass grant");
    const recorded = ak(s.worktree, s.ledger, ...recordArgs("review-full", other, "T-2"));
    expect(recorded.code).toBe(1);
    expect(recorded.err).toContain("started under bypass grant");
    expect(readRecords(defaultEvidenceDir(s.worktree), "task", "review-full")).toEqual([]);
    const used = join(defaultEvidenceDir(s.worktree), "task", "bypass", "super-review-full.json");
    expect(JSON.parse(readFileSync(used, "utf8"))).toMatchObject({ grant_id: first, task_id: "T-1" });
  });

  test("a bypassed record at one snapshot is re-recorded by a fresh same-task grant, then by a typed record", () => {
    const s = granted();
    const first = grantId(s.ledger);
    expect(ak(s.worktree, s.ledger, ...recordArgs("review-readiness", s.grantPath, "T-1")).code).toBe(0);
    const fresh = freshGrant(s, dayLater, "T-1");
    expect(akAt(dayLater, s.worktree, s.ledger, ...recordArgs("review-readiness", fresh.path, "T-1")).code).toBe(0);
    const evidence = defaultEvidenceDir(s.worktree);
    expect(only(readRecords(evidence, "task", "review-readiness")).authority).toMatchObject({
      mode: "bypass",
      grant_id: fresh.id,
      superseded_grant_id: first,
    });
    expect(ak(s.worktree, s.ledger, "record", "--gate", "review-readiness").code).toBe(0);
    expect(only(readRecords(evidence, "task", "review-readiness")).authority).toEqual({
      mode: "explicit",
      superseded_grant_id: fresh.id,
    });
    const after = akAt(dayLater, s.worktree, s.ledger, ...recordArgs("review-readiness", fresh.path, "T-1"));
    expect(after.code).toBe(1);
    expect(after.err).toContain("ended by a typed record");
    expect(after.err).not.toContain("undefined");
    expect(only(readRecords(evidence, "task", "review-readiness")).authority).toEqual({
      mode: "explicit",
      superseded_grant_id: fresh.id,
    });
  });
});

describe("a typed record ends a bypassed phase for the run, and a hand-started phase stays typed", () => {
  test("after a typed end, the original grant is refused at a later snapshot, and a fresh grant re-starts it", () => {
    const s = granted();
    const first = grantId(s.ledger);
    const evidence = defaultEvidenceDir(s.worktree);
    expect(checkPhase(s, s.grantPath, "T-1", "super-review:full").code).toBe(0);
    expect(ak(s.worktree, s.ledger, "record", "--gate", "review-full").code).toBe(0);
    writeFileSync(join(s.worktree, "src", "a.js"), "export const a = 2;\n");
    const again = ak(s.worktree, s.ledger, ...recordArgs("review-full", s.grantPath, "T-1"));
    expect(again.code).toBe(1);
    expect(again.err).toContain("ended by a typed record");
    expect(checkPhase(s, s.grantPath, "T-1", "super-review:full").code).toBe(1);
    expect(readRecords(evidence, "task", "review-full")).toHaveLength(1);
    const fresh = freshGrant(s, dayLater, "T-1");
    expect(akAt(dayLater, s.worktree, s.ledger, ...recordArgs("review-full", fresh.path, "T-1")).code).toBe(0);
    const records = readRecords(evidence, "task", "review-full");
    expect(records).toHaveLength(2);
    expect(records.map((r) => r.authority)).toContainEqual(
      expect.objectContaining({ mode: "bypass", grant_id: fresh.id, superseded_grant_id: first }),
    );
  });

  test("a typed end needs no write to the ledger: with the ledger read-only it still ends the grant in the run", () => {
    const s = granted();
    expect(checkPhase(s, s.grantPath, "T-1", "super-review:full").code).toBe(0);
    chmodSync(s.ledger, 0o555);
    try {
      expect(ak(s.worktree, s.ledger, "record", "--gate", "review-full").code).toBe(0);
      writeFileSync(join(s.worktree, "src", "a.js"), "export const a = 4;\n");
      const checked = checkPhase(s, s.grantPath, "T-1", "super-review:full");
      expect(checked.code).toBe(1);
      expect(checked.err).toContain("ended by a typed record");
      expect(ak(s.worktree, s.ledger, ...recordArgs("review-full", s.grantPath, "T-1")).code).toBe(1);
      expect(readRecords(defaultEvidenceDir(s.worktree), "task", "review-full")).toHaveLength(1);
    } finally {
      chmodSync(s.ledger, 0o755);
    }
  });

  test("--dir is refused with a bypass grant, so another store cannot dodge the typed end (P9b)", () => {
    const s = granted();
    const elsewhere = dir("ak-bypass-store-");
    const checked = ak(
      s.worktree,
      s.ledger,
      "bypass",
      "check",
      "--grant",
      s.grantPath,
      "--task",
      "T-1",
      "--phase",
      "super-review:full",
      "--dir",
      elsewhere,
    );
    expect(checked.code).toBe(2);
    expect(checked.err).toContain("--dir is refused");
    const recorded = ak(s.worktree, s.ledger, ...recordArgs("review-full", s.grantPath, "T-1"), "--dir", elsewhere);
    expect(recorded.code).toBe(2);
    expect(readdirSync(elsewhere)).toEqual([]);
  });

  test("a fresh grant re-starting at the snapshot of a typed end keeps the ended grant refused", () => {
    const s = granted();
    const first = grantId(s.ledger);
    expect(ak(s.worktree, s.ledger, ...recordArgs("review-readiness", s.grantPath, "T-1")).code).toBe(0);
    expect(ak(s.worktree, s.ledger, "record", "--gate", "review-readiness").code).toBe(0);
    const fresh = freshGrant(s, dayLater, "T-1");
    expect(akAt(dayLater, s.worktree, s.ledger, ...recordArgs("review-readiness", fresh.path, "T-1")).code).toBe(0);
    const used = join(defaultEvidenceDir(s.worktree), "task", "bypass", "super-review-readiness.json");
    expect(JSON.parse(readFileSync(used, "utf8"))).toMatchObject({
      grant_id: fresh.id,
      ended_grant_ids: [first],
    });
    expect(checkPhase(s, s.grantPath, "T-1", "super-review:readiness").code).toBe(1);
  });

  test("a grant a typed record ended stays refused after a fresh grant re-starts the phase", () => {
    const s = granted();
    const first = grantId(s.ledger);
    const evidence = defaultEvidenceDir(s.worktree);
    expect(checkPhase(s, s.grantPath, "T-1", "super-review:readiness").code).toBe(0);
    expect(ak(s.worktree, s.ledger, "record", "--gate", "review-readiness").code).toBe(0);
    const fresh = freshGrant(s, () => new Date(), "T-1");
    expect(checkPhase(s, fresh.path, "T-1", "super-review:readiness").code).toBe(0);
    const checked = checkPhase(s, s.grantPath, "T-1", "super-review:readiness");
    expect(checked.code).toBe(1);
    expect(checked.err).toContain(`ended by a typed record after bypass grant ${first}`);
    const recorded = ak(s.worktree, s.ledger, ...recordArgs("review-readiness", s.grantPath, "T-1"));
    expect(recorded.code).toBe(1);
    expect(only(readRecords(evidence, "task", "review-readiness")).authority).toEqual({
      mode: "explicit",
      superseded_grant_id: first,
    });
    expect(ak(s.worktree, s.ledger, ...recordArgs("review-readiness", fresh.path, "T-1")).code).toBe(0);
    expect(only(readRecords(evidence, "task", "review-readiness")).authority).toMatchObject({
      grant_id: fresh.id,
      superseded_grant_id: first,
    });
  });

  test("a typed end refuses every grant that held the phase, not only the one in force", () => {
    const s = granted();
    const first = grantId(s.ledger);
    const evidence = defaultEvidenceDir(s.worktree);
    expect(checkPhase(s, s.grantPath, "T-1", "super-review:readiness").code).toBe(0);
    const second = freshGrant(s, () => new Date(), "T-1");
    expect(checkPhase(s, second.path, "T-1", "super-review:readiness").code).toBe(0);
    expect(ak(s.worktree, s.ledger, "record", "--gate", "review-readiness").code).toBe(0);
    for (const grant of [s.grantPath, second.path]) {
      const checked = checkPhase(s, grant, "T-1", "super-review:readiness");
      expect(checked.code).toBe(1);
      expect(checked.err).toContain("ended by a typed record");
      expect(ak(s.worktree, s.ledger, ...recordArgs("review-readiness", grant, "T-1")).code).toBe(1);
    }
    expect(only(readRecords(evidence, "task", "review-readiness")).authority).toEqual({
      mode: "explicit",
      superseded_grant_id: second.id,
    });
    expect(first).not.toBe(second.id);
  });

  test("the use record lists every grant that has held the phase, the one in force included", () => {
    const s = granted();
    const first = grantId(s.ledger);
    const used = join(defaultEvidenceDir(s.worktree), "task", "bypass", "super-review-readiness.json");
    expect(checkPhase(s, s.grantPath, "T-1", "super-review:readiness").code).toBe(0);
    expect(JSON.parse(readFileSync(used, "utf8"))).toHaveProperty("held_grant_ids", [first]);
    const second = freshGrant(s, () => new Date(), "T-1");
    expect(checkPhase(s, second.path, "T-1", "super-review:readiness").code).toBe(0);
    expect(JSON.parse(readFileSync(used, "utf8"))).toHaveProperty("held_grant_ids", [first, second.id]);
  });

  test("a phase recorded by hand cannot be relabelled with --bypass at the same snapshot", () => {
    const s = granted();
    expect(ak(s.worktree, s.ledger, "record", "--gate", "review-full").code).toBe(0);
    expect(checkPhase(s, s.grantPath, "T-1", "super-review:full").code).toBe(0);
    const relabel = ak(s.worktree, s.ledger, ...recordArgs("review-full", s.grantPath, "T-1"));
    expect(relabel.code).toBe(1);
    expect(relabel.err).toContain("record it with the typed command and no --bypass");
    expect(only(readRecords(defaultEvidenceDir(s.worktree), "task", "review-full")).authority).toBeUndefined();
  });
});

describe("one run per grant: the binding cannot be dodged by flag or by racing", () => {
  test.each([".", ".."])("--run %s is not a run id, at check and at record --bypass, and nothing is written", (dot) => {
    const s = granted();
    const store = defaultEvidenceDir(s.worktree);
    const checked = ak(
      s.worktree,
      s.ledger,
      "bypass",
      "check",
      "--grant",
      s.grantPath,
      "--task",
      "T-1",
      "--phase",
      "super-review:full",
      "--run",
      dot,
    );
    expect(checked.code).toBe(2);
    expect(checked.err).toContain("is not a run id");
    expect(ak(s.worktree, s.ledger, ...recordArgs("review-full", s.grantPath, "T-1"), "--run", dot).code).toBe(2);
    expect(ak(s.worktree, s.ledger, "record", "--gate", "review-full", "--run", dot).code).toBe(2);
    expect(existsSync(join(store, "bypass"))).toBe(false);
    expect(existsSync(join(store, "..", "bypass"))).toBe(false);
  });

  test("a grant first used under --run A is refused under --run B, with a hint naming the fresh grant", () => {
    const s = granted();
    const at = (run: string) =>
      ak(
        s.worktree,
        s.ledger,
        "bypass",
        "check",
        "--grant",
        s.grantPath,
        "--task",
        "T-1",
        "--phase",
        "super-review:full",
        "--run",
        run,
      );
    expect(at("run-a").code).toBe(0);
    const other = at("run-b");
    expect(other.code).toBe(1);
    expect(other.err).toContain("first used in run run-a");
    expect(other.err).toContain("issues a fresh grant for this run");
    expect(other.err).not.toContain("the phase needs its typed command");
    expect(at("run-a").code).toBe(0);
  });

  test("first use through record --bypass binds the grant just as a check does", () => {
    const s = granted();
    expect(ak(s.worktree, s.ledger, ...recordArgs("review-full", s.grantPath, "T-1"), "--run", "run-a").code).toBe(0);
    const other = ak(
      s.worktree,
      s.ledger,
      "bypass",
      "check",
      "--grant",
      s.grantPath,
      "--task",
      "T-1",
      "--phase",
      "super-ship",
      "--run",
      "run-b",
    );
    expect(other.code).toBe(1);
    expect(other.err).toContain("first used in run run-a");
    const recorded = ak(s.worktree, s.ledger, ...recordArgs("review-readiness", s.grantPath, "T-1"), "--run", "run-b");
    expect(recorded.code).toBe(1);
    expect(recorded.err).toContain("issues a fresh grant for this run");
    expect(readRecords(defaultEvidenceDir(s.worktree), "run-b", "review-readiness")).toEqual([]);
  });

  test("two first uses of one grant in two runs at the same moment: at most one wins", async () => {
    const script = join(dir("ak-bypass-race-"), "check.ts");
    writeFileSync(
      script,
      `import { main } from ${JSON.stringify(join(REPO, "src", "lifecycle", "gate.ts"))};
const [cwd, ledger, grant, run] = process.argv.slice(2);
process.exitCode = main(["bypass", "check", "--grant", grant, "--task", "T-1", "--phase", "super-review:full", "--run", run], { out: () => {}, err: () => {} }, cwd, ledger);
`,
    );
    let bothWon = 0;
    for (let i = 0; i < 6; i += 1) {
      const s = granted();
      const spawn = (run: string) =>
        Bun.spawn(["bun", script, s.worktree, s.ledger, s.grantPath, run], { stdout: "ignore", stderr: "ignore" });
      const [a, b] = [spawn(`run-a-${i}`), spawn(`run-b-${i}`)];
      const codes = await Promise.all([a.exited, b.exited]);
      expect(codes.toSorted()).toEqual(codes.includes(1) ? [0, 1] : [0, 0]);
      if (codes[0] === 0 && codes[1] === 0) bothWon += 1;
    }
    expect(bothWon).toBe(0);
  }, 120_000);
});

describe("a forged grant cannot ride a genuine grant's hash", () => {
  test("swapping the grant path between a forged file and the genuine one never passes an expired grant", async () => {
    const s = setup();
    expect(grantFrom(s, s.home, s.grantPath, "--hours", "1").code).toBe(0);
    const genuine = readFileSync(s.grantPath, "utf8");
    const forged = join(s.home, "forged.json");
    writeFileSync(forged, genuine.replace(/"expires_at": "[^"]*"/, '"expires_at": "2099-01-01T00:00:00.000Z"'));
    expect(readFileSync(forged, "utf8")).toContain("2099-01-01");
    const link = join(s.home, "link.json");
    symlinkSync(s.grantPath, link);
    const flipper = Bun.spawn(
      [
        "bun",
        "-e",
        `const fs=require("node:fs");const [l,a,b]=process.argv.slice(1);for(let i=0;;i++){const t=l+".t";try{fs.unlinkSync(t)}catch{};fs.symlinkSync(i%2?a:b,t);fs.renameSync(t,l)}`,
        link,
        s.grantPath,
        forged,
      ],
      { stdout: "ignore", stderr: "ignore" },
    );
    await Bun.sleep(100);
    const later = new Date(Date.now() + 48 * 3_600_000);
    const reasons = new Map<string, number>();
    let passed = 0;
    const until = Date.now() + 1500;
    while (Date.now() < until) {
      const r = checkBypass({
        grant: link,
        task: "T-1",
        phase: "super-align",
        cwd: s.worktree,
        project: s.worktree,
        ledger: s.ledger,
        now: () => later,
      });
      if (r.ok) passed += 1;
      else {
        const kind = r.reason.includes("expired")
          ? "expired"
          : r.reason.includes("registered")
            ? "not registered"
            : "other";
        reasons.set(kind, (reasons.get(kind) ?? 0) + 1);
      }
    }
    flipper.kill();
    await flipper.exited;
    expect(passed).toBe(0);
    expect(reasons.get("expired") ?? 0).toBeGreaterThan(0);
    expect(reasons.get("not registered") ?? 0).toBeGreaterThan(0);
  });
});

describe("a worker-authored grant is rejected", () => {
  test("grant refuses to run from a checkout of the repository it grants", () => {
    const s = setup();
    const r = ak(
      s.worktree,
      s.ledger,
      "bypass",
      "grant",
      "--task",
      "T-1",
      "--by",
      "captain",
      "--reason",
      "r",
      "--out",
      s.grantPath,
      "--project",
      s.project,
      "--worktree",
      s.worktree,
    );
    expect(r.code).toBe(1);
    expect(r.err).toContain("is a task checkout");
    expect(r.err).not.toMatch(/outside|elsewhere|another directory/);
    expect(existsSync(s.grantPath)).toBe(false);
    expect(readdirSync(s.ledger)).toEqual([]);
  });

  test("grant refuses from a subdirectory of a worktree and from under a Firstmate projects dir", () => {
    const s = setup();
    mkdirSync(join(s.worktree, "src", "deep"), { recursive: true });
    const fm = dir("ak-bypass-fm-");
    for (const sub of ["data", "state", "projects/scratch"]) mkdirSync(join(fm, sub), { recursive: true });
    for (const cwd of [join(s.worktree, "src", "deep"), join(fm, "projects", "scratch")]) {
      const r = grantFrom(s, cwd, s.grantPath);
      expect(r.code).toBe(1);
      expect(r.err).toContain("is a task checkout");
    }
    expect(readdirSync(s.ledger)).toEqual([]);
  });

  test("the grant and its ledger entry record who issued it: cwd, host and supervisor home", () => {
    const s = setup();
    for (const sub of ["data", "state", "projects"]) mkdirSync(join(s.home, sub), { recursive: true });
    expect(grantFrom(s, s.home, s.grantPath).code).toBe(0);
    const issued = { cwd: realpathSync(s.home), host: hostname(), supervisor_home: realpathSync(s.home) };
    expect(JSON.parse(readFileSync(s.grantPath, "utf8"))).toMatchObject({ issued });
    expect(JSON.parse(readFileSync(join(s.ledger, `${grantId(s.ledger)}.json`), "utf8"))).toMatchObject({ issued });
  });

  test("grant refuses to write inside the worktree or the git directory", () => {
    const s = setup();
    for (const out of [
      join(s.worktree, "bypass.json"),
      join(git(s.project, "rev-parse", "--absolute-git-dir"), "bypass.json"),
    ]) {
      const r = ak(
        s.home,
        s.ledger,
        "bypass",
        "grant",
        "--task",
        "T-1",
        "--by",
        "captain",
        "--reason",
        "r",
        "--out",
        out,
        "--project",
        s.project,
        "--worktree",
        s.worktree,
      );
      expect(r.code).toBe(1);
      expect(r.err).toContain("which a worker in that repository can write");
    }
  });

  test("a grant file in the worktree is refused even with a matching ledger entry", () => {
    const { worktree, ledger, grantPath } = granted();
    const id = grantId(ledger);
    const inside = join(worktree, "bypass.json");
    const text = readFileSync(grantPath, "utf8");
    writeFileSync(inside, text);
    const sha = `sha256:${createHash("sha256").update(text).digest("hex")}`;
    writeFileSync(
      join(ledger, `${id}.json`),
      JSON.stringify({ grant_id: id, grant_path: realpathSync(inside), grant_sha256: sha }),
    );
    const r = ak(worktree, ledger, "bypass", "check", "--grant", inside, "--task", "T-1", "--phase", "super-align");
    expect(r.code).toBe(1);
    expect(r.err).toContain("which the worker can write");
  });
});

test(`the bundled ${GATE_FILE} carries bypass and refuses an absent grant under node`, () => {
  const s = setup();
  const { catalog } = loadCatalog(REPO);
  if (catalog === null) throw new Error("no catalog");
  const script = join(dir("ak-bypass-bundle-"), "ak-gate.mjs");
  const bundled = planBundle({ root: REPO, catalog }, "claude-code", {}).files.get(GATE_FILE);
  if (bundled === undefined) throw new Error(`no ${GATE_FILE} in the bundle`);
  writeFileSync(script, bundled.contents);
  const node = (...argv: string[]) => Bun.spawnSync(["node", script, ...argv], { cwd: s.worktree });
  // The bundle resolves the account's real ledger, so nothing here runs `grant`: a regression in its
  // guards would write there. The grant itself is exercised above against a temp ledger.
  expect(node().stderr.toString()).toContain("ak lifecycle bypass grant");
  const missing = node("bypass", "check", "--grant", s.grantPath, "--task", "T-1", "--phase", "super-align");
  expect(missing.exitCode).toBe(1);
  expect(missing.stderr.toString()).toContain("does not exist");
});

test(`the supervisor's documented grant command, node ${GATE_FILE} from its home, reaches grant and loads no cwd config`, () => {
  const s = setup();
  const { catalog } = loadCatalog(REPO);
  if (catalog === null) throw new Error("no catalog");
  const script = join(dir("ak-bypass-bundle-"), "ak-gate.mjs");
  const bundled = planBundle({ root: REPO, catalog }, "claude-code", {}).files.get(GATE_FILE);
  if (bundled === undefined) throw new Error(`no ${GATE_FILE} in the bundle`);
  writeFileSync(script, bundled.contents);
  // A home holding what bun would load first: a preload that leaves a marker, and an .env that breaks git.
  const marker = join(s.home, "preload-ran");
  writeFileSync(join(s.home, "preload.ts"), `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran");\n`);
  writeFileSync(join(s.home, "bunfig.toml"), 'preload = ["./preload.ts"]\n');
  writeFileSync(join(s.home, ".env"), "GIT_DIR=/nonexistent-from-dotenv\n");
  // The real ledger is the account's, so the call stops at a guard before writing: a worktree that is
  // not one of the repository's. Reaching that guard shows the command routes to grant and git worked.
  const notWorktree = dir("ak-bypass-notwt-");
  const r = Bun.spawnSync(
    [
      "node",
      script,
      "bypass",
      "grant",
      "--task",
      "T-1",
      "--by",
      "captain",
      "--reason",
      "r",
      "--out",
      s.grantPath,
      "--project",
      s.project,
      "--worktree",
      notWorktree,
    ],
    { cwd: s.home },
  );
  expect(r.exitCode).toBe(1);
  expect(r.stderr.toString()).toContain("is not one of the worktrees");
  expect(r.stderr.toString()).not.toContain("nonexistent-from-dotenv");
  expect(existsSync(marker)).toBe(false);
  expect(existsSync(s.grantPath)).toBe(false);
});
