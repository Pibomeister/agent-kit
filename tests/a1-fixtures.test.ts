import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { parse as parseYaml } from "yaml";

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

type CaseSpec = {
  tags?: string[];
  execution?: { allowed_tools?: string[] };
  context?: { scaffold_script?: string };
};

function loadCase(dir: string): CaseSpec {
  return parseYaml(readFileSync(join(ROOT, "evals", dir, "case.yaml"), "utf8")) ?? {};
}

function scaffold(dir: string, prefix: string): string {
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  made.push(workspace);
  const script = join(ROOT, "evals", dir, "scaffold.sh");
  const result = spawnSync("bash", [script], { cwd: workspace, encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  return workspace;
}

describe("A1 state-dependent fixtures", () => {
  test.each(EMPTY_WORKSPACE_CASES)("%s builds the premise at %s", (dir, marker) => {
    const spec = loadCase(dir);
    expect(spec.tags ?? []).not.toContain("needs-fixture");
    expect(spec.context?.scaffold_script).toBe("scaffold.sh");

    expect(existsSync(join(ROOT, "evals", dir, "scaffold.sh"))).toBe(true);
    const workspace = scaffold(dir, "ak-a1-fixture-");
    expect(existsSync(join(workspace, marker))).toBe(true);
  });
});

describe("A1 cases whose host capability is unavailable", () => {
  test.each([
    "compound/correction-becomes-one-candidate",
    "super-bound/approved-direction-produces-spec-and-tickets",
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
    expect(loadCase(dir).execution?.allowed_tools).toContain("Bash");
  });
});

describe("A1 scaffold content leaves the behavior observable", () => {
  test("the named-criterion case does not hand the verification command to the subject", () => {
    const workspace = scaffold("super-verify/named-criterion-gets-a-receipt", "ak-a1-command-");
    expect(readFileSync(join(workspace, "tickets/AK-214.md"), "utf8")).not.toContain("Verification:");
  });

  test("the typo-fix premise keeps the baseline's template module and its test green", () => {
    const workspace = scaffold("super-align/typo-fix-does-not-start-alignment", "ak-a1-typo-");
    const check = spawnSync("node", ["--test", "test/email/templates.test.js"], { cwd: workspace, encoding: "utf8" });
    expect(check.status, check.stdout + check.stderr).toBe(0);
    const templates = require(join(workspace, "src/email/templates.js"));
    expect(templates.invoiceFooter).toBe("Payement due on reciept");
    expect(templates.render("Hi {{ name }}", { name: "Ada" })).toBe("Hi Ada");
  });

  test("the approved sandbox direction has a compatible tenant-policy path", () => {
    const workspace = scaffold("super-bound/approved-direction-produces-spec-and-tickets", "ak-a1-direction-");
    const alignment = JSON.parse(readFileSync(join(workspace, "runs/sandbox-self-serve/alignment.json"), "utf8"));
    expect(alignment.status).toBe("approved");
    expect(alignment.direction).toMatch(/self-serve sandbox provisioning/i);
    expect(alignment.decisions.join("\n")).toMatch(/authenticates a paying-organisation admin/i);
    expect(alignment.context).toContain("kb://adr/0004-tenant-model");
    const adr = readFileSync(join(workspace, "knowledge-base/adr/0004-tenant-model.md"), "utf8");
    expect(adr).toMatch(/^status: accepted$/m);
    expect(adr).toMatch(/self-serve\s+sandbox provisioning may use the billing endpoint when it authenticates a\s+paying-organisation admin/i);
  });
});
