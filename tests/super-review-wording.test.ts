/**
 * Super-review workflow step 12: a changes-requested full review is recorded with
 * `--verdict changes-requested`. The 0.1.37 wording recorded the gate only on approved.
 *
 * The lock reads SKILL.md after CRLF-to-LF only. It compares the bytes after the
 * Workflow heading line through the line before Hard gates to a golden copy of
 * origin/main e6d4dfc6. Headings are found by CommonMark rules: trim, strip
 * closing hashes, casefold. Before the Workflow heading, an ordered-list marker
 * or a heading whose normalized text is `workflow` fails. Agents read the
 * source. HTML rendering is out of scope. SKILL.md may contain U+2014 EM DASH.
 * Any other non-ASCII character fails.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

const REPO = join(import.meta.dir, "..");

/** Workflow section body at origin/main e6d4dfc6, after CRLF-to-LF. */
const WORKFLOW_GOLDEN: string =
  "\n1. Name the comparison base and the reviewed head before any other work. Absent either, stop with\n   `needs-input` and do not convene a panel. For `delta`, confirm a review run is open; if not, stop\n   with `needs-input` naming `full` as the next action. Do not stop because a person did not type a\n   command, and do not send the caller away to type one.\n2. Build the snapshot and freeze it: its hash, the comparison base, the reviewed head, the source\n   revision and the input hashes. Every seat reads this one object and no seat may edit it.\n3. Select the panel from declared risk rather than from a fixed roster. Correctness is the only\n   unconditional seat; the standards gate runs when the project declares standards or when discovery\n   was uncertain; testing, maintainability, agent-native and learnings fire when the diff earns them;\n   security, adversarial and the remaining conditional and stack seats are selected from artifact\n   evidence, in practice from the attached packs. A substantive feature lands at the six-ish panel;\n   a documentation typo does not; and security, API and data facts are never dropped because a\n   classifier was uncertain (ruling `panel-composition-by-declared-risk`). A change within the\n   project's size guidance seats the lean panel. The catalog of seats, their selection signals and\n   the lean panel are in `./references/panel.md`.\n4. Assemble one context packet per seat: the frozen snapshot plus that seat's own requirements,\n   standards and test context. No packet carries the implementer's narrative, rationale or\n   self-assessment, another reviewer's findings or dispositions, or any approval context produced by\n   the author lane. Every packet carries the shell rule in `./references/panel.md`. Two seats\n   sharing a scratchpad are one seat.\n5. Check the exclusions before dispatch. A seat that cannot be filled independently of the author is\n   `unavailable`, and the security seat is filled by neither the implementer of the change nor\n   whoever approved its spec (ruling `missing-supervisor-never-implementer`).\n6. Dispatch the selected seats concurrently within the turn, each in its own isolated review context.\n   Every finding quotes the line it is about.\n7. Record each lane's state as `covered`, `skipped` or `unavailable` (`schemas/review.schema.json`);\n   the mapping from a seat's own result is in `./references/panel.md`. A lane that could not run,\n   could not be given its required context, or failed, is `unavailable` with the reason named — a\n   result, not an absence (ruling `required-lane-failure-is-unavailable`). Store each covered seat's\n   output exactly as it returned, as a run artifact referenced by hash, before synthesis reads it.\n8. Synthesize without merging: deduplicate by fingerprint, keep each seat's evidence attached to its\n   finding, and never rewrite a severity to reconcile two seats. Suppression is by the catalogued\n   reasons only, and a suppressed finding stays readable with its reason.\n9. For `delta`: first test whether architecture, requirements, the comparison base or the affected\n   surface changed materially. Where any did, invalidate the affected approvals and establish a new\n   baseline — a new scope with its own pass 1 — instead of continuing this loop (ruling\n   `delta-baseline-reset-not-third-loop`). Fix commits, a reached cap, and a replan or rebase that\n   leaves the accepted requirements, the relevant architecture and the patch all unchanged are not\n   material, nor is a same-finding replan that changes only the patch while no trigger applies.\n   Otherwise build the packet, run the spec and standards lanes over the fix, and bound the scope by\n   affected behavior rather than by changed lines (ruling `delta-scope-affected-behavior`). Seat\n   continuity (ruling `reviewer-continuity-not-amnesia`) and the mechanics: `./references/delta.md`.\n10. For `readiness`: run the two independent lanes as a gate over the panel's synthesized verdict,\n    not as a substitute for it. A missing lane is `unavailable`, and a blocking lane result vetoes\n    approval no matter what the panel concluded. Load\n    [verification evidence](../../references/verification-evidence/REFERENCE.md), then, where the build\n    gate records an implementer seat, require each criterion's current receipt to name a\n    runner-attested verifier seat distinct from it (without that record, only recipe-bound checks\n    need one, and a `host-unattested` seat counts, disclosed as worker-attested, only in a run that never held a grant; under the unattended policy (ADR-0014) a distinct `host-unattested` seat counts as a recorded note, whose boundary is the live merge-gate read, an exception to ruling `closure-requires-independent-verification`). Each `frontend` or `backend` criterion needs a supporting check that declares\n    `evidence_required`, and receipts carrying every declared kind. A missing required attestation, a\n    missing declaration or a missing kind makes the verification lane `unavailable`; name the gap.\n11. Set the verdict from the lane results: `approved`, `changes-requested`, `blocked` or\n    `unavailable`. Emit the review and its findings, and report what is still open.\n12. On `approved`, record the gate for this mode: `node <this skill's directory>/../../bin/ak-gate.mjs record\n    --gate review-full`, `review-delta` or `review-readiness` (the bundle's `bin/`). A `full` that returned\n    `changes-requested` records `review-full --verdict changes-requested`; no other verdict is recorded. A\n    full record on an earlier head, or one that requested changes, counts once an approved delta recorded\n    after it covers the head. Run it from the project checkout; the run defaults to the branch's opened-run\n    pointer (or the branch-named v1 run) and records to the git directory. A binding's brief supplies\n    `--dir`. A record on a run that `ship-preflight` has closed is refused; the task needs a new `open`.\n\n";

