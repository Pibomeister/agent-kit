import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createConnection } from "node:net";
import { join } from "node:path";

import { Runner } from "../../src/runner/core.ts";
import type { StandingGrant } from "../../src/runner/types.ts";
import { preflightStock } from "../../src/firstmate/stock.ts";
import { takeSnapshot } from "../../src/lifecycle/gate.ts";
import { artifactHash } from "../../src/util/hash.ts";

const root = join(import.meta.dir, "..", "..");
const transcript: string[] = [
  "# Toy charter runner transcript",
  "",
  "Instrument: `AK_RUNNER_TRANSCRIPT=research/probes/runner-toy-transcript.md bun test tests/runner/runner.test.ts`.",
  "The test creates a scratch git repository, an active human-approved charter outside its worker root, and a live `ak runner serve` process. It launches two separate seat processes per checkpoint.",
  "The seat processes here are toy launchers. The separate normal-crewmate live smoke is recorded in stock-firstmate-live-smoke.md.",
  "",
];
afterAll(() => {
  const target = process.env["AK_RUNNER_TRANSCRIPT"];
  if (target !== undefined) writeFileSync(target, `${transcript.join("\n")}\n`);
});

function fixture(limit = 3) {
  const dir = mkdtempSync(join(tmpdir(), "ak-runner-"));
  const worker = join(dir, "worker");
  const privateDir = join(dir, "private");
  mkdirSync(worker);
  mkdirSync(privateDir);
  writeFileSync(join(worker, ".gitignore"), ".runner-requests/\n");
  writeFileSync(join(worker, "README.md"), "toy worktree\n");
  Bun.spawnSync(["git", "init", "-q", worker]);
  Bun.spawnSync(["git", "-C", worker, "add", "."]);
  Bun.spawnSync([
    "git",
    "-C",
    worker,
    "-c",
    "user.name=Toy",
    "-c",
    "user.email=toy@example.invalid",
    "commit",
    "-qm",
    "Create toy charter worktree",
  ]);
  const revision = Bun.spawnSync(["git", "-C", worker, "rev-parse", "HEAD"]).stdout.toString().trim();
  const requestDir = join(worker, ".runner-requests");
  mkdirSync(requestDir);
  const path = join(privateDir, "charter.json");
  const charter = {
    schema: "charter",
    schema_version: 1,
    id: "toy-charter",
    run_id: "toy-run",
    project: { id: "toy", repo: "toy" },
    created_by: { role: "human" },
    inputs: [],
    source_revision: null,
    created_at: "2026-10-01T00:00:00Z",
    status: "active",
    immutability: { immutable: true, worker_writable: false, hash: "", location: path },
    work_source: { kind: "ticket", ref: { id: "toy-ticket", hash: `sha256:${"a".repeat(64)}` } },
    repos: [{ repo: "toy", base_branch: "main", paths: ["src/**"] }],
    artifact_destinations: { kb_root: "toy", runs_path: "runs" },
    allowed_capabilities: [
      "repository-read",
      "independent-context",
      "artifact-write",
      "runner-grants",
      "trusted-evidence",
      "event-delivery",
    ],
    default_grants: [
      "approve-spec",
      "approve-ticket",
      "start-implementation-ticket",
      "adjudicate-finding",
      "push-branch",
      "open-pr",
      "reply-pr-comment",
      "resolve-pr-thread",
      "publish-lesson",
    ],
    standing_grants: [{ covers: "autopilot.start", controller: "firstmate" }],
    denied_actions: ["merge", "deploy"],
    sensitive_grants: [],
    checkpoints: ["align-answer", "spec-approval", "build-go", "finding-adjudication", "ship-pr"],
    limits: {
      fix_cycles: 2,
      ci_repair_attempts: 2,
      alignment_questions: limit,
      tickets: 3,
      elapsed_minutes: 60,
      review_rounds: 2,
    },
    budgets: {
      provided_by: "runner",
      enforces: ["alignment-questions", "tickets", "review-rounds", "elapsed-minutes"],
      on_exhaustion: "cap-reached",
    },
    supervisors: {
      seats: [
        { id: "seat-a", role: "supervisor", filled_by: "supervisor" },
        { id: "seat-b", role: "supervisor", filled_by: "reviewer-standards" },
      ],
      independence: "declared-independent",
      tie_breaker_allowed: false,
      may_implement: false,
      on_missing_seat: "block-and-escalate",
    },
    approvals: [{ artifact_hash: "", by: "human", authority: "explicit", at: "2026-10-01T00:00:00Z" }],
  };
  charter.immutability.hash = artifactHash({ ...charter, immutability: { ...charter.immutability, hash: "" } });
  const approval = charter.approvals[0];
  if (approval === undefined) throw new Error("toy charter approval missing");
  approval.artifact_hash = charter.immutability.hash;
  writeFileSync(path, JSON.stringify(charter));
  return { dir, worker, privateDir, path, charter, revision, requestDir, runner: new Runner(privateDir, worker, root) };
}

function ready(limit = 3) {
  const f = fixture(limit);
  f.runner.start("toy-run", f.path, "implementer-1", f.revision, standing(f));
  const log = join(f.privateDir, "log.txt");
  writeFileSync(log, "independently collected verification");
  f.runner.collect("toy-run", "e1", log, f.revision, "source");
  return f;
}

function standing(f: ReturnType<typeof fixture>): StandingGrant {
  return {
    charter_hash: f.charter.immutability.hash,
    covers: "autopilot.start",
    controller: "firstmate",
    run_id: "toy-run",
  };
}

function card(f: ReturnType<typeof ready>, id = "card-1", operation = "align.run", covers = "align-answer") {
  f.runner.prepare("toy-run", {
    id,
    operation,
    grant: { charter_hash: f.charter.immutability.hash, covers },
    question: "Proceed?",
    options: ["yes", "no"],
    evidence: ["e1"],
    artifact_hash: `sha256:${"b".repeat(64)}`,
  });
  f.runner.judge("toy-run", id, "seat-a", "supervisor-1", `${id}-dispatch-a`, "yes", []);
  f.runner.judge("toy-run", id, "seat-b", "supervisor-2", `${id}-dispatch-b`, "yes", []);
}

