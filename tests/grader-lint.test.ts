/**
 * Eval graders that cannot fail (AUTHORING.md §9).
 *
 * Two halves, one per kind of grader:
 *
 * - `llm` graders are judged by a model, so no local transcript can score
 *   them. They are covered by the surface lint (`graders.ts`, checks
 *   `evals.llm-file-claim-without-focus` and
 *   `evals.llm-action-claim-without-focus`), NOT by the mutation test below:
 *   the lint fails a file or action claim that the host would score against
 *   the last message.
 * - Deterministic graders (`tool_used`, `tool_order`, `file_exists`, `regex`)
 *   are mutation-tested: for every one in the corpus the test builds a
 *   transcript the grader must fail, and a transcript it must pass where one
 *   can be built, and scores both with the local evaluator in `grader-eval.ts`.
 *   A grader that passes its own failing transcript measures nothing.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Glob } from "bun";
import { parse as parseYaml } from "yaml";

import type { Catalog } from "../src/catalog/load.ts";
import {
  DETERMINISTIC_TYPES,
  callMatches,
  evaluate,
  globToRegExp,
  type Grader,
  type ToolCall,
  type Transcript,
} from "../src/validation/grader-eval.ts";
import { actionClaim, checkGraderSurfaces, fileClaim, unaimedClaims } from "../src/validation/graders.ts";
import { makeTree } from "./helpers/tree.ts";

const ROOT = join(import.meta.dir, "..");

/** The surface check reads only the tree, so the catalog is not consulted. */
const at = (root: string) => ({ root, catalog: {} as Catalog });

const EMPTY: Transcript = { toolCalls: [], lastMessage: "", filesCreated: [] };

describe("fileClaim", () => {
  test.each([
    "No file is created in the working repository.",
    "The run does not edit any file under src/.",
    "Nothing is written to disk.",
    "It stages only the paths it owns; the unrelated file is not staged.",
    "No directory is removed.",
  ])("finds the claim in %p", (criteria) => {
    expect(fileClaim(criteria)).not.toBeNull();
  });

  test.each([
    "The reply names the file extensions it would accept.",
    "The response covers the happy path and one failure.",
    "The run creates one ticket and records its id.",
    "It names the missing knowledgebase adapter.",
  ])("does not flag %p", (criteria) => {
    expect(fileClaim(criteria)).toBeNull();
  });

  test("needs both halves in one sentence", () => {
    expect(fileClaim("The reply names the file. It creates a ticket.")).toBeNull();
  });
});