type Heading = {
  text: string;
  level: number;
  at: number;
  lineEnd: number;
};

type Line = {
  start: number;
  end: number;
  text: string;
};

function linesOf(raw: string): Line[] {
  const lines: Line[] = [];
  let i = 0;
  while (i <= raw.length) {
    const nl = raw.indexOf("\n", i);
    const end = nl === -1 ? raw.length : nl;
    lines.push({ start: i, end, text: raw.slice(i, end) });
    if (nl === -1) {
      break;
    }
    i = nl + 1;
  }
  return lines;
}

function normalizeHeadingText(content: string): string {
  return content
    .trim()
    .replace(/[ \t]+#+[ \t]*$/u, "")
    .trim()
    .toLowerCase();
}

function atxHeading(line: string): { level: number; text: string } | undefined {
  const match = /^( {0,3})(#{1,6})(?:[ \t]+|$)(.*)$/u.exec(line);
  if (match === null) {
    return undefined;
  }
  const marks = match[2];
  if (marks === undefined) {
    return undefined;
  }
  return { level: marks.length, text: normalizeHeadingText(match[3] ?? "") };
}

function setextLevel(line: string): number | undefined {
  if (/^ {0,3}=+[ \t]*$/u.test(line)) {
    return 1;
  }
  if (/^ {0,3}-+[ \t]*$/u.test(line)) {
    return 2;
  }
  return undefined;
}

function headingsOf(raw: string): Heading[] {
  const lines = linesOf(raw);
  const headings: Heading[] = [];
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n];
    if (line === undefined) {
      continue;
    }
    const atx = atxHeading(line.text);
    if (atx !== undefined) {
      const next = lines[n + 1];
      headings.push({
        text: atx.text,
        level: atx.level,
        at: line.start,
        lineEnd: next === undefined ? raw.length : next.start,
      });
      continue;
    }
    const next = lines[n + 1];
    if (next === undefined || line.text.trim() === "") {
      continue;
    }
    const level = setextLevel(next.text);
    if (level === undefined) {
      continue;
    }
    const after = lines[n + 2];
    headings.push({
      text: normalizeHeadingText(line.text),
      level,
      at: line.start,
      lineEnd: after === undefined ? raw.length : after.start,
    });
    n += 1;
  }
  return headings;
}

describe("super-review wording", () => {
  test("step 12 records a changes-requested full review with --verdict changes-requested", () => {
    const raw = readFileSync(join(REPO, "skills/super-review/SKILL.md"), "utf8").replace(/\r\n/g, "\n");
    expect(raw.replace(/[\t\n\x20-\x7E\u2014]/g, "")).toBe("");
    const headings = headingsOf(raw);
    const workflow = headings.find((heading) => heading.text === "workflow" && heading.level === 2);
    if (workflow === undefined) {
      throw new Error("Workflow heading is missing");
    }
    const before = headings.filter((heading) => heading.at < workflow.at && heading.text === "workflow");
    expect(before).toEqual([]);
    const hard = headings.find(
      (heading) => heading.at > workflow.at && heading.text === "hard gates" && heading.level === 2,
    );
    if (hard === undefined) {
      throw new Error("Hard gates heading is missing");
    }
    const prefix = raw.slice(0, workflow.at);
    expect(prefix.split("\n").some((line) => /^\s{0,3}\d{1,9}[.)]/u.test(line))).toBe(false);
    try {
      expect(raw.slice(workflow.lineEnd, hard.at)).toBe(WORKFLOW_GOLDEN);
    } catch (cause) {
      throw new Error("issue #147: step 12 must tell reviewers to record a changes-requested full review", {
        cause,
      });
    }
  });
});
