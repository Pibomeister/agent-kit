/**
 * The grader-calibration driver's pure parts: stratified selection is seeded and takes rare strata
 * whole, stored runs load into a label file that round-trips, κ is assembled from labels and votes,
 * and grading spends nothing unless told to. Judges are stubbed, so no host CLI runs here.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildLabels,
  CRITERIA,
  gradeLabels,
  kappaReport,
  kindOf,
  type LabelFile,
  type LabelItem,
  loadRuns,
  main,
  parseArgs,
  readLabels,
  rescoreLabels,
  stratifiedSample,
  suggestedOf,
  tierOf,
  writeLabels,
} from "./evals/calibrate.ts";
import type { Matrix, Seat } from "./evals/matrix.ts";
import type { Judge } from "./evals/panel.ts";
import { type Case, parsePromptSet, type ScoreOptions, scoreCase } from "./evals/trigger-eval.ts";
import type { SessionEvent } from "./evals/subjects/types.ts";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "ak-calibrate-test-")));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const devText = readFileSync(join(import.meta.dir, "evals", "prompts", "dev.json"), "utf8");
const dev = parsePromptSet(devText, "trigger-dev");
const userInvoked = new Set(dev.cases.filter((c) => c.invocation === "U").map((c) => c.skill));
const scoring: ScoreOptions = { arm: "natural", userInvoked };
const prose = dev.cases.filter((c) => kindOf(c) === "user-prose");
const negative = dev.cases.find((c) => kindOf(c) === "model-negative")!;
const routed = dev.cases.find((c) => c.polarity === "positive" && c.invocation === "M")!;
const draftSkills = new Set(dev.cases.flatMap((c) => (c.draft === undefined ? [] : [c.draft.name])));
const bundledSkills = [...new Set(dev.cases.flatMap((c) => [c.skill, ...c.expected]).filter((skill) => !draftSkills.has(skill)))].sort();

describe("stratifiedSample", () => {
  const rows = [
    ...Array.from({ length: 2 }, (_, i) => ({ id: `rare-${i}`, stratum: "violated/p1", case: `c-rare-${i}` })),
    ...Array.from({ length: 50 }, (_, i) => ({ id: `big-a-${i}`, stratum: "missed/p1", case: `c-a-${i % 5}` })),
    ...Array.from({ length: 50 }, (_, i) => ({ id: `big-b-${i}`, stratum: "recommended/p2", case: `c-b-${i % 5}` })),
  ];

  test("a stratum smaller than its share is taken whole and the rest split the remaining slots", () => {
    const { picked, strata } = stratifiedSample(rows, 20, 7);
    expect(picked).toHaveLength(20);
    expect(strata).toEqual({ "missed/p1": { available: 50, taken: 9 }, "recommended/p2": { available: 50, taken: 9 }, "violated/p1": { available: 2, taken: 2 } });
    expect(picked.filter((r) => r.stratum === "violated/p1").map((r) => r.id).sort()).toEqual(["rare-0", "rare-1"]);
  });

  test("the same seed picks the same rows in the same order, whatever order the rows came in", () => {
    const once = stratifiedSample(rows, 20, 7).picked.map((r) => r.id);
    expect(stratifiedSample([...rows].reverse(), 20, 7).picked.map((r) => r.id)).toEqual(once);
    expect(stratifiedSample(rows, 20, 8).picked.map((r) => r.id)).not.toEqual(once);
  });

  test("distinct cases are taken before a second replicate of any one case", () => {
    const skewed = [
      ...Array.from({ length: 20 }, (_, i) => ({ id: `x-${i}`, stratum: "missed/p1", case: "case-x" })),
      { id: "y-0", stratum: "missed/p1", case: "case-y" },
      { id: "z-0", stratum: "missed/p1", case: "case-z" },
    ];
    for (const seed of [1, 2, 3]) expect(new Set(stratifiedSample(skewed, 3, seed).picked.map((r) => r.case))).toEqual(new Set(["case-x", "case-y", "case-z"]));
  });

  test("asking for more than there is takes everything", () => {
    expect(stratifiedSample(rows, 500, 1).picked).toHaveLength(rows.length);
  });
});

describe("classification", () => {
  test("keeps user-invoked prose cases and model-invoked negatives, and nothing the heuristics do not decide", () => {
    expect(kindOf(prose[0]!)).toBe("user-prose");
    expect(kindOf(negative)).toBe("model-negative");
    expect(kindOf(routed)).toBeNull();
    expect(tierOf("dev-compound-p3")).toBe("p3");
    expect(tierOf("dev-diagnose-n1")).toBe("n1");
    expect(tierOf("legacy")).toBe("other");
  });

  test("the scorer's outcome maps onto the criteria, abstaining where a delegating call followed the load", () => {
    const c = prose.find((x) => x.expected.length === 1)!;
    const skill = c.expected[0]!;
    const load: SessionEvent = { kind: "tool", name: "Skill", raw: "Skill", input: { skill: `ak:${skill}` } };
    const quiet = scoreCase(c, [load], "Here is what I found.", scoring);
    expect(quiet.outcome).toBe("loaded-unclear");
    expect(suggestedOf(quiet).verdict).toBe("PASS");
    const delegated = scoreCase(c, [load, { kind: "tool", name: "Agent", raw: "Agent", input: {} }], "Done.", scoring);
    expect(suggestedOf(delegated)).toMatchObject({ outcome: "loaded-unclear", verdict: null });
    const wrote = scoreCase(c, [load, { kind: "tool", name: "Write", raw: "Write", input: { file_path: "x" } }], "Done.", scoring);
    expect(suggestedOf(wrote)).toMatchObject({ outcome: "violated", verdict: "FAIL" });
    expect(suggestedOf(scoreCase(c, [], "Nothing to do.", scoring))).toMatchObject({ outcome: "missed", verdict: "FAIL" });
  });
});

/** A stored run: a receipt with every case's reply, and a dump for the one session that loaded a skill. */
function storedRun(): { receipt: string; copy: string; dumpDir: string; loadedCase: Case } {
  const loadedCase = prose.find((x) => x.expected.length === 1)!;
  const quietCase = prose.find((x) => x.id !== loadedCase.id && !x.prompt.includes("/ak:"))!;
  const brokenCase = prose.find((x) => x.id !== loadedCase.id && x.id !== quietCase.id)!;
  const runs = join(scratch, "runs");
  const dumpDir = join(runs, "r-t");
  mkdirSync(join(dumpDir, "subject-a"), { recursive: true });
  const events: SessionEvent[] = [
    { kind: "tool", name: "Skill", raw: "Skill", input: { skill: `ak:${loadedCase.expected[0]}` } },
    { kind: "tool", name: "Write", raw: "Write", input: { file_path: "notes.md" } },
  ];
  writeFileSync(join(dumpDir, "subject-a", `${loadedCase.id}.json`), JSON.stringify({ case: loadedCase, scored: {}, reply: "Written.", events }));
  writeFileSync(join(dumpDir, "subject-a", "index.json"), JSON.stringify({ fired: 1 }));
  const result = (c: Case, reply: string, loaded: string[], extra: Record<string, unknown> = {}) => ({ id: c.id, loaded, reply, timed_out: false, exit_code: 0, ...extra });
  const receipt = {
    receipt: {
      prompt_set: "trigger-dev",
      prompt_set_sha256: dev.sha256,
      arm: "natural",
      bundle: "on",
      bundle_complete: bundledSkills,
      argv: ["bun", "trigger-eval.ts", "--json", "runs/r.json", "--dump-transcripts", "runs/r-t"],
    },
    subjects: [
      {
        subject: "subject-a",
        host: "codex",
        results: [
          result(loadedCase, "Written.", [loadedCase.expected[0]!]),
          result(quietCase, `Only you can start this: please type /ak:${quietCase.expected[0]} yourself.`, []),
          result(negative, "Here is the answer.", []),
          result(routed, "Loaded it.", [routed.skill]),
          result(brokenCase, "", [], { exit_code: 1 }),
        ],
      },
    ],
  };
  const file = join(runs, "r.json");
  writeFileSync(file, JSON.stringify(receipt));
  // A rescored copy keeps the original's argv, so it names the same sessions.
  const copy = join(runs, "r.rescored.json");
  writeFileSync(copy, JSON.stringify(receipt));
  return { receipt: file, copy, dumpDir, loadedCase };
}

