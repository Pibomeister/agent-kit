/**
 * T4 held-out eval evidence template (plan T4 / GAP-14).
 *
 * The writer emits the G3 record with empty scores, empty adjudication
 * records, a null corpus location and a not-run verdict. It never fills a
 * slot and never marks passed. The curator and the adjudicators fill the
 * record. There is no scorer in this tree.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { parseT4Evidence } from "./parse.ts";
import { TEMPLATE_REL, type Io, type T4Evidence } from "./types.ts";

const NOT_RUN =
  "No curator-held corpus and no blind adjudication records are bound to this head. Empty slots are not a pass.";

export { TEMPLATE_REL };

export function forceNotRun(record: T4Evidence): T4Evidence {
  return {
    ...record,
    verdict: "not-run",
    reason: NOT_RUN,
    corpus: { ...record.corpus, location: null },
    adjudication: { ...record.adjudication, records: [] },
    metrics: { material_recall: null },
    scores: null,
    hosts: [],
  };
}

export function renderEvidence(repo: string, io: Io): number {
  let raw: string;
  try {
    raw = readFileSync(join(repo, TEMPLATE_REL), "utf8");
  } catch {
    io.err(`t4-held-out evidence: cannot read ${TEMPLATE_REL}\n`);
    return 1;
  }
  const template = parseT4Evidence(raw);
  if (template === null) {
    io.err("t4-held-out evidence: template is not a G3 record\n");
    return 1;
  }
  io.out(`${JSON.stringify(forceNotRun(template), null, 2)}\n`);
  return 0;
}
