/**
 * A local evaluator for the deterministic eval grader types (AUTHORING.md §9).
 *
 * It scores one grader against a synthetic transcript, the way `claude plugin
 * eval` scores it against a real run. It exists so a test can show that every
 * deterministic grader in the corpus can fail: a grader that passes every
 * transcript is not measuring anything, and the host never reports that,
 * because a run that passes it looks like a run that did the right thing.
 *
 * The semantics are copied from the host's grader code at claude 2.1.282, read
 * off the binary rather than inferred from the authoring spec:
 *
 * - `tool_used` counts calls whose name equals `tool` and, when `input_match`
 *   is set, whose serialized input matches it as a JavaScript RegExp (not a
 *   substring). The input is serialized with `JSON.stringify`, so a Skill call
 *   reads `{"skill":"ak:diagnose"}`. It passes when the count is within
 *   `min` (default 1) and `max` (default unbounded).
 * - `tool_order` finds the first call matching `before` and the first matching
 *   `after`. It fails when either was never called, so it cannot express "Skill
 *   before any Write, or no Write at all".
 * - `file_exists` converts `path` from a glob (`**` any depth, `*` within one
 *   segment, `?` one character) and tests it against the files CREATED during
 *   the run. A file that existed before the run and was edited is not on that
 *   list.
 * - `regex` reads `target` (default `last_message`), applies `flags`, and passes
 *   on `contains` (default), `not_contains`, or `count:N` exact matches.
 *
 * `llm` and `baseline` are judged by a model and return null here. They are
 * covered by the surface lint in `graders.ts`, not by this file.
 */

import { globToRegExp } from "../util/glob.ts";

export { globToRegExp };

/** One tool call as the host records it: the tool's name and its input object. */
export interface ToolCall {
  readonly name: string;
  readonly input: unknown;
}

/** What a run leaves for the deterministic graders to read. */
export interface Transcript {
  readonly toolCalls: readonly ToolCall[];
  readonly lastMessage: string;
  /** Paths created during the run, relative to the sandbox cwd. */
  readonly filesCreated: readonly string[];
}

export type Grader = Readonly<Record<string, unknown>>;

/** A tool reference in `tool_order`: a bare name or `{tool, input_match}`. */
interface ToolRef {
  readonly tool: string;
  readonly input_match?: string;
}

export const DETERMINISTIC_TYPES: ReadonlySet<string> = new Set(["tool_used", "tool_order", "file_exists", "regex"]);

/** The text the host matches `input_match` against. */
export function inputText(call: ToolCall): string {
  try {
    return JSON.stringify(call.input) ?? "";
  } catch {
    return "";
  }
}

function toolRef(value: unknown): ToolRef {
  if (typeof value === "string") return { tool: value };
  const ref = value as Record<string, unknown>;
  const out: ToolRef = { tool: String(ref["tool"]) };
  return typeof ref["input_match"] === "string" ? { ...out, input_match: ref["input_match"] } : out;
}

export function callMatches(call: ToolCall, ref: ToolRef): boolean {
  if (call.name !== ref.tool) return false;
  if (ref.input_match !== undefined) return new RegExp(ref.input_match).test(inputText(call));
  return true;
}

/** The text a `regex` grader reads for its `target`, or null for a surface this evaluator does not model. */
export function surfaceText(target: unknown, t: Transcript): string | null {
  if (target === undefined || target === "last_message") return t.lastMessage;
  if (target === "files") return t.filesCreated.join("\n");
  if (target === "trace")
    return [...t.toolCalls.map((c) => JSON.stringify({ tool: c.name, input: c.input })), t.lastMessage].join("\n");
  return null;
}

/**
 * Score one grader. `true` passes, `false` fails, and `null` means this
 * evaluator does not score it: a judged type, or a surface it does not model.
 */
export function evaluate(grader: Grader, t: Transcript): boolean | null {
  switch (grader["type"]) {
    case "tool_used": {
      const ref: ToolRef = toolRef({ tool: grader["tool"], input_match: grader["input_match"] });
      const count = t.toolCalls.filter((c) => callMatches(c, ref)).length;
      const min = typeof grader["min"] === "number" ? grader["min"] : 1;
      const max = typeof grader["max"] === "number" ? grader["max"] : Number.POSITIVE_INFINITY;
      return count >= min && count <= max;
    }
    case "tool_order": {
      const before = t.toolCalls.findIndex((c) => callMatches(c, toolRef(grader["before"])));
      const after = t.toolCalls.findIndex((c) => callMatches(c, toolRef(grader["after"])));
      if (before === -1 || after === -1) return false;
      return before < after;
    }
    case "file_exists": {
      const re = globToRegExp(String(grader["path"]));
      const present = t.filesCreated.some((f) => f.trim() !== "" && re.test(f.trim()));
      const wanted = grader["exists"] === undefined ? true : grader["exists"] === true;
      return present === wanted;
    }
    case "regex": {
      const text = surfaceText(grader["target"], t);
      if (text === null) return null;
      const flags = typeof grader["flags"] === "string" ? grader["flags"] : "";
      const pattern = String(grader["pattern"]);
      const match = typeof grader["match"] === "string" ? grader["match"] : "contains";
      if (match === "contains") return new RegExp(pattern, flags).test(text);
      if (match === "not_contains") return !new RegExp(pattern, flags).test(text);
      const n = Number(match.slice("count:".length));
      const global = flags.includes("g") ? flags : `${flags}g`;
      return (text.match(new RegExp(pattern, global)) ?? []).length === n;
    }
    default:
      return null;
  }
}