function receiptVariant(source: string, name: string, change: (receipt: Record<string, unknown>) => Record<string, unknown>): string {
  const complete = JSON.parse(readFileSync(source, "utf8")) as { receipt: Record<string, unknown> };
  const file = join(scratch, "eligibility", `${name}.json`);
  mkdirSync(join(scratch, "eligibility"), { recursive: true });
  writeFileSync(file, JSON.stringify({ ...complete, receipt: change(complete.receipt) }));
  return file;
}

describe("loading stored runs and the label file", () => {
  test("a bundle-off receipt produces no candidates", () => {
    const run = storedRun();
    const bundleOff = receiptVariant(run.receipt, "bundle-off", ({ bundle_complete: _, ...receipt }) => ({ ...receipt, bundle: "off" }));
    const loaded = loadRuns([bundleOff], scoring);
    expect(loaded.candidates).toEqual([]);
    expect(loaded.skipped).toEqual({ "bundle was not on": 5 });
  });

  test("a legacy or incomplete bundle-on receipt produces no candidates", () => {
    const run = storedRun();
    const legacyBundleOn = receiptVariant(run.receipt, "legacy-bundle-on", ({ bundle_complete: _, ...receipt }) => ({ ...receipt, bundle: "on" }));
    const incompleteBundle = receiptVariant(run.receipt, "incomplete-bundle", (receipt) => ({ ...receipt, bundle_complete: bundledSkills.slice(1) }));
    const legacy = loadRuns([legacyBundleOn], scoring);
    expect(legacy.candidates).toEqual([]);
    expect(legacy.skipped).toEqual({ "bundle completeness was not recorded": 5 });
    const incomplete = loadRuns([incompleteBundle], scoring);
    expect(incomplete.candidates).toEqual([]);
    expect(incomplete.skipped).toEqual({ [`bundle completeness does not cover the prompt set (${bundledSkills[0]})`]: 5 });
    for (const inputs of [[legacyBundleOn, incompleteBundle, run.receipt], [run.receipt, incompleteBundle, legacyBundleOn]]) {
      const mixed = loadRuns(inputs, scoring);
      expect(mixed.candidates).toHaveLength(3);
      expect(mixed.skipped).toEqual({ "not decided by the heuristic graders": 1, "invalid session (exit 1)": 1 });
    }
  });

  test("a receipt that recorded absolute run paths still owns its dump", () => {
    const run = storedRun();
    const absolute = receiptVariant(run.receipt, "absolute-paths", (receipt) => ({
      ...receipt,
      argv: ["bun", "trigger-eval.ts", "--json", run.receipt, "--dump-transcripts", run.dumpDir],
    }));
    const loaded = loadRuns([run.dumpDir, absolute], scoring);
    expect(loaded.candidates).toHaveLength(3);
    expect(loaded.candidates.find((c) => c.case.id === run.loadedCase.id)!.events).toHaveLength(2);
  });

  test("a transcript dump without its eligible owning receipt is refused", () => {
    const run = storedRun();
    expect(() => loadRuns([run.dumpDir], scoring)).toThrow(/eligible owning receipt/);
  });

  test("a receipt joins its dump, counts each session once, and keeps only the rows the heuristics decide", () => {
    const run = storedRun();
    const loaded = loadRuns([run.dumpDir, run.receipt, run.copy], scoring);
    expect(loaded.candidates).toHaveLength(3);
    expect(loaded.skipped).toEqual({ "not decided by the heuristic graders": 1, "invalid session (exit 1)": 1 });
    const dumped = loaded.candidates.find((c) => c.case.id === run.loadedCase.id)!;
    expect(dumped).toMatchObject({ host: "codex", subject: "subject-a" });
    expect(dumped.events).toHaveLength(2);
    expect(dumped.scored.outcome).toBe("violated");
    const quiet = loaded.candidates.filter((c) => c.events === null).map((c) => c.scored.outcome).sort();
    expect(quiet).toEqual(["held", "recommended"]);
  });

  test("the label file carries the scorer's suggestion and an empty label, and survives a write and read unchanged", () => {
    const run = storedRun();
    const sources = [run.receipt];
    const labels = buildLabels(loadRuns(sources, scoring), { n: 80, seed: 1, sources });
    expect(labels.criteria).toBe(CRITERIA);
    expect(labels.items).toHaveLength(3);
    for (const item of labels.items) {
      expect(item).toMatchObject({ label: null, note: "" });
      expect(item.id).toMatch(/^[0-9a-f]{12}$/);
      expect(item.transcript).toContain(`[prompt] ${item.prompt}`);
    }
    const violated = labels.items.find((i) => i.stratum.startsWith("violated/"))!;
    expect(violated).toMatchObject({ events_recorded: true, suggested: { verdict: "FAIL", outcome: "violated" }, kind: "user-prose" });
    expect(violated.transcript).toContain("[tool Write]");
    const held = labels.items.find((i) => i.kind === "model-negative")!;
    expect(held).toMatchObject({ stratum: "held-quiet/n1", events_recorded: false, suggested: { verdict: "PASS" } });
    expect(held.transcript).toContain("[tool calls] not recorded");
    const file = join(scratch, "round-trip", "labels.json");
    writeLabels(file, labels);
    expect(readLabels(file)).toEqual(labels);
    expect(buildLabels(loadRuns(sources, scoring), { n: 80, seed: 1, sources }).items.map((i) => i.id)).toEqual(labels.items.map((i) => i.id));
  });

  test("a label other than PASS, FAIL or null is refused on read", () => {
    const file = join(scratch, "bad-label.json");
    const labels: LabelFile = { version: 1, criteria: CRITERIA, seed: 1, target: 1, sources: [], strata: {}, skipped: {}, items: [item("a", { label: "pass" as unknown as "PASS" })] };
    writeFileSync(file, JSON.stringify(labels));
    expect(() => readLabels(file)).toThrow(/label must be PASS, FAIL or null/);
  });
});

