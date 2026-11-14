/**
 * T7 pilot evidence template (plan T7 / GAP-16).
 *
 * The writer emits the G5 record with empty repos, empty changes, null
 * measures and a not-run verdict. It never names a pilot repo and never
 * marks passed. The maintainer names the repos. Humans record rework,
 * cost and attention. There is no scorer in this tree.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { parseT7Evidence } from "./parse.ts";
import { TEMPLATE_REL, type Io, type T7Evidence } from "./types.ts";

const NOT_RUN =
  "No maintainer-named repos, matched baseline, or human-recorded measures are bound to this head. Empty slots are not a pass.";

export { TEMPLATE_REL };

export function forceNotRun(record: T7Evidence): T7Evidence {
  return {
    ...record,
    verdict: "not-run",
    reason: NOT_RUN,
    pilot: {
      ...record.pilot,
      repos: [],
      matched_baseline: null,
      changes: [],
    },
    measures: { rework: null, cost: null, attention: null },
  };
}

export function renderEvidence(repo: string, io: Io): number {
  let raw: string;
  try {
    raw = readFileSync(join(repo, TEMPLATE_REL), "utf8");
  } catch {
    io.err(`t7-pilot evidence: cannot read ${TEMPLATE_REL}\n`);
    return 1;
  }
  const template = parseT7Evidence(raw);
  if (template === null) {
    io.err("t7-pilot evidence: template is not a G5 record\n");
    return 1;
  }
  io.out(`${JSON.stringify(forceNotRun(template), null, 2)}\n`);
  return 0;
}
