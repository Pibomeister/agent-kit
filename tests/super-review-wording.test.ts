/**
 * Super-review workflow step 12: a changes-requested full review is recorded with
 * `--verdict changes-requested`. The 0.1.37 wording recorded the gate only on approved.
 *
 * Everything before Hard gates is frozen to main's bytes. The lock reads SKILL.md
 * after CRLF-to-LF only and compares every byte from the start of the file through
 * the line before the first `## Hard gates` line to a golden copy of origin/main
 * e6d4dfc6. `## Hard gates` is the sentinel. A later Workflow heading is refused,
 * including a fenced one after Hard gates. Editing anything above Hard gates needs
 * a golden update in review.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

const REPO = join(import.meta.dir, "..");
const SENTINEL = "## Hard gates";

/** Bytes from the start of SKILL.md through the line before Hard gates, at origin/main e6d4dfc6. */
const PREFIX_GOLDEN: string =
  "---\nname: super-review\ndescription: >-\n  Convenes an independent specialist panel for a first pass, a bounded second look at an\n  accepted fix, or the readiness gate. The agent doing the work starts the first pass or\n  the readiness gate when a change needs judgment against requirements, the project's\n  declared standards and its tests. No slash command and no human act is required.\n  Reviewers cannot edit source, and the author of the change does not sit a seat or close\n  a finding. Not for writing the fix, not for running acceptance checks, and not for\n  repairing a red pipeline.\nlicense: MIT\nmetadata:\n  ak_catalog_id: super-review\n---\n\n## When to use\n\nUse `full` when a change is ready for judgment and nothing has reviewed it yet: a panel of seats\nreads one immutable snapshot against requirements, the project's declared standards, and the tests.\nThe agent that produced the change starts this itself, as part of the work.\n\nUse `delta` when a finding was accepted, a fix landed, and the fix needs a bounded second look inside\nthe review run that is already open. After the first `full`, every later review of the change is a\n`delta` over the commits since the last reviewed head, past the fix-cycle cap included.\n\nUse `readiness` when a change is otherwise ready to ship and the question is whether the evidence\nbehind it holds up — not what is wrong with the diff, but whether anything required is missing.\n\nUse it when a caller asks whether a change is safe to merge and the honest answer depends on evidence\na reviewer has not yet read.\n\n## Not for\n\nNot for producing the fix. Reviewers do not edit the source they review (`policies/review.yaml`);\naccepted findings leave this skill and enter the apply-findings protocol, which is where an\nimplementer with write authority acts on them.\n\nNot for establishing that the code works. A review reads a change; it does not run the project's\nacceptance checks and does not produce receipts. Closure needs independent verification evidence\nplus a policy rule saying that evidence suffices for that finding, and reviewer confidence stays\nadvisory (ruling `closure-requires-independent-verification`).\n\nNot for repairing a red pipeline. A failing required check is CI repair's bounded operation, whose\nrule restricts the purpose and scope of the repair and never the standard the change has to meet\n(ruling `ci-repair-restricts-purpose-not-permission`). A product-code change discovered there\nre-enters diagnosis, a bounded patch, new verification and affected delta review — this skill's\n`delta` mode over the affected behavior, never a second full panel.\n\nNot for failing a change on its size or its test-ratio shape. A roughly-hundred-line target and a\ntest pyramid are configurable starting points carried in [`engineering-principles`](../../references/engineering-principles/REFERENCE.md), not\ngrounds for a finding on their own (ruling `numeric-heuristics-are-guidance`).\n\nNot for reviewing a requirements document, a plan or an ADR. Those have their own persona catalog and\ntheir own failure modes, and they enter through `doc-review`.\n\n## Authority\n\n`full` and `readiness`: authority `model`, invocation M. The agent doing the work starts either\nwhen a change needs that judgment. No slash command and no human act is required (ADR-0013). A\ndelegated controller may also start the same protocol through `review.full` and `review.readiness`\nunder a runner-validated grant covering finding-adjudication. A bypass grant (ADR-0008) remains a\nvalid start and is not required. `delta`: authority `active-review-run`, invocation M, through\n`review.delta`.\n\nStarting the review is not approval. The author of the change does not sit a seat and does not\nsupply the verdict (ruling `missing-supervisor-never-implementer`). The author does not close a\nfinding (ruling `closure-requires-independent-verification`).\n\nThere is one protocol. Where the host cannot validate a grant, a controller stops rather than\ninventing a second pipeline (ruling `entrypoint-phase-operation-split`). An agent start does not\nneed that grant.\n\nUnder a Firstmate binding, cite `ak firstmate grant --binding <path> --operation review.full` (or\n`review.readiness`) when it exits 0. A refusal means the binding does not cover the delegated\noperation. It does not stop the model start.\n\nUnder a bypass grant, `node <this skill's directory>/../../bin/ak-gate.mjs bypass check --grant\n<path> --task <id> --phase super-review:full` (or `super-review:readiness`) exits 0 as one valid\nstart. Record the gate with `--bypass <path> --task <id>` so it carries the attribution. Under the unattended policy (ADR-0014), record each review gate with its evidence command after `--`, as [the unattended-lifecycle reference](../../references/unattended-lifecycle/REFERENCE.md) says; a blocking finding still stops.\n\n`review.delta` does not open a review run. Invoked where none is open, it stops with `needs-input`\nnaming `super-review full` as the next permitted action.\n\n## Inputs\n\nThe comparison base and the reviewed head, both named. Absent, stop with `needs-input`: a review with\nno comparison base is an opinion about a file tree.\n\nThe requirements the change claims to satisfy, by id, for the spec axis. Where none can be resolved,\nthe spec lane returns `unavailable` rather than inventing an intent to review against.\n\nThe project's declared standards, discovered from the project's own record. Where a project declares\nnone, the standards seat returns an empty result; absent standards never become invented preferences\n(`policies/review.yaml`).\n\nThe test evidence that exists for the change, and the packs the change earned. Packs are the artifact\nevidence that selects conditional seats; they are read, never guessed at from file names alone.\n\nFor `delta` only: the open review run, its persisted finding list with fingerprints and dispositions,\nits input hashes, and the fix diff (`schemas/review.schema.json` `packet`).\n\n## Workflow\n\n1. Name the comparison base and the reviewed head before any other work. Absent either, stop with\n   `needs-input` and do not convene a panel. For `delta`, confirm a review run is open; if not, stop\n   with `needs-input` naming `full` as the next action. Do not stop because a person did not type a\n   command, and do not send the caller away to type one.\n2. Build the snapshot and freeze it: its hash, the comparison base, the reviewed head, the source\n   revision and the input hashes. Every seat reads this one object and no seat may edit it.\n3. Select the panel from declared risk rather than from a fixed roster. Correctness is the only\n   unconditional seat; the standards gate runs when the project declares standards or when discovery\n   was uncertain; testing, maintainability, agent-native and learnings fire when the diff earns them;\n   security, adversarial and the remaining conditional and stack seats are selected from artifact\n   evidence, in practice from the attached packs. A substantive feature lands at the six-ish panel;\n   a documentation typo does not; and security, API and data facts are never dropped because a\n   classifier was uncertain (ruling `panel-composition-by-declared-risk`). A change within the\n   project's size guidance seats the lean panel. The catalog of seats, their selection signals and\n   the lean panel are in `./references/panel.md`.\n4. Assemble one context packet per seat: the frozen snapshot plus that seat's own requirements,\n   standards and test context. No packet carries the implementer's narrative, rationale or\n   self-assessment, another reviewer's findings or dispositions, or any approval context produced by\n   the author lane. Every packet carries the shell rule in `./references/panel.md`. Two seats\n   sharing a scratchpad are one seat.\n5. Check the exclusions before dispatch. A seat that cannot be filled independently of the author is\n   `unavailable`, and the security seat is filled by neither the implementer of the change nor\n   whoever approved its spec (ruling `missing-supervisor-never-implementer`).\n6. Dispatch the selected seats concurrently within the turn, each in its own isolated review context.\n   Every finding quotes the line it is about.\n7. Record each lane's state as `covered`, `skipped` or `unavailable` (`schemas/review.schema.json`);\n   the mapping from a seat's own result is in `./references/panel.md`. A lane that could not run,\n   could not be given its required context, or failed, is `unavailable` with the reason named — a\n   result, not an absence (ruling `required-lane-failure-is-unavailable`). Store each covered seat's\n   output exactly as it returned, as a run artifact referenced by hash, before synthesis reads it.\n8. Synthesize without merging: deduplicate by fingerprint, keep each seat's evidence attached to its\n   finding, and never rewrite a severity to reconcile two seats. Suppression is by the catalogued\n   reasons only, and a suppressed finding stays readable with its reason.\n9. For `delta`: first test whether architecture, requirements, the comparison base or the affected\n   surface changed materially. Where any did, invalidate the affected approvals and establish a new\n   baseline — a new scope with its own pass 1 — instead of continuing this loop (ruling\n   `delta-baseline-reset-not-third-loop`). Fix commits, a reached cap, and a replan or rebase that\n   leaves the accepted requirements, the relevant architecture and the patch all unchanged are not\n   material, nor is a same-finding replan that changes only the patch while no trigger applies.\n   Otherwise build the packet, run the spec and standards lanes over the fix, and bound the scope by\n   affected behavior rather than by changed lines (ruling `delta-scope-affected-behavior`). Seat\n   continuity (ruling `reviewer-continuity-not-amnesia`) and the mechanics: `./references/delta.md`.\n10. For `readiness`: run the two independent lanes as a gate over the panel's synthesized verdict,\n    not as a substitute for it. A missing lane is `unavailable`, and a blocking lane result vetoes\n    approval no matter what the panel concluded. Load\n    [verification evidence](../../references/verification-evidence/REFERENCE.md), then, where the build\n    gate records an implementer seat, require each criterion's current receipt to name a\n    runner-attested verifier seat distinct from it (without that record, only recipe-bound checks\n    need one, and a `host-unattested` seat counts, disclosed as worker-attested, only in a run that never held a grant; under the unattended policy (ADR-0014) a distinct `host-unattested` seat counts as a recorded note, whose boundary is the live merge-gate read, an exception to ruling `closure-requires-independent-verification`). Each `frontend` or `backend` criterion needs a supporting check that declares\n    `evidence_required`, and receipts carrying every declared kind. A missing required attestation, a\n    missing declaration or a missing kind makes the verification lane `unavailable`; name the gap.\n11. Set the verdict from the lane results: `approved`, `changes-requested`, `blocked` or\n    `unavailable`. Emit the review and its findings, and report what is still open.\n12. On `approved`, record the gate for this mode: `node <this skill's directory>/../../bin/ak-gate.mjs record\n    --gate review-full`, `review-delta` or `review-readiness` (the bundle's `bin/`). A `full` that returned\n    `changes-requested` records `review-full --verdict changes-requested`; no other verdict is recorded. A\n    full record on an earlier head, or one that requested changes, counts once an approved delta recorded\n    after it covers the head. Run it from the project checkout; the run defaults to the branch's opened-run\n    pointer (or the branch-named v1 run) and records to the git directory. A binding's brief supplies\n    `--dir`. A record on a run that `ship-preflight` has closed is refused; the task needs a new `open`.\n\n";

