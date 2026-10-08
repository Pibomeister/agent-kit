import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseLearnArgs } from "../../src/learn/core/context.ts";
import type { Ledger } from "../../src/learn/core/ledger.ts";
import { appendEvents, makeEvent } from "../../src/learn/review/events.ts";
import { DEFAULT_SHOWN, guardrailsSection, topRecent } from "../../src/learn/review/guardrails.ts";
import { registerRoot } from "../../src/learn/memory/registry.ts";
import { ingestOptions, reviewArea } from "../../src/learn/review/cli.ts";
import { reviewLedger, reviewLedgerDir } from "../../src/learn/review/ledger.ts";
import { rebuildIndex, loadPatterns } from "../../src/learn/review/patterns.ts";
import { gitRepo, inOutsideRepo, scratch, testContext } from "./helpers.ts";

function writePage(ledger: Ledger, id: string, count: number, lastSeen: string, extra = ""): void {
  mkdirSync(ledger.path("patterns"), { recursive: true });
  writeFileSync(
    ledger.path("patterns", `${id}.md`),
    `---\nid: ${id}\ntitle: T ${id}\nstatus: active\ncount: ${count}\nlast_seen: ${lastSeen}\n` +
      `sources: [github]\nprs: [1, 2]\npromoted_to: ${extra}\n---\n\n` +
      `## Problem\nP ${id}\n\n## Root cause\nR\n\n## Fix\nFix ${id}.\n\n## Evidence\n- e\n`,
  );
}

function withRuns(ledger: Ledger, rates: string[]): void {
  const rows = rates.map(
    (rate, i) => `| 2026-09-${String(10 + i).padStart(2, "0")} | ${i + 1} | 4 | 1 | 1 | ${rate} |`,
  );
  for (const row of rows) rebuildIndex(ledger, loadPatterns(ledger), row);
}

function run(verb: string, argv: string[], ctx: ReturnType<typeof testContext>): number {
  return reviewArea.verbs[verb]!.run(parseLearnArgs(argv), ctx);
}

describe("guardrails section", () => {
  test("empty without a ledger, and without a bullet; reading never creates the ledger", () => {
    const root = scratch();
    const ctx = testContext();
    expect(guardrailsSection(ctx, root)).toBe("");
    expect(existsSync(reviewLedgerDir(ctx.config, root))).toBe(false);
    reviewLedger(ctx.config, root);
    expect(guardrailsSection(ctx, root)).toBe("");
  });

  test("bullets plus one trend line over the last five runs", () => {
    const root = scratch();
    const ctx = testContext();
    const ledger = reviewLedger(ctx.config, root);
    writePage(ledger, "rp-001", 3, "2026-09-10", "guardrails");
    writePage(ledger, "rp-002", 1, "2026-09-10");
    writeFileSync(ledger.path("guardrails.md"), "- [rp-001] Fix rp-001.\n");
    writeFileSync(ledger.path("pending-team-promotions.md"), "# Pending\n\n## rp-001 → `docs/x.md`\n\napplied: \n");
    withRuns(ledger, ["50%", "40%", "33%", "30%", "25%", "20%"]);
    expect(guardrailsSection(ctx, root)).toBe(
      "Review guardrails (recurring review findings in this repo; check the diff against these before asking for review):\n" +
        "- [rp-001] Fix rp-001.\n" +
        "Review patterns: 2 · repeat rate over the last 5 runs 40%→20% · 1 team promotions pending (`ak learn review promote`)\n",
    );
  });

  test("with more bullets than the cap, the most recent then most frequent stay, in file order", () => {
    const root = scratch();
    const ctx = testContext({ env: { AK_LEARN_GUARDRAILS_SHOWN: "2" } });
    const ledger = reviewLedger(ctx.config, root);
    writePage(ledger, "rp-001", 9, "2026-09-01");
    writePage(ledger, "rp-002", 3, "2026-09-12");
    writePage(ledger, "rp-003", 5, "2026-09-12");
    const bullets = ["- [rp-001] a", "- [rp-002] b", "- [rp-003] c"];
    expect(topRecent(bullets, ledger, 2)).toEqual(["- [rp-002] b", "- [rp-003] c"]);
    expect(topRecent(bullets, ledger, 5)).toEqual(bullets);
    writeFileSync(ledger.path("guardrails.md"), `${bullets.join("\n")}\n`);
    withRuns(ledger, ["10%"]);
    const text = guardrailsSection(ctx, root);
    expect(text).toContain("- [rp-002] b\n- [rp-003] c\n(+1 more in ");
    expect(text).toContain("repeat rate over the last 1 runs 10%");
    expect(DEFAULT_SHOWN).toBe(10);
  });
});

