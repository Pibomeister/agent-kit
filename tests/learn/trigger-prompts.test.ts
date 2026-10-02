/**
 * The skill-routing prompt sets: shape, split and a leakage guard.
 *
 * A routing prompt that repeats its skill's description measures string matching, not routing.
 * The guard rejects any prompt sharing a word 4-gram with its skill's SKILL.md description or its
 * catalog summary (the text the roster shows). The threshold is zero shared 4-grams, not a
 * Jaccard cut: prompts run 10 to 40 words, so one shared 4-gram is already a lifted phrase, and a
 * ratio over sets that small moves more with prompt length than with copying. Shorter n-grams
 * are too strict to hold: "the pull request" or "a human" are ordinary English, and a user asking
 * for a skill's work will use its nouns. The typed `/ak:<id>` token is exempt: a prompt that
 * invokes a skill by its command has to name it, and the guard is about lifted prose.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadCatalog } from "../../src/catalog/load.ts";
import { frontmatter, oneLine } from "../../src/learn/skills/roster.ts";
import { type Case, expectsOf, parsePromptSet, startsWithSlash } from "./evals/trigger-eval.ts";

const REPO = resolve(import.meta.dir, "..", "..");
const PROMPTS = join(import.meta.dir, "evals", "prompts");
const load = (set: string) => parsePromptSet(readFileSync(join(PROMPTS, `${set}.json`), "utf8"), `trigger-${set}`);
const dev = load("dev");
const holdout = load("holdout");
const all: Case[] = [...dev.cases, ...holdout.cases];

const { catalog } = loadCatalog(REPO);
const entries = new Map((catalog?.bySection("skills") ?? []).map((e) => [e.id, e]));

function words(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+(?:'[a-z]+)?/g) ?? [];
}

/** The typed command a prompt may carry, removed before the overlap check. */
const withoutCommands = (text: string) => text.replace(/\/ak:[\w-]+/g, " ");

function ngrams(text: string, n = 4): Set<string> {
  const w = words(text);
  const out = new Set<string>();
  for (let i = 0; i + n <= w.length; i++) out.add(w.slice(i, i + n).join(" "));
  return out;
}

function shared(a: string, b: string, n = 4): string[] {
  const right = ngrams(b, n);
  return [...ngrams(a, n)].filter((g) => right.has(g));
}

function skillTexts(id: string): string[] {
  const description = oneLine(
    frontmatter(readFileSync(join(REPO, "skills", id, "SKILL.md"), "utf8")).description ?? "",
  );
  const summary = entries.get(id)?.raw.summary;
  return [description, typeof summary === "string" ? oneLine(summary) : ""];
}