function item(id: string, fields: Partial<LabelItem> = {}): LabelItem {
  return {
    id,
    source: `run#subject-a/${id}`,
    subject: "subject-a",
    host: "claude",
    case: `dev-x-${id}`,
    skill: "x",
    kind: "user-prose",
    tier: "p1",
    stratum: "missed/p1",
    prompt: "p",
    events_recorded: false,
    transcript: `[case] ${id}`,
    suggested: { verdict: "PASS", outcome: "recommended", reason: "recommended" },
    label: null,
    note: "",
    ...fields,
  };
}

const fileOf = (items: LabelItem[]): LabelFile => ({ version: 1, criteria: CRITERIA, seed: 1, target: items.length, sources: [], strata: {}, skipped: {}, items });

describe("kappaReport", () => {
  const s = (verdict: "PASS" | "FAIL" | null) => ({ verdict, outcome: "recommended" as const, reason: "" });

  test("human-anchored κ over labelled items; reviewer pairs and the scorer against each reviewer over every item both rated", () => {
    const labels = fileOf([
      item("1", { label: "PASS", suggested: s("PASS"), votes: { "reviewer-b": "PASS", "reviewer-c": "PASS" } }),
      item("2", { label: "PASS", suggested: s("FAIL"), votes: { "reviewer-b": "PASS", "reviewer-c": "FAIL" } }),
      item("3", { label: "FAIL", suggested: s("FAIL"), votes: { "reviewer-b": "FAIL", "reviewer-c": "FAIL" } }),
      item("4", { label: "FAIL", suggested: s(null), votes: { "reviewer-b": "FAIL", "reviewer-c": "invalid" } }),
      item("5", { label: null, suggested: s("PASS"), votes: { "reviewer-b": "FAIL", "reviewer-c": "PASS" } }),
    ]);
    const report = kappaReport(labels);
    expect(report).toMatchObject({ items: 5, labelled: 4, bar: 0.6 });
    // reviewer-c's invalid vote and the scorer's abstention drop item 4 from their rows; item 5 is unlabelled.
    const [b, c] = report.reviewer_vs_human;
    expect(report.reviewer_vs_human.map((r) => [r.a, r.b, r.n])).toEqual([["reviewer-b", "human", 4], ["reviewer-c", "human", 3]]);
    expect(b!.kappa).toBe(1);
    expect(c!.kappa).toBeCloseTo(0.4, 10);
    expect(report.scorer_vs_human).toMatchObject({ a: "scorer", b: "human", n: 3 });
    expect(report.scorer_vs_human!.kappa).toBeCloseTo(0.4, 10);
    // Item 5 counts here although no human labelled it: b and c agree on 1 and 3 only, so κ is 0.
    expect(report.reviewer_pairs.map((r) => [r.a, r.b, r.n, r.kappa])).toEqual([["reviewer-b", "reviewer-c", 4, 0]]);
    expect(report.scorer_vs_reviewers.map((r) => [r.a, r.b, r.n])).toEqual([["scorer", "reviewer-b", 4], ["scorer", "reviewer-c", 4]]);
    expect(report.scorer_vs_reviewers[1]!.kappa).toBe(1);
  });

  test("with nothing labelled the human rows have n 0 and no κ, and the reviewer and scorer rows still count", () => {
    const report = kappaReport(
      fileOf([
        item("1", { suggested: s("PASS"), votes: { "reviewer-b": "PASS", "reviewer-c": "PASS" } }),
        item("2", { suggested: s("FAIL"), votes: { "reviewer-b": "FAIL", "reviewer-c": "FAIL" } }),
        item("3", { suggested: s("PASS"), votes: { "reviewer-b": "FAIL", "reviewer-c": "FAIL" } }),
      ]),
    );
    expect(report.labelled).toBe(0);
    expect(report.reviewer_vs_human).toEqual([
      { a: "reviewer-b", b: "human", n: 0, kappa: null },
      { a: "reviewer-c", b: "human", n: 0, kappa: null },
    ]);
    expect(report.scorer_vs_human).toEqual({ a: "scorer", b: "human", n: 0, kappa: null });
    expect(report.reviewer_pairs).toEqual([{ a: "reviewer-b", b: "reviewer-c", n: 3, kappa: 1 }]);
    expect(report.scorer_vs_reviewers.map((r) => [r.b, r.n])).toEqual([["reviewer-b", 3], ["reviewer-c", 3]]);
    for (const r of report.scorer_vs_reviewers) expect(r.kappa).toBeCloseTo(0.4, 10);
  });
});

