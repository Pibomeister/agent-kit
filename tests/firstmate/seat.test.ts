import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { runFirstmate } from "../../src/firstmate/cli.ts";
import { judgeSeat, launchSeat } from "../../src/firstmate/seat.ts";
import { makeDir } from "./fixture.ts";

function setup() {
  const home = makeDir();
  const bin = join(home, "bin");
  mkdirSync(bin);
  const scripts = {
    "fm-tasks-axi.sh": '#!/bin/sh\nprintf "task %s\\n" "$*" >> "$PWD/calls.log"\n',
    "fm-brief.sh":
      '#!/bin/sh\nmkdir -p "$PWD/data/$1"\nprintf "# Task\\n{TASK}\\n## Firstmate spec\\n{FIRSTMATE_SPEC}\\n" > "$PWD/data/$1/brief.md"\nprintf "brief %s\\n" "$*" >> "$PWD/calls.log"\n',
    "fm-spawn.sh":
      '#!/bin/sh\nprintf "spawn %s\\n" "$*" >> "$PWD/calls.log"\nmkdir -p "$PWD/state"\nprintf "endpoint_task_id=%s\\nkind=scout\\nworktree=/scratch/%s\\n" "$1" "$1" > "$PWD/state/$1.meta"\necho "spawned $1"\n',
  };
  for (const [name, body] of Object.entries(scripts)) {
    const path = join(bin, name);
    writeFileSync(path, body);
    chmodSync(path, 0o700);
  }
  const intake = join(home, "data", "runner-intake");
  const evidence = join(intake, "evidence");
  mkdirSync(evidence, { recursive: true });
  const bytes = Buffer.from("trusted evidence for this card\n");
  writeFileSync(join(evidence, "e1.txt"), bytes);
  const packet = join(intake, "packet.json");
  writeFileSync(
    packet,
    JSON.stringify({
      run: "toy-run",
      charter_hash: `sha256:${"a".repeat(64)}`,
      revision: "1".repeat(40),
      diff_hash: `sha256:${"b".repeat(64)}`,
      card: {
        id: "align-1",
        operation: "align.run",
        question: "Approve the direction?",
        options: ["approve", "hold"],
        approve: "approve",
        artifact_hash: `sha256:${"c".repeat(64)}`,
        evidence: [{ id: "e1", hash: `sha256:${createHash("sha256").update(bytes).digest("hex")}` }],
      },
    }),
  );
  const captain = join(intake, "captain.txt");
  writeFileSync(captain, "Run the toy charter on stock Firstmate.");
  return { home, intake, evidence, packet, captain };
}

function judgmentFixture() {
  const f = setup();
  const taskId = "seat-a-align-1";
  const task = join(f.home, "data", taskId);
  mkdirSync(task);
  mkdirSync(join(f.home, "state"));
  writeFileSync(
    join(f.home, "state", `${taskId}.meta`),
    `endpoint_task_id=${taskId}\nkind=scout\nworktree=/scratch/${taskId}\n`,
  );
  writeFileSync(
    join(task, "report.md"),
    '# Seat report\nEvidence checked.\n{"choice":"approve","rationale":"The cited receipt supports approval."}\n',
  );
  const underHome = join(f.intake, "admin.token");
  writeFileSync(underHome, `${"a".repeat(48)}\n`, { mode: 0o600 });
  const token = join(makeDir(), "admin.token");
  writeFileSync(token, `${"a".repeat(48)}\n`, { mode: 0o600 });
  const akRoot = join(f.home, "fake-ak");
  mkdirSync(join(akRoot, "src"), { recursive: true });
  const submitted = join(f.home, "submitted.json");
  writeFileSync(
    join(akRoot, "src", "cli.ts"),
    `if (process.env.AK_RUNNER_TOKEN !== ${JSON.stringify("a".repeat(48))}) process.exit(2); const at=process.argv.indexOf('--json'); await Bun.write(${JSON.stringify(submitted)}, await Bun.file(process.argv[at + 1]).text()); console.log('accepted');`,
  );
  const judge = (adminTokenFile: string) =>
    judgeSeat({
      fmHome: f.home,
      taskId,
      packetPath: f.packet,
      seat: "seat-a",
      actor: "supervisor-seat-a",
      runnerSocket: join(f.intake, "runner.sock"),
      adminTokenFile,
      akRoot,
    });
  return { f, task, underHome, token, submitted, judge };
}

// The accepted judgment launches a nested Bun CLI and took 6.82s beside another full suite.
// Execute it once at module load so the timed test body retains only its result assertions.
const acceptedJudgment = (() => {
  const fixture = judgmentFixture();
  writeFileSync(join(fixture.task, "ak-judge-align-1.json"), '{"choice":"invented"}');
  const result = fixture.judge(fixture.token);
  const request: unknown = JSON.parse(readFileSync(fixture.submitted, "utf8"));
  const mode = statSync(join(dirname(fixture.token), "ak-judge-toy-run-align-1-seat-a.json")).mode & 0o777;
  return { result, request, mode };
})();