describe("trigger prompt sets", () => {
  const skillsOf = (cls: "U" | "M") => [
    ...new Set(
      all
        .values()
        .filter((c) => c.invocation === cls)
        .map((c) => c.skill),
    ),
  ];
  const tally = (cases: Case[], skill: string) => {
    const mine = cases.filter((c) => c.skill === skill);
    return {
      load: mine.filter((c) => c.polarity === "positive" && c.expects === "load").length,
      recommend: mine.filter((c) => c.polarity === "positive" && c.expects === "recommend").length,
      proceed: mine.filter((c) => c.polarity === "positive" && c.expects === "proceed").length,
      negative: mine.filter((c) => c.polarity === "negative").length,
    };
  };

  test("both sets are versioned and carry an id", () => {
    for (const set of [dev, holdout]) {
      expect(set.version).toBeGreaterThanOrEqual(3);
      expect(set.id).toMatch(/^trigger-/);
      expect(set.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  test("100 prompts, 60 dev and 40 holdout", () => {
    expect(dev.cases).toHaveLength(60);
    expect(holdout.cases).toHaveLength(40);
    expect(all).toHaveLength(100);
  });

  test("ids and prompts are unique across both sets", () => {
    expect(new Set(all.map((c) => c.id)).size).toBe(all.length);
    expect(new Set(all.map((c) => c.prompt.toLowerCase())).size).toBe(all.length);
  });

  test("M skills: 2 load + 1 negative in dev, 1 + 1 in holdout", () => {
    expect(skillsOf("M")).toHaveLength(5);
    for (const skill of skillsOf("M")) {
      expect([skill, tally(dev.cases, skill)]).toEqual([skill, { load: 2, recommend: 0, proceed: 0, negative: 1 }]);
      expect([skill, tally(holdout.cases, skill)]).toEqual([skill, { load: 1, recommend: 0, proceed: 0, negative: 1 }]);
    }
  });

  test("U skills: 3 recommend + 1 hard negative in dev (five also typed), 2 + 1 in holdout", () => {
    expect(skillsOf("U")).toHaveLength(10);
    for (const skill of skillsOf("U")) {
      const d = tally(dev.cases, skill);
      expect([skill, d.recommend, d.negative, d.load]).toEqual([skill, 3, 1, 0]);
      expect([skill, d.proceed <= 1]).toEqual([skill, true]);
      expect([skill, tally(holdout.cases, skill)]).toEqual([skill, { load: 0, recommend: 2, proceed: 0, negative: 1 }]);
    }
    expect(dev.cases.filter((c) => c.expects === "proceed")).toHaveLength(5);
  });

  test("every skill is an authored catalog skill, with its class recorded correctly", () => {
    const classes = new Set<string>();
    for (const c of all) {
      const entry = entries.get(c.skill);
      expect(entry, c.id).toBeDefined();
      expect([c.id, entry!.status]).toEqual([c.id, "authored"]);
      expect([c.id, c.invocation]).toEqual([c.id, entry!.invocation!]);
      classes.add(c.invocation);
    }
    expect([...classes].sort()).toEqual(["M", "U"]);
  });

  test("every positive states `expects`, and it agrees with the class and the prompt", () => {
    for (const c of all.filter((x) => x.polarity === "positive")) {
      expect([c.id, c.expected]).toEqual([c.id, [c.skill]]);
      expect([c.id, c.forbidden]).toEqual([c.id, undefined]);
      expect([c.id, c.expects]).toEqual([c.id, expectsOf({ ...c, expects: undefined })]);
      expect([c.id, c.expects === "proceed"]).toEqual([c.id, startsWithSlash(c.prompt, c.skill)]);
    }
  });

  test("document-review prompts supply the document they ask the subject to compare", () => {
    const c = dev.cases.find((candidate) => candidate.id === "dev-doc-review-p2");
    expect(c?.prompt).toContain("# Rollout");
    expect(c?.prompt).toContain("# Risk controls");
    expect(c?.prompt).toContain("every account");
    expect(c?.prompt).toContain("only to internal accounts");
  });

  test("every negative carries a `forbidden` list with its own skill, all catalog skills", () => {
    for (const c of all.filter((x) => x.polarity === "negative")) {
      expect([c.id, c.expected, c.expects]).toEqual([c.id, [], undefined]);
      expect([c.id, c.forbidden?.includes(c.skill)]).toEqual([c.id, true]);
      for (const f of c.forbidden!) expect([c.id, entries.has(f)]).toEqual([c.id, true]);
    }
  });

  test("no negative and no model-invoked prompt names any catalog skill", () => {
    for (const c of all.filter((x) => x.polarity === "negative" || x.invocation === "M")) {
      for (const id of entries.keys())
        expect([c.id, id, new RegExp(`\\b${id}\\b`).test(c.prompt)]).toEqual([c.id, id, false]);
    }
  });

  test("leakage guard: no prompt shares a word 4-gram with its skill's description or summary", () => {
    const leaks: string[] = [];
    for (const c of all) {
      for (const text of skillTexts(c.skill)) {
        const hit = shared(withoutCommands(c.prompt), text);
        if (hit.length > 0) leaks.push(`${c.id}: ${hit.join(" | ")}`);
      }
    }
    expect(leaks).toEqual([]);
  });

  test("the guard catches a lifted phrase (positive control)", () => {
    const [description] = skillTexts("diagnose");
    const lifted = `Please ${words(description!).slice(10, 16).join(" ")} for the export job.`;
    expect(shared(lifted, description!).length).toBeGreaterThan(0);
  });

  test("the guard does not count the typed command, and still counts prose around it", () => {
    const [description] = skillTexts("diagnose");
    expect(
      shared(
        withoutCommands("/ak:super-align /ak:super-bound /ak:super-ship /ak:super-review"),
        "super align super bound super ship",
      ),
    ).toEqual([]);
    const lifted = `/ak:diagnose ${words(description!).slice(10, 16).join(" ")}`;
    expect(shared(withoutCommands(lifted), description!).length).toBeGreaterThan(0);
  });

  test("the candidate set still loads, every case with its draft and `expects: load`", () => {
    const candidate = load("candidate");
    expect(candidate.cases.length).toBeGreaterThan(0);
    for (const c of candidate.cases) expect([c.id, c.draft?.name, c.expects]).toEqual([c.id, c.skill, "load"]);
  });

  test("a legacy bare-array file still parses", () => {
    const legacy = parsePromptSet(JSON.stringify([{ arm: "catalog", prompt: "p", expected: ["diagnose"] }]), "old");
    expect(legacy.version).toBe(1);
    expect(legacy.cases[0]).toMatchObject({
      id: "old-1",
      skill: "diagnose",
      polarity: "positive",
      expected: ["diagnose"],
    });
  });
});