describe("actionClaim", () => {
  test.each([
    "The run does not publish it a second time.",
    "No second record is published.",
    "The supersession is published at most once.",
    "The report is published once.",
    "The run does not post them a second time.",
    "A thread that already carries this run's reply is not replied to again.",
    "No implementer is dispatched for AK-701, and their receipts are not re-run merely to confirm them.",
    "Exactly one branch exists at the end, and no duplicate is opened.",
    "The session does not dispatch another fix round.",
    "It must never push to the default branch.",
    "Nothing is deleted.",
    // The passive shape alone.
    "The page is not published.",
    "The lesson is never deleted.",
    "Their receipts are not re-run.",
    // Forms the auxiliary list once missed.
    "The run won't merge the pull request.",
    "The session cannot publish the page.",
    "The skill never publishes a draft.",
    "Only one pull request is created.",
    "At most one comment is posted.",
    "The run does not reopen the ticket.",
    "The run does not re-open the ticket.",
    "It resumes rather than cutting a second ticket.",
    "It reads the record back rather than publishing a second page.",
    // "record … as" is an idiom only for opinions.
    "The case is not recorded as passing.",
    "The run does not record the finding as fixed.",
    // Idiom lookaheads that must not swallow the action.
    "The fix does not write off-by-one guards into the parser.",
    "The run does not call them a second time.",
    "The run does not start by pushing the branch.",
    // open, close and resolve.
    "It opens the pull request only once.",
    "The ticket is closed only once.",
    "The thread is resolved twice.",
    // A repeat named outright.
    "No second pull request appears.",
    "No duplicate record is produced.",
    // A phrasal particle is cut from the active forms only.
    "The suite is not run through CI.",
    // A reporting verb exempts its own clause, not a claim conjoined after it.
    "It reports that the lane is unavailable and does not publish the verdict.",
    "The run notes that the key matches, then does not post the comment again.",
    "It states that the gate is closed, so no ticket is created.",
    "It tells them that the gate is closed and does not merge the branch.",
  ])("finds the claim in %p", (criteria) => {
    expect(actionClaim(criteria)).not.toBeNull();
  });

  test.each([
    "The response does not report the write complete without a read-back.",
    "The response does not open with a theory read out of the code.",
    "Every seat it did not run is listed with the reason it did not activate.",
    "Nothing is presented as observed that was never run.",
    "A class with no applicable case is recorded as not applicable rather than omitted.",
    "The run states plainly that it did not publish.",
    "The response reads the record back before any second publish.",
    "The response names which lanes were run and which were skipped.",
    // An auxiliary without a negation is a plan, not a claim.
    "The response will run the check and then publish the summary.",
    // Nouns that share a spelling with an action verb, next to a count.
    "The reply names the finding again.",
    "The response reads the record once and cites it.",
    "The response cites the run once.",
    "It states the commit once in its summary.",
    "The response lists the replies again.",
    // Idioms whose verb is not the action.
    "The response does not call it a regression.",
    "The response does not record opinions as findings.",
    "The review does not cut corners.",
    "The reply should not start with an apology.",
    "The response does not write off the failure.",
    // "rather than" with no repeat.
    "Each new finding names what changed, rather than reopening discovery on unrelated issues.",
    // Phrasal verbs after "never".
    "It never runs through the checklist.",
    "It never pushes back on the reviewer.",
    // A count must end its clause.
    "It merges the two lists again in its explanation.",
    "It creates a summary once the checks finish.",
    // What a reporting verb introduces is what the reply says.
    "It explains that the record is not written by hand.",
    "It tells them that the branch is not merged.",
    "It notes that the key matches and states that the comment is not posted again.",
  ])("does not flag %p", (criteria) => {
    expect(actionClaim(criteria)).toBeNull();
  });

  test("needs the negation and the verb in one sentence", () => {
    expect(actionClaim("The run does not stop. It publishes the page.")).toBeNull();
  });
});

describe("unaimedClaims", () => {
  const grader = (extra: Record<string, unknown>) => ({
    graders: [{ name: "g", type: "llm", criteria: "No file is created in the repository.", ...extra }],
  });

  test("an llm file claim with no focus is reported", () => {
    expect(unaimedClaims(grader({}))).toEqual([
      { grader: "g", kind: "file", sentence: "No file is created in the repository." },
    ]);
  });

  test("any explicit focus clears it, including last_message", () => {
    for (const focus of ["trace", "files", "last_message", { source: "file", path: "out.md" }]) {
      expect(unaimedClaims(grader({ focus }))).toEqual([]);
    }
  });

  test("an llm action claim with no focus is reported, and focus clears it", () => {
    const action = (extra: Record<string, unknown>) => ({
      graders: [{ name: "a", type: "llm", criteria: "The run does not publish the page a second time.", ...extra }],
    });
    expect(unaimedClaims(action({}))).toEqual([
      { grader: "a", kind: "action", sentence: "The run does not publish the page a second time." },
    ]);
    expect(unaimedClaims(action({ focus: "trace" }))).toEqual([]);
  });

  test("a sentence making both claims is reported once, as a file claim", () => {
    const doc = { graders: [{ name: "b", type: "llm", criteria: "The run does not write the file again." }] };
    expect(unaimedClaims(doc).map((c) => c.kind)).toEqual(["file"]);
  });

  test("a deterministic grader is not the lint's business", () => {
    expect(unaimedClaims({ graders: [{ name: "g", type: "regex", pattern: "file created" }] })).toEqual([]);
  });
});

