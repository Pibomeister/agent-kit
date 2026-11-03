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
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { check as fcCheck, defaultReportMessage, property } from "fast-check";

import { loadCorpus } from "./corpus.ts";
import { failuresOf, formatEvents } from "./evaluate.ts";
import { CRITICAL, NUM_RUNS, sequenceArb } from "./generator.ts";
import { createWorld } from "./impl.ts";

setDefaultTimeout(60_000);

const world = createWorld();
const seedEnv = process.env["AK_EVENT_SEQ_SEED"];
const pathEnv = process.env["AK_EVENT_SEQ_PATH"];
const parsedSeed = seedEnv === undefined || seedEnv === "" ? undefined : Number(seedEnv);
const seed = parsedSeed !== undefined && Number.isFinite(parsedSeed) ? parsedSeed : undefined;
const runs = pathEnv === undefined || pathEnv === "" ? NUM_RUNS : 1;

describe("review/runner event sequences", () => {
  for (const caseRow of CRITICAL) {
    test(caseRow.name, () => {
      const failures = failuresOf(caseRow.events, world);
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
        expect(failures.length).toBeGreaterThan(0);
        return;
      }
      if (failures.length > 0) throw new Error(`${title}: ${failures.join("; ")}\n${formatEvents(entry.events)}`);
      expect(failures).toEqual([]);
    });
  }

  test(`generated sequences hold plan §7 properties (${NUM_RUNS} runs)`, () => {
    const started = Date.now();
    const details = fcCheck(
      property(sequenceArb, (events) => failuresOf(events, world).length === 0),
      {
        numRuns: runs,
        seed,
        path: pathEnv === undefined || pathEnv === "" ? undefined : pathEnv,
        endOnFailure: true,
      },
    );
    const elapsedMs = Date.now() - started;
    console.log(
      `event-sequence seed=${details.seed} numRuns=${details.numRuns} elapsedMs=${elapsedMs} failed=${details.failed}`,
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
    expect(elapsedMs).toBeLessThan(60_000);
  });
});

afterAll(() => {
  world.restore();
});