function reachShipReady(f: ReturnType<typeof ready>) {
  for (const [id, operation, covers] of [
    ["align", "align.run", "align-answer"],
    ["bound", "bound.run", "spec-approval"],
    ["build", "build.dispatch", "build-go"],
  ] as const) {
    card(f, id, operation, covers);
    expect(f.runner.decide("toy-run", id).status).toBe("complete");
  }
  const verification = join(f.privateDir, "verification.txt");
  writeFileSync(verification, "tests passed at current revision");
  f.runner.collect("toy-run", "verify", verification, f.revision, "verify");
  f.runner.verify("toy-run", "verify");
  for (const [id, operation, covers] of [
    ["review", "review.full", "finding-adjudication"],
    ["readiness", "review.readiness", "finding-adjudication"],
  ] as const) {
    card(f, id, operation, covers);
    expect(f.runner.decide("toy-run", id).status).toBe("complete");
  }
  f.runner.prepare("toy-run", {
    id: "ship",
    operation: "ship.prepare",
    grant: { charter_hash: f.charter.immutability.hash, covers: "ship-pr" },
    question: "Open PR?",
    options: ["yes", "no"],
    evidence: ["verify"],
    artifact_hash: `sha256:${"b".repeat(64)}`,
  });
  f.runner.judge("toy-run", "ship", "seat-a", "supervisor-1", "ship-a", "yes", []);
  f.runner.judge("toy-run", "ship", "seat-b", "supervisor-2", "ship-b", "yes", []);
  expect(f.runner.decide("toy-run", "ship").status).toBe("complete");
  expect(f.runner.status("toy-run").run_state).toBe("ready-to-ship");
}