describe("checkGraderSurfaces", () => {
  test("errors on an unaimed claim in a case file", () => {
    const root = makeTree({
      "evals/alpha/writes-nothing/case.yaml":
        "graders:\n  - name: no-file\n    type: llm\n    criteria: No file is written to the repository.\n",
    });
    const issues = checkGraderSurfaces(at(root));
    expect(issues.map((i) => [i.rule, i.file])).toEqual([
      ["evals.llm-file-claim-without-focus", "evals/alpha/writes-nothing/case.yaml"],
    ]);
    expect(issues[0]?.severity).toBe("error");
  });

  test("errors on an unaimed action claim with its own rule", () => {
    const root = makeTree({
      "evals/alpha/publishes-once/case.yaml":
        "graders:\n  - name: once\n    type: llm\n    criteria: No second page is published.\n",
      "evals/alpha/publishes-once-aimed/case.yaml":
        "graders:\n  - name: once\n    type: llm\n    focus: trace\n    criteria: No second page is published.\n",
    });
    expect(checkGraderSurfaces(at(root)).map((i) => [i.rule, i.file, i.severity])).toEqual([
      ["evals.llm-action-claim-without-focus", "evals/alpha/publishes-once/case.yaml", "error"],
    ]);
  });

  test("the corpus has no unaimed file or action claim", () => {
    expect(checkGraderSurfaces(at(ROOT))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Mutation: every deterministic corpus grader can fail.

interface CorpusGrader {
  readonly where: string;
  readonly grader: Grader;
}

function corpusGraders(): CorpusGrader[] {
  const out: CorpusGrader[] = [];
  for (const path of [...new Glob("evals/*/*/case.yaml").scanSync(ROOT)].sort()) {
    const doc = parseYaml(readFileSync(join(ROOT, path), "utf8")) as { graders?: Grader[] };
    for (const grader of doc.graders ?? []) {
      if (DETERMINISTIC_TYPES.has(String(grader["type"])))
        out.push({ where: `${path} :: ${String(grader["name"])}`, grader });
    }
  }
  return out;
}

/** Inputs a real run could send, tried in order until one satisfies an `input_match`. */
function candidateInputs(): unknown[] {
  const skills = [...new Glob("*").scanSync({ cwd: join(ROOT, "evals"), onlyFiles: false })];
  return [
    {},
    ...skills.flatMap((s) => [{ skill: `ak:${s}` }, { skill: s }]),
    { command: "git push origin HEAD" },
    { command: "gh pr create --fill" },
    { command: "gh pr merge 1" },
    { command: "gh api graphql -f query='mutation { resolveReviewThread }'" },
    { command: "no-mistakes status" },
    { command: "bun run db:migrate" },
    { file_path: "src/cookie.ts", content: "x" },
    { file_path: "catalog.yaml", old_string: "x", new_string: "y" },
  ];
}

const INPUTS = candidateInputs();

/** A call that `ref` matches, or null when no candidate input does. */
function witnessCall(ref: unknown): ToolCall | null {
  const r = typeof ref === "string" ? { tool: ref } : (ref as { tool: string; input_match?: string });
  for (const input of INPUTS) {
    const call: ToolCall = { name: r.tool, input };
    if (callMatches(call, r)) return call;
  }
  return null;
}

/** A string `pattern` matches, by naive unescaping; checked by the caller. */
function witnessText(pattern: string, flags: string): string | null {
  const text = pattern
    .replace(/^\^/, "")
    .replace(/\$$/, "")
    .replace(/\\s[*+]?/g, " ")
    .replace(/\\(.)/g, "$1");
  return new RegExp(pattern, flags).test(text) ? text : null;
}

/** A path the glob matches. */
function witnessPath(glob: string): string | null {
  const path = glob
    .replace(/\*\*\//g, "a/")
    .replace(/\*\*/g, "a")
    .replace(/\*/g, "a")
    .replace(/\?/g, "a");
  return globToRegExp(glob).test(path) ? path : null;
}

function times(call: ToolCall, n: number): ToolCall[] {
  return Array.from({ length: n }, () => call);
}

/** A transcript the grader must fail and, where one exists, one it must pass. */
function mutants(g: Grader): { failing: Transcript; passing: Transcript | null } | string {
  switch (g["type"]) {
    case "tool_used": {
      const call = witnessCall({ tool: g["tool"], input_match: g["input_match"] });
      if (call === null) return `no candidate input matches input_match ${String(g["input_match"])}`;
      const min = typeof g["min"] === "number" ? g["min"] : 1;
      const max = typeof g["max"] === "number" ? g["max"] : null;
      if (min === 0 && max === null) return "min 0 with no max passes every transcript";
      const failing = max === null ? times(call, min - 1) : times(call, max + 1);
      return { failing: { ...EMPTY, toolCalls: failing }, passing: { ...EMPTY, toolCalls: times(call, min) } };
    }
    case "tool_order": {
      const before = witnessCall(g["before"]);
      const after = witnessCall(g["after"]);
      if (before === null || after === null) return "no candidate input matches one side";
      return { failing: { ...EMPTY, toolCalls: [after, before] }, passing: { ...EMPTY, toolCalls: [before, after] } };
    }
    case "file_exists": {
      const path = witnessPath(String(g["path"]));
      if (path === null) return `no witness path for ${String(g["path"])}`;
      const withFile = { ...EMPTY, filesCreated: [path] };
      return g["exists"] === false ? { failing: withFile, passing: EMPTY } : { failing: EMPTY, passing: withFile };
    }
    case "regex": {
      const flags = typeof g["flags"] === "string" ? g["flags"] : "";
      const text = witnessText(String(g["pattern"]), flags);
      if (text === null) return `no witness text for ${String(g["pattern"])}`;
      const on = (s: string): Transcript =>
        g["target"] === "files" ? { ...EMPTY, filesCreated: s === "" ? [] : [s] } : { ...EMPTY, lastMessage: s };
      const match = typeof g["match"] === "string" ? g["match"] : "contains";
      if (match === "contains") return { failing: on(""), passing: on(text) };
      if (match === "not_contains") return { failing: on(text), passing: on("") };
      const n = Number(match.slice("count:".length));
      return {
        failing: on(
          Array(n + 1)
            .fill(text)
            .join("\n"),
        ),
        passing: on(Array(n).fill(text).join("\n")),
      };
    }
    default:
      return `unmodelled type ${String(g["type"])}`;
  }
}

describe("every deterministic corpus grader can fail", () => {
  const graders = corpusGraders();

  test("the corpus has deterministic graders to test", () => {
    expect(graders.length).toBeGreaterThan(0);
  });

  test.each(graders.map((g) => [g.where, g.grader] as const))("%s", (_where, grader) => {
    const m = mutants(grader);
    if (typeof m === "string") throw new Error(m);
    expect(evaluate(grader, m.failing)).toBe(false);
    if (m.passing !== null) expect(evaluate(grader, m.passing)).toBe(true);
  });
});

describe("evaluate", () => {
  test("tool_order fails when either side is never called", () => {
    const g = { type: "tool_order", before: "Skill", after: "Write" };
    expect(evaluate(g, { ...EMPTY, toolCalls: [{ name: "Skill", input: {} }] })).toBe(false);
    expect(evaluate(g, { ...EMPTY, toolCalls: [{ name: "Write", input: {} }] })).toBe(false);
  });

  test("file_exists sees created files only, and ** spans segments", () => {
    const g = { type: "file_exists", path: "docs/**/*.md" };
    expect(evaluate(g, { ...EMPTY, filesCreated: ["docs/a/b/c.md"] })).toBe(true);
    expect(evaluate(g, { ...EMPTY, filesCreated: ["docs/c.md"] })).toBe(true);
    expect(evaluate(g, { ...EMPTY, filesCreated: ["src/c.md"] })).toBe(false);
  });

  test("llm and baseline are not scored here", () => {
    expect(evaluate({ type: "llm", criteria: "x" }, EMPTY)).toBeNull();
    expect(evaluate({ type: "baseline" }, EMPTY)).toBeNull();
  });
});
