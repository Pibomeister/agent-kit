/**
 * Offline worker-session capture: the three supported host stores condense to
 * one observation per turn, reach their project through a registered root or a
 * recorded worktree, and append idempotently to that project's memory ledger.
 */
import { afterAll, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  cpSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { LearnContext } from "../../src/learn/core/context.ts";
import { Ledger } from "../../src/learn/core/ledger.ts";
import { inProtectedFolder } from "../../src/learn/core/paths.ts";
import { run } from "../../src/learn/core/proc.ts";
import { readJsonl } from "../../src/learn/core/store.ts";
import { ensureMemoryLedger } from "../../src/learn/memory/ledger.ts";
import { memoryDir, readState } from "../../src/learn/memory/ledger.ts";
import { loadEpisodes } from "../../src/learn/memory/episodes.ts";
import { type Registry, readWorktrees, registerRoot } from "../../src/learn/memory/registry.ts";
import { fetchNew, formatObservation } from "../../src/learn/memory/reflect.ts";
import { sessionStartBlock } from "../../src/learn/memory/session-context.ts";
import { tick } from "../../src/learn/memory/tick.ts";
import {
  CAPTURE_ID_BASE,
  type CapturedSession,
  PROTECTED_FOLDER,
  ProjectMemorySource,
  WorkerSessionSource,
  parseCodexSession,
  parseGrokSession,
  parseKimiSession,
  scanWorkerSessions,
  workerRootResolver,
} from "../../src/learn/sources/worker-sessions.ts";
import {
  projectScratch,
  reflectorOrEmptyJudge,
  removeProjectScratch,
  scratch,
  testContext,
  withGitCeiling,
} from "./helpers.ts";

const FIXTURES = join(import.meta.dir, "fixtures", "worker-sessions");

afterAll(removeProjectScratch);

function linkedRepo() {
  const main = join(projectScratch(), "registered");
  mkdirSync(main, { recursive: true });
  run(["git", "init", "-q"], { cwd: main });
  writeFileSync(join(main, "README.md"), "fixture\n");
  run(["git", "add", "-A"], { cwd: main });
  run(["git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init", "--no-gpg-sign"], {
    cwd: main,
  });

  const linked = join(projectScratch(), "linked");
  linkWorktree(main, linked, "fixture");
  return { main, linked };
}

/** A linked worktree of `main` at `linked`, written as git would leave it. */
function linkWorktree(main: string, linked: string, name: string): void {
  const linkedGit = join(main, ".git", "worktrees", name);
  mkdirSync(linkedGit, { recursive: true });
  mkdirSync(linked, { recursive: true });
  writeFileSync(join(linked, ".git"), `gitdir: ${linkedGit}\n`);
  writeFileSync(join(linkedGit, "commondir"), "../..\n");
  writeFileSync(join(linkedGit, "gitdir"), `${join(linked, ".git")}\n`);
  writeFileSync(join(linkedGit, "HEAD"), readFileSync(join(main, ".git", "HEAD"), "utf8"));
}

/** Start a session in the fixture's linked worktree; the ceiling keeps the checkout holding the test scratch out of root discovery. */
function startSessionIn(linked: string, ctx: LearnContext): void {
  withGitCeiling(dirname(linked), () => sessionStartBlock(ctx));
}

function captureWorkerSessions(
  ledger: Ledger,
  sessions: readonly CapturedSession[],
  options: { dryRun?: boolean; sinceMs?: number } = {},
): number {
  return WorkerSessionSource.open(ledger).capture(sessions, options).observations;
}

function requiredSession(value: CapturedSession | null): CapturedSession {
  if (value === null) throw new Error("fixture session did not parse");
  return value;
}

const DAY_MS = 86_400_000;
const FIXTURE_DAY = Date.parse("2026-10-04T00:00:00.000Z");

/**
 * Rewrites a copy of the fixtures as sessions that ran in `cwd` yesterday. The episode window is
 * measured from the real clock, so the recorded day moves with it and the times of day stay.
 */
function placeFixtures(dir: string, cwd: string): void {
  const shift = (Math.floor(Date.now() / DAY_MS) - 1) * DAY_MS - FIXTURE_DAY;
  const day = new Date(FIXTURE_DAY + shift).toISOString().slice(0, 10);
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) placeFixtures(path, cwd);
    else if (entry.isFile() && (path.endsWith(".json") || path.endsWith(".jsonl")))
      writeFileSync(
        path,
        readFileSync(path, "utf8")
          .replaceAll("/fixture/worktree", cwd)
          .replaceAll("2026-10-04T", `${day}T`)
          .replace(/\b1791\d{9}\b/g, (ms) => String(Number(ms) + shift)),
      );
  }
}

function workerSession(nativeId: string, times: readonly number[], modified = Date.now()): CapturedSession {
  return {
    native_id: nativeId,
    memory_session_id: nativeId.padEnd(32, "0"),
    platform: "codex",
    cwd: "/fixture/worktree",
    started_at_epoch: times[0] ?? 0,
    completed_at_epoch: times.at(-1) ?? null,
    modified_at_epoch: modified,
    prompt_count: 0,
    request: null,
    completed: null,
    next_steps: null,
    files_modified: [],
    observations: times.map((at, index) => ({
      type: "turn",
      title: "worker turn",
      text: `${nativeId} step ${index}`,
      at,
      files_modified: [],
    })),
  };
}

/** Two overlapping sessions captured into one ledger: ids follow capture order, not time. */
function overlappingWorkers() {
  const ledger = ensureMemoryLedger(scratch("ak-capture-order-"));
  const long = workerSession("a", [100, 110, 120, 130, 140, 150, 160, 170, 180, 190]);
  const short = workerSession("b", [151, 152, 153, 154, 155, 156, 157, 158, 159, 160]);
  captureWorkerSessions(ledger, [long, short]);
  const workers = WorkerSessionSource.open(ledger);
  const rows = workers.observationsSince("", 0);
  const capFor = (count: number) => rows.slice(0, count).reduce((used, row) => used + formatObservation(row).length, 0);
  return { source: new ProjectMemorySource(null, workers), ids: rows.map((row) => row.id), capFor };
}