describe("rescoreLabels", () => {
  test("re-applies the current scorer to each item's stored session and names what changed", () => {
    const run = storedRun();
    const sources = [run.receipt];
    const labels = buildLabels(loadRuns(sources, scoring), { n: 80, seed: 1, sources });
    const current = labels.items.map((i) => i.suggested);
    // As an older scorer might have written it: the recommendation read as a miss.
    const stale = labels.items.find((i) => i.suggested.outcome === "recommended")!;
    stale.suggested = { verdict: "FAIL", outcome: "missed", reason: "missed" };
    stale.votes = { "reviewer-b": "PASS" };
    const orphan = item("gone", { source: join(scratch, "runs", "gone.json#subject-a/x") });
    labels.items.push(orphan);
    const result = rescoreLabels(labels, loadRuns(sources, scoring));
    expect(result.changed).toEqual([{ id: stale.id, from: { verdict: "FAIL", outcome: "missed", reason: "missed" }, to: current[labels.items.indexOf(stale)]! }]);
    expect(result.missing).toEqual(["gone"]);
    expect(result.labels.items.slice(0, -1).map((i) => i.suggested)).toEqual(current);
    // Votes, labels and the orphan are left alone, and the input is not mutated.
    expect(result.labels.items.find((i) => i.id === stale.id)!.votes).toEqual({ "reviewer-b": "PASS" });
    expect(result.labels.items.at(-1)).toEqual(orphan);
    expect(stale.suggested.outcome).toBe("missed");
  });

  test("the rescore command reads the default label file when given only --out, and writes nowhere else", async () => {
    const run = storedRun();
    const sources = [run.receipt];
    const labelsFile = join(scratch, "rescore-cli", "labels.json");
    writeLabels(labelsFile, buildLabels(loadRuns(sources, scoring), { n: 80, seed: 1, sources }));
    const before = readFileSync(labelsFile, "utf8");
    const out = join(scratch, "rescore-cli", "labels.fixed.json");
    expect(await main(["rescore", "--out", out], labelsFile)).toBe(0);
    expect(readLabels(out).items.map((i) => i.id)).toEqual(readLabels(labelsFile).items.map((i) => i.id));
    expect(readFileSync(labelsFile, "utf8")).toBe(before);
  });
});