describe("stock Firstmate seat launcher", () => {
  test("scaffolds and spawns separate scout crewmates from the same frozen packet", () => {
    const f = setup();
    const out: string[] = [];
    const launch = (taskId: string) =>
      runFirstmate(
        [
          "seat-launch",
          "--fm-home",
          f.home,
          "--task-id",
          taskId,
          "--project-name",
          "toy",
          "--project-dir",
          "projects/toy",
          "--packet",
          f.packet,
          "--evidence-dir",
          f.evidence,
          "--captain-intent-file",
          f.captain,
          "--implementer-worktree",
          "/scratch/implementer",
          "--harness",
          "codex",
        ],
        {
          out: (line) => out.push(line),
          err: (line) => {
            throw new Error(line);
          },
        },
      );
    expect(launch("seat-a-align-1")).toBe(0);
    expect(launch("seat-b-align-1")).toBe(0);
    const a = readFileSync(join(f.home, "data", "seat-a-align-1", "brief.md"), "utf8");
    const b = readFileSync(join(f.home, "data", "seat-b-align-1", "brief.md"), "utf8");
    for (const brief of [a, b]) {
      expect(brief).toContain("Run the toy charter on stock Firstmate.");
      expect(brief).toContain("trusted evidence for this card");
      expect(brief).toContain("Approve the direction?");
      expect(brief).not.toContain("other seat's verdict");
    }
    const calls = readFileSync(join(f.home, "calls.log"), "utf8");
    expect(calls).toContain("brief seat-a-align-1 toy --scout");
    expect(calls).toContain("spawn seat-b-align-1 projects/toy --scout --harness codex");
    expect(() =>
      launchSeat({
        fmHome: f.home,
        taskId: "seat-a-align-1",
        projectName: "toy",
        projectDir: "projects/toy",
        packetPath: f.packet,
        evidenceDir: f.evidence,
        captainIntentFile: f.captain,
        implementerWorktree: "/scratch/implementer",
      }),
    ).toThrow("already exists");
  });

  test("refuses evidence whose private bytes do not match the runner packet", () => {
    const f = setup();
    writeFileSync(join(f.evidence, "e1.txt"), "changed");
    expect(() =>
      launchSeat({
        fmHome: f.home,
        taskId: "seat-a-align-1",
        projectName: "toy",
        projectDir: "projects/toy",
        packetPath: f.packet,
        evidenceDir: f.evidence,
        captainIntentFile: f.captain,
        implementerWorktree: "/scratch/implementer",
      }),
    ).toThrow("does not match");
  });

  test("refuses a seat whose spawned worktree is the implementer's", () => {
    const f = setup();
    // The fake fm-spawn.sh records worktree=/scratch/<task id>, so this implementer worktree collides.
    expect(() =>
      launchSeat({
        fmHome: f.home,
        taskId: "seat-c-align-1",
        projectName: "toy",
        projectDir: "projects/toy",
        packetPath: f.packet,
        evidenceDir: f.evidence,
        captainIntentFile: f.captain,
        implementerWorktree: "/scratch/seat-c-align-1",
      }),
    ).toThrow("seat reused the implementer worktree");
  });

  test("refuses a judgment that differs from the one this seat already submitted", () => {
    const fixture = judgmentFixture();
    const request = join(dirname(fixture.token), "ak-judge-toy-run-align-1-seat-a.json");
    const first = {
      run: "toy-run",
      card_id: "align-1",
      seat: "seat-a",
      actor: "supervisor-seat-a",
      dispatch: "fm-seat-a-align-1",
      choice: "hold",
      rationale: "The first submission held.",
      input_dispatches: [],
      lineage: ["supervisor-seat-a"],
    };
    writeFileSync(request, JSON.stringify(first), { mode: 0o600 });
    expect(() => fixture.judge(fixture.token)).toThrow("seat judgment changed after its first submission");
    expect(existsSync(fixture.submitted)).toBe(false);
    expect(JSON.parse(readFileSync(request, "utf8"))).toEqual(first);
  });

  test("submits the report's final bounded judgment with the supervisor token", () => {
    const rejected = judgmentFixture();
    expect(() => rejected.judge(rejected.underHome)).toThrow("outside the Firstmate home");
    expect(existsSync(rejected.submitted)).toBe(false);
    chmodSync(rejected.token, 0o644);
    expect(() => rejected.judge(rejected.token)).toThrow("mode 0600");
    expect(acceptedJudgment.result.result).toContain("accepted");
    expect(acceptedJudgment.request).toMatchObject({
      run: "toy-run",
      card_id: "align-1",
      seat: "seat-a",
      dispatch: "fm-seat-a-align-1",
      choice: "approve",
      input_dispatches: [],
    });
    expect(acceptedJudgment.mode).toBe(0o600);
    chmodSync(rejected.token, 0o600);
    writeFileSync(join(rejected.task, "report.md"), '{"choice":"invented","rationale":"not an option"}\n');
    expect(() => rejected.judge(rejected.token)).toThrow("declared option");
  });
});
