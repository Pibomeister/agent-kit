/**
 * Replay a stored event sequence or a fast-check seed.
 *
 *   bun tests/event-sequences/replay.ts --seed 12345
 *   bun tests/event-sequences/replay.ts --seed 12345 --path '42:1:0' --runs 1
 *   bun tests/event-sequences/replay.ts --events '[{"kind":"cancel"},{"kind":"publish"}]'
 */
import { check as fcCheck, defaultReportMessage, property } from "fast-check";

import { failuresOf, formatEvents, suiteFailures } from "./evaluate.ts";
import { NUM_RUNS, sequenceArb } from "./generator.ts";
import { createWorld } from "./impl.ts";
import { isFiniteNumber } from "./parse.ts";
import { isEventArray, type Event } from "./types.ts";

function flag(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  return argv[index + 1];
}

function usage(): void {
  console.error("usage: bun tests/event-sequences/replay.ts --seed <n> [--path <path>] [--runs <n>]");
  console.error("       bun tests/event-sequences/replay.ts --events '<json>'");
}

function replayEvents(events: readonly Event[]): number {
  const world = createWorld();
  const failures = failuresOf(events, world);
  console.log(formatEvents(events));
  if (failures.length === 0) {
    console.log("pass");
    return 0;
  }
  console.error(failures.join("\n"));
  return 1;
}

function replaySeed(seed: number, path: string | undefined, runs: number): number {
  const world = createWorld();
  const details = fcCheck(
    property(sequenceArb, (events) => suiteFailures(events, world).length === 0),
    {
      numRuns: runs,
      seed,
      path,
    },
  );
  console.log(`event-sequence seed=${details.seed} numRuns=${details.numRuns} failed=${details.failed}`);
  if (!details.failed) return 0;
  const events = details.counterexample?.[0];
  if (events !== undefined) {
    console.error(formatEvents(events));
    console.error(JSON.stringify(events));
    console.error(failuresOf(events, world).join("\n"));
  }
  const report = defaultReportMessage(details);
  if (report !== undefined) console.error(report);
  return 1;
}

const eventsFlag = flag(process.argv, "--events");
const seedFlag = flag(process.argv, "--seed");
const pathFlag = flag(process.argv, "--path");
const runsFlag = flag(process.argv, "--runs");

let code = 0;
if (eventsFlag !== undefined) {
  try {
    const parsed: unknown = JSON.parse(eventsFlag);
    if (!isEventArray(parsed)) {
      console.error("--events must be a JSON array of events whose kind is in the Event union");
      usage();
      code = 2;
    } else code = replayEvents(parsed);
  } catch {
    console.error("invalid --events JSON");
    usage();
    code = 2;
  }
} else if (seedFlag !== undefined) {
  const seed = Number(seedFlag);
  if (!isFiniteNumber(seed)) {
    console.error("--seed must be a finite number");
    usage();
    code = 2;
  } else {
    const runs = runsFlag === undefined || runsFlag === "" ? NUM_RUNS : Number(runsFlag);
    code = replaySeed(seed, pathFlag, isFiniteNumber(runs) ? runs : 1);
  }
} else {
  usage();
  code = 2;
}
process.exit(code);
