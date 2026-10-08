import { describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { Ledger } from "../../src/learn/core/ledger.ts";
import { appendEvents, loadEvents, makeEvent } from "../../src/learn/review/events.ts";
import { EVENTS_FILE, reviewLedger } from "../../src/learn/review/ledger.ts";
import { PROCESSED_FILE } from "../../src/learn/review/maintain.ts";
import { loadPatterns } from "../../src/learn/review/patterns.ts";
import {
  guardrailDraft,
  pendingPromotions,
  promoteById,
  propose,
  retire,
  rollback,
  skillCandidates,
} from "../../src/learn/review/propose.ts";
import { span } from "../../src/learn/core/trace.ts";
import { compileSchemas } from "../../src/validation/schemas.ts";
import { gitRepo, scratch, testContext } from "./helpers.ts";

const REPO = resolve(import.meta.dir, "..", "..");

interface PageOptions {
  count: number;
  status?: string;
  promotedTo?: string;
  promotedCount?: number | "";
  teamTarget?: string;
  fix?: string;
  lastSeen?: string;
  sources?: string;
  prs?: string;
  reviewers?: string;
  skillCandidate?: string;
}

function page(id: string, options: PageOptions): string {
  const {
    count,
    status = "active",
    promotedTo = "",
    promotedCount = "",
    teamTarget = "",
    fix = "Do the one thing.",
    lastSeen = "2026-09-10",
    sources = "claude-mem, github",
    prs = "1, 2",
    reviewers = "a, b",
    skillCandidate,
  } = options;
  return (
    `---\nid: ${id}\ntitle: T ${id}\nstatus: ${status}\ncount: ${count}\nfirst_seen: 2026-09-01\nlast_seen: ${lastSeen}\n` +
    `sources: [${sources}]\nprs: [${prs}]\nreviewers: [${reviewers}]\n` +
    `promoted_to: ${promotedTo}\nteam_target: ${teamTarget}\npromoted_count: ${promotedCount}\n` +
    (skillCandidate === undefined ? "" : `skill_candidate: ${skillCandidate}\n`) +
    `---\n\n` +
    `## Problem\nP ${id}\n\n## Root cause\nR ${id}\n\n## Fix\n${fix}\n\n## Evidence\n` +
    `- https://github.com/acme/app/pull/1#discussion_r9 (a P2 pr 1 2026-09-10)\n- obs:44 (b pr 2 2026-09-10)\n`
  );
}

function setup(root = scratch()) {
  const ctx = testContext();
  const ledger = reviewLedger(ctx.config, root);
  mkdirSync(ledger.path("patterns"), { recursive: true });
  const write = (id: string, options: PageOptions) =>
    writeFileSync(ledger.path("patterns", `${id}.md`), page(id, options));
  return { ctx, ledger, root, write };
}

function guardrails(ledger: Ledger): string {
  return readFileSync(ledger.path("guardrails.md"), "utf8");
}

describe("propose", () => {
  test("threshold three, not two, and a candidate never promotes", () => {
    const { ctx, ledger, root, write } = setup();
    write("rp-001", { count: 3 });
    write("rp-002", { count: 2 });
    write("rp-003", { count: 5, status: "candidate" });
    expect(propose(ctx, ledger, root, 3)).toBe("promoted rp-001 to guardrails");
    expect(guardrails(ledger)).toBe("- [rp-001] Do the one thing.\n");
    const meta = loadPatterns(ledger).get("rp-001")!.meta;
    expect([meta.promoted_to, meta.promoted_count]).toEqual(["guardrails", 3]);
    expect(ledger.git(["log", "-1", "--format=%s"]).stdout.trim()).toBe("propose: guardrails +rp-001");
    expect(propose(ctx, ledger, root, 3)).toBe("nothing to promote");
  });

  test("the threshold defaults to config.promoteAt", () => {
    const { ledger, root, write } = setup();
    write("rp-001", { count: 4 });
    const ctx = testContext({ env: { AK_LEARN_PROMOTE_AT: "5" } });
    expect(propose(ctx, ledger, root)).toBe("nothing to promote");
    write("rp-001", { count: 5 });
    expect(propose(ctx, ledger, root)).toBe("promoted rp-001 to guardrails");
  });

  test("a promotion recorded before promoted_count existed gets today's count as its baseline", () => {
    const { ctx, ledger, root, write } = setup();
    write("rp-001", { count: 26, promotedTo: "guardrails" });
    expect(propose(ctx, ledger, root, 3)).toBe("nothing to promote");
    expect(loadPatterns(ledger).get("rp-001")!.meta.promoted_count).toBe(26);
    expect(ledger.git(["log", "-1", "--format=%s"]).stdout.trim()).toBe(
      "propose: bookkeeping (promoted_count baseline)",
    );
    expect(skillCandidates(loadPatterns(ledger))).toEqual([]);
  });

  test("skill candidates: recurrence after promotion, or a multi-step fix", () => {
    const { ledger, write } = setup();
    write("rp-001", { count: 5, promotedTo: "guardrails", promotedCount: 3 });
    write("rp-002", { count: 3, promotedTo: "guardrails", promotedCount: 3, fix: "1. a\n2. b" });
    write("rp-003", { count: 4, promotedTo: "guardrails", promotedCount: 3 });
    const found = skillCandidates(loadPatterns(ledger)).map((item) => [item.pattern.id, item.reason]);
    expect(found).toEqual([
      ["rp-001", "guardrail bullet did not stop recurrence"],
      ["rp-002", "fix is a multi-step procedure"],
    ]);
  });

  test("a page marked active that one reviewer on one PR wrote is not trusted, whatever its count", () => {
    const { ctx, ledger, root, write } = setup();
    write("rp-001", { count: 9, sources: "github", prs: "1", reviewers: "a" });
    expect(propose(ctx, ledger, root, 3)).toBe("nothing to promote");
    write("rp-001", { count: 9 });
    expect(propose(ctx, ledger, root, 3)).toBe("promoted rp-001 to guardrails");
  });

  test("a pattern already named as a skill candidate, or retired, is not a skill candidate again", () => {
    const { ledger, write } = setup();
    write("rp-001", { count: 5, promotedTo: "guardrails", promotedCount: 3, skillCandidate: "sk-001" });
    write("rp-002", { count: 5, promotedTo: "guardrails", promotedCount: 3, status: "retired" });
    write("rp-003", { count: 5, promotedTo: "guardrails", promotedCount: 3 });
    expect(skillCandidates(loadPatterns(ledger)).map((item) => item.pattern.id)).toEqual(["rp-003"]);
  });

  test("a dry run names what it would promote and writes nothing", () => {
    const { ledger, root, write } = setup();
    write("rp-001", { count: 3 });
    ledger.commit("seed");
    const head = ledger.head();
    const dry = testContext({ env: { AK_LEARN_DRY_RUN: "1" } });
    expect(propose(dry, ledger, root, 3)).toBe("dry run: would promote rp-001");
    expect(ledger.head()).toBe(head);
    expect(guardrails(ledger)).toBe("");
  });
});

describe("rollback, retire and promote by hand", () => {
  test("rollback restores guardrails byte for byte", () => {
    const { ctx, ledger, root, write } = setup();
    write("rp-001", { count: 3 });
    propose(ctx, ledger, root, 3);
    const before = readFileSync(ledger.path("guardrails.md"));
    write("rp-002", { count: 3 });
    propose(ctx, ledger, root, 3);
    expect(readFileSync(ledger.path("guardrails.md")).equals(before)).toBe(false);
    expect(rollback(ledger).startsWith("reverted 'propose: guardrails +rp-002'")).toBe(true);
    expect(readFileSync(ledger.path("guardrails.md")).equals(before)).toBe(true);
    expect(ledger.git(["log", "-1", "--format=%s"]).stdout.startsWith('Revert "propose: guardrails +rp-002')).toBe(
      true,
    );
  });

  test("rollback --to reverts every later commit, but the raw events stay append-only", () => {
    const { ctx, ledger, root, write } = setup();
    write("rp-001", { count: 3 });
    const base = ledger.commit("seed rp-001")!;
    const baseBytes = {
      guard: readFileSync(ledger.path("guardrails.md")),
      page: readFileSync(ledger.path("patterns", "rp-001.md")),
    };
    propose(ctx, ledger, root, 3);
    appendEvents(ledger, [
      makeEvent({
        source: "github",
        kind: "finding",
        project: "app",
        pr: 3,
        sha: null,
        author: "a",
        severity: null,
        path: null,
        line: null,
        text: "late",
        url: null,
        ts: null,
      }),
    ]);
    ledger.commit("ingest: +1 events");
    const message = rollback(ledger, base);
    expect(message).toBe("reverted 'ingest: +1 events', 'propose: guardrails +rp-001'");
    expect(readFileSync(ledger.path("guardrails.md")).equals(baseBytes.guard)).toBe(true);
    expect(readFileSync(ledger.path("patterns", "rp-001.md")).equals(baseBytes.page)).toBe(true);
    expect(loadEvents(ledger).map((event) => event.text)).toEqual(["late"]);
    expect(ledger.git(["status", "--porcelain"]).stdout.trim()).toBe("");
    expect(rollback(ledger, "not-a-revision")).toBe("unknown revision not-a-revision");
  });

  test("rollback --to over three commits that each appended raw events is all or nothing, in one commit", () => {
    const { ledger, write } = setup();
    write("rp-001", { count: 1 });
    writeFileSync(ledger.path(PROCESSED_FILE), "{}\n");
    const base = ledger.commit("seed rp-001")!;
    const before = readFileSync(ledger.path("patterns", "rp-001.md"));
    const guard = readFileSync(ledger.path("guardrails.md"));
    const texts = ["one", "two", "three"];
    texts.forEach((text, n) => {
      appendEvents(ledger, [
        makeEvent({
          source: "github",
          kind: "finding",
          project: "app",
          pr: n + 3,
          sha: null,
          author: "a",
          severity: null,
          path: null,
          line: null,
          text,
          url: null,
          ts: null,
        }),
      ]);
      write("rp-001", { count: n + 2 });
      write(`rp-00${n + 2}`, { count: 1 });
      writeFileSync(ledger.path("guardrails.md"), `- [rp-00${n + 1}] g${n + 1}\n`);
      writeFileSync(ledger.path(PROCESSED_FILE), `${JSON.stringify({ [`h${n}`]: ["rp-001"] })}\n`);
      appendFileSync(ledger.path("log.md"), `\n- run ${n + 1}\n`);
      ledger.commit(`ingest+maintain ${n + 1}`);
    });
    const commitsBefore = Number(ledger.git(["rev-list", "--count", "HEAD"]).stdout.trim());
    const raw = readFileSync(ledger.path(EVENTS_FILE));
    expect(rollback(ledger, base)).toBe("reverted 'ingest+maintain 3', 'ingest+maintain 2', 'ingest+maintain 1'");
    expect(readFileSync(ledger.path("patterns", "rp-001.md")).equals(before)).toBe(true);
    expect(readFileSync(ledger.path("guardrails.md")).equals(guard)).toBe(true);
    expect(readFileSync(ledger.path(PROCESSED_FILE), "utf8")).toBe("{}\n");
    expect([...loadPatterns(ledger).keys()]).toEqual(["rp-001"]);
    expect(readFileSync(ledger.path(EVENTS_FILE)).equals(raw)).toBe(true);
    expect(loadEvents(ledger).map((event) => event.text)).toEqual(texts);
    expect(readFileSync(ledger.path("log.md"), "utf8")).toContain("- run 3");
    expect(Number(ledger.git(["rev-list", "--count", "HEAD"]).stdout.trim())).toBe(commitsBefore + 1);
    expect(ledger.git(["status", "--porcelain"]).stdout.trim()).toBe("");
    expect(ledger.git(["diff", "--name-only", base, "HEAD"]).stdout.trim().split("\n")).toEqual([
      "log.md",
      EVENTS_FILE,
    ]);
  });

  test("rollback --to refuses a dirty wiki layer and a revision off the ledger's history, changing nothing", () => {
    const { ledger, write } = setup();
    write("rp-001", { count: 1 });
    const base = ledger.commit("seed rp-001")!;
    write("rp-001", { count: 2 });
    ledger.commit("maintain");
    const head = ledger.head();
    write("rp-001", { count: 9 });
    expect(rollback(ledger, base)).toBe("the ledger has uncommitted changes (patterns/rp-001.md); nothing was changed");
    expect(loadPatterns(ledger).get("rp-001")!.meta.count).toBe(9);
    ledger.commit("maintain again");
    const orphan = ledger.git(["commit-tree", "-m", "orphan", `${base}^{tree}`]).stdout.trim();
    expect(rollback(ledger, orphan)).toBe(`${orphan} is not an ancestor of the ledger's HEAD`);
    expect(ledger.git(["rev-parse", "HEAD~1"]).stdout.trim()).toBe(head!);
  });

  test("a pattern's id is its file name, whatever its frontmatter claims", () => {
    const { ledger, write } = setup();
    writeFileSync(
      ledger.path("patterns", "rp-001.md"),
      page("rp-001", { count: 3 }).replace("id: rp-001", "id: ../../escape"),
    );
    write("rp-002", { count: 1 });
    const patterns = loadPatterns(ledger);
    expect([...patterns.keys()]).toEqual(["rp-001", "rp-002"]);
    expect(patterns.get("rp-001")!.id).toBe("rp-001");
    expect(patterns.get("rp-001")!.meta.id).toBe("rp-001");
  });

  test("an unusable knowledgebase draft skips only its own proposal; every promotion still lands", () => {
    const { ctx, ledger, root, write } = setup();
    writeFileSync(
      ledger.path("patterns", "rp-001.md"),
      page("rp-001", { count: 3 }).replace("id: rp-001", "id: ../../escape"),
    );
    write("rp-1234567", { count: 3 });
    write("rp-003", { count: 3 });
    // The fixtures share one fix, so each later promotion lists the guardrails before it as resembling it.
    expect(propose(ctx, ledger, root, 3)).toBe(
      "promoted rp-001,rp-003,rp-1234567 to guardrails; similar rp-003 ~ rp-001 (0.75 active); " +
        "similar rp-1234567 ~ rp-001 (0.75 active), rp-003 (0.75 active)",
    );
    expect(guardrails(ledger)).toContain("- [rp-1234567] Do the one thing.");
    const drafts = readdirSync(ledger.path("proposals")).sort();
    expect(drafts).toEqual([
      `learn-${basename(root).toLowerCase()}-rp-001.json`,
      `learn-${basename(root).toLowerCase()}-rp-003.json`,
    ]);
    expect(readFileSync(ledger.path("log.md"), "utf8")).toContain("skipped knowledgebase draft for rp-1234567");
    expect(loadPatterns(ledger).get("rp-1234567")!.meta.promoted_to).toBe("guardrails");
  });

  test("retire removes the bullet and keeps the page", () => {
    const { ctx, ledger, root, write } = setup();
    write("rp-001", { count: 3 });
    propose(ctx, ledger, root, 3);
    expect(retire(ledger, "rp-001")).toBe("retired rp-001; guardrail bullet removed, pattern page kept");
    expect(guardrails(ledger)).toBe("");
    const pattern = loadPatterns(ledger).get("rp-001")!;
    expect(pattern.meta.status).toBe("retired");
    expect(pattern.body).toContain("## Evidence");
    expect(readFileSync(ledger.path("skill-impact.md"), "utf8")).toMatch(/\| retire \| rp-001 \|/);
    expect(propose(ctx, ledger, root, 3)).toBe("nothing to promote");
    expect(retire(ledger, "rp-404")).toBe("unknown pattern rp-404");
  });

  test("a human promotes one pattern whatever its count; retired and promoted patterns are refused", () => {
    const { ctx, ledger, root, write } = setup();
    write("rp-001", { count: 1, status: "candidate" });
    write("rp-002", { count: 3, status: "retired" });
    expect(promoteById(ctx, ledger, root, "rp-001")).toBe(
      "promoted rp-001 to guardrails; similar rp-001 ~ rp-002 (0.75 retired)",
    );
    expect(guardrails(ledger)).toBe("- [rp-001] Do the one thing.\n");
    expect(ledger.git(["log", "-1", "--format=%s"]).stdout.trim()).toBe("promote: guardrails +rp-001 (by hand)");
    expect(promoteById(ctx, ledger, root, "rp-001")).toBe("rp-001 is already promoted to guardrails");
    expect(promoteById(ctx, ledger, root, "rp-002")).toBe("rp-002 is retired");
    expect(promoteById(ctx, ledger, root, "rp-404")).toBe("unknown pattern rp-404");
  });
});

describe("team promotions and knowledgebase drafts", () => {
  test("a team target becomes one pending proposal, never applied by the runtime", () => {
    const { ctx, ledger, root, write } = setup();
    write("rp-001", { count: 3, teamTarget: "docs/review-checklist.md" });
    expect(propose(ctx, ledger, root, 3)).toBe("promoted rp-001 to guardrails; team proposals rp-001");
    const pending = pendingPromotions(ledger);
    expect(pending).toContain("## rp-001 → `docs/review-checklist.md`");
    expect(pending).toContain("Proposed line:\n\n- [rp-001] Do the one thing.");
    expect(pending).toMatch(/^applied: $/m);
    expect(existsSync(join(root, "docs"))).toBe(false);
  });

  test("a promotion proposes a schema-valid candidate lesson and records it in the ledger", () => {
    const root = gitRepo(join(scratch(), "my-app"));
    const { ctx, ledger, write } = setup(root);
    write("rp-001", { count: 3 });
    propose(ctx, ledger, root, 3);
    const record = JSON.parse(readFileSync(ledger.path("proposals", "learn-my-app-rp-001.json"), "utf8"));
    const draft = record.draft;
    expect(compileSchemas(REPO).validatorFor("lesson")!(draft)).toBe(true);
    expect(draft.status).toBe("candidate");
    expect(draft.created_by).toEqual({ role: "learn/pattern-maintainer" });
    expect(draft.trigger.kind).toBe("surprising-review-result");
    expect(draft.statement).toBe("Do the one thing.");
    expect(draft.source_revision.revision).toMatch(/^[0-9a-f]{40}$/);
    expect(draft.evidence).toEqual([
      {
        ref: "https://github.com/acme/app/pull/1#discussion_r9",
        kind: "url",
        note: "https://github.com/acme/app/pull/1#discussion_r9 (a P2 pr 1 2026-09-10)",
      },
      { ref: "review-ledger:obs:44", kind: "receipt", note: "obs:44 (b pr 2 2026-09-10)" },
    ]);
    expect(record.kb_ref).toBeUndefined();
  });

  test("inside a propose span the draft's run id is that span's id", () => {
    const { ctx, ledger, root, write } = setup();
    write("rp-001", { count: 3 });
    const pattern = loadPatterns(ledger).get("rp-001");
    if (pattern === undefined) throw new Error("expected rp-001");
    const runId = span(ctx, "review.propose", "cli", (inner) => {
      expect(guardrailDraft(inner, pattern, root, new Date("2026-09-24T10:00:00Z")).run_id).toBe(inner.span?.spanId);
      return inner.span?.spanId;
    });
    expect(runId).toMatch(/^[0-9a-f]{16}$/);
  });

  test("the draft carries the root cause as guidance and the day as its run id", () => {
    const { ctx, ledger, root, write } = setup();
    write("rp-001", { count: 3 });
    const pattern = loadPatterns(ledger).get("rp-001")!;
    const draft = guardrailDraft(ctx, pattern, root, new Date("2026-09-24T10:00:00Z"));
    expect(draft.guidance).toEqual(["R rp-001"]);
    expect(draft.run_id).toBe("learn-review-20260924");
    expect(draft.id).toBe(
      `learn-${basename(root)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")}-rp-001`,
    );
  });
});