describe("gradeLabels", () => {
  const seat = (id: string, host: Seat["host"], model: string): Seat => ({ id, host, model });
  const matrix: Matrix = {
    subjects: [{ id: "subject-a", host: "claude", model: "bind-1" }],
    reviewers: [seat("reviewer-a", "claude", "bind-1"), seat("reviewer-b", "codex", "bind-2"), seat("reviewer-c", "grok", "bind-3")],
    panels: { "independent-of": "subject", "min-reviewers": 2 },
  };
  const counting = () => {
    const calls: string[] = [];
    const judge: Judge = async (reviewer) => {
      calls.push(reviewer.id);
      return '{"verdict":"PASS","reason":"stubbed"}';
    };
    return { calls, judge };
  };

  test("without spend it judges nothing, leaves the file byte for byte, and reports the seats and the calls a run would make", async () => {
    const file = join(scratch, "dry", "labels.json");
    writeLabels(file, fileOf([item("1"), item("2"), item("3")]));
    const before = readFileSync(file, "utf8");
    const { calls, judge } = counting();
    const run = await gradeLabels(file, { matrix, spend: false, judge });
    expect(calls).toEqual([]);
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(run).toMatchObject({ spent: false, calls: 0, graded: 0 });
    expect(run.plan.calls).toBe(6);
    const [panel] = run.plan.panels;
    expect(panel!.members.map((m) => m.id)).toEqual(["reviewer-b", "reviewer-c"]);
    expect(panel!.seats[0]).toMatchObject({ status: "unavailable", reason: "bound like subject subject-a" });
  });

  test("a subject missing from the matrix is its host's default binding, which refuses every reviewer on that host", async () => {
    const file = join(scratch, "default", "labels.json");
    writeLabels(file, fileOf([item("1", { subject: "subject-default", host: "codex" })]));
    const run = await gradeLabels(file, { matrix, spend: false });
    expect(run.plan.resolved).toEqual({ "subject-default": "host default" });
    expect(run.plan.panels[0]!.seats.find((s) => s.reviewer.id === "reviewer-b")).toMatchObject({ status: "unavailable", reason: "subject subject-default runs the codex default binding" });
    expect(run.plan.panels[0]!.members.map((m) => m.id)).toEqual(["reviewer-a", "reviewer-c"]);
    expect(run.plan.calls).toBe(2);
  });

  test("with spend it stops before max-calls would be passed, keeps the human's label, and does not regrade", async () => {
    const file = join(scratch, "spend", "labels.json");
    writeLabels(file, fileOf([item("1", { label: "FAIL" }), item("2"), item("3")]));
    const { calls, judge } = counting();
    const run = await gradeLabels(file, { matrix, spend: true, maxCalls: 5, judge, queue: join(scratch, "spend", "q.jsonl") });
    expect(run).toMatchObject({ spent: true, calls: 4, graded: 2, deferred: 1 });
    expect(calls).toHaveLength(4);
    const after = readLabels(file);
    expect(after.items[0]).toMatchObject({ label: "FAIL", votes: { "reviewer-b": "PASS", "reviewer-c": "PASS" }, panel_verdict: "PASS", graded_as: "subject-a" });
    expect(after.items[2]!.votes).toBeUndefined();
    const again = await gradeLabels(file, { matrix, spend: false });
    expect(again.plan.pending).toEqual({ "subject-a": [after.items[2]!.id] });
  });

  test("an invalid vote counts as graded unless --retry-invalid, which regrades only that seat, within max-calls", async () => {
    const graded = { graded_as: "subject-a", panel_verdict: "needs-human" as const, reasons: { "reviewer-b": "no reply", "reviewer-c": "ok" } };
    const file = join(scratch, "retry", "labels.json");
    writeLabels(
      file,
      fileOf([
        item("1", { ...graded, label: "PASS", votes: { "reviewer-b": "invalid", "reviewer-c": "PASS" } }),
        item("2", { ...graded, votes: { "reviewer-b": "invalid", "reviewer-c": "invalid" } }),
        item("3", { ...graded, votes: { "reviewer-b": "PASS", "reviewer-c": "PASS" } }),
      ]),
    );
    const queue = join(scratch, "retry", "q.jsonl");

    const plain = counting();
    const without = await gradeLabels(file, { matrix, spend: true, judge: plain.judge, queue });
    expect(plain.calls).toEqual([]);
    expect(without).toMatchObject({ calls: 0, graded: 0, plan: { calls: 0, pending: { "subject-a": [] } } });

    const dry = await gradeLabels(file, { matrix, spend: false, retryInvalid: true });
    expect(dry.plan).toMatchObject({ calls: 3, pending: { "subject-a": ["1", "2"] } });

    const retrying = counting();
    const run = await gradeLabels(file, { matrix, spend: true, retryInvalid: true, maxCalls: 2, judge: retrying.judge, queue });
    expect(retrying.calls).toEqual(["reviewer-b"]);
    expect(run).toMatchObject({ calls: 1, graded: 1, deferred: 1 });
    const after = readLabels(file);
    expect(after.items[0]).toMatchObject({
      label: "PASS",
      votes: { "reviewer-b": "PASS", "reviewer-c": "PASS" },
      reasons: { "reviewer-b": "stubbed", "reviewer-c": "ok" },
      panel_verdict: "PASS",
    });
    expect(after.items[1]!.votes).toEqual({ "reviewer-b": "invalid", "reviewer-c": "invalid" });
    const again = await gradeLabels(file, { matrix, spend: false, retryInvalid: true });
    expect(again.plan).toMatchObject({ calls: 2, pending: { "subject-a": ["2"] } });
  });
});