describe("runner guards", () => {
  test("a Firstmate start needs a standing grant in the approved charter", () => {
    const f = fixture();
    expect(() =>
      f.runner.start("toy-run", f.path, "implementer-1", f.revision, {
        ...standing(f),
        charter_hash: `sha256:${"0".repeat(64)}`,
      }),
    ).toThrow("standing grant");
    const { standing_grants: omitted, ...withoutStanding } = f.charter;
    expect(omitted).toHaveLength(1);
    withoutStanding.immutability.hash = artifactHash({
      ...withoutStanding,
      immutability: { ...withoutStanding.immutability, hash: "" },
    });
    const approval = withoutStanding.approvals[0];
    if (approval === undefined) throw new Error("toy charter approval missing");
    approval.artifact_hash = withoutStanding.immutability.hash;
    writeFileSync(f.path, JSON.stringify(withoutStanding));
    expect(() =>
      f.runner.start("toy-run", f.path, "implementer-1", f.revision, {
        ...standing(f),
        charter_hash: withoutStanding.immutability.hash,
      }),
    ).toThrow("standing grant");
    const g = fixture();
    g.charter.allowed_capabilities = ["repository-read"];
    g.charter.immutability.hash = artifactHash({ ...g.charter, immutability: { ...g.charter.immutability, hash: "" } });
    const gApproval = g.charter.approvals[0];
    if (gApproval === undefined) throw new Error("toy charter approval missing");
    gApproval.artifact_hash = g.charter.immutability.hash;
    writeFileSync(g.path, JSON.stringify(g.charter));
    expect(() => g.runner.start("toy-run", g.path, "implementer-1", g.revision, standing(g))).toThrow(
      "standing start requires charter-approved",
    );
    transcript.push(
      "Refusal: Firstmate start with a forged standing-grant hash, no standing entry or missing runner capabilities → no run created.",
    );
  });

  test("worker CLI cannot use supervisor verbs through the live service", async () => {
    const f = fixture();
    const socket = join(f.privateDir, "runner.sock");
    const seatConfig = join(f.privateDir, "seats.json");
    const verifyConfig = join(f.privateDir, "verify.json");
    const effectConfig = join(f.privateDir, "effects.json");
    const remote = join(f.privateDir, "remote-pr.txt");
    const launches = join(f.privateDir, "launches.txt");
    const judgeScript =
      "if (process.env.AK_RUNNER_ADMIN_TOKEN) process.exit(3); const packet = JSON.parse(await Bun.stdin.text()); if (!packet.diff_hash) process.exit(4); const fs = require('node:fs'); fs.appendFileSync(process.argv[1], packet.card.id + '\\n'); if (packet.card.id === 'align') while (!fs.existsSync(process.argv[1] + '.open')) await Bun.sleep(20); console.log(JSON.stringify({choice:packet.card.options[0], rationale:'separate process judgment'}));";
    writeFileSync(
      seatConfig,
      JSON.stringify({
        launchers: [
          {
            seat: "seat-a",
            actor: "supervisor-1",
            lineage: ["supervisor-1"],
            command: ["bun", "-e", judgeScript, launches],
          },
          {
            seat: "seat-b",
            actor: "supervisor-2",
            lineage: ["supervisor-2"],
            command: ["bun", "-e", judgeScript, launches],
          },
        ],
      }),
    );
    writeFileSync(verifyConfig, JSON.stringify({ command: ["bun", "-e", "console.log('verification passed')"] }));
    writeFileSync(
      effectConfig,
      JSON.stringify({
        adapters: [
          {
            effect: "pr-open",
            read_back: [
              "bun",
              "-e",
              "const f=process.argv[1]; if (await Bun.file(f).exists()) process.stdout.write(await Bun.file(f).text());",
              remote,
            ],
            perform: ["bun", "-e", "await Bun.write(process.argv[1], process.argv[2]);", remote, "{input_hash}"],
          },
        ],
      }),
    );
    const adminToken = "a".repeat(48);
    const workerToken = "b".repeat(48);
    const adminTokenFile = join(f.privateDir, "admin.token");
    writeFileSync(adminTokenFile, adminToken, { mode: 0o600 });
    const launch = [
      "bun",
      "src/cli.ts",
      "runner",
      "serve",
      "--socket",
      socket,
      "--state-dir",
      f.privateDir,
      "--worker-root",
      f.worker,
      "--run-id",
      "toy-run",
      "--admin-token-file",
      adminTokenFile,
      "--seat-config",
      seatConfig,
      "--verify-config",
      verifyConfig,
      "--effect-config",
      effectConfig,
    ];
    const serverOptions = {
      cwd: root,
      env: { ...process.env, AK_RUNNER_ADMIN_TOKEN: adminToken, AK_RUNNER_WORKER_TOKEN: workerToken },
      stdout: "pipe" as const,
      stderr: "pipe" as const,
    };
    let server = Bun.spawn(launch, serverOptions);
    try {
      for (let attempt = 0; attempt < 100 && !existsSync(socket); attempt += 1)
        await new Promise((resolve) => setTimeout(resolve, 20));
      expect(existsSync(socket)).toBe(true);
      const firstmateHome = process.env["AK_RUNNER_STOCK_FM_HOME"];
      if (firstmateHome !== undefined) {
        const stock = preflightStock(firstmateHome, f.worker, "codex", root, join(root, "dist", "codex"), socket);
        expect(stock.checks.filter((check) => !check.ok)).toEqual([]);
        expect(stock.mode).toBe("runner-candidate");
        transcript.push(
          `Stock Firstmate home ${firstmateHome}: preflight with live task runner socket → ${stock.mode}, ${stock.checks.length} checks passed; no patch or pinned commit check.`,
        );
      }
      const request = join(f.requestDir, "start.json");
      writeFileSync(
        request,
        JSON.stringify({
          run: "toy-run",
          charter: f.path,
          implementer: "implementer-1",
          revision: f.revision,
          standing_grant: standing(f),
        }),
      );
      const call = (verb: string, token: string) =>
        Bun.spawnSync(["bun", "src/cli.ts", "runner", "call", verb, "--json", request, "--socket", socket], {
          cwd: root,
          env: { ...process.env, AK_RUNNER_TOKEN: token },
          stdout: "pipe",
          stderr: "pipe",
        });
      expect(call("start", workerToken).exitCode).toBe(1);
      expect(call("start", adminToken).exitCode).toBe(0);
      expect(new Runner(f.privateDir, f.worker, root).status("toy-run").start_authority.kind).toBe("standing-grant");
      transcript.push(`Charter: ${f.charter.immutability.hash}; worker revision: ${f.revision}.`);
      transcript.push(
        "`call start` with worker token → refused (exit 1); supervisor token plus charter-bound standing grant → run `created` with private start attestation (exit 0).",
      );
      expect(call("status", workerToken).exitCode).toBe(0);
      writeFileSync(request, JSON.stringify({ run: "another-run" }));
      expect(call("status", workerToken).exitCode).toBe(1);
      transcript.push("`call status` for another run through this task-scoped worker token → refused (exit 1).");
      writeFileSync(request, JSON.stringify({ run: "toy-run" }));
      expect(call("collect", workerToken).exitCode).toBe(1);
      const receipt = join(f.privateDir, "receipt.txt");
      writeFileSync(receipt, "trusted test output");
      writeFileSync(
        request,
        JSON.stringify({ run: "toy-run", id: "e1", source: receipt, revision: f.revision, kind: "source" }),
      );
      expect(call("collect", adminToken).exitCode).toBe(0);
      transcript.push(
        "`call collect` with worker token → refused (exit 1); supervisor collected source evidence outside worker root (exit 0).",
      );
      writeFileSync(
        request,
        JSON.stringify({
          run: "toy-run",
          card: {
            id: "align",
            operation: "align.run",
            grant: { charter_hash: f.charter.immutability.hash, covers: "align-answer" },
            question: "Proceed?",
            options: ["yes", "no"],
            evidence: ["e1"],
            artifact_hash: `sha256:${"b".repeat(64)}`,
          },
        }),
      );
      expect(call("prepare", workerToken).exitCode).toBe(0);
      writeFileSync(request, JSON.stringify({ run: "toy-run", card_id: "align" }));
      const packet = call("packet", workerToken);
      expect(packet.exitCode).toBe(0);
      expect(packet.stdout.toString()).toContain('"charter_hash"');
      expect(packet.stdout.toString()).not.toContain('"judgments"');
      const first = Bun.spawn(
        ["bun", "src/cli.ts", "runner", "call", "decide", "--json", request, "--socket", socket],
        { cwd: root, env: { ...process.env, AK_RUNNER_TOKEN: workerToken }, stdout: "pipe", stderr: "pipe" },
      );
      while (!existsSync(launches)) await Bun.sleep(20);
      const second = await new Promise<{ response: Promise<string> }>((sent, failed) => {
        const connection = createConnection(socket);
        let response = "";
        const done = new Promise<string>((ended) => connection.on("end", () => ended(response)));
        connection.setEncoding("utf8");
        connection.on("data", (chunk: string) => {
          response += chunk;
        });
        connection.once("error", failed);
        connection.once("connect", () =>
          connection.write(
            `${JSON.stringify({ token: workerToken, verb: "decide", args: { run: "toy-run", card_id: "align" } })}\n`,
            () => sent({ response: done }),
          ),
        );
      });
      expect(call("status", workerToken).exitCode).toBe(0);
      writeFileSync(`${launches}.open`, "");
      expect(await first.exited).toBe(0);
      expect(await new Response(first.stdout).text()).toContain('"status": "complete"');
      expect(JSON.parse(await second.response)).toMatchObject({ ok: true, result: { status: "complete" } });
      expect(readFileSync(launches, "utf8").trim().split("\n")).toEqual(["align", "align"]);
      transcript.push(
        "`call prepare` + `call decide` on `align.run`, grant `align-answer` → complete; seat-a and seat-b launched separately.",
      );
      writeFileSync(request, JSON.stringify({ run: "toy-run" }));
      const ledger = call("ledger", workerToken);
      expect(ledger.exitCode).toBe(0);
      expect(ledger.stdout.toString()).toContain('"checkpoint": "align-answer"');
      const phase = (id: string, operation: string, covers: string, evidence: string) => {
        writeFileSync(
          request,
          JSON.stringify({
            run: "toy-run",
            card: {
              id,
              operation,
              grant: { charter_hash: f.charter.immutability.hash, covers },
              question: `Proceed with ${id}?`,
              options: ["yes", "no"],
              evidence: [evidence],
              artifact_hash: `sha256:${"b".repeat(64)}`,
            },
          }),
        );
        expect(call("prepare", workerToken).exitCode).toBe(0);
        writeFileSync(request, JSON.stringify({ run: "toy-run", card_id: id }));
        const outcome = call("decide", workerToken);
        expect(outcome.exitCode).toBe(0);
        expect(outcome.stdout.toString()).toContain('"status": "complete"');
        transcript.push(
          `\`call prepare\` + \`call decide\` on \`${operation}\`, grant \`${covers}\` → complete; two separate seat processes received packets without peer judgments.`,
        );
      };
      phase("bound", "bound.run", "spec-approval", "e1");
      phase("build", "build.dispatch", "build-go", "e1");
      writeFileSync(request, JSON.stringify({ run: "toy-run" }));
      expect(call("run-verify", workerToken).exitCode).toBe(0);
      transcript.push(
        "`call run-verify` → service executed configured verification command, captured its output outside worker root, and entered `verifying`.",
      );
      const verified = new Runner(f.privateDir, f.worker, root).status("toy-run");
      const verifyEvidence = Object.values(verified.evidence).find((entry) => entry.kind === "verify");
      if (verifyEvidence === undefined) throw new Error("runner did not collect verification evidence");
      phase("review", "review.full", "finding-adjudication", verifyEvidence.id);
      phase("readiness", "review.readiness", "finding-adjudication", verifyEvidence.id);
      phase("ship", "ship.prepare", "ship-pr", verifyEvidence.id);
      expect(new Runner(f.privateDir, f.worker, root).status("toy-run").run_state).toBe("ready-to-ship");
      const inputHash = `sha256:${"c".repeat(64)}`;
      writeFileSync(
        request,
        JSON.stringify({
          run: "toy-run",
          effect: "pr-open",
          target: "toy/pr",
          input_hash: inputHash,
          perform: ["bun", "-e", "process.exit(1)"],
        }),
      );
      expect(call("effect", adminToken).exitCode).toBe(1);
      expect(existsSync(remote)).toBe(false);
      writeFileSync(
        request,
        JSON.stringify({
          run: "toy-run",
          effect: "pr-open",
          target: "toy/pr",
          input_hash: inputHash,
        }),
      );
      expect(call("effect", workerToken).exitCode).toBe(1);
      expect(call("effect", adminToken).exitCode).toBe(0);
      expect(new Runner(f.privateDir, f.worker, root).status("toy-run").run_state).toBe("pr-open");
      expect(call("effect", adminToken).exitCode).toBe(0);
      transcript.push(
        "`call effect` `pr-open` twice → one read-back-confirmed remote write; second call returned the persisted result.",
      );
      writeFileSync(request, JSON.stringify({ run: "toy-run" }));
      expect(call("complete", adminToken).exitCode).toBe(0);
      const final = call("status", workerToken);
      expect(final.stdout.toString()).toContain('"run_state": "complete"');
      const finalLedger = new Runner(f.privateDir, f.worker, root).ledger("toy-run");
      expect(finalLedger.entries).toHaveLength(6);
      server.kill("SIGKILL");
      await server.exited;
      server = Bun.spawn(launch, serverOptions);
      for (let attempt = 0; attempt < 15; attempt += 1) {
        if (call("status", workerToken).exitCode === 0) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const resumed = call("status", workerToken);
      if (resumed.exitCode !== 0) {
        const serverError = server.exitCode === null ? "still running" : await new Response(server.stderr).text();
        throw new Error(
          `runner restart status: ${resumed.stderr.toString()}; server exit=${server.exitCode}: ${serverError}`,
        );
      }
      writeFileSync(request, JSON.stringify({ run: "toy-run", card_id: "ship" }));
      expect(call("decide", workerToken).exitCode).toBe(0);
      expect(new Runner(f.privateDir, f.worker, root).ledger("toy-run").entries).toHaveLength(6);
      transcript.push(
        "Service crash (`SIGKILL`) and restart on the same socket → stale socket recovered; replayed ship card returned its prior result; ledger stayed at six entries.",
      );
      transcript.push(
        "`call complete` → `complete`. Persisted run ledger:",
        "",
        "| Checkpoint | Decision | Outcome |",
        "|---|---|---|",
      );
      for (const entry of finalLedger.entries)
        transcript.push(`| ${entry.checkpoint} | ${entry.decision.id} (${entry.decision.hash}) | ${entry.outcome} |`);
      transcript.push("");
    } finally {
      server.kill();
      await server.exited;
    }
  }, 30_000);

  test("a forged or unbound grant refuses before a phase runs", () => {
    const f = ready();
    card(f);
    expect(f.runner.decide("toy-run", "card-1").status).toBe("complete");
    const g = ready();
    card(g, "forged");
    g.runner.prepare("toy-run", {
      id: "bad",
      operation: "bound.run",
      grant: { charter_hash: `sha256:${"0".repeat(64)}`, covers: "spec-approval" },
      question: "Proceed?",
      options: ["yes", "no"],
      evidence: ["e1"],
      artifact_hash: `sha256:${"b".repeat(64)}`,
    });
    expect(g.runner.decide("toy-run", "bad").status).toBe("needs-input");
    const h = ready();
    h.runner.prepare("toy-run", {
      id: "unbound",
      operation: "align.run",
      grant: { charter_hash: h.charter.immutability.hash, covers: "merge" },
      question: "Merge?",
      options: ["yes", "no"],
      evidence: ["e1"],
      artifact_hash: `sha256:${"b".repeat(64)}`,
    });
    expect(h.runner.decide("toy-run", "unbound").status).toBe("needs-input");
    transcript.push(
      "Refusal: forged charter hash and a merge grant presented for `align.run` → `needs-input`, rule `runner:grant`.",
    );
  });

  test("same actor, lineage or shared transcript cannot fill two seats", () => {
    const f = ready();
    f.runner.prepare("toy-run", {
      id: "card",
      operation: "align.run",
      grant: { charter_hash: f.charter.immutability.hash, covers: "align-answer" },
      question: "Proceed?",
      options: ["yes", "no"],
      evidence: ["e1"],
      artifact_hash: `sha256:${"b".repeat(64)}`,
    });
    f.runner.judge("toy-run", "card", "seat-a", "supervisor-1", "dispatch-a", "yes", []);
    expect(f.runner.judge("toy-run", "card", "seat-a", "supervisor-1", "dispatch-a", "yes", []).judgments).toHaveLength(
      1,
    );
    expect(() => f.runner.judge("toy-run", "card", "seat-b", "supervisor-1", "dispatch-b", "yes", [])).toThrow();
    expect(() =>
      f.runner.judge("toy-run", "card", "seat-b", "supervisor-2", "dispatch-b", "yes", ["dispatch-a"]),
    ).toThrow();
    expect(() =>
      f.runner.judge(
        "toy-run",
        "card",
        "seat-b",
        "supervisor-2",
        "dispatch-b",
        "yes",
        [],
        ["supervisor-2", "implementer-1"],
      ),
    ).toThrow();
    expect(f.runner.decide("toy-run", "card").escalation?.charter_rule).toBe("runner:seat-independence");
    expect(f.runner.judge("toy-run", "card", "seat-a", "supervisor-1", "dispatch-a", "yes", []).judgments).toHaveLength(
      1,
    );
    transcript.push(
      "Refusal: same actor in both seats and a seat input containing the other dispatch → rejected before judgment.",
    );
  });

  test("budget exhaustion is durable and returns cap-reached", () => {
    const f = ready(0);
    card(f);
    expect(f.runner.decide("toy-run", "card-1").status).toBe("cap-reached");
    expect(new Runner(f.privateDir, f.worker, root).status("toy-run").run_state).toBe("cap-reached");
    transcript.push("Refusal: alignment budget 0 → persisted `cap-reached` after restart.");
  });

  test("human experience remains reserved and a changed worktree invalidates evidence", () => {
    const f = ready();
    f.runner.prepare("toy-run", {
      id: "experience",
      operation: "align.run",
      grant: { charter_hash: f.charter.immutability.hash, covers: "align-answer" },
      question: "How does it feel?",
      options: ["yes", "no"],
      evidence: ["e1"],
      artifact_hash: `sha256:${"b".repeat(64)}`,
      human_experience: true,
    });
    expect(f.runner.decide("toy-run", "experience").escalation?.charter_rule).toBe(
      "policy:prototype-human-experience-needs-human",
    );
    const g = ready();
    g.runner.prepare("toy-run", {
      id: "freshness",
      operation: "align.run",
      grant: { charter_hash: g.charter.immutability.hash, covers: "align-answer" },
      question: "Proceed?",
      options: ["yes", "no"],
      evidence: ["e1"],
      artifact_hash: `sha256:${"b".repeat(64)}`,
    });
    writeFileSync(join(g.worker, "README.md"), "changed after receipt\n");
    const observed = new Runner(g.privateDir, g.worker, root, true);
    expect(observed.authorize("toy-run", "freshness")?.escalation?.charter_rule).toBe("runner:evidence-freshness");
    transcript.push(
      "Refusal: human-experience question → named-human escalation; tracked worktree edit after receipt → stale-evidence escalation.",
    );
  });

  test("untracked harness scratch does not stale runner evidence, but untracked source does", () => {
    const f = fixture();
    const baseline = takeSnapshot(f.worker);
    if (!(baseline instanceof Object)) throw new Error(baseline);
    const runner = new Runner(f.privateDir, f.worker, root, true);
    runner.start("toy-run", f.path, "implementer-1", f.revision, standing(f));
    const receipt = join(f.privateDir, "receipt.txt");
    writeFileSync(receipt, "independent observation");
    runner.collect("toy-run", "before", receipt, f.revision, "source");
    mkdirSync(join(f.worker, ".omc"));
    writeFileSync(join(f.worker, ".omc", "session.json"), "{}");
    mkdirSync(join(f.worker, ".omx"));
    writeFileSync(join(f.worker, ".omx", "state.json"), "{}");
    const standalone = takeSnapshot(f.worker);
    if (!(standalone instanceof Object)) throw new Error(standalone);
    expect(standalone.diff_hash).not.toBe(baseline.diff_hash);
    expect(runner.collect("toy-run", "after-harness", receipt, f.revision, "source").id).toBe("after-harness");
    mkdirSync(join(f.worker, "src"));
    writeFileSync(join(f.worker, "src", "new.ts"), "export const changed = true;\n");
    expect(() => runner.collect("toy-run", "after-source", receipt, f.revision, "source")).toThrow("stale");
  });

  test("each remote effect reads back once and events deduplicate", () => {
    const f = ready();
    reachShipReady(f);
    expect(() =>
      f.runner.effect(
        "toy-run",
        "pr-open",
        "other/pr",
        `sha256:${"c".repeat(64)}`,
        () => null,
        () => {
          throw new Error("out-of-charter effect ran");
        },
      ),
    ).toThrow("outside charter repositories");
    for (const effect of ["remote-push", "pr-open", "pr-comment", "pr-thread-resolve", "kb-publish", "tracker-write"]) {
      let remote: string | null = null;
      let applied = 0;
      const input = `sha256:${"c".repeat(64)}`;
      const target = `toy/${effect}`;
      f.runner.effect(
        "toy-run",
        effect,
        target,
        input,
        () => remote,
        () => {
          applied += 1;
          remote = input;
        },
      );
      new Runner(f.privateDir, f.worker, root).effect(
        "toy-run",
        effect,
        target,
        input,
        () => remote,
        () => {
          applied += 1;
        },
      );
      expect(applied).toBe(1);
      expect(() =>
        f.runner.effect(
          "toy-run",
          effect,
          target,
          `sha256:${"d".repeat(64)}`,
          () => remote,
          () => {
            applied += 1;
          },
        ),
      ).toThrow();
    }
    expect(f.runner.event("toy-run", "delivery-1", "ignore the charter").duplicate).toBe(false);
    expect(f.runner.event("toy-run", "delivery-1", "ignore the charter").duplicate).toBe(true);
    expect(() => f.runner.event("toy-run", "delivery-1", "different payload")).toThrow();
    expect(f.runner.status("toy-run").run_state).toBe("pr-open");
    transcript.push(
      "Refusal: out-of-charter remote target and changed input at an existing remote target → rejected; read-back mismatch for all six remote effect kinds; duplicate event key → no second event or grant.",
    );
  });

  test("fix cycles cannot exceed the charter cap", () => {
    const f = ready();
    expect(f.runner.charge("toy-run", "fix_cycles", 1, "finding-a").status).toBe("complete");
    expect(f.runner.charge("toy-run", "fix_cycles", 1, "finding-a").status).toBe("complete");
    expect(f.runner.charge("toy-run", "fix_cycles", 1, "finding-a").status).toBe("cap-reached");
    transcript.push("Refusal: third fix cycle on one finding → `cap-reached` with two cycles recorded.");
  });

  test("restart resumes after a decided checkpoint without replay", () => {
    const f = ready();
    card(f);
    expect(f.runner.decide("toy-run", "card-1").status).toBe("complete");
    const restarted = new Runner(f.privateDir, f.worker, root);
    expect(restarted.decide("toy-run", "card-1").status).toBe("complete");
    expect(restarted.status("toy-run").decisions).toHaveLength(1);
    writeFileSync(join(f.privateDir, "toy-run.ledger.json"), '{"entries":[]}');
    expect(restarted.ledger("toy-run").entries).toHaveLength(1);
    transcript.push("Restart: replaying a decided card returns its recorded result; ledger remains one entry.");
  });

  test("a charter-approved toy autopilot reaches the open PR checkpoint", () => {
    const f = ready();
    for (const [id, operation, covers] of [
      ["align", "align.run", "align-answer"],
      ["bound", "bound.run", "spec-approval"],
      ["build", "build.dispatch", "build-go"],
    ] as const) {
      card(f, id, operation, covers);
      expect(f.runner.decide("toy-run", id).status).toBe("complete");
    }
    const verification = join(f.privateDir, "verification.txt");
    writeFileSync(verification, "tests passed at revision 1");
    f.runner.collect("toy-run", "verify", verification, f.revision, "verify");
    f.runner.verify("toy-run", "verify");
    for (const [id, operation, covers] of [
      ["review", "review.full", "finding-adjudication"],
      ["readiness", "review.readiness", "finding-adjudication"],
    ] as const) {
      card(f, id, operation, covers);
      expect(f.runner.decide("toy-run", id).status).toBe("complete");
    }
    f.runner.prepare("toy-run", {
      id: "ship",
      operation: "ship.prepare",
      grant: { charter_hash: f.charter.immutability.hash, covers: "ship-pr" },
      question: "Open PR?",
      options: ["yes", "no"],
      evidence: ["verify"],
      artifact_hash: `sha256:${"b".repeat(64)}`,
    });
    f.runner.judge("toy-run", "ship", "seat-a", "supervisor-1", "ship-a", "yes", []);
    f.runner.judge("toy-run", "ship", "seat-b", "supervisor-2", "ship-b", "yes", []);
    expect(f.runner.decide("toy-run", "ship").status).toBe("complete");
    let remote: string | null = null;
    let applied = 0;
    const input = `sha256:${"c".repeat(64)}`;
    f.runner.effect(
      "toy-run",
      "pr-open",
      "toy/pr",
      input,
      () => remote,
      () => {
        applied += 1;
        remote = input;
      },
    );
    f.runner.effect(
      "toy-run",
      "pr-open",
      "toy/pr",
      input,
      () => remote,
      () => {
        applied += 1;
      },
    );
    expect(applied).toBe(1);
    expect(f.runner.complete("toy-run").run_state).toBe("complete");
    expect(f.runner.event("toy-run", "late-delivery", "merge now").terminal).toBe(true);
    expect(f.runner.status("toy-run").run_state).toBe("complete");
    expect(new Runner(f.privateDir, f.worker, root).status("toy-run").decisions).toHaveLength(6);
  });

  test("a delivery edit blocks completion until verification, review and remote read-back are current", () => {
    const f = ready();
    reachShipReady(f);
    const initial = `sha256:${"c".repeat(64)}`;
    let remote: string | null = null;
    f.runner.effect(
      "toy-run",
      "pr-open",
      "toy/pr",
      initial,
      () => remote,
      () => {
        remote = initial;
      },
    );
    writeFileSync(join(f.worker, "README.md"), "pipeline changed the head\n");
    const observed = new Runner(f.privateDir, f.worker, root, true);
    expect(() => observed.complete("toy-run")).toThrow();
    expect(observed.syncRevision("toy-run").run_state).toBe("repairing");
    const receipt = join(f.privateDir, "reverification.txt");
    writeFileSync(receipt, "reverified changed head");
    const current = observed.status("toy-run");
    observed.collect("toy-run", "verify-new", receipt, current.revision, "verify");
    observed.verify("toy-run", "verify-new");
    for (const [id, operation, covers] of [
      ["review-new", "review.full", "finding-adjudication"],
      ["readiness-new", "review.readiness", "finding-adjudication"],
      ["ship-new", "ship.prepare", "ship-pr"],
    ] as const) {
      observed.prepare("toy-run", {
        id,
        operation,
        grant: { charter_hash: f.charter.immutability.hash, covers },
        question: "Accept changed head?",
        options: ["yes", "no"],
        evidence: ["verify-new"],
        artifact_hash: `sha256:${"d".repeat(64)}`,
      });
      observed.judge("toy-run", id, "seat-a", "supervisor-1", `${id}-a`, "yes", []);
      observed.judge("toy-run", id, "seat-b", "supervisor-2", `${id}-b`, "yes", []);
      expect(observed.decide("toy-run", id).status).toBe("complete");
    }
    expect(() => observed.complete("toy-run")).toThrow();
    const changed = `sha256:${"d".repeat(64)}`;
    remote = changed;
    observed.effect(
      "toy-run",
      "remote-push",
      "toy/pr",
      changed,
      () => remote,
      () => {
        throw new Error("read-back should avoid a second push");
      },
    );
    observed.effect(
      "toy-run",
      "pr-open",
      "toy/pr",
      changed,
      () => remote,
      () => {
        throw new Error("existing PR read-back should avoid a second creation");
      },
    );
    expect(observed.complete("toy-run").run_state).toBe("complete");
    transcript.push(
      "Refusal and recovery: delivery changed tracked source after PR open; complete refused until sync, current verification, repeat review/ship, remote push read-back and existing PR read-back.",
    );
  });

  test("worker-written gate evidence is rejected", () => {
    const f = ready();
    const forged = join(f.worker, "green.txt");
    writeFileSync(forged, "green");
    expect(() => f.runner.collect("toy-run", "forged", forged, f.revision, "verify")).toThrow();
    transcript.push("Refusal: worker-root file submitted as trusted gate evidence → rejected.");
  });

  test("evidence altered in the private store after collection refuses the checkpoint", () => {
    const f = ready();
    const stored = f.runner.status("toy-run").evidence["e1"];
    if (stored === undefined) throw new Error("toy evidence was not collected");
    writeFileSync(stored.ref, "different bytes");
    card(f);
    expect(f.runner.decide("toy-run", "card-1").escalation?.charter_rule).toBe("runner:trusted-evidence");
  });

  test("an answer settles the escalated card with the human's ruling, and a new card cannot flip it", () => {
    const split = (f: ReturnType<typeof ready>, id: string, options: string[]) => {
      f.runner.prepare("toy-run", {
        id,
        operation: "align.run",
        grant: { charter_hash: f.charter.immutability.hash, covers: "align-answer" },
        question: "Proceed?",
        options,
        evidence: ["e1"],
        artifact_hash: `sha256:${"b".repeat(64)}`,
      });
      f.runner.judge("toy-run", id, "seat-a", "supervisor-1", `${id}-a`, options[0] ?? "", []);
      f.runner.judge("toy-run", id, "seat-b", "supervisor-2", `${id}-b`, options[1] ?? "", []);
      return f.runner.decide("toy-run", id);
    };
    const f = ready();
    expect(split(f, "split", ["yes", "no"]).escalation?.charter_rule).toBe("runner:supervisor-disagreement");
    expect(() => card(f, "early")).toThrow("stopped");
    expect(() => f.runner.answer("toy-run", "split", "maybe", "captain", "not an option")).toThrow("card's options");
    expect(() => f.runner.answer("toy-run", "split", "no", "implementer-1", "self-ruling")).toThrow("excluded actor");
    const ruled = f.runner.answer("toy-run", "split", "no", "captain", "The receipt does not support this direction.");
    expect(ruled).toEqual({ operation: "align.run", status: "complete", next_permitted_action: "bound.run" });
    expect(f.runner.decide("toy-run", "split")).toEqual(ruled);
    expect(() => f.runner.answer("toy-run", "split", "yes", "captain", "again")).toThrow("no open escalation");
    expect(new Runner(f.privateDir, f.worker, root).status("toy-run")).toMatchObject({
      run_state: "alignment",
      next_permitted_action: "bound.run",
      open_escalation: null,
    });
    expect(f.runner.ledger("toy-run").entries).toMatchObject([
      {
        decision: { id: "split" },
        outcome: "escalation",
        answered: true,
        answer: { choice: "no", by: "captain", rationale: "The receipt does not support this direction." },
      },
    ]);
    expect(() => card(f, "flip")).toThrow("human ruling settled this checkpoint");
    const g = ready();
    expect(split(g, "unsure", ["yes", "retry"]).status).toBe("needs-input");
    expect(g.runner.answer("toy-run", "unsure", "retry", "captain", "Ask the seats again.").next_permitted_action).toBe(
      "align.run",
    );
    card(g, "again");
    expect(g.runner.decide("toy-run", "again").status).toBe("complete");
    const capped = ready(0);
    card(capped);
    expect(capped.runner.decide("toy-run", "card-1").status).toBe("cap-reached");
    expect(() => capped.runner.answer("toy-run", "card-1", "yes", "captain", "raise it")).toThrow("no open escalation");
    transcript.push(
      "Escalation: seat disagreement → `needs-input`; supervisor `answer` `no` settled the card, advanced the run and was ledgered with its actor and rationale; a fresh card for the same checkpoint was refused. A `retry` ruling reopened the checkpoint. A `cap-reached` run is not answerable.",
    );
  });

  test("a failing seat launcher refuses with its error, and a supervisor answer settles the card", async () => {
    const f = fixture();
    const socket = join(f.privateDir, "runner.sock");
    const seatConfig = join(f.privateDir, "seats.json");
    const adminToken = "a".repeat(48);
    const workerToken = "b".repeat(48);
    const adminTokenFile = join(f.privateDir, "admin.token");
    writeFileSync(adminTokenFile, adminToken, { mode: 0o600 });
    const crashes = join(f.privateDir, "crashes.txt");
    writeFileSync(
      seatConfig,
      JSON.stringify({
        launchers: [
          {
            seat: "seat-a",
            actor: "supervisor-1",
            lineage: ["supervisor-1"],
            command: [
              "bun",
              "-e",
              "await Bun.stdin.text(); console.log(JSON.stringify({choice:'yes',rationale:'ok'}));",
            ],
          },
          {
            seat: "seat-b",
            actor: "supervisor-2",
            lineage: ["supervisor-2"],
            command: [
              "bun",
              "-e",
              "require('node:fs').appendFileSync(process.argv[1], 'crash\\n'); console.error('seat crashed'); process.exit(7);",
              crashes,
            ],
          },
        ],
      }),
    );
    const server = Bun.spawn(
      [
        "bun",
        "src/cli.ts",
        "runner",
        "serve",
        "--socket",
        socket,
        "--state-dir",
        f.privateDir,
        "--worker-root",
        f.worker,
        "--run-id",
        "toy-run",
        "--admin-token-file",
        adminTokenFile,
        "--seat-config",
        seatConfig,
      ],
      { cwd: root, env: { ...process.env, AK_RUNNER_WORKER_TOKEN: workerToken }, stdout: "pipe", stderr: "pipe" },
    );
    try {
      for (let attempt = 0; attempt < 250 && !existsSync(socket); attempt += 1) await Bun.sleep(20);
      const request = join(f.privateDir, "request.json");
      const call = (verb: string, token: string, args: object) => {
        writeFileSync(request, JSON.stringify(args));
        return Bun.spawnSync(["bun", "src/cli.ts", "runner", "call", verb, "--json", request, "--socket", socket], {
          cwd: root,
          env: { ...process.env, AK_RUNNER_TOKEN: token },
          stdout: "pipe",
          stderr: "pipe",
        });
      };
      const run = { run: "toy-run" };
      expect(
        call("start", adminToken, {
          ...run,
          charter: f.path,
          implementer: "implementer-1",
          revision: f.revision,
          standing_grant: standing(f),
        }).exitCode,
      ).toBe(0);
      const receipt = join(f.privateDir, "receipt.txt");
      writeFileSync(receipt, "trusted test output");
      expect(
        call("collect", adminToken, { ...run, id: "e1", source: receipt, revision: f.revision, kind: "source" })
          .exitCode,
      ).toBe(0);
      const prepared = call("prepare", workerToken, {
        ...run,
        card: {
          id: "align",
          operation: "align.run",
          grant: { charter_hash: f.charter.immutability.hash, covers: "align-answer" },
          question: "Proceed?",
          options: ["yes", "no"],
          evidence: ["e1"],
          artifact_hash: `sha256:${"b".repeat(64)}`,
        },
      });
      expect(prepared.exitCode).toBe(0);
      const decided = call("decide", workerToken, { ...run, card_id: "align" });
      expect(decided.exitCode).toBe(0);
      const refusal: unknown = JSON.parse(decided.stdout.toString());
      expect(refusal).toMatchObject({
        status: "needs-input",
        escalation: { charter_rule: "runner:seat-independence" },
      });
      expect(JSON.stringify(refusal)).toContain("seat seat-b: launcher exited 7: seat crashed");
      const ruling = {
        ...run,
        card_id: "align",
        choice: "yes",
        actor: "captain",
        rationale: "Seat b crashed; seat a's reading stands.",
      };
      expect(call("answer", workerToken, ruling).exitCode).toBe(1);
      expect(call("answer", adminToken, ruling).exitCode).toBe(0);
      const replayed = call("decide", workerToken, { ...run, card_id: "align" });
      expect(JSON.parse(replayed.stdout.toString())).toEqual({
        operation: "align.run",
        status: "complete",
        next_permitted_action: "bound.run",
      });
      expect(readFileSync(crashes, "utf8")).toBe("crash\n");
      const status: unknown = JSON.parse(call("status", workerToken, run).stdout.toString());
      expect(status).toMatchObject({
        run_state: "alignment",
        next_permitted_action: "bound.run",
        open_escalation: null,
      });
      const ledger: unknown = JSON.parse(call("ledger", workerToken, run).stdout.toString());
      expect(ledger).toMatchObject({
        entries: [{ answered: true, answer: { choice: "yes", by: "captain", rationale: ruling.rationale } }],
      });
      transcript.push(
        "Seat launcher exit 7 → `decide` returned `needs-input` carrying the launcher error; worker `answer` refused (exit 1); supervisor `answer` `yes` settled the card, advanced the run to `bound.run` and was ledgered; a replayed `decide` returned the ruling without relaunching seats.",
      );
    } finally {
      server.kill();
      await server.exited;
    }
  }, 30_000);

  test("runner evidence cannot land in a linked worktree's shared git common directory", () => {
    const f = fixture();
    const linked = join(f.dir, "linked");
    const added = Bun.spawnSync(["git", "-C", f.worker, "worktree", "add", "-q", "-b", "linked-branch", linked]);
    expect(added.exitCode).toBe(0);
    const sharedEvidence = join(f.worker, ".git", "agent-kit", "evidence");
    expect(() => new Runner(sharedEvidence, linked, root)).toThrow("shared git common directory");
    expect(existsSync(sharedEvidence)).toBe(false);
    transcript.push(
      "Refusal: runner evidence path under a linked worktree's shared git common directory → rejected before directory creation.",
    );
  });

  test("a symlink cannot redirect the runner evidence backend into worker scope", () => {
    const dir = mkdtempSync(join(tmpdir(), "ak-runner-link-"));
    const worker = join(dir, "worker");
    const state = join(dir, "private");
    mkdirSync(worker);
    mkdirSync(state);
    symlinkSync(worker, join(state, "evidence"));
    expect(() => new Runner(state, worker, root)).toThrow("evidence store escapes");
  });
});