function codexMessage(role: "user" | "assistant", text: string) {
  return { type: "response_item", payload: { type: "message", role, content: [{ type: "input_text", text }] } };
}

function codexToolCall(name: string, input: string) {
  return { type: "response_item", payload: { type: "custom_tool_call", name, input } };
}

function codexToolOutput(text: string) {
  return {
    type: "response_item",
    payload: { type: "custom_tool_call_output", output: [{ type: "input_text", text }] },
  };
}

const CODEX_TASK_COMPLETE = { type: "event_msg", payload: { type: "task_complete" } };

/** The first observation of a one-turn rollout whose only tool call returned `output`. */
function shellTurn(id: string, output: string) {
  return requiredSession(
    parseCodexSession(
      writeRollout(scratch("ak-codex-exit-"), id, "/fixture/worktree", [
        codexMessage("user", "Run the checks."),
        codexToolCall("shell", "bun test"),
        codexToolOutput(output),
        codexMessage("assistant", "Done."),
        CODEX_TASK_COMPLETE,
      ]),
    ),
  ).observations[0];
}

function exitHeader(code: number, body: string): string {
  return `Chunk ID: 1f2e3d\nWall time: 0.4 seconds\nProcess exited with code ${code}\nOriginal token count: 12\nOutput:\n${body}`;
}

function execResult(code: number): string {
  return `Script completed\nWall time 0.4 seconds\nOutput:\n{"chunk_id":"1f2e3d","wall_time_seconds":0.4,"exit_code":${code},"output":"error budget ok"}`;
}

/** A Codex rollout under `home`, whose first line is the `session_meta` the scan places it by. */
function writeRollout(home: string, id: string, cwd: string, rows: readonly object[]): string {
  const dir = join(home, "sessions");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `rollout-${id}.jsonl`);
  writeFileSync(
    path,
    [{ type: "session_meta", payload: { id, cwd } }, ...rows].map((row) => JSON.stringify(row)).join("\n"),
  );
  return path;
}