describe("parseArgs", () => {
  test("grade spends only with --spend, and --max-calls without it is refused rather than ignored", () => {
    const dry = parseArgs(["grade", "--subject", "subject-a"]);
    expect("problems" in dry ? dry.problems : [...dry.switches]).toEqual([]);
    expect(parseArgs(["grade", "--max-calls", "10"])).toEqual({ problems: ["--max-calls bounds a spending run; it means nothing without --spend"] });
    const spend = parseArgs(["grade", "--spend", "--max-calls", "10"]);
    expect("problems" in spend ? spend.problems : [...spend.switches]).toEqual(["--spend"]);
  });

  test("an unknown flag, a missing value, a bad number or a missing source is an error", () => {
    expect(parseArgs(["grade", "--spend", "--retry-invalid"])).toMatchObject({ switches: new Set(["--spend", "--retry-invalid"]) });
    expect(parseArgs(["grade", "--spnd"])).toEqual({ problems: ["grade does not take --spnd"] });
    expect(parseArgs(["sample", "--from"])).toEqual({ problems: ["--from needs a value", "sample needs at least one --from"] });
    expect(parseArgs(["sample", "--from", "a", "--n", "eighty"])).toEqual({ problems: ["--n must be a whole number, not eighty"] });
    expect(parseArgs(["label"])).toEqual({ problems: ['the first argument must be sample, grade, kappa or rescore, not "label"'] });
    expect(parseArgs(["rescore", "--file", "a.json", "--out", "b.json"])).toMatchObject({ command: "rescore", values: { "--file": ["a.json"], "--out": ["b.json"] } });
    expect(parseArgs(["rescore", "--spend"])).toEqual({ problems: ["rescore does not take --spend"] });
    const ok = parseArgs(["sample", "--from", "a", "--from", "b"]);
    expect("problems" in ok ? ok.problems : ok.values["--from"]).toEqual(["a", "b"]);
  });
});