function firstSentinelAt(raw: string): number {
  let i = 0;
  while (i <= raw.length) {
    const nl = raw.indexOf("\n", i);
    const end = nl === -1 ? raw.length : nl;
    if (raw.slice(i, end) === SENTINEL) {
      return i;
    }
    if (nl === -1) {
      break;
    }
    i = nl + 1;
  }
  return -1;
}

function normalizeAtxText(content: string): string {
  return content
    .trim()
    .replace(/[ \t]+#+[ \t]*$/u, "")
    .trim()
    .toLowerCase();
}

function isAtxWorkflow(line: string): boolean {
  const match = /^( {0,3})(#{1,6})(?:[ \t]+|$)(.*)$/u.exec(line);
  if (match === null) {
    return false;
  }
  return normalizeAtxText(match[3] ?? "") === "workflow";
}

function isSetextUnderline(line: string): boolean {
  return /^ {0,3}(?:=+|-+)[ \t]*$/u.test(line);
}

function laterWorkflowHeading(rest: string): boolean {
  const lines = rest.split("\n");
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n] ?? "";
    if (isAtxWorkflow(line)) {
      return true;
    }
    const next = lines[n + 1];
    if (next === undefined || line.trim() === "") {
      continue;
    }
    if (isSetextUnderline(next) && line.trim().toLowerCase() === "workflow") {
      return true;
    }
  }
  return false;
}

describe("super-review wording", () => {
  test("step 12 records a changes-requested full review with --verdict changes-requested", () => {
    const raw = readFileSync(join(REPO, "skills/super-review/SKILL.md"), "utf8").replace(/\r\n/g, "\n");
    const hardAt = firstSentinelAt(raw);
    if (hardAt < 0) {
      throw new Error("## Hard gates sentinel is missing");
    }
    try {
      expect(raw.slice(0, hardAt)).toBe(PREFIX_GOLDEN);
    } catch (cause) {
      throw new Error("issue #147: step 12 must tell reviewers to record a changes-requested full review", {
        cause,
      });
    }
    expect(laterWorkflowHeading(raw.slice(hardAt))).toBe(false);
  });
});
