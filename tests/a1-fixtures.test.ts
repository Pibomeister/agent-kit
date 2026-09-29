import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = resolve(import.meta.dir, "..");

const EMPTY_WORKSPACE_CASES = [
  ["doc-review/third-round-does-not-run", "runs/settlement/review.json"],
  ["receiving-review/refuses-to-produce-a-fresh-review", "review/comments.json"],
  ["super-review/baseline-reset-is-not-a-third-delta-loop", "runs/review/baseline.json"],
  ["super-review/confidence-does-not-close-a-finding", "runs/review/findings.json"],
  ["super-review/seat-isolation-unavailable-stops-the-run", "review/input.json"],
  ["super-review/third-fix-cycle-does-not-run", "runs/review/findings.json"],
  ["super-scout/caller-hint-is-not-evidence", "src/auth/token.js"],
  ["super-scout/refuses-unbounded-question", "src/auth/token.js"],
  ["super-ship/lesson-is-drafted-not-published", "evidence/migration-ordering.md"],
  ["super-verify/refuses-code-quality-opinion", "src/session/store.js"],
  ["super-build/round-cap-adjudicates-open-findings", "runs/build/findings.json"],
  ["compound/no-knowledgebase-means-no-repo-fallback", "lesson-draft.md"],
  ["doc-review/no-knowledgebase-write-stops-before-publishing", "runs/document-review/panel.json"],
  ["super-align/no-knowledgebase-write-stops-before-publishing", "runs/alignment/approved.json"],
  ["super-align/typo-fix-does-not-start-alignment", "src/email/templates.js"],
  ["super-bound/no-knowledgebase-write-stops-before-publishing", "specs/approved.md"],
  ["super-bound/reviewed-ticket-does-not-reopen-bounding", "tickets/BILL-412.md"],
  ["super-review/refuses-to-edit-the-source-it-reviews", "review/finding.json"],
  ["wayfind/out-of-scope-needs-a-reason", "maps/search-migration.md"],
] as const;

const made: string[] = [];
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

function loadCase(dir: string) {
  const text = readFileSync(join(ROOT, "evals", dir, "case.yaml"), "utf8");
  const list = (key: string) => new RegExp(`^\\s*${key}: \\[([^\\]]*)\\]`, "m").exec(text)?.[1]
    ?.split(",").map((item) => item.trim()).filter(Boolean) ?? [];
  return {
    tags: list("tags"),
    execution: { allowed_tools: list("allowed_tools") },
    context: { scaffold_script: /^\s+scaffold_script: (.+)$/m.exec(text)?.[1] },
  };
}

describe("A1 state-dependent fixtures", () => {
  test.each(EMPTY_WORKSPACE_CASES)("%s builds the premise at %s", (dir, marker) => {
    const spec = loadCase(dir);
    expect(spec.tags ?? []).not.toContain("needs-fixture");
    expect(spec.context?.scaffold_script).toBe("scaffold.sh");

    const workspace = realpathSync(mkdtempSync(join(tmpdir(), "ak-a1-fixture-")));
    made.push(workspace);
    const script = join(ROOT, "evals", dir, "scaffold.sh");
    expect(existsSync(script)).toBe(true);
    const result = spawnSync("bash", [script], { cwd: workspace, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(join(workspace, marker))).toBe(true);
  });
});

describe("A1 cases whose host capability is unavailable", () => {
  test.each([
    "compound/correction-becomes-one-candidate",
    "wayfind/loose-effort-charts-a-map",
  ])("%s stays out of difference claims", (dir) => {
    expect(loadCase(dir).tags).toContain("needs-fixture");
  });
});

describe("A1 review fixtures expose their revisions", () => {
  test.each([
    "super-review/delta-reaches-an-untouched-affected-caller",
    "super-review/new-behavior-without-coverage-selects-the-testing-seat",
    "super-review/one-line-fix-gets-a-delta-not-a-second-panel",
    "super-review/risk-signals-select-the-conditional-seats",
    "receiving-review/assesses-a-thread-against-the-code",
    "receiving-review/outdated-thread-is-decided-by-fingerprint",
  ])("%s grants Bash for diff and history reads", (dir) => {
    expect(loadCase(dir).execution.allowed_tools).toContain("Bash");
  });
});

describe("A1 scaffold content leaves the behavior observable", () => {
  test("the named-criterion case does not hand the verification command to the subject", () => {
    const workspace = realpathSync(mkdtempSync(join(tmpdir(), "ak-a1-command-")));
    made.push(workspace);
    const script = join(ROOT, "evals/super-verify/named-criterion-gets-a-receipt/scaffold.sh");
    const result = spawnSync("bash", [script], { cwd: workspace, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(workspace, "tickets/AK-214.md"), "utf8")).not.toContain("Verification:");
  });

  test("the approved sandbox direction has a compatible tenant-policy path", () => {
    const scaffold = readFileSync(join(ROOT, "evals/super-bound/approved-direction-produces-spec-and-tickets/scaffold.sh"), "utf8").toLowerCase();
    expect(scaffold).toContain("self-serve sandbox provisioning");
    expect(scaffold).toContain("paying-organisation admin");
  });
});
