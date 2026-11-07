/**
 * Review/runner event-sequence property suite (plan §7 / GAP-07).
 *
 * Properties (plan §7 → this file):
 * - Approval implies every required lane is covered — unavailable + timeout rules
 * - Byte/rubric changes cannot keep a current approval — approval.stale
 * - Resume cannot decrease consumed repair counters — budget across resume/restart
 * - Synthesis cannot change lane execution state or erase conflicting evidence
 * - Applied does not imply resolved — awaiting-verification vs finding.self-closed
 * - Author-controlled flags cannot establish isolation or authority
 * - Cancelled work cannot later publish a current success
 * - Reordering independent seat completion does not change coverage or authority
 * - A renamed run or moved line cannot mint a new repair budget
 *
 * CI is deterministic: when AK_EVENT_SEQ_SEED is unset the suite uses PINNED_SEED.
 * Random exploration is opt-in: AK_EVENT_SEQ_RANDOM=1.
 *
 * Replay a seed (printed on every run as `event-sequence seed=`):
 *   AK_EVENT_SEQ_SEED=<seed> bun test tests/event-sequences/event-sequences.test.ts
 *
 * Replay one shrinking path:
 *   AK_EVENT_SEQ_SEED=<seed> AK_EVENT_SEQ_PATH=<path> bun test tests/event-sequences/event-sequences.test.ts
 *
 * Replay a stored sequence or seed from the CLI:
 *   bun tests/event-sequences/replay.ts --seed <seed> [--path <path>] [--runs 1000]
 *   bun tests/event-sequences/replay.ts --events '<json array of events>'
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { check as fcCheck, defaultReportMessage, property } from "fast-check";

import { loadCorpus } from "./corpus.ts";
import { failuresOf, formatEvents, PROBE_TIMEOUT_GAP, suiteFailures } from "./evaluate.ts";
import { CRITICAL, NUM_RUNS, PINNED_SEED, sequenceArb } from "./generator.ts";
import { applyImpl, createWorld, inspectImpl, type World } from "./impl.ts";
import { applyEvent, initialModel } from "./model.ts";
import { isFiniteNumber } from "./parse.ts";
import type { Event } from "./types.ts";

const EVENT_SEQ_BUDGET_MS = 300_000;
setDefaultTimeout(EVENT_SEQ_BUDGET_MS);

const world = createWorld();
const seedEnv = process.env["AK_EVENT_SEQ_SEED"];
const pathEnv = process.env["AK_EVENT_SEQ_PATH"];
const randomEnv = process.env["AK_EVENT_SEQ_RANDOM"];
const parsedSeed = seedEnv === undefined || seedEnv === "" ? undefined : Number(seedEnv);
const explicitSeed = parsedSeed !== undefined && isFiniteNumber(parsedSeed) ? parsedSeed : undefined;
const seed = explicitSeed ?? (randomEnv === "1" ? undefined : PINNED_SEED);
const runs = pathEnv === undefined || pathEnv === "" ? NUM_RUNS : 1;

describe("review/runner event sequences", () => {
  for (const caseRow of CRITICAL) {
    test(caseRow.name, () => {
      const failures = suiteFailures(caseRow.events, world);
      if (failures.length > 0) throw new Error(`${caseRow.name}: ${failures.join("; ")}`);
      expect(failures).toEqual([]);
    });
  }

  for (const entry of loadCorpus()) {
    const title = entry.knownFailure
      ? `known failure seed ${entry.seed ?? "sequence"}: ${entry.note}`
      : `regression seed ${entry.seed ?? "sequence"}`;
    test(title, () => {
      const failures = failuresOf(entry.events, world);
      if (entry.knownFailure) {
        const expected = entry.expectedFailure;
        if (expected === undefined) throw new Error(`${title}: knownFailure entry has no expectedFailure`);
        const matched = failures.some((failure) => failure.includes(expected));
        if (!matched) {
          throw new Error(`${title}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(failures)}`);
        }
        expect(matched).toBe(true);
        return;
      }
      if (failures.length > 0) throw new Error(`${title}: ${failures.join("; ")}\n${formatEvents(entry.events)}`);
      expect(failures).toEqual([]);
    });
  }

  test("sequence X after a long sequence Y matches X alone", () => {
    const x: Event[] = [
      { kind: "cover-lane", role: "code-review/correctness", filledBy: "supervisor-1" },
      { kind: "cover-lane", role: "code-review/security", filledBy: "supervisor-2" },
      { kind: "set-verdict", verdict: "approved" },
      { kind: "charge-fix-cycle", findingId: "finding-a" },
      { kind: "rename-run" },
      { kind: "publish" },
    ];
    const y: Event[] = [
      { kind: "charge-fix-cycle", findingId: "finding-a" },
      { kind: "charge-fix-cycle", findingId: "finding-b" },
      { kind: "resume" },
      { kind: "rename-run" },
      { kind: "move-line", findingId: "finding-a" },
      { kind: "move-line", findingId: "finding-b" },
      { kind: "unavailable-lane", role: "code-review/security", reason: "timeout" },
      { kind: "synthesize", soften: true, mutateLaneState: true },
      { kind: "resolve-finding", findingId: "finding-a", closer: "implementer", independent: false },
      { kind: "cancel" },
      { kind: "publish" },
      { kind: "change-bytes" },
    ];
    const alone = failuresOf(x, world);
    failuresOf(y, world);
    world.restore();
    expect(world.renameSeq).toBe(0);
    expect(world.cancelled).toBe(false);
    expect(world.publishedAfterCancel).toBe(false);
    expect(existsSync(join(world.privateDir, "toy-run-r1.json"))).toBe(false);
    expect(existsSync(join(world.privateDir, "toy-run-finding-a-l1.json"))).toBe(false);
    expect(existsSync(join(world.privateDir, "toy-run-finding-b-l1.json"))).toBe(false);
    expect(existsSync(join(world.ctx.root, "templates", "finding-a.json"))).toBe(false);
    expect(existsSync(join(world.ctx.root, "templates", "finding-b.json"))).toBe(false);
    expect(existsSync(join(world.ctx.root, "templates", "finding.json"))).toBe(false);
    expect(existsSync(join(world.ctx.root, "templates", "review-probe.json"))).toBe(false);
    const after = failuresOf(x, world);
    expect(after).toEqual(alone);
  });

  test("replay of a shrunk counterexample reproduces", () => {
    const events: Event[] = [
      { kind: "unavailable-lane", role: "code-review/correctness", reason: "timeout" },
      { kind: "unavailable-lane", role: "code-review/security", reason: "timeout" },
      { kind: "synthesize", soften: false, mutateLaneState: true },
      { kind: "set-verdict", verdict: "approved" },
    ];
    const first = failuresOf(events, world);
    const second = failuresOf(events, world);
    expect(first).toEqual(second);
    expect(first.some((failure) => failure.includes(PROBE_TIMEOUT_GAP))).toBe(true);
    const replayed = Bun.spawnSync(["bun", "tests/event-sequences/replay.ts", "--events", JSON.stringify(events)], {
      cwd: joinRoot(),
    });
    expect(replayed.exitCode).toBe(1);
    expect(replayed.stderr.toString()).toContain(PROBE_TIMEOUT_GAP);
  });

  test("harness: truncated fix_cycles after restart is a budget drop", () => {
    const broken = createWorld();
    broken.zeroBudgetAfterRestart = true;
    const failures = failuresOf([{ kind: "charge-fix-cycle", findingId: "finding-a" }, { kind: "restart" }], broken);
    expect(failures.length).toBeGreaterThan(0);
    expect(failures.some((failure) => /budget .+ fell/.test(failure))).toBe(true);
  });

  test("harness: dropping the unavailable rule surfaces the timeout failure", () => {
    const broken = createWorld();
    broken.submitTimeoutAsCovered = true;
    const events: Event[] = [
      { kind: "unavailable-lane", role: "code-review/security", reason: "timeout" },
      { kind: "cover-lane", role: "code-review/correctness", filledBy: "supervisor-1" },
      { kind: "set-verdict", verdict: "approved" },
    ];
    const failures = failuresOf(events, broken);
    expect(failures.length).toBeGreaterThan(0);
    expect(
      failures.some((failure) =>
        failure.includes(
          "approved a required timeout/unavailable lane; review.unavailable-required-lane-blocks-approval did not fire",
        ),
      ),
    ).toBe(true);
    const view = inspectSequence(broken, events);
    expect(view.rules).not.toContain("review.unavailable-required-lane-blocks-approval");
    expect(view.rules).not.toContain("schemas.document-invalid");
  });

  test("artifact rules for X after Y match X alone when findings and ticket match", () => {
    const isolated = createWorld();
    isolated.grantOnApprovedReview = true;
    const shared: Event[] = [
      { kind: "resolve-finding", findingId: "finding-a", closer: "verifier", independent: true },
      { kind: "cover-lane", role: "code-review/correctness", filledBy: "supervisor-1" },
      { kind: "cover-lane", role: "code-review/security", filledBy: "supervisor-2" },
    ];
    const x: Event[] = [...shared, { kind: "set-verdict", verdict: "approved" }];
    const y: Event[] = [...shared, { kind: "set-verdict", verdict: "blocked" }];
    inspectImpl(isolated, modelFrom(y));
    const after = inspectImpl(isolated, modelFrom(x));
    const fresh = createWorld();
    fresh.grantOnApprovedReview = true;
    const alone = inspectImpl(fresh, modelFrom(x));
    expect(alone.rules).toContain("grant.charter-hash-unknown");
    expect(after.rules).toEqual(alone.rules);
  });

  test("harness: a forced publish after cancel is a cancel failure", () => {
    const broken = createWorld();
    broken.allowPublishAfterCancel = true;
    const failures = failuresOf([{ kind: "cancel" }, { kind: "publish" }, { kind: "publish" }], broken);
    expect(failures.length).toBeGreaterThan(0);
    expect(failures.some((failure) => failure.includes("cancelled run published a current result"))).toBe(true);
    expect(Object.keys(broken.runner.status(broken.runId).effects).length).toBeGreaterThan(0);
  });

  // Explicit per-test timeout keeps the 300s property budget when run.sh passes --timeout=30000.
  test(
    `generated sequences hold plan §7 properties (${NUM_RUNS} runs)`,
    () => {
      const started = Date.now();
      const details = fcCheck(
        property(sequenceArb, (events) => suiteFailures(events, world).length === 0),
        {
          numRuns: runs,
          seed,
          path: pathEnv === undefined || pathEnv === "" ? undefined : pathEnv,
          endOnFailure: true,
        },
      );
      const elapsedMs = Date.now() - started;
      console.log(
        `event-sequence seed=${details.seed} numRuns=${details.numRuns} elapsedMs=${elapsedMs} budgetMs=${EVENT_SEQ_BUDGET_MS} failed=${details.failed}`,
      );
      if (details.failed) {
        const events = details.counterexample?.[0];
        const listed =
          events === undefined
            ? ""
            : `\n${formatEvents(events)}\n${JSON.stringify(events)}\n${failuresOf(events, world).join("\n")}`;
        throw new Error(`${defaultReportMessage(details) ?? "property failed"}${listed}`);
      }
      expect(details.numRuns).toBe(runs);
    },
    EVENT_SEQ_BUDGET_MS,
  );

  test("replay rejects a non-finite seed", () => {
    const result = Bun.spawnSync(["bun", "tests/event-sequences/replay.ts", "--seed", "nope"], { cwd: joinRoot() });
    expect(result.exitCode).toBe(2);
    expect(result.stderr.toString()).toContain("usage:");
  });

  test("replay rejects invalid events JSON", () => {
    const result = Bun.spawnSync(["bun", "tests/event-sequences/replay.ts", "--events", "{"], { cwd: joinRoot() });
    expect(result.exitCode).toBe(2);
    expect(result.stderr.toString()).toContain("invalid --events JSON");
  });

  test("replay rejects an unknown event kind", () => {
    const result = Bun.spawnSync(["bun", "tests/event-sequences/replay.ts", "--events", '[{"kind":"not-an-event"}]'], {
      cwd: joinRoot(),
    });
    expect(result.exitCode).toBe(2);
    expect(result.stderr.toString()).toContain("Event union");
  });
});

afterAll(() => {
  world.restore();
});

function joinRoot(): string {
  return join(import.meta.dir, "..", "..");
}

function inspectSequence(target: World, events: readonly Event[]) {
  target.restore();
  const model = initialModel();
  for (const event of events) {
    applyEvent(model, event);
    applyImpl(target, event);
  }
  return inspectImpl(target, model);
}

function modelFrom(events: readonly Event[]) {
  const model = initialModel();
  for (const event of events) applyEvent(model, event);
  return model;
}