describe("ak learn review", () => {
  const FINDING_REPLY = (hash: string) => ({
    create_patterns: [
      {
        tmp_id: "n1",
        title: "Teardown leaks rows",
        problem: "Rows survive.",
        root_cause: "No ordered cleanup.",
        fix: "Delete leaf-first.",
        event_hashes: [hash],
      },
    ],
    event_matches: [{ hash, pattern_ids: ["n1"] }],
  });

  test("run is ingest, maintain and propose under one lock; report shows the index and guardrails", () => {
    const repo = gitRepo(join(scratch(), "app"));
    const ctx = testContext({
      cwd: repo,
      replies: [(prompt) => FINDING_REPLY(/hash=([0-9a-f]{16})/.exec(prompt)![1]!)],
    });
    const ledger = reviewLedger(ctx.config, repo);
    appendEvents(ledger, [
      makeEvent({
        source: "github",
        kind: "finding",
        project: "app",
        pr: 7,
        sha: null,
        author: "a",
        severity: "P2",
        path: null,
        line: null,
        text: "rows survive",
        url: "https://x.test/7",
        ts: "2026-09-10T00:00:00Z",
      }),
    ]);
    expect(run("run", ["--no-github", "--no-mem"], ctx)).toBe(0);
    expect(ctx.out).toEqual([
      `ingest: +0 new events -> ${ledger.dir}`,
      "maintain: processed 1 events; 1 new patterns; repeat rate 0%",
      "propose: nothing to promote",
    ]);
    expect(existsSync(ledger.path(".lock"))).toBe(false);
    ctx.out.length = 0;
    expect(run("report", [], ctx)).toBe(0);
    const report = ctx.out.join("\n");
    expect(report).toContain("| rp-001 | 1 |");
    expect(report).toContain("## Guardrails\n\n(none)");
  });

  test("promote by hand, list pending, retire, then roll the retirement back", () => {
    const repo = gitRepo(join(scratch(), "app"));
    const ctx = testContext({ cwd: repo });
    const ledger = reviewLedger(ctx.config, repo);
    writePage(ledger, "rp-001", 1, "2026-09-10");
    ledger.commit("seed");
    expect(run("promote", ["--id", "rp-001"], ctx)).toBe(0);
    expect(run("promote", ["--id", "rp-404"], ctx)).toBe(1);
    expect(run("promote", [], ctx)).toBe(0);
    expect(run("retire", [], ctx)).toBe(2);
    expect(run("retire", ["rp-001"], ctx)).toBe(0);
    expect(readFileSync(ledger.path("guardrails.md"), "utf8")).toBe("");
    expect(run("rollback", [], ctx)).toBe(0);
    expect(readFileSync(ledger.path("guardrails.md"), "utf8")).toBe("- [rp-001] Fix rp-001.\n");
    expect(ctx.out).toContain("reverted 'retire: rp-001'");
  });

  test("--repo PATH names the project root from anywhere, --cwd is its alias, and --gh-repo names the GitHub repository", () => {
    const repo = gitRepo(join(scratch(), "app"));
    const ctx = testContext({ cwd: scratch() });
    expect(run("report", ["--repo", repo], ctx)).toBe(0);
    expect(ctx.out.at(-1)).toBe(`ledger: ${reviewLedgerDir(ctx.config, repo)}`);
    expect(run("report", ["--cwd", repo], ctx)).toBe(0);
    expect(ctx.out.at(-1)).toBe(`ledger: ${reviewLedgerDir(ctx.config, repo)}`);
    expect(ingestOptions(parseLearnArgs(["--repo", repo, "--gh-repo", "acme/app", "--pr", "4,5"]), ctx)).toMatchObject({
      repo: "acme/app",
      prs: [4, 5],
    });
    expect(ingestOptions(parseLearnArgs(["--gh-repo=acme/app"]), ctx).repo).toBe("acme/app");
    expect(ingestOptions(parseLearnArgs(["--repo", repo]), ctx).repo).toBeUndefined();
  });

  test("dry runs report and write nothing; a bad --pr and a non-git directory fail", () => {
    const repo = gitRepo(join(scratch(), "app"));
    const ctx = testContext({ cwd: repo, env: { AK_LEARN_DRY_RUN: "1" } });
    // A dry run looks the pattern up like the real run does, so an id the ledger lacks is refused, not "would retire".
    expect(run("retire", ["--id", "rp-001"], ctx)).toBe(1);
    expect(run("rollback", ["--to", "abc"], ctx)).toBe(0);
    expect(ctx.out).toEqual([
      "unknown pattern 'rp-001'; there are none to choose from",
      "dry run: would revert every commit after abc",
    ]);
    expect(existsSync(reviewLedgerDir(ctx.config, repo))).toBe(false);

    const live = testContext({ cwd: repo });
    expect(run("ingest", ["--pr", "12,x", "--no-mem"], live)).toBe(1);
    expect(live.err.join("\n")).toContain("--pr wants PR numbers, got x");
    const { elsewhere, code } = inOutsideRepo((cwd) => {
      const created = testContext({ cwd });
      return { elsewhere: created, code: run("maintain", [], created) };
    });
    expect(code).toBe(1);
    expect(elsewhere.err).toEqual(["ak learn review: not inside a git repository"]);
  });

  test("an unknown --source and a --repo that names no repository are refused with what exists", () => {
    const repo = gitRepo(join(scratch(), "app"));
    const ctx = testContext({ cwd: repo });
    expect(run("ingest", ["--source", "codx", "--no-github", "--no-mem"], ctx)).toBe(1);
    expect(ctx.err).toEqual(["ak learn review: --source: unknown source 'codx'; did you mean codex?"]);
    ctx.err.length = 0;
    expect(run("ingest", ["--source", "codex", "--no-github", "--no-mem"], ctx)).toBe(0);

    registerRoot(ctx.config, repo);
    expect(run("report", ["--repo", `${repo}-old`], ctx)).toBe(1);
    expect(ctx.err).toEqual([
      `ak learn review: not inside a git repository: unknown repository '${repo}-old'; did you mean ${repo}?`,
    ]);
  });
});