describe("worker session parsers", () => {
  test("condenses a captured Codex rollout into one row per turn with its tool input, failure output and edited files", () => {
    const path = join(FIXTURES, "codex", "sessions", "2026", "10", "04", "rollout-fixture.jsonl");
    const session = requiredSession(parseCodexSession(path));
    expect(session.platform).toBe("codex");
    expect(session.cwd).toBe("/fixture/worktree");
    expect(session.request).toBe("Fix the lint warnings without suppressing the rule.");
    expect(session.completed).toBe("I renamed the token and the lint command is green.");
    expect(session.prompt_count).toBe(1);
    expect(session.memory_session_id).toMatch(/^[0-9a-f]{32}$/);
    expect(session.observations.map((row) => row.type)).toEqual(["error"]);
    expect(session.files_modified).toEqual(["src/lint.ts"]);
    const text = session.observations[0]?.text ?? "";
    expect(text.split("\n").slice(0, 4)).toEqual([
      "prompt: Fix the lint warnings without suppressing the rule.",
      "reply: I renamed the token and the lint command is green.",
      "failed: apply_patch",
      "tools: apply_patch x1",
    ]);
    expect(text).toContain("-> 200 warnings remain: lint/no-placeholder");
    expect(text).not.toContain("injected project instructions");
    expect(text).not.toContain("injected global instructions");
    expect(text).not.toContain("injected skill body");
    expect(text).not.toContain("environment_context");
  });

  test("a turn whose tool results report zero failures is not a failure signal", () => {
    const outputs = [
      "Found 0 warnings and 0 errors.",
      "12 pass\n0 fail\nno regression detected",
      "10 warnings in src/lint.ts",
      "1 error, 0 warnings",
      "2 errors, 0 warnings",
      "3 findings and 2 violations after 0 failures",
      "0 errors, 0 failures, no regressions",
    ];
    const path = writeRollout(scratch("ak-codex-rollout-"), "clean", "/fixture/worktree", [
      ...outputs.flatMap((output, index) => [codexMessage("user", `check ${index}`), codexToolOutput(output)]),
      CODEX_TASK_COMPLETE,
    ]);
    const session = requiredSession(parseCodexSession(path));
    expect(session.observations.map((row) => row.type)).toEqual([
      "turn",
      "turn",
      "error",
      "error",
      "error",
      "error",
      "turn",
    ]);
  });

  test("a turn still running is left for a later scan and stored once its record goes quiet", () => {
    const path = writeRollout(scratch("ak-codex-open-"), "open", "/fixture/worktree", [
      codexMessage("user", "first request"),
      codexMessage("assistant", "first answer"),
      codexMessage("user", "second request"),
      codexToolCall("shell", "bun test"),
    ]);
    const running = requiredSession(parseCodexSession(path));
    expect(running.observations.map((row) => row.text)).toEqual(["prompt: first request\nreply: first answer"]);
    expect(running.prompt_count).toBe(1);

    const quiet = requiredSession(parseCodexSession(path, Date.now() + 2 * 3_600_000));
    expect(quiet.observations).toHaveLength(2);
    expect(quiet.observations[1]?.text).toContain("prompt: second request");
  });

  test("a session past the cap keeps its first prompt and newest turns around a row counting the rest", () => {
    const turns = 1005;
    const path = writeRollout(scratch("ak-codex-long-"), "long", "/fixture/worktree", [
      ...Array.from({ length: turns }, (_, index) => [
        codexMessage("user", `request ${index}`),
        codexMessage("assistant", `answer ${index}`),
      ]).flat(),
      CODEX_TASK_COMPLETE,
    ]);
    const session = requiredSession(parseCodexSession(path));
    expect(session.observations).toHaveLength(999);
    expect(session.observations[0]?.text).toBe("prompt: request 0\nreply: answer 0");
    expect(session.observations[1]).toMatchObject({
      type: "truncated",
      text: "7 earlier turns of this session were left out",
    });
    expect(session.observations[2]?.text).toBe("prompt: request 8\nreply: answer 8");
    expect(session.observations.at(-1)?.text).toBe("prompt: request 1004\nreply: answer 1004");
    expect(session.completed).toBe("answer 1004");
    expect(session.prompt_count).toBe(turns);
  });

  test("stores short scrubbed excerpts, never a full tool output or a credential", () => {
    const token = `ghp_${"a1".repeat(18)}`;
    const path = writeRollout(scratch("ak-codex-scrub-"), "scrub", "/fixture/worktree", [
      codexMessage("user", `Push with ${token} from /Users/alice/project please.`),
      codexToolCall("shell", `curl -H "Authorization: Bearer ${"b2".repeat(16)}" https://example.test`),
      codexToolOutput(`API_TOKEN=${"c3".repeat(12)}\n${"x".repeat(5_000)}\nEND-OF-OUTPUT`),
      codexMessage("assistant", "Pushed."),
      CODEX_TASK_COMPLETE,
    ]);
    const session = requiredSession(parseCodexSession(path));
    const text = session.observations[0]?.text ?? "";
    expect(text).toContain("prompt: Push with [redacted:github-token] from [redacted:home-path]/project please.");
    expect(text).toContain("Bearer [redacted:bearer-token]");
    expect(text).toContain("API_TOKEN=[redacted:env-secret]");
    expect(text).not.toContain("END-OF-OUTPUT");
    expect(text.length).toBeLessThan(900);
    expect(session.request).toBe("Push with [redacted:github-token] from [redacted:home-path]/project please.");
    for (const secret of [token, "b2".repeat(16), "c3".repeat(12), "/Users/alice"])
      expect(JSON.stringify(session)).not.toContain(secret);
  });

  test("a recorded exit status decides whether a call failed, whatever its output says", () => {
    const passed = shellTurn("zero", exitHeader(0, "error handling: 14 pass, warnings as errors enabled"));
    expect(passed?.type).toBe("turn");
    expect(passed?.text).not.toContain("failed:");

    const failed = shellTurn("nonzero", exitHeader(2, "nothing to report"));
    expect(failed?.type).toBe("error");
    expect(failed?.text).toContain("failed: shell");

    expect(shellTurn("exec-zero", execResult(0))?.type).toBe("turn");
    expect(shellTurn("exec-nonzero", execResult(1))?.type).toBe("error");
    expect(shellTurn("unrecorded", "error: preview quota exceeded")?.type).toBe("error");
  });

  test("a Codex sub-agent thread takes its request from the brief addressed to it, never the encrypted part", () => {
    const session = requiredSession(
      parseCodexSession(join(FIXTURES, "codex-subagent", "sessions", "2026", "10", "04", "rollout-subagent.jsonl")),
    );
    expect(session.request).toBe("Audit the retry loop in src/queue.ts and report what you find.");
    expect(session.prompt_count).toBe(1);
    expect(session.observations[0]?.text).toStartWith("prompt: Audit the retry loop in src/queue.ts");
    expect(JSON.stringify(session)).not.toContain("gAAAA-fixture-ciphertext");
    expect(JSON.stringify(session)).not.toContain("Relay for the other worker");
  });

  test("captured rows reach the ledger through the secret gate, which records what it removed", () => {
    const ledger = ensureMemoryLedger(scratch("ak-capture-gate-"));
    const stripe = `sk_live_${"d4".repeat(12)}`;
    const path = writeRollout(scratch("ak-codex-gate-"), "gate", "/fixture/worktree", [
      codexMessage("user", `Charge with ${stripe} now.`),
      codexMessage("assistant", "Charged."),
      CODEX_TASK_COMPLETE,
    ]);
    const session = requiredSession(parseCodexSession(path));
    expect(session.request).toBe("Charge with [redacted:stripe-key] now.");
    captureWorkerSessions(ledger, [{ ...session, completed: `Used ${stripe}.` }]);
    expect(readFileSync(ledger.path("raw", "worker-sessions.jsonl"), "utf8")).not.toContain(stripe);
    expect(readJsonl<{ file: string; kinds: object }>(ledger.path("raw", "secret-redactions.jsonl"))).toEqual([
      expect.objectContaining({ file: "raw/worker-sessions.jsonl", kinds: { "stripe-key": 1 } }),
    ]);
  });

  test("the first 300 characters of a long turn carry its prompt, its final reply and the calls that failed", () => {
    const path = writeRollout(scratch("ak-codex-lead-"), "lead", "/fixture/worktree", [
      codexMessage("user", `Make the checkout total match the cart. ${"Background nobody needs. ".repeat(40)}`),
      codexToolCall("shell", `bun test ${"tests/checkout/".repeat(30)}`),
      codexToolOutput(`3 tests failed\n${"stack frame\n".repeat(200)}`),
      codexMessage("assistant", "First attempt, superseded."),
      codexToolCall("apply_patch", "*** Update File: src/total.ts"),
      codexToolOutput("Success. Updated the following files: src/total.ts"),
      codexToolCall("deploy_preview", "{}"),
      codexToolOutput("error: preview quota exceeded"),
      codexMessage("assistant", `The total now sums line items after discounts. ${"More detail. ".repeat(60)}`),
      CODEX_TASK_COMPLETE,
    ]);
    const text = requiredSession(parseCodexSession(path)).observations[0]?.text ?? "";
    const lead = text.slice(0, 300).split("\n");
    expect(lead[0]).toStartWith("prompt: Make the checkout total match the cart.");
    expect(lead[1]).toStartWith("reply: The total now sums line items after discounts.");
    expect(lead[2]).toBe("failed: shell, deploy_preview");
    expect(text.split("\n")[3]).toBe("tools: shell x1, apply_patch x1, deploy_preview x1");
    expect(text.slice(300)).toContain("-> 3 tests failed");
  });

  test("normalizes a captured Grok session and excludes synthetic context", () => {
    const dir = join(FIXTURES, "grok", "sessions", "%2Ffixture%2Fworktree", "grok-session");
    const session = requiredSession(parseGrokSession(dir));
    expect(session.platform).toBe("grok");
    expect(session.request).toBe("Review why the verifier needed five rounds.");
    expect(session.files_modified).toEqual(["src/review.ts"]);
    expect(session.observations.some((row) => row.text.includes("injected project context"))).toBe(false);
    expect(session.observations.map((row) => row.type)).toEqual(["error"]);
  });

  test("normalizes a captured Kimi wire and excludes injections and private reasoning", () => {
    const dir = join(FIXTURES, "kimi", "sessions", "wd_fixture", "kimi-session");
    const session = requiredSession(parseKimiSession(dir));
    expect(session.platform).toBe("kimi");
    expect(session.request).toBe("Find the regression in the capture loop.");
    expect(session.files_modified).toEqual(["src/capture.ts"]);
    const text = session.observations.map((row) => row.text).join("\n");
    expect(text).not.toContain("injected reminder");
    expect(text).not.toContain("private reasoning");
    expect(text).toContain("Typecheck failed");
  });

  test("scans captured fixture homes for every supported host", () => {
    const scan = scanWorkerSessions(
      {
        codex: [join(FIXTURES, "codex")],
        grok: [join(FIXTURES, "grok")],
        kimi: [join(FIXTURES, "kimi")],
      },
      (cwd) => (cwd === "/fixture/worktree" ? "/registered" : null),
      { sinceMs: 0 },
    );
    expect([...scan.sessions.keys()]).toEqual(["/registered"]);
    expect((scan.sessions.get("/registered") ?? []).map((session) => session.platform).toSorted()).toEqual([
      "codex",
      "grok",
      "kimi",
    ]);
    expect(scan.unmatched).toBe(0);
  });

  test("an unreadable host record is skipped and reported while the other sessions are returned", () => {
    const homes = scratch("ak-worker-unreadable-");
    cpSync(FIXTURES, homes, { recursive: true });
    const broken = join(homes, "kimi", "sessions", "wd_fixture", "broken-session");
    mkdirSync(join(broken, "agents", "main", "wire.jsonl"), { recursive: true });
    writeFileSync(join(broken, "state.json"), JSON.stringify({ id: "broken", cwd: "/fixture/worktree" }));
    const warnings: string[] = [];
    const scan = scanWorkerSessions(
      { codex: [join(homes, "codex")], grok: [join(homes, "grok")], kimi: [join(homes, "kimi")] },
      () => "/registered",
      { sinceMs: 0, warn: (line) => warnings.push(line) },
    );
    expect((scan.sessions.get("/registered") ?? []).map((session) => session.platform).toSorted()).toEqual([
      "codex",
      "grok",
      "kimi",
    ]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(join(broken, "state.json"));
  });

  test("a session outside every registered root is counted from its cwd alone and never parsed", () => {
    const homes = scratch("ak-worker-unmatched-");
    cpSync(FIXTURES, homes, { recursive: true });
    const elsewhere = join(homes, "kimi", "sessions", "wd_fixture", "elsewhere-session");
    mkdirSync(join(elsewhere, "agents", "main", "wire.jsonl"), { recursive: true });
    writeFileSync(join(elsewhere, "state.json"), JSON.stringify({ id: "elsewhere", cwd: "/unregistered/project" }));
    writeRollout(join(homes, "codex"), "elsewhere", "/unregistered/project", [
      codexMessage("user", "work in another project"),
      CODEX_TASK_COMPLETE,
    ]);
    const asked: string[] = [];
    const warnings: string[] = [];
    const scan = scanWorkerSessions(
      { codex: [join(homes, "codex")], grok: [join(homes, "grok")], kimi: [join(homes, "kimi")] },
      (cwd) => {
        asked.push(cwd);
        return cwd === "/fixture/worktree" ? "/registered" : null;
      },
      { sinceMs: 0, warn: (line) => warnings.push(line) },
    );
    expect(scan.unmatched).toBe(2);
    expect(scan.sessions.get("/registered")).toHaveLength(3);
    expect(asked.filter((cwd) => cwd === "/unregistered/project")).toHaveLength(2);
    expect(warnings).toEqual([]);
  });
});

describe("worker scan against what the ledger holds", () => {
  const rows = [
    codexMessage("user", "tidy the cart module"),
    codexMessage("assistant", "The cart module is tidy."),
    CODEX_TASK_COMPLETE,
  ];

  test("a finished session the ledger holds as its record stands is not parsed again and still counts as activity", () => {
    const codex = scratch("ak-worker-held-");
    const path = writeRollout(codex, "held", "/code/shop", rows);
    const homes = { codex: [codex], grok: [], kimi: [] };
    const ledger = ensureMemoryLedger(scratch("ak-capture-held-"));
    const stored = WorkerSessionSource.open(ledger);
    const first = scanWorkerSessions(homes, () => "/code/shop", { stored: () => stored });
    const parsed = first.sessions.get("/code/shop") ?? [];
    expect(parsed).toHaveLength(1);
    expect(stored.capture(parsed)).toEqual({ observations: 1, sessions: 1 });

    const second = scanWorkerSessions(homes, () => "/code/shop", { stored: () => stored });
    expect(second.sessions.size).toBe(0);
    expect(second.activity.get("/code/shop")).toBe(first.activity.get("/code/shop"));
    expect(second.activity.get("/code/shop")).toBe(parsed[0]?.completed_at_epoch ?? 0);

    const later = new Date(Date.now() + 60_000);
    utimesSync(path, later, later);
    const third = scanWorkerSessions(homes, () => "/code/shop", { stored: () => stored });
    const touched = third.sessions.get("/code/shop") ?? [];
    expect(touched).toHaveLength(1);
    expect(stored.capture(touched)).toEqual({ observations: 0, sessions: 1 });
    expect(scanWorkerSessions(homes, () => "/code/shop", { stored: () => stored }).sessions.size).toBe(0);
  });

  test("a session still running is parsed on every scan", () => {
    const codex = scratch("ak-worker-running-");
    writeRollout(codex, "running", "/code/shop", [
      ...rows,
      { type: "event_msg", payload: { type: "task_started" } },
      codexMessage("user", "now the checkout"),
    ]);
    const homes = { codex: [codex], grok: [], kimi: [] };
    const stored = WorkerSessionSource.open(ensureMemoryLedger(scratch("ak-capture-running-")));
    const first = scanWorkerSessions(homes, () => "/code/shop", { stored: () => stored });
    expect(stored.capture(first.sessions.get("/code/shop") ?? [])).toEqual({ observations: 1, sessions: 1 });
    expect(
      scanWorkerSessions(homes, () => "/code/shop", { stored: () => stored }).sessions.get("/code/shop"),
    ).toHaveLength(1);
  });

  test("a session under a root the run does not cover is neither parsed nor counted as unplaced", () => {
    const codex = scratch("ak-worker-scope-");
    writeRollout(codex, "covered", "/code/shop", rows);
    const other = writeRollout(codex, "other", "/code/blog", rows);
    appendFileSync(other, "\n{not json");
    const warnings: string[] = [];
    const scan = scanWorkerSessions({ codex: [codex], grok: [], kimi: [] }, (cwd) => cwd, {
      wanted: (root) => root === "/code/shop",
      warn: (line) => warnings.push(line),
    });
    expect([...scan.sessions.keys()]).toEqual(["/code/shop"]);
    expect([...scan.activity.keys()]).toEqual(["/code/shop"]);
    expect(scan.unmatched).toBe(0);
    expect(warnings).toEqual([]);
  });
});

describe("worker scan places every record before parsing any", () => {
  test("a root is asked about once with its newest record time, and a refused root has no record parsed", () => {
    const codex = scratch("ak-worker-idle-");
    const rows = [codexMessage("user", "tidy the cart module"), CODEX_TASK_COMPLETE];
    const old = new Date(Date.now() - 10 * 86_400_000);
    const older = new Date(Date.now() - 12 * 86_400_000);
    const idle = writeRollout(codex, "idle", "/code/idle", rows);
    appendFileSync(idle, "\n{not json");
    utimesSync(idle, old, old);
    utimesSync(writeRollout(codex, "idle-older", "/code/idle", rows), older, older);
    const busy = writeRollout(codex, "busy", "/code/busy", rows);
    const cutoff = Date.now() - 7 * 86_400_000;
    const asked: Array<[string, number]> = [];
    const warnings: string[] = [];
    const scan = scanWorkerSessions({ codex: [codex], grok: [], kimi: [] }, (cwd) => cwd, {
      wanted: (root, newestMs) => {
        asked.push([root, newestMs]);
        return newestMs >= cutoff;
      },
      warn: (line) => warnings.push(line),
    });
    expect(asked.toSorted(([a], [b]) => a.localeCompare(b))).toEqual([
      ["/code/busy", statSync(busy).mtimeMs],
      ["/code/idle", statSync(idle).mtimeMs],
    ]);
    expect([...scan.sessions.keys()]).toEqual(["/code/busy"]);
    expect([...scan.activity.keys()]).toEqual(["/code/busy"]);
    expect(warnings).toEqual([]);
  });
});

describe("worker capture project resolution", () => {
  const registry: Registry = {
    shop: { root: "/code/shop", mem_project: "shop", last_seen: 1 },
    api: { root: "/code/shop/services/api", mem_project: "api", last_seen: 1 },
  };

  test("places a cwd under the deepest registered root by path alone", () => {
    const rootFor = workerRootResolver(registry, {});
    expect(rootFor("/code/shop")).toBe("/code/shop");
    expect(rootFor("/code/shop/packages/web")).toBe("/code/shop");
    expect(rootFor("/code/shop/services/api/src")).toBe("/code/shop/services/api");
    expect(rootFor("/code/shop-admin")).toBeNull();
    expect(rootFor("/elsewhere/shop")).toBeNull();
  });

  test("places a cwd in a recorded worktree under the root recorded for it", () => {
    const rootFor = workerRootResolver(registry, {
      "/workspaces/shop/fix-cart": "/code/shop",
      "/workspaces/gone/branch": "/code/unregistered",
    });
    expect(rootFor("/workspaces/shop/fix-cart")).toBe("/code/shop");
    expect(rootFor("/workspaces/shop/fix-cart/packages/web")).toBe("/code/shop");
    expect(rootFor("/workspaces/shop/other-branch")).toBeNull();
    expect(rootFor("/workspaces/gone/branch")).toBeNull();
  });
});

describe("memory tick worker capture", () => {
  test("records all three hosts under the root their worktree was recorded for, without a claude-mem database", () => {
    const { main, linked } = linkedRepo();
    const homes = scratch("ak-worker-homes-");
    cpSync(FIXTURES, homes, { recursive: true });
    placeFixtures(homes, linked);
    const ctx = testContext({
      cwd: linked,
      env: {
        AK_LEARN_CODEX_HOMES: join(homes, "codex"),
        AK_LEARN_GROK_HOMES: join(homes, "grok"),
        AK_LEARN_KIMI_HOMES: join(homes, "kimi"),
      },
      replies: [reflectorOrEmptyJudge, { lessons: [], review_events: [], log: "fixture batch" }],
    });
    startSessionIn(linked, ctx);
    expect(readWorktrees(ctx.config)).toEqual({ [linked]: main });

    expect(tick(ctx, { only: main, job: "reflect", force: true })).toBe(0);
    const ledger = new Ledger(memoryDir(ctx.config, main));
    expect(
      loadEpisodes(ledger)
        .map((episode) => episode.platform)
        .toSorted(),
    ).toEqual(["codex", "grok", "kimi"]);
    expect(ctx.out.some((line) => line.includes("worker observations +3"))).toBe(true);
    expect(ctx.prompts).toHaveLength(1);
    expect(ctx.prompts[0]).toContain("200 warnings remain");
    expect(ctx.prompts[0]).toContain("verifier still reports the same finding");
    expect(ctx.prompts[0]).toContain("Typecheck failed in src/capture.ts");
    expect(readState(ledger).last_worker_obs_id_reflected).toBeGreaterThanOrEqual(CAPTURE_ID_BASE);

    expect(tick(ctx, { only: main, job: "nightly", force: true })).toBe(0);
    expect(ctx.prompts).toHaveLength(2);
    expect(ctx.out.some((line) => line.includes("nightly: 3/3 episodes"))).toBe(true);

    expect(tick(ctx, { only: main, job: "reflect", force: true })).toBe(0);
    expect(ctx.prompts).toHaveLength(2);
    expect(WorkerSessionSource.open(ledger).observationsSince("", 0)).toHaveLength(3);
    expect(ctx.out.some((line) => line.includes("worker sessions skipped"))).toBe(false);
  });

  test("a scheduled tick still runs a project whose worker sessions are all captured already", () => {
    const { main } = linkedRepo();
    const codex = scratch("ak-worker-activity-");
    const ctx = testContext({ cwd: main, env: { AK_LEARN_CODEX_HOMES: codex } });
    registerRoot(ctx.config, main);
    writeRollout(codex, "captured", main, [
      codexMessage("user", "tidy the cart module"),
      codexMessage("assistant", "The cart module is tidy."),
      CODEX_TASK_COMPLETE,
    ]);

    expect(tick(ctx)).toBe(0);
    expect(ctx.out.some((line) => line.includes("worker observations +1"))).toBe(true);
    const first = ctx.out.length;
    expect(tick(ctx)).toBe(0);
    const again = ctx.out.slice(first);
    expect(again.some((line) => line.includes("worker observations"))).toBe(false);
    expect(again.some((line) => line.includes("new_obs 1"))).toBe(true);
  });

  test("Grok and Kimi sessions in a linked worktree no hook recorded reach its root through the worktree's git pointer", () => {
    const { main, linked } = linkedRepo();
    const homes = scratch("ak-worker-hookless-");
    for (const host of ["grok", "kimi"]) cpSync(join(FIXTURES, host), join(homes, host), { recursive: true });
    placeFixtures(homes, join(linked, "packages", "web"));
    mkdirSync(join(linked, "packages", "web"), { recursive: true });
    const ctx = testContext({
      cwd: main,
      env: {
        AK_LEARN_CODEX_HOMES: join(homes, "codex"),
        AK_LEARN_GROK_HOMES: join(homes, "grok"),
        AK_LEARN_KIMI_HOMES: join(homes, "kimi"),
      },
    });
    registerRoot(ctx.config, main);
    expect(readWorktrees(ctx.config)).toEqual({});

    expect(tick(ctx, { only: main, job: "reflect" })).toBe(0);
    expect(
      loadEpisodes(new Ledger(memoryDir(ctx.config, main)))
        .map((episode) => episode.platform)
        .toSorted(),
    ).toEqual(["grok", "kimi"]);
    expect(ctx.out.some((line) => line.includes("worker sessions skipped"))).toBe(false);
  });

  test("a worktree pointer naming an unregistered root places nothing", () => {
    const { main, linked } = linkedRepo();
    const entry = { mem_project: "registered", last_seen: 1 };
    expect(workerRootResolver({ other: { ...entry, root: "/code/other" } }, {})(linked)).toBeNull();
    expect(workerRootResolver({ main: { ...entry, root: main } }, {})(join(linked, "src"))).toBe(main);
  });

  test("a removed worktree's sessions still reach its project, and unplaced sessions are counted in one line", () => {
    const { main, linked } = linkedRepo();
    const codex = scratch("ak-worker-removed-");
    const ctx = testContext({ cwd: linked, env: { AK_LEARN_CODEX_HOMES: codex } });
    startSessionIn(linked, ctx);
    rmSync(linked, { recursive: true });
    writeRollout(codex, "after-removal", join(linked, "packages", "web"), [
      codexMessage("user", "finish the cart fix"),
      codexMessage("assistant", "The cart fix is done."),
      CODEX_TASK_COMPLETE,
    ]);
    for (const id of ["stray-one", "stray-two"])
      writeRollout(codex, id, join(scratch("ak-unregistered-"), "project"), [
        codexMessage("user", "unrelated work"),
        CODEX_TASK_COMPLETE,
      ]);

    expect(tick(ctx, { only: main, job: "reflect" })).toBe(0);
    const stored = WorkerSessionSource.open(new Ledger(memoryDir(ctx.config, main))).observationsSince("", 0);
    expect(stored.map((row) => row.facts)).toEqual(["prompt: finish the cart fix\nreply: The cart fix is done."]);
    expect(ctx.out.filter((line) => line.includes("worker sessions skipped"))).toEqual([
      "worker sessions skipped: 2 outside every registered root and worktree",
    ]);
  });
});

describe("worker capture in a macOS protected folder", () => {
  const entry = { mem_project: "registered", last_seen: 1 };
  const rows = [codexMessage("user", "tidy the cart module"), CODEX_TASK_COMPLETE];

  test("the protected-folder test reads the path alone", () => {
    const home = "/Users/nobody-ak-fixture";
    for (const folder of ["Documents", "Desktop", "Downloads"]) {
      expect(inProtectedFolder(join(home, folder), home, "darwin")).toBe(true);
      expect(inProtectedFolder(join(home, folder, "code", "shop", "src"), home, "darwin")).toBe(true);
      expect(inProtectedFolder(join(home, folder, "..", folder, "shop"), home, "darwin")).toBe(true);
      expect(inProtectedFolder(join(home, folder.toLowerCase(), "shop"), home, "darwin")).toBe(true);
      expect(inProtectedFolder(join(home, `${folder}-old`, "shop"), home, "darwin")).toBe(false);
      expect(inProtectedFolder(join(home, folder, "shop"), home, "linux")).toBe(false);
      expect(inProtectedFolder(join(home, folder, "shop"), home, "win32")).toBe(false);
    }
    expect(inProtectedFolder(home, home, "darwin")).toBe(false);
    expect(inProtectedFolder(join(home, "orca", "workspaces", "shop"), home, "darwin")).toBe(false);
    expect(inProtectedFolder(join(home, "code", "Documents", "shop"), home, "darwin")).toBe(false);
    expect(inProtectedFolder("/Users/someone-else/Documents/shop", home, "darwin")).toBe(false);
  });

  test("a linked worktree in Documents, Desktop or Downloads is skipped without its pointer being read", () => {
    const { main } = linkedRepo();
    const home = scratch("ak-fake-home-");
    const registry = { main: { ...entry, root: main } };
    const onMac = workerRootResolver(registry, {}, { home, platform: "darwin" });
    for (const folder of ["Documents", "Desktop", "Downloads"]) {
      const linked = join(home, folder, "linked");
      linkWorktree(main, linked, folder);
      mkdirSync(join(linked, "packages", "web"), { recursive: true });
      // The pointer names the registered root, so any read of it would place the cwd there.
      expect(onMac(linked)).toBe(PROTECTED_FOLDER);
      expect(onMac(join(linked, "packages", "web"))).toBe(PROTECTED_FOLDER);
      expect(workerRootResolver(registry, {}, { home, platform: "linux" })(join(linked, "packages", "web"))).toBe(main);
    }
    expect(onMac(join(home, "Documents", "no-repository"))).toBe(PROTECTED_FOLDER);
  });

  test("a linked worktree outside the protected folders is still placed by its pointer", () => {
    const { main } = linkedRepo();
    const home = scratch("ak-fake-home-");
    const linked = join(home, "orca", "workspaces", "linked");
    linkWorktree(main, linked, "elsewhere");
    const rootFor = workerRootResolver({ main: { ...entry, root: main } }, {}, { home, platform: "darwin" });
    expect(rootFor(linked)).toBe(main);
    expect(rootFor(join(home, "orca", "workspaces", "no-repository"))).toBeNull();
  });

  test("a registered root or recorded worktree in a protected folder still places its sessions by path", () => {
    const home = "/Users/nobody-ak-fixture";
    const root = join(home, "Documents", "shop");
    const recorded = join(home, "Desktop", "shop-fix");
    const rootFor = workerRootResolver(
      { shop: { ...entry, root } },
      { [recorded]: root },
      { home, platform: "darwin" },
    );
    expect(rootFor(join(root, "packages", "web"))).toBe(root);
    expect(rootFor(join(recorded, "src"))).toBe(root);
    expect(rootFor(join(home, "Documents", "other"))).toBe(PROTECTED_FOLDER);
  });

  test("the scan counts each skipped working directory once, apart from the unplaced sessions", () => {
    const codex = scratch("ak-worker-protected-");
    writeRollout(codex, "docs-one", "/home/Documents/shop", rows);
    writeRollout(codex, "docs-two", "/home/Documents/shop", rows);
    writeRollout(codex, "desktop", "/home/Desktop/blog", rows);
    writeRollout(codex, "stray", "/unregistered/project", rows);
    writeRollout(codex, "placed", "/code/shop", rows);
    const scan = scanWorkerSessions({ codex: [codex], grok: [], kimi: [] }, (cwd) =>
      cwd.startsWith("/home/") ? PROTECTED_FOLDER : cwd === "/code/shop" ? cwd : null,
    );
    expect(scan.protectedFolders).toBe(2);
    expect(scan.unmatched).toBe(1);
    expect([...scan.sessions.keys()]).toEqual(["/code/shop"]);
  });

  test("the tick reports the skipped working directories in one line and still captures the rest", () => {
    const { main } = linkedRepo();
    const home = scratch("ak-fake-home-");
    const codex = scratch("ak-worker-protected-tick-");
    const ctx = testContext({ cwd: main, env: { HOME: home, AK_LEARN_CODEX_HOMES: codex } });
    registerRoot(ctx.config, main);
    const linked = join(home, "Documents", "linked");
    linkWorktree(main, linked, "protected");
    for (const id of ["one", "two"]) writeRollout(codex, `documents-${id}`, linked, rows);
    writeRollout(codex, "downloads", join(home, "Downloads", "unpacked"), rows);
    writeRollout(codex, "main", main, [
      codexMessage("user", "finish the cart fix"),
      codexMessage("assistant", "The cart fix is done."),
      CODEX_TASK_COMPLETE,
    ]);

    expect(tick(ctx, { only: main, job: "reflect" })).toBe(0);
    const skipped = ctx.out.filter((line) => line.includes("skipped"));
    // Only macOS guards the folders; elsewhere the pointer is read and the Documents sessions are placed.
    if (process.platform === "darwin")
      expect(skipped).toEqual([
        "worker working directories skipped: 2 in a macOS protected folder, worktree pointer not read",
      ]);
    else expect(skipped).toEqual(["worker sessions skipped: 1 outside every registered root and worktree"]);
    const stored = WorkerSessionSource.open(new Ledger(memoryDir(ctx.config, main))).observationsSince("", 0);
    expect(stored.some((row) => row.facts === "prompt: finish the cart fix\nreply: The cart fix is done.")).toBe(true);
  });
});

describe("reflect window over captured workers", () => {
  test("a capped read after the worker watermark shows the ids next to it, whatever their times", () => {
    const { source, ids, capFor } = overlappingWorkers();
    const shown = fetchNew(source, "", 0, capFor(15), CAPTURE_ID_BASE - 1);
    expect(shown.map((row) => row.id)).toEqual(ids.slice(0, 15));
  });

  test("a zero worker watermark fills from the oldest worker rows in the store", () => {
    const { source, ids, capFor } = overlappingWorkers();
    const shown = fetchNew(source, "", 41, capFor(5), 0);
    expect(shown.map((row) => row.id)).toEqual(ids.slice(0, 5));
  });
});

describe("captured observation ledger", () => {
  test("appends normalized sessions idempotently with a separate monotonic id range", () => {
    const ledger = ensureMemoryLedger(scratch("ak-capture-ledger-"));
    const codex = requiredSession(
      parseCodexSession(join(FIXTURES, "codex", "sessions", "2026", "10", "04", "rollout-fixture.jsonl")),
    );
    const more = workerSession("m", [1, 2, 3]);
    expect(captureWorkerSessions(ledger, [codex, more])).toBe(4);
    expect(captureWorkerSessions(ledger, [codex, more])).toBe(0);

    const source = WorkerSessionSource.open(ledger);
    expect(source.sessions("ignored", 0, Number.MAX_SAFE_INTEGER)).toHaveLength(2);
    expect(source.sessionObservations(codex.memory_session_id)).toHaveLength(1);
    const observations = source.observationsSince("", 0);
    expect(observations).toHaveLength(4);
    expect(observations.every((row) => row.id >= CAPTURE_ID_BASE)).toBe(true);
    expect(new Set(observations.map((row) => row.id)).size).toBe(4);
    expect(new Ledger(ledger.dir).git(["status", "--porcelain"]).stdout).not.toBe("");
  });

  test("a row's text is written once, beside a digest rather than a second copy", () => {
    const ledger = ensureMemoryLedger(scratch("ak-capture-once-"));
    captureWorkerSessions(ledger, [workerSession("t", [1])]);

    const path = ledger.path("raw/worker-observations.jsonl");
    expect(readFileSync(path, "utf8").split("t step 0")).toHaveLength(2);
    const rows = readJsonl<{ narrative: string | null; facts: string; key: string }>(path);
    expect(rows.map((row) => [row.narrative, row.facts])).toEqual([[null, "t step 0"]]);
    expect(rows[0]?.key).toMatch(/^[0-9a-f]{16}$/);
    expect(WorkerSessionSource.open(ledger).observationsSince("", 0).map(formatObservation).join("")).toContain(
      "t step 0",
    );
  });

  test("a session its host stopped writing before the scan window is dropped from the store", () => {
    const ledger = ensureMemoryLedger(scratch("ak-capture-window-"));
    const windowStart = 1_000_000;
    const old = workerSession("o", [1, 2, 3], windowStart - 1);
    const current = workerSession("c", [4, 5], windowStart + 1);
    expect(captureWorkerSessions(ledger, [old, current], { sinceMs: windowStart })).toBe(5);
    expect(captureWorkerSessions(ledger, [old, current], { sinceMs: windowStart })).toBe(0);
    const before = WorkerSessionSource.open(ledger).observationsSince("", 0);
    expect(before).toHaveLength(5);

    const later = workerSession("n", [6], windowStart + 2);
    expect(captureWorkerSessions(ledger, [current, later], { sinceMs: windowStart })).toBe(1);
    const source = WorkerSessionSource.open(ledger);
    const after = source.observationsSince("", 0);
    expect(after.map((row) => row.facts)).toEqual(["c step 0", "c step 1", "n step 0"]);
    expect(after.at(-1)?.id).toBeGreaterThan(Math.max(...before.map((row) => row.id)));
    expect(source.sessions("ignored", 0, Number.MAX_SAFE_INTEGER).map((row) => row.memory_session_id)).toEqual([
      current.memory_session_id,
      later.memory_session_id,
    ]);
    expect(readFileSync(ledger.path("raw/worker-sessions.jsonl"), "utf8").trim().split("\n")).toHaveLength(2);
  });

  test("a host record rewritten shorter still appends its new rows, and only those", () => {
    const ledger = ensureMemoryLedger(scratch("ak-capture-rewrite-"));
    const before = workerSession("g", [1, 2, 3, 4, 5, 6]);
    expect(captureWorkerSessions(ledger, [before])).toBe(6);

    const kept = before.observations.slice(4);
    const added = {
      type: "turn",
      title: "worker turn",
      text: "g step after compaction",
      at: 9,
      files_modified: [],
    };
    const rewritten = { ...before, observations: [...kept, added] };
    expect(captureWorkerSessions(ledger, [rewritten])).toBe(1);
    expect(captureWorkerSessions(ledger, [rewritten])).toBe(0);

    const source = WorkerSessionSource.open(ledger);
    const texts = source.sessionObservations(before.memory_session_id).map((row) => row.facts);
    expect(texts).toEqual([...before.observations.map((row) => row.text), "g step after compaction"]);
    expect(source.sessions("ignored", 0, Number.MAX_SAFE_INTEGER)[0]?.observation_count).toBe(7);
  });

  test("a repeated row is stored once per occurrence", () => {
    const ledger = ensureMemoryLedger(scratch("ak-capture-repeat-"));
    const once = workerSession("r", [1]);
    const twice = { ...once, observations: [...once.observations, ...once.observations] };
    expect(captureWorkerSessions(ledger, [once])).toBe(1);
    expect(captureWorkerSessions(ledger, [twice])).toBe(1);
    expect(captureWorkerSessions(ledger, [twice])).toBe(0);
  });
});
