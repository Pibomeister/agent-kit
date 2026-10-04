/**
 * The eval harness types and grades in the form of the bundle each host installs (ADR-0009).
 * Offline: no session runs here.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { startsFor, startVocabulary } from "./evals/explicit-start.ts";
import { type Case, expectsOf, parsePromptSet, type ScoreOptions, scoreCase } from "./evals/trigger-eval.ts";

const U = ["compound", "super-align"];
const codex = startVocabulary("codex", "/ak:", U);
const claude = startVocabulary("claude-code", "/ak:", U);

describe("the prompt a host is sent", () => {
  test("a typed U command is sent in the form the host's bundle gates on", () => {
    expect(codex.typed("/ak:super-align settle the cache design")).toBe("$ak:super-align settle the cache design");
    expect(claude.typed("/ak:super-align settle the cache design")).toBe("/ak:super-align settle the cache design");
  });

  test("a longer id, an M command and prose are sent as written", () => {
    const prose = "Run /ak:compound-refresh, then /ak:super-scout, then align the team on the design.";
    expect(codex.typed(prose)).toBe(prose);
  });

  test("every typed case in the committed sets opens with the installed bundle's start, the file unchanged", () => {
    for (const set of ["dev", "holdout"]) {
      const file = join(import.meta.dir, "evals", "prompts", `${set}.json`);
      const before = readFileSync(file, "utf8");
      const typed = parsePromptSet(before, `trigger-${set}`).cases.filter((c) => expectsOf(c) === "proceed");
      for (const c of typed) {
        expect(`${c.id}: ${startsFor("codex").typed(c.prompt).startsWith(`$ak:${c.skill}`)}`).toBe(`${c.id}: true`);
        expect(`${c.id}: ${startsFor("claude").typed(c.prompt)}`).toBe(`${c.id}: ${c.prompt}`);
        expect(`${c.id}: ${startsFor("grok").typed(c.prompt)}`).toBe(`${c.id}: ${c.prompt}`);
      }
      expect(readFileSync(file, "utf8")).toBe(before);
    }
  });
});

describe("the reply the graders read", () => {
  const prose: Case = {
    id: "align-prose",
    skill: "super-align",
    polarity: "positive",
    invocation: "U",
    prompt: "We need to agree what the cache should do before anyone builds it.",
    expected: ["super-align"],
  };
  const scoring: ScoreOptions = { arm: "natural", userInvoked: new Set(U) };
  const native = "That is alignment work, which only you can start. Type `$ak:super-align` followed by your request.";
  const canonical =
    "That is alignment work, which only you can start. Type `/ak:super-align` followed by your request.";

  test("a Codex reply that names the Codex start is a recommendation", () => {
    const scored = scoreCase(prose, [], codex.canonical(native), scoring);
    expect(scored.recommended).toBe(true);
    expect(scored.pass).toBe(true);
  });

  test("a Codex reply that names the command its bundle refuses is not", () => {
    const scored = scoreCase(prose, [], codex.canonical(canonical), scoring);
    expect(scored.recommended).toBe(false);
    expect(scored.pass).toBe(false);
  });

  test("a Claude Code reply is read as written, so the Codex start does not pass there", () => {
    expect(claude.canonical(canonical)).toBe(canonical);
    expect(scoreCase(prose, [], claude.canonical(canonical), scoring).pass).toBe(true);
    expect(scoreCase(prose, [], claude.canonical(native), scoring).pass).toBe(false);
  });

  test("another skill's start and a longer id keep their own meaning", () => {
    expect(codex.canonical("I ran `$ak:compound`; `$ak:compound-refresh` is separate.")).toBe(
      "I ran `/ak:compound`; `$ak:compound-refresh` is separate.",
    );
  });
});
